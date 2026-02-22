/**
 * Worker lifecycle management: spawn, kill, complete, dismiss, discover.
 * Handles initialization, teardown, dependency triggering, and headless/batch operations.
 */

import crypto from 'crypto';
import {
  workers, outputBuffers, commandQueues, ptyInstances,
  pendingWorkers, inFlightSpawns, autoCleanupTimers, lastResizeSize,
  sessionFailCounts, respawnAttempts,
  SESSION_PREFIX, THEA_ROOT, MAX_CONCURRENT_WORKERS, AUTO_CLEANUP_DELAY_MS,
  DEFAULT_COLS, DEFAULT_ROWS, STRATEGOS_API,
  TMUX_CB_THRESHOLD, TMUX_CB_WINDOW_MS,
  path, fs, spawn, uuidv4,
  addActivity, normalizeWorker,
  escapePromptXml, escapeJsonValue,
  spawnTmux, safeSendKeys, validateSessionName, sessionExists,
  getWorkerDeathCallback,
  isCircuitBreakerTripped, incrementCircuitBreaker, resetCircuitBreakerOnSuccess,
} from './state.js';

import {
  detectWorkerType, isProtectedWorker,
  writeStrategosContext, removeStrategosContext,
  writeGeminiContext, removeGeminiContext,
} from './templates.js';

// ============================================
// TOOL RESTRICTIONS BY ROLE
// ============================================

// Roles that are read-only / delegation-only — no Edit, Write, NotebookEdit, or Task
const READ_ONLY_ROLES = new Set(['GENERAL', 'COLONEL', 'REVIEW', 'RESEARCH']);

// --tools flag: comma-separated, restricts which built-in tools EXIST (not just permissions)
// --allowedTools only controls permission prompts — does NOT prevent usage!
const READ_ONLY_TOOLS = 'Read,Glob,Grep,Bash,WebSearch,WebFetch';

/**
 * Returns additional CLI args for `claude` based on worker role.
 * Read-only roles get --tools to structurally remove Edit/Write/NotebookEdit.
 * Also --disallowedTools for dangerous Bash patterns.
 */
function getToolRestrictionArgs(label) {
  const { prefix } = detectWorkerType(label);
  if (prefix && READ_ONLY_ROLES.has(prefix)) {
    console.log(`[SpawnWorker] Tool restriction (--tools): ${READ_ONLY_TOOLS} for ${label}`);
    return [
      '--tools', READ_ONLY_TOOLS,
      '--disallowedTools', 'Bash(rm *)', 'Bash(rmdir *)',
    ];
  }
  return [];
}

import {
  startPtyCapture, stopPtyCapture, sendInputDirect, sendInput,
} from './output.js';

import {
  startHealthMonitor, stopHealthMonitor,
  addRespawnSuggestion,
} from './health.js';

import { clearWorkerContext } from '../summaryService.js';
import { getLogger } from '../logger.js';
import {
  startSession as dbStartSession,
  endSession as dbEndSession,
} from '../workerOutputDb.js';
import { recordWorkerSpawn } from '../metricsService.js';
import {
  registerWorkerDependencies,
  markWorkerStarted,
  markWorkerCompleted,
  markWorkerFailed,
  removeWorkerDependencies,
  canWorkerStart,
  registerWorkflowWorker,
} from '../dependencyGraph.js';
import { MAX_SYSTEM_PROMPT_LENGTH, MAX_TIMEOUT_MS } from '../validation.js';

// ============================================
// WORKER INITIALIZATION
// ============================================

function initializeWorker(id, config, io) {
  const {
    label, projectName, projectPath, sessionName, ralphToken,
    dependsOn, workflowId, taskId,
    parentWorkerId, parentLabel, task, initialInput,
    autoAccept, ralphMode, backend,
  } = config;

  const worker = {
    id,
    label,
    project: projectName,
    workingDir: projectPath,
    tmuxSession: sessionName,
    status: 'running',
    mode: 'tmux',
    backend: backend || 'claude',
    createdAt: new Date(),
    lastActivity: new Date(),
    lastOutput: new Date(),
    health: 'healthy',
    queuedCommands: 0,
    waitingAtPrompt: false,
    dependsOn,
    workflowId,
    taskId,
    parentWorkerId,
    parentLabel,
    task,
    childWorkerIds: [],
    childWorkerHistory: [],
    autoAccept,
    autoAcceptPaused: false,
    lastAutoAcceptHash: null,
    ralphMode,
    ralphToken,
    ralphStatus: ralphMode ? 'pending' : null,
    ralphSignaledAt: null,
    ralphLearnings: null,
    ralphProgress: null,
    ralphCurrentStep: null,
    ralphOutputs: null,
    ralphArtifacts: null,
    ralphSignalCount: 0,
    firstRalphAt: null,
    lastRalphSignalAt: null,
    bulldozeMode: false,
    bulldozePaused: false,
    bulldozeIdleCount: 0,
    bulldozeCyclesCompleted: 0,
    bulldozeConsecutiveErrors: 0,
    bulldozeStartedAt: null,
    bulldozeLastCycleAt: null,
    // Delegation metrics — only meaningful for generals, but initialized for all
    // so downstream code doesn't need null checks
    delegationMetrics: {
      spawnsIssued: 0,
      roleViolations: 0,
      filesEdited: 0,
      commandsRun: 0,
    },
  };

  workers.set(id, worker);
  outputBuffers.set(id, '');
  commandQueues.set(id, []);

  markWorkerStarted(id);
  dbStartSession(worker);
  startPtyCapture(id, sessionName, io);
  startHealthMonitor(id, io);

  // Track parent-child relationship
  if (parentWorkerId) {
    const parentWorker = workers.get(parentWorkerId);
    if (parentWorker) {
      parentWorker.childWorkerIds = parentWorker.childWorkerIds || [];
      // Idempotent push: prevent duplicate child IDs (e.g. from retry/re-register)
      if (!parentWorker.childWorkerIds.includes(id)) {
        parentWorker.childWorkerIds.push(id);
      }
      // Track delegation: parent spawned a child
      if (parentWorker.delegationMetrics) {
        parentWorker.delegationMetrics.spawnsIssued++;
      }
    } else {
      // Parent doesn't exist (already killed/dismissed) — don't silently create an orphan
      console.warn(`[InitWorker] parentWorkerId "${parentWorkerId}" not found for worker ${id} (${label}). Setting parentWorkerId to null.`);
      worker.parentWorkerId = null;
      worker.parentLabel = null;
    }
  }

  // Send task/initial input after Claude initializes
  setTimeout(async () => {
    try {
      const currentWorker = workers.get(id);
      if (currentWorker && currentWorker.status === 'running') {
        const workerType = detectWorkerType(label);
        let stdinMsg = null;

        if (initialInput) {
          stdinMsg = initialInput;
        } else if (task) {
          if (typeof task === 'string') {
            stdinMsg = `Here is your task:\n\n${escapePromptXml(task)}`;
          } else if (typeof task === 'object' && task.description) {
            let taskMsg = `Here is your task:\n\n${escapePromptXml(task.description)}`;
            if (task.purpose) taskMsg += `\n\nPurpose: ${escapePromptXml(task.purpose)}`;
            if (task.endState) taskMsg += `\nSuccess criteria: ${escapePromptXml(task.endState)}`;
            if (task.keyTasks && Array.isArray(task.keyTasks)) {
              taskMsg += `\n\nKey steps:\n${task.keyTasks.map(t => '- ' + escapePromptXml(t)).join('\n')}`;
            }
            if (task.constraints && Array.isArray(task.constraints)) {
              taskMsg += `\n\nConstraints:\n${task.constraints.map(c => '- ' + escapePromptXml(c)).join('\n')}`;
            }
            stdinMsg = taskMsg;
          }
        } else if (workerType.isGeneral) {
          stdinMsg = 'Awaiting orders. You have no assigned task yet — wait for the human to provide one. Do NOT begin autonomous operations or start scouting.';
        }

        if (stdinMsg) {
          await sendInputDirect(id, stdinMsg);
          console.log(`Sent initial task to ${label}`);
        }
      }
    } catch (err) {
      console.error(`Failed to send initial task to ${label}:`, err.message);
    }
  }, 3000);

  // Ralph adoption reminder
  if (ralphMode && ralphToken) {
    setTimeout(() => {
      const w = workers.get(id);
      if (w && w.ralphMode && w.status === 'running' && (!w.ralphStatus || w.ralphStatus === 'pending')) {
        const rulesLocation = worker.backend === 'gemini' ? 'GEMINI.md' : '.claude/rules/';
        const reminderMsg = `Reminder: Signal your progress via Ralph. The curl command is in your rules file (${rulesLocation}).`;
        sendInputDirect(id, reminderMsg).catch(err => { console.warn(`[Ralph] Failed to send reminder: ${err.message}`); });
        console.log(`[Ralph] Sent 60s reminder to ${label}`);
      }
    }, 60000);
  }

  return worker;
}

