/**
 * Shared mutable state, constants, and utility functions for the worker system.
 * All modules import from here to access the central Maps, Sets, and helpers.
 */

import { spawn, exec } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs/promises';
import { writeFileSync, renameSync, mkdirSync, existsSync, readdirSync, readFileSync, statSync, unlinkSync } from 'fs';

export { spawn, exec, uuidv4, path, fs, writeFileSync, renameSync, mkdirSync, existsSync, readdirSync, readFileSync, statSync, unlinkSync };

export const execAsync = promisify(exec);

// ============================================
// IN-MEMORY STATE
// ============================================

// Core worker state
export const workers = new Map();
export const activityLog = [];
export const MAX_ACTIVITY_LOG = 100;

// Output buffers for each worker (for API access)
export const outputBuffers = new Map();

// Command queues for each worker
export const commandQueues = new Map();

// PTY capture state per worker
export const ptyInstances = new Map();

// Workers registered for health monitoring
export const healthChecks = new Set();

// PTY session check consecutive failure counts
export const sessionFailCounts = new Map();
export const SESSION_FAIL_THRESHOLD = 3;

// Pending workers waiting for dependencies
export const pendingWorkers = new Map();

// In-flight spawn tracking
export const inFlightSpawns = new Set();

// Per-project context write lock
export const _contextWriteLocks = new Map();

// Auto-cleanup timers
export const autoCleanupTimers = new Map();

// Track last resize dimensions per worker
export const lastResizeSize = new Map();

// Track respawn attempts to prevent infinite loops
export const respawnAttempts = new Map();

// Respawn suggestions
export const respawnSuggestions = [];
export const MAX_RESPAWN_SUGGESTIONS = 20;

// Per-worker send lock
export const _sendingInput = new Set();

// Re-entrance guard for processQueue
export const _processingQueues = new Set();

// ============================================
// CONSTANTS
// ============================================

export const SESSION_PREFIX = 'thea-worker-';
// Auto-derive THEA_ROOT from file location: state.js is at THEA_ROOT/<project>/server/workers/state.js
const _stateFileDir = path.dirname(new URL(import.meta.url).pathname);
export const THEA_ROOT = process.env.THEA_ROOT || path.resolve(_stateFileDir, '..', '..', '..');
export const MAX_CONCURRENT_WORKERS = 100;
export const AUTO_CLEANUP_DELAY_MS = 30000;
export const STALE_WORKER_THRESHOLD_MS = 30 * 60 * 1000;

// Default terminal size
export const DEFAULT_COLS = 120;
export const DEFAULT_ROWS = 40;

// Strategos API configuration
export const STRATEGOS_API = 'http://localhost:38007';

// Persistence file paths
export const PERSISTENCE_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '.tmp');
export const PERSISTENCE_FILE = path.join(PERSISTENCE_DIR, 'workers.json');
export const CHECKPOINT_DIR = path.join(PERSISTENCE_DIR, 'checkpoints');

// Ensure directories exist
fs.mkdir(CHECKPOINT_DIR, { recursive: true }).catch(err => {
  console.error(`[Init] Failed to create checkpoint directory ${CHECKPOINT_DIR}: ${err.message}`);
});
fs.mkdir(PERSISTENCE_DIR, { recursive: true }).catch(err => {
  console.error(`[Init] Failed to create persistence directory ${PERSISTENCE_DIR}: ${err.message}`);
});

// Queue processing constants
export const PROCESS_QUEUE_MAX_DRAIN = 20;
export const PROCESS_QUEUE_DELAY_MS = 200;
export const MAX_QUEUE_SIZE = 1000;

// Crash recovery constants
export const MAX_RESPAWN_ATTEMPTS = 2;
export const RESPAWN_COOLDOWN_MS = 60000;

// ============================================
// WORKER DEATH CALLBACK
// ============================================

let _onWorkerDeath = null;
export function setWorkerDeathCallback(fn) { _onWorkerDeath = fn; }
export function getWorkerDeathCallback() { return _onWorkerDeath; }

// ============================================
// CIRCUIT BREAKER
// ============================================

