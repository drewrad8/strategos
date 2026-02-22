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

import { isProtectedWorker } from './templates.js';
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
import {
  startSession as dbStartSession,
} from '../workerOutputDb.js';

// ============================================
// WORKER CHECKPOINTING
// ============================================

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
    console.log(`[Checkpoint] Saved checkpoint for ${worker.label} (${workerId}) → ${filePath} [reason: ${reason}]`);

    // Keep only last 50 checkpoints to prevent disk bloat
    try {
      const files = readdirSync(CHECKPOINT_DIR)
        .filter(f => f.endsWith('.json'))
        .map(f => ({ name: f, mtime: statSync(path.join(CHECKPOINT_DIR, f)).mtime }))
        .sort((a, b) => b.mtime - a.mtime);
      for (const f of files.slice(50)) {
        try { unlinkSync(path.join(CHECKPOINT_DIR, f.name)); } catch { /* best-effort cleanup */ }
      }
    } catch (e) {
      // Cleanup is best-effort
    }
  } catch (err) {
    console.error(`[Checkpoint] Failed to write checkpoint for ${workerId}:`, err.message);
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

async function _doSaveWorkerState() {
  try {
    const state = {
      timestamp: new Date().toISOString(),
      workers: Array.from(workers.values()).map(w => ({
        id: w.id,
        label: w.label,
        project: w.project,
        workingDir: w.workingDir,
        tmuxSession: w.tmuxSession,
        backend: w.backend || 'claude',
        createdAt: w.createdAt,
        // Timestamps for stalled/crash detection
        lastOutput: w.lastOutput,
        lastActivity: w.lastActivity,
        // Settings
        autoAccept: w.autoAccept ?? true,
        autoAcceptPaused: w.autoAcceptPaused ?? false,
        ralphMode: w.ralphMode ?? false,
        ralphToken: w.ralphToken ?? null,
        // Task context for respawn
        task: w.task ?? null,
        parentWorkerId: w.parentWorkerId ?? null,
        parentLabel: w.parentLabel ?? null,
        childWorkerIds: w.childWorkerIds || [],
        childWorkerHistory: w.childWorkerHistory || [],
        // Dependency tracking (for graph reconstruction on restore)
        dependsOn: w.dependsOn || [],
        workflowId: w.workflowId ?? null,
        taskId: w.taskId ?? null,
        // Runtime state (survives restart)
        status: w.status ?? 'running',
        health: w.health ?? 'healthy',
        ralphStatus: w.ralphStatus ?? null,
        ralphProgress: w.ralphProgress ?? null,
        ralphCurrentStep: w.ralphCurrentStep ?? null,
        ralphSignalCount: w.ralphSignalCount ?? 0,
        firstRalphAt: w.firstRalphAt ?? null,
        lastRalphSignalAt: w.lastRalphSignalAt ?? null,
        // Ralph completion data (must survive restart for dependent workers)
        ralphSignaledAt: w.ralphSignaledAt ?? null,
        ralphLearnings: w.ralphLearnings ?? null,
        ralphOutputs: w.ralphOutputs ?? null,
        ralphArtifacts: w.ralphArtifacts ?? null,
        ralphBlockedReason: w.ralphBlockedReason ?? null,
        _ralphManuallySignaled: w._ralphManuallySignaled ?? false,
        // Lifecycle timestamps
        completedAt: w.completedAt ?? null,
        awaitingReviewAt: w.awaitingReviewAt ?? null,
        crashReason: w.crashReason ?? null,
        crashedAt: w.crashedAt ?? null,
        // Bulldoze mode state
        bulldozeMode: w.bulldozeMode ?? false,
        bulldozePaused: w.bulldozePaused ?? false,
        bulldozePauseReason: w.bulldozePauseReason ?? null,
        bulldozeCyclesCompleted: w.bulldozeCyclesCompleted ?? 0,
        bulldozeStartedAt: w.bulldozeStartedAt ?? null,
        bulldozeLastCycleAt: w.bulldozeLastCycleAt ?? null,
        bulldozeConsecutiveErrors: w.bulldozeConsecutiveErrors ?? 0,
        // Sentinel role-violation counter (must survive restart)
        roleViolations: w.roleViolations ?? 0,
        // Delegation metrics (for tracking general behavior)
        delegationMetrics: w.delegationMetrics ?? null,
      }))
    };

    // Atomic write: write to temp file then rename to prevent corruption on crash
    const tmpFile = PERSISTENCE_FILE + '.tmp';
    await fs.writeFile(tmpFile, JSON.stringify(state, null, 2));
    await fs.rename(tmpFile, PERSISTENCE_FILE);
  } catch (error) {
    console.error('Failed to save worker state:', error.message);
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
      workers: Array.from(workers.values()).map(w => ({
        id: w.id,
        label: w.label,
        project: w.project,
        workingDir: w.workingDir,
        tmuxSession: w.tmuxSession,
        backend: w.backend || 'claude',
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
        // Ralph completion data (must survive restart for dependent workers)
        ralphSignaledAt: w.ralphSignaledAt ?? null,
        ralphLearnings: w.ralphLearnings ?? null,
        ralphOutputs: w.ralphOutputs ?? null,
        ralphArtifacts: w.ralphArtifacts ?? null,
        ralphBlockedReason: w.ralphBlockedReason ?? null,
        _ralphManuallySignaled: w._ralphManuallySignaled ?? false,
        // Lifecycle timestamps
        completedAt: w.completedAt ?? null,
        awaitingReviewAt: w.awaitingReviewAt ?? null,
        crashReason: w.crashReason ?? null,
        crashedAt: w.crashedAt ?? null,
        // Bulldoze mode state
        bulldozeMode: w.bulldozeMode ?? false,
        bulldozePaused: w.bulldozePaused ?? false,
        bulldozePauseReason: w.bulldozePauseReason ?? null,
        bulldozeCyclesCompleted: w.bulldozeCyclesCompleted ?? 0,
        bulldozeStartedAt: w.bulldozeStartedAt ?? null,
        bulldozeLastCycleAt: w.bulldozeLastCycleAt ?? null,
        bulldozeConsecutiveErrors: w.bulldozeConsecutiveErrors ?? 0,
        roleViolations: w.roleViolations ?? 0,
        delegationMetrics: w.delegationMetrics ?? null,
      }))
    };

    // Atomic write: temp file then rename (even in sync crash handler)
    const tmpFile = PERSISTENCE_FILE + '.tmp';
    writeFileSync(tmpFile, JSON.stringify(state, null, 2));
    renameSync(tmpFile, PERSISTENCE_FILE);
    console.error(`[CrashSave] Saved ${state.workers.length} workers to ${PERSISTENCE_FILE}`);
  } catch (error) {
    console.error('[CrashSave] Failed to save worker state:', error.message);
  }
}