// ============================================
// WORKER SPAWNING
// ============================================

export async function spawnWorker(projectPath, label = null, io = null, options = {}) {
  const projectName = path.basename(projectPath);
  const workerLabel = label || projectName;

  const isGeneral = workerLabel.toUpperCase().startsWith('GENERAL:');

  if (isGeneral && options.autoAccept === undefined) {
    options.autoAccept = true;
  }

  const {
    dependsOn = [],
    onComplete = null,
    workflowId = null,
    taskId = null,
    task = null,
    parentWorkerId = null,
    parentLabel = null,
    initialInput = null,
    autoAccept = true,
    ralphMode = true,
    allowDuplicate = false,
    externalRalphToken = null,
    backend = 'claude',
  } = options;

  const id = uuidv4().slice(0, 8);
  const sessionName = `${SESSION_PREFIX}${id}`;

  const stats = await fs.stat(projectPath).catch(() => null);
  if (!stats || !stats.isDirectory()) {
    throw new Error(`Invalid project path: ${projectPath}`);
  }

  const runningWorkers = Array.from(workers.values()).filter(w => w.status === 'running');
  const totalActive = runningWorkers.length + pendingWorkers.size + inFlightSpawns.size;
  if (totalActive >= MAX_CONCURRENT_WORKERS) {
    throw new Error(`Cannot spawn worker: maximum concurrent workers (${MAX_CONCURRENT_WORKERS}) reached. ` +
      `Currently running: ${runningWorkers.length}, pending: ${pendingWorkers.size}, spawning: ${inFlightSpawns.size}. Kill some workers or wait for completion.`);
  }

  const spawnKey = `${workerLabel}::${projectName}`;
  if (!allowDuplicate) {
    const existingDuplicate = runningWorkers.find(
      w => w.label === workerLabel && w.project === projectName
    );
    if (existingDuplicate) {
      throw new Error(
        `Duplicate worker: "${workerLabel}" for project "${projectName}" already running as ${existingDuplicate.id}. ` +
        `Use allowDuplicate option to spawn anyway.`
      );
    }
    for (const [pendingId, pending] of pendingWorkers.entries()) {
      if (pending.label === workerLabel && path.basename(pending.projectPath) === projectName) {
        throw new Error(
          `Duplicate worker: "${workerLabel}" for project "${projectName}" is pending (waiting on dependencies) as ${pendingId}. ` +
          `Use allowDuplicate option to spawn anyway.`
        );
      }
    }
    if (inFlightSpawns.has(spawnKey)) {
      throw new Error(
        `Duplicate worker: "${workerLabel}" for project "${projectName}" is currently being spawned. ` +
        `Use allowDuplicate option to spawn anyway.`
      );
    }
  }
  inFlightSpawns.add(spawnKey);

  const depResult = registerWorkerDependencies(id, dependsOn, onComplete, workflowId);
  if (!depResult.success) {
    throw new Error(depResult.error);
  }

  const canStart = dependsOn.length === 0 || canWorkerStart(id);

  if (!canStart) {
    const pendingWorker = {
      id,
      label: workerLabel,
      project: projectName,
      workingDir: projectPath,
      status: 'pending',
      dependsOn,
      onComplete,
      workflowId,
      taskId,
      parentWorkerId,
      parentLabel,
      task,
      createdAt: new Date()
    };

    pendingWorkers.set(id, {
      projectPath,
      label: workerLabel,
      dependsOn,
      onComplete,
      workflowId,
      taskId,
      task,
      parentWorkerId,
      parentLabel,
      initialInput,
      io,
      autoAccept,
      ralphMode,
      externalRalphToken,
      backend,
      createdAt: Date.now()
    });

    if (workflowId && taskId) {
      registerWorkflowWorker(workflowId, taskId, id);
    }

    const activity = addActivity('worker_pending', id, workerLabel, projectName,
      `Worker "${workerLabel}" waiting on ${dependsOn.length} dependencies`);

    if (io) {
      io.emit('activity:new', activity);
    }

    inFlightSpawns.delete(spawnKey);

    return pendingWorker;
  }

  // Dependencies are satisfied, spawn immediately
  try {
    if (isCircuitBreakerTripped()) {
      throw new Error('Tmux circuit breaker tripped: too many consecutive spawn failures. Check tmux health.');
    }

    validateSessionName(sessionName);
    console.log(`[SpawnWorker] Creating worker ${id} with session ${sessionName}`);

    const spawnStartTime = Date.now();

    const ralphToken = ralphMode ? (externalRalphToken || crypto.randomBytes(16).toString('hex')) : null;

    console.log(`[SpawnWorker] Writing worker rules for ${id} (backend: ${backend})${ralphToken ? ` (Ralph token: ${ralphToken.slice(0, 8)}...)` : ''}`);
    if (backend === 'gemini') {
      await writeGeminiContext(id, workerLabel, projectPath, ralphToken, {
        parentWorkerId,
        parentLabel,
        bulldozeMode: false,
      });
    } else {
      await writeStrategosContext(id, workerLabel, projectPath, ralphToken, {
        parentWorkerId,
        parentLabel,
        bulldozeMode: false,
      });
    }
    console.log(`[SpawnWorker] Rules written, now creating tmux session ${sessionName}`);

    if (backend === 'gemini') {
      // Spawn Gemini CLI with --yolo flag for auto-approval
      // Pass GEMINI_API_KEY from server environment
      const geminiEnvArgs = [];
      if (process.env.GEMINI_API_KEY) {
        geminiEnvArgs.push('-e', `GEMINI_API_KEY=${process.env.GEMINI_API_KEY}`);
      }
      await spawnTmux([
        'new-session', '-d',
        '-s', sessionName,
        '-x', String(DEFAULT_COLS),
        '-y', String(DEFAULT_ROWS),
        ...geminiEnvArgs,
        '-c', projectPath,
        'gemini', '--yolo'
      ]);
    } else {
      const toolArgs = getToolRestrictionArgs(workerLabel);
      await spawnTmux([
        'new-session', '-d',
        '-s', sessionName,
        '-x', String(DEFAULT_COLS),
        '-y', String(DEFAULT_ROWS),
        '-c', projectPath,
        'claude', ...toolArgs
      ]);
    }
    console.log(`[SpawnWorker] tmux session ${sessionName} created successfully`);
    resetCircuitBreakerOnSuccess();

    const spawnDuration = Date.now() - spawnStartTime;
    try {
      recordWorkerSpawn(id, spawnDuration, { project: projectName, label: workerLabel });
    } catch (metricsErr) {
      console.error(`[SpawnWorker] Metrics recording failed (non-fatal): ${metricsErr.message}`);
    }

    const worker = initializeWorker(id, {
      label: workerLabel, projectName, projectPath, sessionName, ralphToken,
      dependsOn, workflowId, taskId,
      parentWorkerId, parentLabel, task, initialInput,
      autoAccept, ralphMode, backend,
    }, io);

    inFlightSpawns.delete(spawnKey);

    if (workflowId && taskId) {
      registerWorkflowWorker(workflowId, taskId, id);
    }

    const activity = addActivity('worker_started', id, workerLabel, projectName,
      `Started worker "${workerLabel}" in ${projectPath}`);

    if (io) {
      io.emit('worker:created', normalizeWorker(worker));
      io.emit('activity:new', activity);
    }

    const { saveWorkerState } = await import('./persistence.js');
    await saveWorkerState();

    return worker;
  } catch (error) {
    inFlightSpawns.delete(spawnKey);

    if (!workers.has(id)) {
      incrementCircuitBreaker();
      console.error(`[CircuitBreaker] Tmux spawn failure`);
    }

    markWorkerFailed(id);
    removeWorkerDependencies(id);

    if (workers.has(id)) {
      stopPtyCapture(id);
      stopHealthMonitor(id);
      workers.delete(id);
      outputBuffers.delete(id);
      commandQueues.delete(id);
      sessionFailCounts.delete(id);
      ptyInstances.delete(id);
      lastResizeSize.delete(id);
    }
    respawnAttempts.delete(id);

    if (backend === 'gemini') {
      await removeGeminiContext(projectPath, id);
    } else {
      await removeStrategosContext(projectPath, id);
    }

    const activity = addActivity('error', id, workerLabel, projectName,
      `Failed to start worker: ${error.message}`);

    if (io) {
      io.emit('activity:new', activity);
    }

    throw error;
  }
}

