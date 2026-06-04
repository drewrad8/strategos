/**
 * Session persistence: save/restore worker state, checkpoints.
 * Handles debounced saves, immediate saves, crash saves, and full state restoration.
 */

import {
  workers, outputBuffers, commandQueues,
  pendingWorkers, inFlightSpawns, respawnAttempts,
  PERSISTENCE_DIR, PERSISTENCE_FILE, CHECKPOINT_DIR,
  path, fs, writeFileSync, renameSync, mkdirSync, existsSync, readdirSync, statSync, unlinkSync,
  stripAnsiCodes, normalizeWorker,
  spawnTmux, validateSessionName, sessionExists,
} from './state.js';

import { startPtyCapture, stopPtyCapture, sendInputDirect } from './output.js';
import { tryAutoPromoteWorker } from './ralph.js';
import {
  startHealthMonitor, stopHealthMonitor,
  getCrashPatterns, handleCrashedWorker,
} from './health.js';
import {
  registerWorkerDependencies,
  markWorkerStarted,
  markWorkerCompleted,
  markWorkerFailed,
} from '../dependencyGraph.js';
import { invalidateWorkersCache } from './queries.js';
import { pruneWorktrees } from './worktree.js';
import {
  startSession as dbStartSession,
} from '../workerOutputDb.js';
import { getLogger } from '../logger.js';

const logger = getLogger();

// ============================================
// WORKER CHECKPOINTING
// ============================================

const CHECKPOINT_COUNT_CAP = 500;
const CHECKPOINT_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days in ms

/**
 * Evict excess and age-stale checkpoint files from dir.
 * Keeps the newest CHECKPOINT_COUNT_CAP files; additionally removes any file
 * older than 30 days that survived the count cut.
 */
export function pruneCheckpoints(dir) {
  try {
    const now = Date.now();
    const files = readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .map(f => ({ name: f, mtime: statSync(path.join(dir, f)).mtime }))
      .sort((a, b) => b.mtime - a.mtime); // newest first
    for (const f of files.slice(CHECKPOINT_COUNT_CAP)) {
      try { unlinkSync(path.join(dir, f.name)); } catch { /* best-effort */ }
    }
    for (const f of files.slice(0, CHECKPOINT_COUNT_CAP)) {
      if (now - f.mtime > CHECKPOINT_AGE_MS) {
        try { unlinkSync(path.join(dir, f.name)); } catch { /* best-effort */ }
      }
    }
  } catch (e) {
    logger.warn(`[Checkpoint] pruneCheckpoints failed: ${e.message}`);
  }
}

/**
 * Write a checkpoint for a dying worker — captures everything we know about it
 * so the next worker or human can understand what was lost.
 * Checkpoints are written to server/.tmp/checkpoints/{workerId}.json
 */
export function writeWorkerCheckpoint(workerId, reason = 'unknown') {
  const worker = workers.get(workerId);
  if (!worker) return;

  try {
    const output = outputBuffers.get(workerId) || '';
    // Extract last meaningful lines from output (strip ANSI)
    const cleanOutput = stripAnsiCodes(output);
    const lastLines = cleanOutput.split('\n').filter(l => l.trim()).slice(-50).join('\n');

    const checkpoint = {
      workerId,
      label: worker.label,
      project: worker.project,
      workingDir: worker.workingDir,
      reason,
      diedAt: new Date().toISOString(),
      createdAt: worker.createdAt,
      uptime: Math.max(0, Date.now() - new Date(worker.createdAt).getTime()) || 0,
      // What was it doing?
      task: worker.task || null,
      ralphStatus: worker.ralphStatus || null,
      ralphProgress: worker.ralphProgress || null,
      ralphCurrentStep: worker.ralphCurrentStep || null,
      ralphLearnings: worker.ralphLearnings || null,
      ralphOutputs: worker.ralphOutputs || null,
      ralphArtifacts: worker.ralphArtifacts || null,
      // Who was it connected to?
      parentWorkerId: worker.parentWorkerId || null,
      parentLabel: worker.parentLabel || null,
      childWorkerIds: worker.childWorkerIds || [],
      childWorkerHistory: worker.childWorkerHistory || [],
      // Last known output (last 50 lines)
      lastOutput: lastLines,
      // Health at death
      health: worker.health,
      crashReason: worker.crashReason || null,
      // Delegation tracking (for generals)
      delegationMetrics: worker.delegationMetrics || null,
    };

    const filePath = path.join(CHECKPOINT_DIR, `${workerId}.json`);
    writeFileSync(filePath, JSON.stringify(checkpoint, null, 2));
    logger.info(`[Checkpoint] Saved checkpoint for ${worker.label} (${workerId}) → ${filePath} [reason: ${reason}]`);

    pruneCheckpoints(CHECKPOINT_DIR);
  } catch (err) {
    logger.error(`[Checkpoint] Failed to write checkpoint for ${workerId}: ${err.message}`);
  }
}

/**
 * Write an emergency checkpoint for a GENERAL/COLONEL that vanished before
 * registering in the workers Map. Provides a forensic trail when no worker
 * object exists to draw from (P1-VAN gap — stability-gaps-2026-04-20.md).
 *
 * @param {string} workerId   - Extracted from the tmux session name
 * @param {string} sessionName - Full tmux session name (e.g. 'thea-worker-abc123')
 * @param {string} [lastOutput] - Last ~100 lines captured from tmux (may be empty)
 */