let _tmuxFailCount = 0;
let _tmuxFirstFailAt = 0;
export const TMUX_CB_THRESHOLD = 3;
export const TMUX_CB_WINDOW_MS = 60000;

export function getCircuitBreakerStatus() {
  const tripped = _tmuxFailCount >= TMUX_CB_THRESHOLD && (Date.now() - _tmuxFirstFailAt) < TMUX_CB_WINDOW_MS;
  return {
    tripped,
    failCount: _tmuxFailCount,
    firstFailAt: _tmuxFirstFailAt || null,
    threshold: TMUX_CB_THRESHOLD,
    windowMs: TMUX_CB_WINDOW_MS
  };
}

export function resetCircuitBreaker() {
  _tmuxFailCount = 0;
  _tmuxFirstFailAt = 0;
}

export function incrementCircuitBreaker() {
  if (_tmuxFailCount === 0) _tmuxFirstFailAt = Date.now();
  _tmuxFailCount++;
  return _tmuxFailCount;
}

export function resetCircuitBreakerOnSuccess() {
  _tmuxFailCount = 0;
}

export function isCircuitBreakerTripped() {
  return _tmuxFailCount >= TMUX_CB_THRESHOLD && (Date.now() - _tmuxFirstFailAt) < TMUX_CB_WINDOW_MS;
}

// ============================================
// SECURITY: Prompt template escaping
// ============================================

export function escapePromptXml(str) {
  if (typeof str !== 'string') return String(str ?? '');
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function escapeJsonValue(str) {
  if (typeof str !== 'string') return String(str ?? '');
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
}

// ============================================
// UTILITY FUNCTIONS
// ============================================

export function simpleHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h) + str.charCodeAt(i);
    h = h & h;
  }
  return h;
}

export function stripAnsiCodes(str) {
  return str.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
            .replace(/\x1b\([AB]/g, '')
            .replace(/\x1b\][^\x07]*\x07/g, '');
}

// ============================================
// TMUX UTILITIES
// ============================================

export function validateSessionName(name) {
  if (!name || typeof name !== 'string') {
    throw new Error('Invalid session name');
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error('Session name contains invalid characters');
  }
  return name;
}

const QUIET_TMUX_COMMANDS = new Set(['capture-pane', 'has-session']);
export const TMUX_SOCKET = 'strategos';

const TMUX_TIMEOUT_MS = 30_000; // 30s timeout for tmux commands

export function spawnTmux(args) {
  return new Promise((resolve, reject) => {
    const fullArgs = ['-L', TMUX_SOCKET, ...args];

    if (args[0] === 'new-session') {
      const insertIdx = fullArgs.indexOf('new-session') + 1;
      fullArgs.splice(insertIdx, 0, '-e', 'CLAUDECODE=');
    }

    const isQuiet = QUIET_TMUX_COMMANDS.has(args[0]);
    if (!isQuiet) {
      console.log(`[spawnTmux] Running: tmux ${fullArgs.join(' ')}`);
    }
    const proc = spawn('tmux', fullArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { proc.kill('SIGKILL'); } catch { /* already dead */ }
      reject(new Error(`tmux command timed out after ${TMUX_TIMEOUT_MS / 1000}s: tmux ${args.join(' ')}`));
    }, TMUX_TIMEOUT_MS);

    proc.stdout.on('data', data => stdout += data.toString());
    proc.stderr.on('data', data => stderr += data.toString());

    proc.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (!isQuiet || code !== 0) {
        console.log(`[spawnTmux] Exited with code ${code}${stderr ? `, stderr: ${stderr}` : ''}`);
      }
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(stderr || `tmux exited with code ${code}`));
      }
    });

    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      console.error(`[spawnTmux] Error:`, err);
      reject(err);
    });
  });
}

export async function safeSendKeys(sessionName, keys) {
  validateSessionName(sessionName);
  const args = ['send-keys', '-t', sessionName, ...keys];
  return spawnTmux(args);
}

export async function checkTmux() {
  try {
    await execAsync('which tmux');
    return true;
  } catch {
    return false;
  }
}

export async function sessionExists(sessionName) {
  try {
    validateSessionName(sessionName);
    await spawnTmux(['has-session', '-t', sessionName]);
    return true;
  } catch {
    return false;
  }
}