async function startPendingWorker(workerId, io = null) {
  const pending = pendingWorkers.get(workerId);
  if (!pending) return null;

  if (!canWorkerStart(workerId)) {
    console.log(`[StartPending] Worker ${workerId} (${pending.label}) cannot start`);
    pendingWorkers.delete(workerId);
    return null;
  }

  const runningWorkers = Array.from(workers.values()).filter(w => w.status === 'running');
  if (runningWorkers.length + inFlightSpawns.size >= MAX_CONCURRENT_WORKERS) {
    console.warn(`[StartPending] Worker ${workerId} (${pending.label}) blocked — at limit`);
    pendingWorkers.set(workerId, pending);
    return null;
  }

  pendingWorkers.delete(workerId);

  const sessionName = `${SESSION_PREFIX}${workerId}`;
  const projectName = path.basename(pending.projectPath);
  const effectiveIo = io || pending.io;

  try {
    if (isCircuitBreakerTripped()) {
      throw new Error('Tmux circuit breaker tripped: too many consecutive spawn failures. Check tmux health.');
    }

    validateSessionName(sessionName);

    const ralphToken = pending.ralphMode ? (pending.externalRalphToken || crypto.randomBytes(16).toString('hex')) : null;

    const pendingBackend = pending.backend || 'claude';
    if (pendingBackend === 'gemini') {
      await writeGeminiContext(workerId, pending.label, pending.projectPath, ralphToken);
    } else {
      await writeStrategosContext(workerId, pending.label, pending.projectPath, ralphToken);
    }

    if (pendingBackend === 'gemini') {
      const geminiEnvArgs = [];
      if (process.env.GEMINI_API_KEY) {
        geminiEnvArgs.push('-e', `GEMINI_API_KEY=${process.env.GEMINI_API_KEY}`);
      }
      await spawnTmux([
        'new-session', '-d',
        '-s', sessionName,
        '-x', String(DEFAULT_COLS),
        '-y', String(DEFAULT_ROWS),
        ...geminiEnvArgs,
        '-c', pending.projectPath,
        'gemini', '--yolo'
      ]);
    } else {
      const toolArgs = getToolRestrictionArgs(pending.label);
      await spawnTmux([
        'new-session', '-d',
        '-s', sessionName,
        '-x', String(DEFAULT_COLS),
        '-y', String(DEFAULT_ROWS),
        '-c', pending.projectPath,
        'claude', ...toolArgs
      ]);
    }
    resetCircuitBreakerOnSuccess();

    const worker = initializeWorker(workerId, {
      label: pending.label, projectName, projectPath: pending.projectPath, sessionName, ralphToken,
      dependsOn: pending.dependsOn, workflowId: pending.workflowId, taskId: pending.taskId,
      parentWorkerId: pending.parentWorkerId, parentLabel: pending.parentLabel,
      task: pending.task, initialInput: pending.initialInput,
      autoAccept: pending.autoAccept ?? true, ralphMode: pending.ralphMode || false,
      backend: pending.backend || 'claude',
    }, effectiveIo);

    const activity = addActivity('worker_started', workerId, pending.label, projectName,
      `Started worker "${pending.label}" (dependencies satisfied)`);

    if (effectiveIo) {
      effectiveIo.emit('worker:created', normalizeWorker(worker));
      effectiveIo.emit('worker:dependencies_satisfied', { workerId });
      effectiveIo.emit('activity:new', activity);
    }

    const { saveWorkerState } = await import('./persistence.js');
    await saveWorkerState();

    return worker;
  } catch (error) {
    if (!workers.has(workerId)) {
      incrementCircuitBreaker();
    }

    markWorkerFailed(workerId);
    removeWorkerDependencies(workerId);
    pendingWorkers.delete(workerId);

    if (workers.has(workerId)) {
      stopPtyCapture(workerId);
      stopHealthMonitor(workerId);
      workers.delete(workerId);
      outputBuffers.delete(workerId);
      commandQueues.delete(workerId);
      sessionFailCounts.delete(workerId);
      lastResizeSize.delete(workerId);
    }
    respawnAttempts.delete(workerId);

    if (pendingBackend === 'gemini') {
      await removeGeminiContext(pending.projectPath, workerId);
    } else {
      await removeStrategosContext(pending.projectPath, workerId);
    }

    const activity = addActivity('error', workerId, pending.label, projectName,
      `Failed to start pending worker: ${error.message}`);

    if (effectiveIo) {
      effectiveIo.emit('activity:new', activity);
    }

    throw error;
  }
}