export function writeOrphanedGeneralCheckpoint(workerId, sessionName, lastOutput = '') {
  try {
    const snippet = (lastOutput || '').split('\n').filter(l => l.trim()).slice(-100).join('\n');
    const checkpoint = {
      workerId,
      label: 'ORPHANED',
      tmuxSession: sessionName,
      lastOutput: snippet,
      crashedAt: new Date().toISOString(),
      reason: 'orphaned-general-vanish',
    };
    const filePath = path.join(CHECKPOINT_DIR, `${workerId}.json`);
    writeFileSync(filePath, JSON.stringify(checkpoint, null, 2));
    logger.info(`[Checkpoint] Saved orphaned checkpoint for ${workerId} → ${filePath}`);
    pruneCheckpoints(CHECKPOINT_DIR);
  } catch (err) {
    logger.error(`[Checkpoint] Failed to write orphaned checkpoint for ${workerId}: ${err.message}`);
  }
}

/**
 * Write a best-effort checkpoint for every currently-tracked worker.
 * Called at the end of the shutdown grace window so a last-known-state snapshot
 * exists on disk even if workers didn't have time to signal done/held.
 * @param {string} reason - Reason tag written to each checkpoint (e.g. 'server_shutdown')
 */
export function bulkCheckpointRunningWorkers(reason = 'server_shutdown') {
  for (const [workerId] of workers) {
    try {
      writeWorkerCheckpoint(workerId, reason);
    } catch { /* best-effort — individual failures must not block shutdown */ }
  }
}

// ============================================
// SESSION PERSISTENCE
// ============================================

// Write lock to serialize saveWorkerState calls.
// Without this, concurrent non-awaited calls can interleave reads and writes,
// causing older state to overwrite newer state (last-write-wins corruption).
let _saveStatePending = Promise.resolve();
let _saveStateDirty = false;
let _saveStateTimer = null;
const SAVE_STATE_DEBOUNCE_MS = 2000;

/**
 * Debounced save: coalesces rapid calls into a single write after 2s of quiet.
 * Critical paths (shutdown, crash) should call saveWorkerStateImmediate() instead.
 */
export async function saveWorkerState() {
  _saveStateDirty = true;
  if (!_saveStateTimer) {
    _saveStateTimer = setTimeout(() => {
      _saveStateTimer = null;
      if (_saveStateDirty) {
        _saveStateDirty = false;
        _saveStatePending = _saveStatePending.then(_doSaveWorkerState, _doSaveWorkerState);
      }
    }, SAVE_STATE_DEBOUNCE_MS);
    if (_saveStateTimer.unref) _saveStateTimer.unref();
  }
}

/**
 * Immediate save: bypasses debounce for critical paths (shutdown, cleanup).
 */
export async function saveWorkerStateImmediate() {
  _saveStateDirty = false;
  if (_saveStateTimer) { clearTimeout(_saveStateTimer); _saveStateTimer = null; }
  _saveStatePending = _saveStatePending.then(_doSaveWorkerState, _doSaveWorkerState);
  return _saveStatePending;
}

function serializeWorker(w) {
  return {
    id: w.id,
    label: w.label,
    project: w.project,
    workingDir: w.workingDir,
    repoPath: w.repoPath ?? w.workingDir,
    isolated: w.isolated ?? false,
    tmuxSession: w.tmuxSession,
    backend: w.backend || 'claude',
    model: w.model || null,
    createdAt: w.createdAt,
    lastOutput: w.lastOutput,
    lastActivity: w.lastActivity,
    autoAccept: w.autoAccept ?? true,
    autoAcceptPaused: w.autoAcceptPaused ?? false,
    ralphMode: w.ralphMode ?? false,
    ralphToken: w.ralphToken ?? null,
    task: w.task ?? null,
    parentWorkerId: w.parentWorkerId ?? null,
    parentLabel: w.parentLabel ?? null,
    childWorkerIds: w.childWorkerIds || [],
    childWorkerHistory: w.childWorkerHistory || [],
    dependsOn: w.dependsOn || [],
    workflowId: w.workflowId ?? null,
    taskId: w.taskId ?? null,
    status: w.status ?? 'running',
    health: w.health ?? 'healthy',
    ralphStatus: w.ralphStatus ?? null,
    ralphProgress: w.ralphProgress ?? null,
    ralphCurrentStep: w.ralphCurrentStep ?? null,
    ralphSignalCount: w.ralphSignalCount ?? 0,
    firstRalphAt: w.firstRalphAt ?? null,
    lastRalphSignalAt: w.lastRalphSignalAt ?? null,
    ralphSignaledAt: w.ralphSignaledAt ?? null,
    ralphLearnings: w.ralphLearnings ?? null,
    ralphOutputs: w.ralphOutputs ?? null,
    ralphArtifacts: w.ralphArtifacts ?? null,
    ralphBlockedReason: w.ralphBlockedReason ?? null,
    _ralphManuallySignaled: w._ralphManuallySignaled ?? false,
    completedAt: w.completedAt ?? null,
    awaitingReviewAt: w.awaitingReviewAt ?? null,
    crashReason: w.crashReason ?? null,
    crashedAt: w.crashedAt ?? null,
    bulldozeMode: w.bulldozeMode ?? false,
    bulldozePaused: w.bulldozePaused ?? false,
    bulldozePauseReason: w.bulldozePauseReason ?? null,
    bulldozeCyclesCompleted: w.bulldozeCyclesCompleted ?? 0,
    bulldozeStartedAt: w.bulldozeStartedAt ?? null,
    bulldozeLastCycleAt: w.bulldozeLastCycleAt ?? null,
    bulldozeConsecutiveErrors: w.bulldozeConsecutiveErrors ?? 0,
    forcedAutonomy: w.forcedAutonomy ?? false,
    roleViolations: w.roleViolations ?? 0,
    delegationMetrics: w.delegationMetrics ?? null,
    autoContinue: w.autoContinue ?? true,
    autoContinueCount: w.autoContinueCount ?? 0,
    autoDismissAfterDone: w.autoDismissAfterDone ?? true,
    taskReceivedAt: w.taskReceivedAt ?? null,
    taskQualityScore: w.taskQualityScore ?? null,
    // Auto-fallback observability — set when modelFallbackService substituted spawn args.
    originalModel: w.originalModel ?? null,
    originalEffort: w.originalEffort ?? null,
    fallbackReason: w.fallbackReason ?? null,
  };
}

