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
  path, fs, spawn, uuidv4, existsSync, unlinkSync,
  addActivity, normalizeWorker,
  escapePromptXml, escapeJsonValue,
  spawnTmux, safeSendKeys, validateSessionName, sessionExists,
  getWorkerDeathCallback,
  isCircuitBreakerTripped, incrementCircuitBreaker, resetCircuitBreakerOnSuccess,
  withTmuxLock,
} from './state.js';

import {
  detectWorkerType,
  writeStrategosContext, removeStrategosContext,
} from './templates.js';

import { createWorktree, removeWorktree } from './worktree.js';

import { checkSpawnResources } from './resources.js';

import { shouldFallback as _shouldFallback } from '../services/modelFallbackService.js';

/**
 * Apply per-model auto-fallback at spawn time. Returns
 *   { model, effortLevel, fallback: { reason, originalModel, originalEffort } | null }
 * where `model` and `effortLevel` are the (possibly substituted) values to spawn with.
 */
function applyModelFallback(label, model, effortLevel) {
  // No model selected = inherit from claude defaults; fallback service decides only when target is explicit.
  if (!model) return { model, effortLevel, fallback: null };
  const decision = _shouldFallback(model, label);
  if (!decision.fallback) return { model, effortLevel, fallback: null };
  logger.warn(`[ModelFallback] ${label}: ${model} → ${decision.replacementModel} (${decision.reason})`);
  return {
    model: decision.replacementModel,
    effortLevel: decision.replacementEffort,
    fallback: {
      reason: decision.reason,
      originalModel: model,
      originalEffort: effortLevel ?? null,
    },
  };
}

// ============================================
// TOOL RESTRICTIONS BY ROLE
// ============================================

// Roles that are read-only / delegation-only — no Edit, Write, NotebookEdit, or Task
const READ_ONLY_ROLES = new Set(['GENERAL', 'COLONEL', 'REVIEW', 'RESEARCH']);

// --tools flag: comma-separated, restricts which built-in tools EXIST (not just permissions)
// --allowedTools only controls permission prompts — does NOT prevent usage!
//
// NOTE: Bash IS intentionally included here. Generals and colonels must be able to run
// `curl` commands against the Strategos API (localhost:38007) for spawning workers and
// Ralph signals. Removing Bash would break API coordination entirely.
//
// STRUCTURAL prevention: Edit, Write, NotebookEdit are ABSENT from this list — they
// literally do not exist for these workers and cannot be called.
// PROMPT prevention: The general template explicitly forbids all non-curl bash usage
// with a BASH BLACKLIST and CORRECT ALTERNATIVES section. Two layers of defense.
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
  GENERAL: 'max',      // strategic decisions need maximum reasoning
  COLONEL: 'high',     // coordination with full context
  RESEARCH: 'high',    // thorough exploration
  IMPL: 'high',        // full implementation quality
  FIX: 'high',         // thorough debugging
  REVIEW: 'high',      // careful review
  TEST: 'high',        // thorough test coverage
};

const DEFAULT_EFFORT = 'medium';
const VALID_EFFORTS = new Set(['low', 'medium', 'high', 'max']);

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

// ============================================
// SHARED BACKEND LAUNCH + FAILURE-CLEANUP HELPERS
// ============================================
//
// Single source of truth for the tmux spawn command per backend and for the
// failure-cleanup teardown. Previously the immediate path (spawnWorker) and the
// deferred path (startPendingWorker) each inlined this — and DIVERGED: the
// immediate path hardcoded `claude` and ignored the requested backend, so a
// dependency-free gemini/aider worker silently launched claude. Routing both
// paths through buildBackendLaunchArgs() fixes that latent bug.