// ============================================
// WORKER TEARDOWN / CLEANUP / KILL
// ============================================

async function teardownWorker(workerId, worker, io, { activityMessage, logPrefix = 'Teardown', skipTmuxKill = false } = {}) {
  const deathCb = getWorkerDeathCallback();
  if (deathCb && worker.ralphToken) {
    try { deathCb(worker); } catch (e) { /* ignore */ }
  }

  stopPtyCapture(workerId);

  if (!skipTmuxKill && worker.tmuxSession) {
    try {
      validateSessionName(worker.tmuxSession);
      await spawnTmux(['kill-session', '-t', worker.tmuxSession]);
    } catch { /* already dead or invalid */ }
  }

  dbEndSession(workerId, 'stopped');

  if (worker.workingDir) {
    if (worker.backend === 'gemini') {
      await removeGeminiContext(worker.workingDir, workerId);
    } else {
      await removeStrategosContext(worker.workingDir, workerId);
    }
  }

  try {
    const failedDependents = markWorkerFailed(workerId);
    for (const depId of failedDependents) {
      if (pendingWorkers.has(depId)) {
        console.log(`[${logPrefix}] Removing orphaned pending worker ${depId}`);
        pendingWorkers.delete(depId);
      }
    }
  } catch (e) {
    // Worker may not have been registered
  }

  if (worker.parentWorkerId) {
    const parent = workers.get(worker.parentWorkerId);
    if (parent?.childWorkerIds) {
      // Use splice-by-index instead of filter-and-reassign to avoid race condition:
      // Two concurrent teardowns could both read the same array, filter out their own ID,
      // and the second write would overwrite the first (re-adding the first child).
      // Splice mutates in-place on the same array reference, so concurrent removals are safe.
      const idx = parent.childWorkerIds.indexOf(workerId);
      if (idx !== -1) {
        parent.childWorkerIds.splice(idx, 1);
      }
      // Preserve history of all children that ever existed
      if (!parent.childWorkerHistory) parent.childWorkerHistory = [];
      if (!parent.childWorkerHistory.includes(workerId)) {
        parent.childWorkerHistory.push(workerId);
      }
    }
  }

  worker.status = 'stopped';
  workers.delete(workerId);
  outputBuffers.delete(workerId);
  commandQueues.delete(workerId);
  sessionFailCounts.delete(workerId);
  ptyInstances.delete(workerId);
  lastResizeSize.delete(workerId);
  respawnAttempts.delete(workerId);
  const acTimer = autoCleanupTimers.get(workerId);
  if (acTimer) { clearTimeout(acTimer); autoCleanupTimers.delete(workerId); }
  clearWorkerContext(workerId);
  removeWorkerDependencies(workerId);
  stopHealthMonitor(workerId);

  // Clean up bulldoze state file if it exists
  if (worker.workingDir) {
    const bulldozeStatePath = path.join(worker.workingDir, 'tmp', `bulldoze-state-${workerId}.md`);
    try { await fs.unlink(bulldozeStatePath); } catch { /* ENOENT is fine */ }
  }

  console.log(`[${logPrefix}] Worker ${workerId} cleanup complete`);

  const activity = addActivity('worker_stopped', workerId, worker.label, worker.project,
    activityMessage || `Stopped worker "${worker.label}"`);

  if (io) {
    io.emit('worker:deleted', { workerId });
    io.emit('activity:new', activity);
  }

  const { saveWorkerStateImmediate } = await import('./persistence.js');
  await saveWorkerStateImmediate();
}

