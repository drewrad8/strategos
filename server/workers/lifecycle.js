/**
 * Worker lifecycle management: spawn, kill, complete, dismiss, discover.
 * Handles initialization, teardown, dependency triggering, and headless/batch operations.
 */

import crypto from 'crypto';
import {
  workers, outputBuffers, commandQueues, ptyInstances,
  pendingWorkers, inFlightSpawns, autoCleanupTimers, autoDismissTimers, lastResizeSize,
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
  writeAiderContext, removeAiderContext,
  generateAiderContext,
} from './templates.js';

import { checkSpawnResources } from './resources.js';

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
 * --tools is the real enforcement; --disallowedTools was removed (security theater).
 */
function getToolRestrictionArgs(label) {
  const { prefix } = detectWorkerType(label);
  if (prefix && READ_ONLY_ROLES.has(prefix)) {
    logger.info(`[SpawnWorker] Tool restriction (--tools): ${READ_ONLY_TOOLS} for ${label}`);
    return ['--tools', READ_ONLY_TOOLS];
  }
  return [];
}

// ============================================
// EFFORT LEVEL BY WORKER TYPE
// ============================================

const EFFORT_LEVELS = {
  GENERAL: 'high',     // strategic decisions need deep reasoning
  COLONEL: 'medium',   // coordination
  RESEARCH: 'medium',  // balanced exploration
  IMPL: 'medium',      // balanced
  FIX: 'medium',       // balanced debugging
  REVIEW: 'low',       // pattern-matching, not deep reasoning
  TEST: 'low',         // running tests is straightforward
};

const DEFAULT_EFFORT = 'medium';
const VALID_EFFORTS = new Set(['low', 'medium', 'high']);

/**
 * Returns the effort level for a worker based on its type.
 * An explicit override (from spawn options) takes precedence over the default mapping.
 */
function getEffortLevel(label, override = null) {
  if (override && VALID_EFFORTS.has(override)) {
    return override;
  }
  const { prefix } = detectWorkerType(label);
  return (prefix && EFFORT_LEVELS[prefix]) || DEFAULT_EFFORT;
}

/**
 * Returns CLI args for claude --effort flag and environment variable.
 */