async function _doSaveWorkerState() {
  try {
    const state = {
      timestamp: new Date().toISOString(),
      workers: Array.from(workers.values()).map(serializeWorker)
    };

    // Atomic write: write to temp file then rename to prevent corruption on crash
    const tmpFile = PERSISTENCE_FILE + '.tmp';
    await fs.writeFile(tmpFile, JSON.stringify(state, null, 2));
    await fs.rename(tmpFile, PERSISTENCE_FILE);
  } catch (error) {
    logger.error(`[persistence] Failed to save worker state: ${error.message}`);
  }
}

/**
 * Synchronous version of saveWorkerState for crash handlers.
 * Uses writeFileSync since async operations may not complete during uncaughtException.
 */
export function saveWorkerStateSync() {
  try {
    if (!existsSync(PERSISTENCE_DIR)) {
      mkdirSync(PERSISTENCE_DIR, { recursive: true });
    }

    const state = {
      timestamp: new Date().toISOString(),
      crashSave: true,
      workers: Array.from(workers.values()).map(serializeWorker)
    };

    // Atomic write: temp file then rename (even in sync crash handler)
    const tmpFile = PERSISTENCE_FILE + '.tmp';
    writeFileSync(tmpFile, JSON.stringify(state, null, 2));
    renameSync(tmpFile, PERSISTENCE_FILE);
    logger.error(`[CrashSave] Saved ${state.workers.length} workers to ${PERSISTENCE_FILE}`);
  } catch (error) {
    logger.error(`[CrashSave] Failed to save worker state: ${error.message}`);
  }
}