export async function cleanupWorker(workerId, io) {
  const worker = workers.get(workerId);
  if (!worker) return;

  if (worker.beingCleanedUp) return;

  const { writeWorkerCheckpoint } = await import('./persistence.js');
  writeWorkerCheckpoint(workerId, 'cleanup');

  addRespawnSuggestion(workerId, worker);

  if (isProtectedWorker(worker)) {
    console.error(`[CleanupWorker] BLOCKED: Refusing to cleanup protected worker ${workerId} (${worker.label}).`);
    if (io) {
      io.emit('worker:kill:blocked', { workerId, label: worker.label, reason: 'protected_tier_cleanup' });
    }
    return;
  }

  await teardownWorker(workerId, worker, io, {
    activityMessage: `Worker "${worker.label}" cleaned up`,
    logPrefix: 'CleanupWorker',
  });
}

export async function killWorker(workerId, io = null, options = {}) {
  const worker = workers.get(workerId);

  if (!worker) {
    console.log(`[KillWorker] Worker ${workerId} already removed — skipping (idempotent)`);
    return;
  }

  if (worker.beingCleanedUp) {
    console.log(`[KillWorker] Worker ${workerId} already being cleaned up — skipping (idempotent)`);
    return;
  }
  worker.beingCleanedUp = true;

  // Worker-initiated kill protection
  if (options.callerWorkerId) {
    const caller = workers.get(options.callerWorkerId);

    if (options.callerWorkerId === workerId) {
      worker.beingCleanedUp = false;
      console.error(`[KillWorker] BLOCKED: Worker ${options.callerWorkerId} attempted to kill itself.`);
      try { getLogger().error('Kill blocked: self-kill attempt', { callerWorkerId: options.callerWorkerId, targetWorkerId: workerId }); } catch { /* best effort */ }
      if (io) {
        io.emit('worker:kill:blocked', { workerId, callerWorkerId: options.callerWorkerId, reason: 'self_kill' });
      }
      throw new Error(`Workers cannot kill themselves.`);
    }

    let isAncestor = false;
    let current = worker;
    const visited = new Set();
    while (current?.parentWorkerId && !visited.has(current.parentWorkerId)) {
      visited.add(current.parentWorkerId);
      if (current.parentWorkerId === options.callerWorkerId) {
        isAncestor = true;
        break;
      }
      current = workers.get(current.parentWorkerId);
    }

    if (!isAncestor) {
      worker.beingCleanedUp = false;
      const callerLabel = caller?.label || 'unknown';
      console.error(`[KillWorker] BLOCKED: Worker ${options.callerWorkerId} (${callerLabel}) attempted to kill non-descendant ${workerId} (${worker.label}).`);
      try { getLogger().error('Kill blocked: not a descendant', { callerWorkerId: options.callerWorkerId, callerLabel, targetWorkerId: workerId, targetLabel: worker.label }); } catch { /* best effort */ }
      if (io) {
        io.emit('worker:kill:blocked', {
          workerId,
          callerWorkerId: options.callerWorkerId,
          callerLabel,
          targetLabel: worker.label,
          reason: 'not_descendant',
        });
      }
      throw new Error(`Worker "${callerLabel}" cannot kill "${worker.label}" — not a descendant.`);
    }

    console.log(`[KillWorker] Hierarchy validated: ${options.callerWorkerId} is ancestor of ${workerId}`);
  }

  // GENERAL protection
  if (isProtectedWorker(worker) && !options.force) {
    worker.beingCleanedUp = false;
    console.error(`[KillWorker] BLOCKED: Refusing to kill protected worker ${workerId} (${worker.label}).`);
    if (io) {
      io.emit('worker:kill:blocked', { workerId, label: worker.label, reason: 'protected_tier' });
    }
    throw new Error(`Cannot kill GENERAL-tier worker "${worker.label}" without force flag.`);
  }

  console.log(`[KillWorker] Killing worker ${workerId} (${worker.label})`);
  try {
    getLogger().warn('Worker killed', {
      workerId, label: worker.label, project: worker.project,
      callerWorkerId: options.callerWorkerId || 'human',
      reason: options.reason || 'killed',
      force: !!options.force,
      ralphStatus: worker.ralphStatus, ralphProgress: worker.ralphProgress,
    });
  } catch { /* best effort */ }

  const { writeWorkerCheckpoint } = await import('./persistence.js');
  writeWorkerCheckpoint(workerId, options.reason || 'killed');

  try {
    validateSessionName(worker.tmuxSession);
  } catch (validationError) {
    console.error(`[KillWorker] Invalid session name: ${validationError.message}`);
    throw new Error(`Invalid worker session name`);
  }

  try {
    const result = await spawnTmux(['kill-session', '-t', worker.tmuxSession]);
    console.log(`[KillWorker] Tmux kill-session result:`, result);
  } catch (error) {
    console.log(`[KillWorker] Tmux kill-session failed (may already be gone):`, error.message);
  }

  const stillExists = await sessionExists(worker.tmuxSession);
  if (stillExists) {
    console.warn(`[KillWorker] Session still exists, force killing...`);
    try {
      await spawnTmux(['kill-session', '-t', worker.tmuxSession]);
    } catch {
      // Ignore
    }
  }

  // Handle orphaned children: re-parent to grandparent or log warning
  if (worker.childWorkerIds && worker.childWorkerIds.length > 0) {
    const grandparentId = worker.parentWorkerId || null;
    const grandparent = grandparentId ? workers.get(grandparentId) : null;

    for (const childId of [...worker.childWorkerIds]) {
      const child = workers.get(childId);
      if (!child) continue;

      if (grandparent) {
        // Re-parent to grandparent
        child.parentWorkerId = grandparentId;
        child.parentLabel = grandparent.label;
        grandparent.childWorkerIds = grandparent.childWorkerIds || [];
        if (!grandparent.childWorkerIds.includes(childId)) {
          grandparent.childWorkerIds.push(childId);
        }
        console.log(`[KillWorker] Re-parented orphan ${childId} (${child.label}) to grandparent ${grandparentId} (${grandparent.label})`);
      } else {
        // No grandparent — child becomes a root worker
        child.parentWorkerId = null;
        child.parentLabel = null;
        console.warn(`[KillWorker] Orphaned child ${childId} (${child.label}) — no grandparent available, now a root worker`);
      }
    }
    // Clear the dying parent's child list (children have been re-parented)
    worker.childWorkerIds = [];
  }

  await teardownWorker(workerId, worker, io, {
    activityMessage: `Stopped worker "${worker.label}"`,
    logPrefix: 'KillWorker',
    skipTmuxKill: true,
  });

  return true;
}