function getEffortArgs(label, override = null) {
  const effort = getEffortLevel(label, override);
  logger.info(`[SpawnWorker] Effort level: ${effort} for ${label}${override ? ' (override)' : ''}`);
  return ['--effort', effort];
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
import { recordWorkerSpawn, recordWorkerTaskDuration, recordWorkerSuccess, recordWorkerRoleViolations, recordWorkerRalphSignals } from '../metricsService.js';
import { detectWorkerType as detectWorkerTypeForMetrics } from './templates.js';
import {
  registerWorkerDependencies,
  markWorkerStarted,
  markWorkerCompleted,
  markWorkerFailed,
  removeWorkerDependencies,
  canWorkerStart,
} from '../dependencyGraph.js';
import { MAX_SYSTEM_PROMPT_LENGTH, MAX_TIMEOUT_MS } from '../validation.js';
import { invalidateWorkersCache } from './queries.js';

const logger = getLogger();

/**
 * Record all worker intelligence metrics at lifecycle end (dismiss/complete/kill).
 */
function recordWorkerIntelligenceMetrics(worker, success) {
  try {
    const typeInfo = detectWorkerTypeForMetrics(worker.label);
    const template = typeInfo.prefix || 'unknown';

    // Task duration: time from spawn to now
    if (worker.createdAt) {
      const durationMs = Date.now() - new Date(worker.createdAt).getTime();
      if (durationMs > 0 && durationMs < 7 * 24 * 60 * 60 * 1000) { // Cap at 7 days
        recordWorkerTaskDuration(worker, durationMs, template);
      }
    }

    // Success: 1 for done/dismissed, 0 for crashed/killed
    recordWorkerSuccess(worker, success, template);

    // Role violations from delegation metrics
    const violations = worker.delegationMetrics?.roleViolations || 0;
    if (violations > 0) {
      recordWorkerRoleViolations(worker, violations, template);
    }

    // Ralph signal count
    const signalCount = worker.ralphSignalCount || 0;
    if (signalCount > 0) {
      recordWorkerRalphSignals(worker, signalCount, template);
    }
  } catch (err) {
    logger.error('[Metrics] Failed to record worker intelligence metrics:', err.message);
  }
}

// ============================================
// WORKER INITIALIZATION
// ============================================

function initializeWorker(id, config, io) {
  const {
    label, projectName, projectPath, sessionName, ralphToken,
    dependsOn, workflowId, taskId,
    parentWorkerId, parentLabel, task, initialInput,
    autoAccept, ralphMode, backend, model,
    autoDismissAfterDone,
    autoRespawn, autoRespawnConfig,
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
    model: model || null,
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
    // Intelligence improvements
    autoDismissAfterDone: autoDismissAfterDone !== false, // default true
    taskReceivedAt: task ? new Date() : null,
    // Auto-respawn support
    autoRespawn: autoRespawn === true,
    autoRespawnConfig: autoRespawnConfig || null,
  };

  workers.set(id, worker);
  invalidateWorkersCache();
  outputBuffers.set(id, '');
  commandQueues.set(id, []);

  markWorkerStarted(id);
  dbStartSession(worker);
  startPtyCapture(id, sessionName, io);
  startHealthMonitor(id, io);

  // Register for auto-respawn if requested
  if (autoRespawn === true && autoRespawnConfig) {
    import('../services/autoRespawnService.js').then(({ registerAutoRespawn }) => {
      registerAutoRespawn(id, autoRespawnConfig);
    }).catch(e => logger.error(`[InitWorker] Failed to register auto-respawn for ${id}: ${e.message}`));
  }

  // Track parent-child relationship
  if (parentWorkerId) {
    const parentWorker = workers.get(parentWorkerId);
    if (parentWorker) {
      // Reject truly dead parents — prevents children from being assigned to zombie parents
      const deadStatuses = ['error', 'stopped', 'completed'];
      if (deadStatuses.includes(parentWorker.status)) {
        logger.warn(`[InitWorker] parentWorkerId "${parentWorkerId}" has status "${parentWorker.status}" for worker ${id} (${label}). Rejecting dead parent, setting parentWorkerId to null.`);
        worker.parentWorkerId = null;
        worker.parentLabel = null;
      } else if (parentWorker.status === 'awaiting_review') {
        // Parent signaled done but is spawning a child — clearly active again. Revert to running.
        import('./ralph.js').then(({ revertFromDone }) => revertFromDone(parentWorkerId, io, `child_spawn:${id}`)).catch(() => {});
        parentWorker.childWorkerIds = parentWorker.childWorkerIds || [];
        if (!parentWorker.childWorkerIds.includes(id)) {
          parentWorker.childWorkerIds.push(id);
        }
        if (parentWorker.delegationMetrics) {
          parentWorker.delegationMetrics.spawnsIssued++;
        }
      } else {
        parentWorker.childWorkerIds = parentWorker.childWorkerIds || [];
        // Idempotent push: prevent duplicate child IDs (e.g. from retry/re-register)
        if (!parentWorker.childWorkerIds.includes(id)) {
          parentWorker.childWorkerIds.push(id);
        }
        // Track delegation: parent spawned a child
        if (parentWorker.delegationMetrics) {
          parentWorker.delegationMetrics.spawnsIssued++;
        }
      }
    } else {
      // Parent doesn't exist (already killed/dismissed) — don't silently create an orphan
      logger.warn(`[InitWorker] parentWorkerId "${parentWorkerId}" not found for worker ${id} (${label}). Setting parentWorkerId to null.`);
      worker.parentWorkerId = null;
      worker.parentLabel = null;
    }
  }

  // Send task/initial input after Claude initializes
  // 3s delay (up from 1.5s) — tmux pane needs time to be ready after session creation
  setTimeout(async () => {
    const TMUX_MAX_CHARS = 8000; // safe tmux send-keys limit; longer strings kill IMPL workers
    const buildTaskMsg = () => {
      if (initialInput) return initialInput;
      if (task) {
        if (typeof task === 'string') {
          return `Here is your task:\n\n${escapePromptXml(task)}`;
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
          return taskMsg;
        }
      }
      return null;
    };

    const tryDeliver = async (attemptsLeft) => {
      try {
        const currentWorker = workers.get(id);
        if (!currentWorker || currentWorker.status !== 'running') return;
        const workerType = detectWorkerType(label);
        let stdinMsg = buildTaskMsg();
        if (!stdinMsg && workerType.isGeneral) {
          stdinMsg = 'Awaiting orders. You have no assigned task yet — wait for the human to provide one. Do NOT begin autonomous operations or start scouting.';
        }

        if (stdinMsg) {
          // Truncate before tmux send-keys — "command too long" kills IMPL workers silently
          if (stdinMsg.length > TMUX_MAX_CHARS) {
            logger.warn(`[TaskDelivery] Task message too long (${stdinMsg.length} chars) for ${label}, truncating to ${TMUX_MAX_CHARS}`);
            stdinMsg = stdinMsg.slice(0, TMUX_MAX_CHARS) + '\n\n[...truncated, full task in context file...]';
          }
          // Aider treats each newline as a prompt submission, so collapse
          // multi-line task messages into a single line for aider workers
          if (currentWorker.backend === 'aider') {
            stdinMsg = stdinMsg.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
          }
          await sendInputDirect(id, stdinMsg, 'lifecycle:stdin');
          logger.info(`Sent initial task to ${label}`);
        }
      } catch (err) {
        // Retry on "can't find pane" — pane occasionally not ready even at 3s
        if (attemptsLeft > 0 && err.message && err.message.includes("can't find pane")) {
          logger.warn(`[TaskDelivery] Pane not ready for ${label}, retrying in 1s (${attemptsLeft} attempts left)`);
          await new Promise(resolve => setTimeout(resolve, 1000));
          return tryDeliver(attemptsLeft - 1);
        }
        logger.error(`Failed to send initial task to ${label}:`, err.message);
      }
    };

    await tryDeliver(3);
  }, 3000);

  // Ralph adoption reminder
  if (ralphMode && ralphToken) {
    setTimeout(() => {
      const w = workers.get(id);
      if (w && w.ralphMode && w.status === 'running' && (!w.ralphStatus || w.ralphStatus === 'pending')) {
        const rulesLocation = worker.backend === 'gemini' ? 'GEMINI.md' : worker.backend === 'aider' ? 'initial message' : '.claude/rules/';
        const reminderMsg = `Reminder: Signal your progress via Ralph. The curl command is in your rules file (${rulesLocation}).`;
        sendInputDirect(id, reminderMsg, 'lifecycle:ralph_reminder').catch(err => { logger.warn(`[Ralph] Failed to send reminder: ${err.message}`); });
        logger.info(`[Ralph] Sent 60s reminder to ${label}`);
      }
    }, 60000);
  }

  // Task re-delivery: if worker hasn't signaled Ralph and has minimal output at 3min,
  // re-send the task — handles the ~8% of workers that silently fail to receive their task
  if (task || initialInput) {
    setTimeout(async () => {
      try {
        const w = workers.get(id);
        if (!w || w.status !== 'running') return;
        // A Ralph signal is definitive proof the worker received its task — never re-deliver
        if (w.ralphSignalCount > 0) return;
        if (w.ralphStatus && w.ralphStatus !== 'pending') return;

        const buf = outputBuffers.get(id) || '';
        if (buf.length >= 2000) return;

        // Worker still pending with minimal output — re-send task
        logger.warn(`[TaskRedelivery] ${label} hasn't signaled after 3min, re-sending task`);

        let redeliveryMsg = null;
        if (initialInput) {
          redeliveryMsg = initialInput;
        } else if (task) {
          if (typeof task === 'string') {
            redeliveryMsg = `Here is your task:\n\n${escapePromptXml(task)}`;
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
            redeliveryMsg = taskMsg;
          }
        }

        if (redeliveryMsg) {
          if (redeliveryMsg.length > 8000) {
            logger.warn(`[TaskRedelivery] Redelivery message too long (${redeliveryMsg.length} chars) for ${label}, truncating`);
            redeliveryMsg = redeliveryMsg.slice(0, 8000) + '\n\n[...truncated, full task in context file...]';
          }
          if (w.backend === 'aider') {
            redeliveryMsg = redeliveryMsg.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
          }
          await sendInputDirect(id, redeliveryMsg, 'lifecycle:task_redelivery');
          logger.info(`[TaskRedelivery] Re-sent task to ${label}`);
        }
      } catch (err) {
        logger.error(`[TaskRedelivery] Failed to re-send task to ${label}:`, err.message);
      }
    }, 180000);
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
    model = null,
    autoDismissAfterDone = true,
    effortLevel = null,
    autoRespawn = false,
    autoRespawnConfig = null,
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

  // System resource check — prevent spawning when memory/swap is critically low
  const resourceCheck = await checkSpawnResources();
  if (!resourceCheck.allowed) {
    throw new Error(`Cannot spawn worker: ${resourceCheck.reason}`);
  }
  if (resourceCheck.warnings) {
    logger.warn(`[SpawnWorker] Resource warnings for ${workerLabel}: ${resourceCheck.warnings.join(", ")}`);
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
      model,
      effortLevel,
      createdAt: Date.now()
    });

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
    logger.info(`[SpawnWorker] Creating worker ${id} with session ${sessionName}`);

    const spawnStartTime = Date.now();

    const ralphToken = ralphMode ? (externalRalphToken || crypto.randomBytes(16).toString('hex')) : null;

    logger.info(`[SpawnWorker] Writing worker rules for ${id} (backend: ${backend})${ralphToken ? ` (Ralph token: ${ralphToken.slice(0, 8)}...)` : ''}`);
    if (backend === 'gemini') {
      await writeGeminiContext(id, workerLabel, projectPath, ralphToken, {
        parentWorkerId,
        parentLabel,
        bulldozeMode: false,
      });
    } else if (backend === 'aider') {
      await writeAiderContext(id, workerLabel, projectPath, ralphToken, {
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
    logger.info(`[SpawnWorker] Rules written, now creating tmux session ${sessionName}`);

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
    } else if (backend === 'aider') {
      // Spawn Aider with Ollama model via remote Ollama server
      const aiderModel = model || 'ollama_chat/qwen2.5-coder:32b-instruct';
      const aiderContextFile = `.aider.strategos-${id}.md`;
      await spawnTmux([
        'new-session', '-d',
        '-s', sessionName,
        '-x', String(DEFAULT_COLS),
        '-y', String(DEFAULT_ROWS),
        '-e', `OLLAMA_API_BASE=${process.env.OLLAMA_API_BASE || 'http://localhost:11434'}`,
        '-c', projectPath,
        'aider', '--model', aiderModel, '--yes', '--no-auto-commits',
        '--read', aiderContextFile
      ]);
    } else {
      const toolArgs = getToolRestrictionArgs(workerLabel);
      const effortArgs = getEffortArgs(workerLabel, effortLevel);
      const modelArgs = model ? ['--model', model] : [];
      await spawnTmux([
        'new-session', '-d',
        '-s', sessionName,
        '-x', String(DEFAULT_COLS),
        '-y', String(DEFAULT_ROWS),
        '-e', `CLAUDE_CODE_EFFORT_LEVEL=${getEffortLevel(workerLabel, effortLevel)}`,
        '-e', 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=65',
        '-c', projectPath,
        'claude', ...modelArgs, ...toolArgs, ...effortArgs
      ]);
    }
    logger.info(`[SpawnWorker] tmux session ${sessionName} created successfully`);
    resetCircuitBreakerOnSuccess();

    const spawnDuration = Date.now() - spawnStartTime;
    try {
      recordWorkerSpawn(id, spawnDuration, { project: projectName, label: workerLabel });
    } catch (metricsErr) {
      logger.error(`[SpawnWorker] Metrics recording failed (non-fatal): ${metricsErr.message}`);
    }

    const worker = initializeWorker(id, {
      label: workerLabel, projectName, projectPath, sessionName, ralphToken,
      dependsOn, workflowId, taskId,
      parentWorkerId, parentLabel, task, initialInput,
      autoAccept, ralphMode, backend, model, autoDismissAfterDone,
      autoRespawn, autoRespawnConfig,
    }, io);

    inFlightSpawns.delete(spawnKey);

    const activity = addActivity('worker_started', id, workerLabel, projectName,
      `Started worker "${workerLabel}" in ${projectPath}`);

    if (io) {
      io.emit('worker:created', normalizeWorker(worker));
      io.emit('activity:new', activity);
      // Add all connected sockets to this worker's room for worker:updated events
      io.socketsJoin(`worker:${id}`);
    }

    const { saveWorkerState } = await import('./persistence.js');
    await saveWorkerState();

    return worker;
  } catch (error) {
    inFlightSpawns.delete(spawnKey);

    if (!workers.has(id)) {
      incrementCircuitBreaker();
      logger.error(`[CircuitBreaker] Tmux spawn failure`);
    }

    markWorkerFailed(id);
    removeWorkerDependencies(id);

    if (workers.has(id)) {
      stopPtyCapture(id);
      stopHealthMonitor(id);
      workers.delete(id);
      invalidateWorkersCache();
      outputBuffers.delete(id);
      commandQueues.delete(id);
      sessionFailCounts.delete(id);
      ptyInstances.delete(id);
      lastResizeSize.delete(id);
    }
    respawnAttempts.delete(id);

    if (backend === 'gemini') {
      await removeGeminiContext(projectPath, id);
    } else if (backend === 'aider') {
      await removeAiderContext(projectPath, id);
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
    logger.info(`[StartPending] Worker ${workerId} (${pending.label}) cannot start`);
    pendingWorkers.delete(workerId);
    return null;
  }

  const runningWorkers = Array.from(workers.values()).filter(w => w.status === 'running');
  if (runningWorkers.length + inFlightSpawns.size >= MAX_CONCURRENT_WORKERS) {
    logger.warn(`[StartPending] Worker ${workerId} (${pending.label}) blocked — at limit`);
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
    } else if (pendingBackend === 'aider') {
      await writeAiderContext(workerId, pending.label, pending.projectPath, ralphToken);
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
    } else if (pendingBackend === 'aider') {
      const aiderModel = pending.model || 'ollama_chat/qwen2.5-coder:32b-instruct';
      const aiderContextFile = `.aider.strategos-${workerId}.md`;
      await spawnTmux([
        'new-session', '-d',
        '-s', sessionName,
        '-x', String(DEFAULT_COLS),
        '-y', String(DEFAULT_ROWS),
        '-e', `OLLAMA_API_BASE=${process.env.OLLAMA_API_BASE || 'http://localhost:11434'}`,
        '-c', pending.projectPath,
        'aider', '--model', aiderModel, '--yes', '--no-auto-commits',
        '--read', aiderContextFile
      ]);
    } else {
      const toolArgs = getToolRestrictionArgs(pending.label);
      const effortArgs = getEffortArgs(pending.label, pending.effortLevel || null);
      const modelArgs = pending.model ? ['--model', pending.model] : [];
      await spawnTmux([
        'new-session', '-d',
        '-s', sessionName,
        '-x', String(DEFAULT_COLS),
        '-y', String(DEFAULT_ROWS),
        '-e', `CLAUDE_CODE_EFFORT_LEVEL=${getEffortLevel(pending.label, pending.effortLevel || null)}`,
        '-e', 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=65',
        '-c', pending.projectPath,
        'claude', ...modelArgs, ...toolArgs, ...effortArgs
      ]);
    }
    resetCircuitBreakerOnSuccess();

    const worker = initializeWorker(workerId, {
      label: pending.label, projectName, projectPath: pending.projectPath, sessionName, ralphToken,
      dependsOn: pending.dependsOn, workflowId: pending.workflowId, taskId: pending.taskId,
      parentWorkerId: pending.parentWorkerId, parentLabel: pending.parentLabel,
      task: pending.task, initialInput: pending.initialInput,
      autoAccept: pending.autoAccept ?? true, ralphMode: pending.ralphMode || false,
      backend: pending.backend || 'claude', model: pending.model || null,
    }, effectiveIo);

    const activity = addActivity('worker_started', workerId, pending.label, projectName,
      `Started worker "${pending.label}" (dependencies satisfied)`);

    if (effectiveIo) {
      effectiveIo.emit('worker:created', normalizeWorker(worker));
      effectiveIo.emit('worker:dependencies_satisfied', { workerId });
      effectiveIo.emit('activity:new', activity);
      // Add all connected sockets to this worker's room for worker:updated events
      effectiveIo.socketsJoin(`worker:${workerId}`);
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
      invalidateWorkersCache();
      outputBuffers.delete(workerId);
      commandQueues.delete(workerId);
      sessionFailCounts.delete(workerId);
      lastResizeSize.delete(workerId);
    }
    respawnAttempts.delete(workerId);

    if (pendingBackend === 'gemini') {
      await removeGeminiContext(pending.projectPath, workerId);
    } else if (pendingBackend === 'aider') {
      await removeAiderContext(pending.projectPath, workerId);
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

async function teardownWorker(workerId, worker, io, { activityMessage, logPrefix = 'Teardown', skipTmuxKill = false, reason = 'killed', skipAutoRespawn = false } = {}) {
  const deathCb = getWorkerDeathCallback();
  if (deathCb && worker.ralphToken) {
    try { deathCb(worker); } catch (e) { /* ignore */ }
  }

  // Trigger auto-respawn for generals that die unexpectedly (not dismissed/completed)
  if (!skipAutoRespawn && worker.autoRespawn && reason !== 'dismissed' && reason !== 'completed') {
    const workerSnapshot = {
      ralphProgress: worker.ralphProgress,
      ralphCurrentStep: worker.ralphCurrentStep,
      ralphLearnings: worker.ralphLearnings,
    };
    import('../services/autoRespawnService.js').then(({ handleGeneralDeath }) => {
      handleGeneralDeath(workerId, reason, io, workerSnapshot).catch(e =>
        logger.error(`[AutoRespawn] handleGeneralDeath failed for ${workerId}: ${e.message}`)
      );
    }).catch(e => logger.error(`[AutoRespawn] Import failed: ${e.message}`));
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
    } else if (worker.backend === 'aider') {
      await removeAiderContext(worker.workingDir, workerId);
    } else {
      await removeStrategosContext(worker.workingDir, workerId);
    }
  }

  try {
    const failedDependents = markWorkerFailed(workerId);
    for (const depId of failedDependents) {
      if (pendingWorkers.has(depId)) {
        logger.info(`[${logPrefix}] Removing orphaned pending worker ${depId}`);
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
  invalidateWorkersCache();
  outputBuffers.delete(workerId);
  commandQueues.delete(workerId);
  sessionFailCounts.delete(workerId);
  ptyInstances.delete(workerId);
  lastResizeSize.delete(workerId);
  respawnAttempts.delete(workerId);
  const acTimer = autoCleanupTimers.get(workerId);
  if (acTimer) { clearTimeout(acTimer); autoCleanupTimers.delete(workerId); }
  const adTimer = autoDismissTimers.get(workerId);
  if (adTimer) { clearTimeout(adTimer); autoDismissTimers.delete(workerId); }
  clearWorkerContext(workerId);
  removeWorkerDependencies(workerId);
  stopHealthMonitor(workerId);

  // Clean up bulldoze state file if it exists
  if (worker.workingDir) {
    const bulldozeStatePath = path.join(worker.workingDir, 'tmp', `bulldoze-state-${workerId}.md`);
    try { await fs.unlink(bulldozeStatePath); } catch { /* ENOENT is fine */ }
  }

  logger.info(`[${logPrefix}] Worker ${workerId} cleanup complete`);

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

  // Record failure in learnings DB if worker never signaled done.
  // Skip if worker completed successfully (awaiting_review = signaled done but not yet dismissed).
  const { persistFailureLearning } = await import('./ralph.js');
  const successfulRalphStatuses = new Set(['done', 'awaiting_review']);
  if (!successfulRalphStatuses.has(worker.ralphStatus)) {
    persistFailureLearning(worker, workerId, 'cleanup');
  }

  addRespawnSuggestion(workerId, worker);

  if (isProtectedWorker(worker)) {
    logger.error(`[CleanupWorker] BLOCKED: Refusing to cleanup protected worker ${workerId} (${worker.label}).`);
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
    logger.info(`[KillWorker] Worker ${workerId} already removed — skipping (idempotent)`);
    return;
  }

  if (worker.beingCleanedUp) {
    logger.info(`[KillWorker] Worker ${workerId} already being cleaned up — skipping (idempotent)`);
    return;
  }
  worker.beingCleanedUp = true;

  // Worker-initiated kill protection
  if (options.callerWorkerId) {
    const caller = workers.get(options.callerWorkerId);

    if (options.callerWorkerId === workerId) {
      worker.beingCleanedUp = false;
      logger.error(`[KillWorker] BLOCKED: Worker ${options.callerWorkerId} attempted to kill itself.`);
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
      logger.error(`[KillWorker] BLOCKED: Worker ${options.callerWorkerId} (${callerLabel}) attempted to kill non-descendant ${workerId} (${worker.label}).`);
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

    logger.info(`[KillWorker] Hierarchy validated: ${options.callerWorkerId} is ancestor of ${workerId}`);
  }

  // GENERAL protection
  if (isProtectedWorker(worker) && !options.force) {
    worker.beingCleanedUp = false;
    logger.error(`[KillWorker] BLOCKED: Refusing to kill protected worker ${workerId} (${worker.label}).`);
    if (io) {
      io.emit('worker:kill:blocked', { workerId, label: worker.label, reason: 'protected_tier' });
    }
    throw new Error(`Cannot kill GENERAL-tier worker "${worker.label}" without force flag.`);
  }

  logger.info(`[KillWorker] Killing worker ${workerId} (${worker.label})`);
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

  // Record failure in learnings DB if worker never signaled done.
  // Skip if: worker was dismissed/killed after completing (awaiting_review = signaled done but not yet dismissed).
  const { persistFailureLearning } = await import('./ralph.js');
  const successfulRalphStatuses = new Set(['done', 'awaiting_review']);
  if (!successfulRalphStatuses.has(worker.ralphStatus)) {
    persistFailureLearning(worker, workerId, options.reason || 'killed');
  }

  try {
    validateSessionName(worker.tmuxSession);
  } catch (validationError) {
    logger.error(`[KillWorker] Invalid session name: ${validationError.message}`);
    throw new Error(`Invalid worker session name`);
  }

  try {
    const result = await spawnTmux(['kill-session', '-t', worker.tmuxSession]);
    logger.info(`[KillWorker] Tmux kill-session result:`, result);
  } catch (error) {
    logger.info(`[KillWorker] Tmux kill-session failed (may already be gone):`, error.message);
  }

  const stillExists = await sessionExists(worker.tmuxSession);
  if (stillExists) {
    logger.warn(`[KillWorker] Session still exists, force killing...`);
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
        logger.info(`[KillWorker] Re-parented orphan ${childId} (${child.label}) to grandparent ${grandparentId} (${grandparent.label})`);
      } else {
        // No grandparent — child becomes a root worker
        child.parentWorkerId = null;
        child.parentLabel = null;
        logger.warn(`[KillWorker] Orphaned child ${childId} (${child.label}) — no grandparent available, now a root worker`);
      }
    }
    // Clear the dying parent's child list (children have been re-parented)
    worker.childWorkerIds = [];
  }

  await teardownWorker(workerId, worker, io, {
    activityMessage: `Stopped worker "${worker.label}"`,
    logPrefix: 'KillWorker',
    skipTmuxKill: true,
    reason: options.reason || 'killed',
    skipAutoRespawn: options.reason === 'dismissed' || options.reason === 'completed',
  });

  return true;
}

export async function dismissWorker(workerId, io = null) {
  const worker = workers.get(workerId);
  if (!worker) {
    // Worker already dismissed, completed, or cleaned up — idempotent success.
    // Avoids 404 when the MCP layer retries a dismiss after the worker was auto-dismissed.
    return { dismissed: true, alreadyGone: true };
  }

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
      logger.warn(`[Dismiss] Worker ${workerId} (${worker.label}) has uncommitted changes: ${stdout.trim()}`);
    }
  } catch (e) {
    // Best effort
  }

  logger.info(`[Dismiss] Dismissing worker ${workerId} (${worker.label})`);
  recordWorkerIntelligenceMetrics(worker, true);
  await killWorker(workerId, io, { reason: 'dismissed', force: true });

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
    logger.warn(`[CompleteWorker] Worker ${workerId} (${worker.label}) has status "${worker.status}" — not completable, skipping`);
    return { worker: normalizeWorker(worker), triggeredWorkers: [], onCompleteAction: null };
  }

  const { triggeredWorkers, onCompleteAction } = markWorkerCompleted(workerId);

  worker.status = 'completed';
  worker.completedAt = new Date();
  respawnAttempts.delete(workerId);
  recordWorkerIntelligenceMetrics(worker, true);

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
      logger.error(`Failed to start triggered worker ${triggeredId}:`, error.message);
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
          logger.info(`[AutoCleanup] Cleaning up completed worker ${workerId} (${worker.label})`);
          await killWorker(workerId, io);
        }
      } catch (error) {
        logger.error(`[AutoCleanup] Failed to cleanup worker ${workerId}:`, error.message);
      }
    }, AUTO_CLEANUP_DELAY_MS);
    autoCleanupTimers.set(workerId, timerId);
  } else if (autoCleanup && isProtectedWorker(worker)) {
    logger.warn(`[AutoCleanup] Skipping auto-cleanup for GENERAL worker ${workerId} (${worker.label}).`);
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
          logger.warn(`[onComplete] Blocked spawn with path outside allowed root: ${spawnPath}`);
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
          logger.error('onComplete spawn failed:', error.message);
        }
      }
      break;

    case 'webhook':
      if (action.config && action.config.url) {
        try {
          const webhookUrl = new URL(String(action.config.url));
          if (webhookUrl.protocol !== 'http:' && webhookUrl.protocol !== 'https:') {
            logger.warn(`[onComplete] Blocked webhook with disallowed protocol: ${webhookUrl.protocol}`);
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
            logger.warn(`[onComplete] Blocked webhook to internal/private host: ${hostname}`);
            break;
          }
          const method = (action.config.method || 'POST').toUpperCase();
          if (method !== 'POST' && method !== 'PUT') {
            logger.warn(`[onComplete] Blocked webhook with disallowed method: ${method}`);
            break;
          }
          const response = await fetch(webhookUrl.toString(), {
            method,
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              event: 'worker_completed',
              workerId: completedWorkerId,
              timestamp: new Date().toISOString(),
              ...(action.config.body || {})
            }),
            signal: AbortSignal.timeout(10000)
          });
          logger.info(`Webhook ${webhookUrl.hostname} returned ${response.status}`);
        } catch (error) {
          logger.error('onComplete webhook failed:', error.message);
        }
      }
      break;

    case 'emit':
      if (io && action.config && action.config.event) {
        const ALLOWED_EVENT_PREFIXES = ['worker:', 'custom:', 'app:'];
        const eventName = String(action.config.event);
        const isAllowed = ALLOWED_EVENT_PREFIXES.some(p => eventName.startsWith(p));
        if (!isAllowed) {
          logger.warn(`[onComplete] Blocked emit of disallowed event: ${eventName}`);
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
      logger.warn(`Unknown onComplete action type: ${action.type}`);
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
    io.to(`worker:${workerId}`).emit('worker:updated', normalizeWorker(worker));
  }

  import('./persistence.js').then(({ saveWorkerState }) => {
    saveWorkerState().catch(err => logger.error(`[UpdateLabel] State save failed: ${err.message}`));
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
    logger.info(`Resized ${worker.label} to ${cols}x${rows}`);
    return { cols, rows };
  } catch (error) {
    logger.error(`Failed to resize ${worker.label}:`, error.message);
    throw error;
  }
}

export async function broadcastToProject(projectName, input) {
  const { getWorkersByProject } = await import('../workerManager.js');
  const projectWorkers = getWorkersByProject(projectName);

  const results = await Promise.allSettled(
    projectWorkers.map(w => sendInput(w.id, input, null, { source: 'project_broadcast' }))
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
        logger.warn(`[Discover] Skipping session with invalid name: ${sessionName}`);
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
          logger.warn(`[Discover] Session ${sessionName} has workingDir outside thea root (${resolvedDir}), using default`);
        }
      } catch {
        // Use default
      }

      const projectName = path.basename(workingDir);

      // Detect backend by checking what process is running in the tmux pane
      let detectedBackend = 'claude';
      try {
        const { stdout: paneCmd } = await spawnTmux(['list-panes', '-t', sessionName, '-F', '#{pane_current_command}']);
        const paneCmdTrimmed = (paneCmd || '').trim();
        if (paneCmdTrimmed.includes('gemini')) {
          detectedBackend = 'gemini';
        } else if (paneCmdTrimmed.includes('aider')) {
          detectedBackend = 'aider';
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
    logger.warn('[DiscoverWorkers] Error discovering existing workers:', err.message);
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