/**
 * Build the tmux `new-session` argv for a worker, selecting the binary + flags
 * from the requested backend. Pure (depends only on its args + process.env).
 *
 * For backend 'claude' the caller passes the already-resolved (post-fallback)
 * model/effortLevel so each spawn path keeps its own fallback timing. For
 * 'aider' `model` is the aider model (defaulted here). For 'gemini' both are
 * ignored. `id` is used only to name the per-worker aider context file.
 *
 * @param {object} opts
 * @param {string} opts.backend - 'claude' (default), 'gemini', or 'aider'
 * @param {string} opts.id - worker id (used for the aider context filename)
 * @param {string} opts.sessionName - tmux session name
 * @param {string} opts.workingDir - tmux cwd (worktree when isolated)
 * @param {string} opts.label - worker label (drives tool/effort args for claude)
 * @param {string|null} [opts.model] - resolved model (claude) / aider model
 * @param {string|null} [opts.effortLevel] - resolved effort level (claude only)
 * @returns {string[]} argv passed to spawnTmux
 */
export function buildBackendLaunchArgs({ backend, id, sessionName, workingDir, label, model = null, effortLevel = null }) {
  if (backend === 'gemini') {
    const geminiEnvArgs = [];
    if (process.env.GEMINI_API_KEY) {
      geminiEnvArgs.push('-e', `GEMINI_API_KEY=${process.env.GEMINI_API_KEY}`);
    }
    return [
      'new-session', '-d',
      '-s', sessionName,
      '-x', String(DEFAULT_COLS),
      '-y', String(DEFAULT_ROWS),
      ...geminiEnvArgs,
      '-c', workingDir,
      'gemini', '--yolo'
    ];
  }

  if (backend === 'aider') {
    const aiderModel = model || 'ollama_chat/qwen2.5-coder:32b-instruct';
    const aiderContextFile = `.aider.strategos-${id}.md`;
    const isOpenAICompat = aiderModel.startsWith('openai/');
    const backendEnvArgs = isOpenAICompat
      ? ['-e', `OPENAI_API_BASE=${process.env.ZHIPUAI_API_BASE || process.env.OPENAI_API_BASE || 'https://open.bigmodel.cn/api/paas/v4/'}`,
         '-e', `OPENAI_API_KEY=${process.env.ZHIPUAI_API_KEY || process.env.OPENAI_API_KEY || ''}`]
      : ['-e', `OLLAMA_API_BASE=${process.env.OLLAMA_API_BASE || 'http://localhost:11434'}`];
    return [
      'new-session', '-d',
      '-s', sessionName,
      '-x', String(DEFAULT_COLS),
      '-y', String(DEFAULT_ROWS),
      ...backendEnvArgs,
      '-c', workingDir,
      'aider', '--model', aiderModel, '--yes', '--no-auto-commits',
      '--read', aiderContextFile
    ];
  }

  // Default: claude.
  const toolArgs = getToolRestrictionArgs(label);
  const effortArgs = getEffortArgs(label, effortLevel);
  const modelArgs = model ? ['--model', model] : [];
  return [
    'new-session', '-d',
    '-s', sessionName,
    '-x', String(DEFAULT_COLS),
    '-y', String(DEFAULT_ROWS),
    '-e', `CLAUDE_CODE_EFFORT_LEVEL=${getEffortLevel(label, effortLevel)}`,
    '-e', 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=65',
    '-c', workingDir,
    'claude', '--dangerously-skip-permissions', ...modelArgs, ...toolArgs, ...effortArgs
  ];
}

/**
 * Launch a worker's tmux session for the given backend. Thin wrapper over
 * buildBackendLaunchArgs() + spawnTmux() so both spawn paths share one code path.
 */
async function _launchWorker(opts) {
  await spawnTmux(buildBackendLaunchArgs(opts));
}

/**
 * Shared failure-cleanup for a spawn that threw. Tears down the half-created
 * worker: marks it failed, drops dependency edges, purges per-worker state maps,
 * removes the rules file + worktree, and emits an error activity.
 *
 * Caller-specific concerns stay in the caller: circuit-breaker accounting,
 * inFlightSpawns/pendingWorkers bookkeeping, and the duplicate-error rethrow.
 *
 * @param {string} id - worker id
 * @param {object} ctx
 * @param {string} ctx.workingDir - tmux cwd / worktree dir (rules-file location)
 * @param {boolean} ctx.isolated - whether a worktree was created (needs removal)
 * @param {string} ctx.projectPath - canonical repo path (worktree parent)
 * @param {string} ctx.projectName - project name (for the activity record)
 * @param {string} ctx.label - worker label (for the activity record)
 * @param {object|null} ctx.io - socket.io instance (may be null)
 * @param {Error} ctx.error - the thrown error (message used in the activity)
 * @param {string} ctx.activityVerb - leading text of the error activity message
 */