export async function dismissWorker(workerId, io = null) {
  const worker = workers.get(workerId);
  if (!worker) throw new Error(`Worker ${workerId} not found`);

  let uncommittedWarning = null;
  try {
    const { stdout } = await new Promise((resolve, reject) => {
      const proc = spawn('git', ['-C', worker.workingDir, 'status', '--porcelain'], { timeout: 5000 });
      let stdout = '', stderr = '';
      proc.stdout.on('data', d => stdout += d);
      proc.stderr.on('data', d => stderr += d);
      proc.on('close', code => resolve({ stdout, stderr, code }));
      proc.on('error', reject);
    });
    if (stdout.trim()) {
      uncommittedWarning = `Worker had uncommitted changes:\n${stdout.trim()}`;
      console.warn(`[Dismiss] Worker ${workerId} (${worker.label}) has uncommitted changes: ${stdout.trim()}`);
    }
  } catch (e) {
    // Best effort
  }

  console.log(`[Dismiss] Dismissing worker ${workerId} (${worker.label})`);
  await killWorker(workerId, io, { reason: 'dismissed' });

  return { dismissed: true, uncommittedWarning };
}

// ============================================
// DEPENDENCY / COMPLETION
// ============================================

export async function completeWorker(workerId, io = null, options = {}) {
  const { autoCleanup = true } = options;

  const worker = workers.get(workerId);
  if (!worker) {
    throw new Error(`Worker ${workerId} not found`);
  }

  const COMPLETABLE_STATUSES = ['running', 'error', 'awaiting_review'];
  if (!COMPLETABLE_STATUSES.includes(worker.status)) {
    console.warn(`[CompleteWorker] Worker ${workerId} (${worker.label}) has status "${worker.status}" — not completable, skipping`);
    return { worker: normalizeWorker(worker), triggeredWorkers: [], onCompleteAction: null };
  }

  const { triggeredWorkers, onCompleteAction } = markWorkerCompleted(workerId);

  worker.status = 'completed';
  worker.completedAt = new Date();
  respawnAttempts.delete(workerId);

  const activity = addActivity('worker_completed', workerId, worker.label, worker.project,
    `Worker "${worker.label}" completed`);

  if (io) {
    io.emit('worker:completed', { workerId, worker: normalizeWorker(worker) });
    io.emit('activity:new', activity);
  }

  const startedWorkers = [];
  for (const triggeredId of triggeredWorkers) {
    try {
      const started = await startPendingWorker(triggeredId, io);
      if (started) {
        startedWorkers.push(started);
      }
    } catch (error) {
      console.error(`Failed to start triggered worker ${triggeredId}:`, error.message);
    }
  }

  if (onCompleteAction) {
    await handleOnCompleteAction(onCompleteAction, workerId, io);
  }

  if (triggeredWorkers.length > 0 && io) {
    io.emit('dependencies:triggered', {
      completedWorkerId: workerId,
      triggeredWorkerIds: triggeredWorkers
    });
  }

  if (autoCleanup && !isProtectedWorker(worker)) {
    const timerId = setTimeout(async () => {
      autoCleanupTimers.delete(workerId);
      try {
        const currentWorker = workers.get(workerId);
        if (currentWorker && currentWorker.status === 'completed' && !currentWorker.beingCleanedUp) {
          currentWorker.beingCleanedUp = true;
          console.log(`[AutoCleanup] Cleaning up completed worker ${workerId} (${worker.label})`);
          await killWorker(workerId, io);
        }
      } catch (error) {
        console.error(`[AutoCleanup] Failed to cleanup worker ${workerId}:`, error.message);
      }
    }, AUTO_CLEANUP_DELAY_MS);
    autoCleanupTimers.set(workerId, timerId);
  } else if (autoCleanup && isProtectedWorker(worker)) {
    console.warn(`[AutoCleanup] Skipping auto-cleanup for GENERAL worker ${workerId} (${worker.label}).`);
  }

  return {
    worker: normalizeWorker(worker),
    triggeredWorkers: startedWorkers,
    onCompleteAction
  };
}