export async function restoreWorkerState(io = null) {
  try {
    // Defense-in-depth: cap persistence file size to prevent memory exhaustion on tampered file
    const MAX_PERSISTENCE_SIZE = 10 * 1024 * 1024; // 10MB
    const fileStat = await fs.stat(PERSISTENCE_FILE).catch(() => null);
    if (fileStat && fileStat.size > MAX_PERSISTENCE_SIZE) {
      console.error(`[Restore] Persistence file too large (${fileStat.size} bytes, max ${MAX_PERSISTENCE_SIZE}) — refusing to load`);
      return [];
    }

    const data = await fs.readFile(PERSISTENCE_FILE, 'utf-8');
    const state = JSON.parse(data);

    // Schema validation: ensure saved state has expected structure
    if (!state || !Array.isArray(state.workers)) {
      console.error('[Restore] Invalid persistence file: missing workers array');
      return [];
    }

    // Cap workers array size (defense-in-depth against tampered file with millions of entries)
    const MAX_RESTORE_WORKERS = 500;
    if (state.workers.length > MAX_RESTORE_WORKERS) {
      console.error(`[Restore] Too many workers in persistence file (${state.workers.length}, max ${MAX_RESTORE_WORKERS}) — truncating`);
      state.workers = state.workers.slice(0, MAX_RESTORE_WORKERS);
    }

    console.log(`Restoring ${state.workers.length} workers from saved state...`);

    const restoredIds = new Set();
    for (const savedWorker of state.workers) {
      // Validate required fields before attempting restore
      if (!savedWorker || typeof savedWorker.id !== 'string' || !savedWorker.id ||
          typeof savedWorker.tmuxSession !== 'string' || !savedWorker.tmuxSession ||
          typeof savedWorker.workingDir !== 'string' || !savedWorker.workingDir) {
        console.warn(`  Skipping entry with missing required fields (id/tmuxSession/workingDir)`);
        continue;
      }
      // Validate worker ID format (defense-in-depth: ID is used in checkpoint filenames)
      if (!/^[a-zA-Z0-9_-]{1,36}$/.test(savedWorker.id)) {
        console.warn(`  Skipping entry with invalid worker ID format: ${String(savedWorker.id).slice(0, 50)}`);
        continue;
      }
      // Check if tmux session still exists
      const exists = await sessionExists(savedWorker.tmuxSession);
      if (!exists) {
        console.log(`  Skipping ${savedWorker.label} (${savedWorker.id}) - session no longer exists`);
        // Clean up orphaned bulldoze state file
        if (savedWorker.workingDir && savedWorker.bulldozeMode) {
          const normalizedWd = path.resolve(savedWorker.workingDir);
          if (path.isAbsolute(normalizedWd) && !normalizedWd.includes('..')) {
            const bulldozeStatePath = path.join(normalizedWd, 'tmp', `bulldoze-state-${savedWorker.id}.md`);
            try { await fs.unlink(bulldozeStatePath); console.log(`  Cleaned up orphaned bulldoze state: ${bulldozeStatePath}`); } catch { /* ENOENT is fine */ }
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
                    console.log(`  Cleaned up orphaned rules file: ${f}`);
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
                    console.log(`  Cleaned up orphaned Gemini context: ${f}`);
                  }
                }
                // Remove Strategos-managed master GEMINI.md
                try {
                  const masterContent = await fs.readFile(path.join(normalizedDir, 'GEMINI.md'), 'utf-8');
                  if (masterContent.includes('<!-- Strategos managed -->')) {
                    await fs.unlink(path.join(normalizedDir, 'GEMINI.md'));
                    console.log(`  Cleaned up orphaned master GEMINI.md`);
                  }
                } catch { /* ignore ENOENT */ }
              } catch (e) { /* ignore ENOENT */ }
            }
          }
        }
        continue;
      }

      // Validate session name from saved state (defense-in-depth against tampered persistence file)
      try {
        validateSessionName(savedWorker.tmuxSession);
      } catch {
        console.warn(`  Skipping ${savedWorker.label} (${savedWorker.id}) - invalid session name in saved state`);
        continue;
      }

      // Verify session is functional by attempting capture-pane (not just has-session)
      // has-session can return true for zombie sessions that can't actually be used
      try {
        await spawnTmux(['capture-pane', '-t', savedWorker.tmuxSession, '-p']);
      } catch {
        console.warn(`  Skipping ${savedWorker.label} (${savedWorker.id}) - session exists but capture-pane failed (zombie session)`);
        continue;
      }

      // Verify the process inside the tmux session is still alive (not just a dead shell)
      let _processHealthy = true;
      try {
        const { stdout: paneCmd } = await spawnTmux(['list-panes', '-t', savedWorker.tmuxSession, '-F', '#{pane_current_command}']);
        const cmd = (paneCmd || '').trim();
        if (!cmd || cmd === 'bash' || cmd === 'zsh' || cmd === 'sh') {
          console.warn(`  [Restore] Session ${savedWorker.tmuxSession} has dead process (${cmd || 'empty'}), will mark as crashed`);
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
        tmuxSession: savedWorker.tmuxSession,
        // Backend ('claude' or 'gemini')
        backend: (savedWorker.backend === 'gemini') ? 'gemini' : 'claude',
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
        outputBuffers.set(savedWorker.id, '');
        commandQueues.set(savedWorker.id, []);

        // Notify UI about restored worker
        if (io) {
          io.emit('worker:created', normalizeWorker(worker));
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
              const restoreMsg = w.backend === 'gemini'
                ? `Signal your progress via Ralph. Run: curl -s -X POST http://localhost:38007/api/ralph/signal/by-worker/${wId} -H "Content-Type: application/json" -d '{"status":"in_progress","progress":10,"currentStep":"what you are doing"}'`
                : `Signal your progress via the strategos_signal MCP tool: strategos_signal(status: "in_progress", progress: 10, currentStep: "what you are doing"). Your worker ID is ${wId} (auto-detected if omitted). Use strategos_whoami if unsure of your identity.`;
              sendInputDirect(wId, restoreMsg).catch(err => { console.warn(`[Ralph] Failed to send restore reminder: ${err.message}`); });
              console.log(`[Ralph] Sent post-restore reminder to ${worker.label}`);
            }
          }, 30000); // 30s after restore (shorter than 60s spawn delay since worker already running)
        }

        restoredIds.add(savedWorker.id);
        console.log(`  Restored ${savedWorker.label}`);
      } catch (workerErr) {
        console.error(`[Restore] Failed to initialize worker ${savedWorker.id} (${savedWorker.label}): ${workerErr.message}`);
        // Clean up partial state to prevent orphaned entries
        stopPtyCapture(savedWorker.id);
        stopHealthMonitor(savedWorker.id);
        workers.delete(savedWorker.id);
        outputBuffers.delete(savedWorker.id);
        commandQueues.delete(savedWorker.id);
        continue; // Skip to next worker, don't abort entire restore
      }
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
          console.log(`  Pruned ${deadChildIds.length} dead child reference(s) from ${worker.label} (moved to history)`);
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
          console.warn(`  Failed to register standalone worker ${worker.label} in graph: ${err.message}`);
        }
      }
    }
    for (const [workerId, worker] of workers.entries()) {
      if (worker.dependsOn && worker.dependsOn.length > 0) {
        const liveDeps = worker.dependsOn.filter(id => restoredIds.has(id));
        try {
          registerWorkerDependencies(workerId, liveDeps, null, worker.workflowId);
          if (liveDeps.length > 0) {
            console.log(`  Rebuilt dependency graph for ${worker.label} (${liveDeps.length} deps)`);
          }
        } catch (err) {
          console.warn(`  Failed to rebuild dependencies for ${worker.label}: ${err.message}`);
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

    // After all workers restored, do a delayed crash check (allow output buffers to populate)
    setTimeout(async () => {
      try {
        console.log('[CrashCheck] Running post-restore crash detection...');
        for (const [workerId, worker] of workers.entries()) {
          // Skip completed/stopped workers — their output may contain past error strings
          if (worker.status === 'completed' || worker.status === 'stopped') continue;
          const output = outputBuffers.get(workerId) || '';
          const crashPatterns = getCrashPatterns(output);
          for (const pattern of crashPatterns) {
            if (pattern.test()) {
              if (worker.health !== 'crashed') {
                console.error(`[CrashDetect] Worker ${workerId} (${worker.label}) crashed during previous session: ${pattern.reason}`);
                worker.health = 'crashed';
                worker.crashReason = `${pattern.reason} (detected on restore)`;
                worker.crashedAt = new Date();
                if (io) {
                  io.emit('worker:crashed', { workerId, label: worker.label, reason: worker.crashReason });
                }
                handleCrashedWorker(workerId, worker, io)
                  .catch(err => console.error(`[CrashCheck] handleCrashedWorker failed for ${workerId}: ${err.message}`));
              }
              break;
            }
          }
        }
        console.log('[CrashCheck] Post-restore crash detection complete');

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
          console.log(`[Restore] Auto-promoted ${promoted} worker(s) to done on restore`);
        }
      } catch (err) {
        console.error(`[CrashCheck] Post-restore crash detection failed: ${err.message}`);
      }
    }, 5000); // Wait 5 seconds for output buffers to populate

  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error('Failed to restore worker state:', error.message);
    }
  }
}