async function _cleanupFailedSpawn(id, { workingDir, isolated, projectPath, projectName, label, io, error, activityVerb }) {
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

  await removeStrategosContext(workingDir, id);
  clearWorkerContext(id);

  // Early-spawn-failure (§3.4): if a worktree was created before the throw, remove it.
  if (isolated) {
    await removeWorktree(projectPath, id);
  }

  const activity = addActivity('error', id, label, projectName,
    `${activityVerb}: ${error.message}`);

  if (io) {
    io.emit('activity:new', activity);
  }
}

import {
  startPtyCapture, stopPtyCapture, sendInputDirect, sendInput, flushCurrentOutputToDb,
} from './output.js';

import {
  startHealthMonitor, stopHealthMonitor,
  addRespawnSuggestion, isProtectedOrColonel,
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
    injectProjectContext = false,
    forcedAutonomy = false,
    bulldozeMode: configBulldozeMode = false,
    fallbackInfo = null,
    // Worktree isolation: workingDir is the tmux cwd (the worktree when isolated);
    // repoPath is the canonical repo. Default to projectPath = today's shared-cwd behavior.
    workingDir = projectPath,
    repoPath = projectPath,
    isolated = false,
  } = config;

  const worker = {
    id,
    label,
    project: projectName,
    workingDir,
    repoPath,
    isolated,
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
    bulldozeMode: configBulldozeMode || false,
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
    forcedAutonomy: forcedAutonomy || false,
    // ForcedAutonomy nudge tracking — initialize explicitly to prevent NaN in backoff math
    _forcedAutonomyNudgeCount: 0,
    _forcedAutonomyIdleCount: 0,
    _forcedAutonomyLastNudge: null,
    _missionComplete: false,
    _missionCompleteNotified: false,
    _pendingMissionCompleteReminder: false,
    // Auto-respawn support
    autoRespawn: autoRespawn === true,
    autoRespawnConfig: autoRespawnConfig || null,
    _handoffRotating: false,
    _successorId: null,
    contextInjected: injectProjectContext,
    // Auto-fallback observability — set when modelFallbackService substituted model+effort.
    originalModel: fallbackInfo?.originalModel ?? null,
    originalEffort: fallbackInfo?.originalEffort ?? null,
    fallbackReason: fallbackInfo?.reason ?? null,
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
        const reminderMsg = `Reminder: Signal your progress via Ralph. The curl command is in your rules file (.claude/rules/).`;
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

/**
 * @param {string} projectPath - Absolute path to the project directory
 * @param {string|null} label - Worker label (e.g. "IMPL: fix auth bug")
 * @param {object|null} io - Socket.io instance for live updates
 * @param {object} [options={}]
 * @param {boolean|string} [options.injectProjectContext='auto'] - Whether to inject program.md into worker rules.
 *   true = always inject; false = never; 'auto' = inject for RESEARCH/COLONEL/GENERAL, skip for specialists.
 */
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
    injectProjectContext = 'auto',
    forcedAutonomy = false,
    bulldozeMode = false,
  } = options;

  const _ctxPrefix = detectWorkerType(workerLabel).prefix;
  const _HIGH_CTX = new Set(['RESEARCH', 'COLONEL', 'GENERAL']);
  const effectiveInjectCtx = injectProjectContext === true ? true
    : injectProjectContext === false ? false
    : _HIGH_CTX.has(_ctxPrefix) ? true : false;

  let effectiveModel = model;
  let effectiveEffort = effortLevel;
  let fallbackInfo = null;
  if (backend === 'claude') {
    const fb = applyModelFallback(workerLabel, model, effortLevel);
    effectiveModel = fb.model;
    effectiveEffort = fb.effortLevel;
    fallbackInfo = fb.fallback;
  }

  const id = uuidv4().slice(0, 8);
  const sessionName = `${SESSION_PREFIX}${id}`;

  const stats = await fs.stat(projectPath).catch(() => null);
  if (!stats || !stats.isDirectory()) {
    throw new Error(`Invalid project path: ${projectPath}`);
  }

  const activeWorkersList = Array.from(workers.values()).filter(
    w => (w.status === 'running' || w.status === 'pending') && !w.awaitingReviewAt
  );
  const activeCount = activeWorkersList.length + inFlightSpawns.size;
  if (activeCount >= MAX_CONCURRENT_WORKERS) {
    const capErr = new Error(
      `Max concurrent workers (${MAX_CONCURRENT_WORKERS}) reached — refusing to spawn. ` +
      `Active: ${activeCount} (${activeWorkersList.length} workers + ${inFlightSpawns.size} in-flight). ` +
      `Set STRATEGOS_MAX_WORKERS env var to raise the cap.`
    );
    capErr.code = 'MAX_WORKERS_EXCEEDED';
    capErr.limit = MAX_CONCURRENT_WORKERS;
    capErr.active = activeCount;
    throw capErr;
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
    const existingDuplicate = activeWorkersList.find(
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
      autoDismissAfterDone,
      autoRespawn,
      autoRespawnConfig,
      forcedAutonomy,
      bulldozeMode,
      injectProjectContext: effectiveInjectCtx,
      createdAt: Date.now()
    });

    if (io) { io.emit('worker:created', normalizeWorker(pendingWorker)); }

    const activity = addActivity('worker_pending', id, workerLabel, projectName,
      `Worker "${workerLabel}" waiting on ${dependsOn.length} dependencies`);

    if (io) {
      io.emit('activity:new', activity);
    }

    inFlightSpawns.delete(spawnKey);

    return pendingWorker;
  }

  let tmuxCreated = false;
  // Worktree isolation state — declared here so the catch block can clean up a worktree
  // that was created before tmux threw. Defaults = today's shared-cwd behavior.
  let workingDir = projectPath;
  let isolated = false;
  // Dependencies are satisfied, spawn immediately
  try {
    if (isCircuitBreakerTripped()) {
      throw new Error('Tmux circuit breaker tripped: too many consecutive spawn failures. Check tmux health.');
    }

    validateSessionName(sessionName);
    logger.info(`[SpawnWorker] Creating worker ${id} with session ${sessionName}`);

    const spawnStartTime = Date.now();

    const ralphToken = ralphMode ? (externalRalphToken || crypto.randomBytes(16).toString('hex')) : null;

    // NEW (§3.2) — establish per-worker working dir (worktree) before init/rules/tmux.
    // No-op (workingDir = projectPath, isolated = false) when isolation is disabled.
    ({ workingDir, isolated } = await createWorktree(projectPath, id));

    const worker = initializeWorker(id, {
      label: workerLabel, projectName, projectPath, sessionName, ralphToken,
      dependsOn, workflowId, taskId,
      parentWorkerId, parentLabel, task, initialInput,
      autoAccept, ralphMode, backend, model: effectiveModel, autoDismissAfterDone,
      autoRespawn, autoRespawnConfig, injectProjectContext: effectiveInjectCtx,
      fallbackInfo,
      workingDir, repoPath: projectPath, isolated,
    }, io);

    logger.info(`[SpawnWorker] Writing worker rules for ${id}${ralphToken ? ` (Ralph token: ${ralphToken.slice(0, 8)}...)` : ''}`);
    await writeStrategosContext(id, workerLabel, workingDir, ralphToken, {
      parentWorkerId,
      parentLabel,
      bulldozeMode: false,
      injectProjectContext: effectiveInjectCtx,
      contextSourcePath: projectPath,
    });
    logger.info(`[SpawnWorker] Rules written, now creating tmux session ${sessionName}`);

    // Honor the requested backend (claude/gemini/aider) via the shared launcher.
    // For claude, pass the post-fallback model/effort resolved above; for
    // aider, effectiveModel === model (fallback only runs for claude). This
    // fixes the latent bug where the immediate path hardcoded claude.
    await _launchWorker({
      backend,
      id,
      sessionName,
      workingDir,
      label: workerLabel,
      model: effectiveModel,
      effortLevel: effectiveEffort,
    });
    logger.info(`[SpawnWorker] tmux session ${sessionName} created successfully`);
    resetCircuitBreakerOnSuccess();
    tmuxCreated = true;

    const spawnDuration = Date.now() - spawnStartTime;
    try {
      recordWorkerSpawn(id, spawnDuration, { project: projectName, label: workerLabel });
    } catch (metricsErr) {
      logger.error(`[SpawnWorker] Metrics recording failed (non-fatal): ${metricsErr.message}`);
    }

    // Consume handoff doc after successor has had time to read it
    const handoffPath = path.join(workingDir, `tmp/handoff-${id}.md`);
    setTimeout(() => {
      try {
        if (existsSync(handoffPath)) {
          unlinkSync(handoffPath);
          logger.info(`[Handoff] Consumed handoff doc for ${id}`);
        }
      } catch (e) { /* ignore */ }
    }, 60000);

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

    if (!tmuxCreated) {
      // Duplicate-spawn races (label/in-flight collisions) are not tmux failures — skip breaker increment.
      if (error.message && error.message.includes('Duplicate worker')) {
        throw error;
      }
      incrementCircuitBreaker();
      logger.error(`[CircuitBreaker] Tmux spawn failure`);
    }

    await _cleanupFailedSpawn(id, {
      workingDir, isolated, projectPath, projectName,
      label: workerLabel, io, error,
      activityVerb: 'Failed to start worker',
    });

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

  const activeForPending = Array.from(workers.values()).filter(
    w => (w.status === 'running' || w.status === 'pending') && !w.awaitingReviewAt
  );
  if (activeForPending.length + inFlightSpawns.size >= MAX_CONCURRENT_WORKERS) {
    logger.warn(`[StartPending] Worker ${workerId} (${pending.label}) blocked — at limit`);
    pendingWorkers.set(workerId, pending);
    return null;
  }

  pendingWorkers.delete(workerId);

  const sessionName = `${SESSION_PREFIX}${workerId}`;
  const projectName = path.basename(pending.projectPath);
  const effectiveIo = io || pending.io;
  const pendingBackend = pending.backend || 'claude';

  // Worktree isolation state — declared here so the catch block can clean up. (§3.3)
  let workingDir = pending.projectPath;
  let isolated = false;

  try {
    if (isCircuitBreakerTripped()) {
      throw new Error('Tmux circuit breaker tripped: too many consecutive spawn failures. Check tmux health.');
    }

    validateSessionName(sessionName);

    const ralphToken = pending.ralphMode ? (pending.externalRalphToken || crypto.randomBytes(16).toString('hex')) : null;

    // NEW (§3.3) — per-worker worktree before rules/tmux. No-op when isolation disabled.
    ({ workingDir, isolated } = await createWorktree(pending.projectPath, workerId));

    await writeStrategosContext(workerId, pending.label, workingDir, ralphToken, {
      parentWorkerId: pending.parentWorkerId,
      parentLabel: pending.parentLabel,
      bulldozeMode: pending.bulldozeMode || false,
      forcedAutonomy: pending.forcedAutonomy || false,
      injectProjectContext: pending.injectProjectContext || false,
      contextSourcePath: pending.projectPath,
    });

    // claude: re-apply fallback at resume time using freshest cached usage. The
    // worker may have been pending for hours and the bucket state may have
    // shifted. gemini/aider have no fallback — model/effort flow through as-is.
    let launchModel = pending.model || null;
    let launchEffort = pending.effortLevel || null;
    if (pendingBackend === 'claude') {
      const fb = applyModelFallback(pending.label, pending.model || null, pending.effortLevel || null);
      pending._effectiveModel = fb.model;
      pending._effectiveEffort = fb.effortLevel;
      pending._fallbackInfo = fb.fallback;
      launchModel = fb.model;
      launchEffort = fb.effortLevel;
    }
    await _launchWorker({
      backend: pendingBackend,
      id: workerId,
      sessionName,
      workingDir,
      label: pending.label,
      model: launchModel,
      effortLevel: launchEffort,
    });
    resetCircuitBreakerOnSuccess();

    const worker = initializeWorker(workerId, {
      label: pending.label, projectName, projectPath: pending.projectPath, sessionName, ralphToken,
      dependsOn: pending.dependsOn, workflowId: pending.workflowId, taskId: pending.taskId,
      parentWorkerId: pending.parentWorkerId, parentLabel: pending.parentLabel,
      task: pending.task, initialInput: pending.initialInput,
      autoAccept: pending.autoAccept ?? true, ralphMode: pending.ralphMode || false,
      backend: pending.backend || 'claude',
      model: pending._effectiveModel ?? (pending.model || null),
      fallbackInfo: pending._fallbackInfo || null,
      autoDismissAfterDone: pending.autoDismissAfterDone !== false,
      autoRespawn: pending.autoRespawn || false,
      autoRespawnConfig: pending.autoRespawnConfig || null,
      injectProjectContext: pending.injectProjectContext || false,
      forcedAutonomy: pending.forcedAutonomy || false,
      bulldozeMode: pending.bulldozeMode || false,
      workingDir, repoPath: pending.projectPath, isolated,
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
    pendingWorkers.delete(workerId);

    await _cleanupFailedSpawn(workerId, {
      workingDir, isolated, projectPath: pending.projectPath, projectName,
      label: pending.label, io: effectiveIo, error,
      activityVerb: 'Failed to start pending worker',
    });

    throw error;
  }
}

// ============================================
// WORKER TEARDOWN / CLEANUP / KILL
// ============================================

async function teardownWorker(workerId, worker, io, { activityMessage, logPrefix = 'Teardown', skipTmuxKill = false, reason = 'killed', skipAutoRespawn = false } = {}) {
  const deathCb = getWorkerDeathCallback();
  if (deathCb && worker.ralphToken) {
    try { deathCb(worker); } catch (e) { getLogger().error('[lifecycle.worker] deathCb failed', e?.message); }
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
  } else if (skipAutoRespawn && worker.autoRespawn) {
    // Intentional kill of a respawn-registered worker — deregister to cancel any
    // pending cooldown-retry timeouts in the service that could still fire after teardown.
    import('../services/autoRespawnService.js').then(({ deregisterAutoRespawn }) => {
      deregisterAutoRespawn(workerId);
    }).catch(() => {});
  }

  stopPtyCapture(workerId);

  if (!skipTmuxKill && worker.tmuxSession) {
    try {
      validateSessionName(worker.tmuxSession);
      await spawnTmux(['kill-session', '-t', worker.tmuxSession]);
    } catch (err) { getLogger().debug('[lifecycle.worker] tmux kill-session failed in teardown (session may already be dead)', err?.message); }
  }

  dbEndSession(workerId, 'stopped');

  if (worker.workingDir) {
    await removeStrategosContext(worker.workingDir, workerId);
  }

  // NEW (§3.4) — best-effort worktree teardown. Single chokepoint: dismiss, kill, crash,
  // timeout, and cleanup all funnel through teardownWorker. No-op when not isolated.
  if (worker.isolated && worker.repoPath) {
    await removeWorktree(worker.repoPath, workerId);
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
    getLogger().error('[lifecycle.worker] markWorkerFailed failed in teardown (worker may not be in dependency graph)', e?.message);
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
    try { await fs.unlink(bulldozeStatePath); } catch (err) { getLogger().debug('[lifecycle.worker] bulldoze state cleanup failed (ENOENT is fine)', err?.message); }
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
  worker.beingCleanedUp = true;

  try {
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

    if (isProtectedOrColonel(worker)) {
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
  } finally {
    worker.beingCleanedUp = false;
  }
}

export async function killWorker(workerId, io = null, options = {}) {
  if (process.env.STRATEGOS_PAUSE_AUTO_KILL === "1" && options.reason !== "dismissed") {
    getLogger().warn(`[lifecycle.worker] STRATEGOS_PAUSE_AUTO_KILL=1 — refusing auto-kill of ${workerId} (reason=${options.reason || "unspecified"})`);
    return;
  }

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
      const callerLabel = caller?.label || 'unknown';
      const callerIsOrchestrator = isProtectedOrColonel(caller);

      // Exception 1: E2E_FIXTURE workers are test artifacts — any general/colonel can clean them up
      const targetIsFixture = worker.label?.toUpperCase().includes('E2E_FIXTURE');
      if (targetIsFixture && callerIsOrchestrator) {
        logger.info(`[KillWorker] Hierarchy exception: orchestrator "${callerLabel}" killing E2E_FIXTURE worker "${worker.label}" (allowed)`);
      }
      // Exception 2: Orphan workers (no parent chain) can be killed by any general/colonel
      else if (!worker.parentWorkerId && callerIsOrchestrator) {
        logger.info(`[KillWorker] Hierarchy exception: orchestrator "${callerLabel}" killing orphan worker "${worker.label}" (allowed)`);
      }
      else {
        worker.beingCleanedUp = false;
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
    }

    logger.info(`[KillWorker] Hierarchy validated: ${options.callerWorkerId} is ancestor of ${workerId}`);
  }

  // GENERAL/COLONEL protection
  if (isProtectedOrColonel(worker) && !options.force) {
    worker.beingCleanedUp = false;
    logger.error(`[KillWorker] BLOCKED: Refusing to kill protected worker ${workerId} (${worker.label}).`);
    if (io) {
      io.emit('worker:kill:blocked', { workerId, label: worker.label, reason: 'protected_tier' });
    }
    throw new Error(`Cannot kill GENERAL/COLONEL-tier worker "${worker.label}" without force flag.`);
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

  // Flush current terminal snapshot to DB before failure-learning collection runs.
  // Ensures persistFailureLearning sees the last-known state even if the 1-in-10
  // DB throttle left the DB stale (RC-4 silent-death breadcrumb gap, plan 5dc5550).
  try { flushCurrentOutputToDb(workerId); } catch { /* best effort — don't block kill */ }

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
    } catch (err) {
      getLogger().debug('[lifecycle.worker] force tmux kill-session failed (session may already be gone)', err?.message);
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
    skipAutoRespawn: !!options.suppressRespawn || options.reason === 'dismissed' || options.reason === 'completed' || options.reason === 'killed_by_human',
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
    getLogger().error('[lifecycle.worker] git status check failed in dismiss (non-fatal)', e?.message);
  }

  logger.info(`[Dismiss] Dismissing worker ${workerId} (${worker.label})`);
  recordWorkerIntelligenceMetrics(worker, true);
  worker.status = 'dismissed';
  if (io) {
    io.emit('worker:dismissed', { workerId, label: worker.label });
  }
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

  if (autoCleanup && !isProtectedOrColonel(worker)) {
    const timerId = setTimeout(async () => {
      autoCleanupTimers.delete(workerId);
      try {
        const currentWorker = workers.get(workerId);
        if (currentWorker && currentWorker.status === 'completed' && !currentWorker.beingCleanedUp) {
          logger.info(`[AutoCleanup] Cleaning up completed worker ${workerId} (${worker.label})`);
          await killWorker(workerId, io);
        }
      } catch (error) {
        logger.error(`[AutoCleanup] Failed to cleanup worker ${workerId}:`, error.message);
      }
    }, AUTO_CLEANUP_DELAY_MS);
    autoCleanupTimers.set(workerId, timerId);
  } else if (autoCleanup && isProtectedOrColonel(worker)) {
    logger.warn(`[AutoCleanup] Skipping auto-cleanup for GENERAL/COLONEL worker ${workerId} (${worker.label}).`);
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
    await withTmuxLock(workerId, async () => {
      await spawnTmux(['resize-window', '-t', worker.tmuxSession, '-x', String(cols), '-y', String(rows)]);
      await spawnTmux(['send-keys', '-t', worker.tmuxSession, 'C-l']);
    });
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
      } catch (err) {
        getLogger().debug('[lifecycle.worker] could not determine pane working dir, using default', err?.message);
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
      } catch (err) { getLogger().debug('[lifecycle.worker] could not detect backend for session, defaulting to claude', err?.message); }

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
          try { proc.kill('SIGKILL'); } catch (e) { getLogger().debug('[lifecycle.worker] SIGKILL failed (process may already be dead)', e?.message); }
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