export async function restoreWorkerState(io = null) {
  try {
    // Defense-in-depth: cap persistence file size to prevent memory exhaustion on tampered file
    const MAX_PERSISTENCE_SIZE = 10 * 1024 * 1024; // 10MB
    const fileStat = await fs.stat(PERSISTENCE_FILE).catch(() => null);
    if (fileStat && fileStat.size > MAX_PERSISTENCE_SIZE) {
      logger.error(`[Restore] Persistence file too large (${fileStat.size} bytes, max ${MAX_PERSISTENCE_SIZE}) — refusing to load`);
      return [];
    }

    const data = await fs.readFile(PERSISTENCE_FILE, 'utf-8');
    const state = JSON.parse(data);

    // Schema validation: ensure saved state has expected structure
    if (!state || !Array.isArray(state.workers)) {
      logger.error('[Restore] Invalid persistence file: missing workers array');
      return [];
    }

    // Cap workers array size (defense-in-depth against tampered file with millions of entries)
    const MAX_RESTORE_WORKERS = 500;
    if (state.workers.length > MAX_RESTORE_WORKERS) {
      logger.error(`[Restore] Too many workers in persistence file (${state.workers.length}, max ${MAX_RESTORE_WORKERS}) — truncating`);
      state.workers = state.workers.slice(0, MAX_RESTORE_WORKERS);
    }

    logger.info(`[persistence] Restoring ${state.workers.length} workers from saved state`);

    const restoredIds = new Set();
    for (const savedWorker of state.workers) {
      // Validate required fields before attempting restore
      if (!savedWorker || typeof savedWorker.id !== 'string' || !savedWorker.id ||
          typeof savedWorker.tmuxSession !== 'string' || !savedWorker.tmuxSession ||
          typeof savedWorker.workingDir !== 'string' || !savedWorker.workingDir) {
        logger.warn('[Restore] Skipping entry with missing required fields (id/tmuxSession/workingDir)');
        continue;
      }
      // Validate worker ID format (defense-in-depth: ID is used in checkpoint filenames)
      if (!/^[a-zA-Z0-9_-]{1,36}$/.test(savedWorker.id)) {
        logger.warn(`[Restore] Skipping entry with invalid worker ID format: ${String(savedWorker.id).slice(0, 50)}`);
        continue;
      }
      // Check if tmux session still exists
      const exists = await sessionExists(savedWorker.tmuxSession);
      if (!exists) {
        logger.info(`[Restore] Skipping ${savedWorker.label} (${savedWorker.id}) - session no longer exists`);
        // Clean up orphaned bulldoze state file
        if (savedWorker.workingDir && savedWorker.bulldozeMode) {
          const normalizedWd = path.resolve(savedWorker.workingDir);
          if (path.isAbsolute(normalizedWd) && !normalizedWd.includes('..')) {
            const bulldozeStatePath = path.join(normalizedWd, 'tmp', `bulldoze-state-${savedWorker.id}.md`);
            try { await fs.unlink(bulldozeStatePath); logger.info(`[Restore] Cleaned up orphaned bulldoze state: ${bulldozeStatePath}`); } catch { /* ENOENT is fine */ }
          }
        }
        // Clean up orphaned context file if no other worker shares the path
        if (savedWorker.workingDir && typeof savedWorker.workingDir === 'string') {
          // Normalize and validate path from persistence file (defense-in-depth against tampered file)
          const normalizedDir = path.resolve(savedWorker.workingDir);
          if (!normalizedDir.includes('..') && path.isAbsolute(normalizedDir)) {
            const othersOnPath = state.workers.filter(
              w => w.workingDir === savedWorker.workingDir && w.id !== savedWorker.id
            );
            const aliveResults = await Promise.allSettled(
              othersOnPath.map(w => sessionExists(w.tmuxSession))
            );
            const anyAlive = aliveResults.some(r => r.status === 'fulfilled' && r.value);
            if (!anyAlive) {
              // Clean up Claude rules files
              const rulesDir = path.join(normalizedDir, '.claude', 'rules');
              try {
                const ruleFiles = await fs.readdir(rulesDir);
                for (const f of ruleFiles) {
                  if (f.startsWith('strategos-worker-') && f.endsWith('.md')) {
                    await fs.unlink(path.join(rulesDir, f));
                    logger.info(`[Restore] Cleaned up orphaned rules file: ${f}`);
                  }
                }
              } catch (e) { /* ignore ENOENT */ }
              const legacyCtx = path.join(normalizedDir, '.claudecontext');
              try { await fs.unlink(legacyCtx); } catch { /* ignore */ }

              // Clean up Gemini context files
              try {
                const dirFiles = await fs.readdir(normalizedDir);
                for (const f of dirFiles) {
                  if (f.startsWith('GEMINI-strategos-worker-') && f.endsWith('.md')) {
                    await fs.unlink(path.join(normalizedDir, f));
                    logger.info(`[Restore] Cleaned up orphaned Gemini context: ${f}`);
                  }
                }
                // Remove Strategos-managed master GEMINI.md
                try {
                  const masterContent = await fs.readFile(path.join(normalizedDir, 'GEMINI.md'), 'utf-8');
                  if (masterContent.includes('<!-- Strategos managed -->')) {
                    await fs.unlink(path.join(normalizedDir, 'GEMINI.md'));
                    logger.info('[Restore] Cleaned up orphaned master GEMINI.md');
                  }
                } catch { /* ignore ENOENT */ }
              } catch (e) { /* ignore ENOENT */ }
            }
          }
        }
        // Checkpoint dead-session workers so the operator has visibility into what was lost
        try {
          const checkpoint = {
            ...savedWorker,
            reason: 'tmux session died during server downtime',
            diedAt: new Date().toISOString(),
            uptime: savedWorker.createdAt
              ? Math.max(0, Date.now() - new Date(savedWorker.createdAt).getTime())
              : 0,
          };
          const checkpointPath = path.join(CHECKPOINT_DIR, `${savedWorker.id}.json`);
          writeFileSync(checkpointPath, JSON.stringify(checkpoint, null, 2));
          logger.warn(`[Restore] ⚠ Dead-session worker checkpointed: ${savedWorker.label} (${savedWorker.id}) — last progress: ${savedWorker.ralphProgress ?? 'unknown'}%, step: ${savedWorker.ralphCurrentStep ?? 'unknown'}`);
        } catch (cpErr) {
          logger.error(`[Restore] Failed to write checkpoint for dead worker ${savedWorker.id}: ${cpErr.message}`);
        }
        continue;
      }

      // Validate session name from saved state (defense-in-depth against tampered persistence file)
      try {
        validateSessionName(savedWorker.tmuxSession);
      } catch {
        logger.warn(`[Restore] Skipping ${savedWorker.label} (${savedWorker.id}) - invalid session name in saved state`);
        continue;
      }

      // Verify session is functional by attempting capture-pane (not just has-session)
      // has-session can return true for zombie sessions that can't actually be used
      try {
        await spawnTmux(['capture-pane', '-t', savedWorker.tmuxSession, '-p']);
      } catch {
        logger.warn(`[Restore] Skipping ${savedWorker.label} (${savedWorker.id}) - session exists but capture-pane failed (zombie session)`);
        // Checkpoint zombie-session workers so the operator has visibility into what was lost
        try {
          const checkpoint = {
            ...savedWorker,
            reason: 'zombie tmux session (capture-pane failed) during server restore',
            diedAt: new Date().toISOString(),
            uptime: savedWorker.createdAt
              ? Math.max(0, Date.now() - new Date(savedWorker.createdAt).getTime())
              : 0,
          };
          const checkpointPath = path.join(CHECKPOINT_DIR, `${savedWorker.id}.json`);
          writeFileSync(checkpointPath, JSON.stringify(checkpoint, null, 2));
          logger.warn(`[Restore] ⚠ Zombie-session worker checkpointed: ${savedWorker.label} (${savedWorker.id}) — last progress: ${savedWorker.ralphProgress ?? 'unknown'}%, step: ${savedWorker.ralphCurrentStep ?? 'unknown'}`);
        } catch (cpErr) {
          logger.error(`[Restore] Failed to write checkpoint for zombie worker ${savedWorker.id}: ${cpErr.message}`);
        }
        continue;
      }

      // Kill zombie tmux sessions: if the saved state says the worker is dead/error/stopped/completed,
      // don't reanimate it just because its tmux session survived a restart.
      const savedStatus = typeof savedWorker.status === 'string' ? savedWorker.status : '';
      const savedHealth = typeof savedWorker.health === 'string' ? savedWorker.health : '';
      if (['error', 'stopped', 'completed'].includes(savedStatus) || savedHealth === 'dead') {
        logger.info(`[Restore] Killing zombie tmux session for dead worker ${savedWorker.id} (${savedWorker.label}) — status: ${savedStatus}, health: ${savedHealth}`);
        try {
          await spawnTmux(['kill-session', '-t', savedWorker.tmuxSession]);
        } catch { /* session may already be gone */ }
        // Write a checkpoint so the dead state is preserved, then skip restoring
        try {
          const checkpointPath = path.join(CHECKPOINT_DIR, `${savedWorker.id}.json`);
          writeFileSync(checkpointPath, JSON.stringify(savedWorker, null, 2));
        } catch { /* best-effort checkpoint */ }
        continue;
      }

      // Skip ephemeral workers that should not survive a server restart.
      // Auto-bulldoze workers are spawned on-demand by external watchdogs and should
      // not be reanimated from persistence — the watchdog will re-create them if needed.
      const workerLabel = typeof savedWorker.label === 'string' ? savedWorker.label.toLowerCase() : '';
      if (workerLabel.startsWith('auto-bulldoze')) {
        logger.info(`[Restore] Skipping ephemeral worker ${savedWorker.label} (${savedWorker.id}) — auto-bulldoze workers are not restored`);
        try {
          await spawnTmux(['kill-session', '-t', savedWorker.tmuxSession]);
        } catch { /* session may already be gone */ }
        continue;
      }

      // Verify the process inside the tmux session is still alive (not just a dead shell)
      let _processHealthy = true;
      try {
        const { stdout: paneCmd } = await spawnTmux(['list-panes', '-t', savedWorker.tmuxSession, '-F', '#{pane_current_command}']);
        const cmd = (paneCmd || '').trim();
        if (!cmd || cmd === 'bash' || cmd === 'zsh' || cmd === 'sh') {
          logger.warn(`[Restore] Session ${savedWorker.tmuxSession} has dead process (${cmd || 'empty'}), will mark as crashed`);
          _processHealthy = false;
        }
      } catch {
        // list-panes failed — session is likely broken, but don't skip (capture-pane passed)
      }

      // Skip if already tracked
      if (workers.has(savedWorker.id)) continue;

      // EXPLICIT FIELD MAPPING — no spread operator. Every field must be listed.
      // This prevents future fields from leaking into internal state unexpectedly.
      // String fields coerced from persistence file (defense-in-depth against tampered types).
      const worker = {
        // Core identity (from saved state)
        id: savedWorker.id,
        label: typeof savedWorker.label === 'string' ? savedWorker.label : String(savedWorker.label ?? ''),
        project: typeof savedWorker.project === 'string' ? savedWorker.project : String(savedWorker.project ?? ''),
        workingDir: savedWorker.workingDir,
        // Worktree isolation fields (§3.5). repoPath falls back to workingDir for
        // pre-isolation saved state; isolated is strictly boolean.
        repoPath: typeof savedWorker.repoPath === 'string' ? savedWorker.repoPath : savedWorker.workingDir,
        isolated: savedWorker.isolated === true,
        tmuxSession: savedWorker.tmuxSession,
        // Backend ('claude' or 'gemini')
        backend: ['gemini', 'aider'].includes(savedWorker.backend) ? savedWorker.backend : 'claude',
        model: savedWorker.model || null,
        // State (coerce status/health to prevent object/array injection from tampered persistence)
        status: typeof savedWorker.status === 'string' ? savedWorker.status : 'running',
        mode: 'tmux',
        health: typeof savedWorker.health === 'string' ? savedWorker.health : 'healthy',
        queuedCommands: 0,
        waitingAtPrompt: false, // Runtime-only, re-detected by PTY capture
        // Timestamps
        createdAt: savedWorker.createdAt ? new Date(savedWorker.createdAt) : new Date(),
        lastActivity: savedWorker.lastActivity ? new Date(savedWorker.lastActivity) : new Date(),
        lastOutput: savedWorker.lastOutput ? new Date(savedWorker.lastOutput) : new Date(),
        completedAt: savedWorker.completedAt ? new Date(savedWorker.completedAt) : null,
        awaitingReviewAt: savedWorker.awaitingReviewAt ? new Date(savedWorker.awaitingReviewAt) : null,
        // Relationships (coerce array elements to strings; IDs must be strings)
        dependsOn: Array.isArray(savedWorker.dependsOn) ? savedWorker.dependsOn.filter(d => typeof d === 'string') : [],
        workflowId: typeof savedWorker.workflowId === 'string' ? savedWorker.workflowId : null,
        taskId: typeof savedWorker.taskId === 'string' ? savedWorker.taskId : null,
        parentWorkerId: typeof savedWorker.parentWorkerId === 'string' ? savedWorker.parentWorkerId : null,
        parentLabel: typeof savedWorker.parentLabel === 'string' ? savedWorker.parentLabel : null,
        // task can be string (from HTTP/socket spawn) or object (from ralphService)
        task: (typeof savedWorker.task === 'string' ||
          (typeof savedWorker.task === 'object' && savedWorker.task !== null && !Array.isArray(savedWorker.task)))
          ? savedWorker.task : null,
        childWorkerIds: Array.isArray(savedWorker.childWorkerIds) ? savedWorker.childWorkerIds.filter(c => typeof c === 'string') : [],
        childWorkerHistory: Array.isArray(savedWorker.childWorkerHistory) ? savedWorker.childWorkerHistory.filter(c => typeof c === 'string') : [],
        // Auto-accept settings
        autoAccept: savedWorker.autoAccept !== false, // default true
        autoAcceptPaused: savedWorker.autoAcceptPaused === true,
        lastAutoAcceptHash: null, // Runtime-only, reset on restore
        // Ralph mode settings
        ralphMode: savedWorker.ralphMode === true,
        ralphToken: typeof savedWorker.ralphToken === 'string' ? savedWorker.ralphToken : null,
        ralphStatus: typeof savedWorker.ralphStatus === 'string' ? savedWorker.ralphStatus : null,
        ralphSignaledAt: savedWorker.ralphSignaledAt ? new Date(savedWorker.ralphSignaledAt) : null,
        ralphLearnings: typeof savedWorker.ralphLearnings === 'string' ? savedWorker.ralphLearnings : null,
        ralphProgress: typeof savedWorker.ralphProgress === 'number' ? savedWorker.ralphProgress : null,
        ralphCurrentStep: typeof savedWorker.ralphCurrentStep === 'string' ? savedWorker.ralphCurrentStep : null,
        // ralphOutputs can be string OR plain object (from signal endpoint)
        ralphOutputs: (typeof savedWorker.ralphOutputs === 'string' ||
          (typeof savedWorker.ralphOutputs === 'object' && savedWorker.ralphOutputs !== null && !Array.isArray(savedWorker.ralphOutputs)))
          ? savedWorker.ralphOutputs : null,
        // ralphArtifacts is an array of strings
        ralphArtifacts: Array.isArray(savedWorker.ralphArtifacts)
          ? savedWorker.ralphArtifacts.filter(a => typeof a === 'string')
          : (typeof savedWorker.ralphArtifacts === 'string' ? savedWorker.ralphArtifacts : null),
        ralphBlockedReason: typeof savedWorker.ralphBlockedReason === 'string' ? savedWorker.ralphBlockedReason : null,
        _ralphManuallySignaled: savedWorker._ralphManuallySignaled === true,
        ralphSignalCount: typeof savedWorker.ralphSignalCount === 'number' ? savedWorker.ralphSignalCount : 0,
        firstRalphAt: savedWorker.firstRalphAt ? new Date(savedWorker.firstRalphAt) : null,
        lastRalphSignalAt: savedWorker.lastRalphSignalAt ? new Date(savedWorker.lastRalphSignalAt) : null,
        // Crash state
        crashReason: typeof savedWorker.crashReason === 'string' ? savedWorker.crashReason : null,
        crashedAt: savedWorker.crashedAt ? new Date(savedWorker.crashedAt) : null,
        // Bulldoze mode state
        bulldozeMode: savedWorker.bulldozeMode === true,
        bulldozePaused: savedWorker.bulldozePaused === true,
        bulldozePauseReason: typeof savedWorker.bulldozePauseReason === 'string' ? savedWorker.bulldozePauseReason : null,
        bulldozeCyclesCompleted: typeof savedWorker.bulldozeCyclesCompleted === 'number' ? savedWorker.bulldozeCyclesCompleted : 0,
        bulldozeStartedAt: savedWorker.bulldozeStartedAt ? new Date(savedWorker.bulldozeStartedAt) : null,
        bulldozeLastCycleAt: savedWorker.bulldozeLastCycleAt ? new Date(savedWorker.bulldozeLastCycleAt) : null,
        bulldozeConsecutiveErrors: typeof savedWorker.bulldozeConsecutiveErrors === 'number' ? savedWorker.bulldozeConsecutiveErrors : 0,
        bulldozeIdleCount: 0, // Runtime-only, reset on restore
        // Forced autonomy mode
        forcedAutonomy: savedWorker.forcedAutonomy === true,
        // Sentinel role-violation counter
        roleViolations: typeof savedWorker.roleViolations === 'number' ? savedWorker.roleViolations : 0,
        // Delegation metrics (for tracking general behavior)
        delegationMetrics: (savedWorker.delegationMetrics && typeof savedWorker.delegationMetrics === 'object')
          ? {
            spawnsIssued: typeof savedWorker.delegationMetrics.spawnsIssued === 'number' ? savedWorker.delegationMetrics.spawnsIssued : 0,
            roleViolations: typeof savedWorker.delegationMetrics.roleViolations === 'number' ? savedWorker.delegationMetrics.roleViolations : 0,
            filesEdited: typeof savedWorker.delegationMetrics.filesEdited === 'number' ? savedWorker.delegationMetrics.filesEdited : 0,
            commandsRun: typeof savedWorker.delegationMetrics.commandsRun === 'number' ? savedWorker.delegationMetrics.commandsRun : 0,
          }
          : { spawnsIssued: 0, roleViolations: 0, filesEdited: 0, commandsRun: 0 },
        // Auto-continue settings
        autoContinue: savedWorker.autoContinue !== false, // default true
        autoContinueCount: typeof savedWorker.autoContinueCount === 'number' ? savedWorker.autoContinueCount : 0,
        // Runtime-only auto-continue state (reset on restore, re-detected from output)
        _rateLimitDetected: false,
        _sessionLimitDetected: false,
        _autoContinueIdleCount: 0,
        _autoContinueAttempts: 0,
        _autoContinueExhausted: false,
        rateLimited: false,
        rateLimitResetAt: null,
        // Auto-dismiss after done
        autoDismissAfterDone: savedWorker.autoDismissAfterDone !== false, // default true
        // Task received timestamp
        taskReceivedAt: savedWorker.taskReceivedAt ? new Date(savedWorker.taskReceivedAt) : null,
        taskQualityScore: savedWorker.taskQualityScore ?? null,
        // Auto-fallback observability — set when modelFallbackService substituted spawn args.
        originalModel: typeof savedWorker.originalModel === 'string' ? savedWorker.originalModel : null,
        originalEffort: typeof savedWorker.originalEffort === 'string' ? savedWorker.originalEffort : null,
        fallbackReason: typeof savedWorker.fallbackReason === 'string' ? savedWorker.fallbackReason : null,
      };

      // Per-worker try-catch: if one worker fails to initialize, continue restoring others
      try {
        // Apply process health check result from earlier validation
        if (!_processHealthy) {
          worker.health = 'crashed';
          worker.crashReason = 'Process dead on restore';
          worker.crashedAt = new Date();
        }

        workers.set(savedWorker.id, worker);
        invalidateWorkersCache();
        outputBuffers.set(savedWorker.id, '');
        commandQueues.set(savedWorker.id, []);

        // Notify UI about restored worker
        if (io) {
          io.emit('worker:created', normalizeWorker(worker));
          // Add all connected sockets to this worker's room for worker:updated events
          io.socketsJoin(`worker:${savedWorker.id}`);
        }

        // Start database session for output persistence
        dbStartSession(worker);

        // Start PTY capture
        startPtyCapture(savedWorker.id, savedWorker.tmuxSession, io);

        // Start health monitoring
        startHealthMonitor(savedWorker.id, io);

        // Re-send Ralph adoption reminder for workers that haven't signaled yet
        if (worker.ralphMode && worker.ralphToken && worker.status === 'running' &&
            (!worker.ralphStatus || worker.ralphStatus === 'pending')) {
          const wId = savedWorker.id;
          const wToken = worker.ralphToken;
          setTimeout(() => {
            const w = workers.get(wId);
            if (w && w.ralphMode && w.status === 'running' && (!w.ralphStatus || w.ralphStatus === 'pending')) {
              const restoreMsg = (w.backend === 'gemini' || w.backend === 'aider')
                ? `Signal your progress via Ralph. Run: curl -s --retry 3 --retry-delay 2 --retry-connrefused -X POST http://localhost:38007/api/ralph/signal/by-worker/${wId} -H "Content-Type: application/json" -d '{"status":"in_progress","progress":10,"currentStep":"what you are doing"}'`
                : `Signal your progress via the strategos_signal MCP tool: strategos_signal(status: "in_progress", progress: 10, currentStep: "what you are doing"). Your worker ID is ${wId} (auto-detected if omitted). Use strategos_whoami if unsure of your identity.`;
              sendInputDirect(wId, restoreMsg, 'persistence:restore_reminder').catch(err => { logger.warn(`[Ralph] Failed to send restore reminder: ${err.message}`); });
              logger.info(`[Ralph] Sent post-restore reminder to ${worker.label}`);
            }
          }, 30000); // 30s after restore (shorter than 60s spawn delay since worker already running)
        }

        restoredIds.add(savedWorker.id);
        logger.info(`[Restore] Restored ${savedWorker.label}`);
      } catch (workerErr) {
        logger.error(`[Restore] Failed to initialize worker ${savedWorker.id} (${savedWorker.label}): ${workerErr.message}`);
        // Clean up partial state to prevent orphaned entries
        stopPtyCapture(savedWorker.id);
        stopHealthMonitor(savedWorker.id);
        workers.delete(savedWorker.id);
        invalidateWorkersCache();
        outputBuffers.delete(savedWorker.id);
        commandQueues.delete(savedWorker.id);
        continue; // Skip to next worker, don't abort entire restore
      }
    }

    // Enforce the checkpoint cap after the batch restore writes.
    // Dead/zombie workers each write one checkpoint; a large restore can transiently exceed 500.
    try {
      pruneCheckpoints(CHECKPOINT_DIR);
    } catch (pruneErr) {
      logger.warn(`[Restore] pruneCheckpoints failed after batch restore: ${pruneErr.message}`);
    }

    // Clean up childWorkerIds that reference dead workers — move them to childWorkerHistory
    for (const [workerId, worker] of workers.entries()) {
      if (worker.childWorkerIds && worker.childWorkerIds.length > 0) {
        const before = worker.childWorkerIds.length;
        const deadChildIds = worker.childWorkerIds.filter(id => !restoredIds.has(id));
        worker.childWorkerIds = worker.childWorkerIds.filter(id => restoredIds.has(id));
        // Migrate dead children to history so generals retain their records
        if (deadChildIds.length > 0) {
          if (!worker.childWorkerHistory) worker.childWorkerHistory = [];
          for (const deadId of deadChildIds) {
            if (!worker.childWorkerHistory.includes(deadId)) {
              worker.childWorkerHistory.push(deadId);
            }
          }
          logger.info(`[Restore] Pruned ${deadChildIds.length} dead child reference(s) from ${worker.label} (moved to history)`);
        }
      }
    }

    // Rebuild dependency graph for ALL restored workers.
    // Phase 1: Register standalone workers (no deps) so they exist as dependency targets.
    // Phase 2: Register workers WITH deps (their targets now exist in the graph).
    // Without Phase 1, workers with deps would have their dependency targets treated as
    // "already completed" (unknown node → skip) even if the target is still running.
    for (const [workerId, worker] of workers.entries()) {
      if (!worker.dependsOn || worker.dependsOn.length === 0) {
        try {
          registerWorkerDependencies(workerId, [], null, worker.workflowId);
        } catch (err) {
          logger.warn(`[Restore] Failed to register standalone worker ${worker.label} in graph: ${err.message}`);
        }
      }
    }
    for (const [workerId, worker] of workers.entries()) {
      if (worker.dependsOn && worker.dependsOn.length > 0) {
        const liveDeps = worker.dependsOn.filter(id => restoredIds.has(id));
        try {
          registerWorkerDependencies(workerId, liveDeps, null, worker.workflowId);
          if (liveDeps.length > 0) {
            logger.info(`[Restore] Rebuilt dependency graph for ${worker.label} (${liveDeps.length} deps)`);
          }
        } catch (err) {
          logger.warn(`[Restore] Failed to rebuild dependencies for ${worker.label}: ${err.message}`);
        }
      }
    }

    // Sync graph node status with restored worker status.
    // Without this, completed workers appear as "ready" in the graph and won't trigger dependents.
    for (const [workerId, worker] of workers.entries()) {
      if (worker.status === 'running') {
        markWorkerStarted(workerId);
      } else if (worker.status === 'completed') {
        markWorkerCompleted(workerId);
      } else if (worker.status === 'error' || worker.health === 'crashed') {
        markWorkerFailed(workerId);
      }
    }

    // Boot-time worktree GC (§3.5/E4): remove orphan worktree dirs whose owning worker
    // no longer exists (crashed during downtime). Keep dirs for live restored workers.
    try {
      const liveWorkerIds = [...workers.keys()];
      const repoPaths = [...new Set(
        [...workers.values()].map(w => w.repoPath).filter(p => typeof p === 'string')
      )];
      const { removed } = await pruneWorktrees(liveWorkerIds, repoPaths);
      if (removed.length > 0) {
        logger.info(`[Restore] Pruned ${removed.length} orphan worktree dir(s)`);
      }
    } catch (gcErr) {
      logger.warn(`[Restore] Worktree GC failed (non-fatal): ${gcErr.message}`);
    }

    // After all workers restored, do a delayed crash check (allow output buffers to populate)
    setTimeout(async () => {
      try {
        logger.info('[CrashCheck] Running post-restore crash detection');
        for (const [workerId, worker] of workers.entries()) {
          // Skip completed/stopped workers — their output may contain past error strings
          if (worker.status === 'completed' || worker.status === 'stopped') continue;
          const output = outputBuffers.get(workerId) || '';
          const crashPatterns = getCrashPatterns(output);
          for (const pattern of crashPatterns) {
            if (pattern.test()) {
              if (worker.health !== 'crashed') {
                logger.error(`[CrashDetect] Worker ${workerId} (${worker.label}) crashed during previous session: ${pattern.reason}`);
                worker.health = 'crashed';
                worker.crashReason = `${pattern.reason} (detected on restore)`;
                worker.crashedAt = new Date();
                if (io) {
                  io.emit('worker:crashed', { workerId, label: worker.label, reason: worker.crashReason });
                }
                handleCrashedWorker(workerId, worker, io)
                  .catch(err => logger.error(`[CrashCheck] handleCrashedWorker failed for ${workerId}: ${err.message}`));
              }
              break;
            }
          }
        }
        logger.info('[CrashCheck] Post-restore crash detection complete');

        // Post-restore auto-promotion re-evaluation:
        // Workers at >= 90% in_progress with completion keywords in their currentStep
        // may have been missed if the auto-promotion code was deployed after the signal
        // or the server restarted before the promoted state was saved.
        // Uses shared tryAutoPromoteWorker which handles the full done-path:
        // status change, parent delivery, parent aggregation, socket events.
        let promoted = 0;
        for (const [wId, w] of workers.entries()) {
          if (tryAutoPromoteWorker(w, io, 'restore')) {
            promoted++;
          }
        }
        if (promoted > 0) {
          logger.info(`[Restore] Auto-promoted ${promoted} worker(s) to done on restore`);
        }
      } catch (err) {
        logger.error(`[CrashCheck] Post-restore crash detection failed: ${err.message}`);
      }
    }, 5000); // Wait 5 seconds for output buffers to populate

  } catch (error) {
    if (error.code !== 'ENOENT') {
      logger.error(`[persistence] Failed to restore worker state: ${error.message}`);
    }
  }
}