// ============================================
// ACTIVITY LOGGING
// ============================================

export function addActivity(type, workerId, workerLabel, project, message) {
  const entry = {
    id: uuidv4(),
    timestamp: new Date(),
    type,
    workerId,
    workerLabel,
    project,
    message
  };

  activityLog.unshift(entry);

  if (activityLog.length > MAX_ACTIVITY_LOG) {
    activityLog.pop();
  }

  return entry;
}

export function getActivityLog() {
  return [...activityLog];
}

// ============================================
// NORMALIZER
// ============================================

/**
 * Normalizes a worker object for client consumption using an EXPLICIT ALLOWLIST.
 * SECURITY: Only listed fields are sent to clients. This prevents leaking internal
 * state (ralphToken, _dbWriteCount, _staleWarned, beingCleanedUp, etc.).
 */
export function normalizeWorker(worker) {
  if (!worker) return null;
  return {
    id: worker.id,
    label: worker.label,
    project: worker.project,
    workingDir: worker.workingDir ? path.basename(worker.workingDir) : null,
    tmuxSession: worker.tmuxSession,
    status: worker.status,
    mode: worker.mode,
    backend: worker.backend || 'claude',
    health: worker.health,
    queuedCommands: worker.queuedCommands ?? 0,
    waitingAtPrompt: worker.waitingAtPrompt ?? false,
    createdAt: worker.createdAt,
    lastActivity: worker.lastActivity,
    lastOutput: worker.lastOutput,
    crashedAt: worker.crashedAt ?? null,
    completedAt: worker.completedAt ?? null,
    awaitingReviewAt: worker.awaitingReviewAt ?? null,
    dependsOn: Array.isArray(worker.dependsOn) ? worker.dependsOn : [],
    workflowId: worker.workflowId ?? null,
    taskId: worker.taskId ?? null,
    parentWorkerId: worker.parentWorkerId ?? null,
    parentLabel: worker.parentLabel ?? null,
    task: worker.task ?? null,
    childWorkerIds: Array.isArray(worker.childWorkerIds) ? worker.childWorkerIds : [],
    childWorkerHistory: Array.isArray(worker.childWorkerHistory) ? worker.childWorkerHistory : [],
    autoAccept: worker.autoAccept ?? true,
    autoAcceptPaused: worker.autoAcceptPaused ?? false,
    ralphMode: worker.ralphMode ?? false,
    ralphStatus: worker.ralphStatus ?? null,
    ralphSignaledAt: worker.ralphSignaledAt ?? null,
    ralphLearnings: worker.ralphLearnings ?? null,
    ralphProgress: worker.ralphProgress ?? null,
    ralphCurrentStep: worker.ralphCurrentStep ?? null,
    ralphOutputs: worker.ralphOutputs ?? null,
    ralphArtifacts: worker.ralphArtifacts ?? null,
    ralphBlockedReason: worker.ralphBlockedReason ?? null,
    ralphSignalCount: worker.ralphSignalCount ?? 0,
    firstRalphAt: worker.firstRalphAt ?? null,
    lastRalphSignalAt: worker.lastRalphSignalAt ?? null,
    crashReason: worker.crashReason ?? null,
    bulldozeMode: worker.bulldozeMode ?? false,
    bulldozePaused: worker.bulldozePaused ?? false,
    bulldozePauseReason: worker.bulldozePauseReason ?? null,
    bulldozeCyclesCompleted: worker.bulldozeCyclesCompleted ?? 0,
    bulldozeStartedAt: worker.bulldozeStartedAt ?? null,
    bulldozeLastCycleAt: worker.bulldozeLastCycleAt ?? null,
    bulldozeMetrics: worker.bulldozeMetrics ?? null,
    roleViolations: worker.roleViolations ?? 0,
    delegationMetrics: worker.delegationMetrics ?? null,
    autoContinue: worker.autoContinue ?? true,
    autoContinueCount: worker.autoContinueCount ?? 0,
    rateLimited: worker.rateLimited ?? false,
    rateLimitResetAt: worker.rateLimitResetAt ?? null,
  };
}