async function handleOnCompleteAction(action, completedWorkerId, io) {
  if (!action || !action.type) return;

  switch (action.type) {
    case 'spawn':
      if (action.config && action.config.projectPath) {
        const spawnPath = path.resolve(String(action.config.projectPath));
        if (!spawnPath.startsWith(THEA_ROOT) || spawnPath.includes('\0') || spawnPath.includes('..')) {
          console.warn(`[onComplete] Blocked spawn with path outside allowed root: ${spawnPath}`);
          break;
        }
        try {
          await spawnWorker(
            spawnPath,
            action.config.label || null,
            io,
            action.config.options || {}
          );
        } catch (error) {
          console.error('onComplete spawn failed:', error.message);
        }
      }
      break;

    case 'webhook':
      if (action.config && action.config.url) {
        try {
          const webhookUrl = new URL(String(action.config.url));
          if (webhookUrl.protocol !== 'http:' && webhookUrl.protocol !== 'https:') {
            console.warn(`[onComplete] Blocked webhook with disallowed protocol: ${webhookUrl.protocol}`);
            break;
          }
          const rawHostname = webhookUrl.hostname.toLowerCase();
          const hostname = rawHostname.startsWith('[') && rawHostname.endsWith(']')
            ? rawHostname.slice(1, -1) : rawHostname;
          const BLOCKED_HOSTS = [
            'localhost', '127.0.0.1', '::1', '::', '0.0.0.0',
            '169.254.169.254', 'metadata.google.internal',
          ];
          const BLOCKED_PREFIXES = [
            '10.', '172.16.', '172.17.', '172.18.', '172.19.',
            '172.20.', '172.21.', '172.22.', '172.23.', '172.24.', '172.25.', '172.26.',
            '172.27.', '172.28.', '172.29.', '172.30.', '172.31.', '192.168.', '127.',
            'fc', 'fd', 'fe80:',
            '::ffff:10.', '::ffff:172.16.', '::ffff:172.17.', '::ffff:172.18.', '::ffff:172.19.',
            '::ffff:172.20.', '::ffff:172.21.', '::ffff:172.22.', '::ffff:172.23.',
            '::ffff:172.24.', '::ffff:172.25.', '::ffff:172.26.', '::ffff:172.27.',
            '::ffff:172.28.', '::ffff:172.29.', '::ffff:172.30.', '::ffff:172.31.',
            '::ffff:192.168.', '::ffff:127.', '::ffff:0.',
          ];
          if (BLOCKED_HOSTS.includes(hostname) || BLOCKED_PREFIXES.some(p => hostname.startsWith(p))) {
            console.warn(`[onComplete] Blocked webhook to internal/private host: ${hostname}`);
            break;
          }
          const method = (action.config.method || 'POST').toUpperCase();
          if (method !== 'POST' && method !== 'PUT') {
            console.warn(`[onComplete] Blocked webhook with disallowed method: ${method}`);
            break;
          }
          const response = await fetch(webhookUrl.toString(), {
            method,
            headers: {
              'Content-Type': 'application/json',
              ...(action.config.headers || {})
            },
            body: JSON.stringify({
              event: 'worker_completed',
              workerId: completedWorkerId,
              timestamp: new Date().toISOString(),
              ...(action.config.body || {})
            }),
            signal: AbortSignal.timeout(10000)
          });
          console.log(`Webhook ${webhookUrl.hostname} returned ${response.status}`);
        } catch (error) {
          console.error('onComplete webhook failed:', error.message);
        }
      }
      break;

    case 'emit':
      if (io && action.config && action.config.event) {
        const ALLOWED_EVENT_PREFIXES = ['worker:', 'custom:', 'app:'];
        const eventName = String(action.config.event);
        const isAllowed = ALLOWED_EVENT_PREFIXES.some(p => eventName.startsWith(p));
        if (!isAllowed) {
          console.warn(`[onComplete] Blocked emit of disallowed event: ${eventName}`);
          break;
        }
        const SENSITIVE_KEYS = ['ralphToken', 'apiKey', 'password', 'secret', 'token', 'credential'];
        function stripSensitiveKeys(obj) {
          if (!obj || typeof obj !== 'object') return obj;
          if (Array.isArray(obj)) return obj.map(stripSensitiveKeys);
          const cleaned = {};
          for (const [k, v] of Object.entries(obj)) {
            if (SENSITIVE_KEYS.includes(k)) continue;
            cleaned[k] = (v && typeof v === 'object') ? stripSensitiveKeys(v) : v;
          }
          return cleaned;
        }
        const safeData = action.config.data ? stripSensitiveKeys(action.config.data) : {};
        io.emit(eventName, {
          workerId: completedWorkerId,
          ...safeData
        });
      }
      break;

    default:
      console.warn(`Unknown onComplete action type: ${action.type}`);
  }
}

// ============================================
// UPDATE OPERATIONS
// ============================================

export function updateWorkerLabel(workerId, newLabel, io = null) {
  const worker = workers.get(workerId);

  if (!worker) {
    throw new Error(`Worker ${workerId} not found`);
  }

  worker.label = newLabel;
  worker.lastActivity = new Date();

  if (io) {
    io.emit('worker:updated', normalizeWorker(worker));
  }

  import('./persistence.js').then(({ saveWorkerState }) => {
    saveWorkerState().catch(err => console.error(`[UpdateLabel] State save failed: ${err.message}`));
  });

  return normalizeWorker(worker);
}

export async function resizeWorkerTerminal(workerId, cols, rows, io = null) {
  const worker = workers.get(workerId);
  if (!worker) {
    throw new Error(`Worker ${workerId} not found`);
  }

  cols = Math.max(20, Math.min(500, parseInt(cols, 10) || 80));
  rows = Math.max(5, Math.min(200, parseInt(rows, 10) || 24));

  const sizeKey = `${cols}x${rows}`;
  if (lastResizeSize.get(workerId) === sizeKey) {
    return { cols, rows, skipped: true };
  }
  lastResizeSize.set(workerId, sizeKey);

  try {
    validateSessionName(worker.tmuxSession);
    await spawnTmux(['resize-window', '-t', worker.tmuxSession, '-x', String(cols), '-y', String(rows)]);
    await spawnTmux(['send-keys', '-t', worker.tmuxSession, 'C-l']);
    console.log(`Resized ${worker.label} to ${cols}x${rows}`);
    return { cols, rows };
  } catch (error) {
    console.error(`Failed to resize ${worker.label}:`, error.message);
    throw error;
  }
}

export async function broadcastToProject(projectName, input) {
  const { getWorkersByProject } = await import('../workerManager.js');
  const projectWorkers = getWorkersByProject(projectName);

  const results = await Promise.allSettled(
    projectWorkers.map(w => sendInput(w.id, input))
  );

  return results;
}

// ============================================
// WORKER DISCOVERY
// ============================================

export async function discoverExistingWorkers(io = null) {
  try {
    const { stdout } = await spawnTmux(['list-sessions', '-F', '#{session_name}\t#{session_created}']).catch(() => ({ stdout: '' }));

    const sessions = stdout.trim().split('\n')
      .map(line => {
        const [name, created] = line.split('\t');
        return { name, created: created ? parseInt(created, 10) : null };
      })
      .filter(s => s.name?.startsWith(SESSION_PREFIX));

    for (const { name: sessionName, created: sessionCreated } of sessions) {
      const id = sessionName.replace(SESSION_PREFIX, '');

      if (workers.has(id)) continue;

      try {
        validateSessionName(sessionName);
      } catch {
        console.warn(`[Discover] Skipping session with invalid name: ${sessionName}`);
        continue;
      }

      const exists = await sessionExists(sessionName);
      if (!exists) continue;

      let workingDir = THEA_ROOT;
      try {
        const { stdout: cwd } = await spawnTmux([
          'display-message', '-t', sessionName, '-p', '#{pane_current_path}'
        ]);
        const resolvedDir = path.resolve(cwd.trim());
        if (resolvedDir.startsWith(THEA_ROOT)) {
          workingDir = resolvedDir;
        } else {
          console.warn(`[Discover] Session ${sessionName} has workingDir outside thea root (${resolvedDir}), using default`);
        }
      } catch {
        // Use default
      }

      const projectName = path.basename(workingDir);

      // Detect backend by checking what process is running in the tmux pane
      let detectedBackend = 'claude';
      try {
        const { stdout: paneCmd } = await spawnTmux(['list-panes', '-t', sessionName, '-F', '#{pane_current_command}']);
        if ((paneCmd || '').trim().includes('gemini')) {
          detectedBackend = 'gemini';
        }
      } catch { /* default to claude */ }

      const worker = {
        id,
        label: projectName,
        project: projectName,
        workingDir,
        tmuxSession: sessionName,
        status: 'running',
        mode: 'tmux',
        backend: detectedBackend,
        createdAt: sessionCreated ? new Date(sessionCreated * 1000) : new Date(),
        lastActivity: new Date(),
        lastOutput: new Date(),
        health: 'healthy',
        queuedCommands: 0,
        dependsOn: [],
        workflowId: null,
        taskId: null,
        parentWorkerId: null,
        parentLabel: null,
        childWorkerIds: [],
        childWorkerHistory: [],
        task: null,
        waitingAtPrompt: false,
        autoAccept: false,
        autoAcceptPaused: false,
        lastAutoAcceptHash: null,
        ralphMode: false,
        ralphToken: null,
        ralphStatus: null,
        ralphSignaledAt: null,
        ralphLearnings: null,
        ralphProgress: null,
        ralphCurrentStep: null,
        ralphOutputs: null,
        ralphArtifacts: null,
        ralphSignalCount: 0,
        firstRalphAt: null,
        lastRalphSignalAt: null,
        crashReason: null,
        crashedAt: null,
        completedAt: null,
        awaitingReviewAt: null,
      };

      workers.set(id, worker);
      outputBuffers.set(id, '');
      commandQueues.set(id, []);

      dbStartSession(worker);
      startPtyCapture(id, sessionName, io);
      startHealthMonitor(id, io);
    }

    const { getWorkers } = await import('../workerManager.js');
    return getWorkers();
  } catch (err) {
    console.warn('[DiscoverWorkers] Error discovering existing workers:', err.message);
    return [];
  }
}

// ============================================
// CLAUDE HEADLESS MODE
// ============================================

export async function runHeadless(projectPath, prompt, options = {}) {
  const {
    outputFormat = 'json',
    systemPrompt = null,
    timeout: rawTimeout = 300000
  } = options;

  const timeout = (typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) && rawTimeout > 0)
    ? Math.min(rawTimeout, MAX_TIMEOUT_MS)
    : 300000;

  const stats = await fs.stat(projectPath).catch(() => null);
  if (!stats || !stats.isDirectory()) {
    throw new Error(`Invalid project path: ${projectPath}`);
  }

  const validFormats = ['json', 'text', 'stream-json'];
  if (!validFormats.includes(outputFormat)) {
    throw new Error(`Invalid output format: ${outputFormat}`);
  }

  if (systemPrompt && systemPrompt.length > MAX_SYSTEM_PROMPT_LENGTH) {
    throw new Error(`systemPrompt exceeds maximum length (${MAX_SYSTEM_PROMPT_LENGTH} chars)`);
  }

  return new Promise((resolve, reject) => {
    const args = ['--print', '--output-format', outputFormat];
    let settled = false;

    if (systemPrompt) {
      args.push('--append-system-prompt', systemPrompt);
    }

    const proc = spawn('claude', args, {
      cwd: projectPath,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout
    });

    let stdout = '';
    let stderr = '';
    const MAX_HEADLESS_STDOUT = 5 * 1024 * 1024;
    const MAX_HEADLESS_STDERR = 1 * 1024 * 1024;
    let stdoutTruncated = false;
    let stderrTruncated = false;

    proc.stdout.on('data', chunk => {
      if (!stdoutTruncated) {
        stdout += chunk;
        if (stdout.length > MAX_HEADLESS_STDOUT) {
          stdout = stdout.slice(0, MAX_HEADLESS_STDOUT);
          stdoutTruncated = true;
        }
      }
    });
    proc.stderr.on('data', chunk => {
      if (!stderrTruncated) {
        stderr += chunk;
        if (stderr.length > MAX_HEADLESS_STDERR) {
          stderr = stderr.slice(0, MAX_HEADLESS_STDERR);
          stderrTruncated = true;
        }
      }
    });

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        proc.kill();
        const killTimer = setTimeout(() => {
          try { proc.kill('SIGKILL'); } catch (e) { /* process may already be dead */ }
        }, 5000);
        killTimer.unref();
        reject(new Error('Headless operation timed out'));
      }
    }, timeout);

    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (code !== 0) {
        const safeStderr = stderr.slice(0, 500).replace(/\/[^\s:'"]+/g, '[path]');
        reject(new Error(`Claude exited with code ${code}: ${safeStderr}`));
        return;
      }

      try {
        if (outputFormat === 'json') {
          resolve(JSON.parse(stdout));
        } else {
          resolve(stdout);
        }
      } catch (e) {
        resolve(stdout);
      }
    });

    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}

const MAX_BATCH_SIZE = 50;

export async function runBatchOperation(projectPaths, prompt, options = {}) {
  if (!Array.isArray(projectPaths) || projectPaths.length === 0) {
    throw new Error('projectPaths must be a non-empty array');
  }
  if (projectPaths.length > MAX_BATCH_SIZE) {
    throw new Error(`Batch size ${projectPaths.length} exceeds maximum of ${MAX_BATCH_SIZE}`);
  }

  const results = await Promise.allSettled(
    projectPaths.map(p => runHeadless(p, prompt, options))
  );

  return results.map((result, i) => ({
    project: path.basename(projectPaths[i]),
    success: result.status === 'fulfilled',
    result: result.status === 'fulfilled' ? result.value : null,
    error: result.status === 'rejected' ? result.reason.message : null
  }));
}
