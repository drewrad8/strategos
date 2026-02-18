/**
 * Sentinel — Continuous self-diagnostics for Strategos.
 *
 * Runs server-side (no worker needed). Performs deep health checks every
 * SENTINEL_INTERVAL_MS and exposes results via getLastDiagnostics().
 *
 * External watchdog (systemd timer) calls GET /api/diagnostics to consume results.
 *
 * Checks:
 *  - Process: memory, uptime, event loop lag
 *  - Workers: status coherence, tmux session liveness, orphan detection, pane process
 *  - Circuit breaker: tmux failure state
 *  - Ralph: stall detection (workers that never signal)
 *  - Tmux: socket health, session list vs worker Map consistency
 */

import { spawn } from 'child_process';
import { getWorkers, getCircuitBreakerStatus, getResourceStats } from './workerManager.js';

// Dedicated tmux socket — must match workerManager.js
const TMUX_SOCKET = 'strategos';

const SENTINEL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_HISTORY = 288; // 24h at 5min intervals

let _interval = null;
let _history = [];
let _lastResult = null;
let _startedAt = null;

/**
 * Run a tmux command on the strategos socket. Returns { stdout, stderr, code }.
 */
function tmuxCheck(args) {
  return new Promise((resolve) => {
    const proc = spawn('tmux', ['-L', TMUX_SOCKET, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => stdout += d.toString());
    proc.stderr.on('data', d => stderr += d.toString());
    proc.on('close', code => resolve({ stdout, stderr, code }));
    proc.on('error', () => resolve({ stdout: '', stderr: 'spawn failed', code: -1 }));
    // 10s timeout
    setTimeout(() => { try { proc.kill(); } catch {} resolve({ stdout: '', stderr: 'timeout', code: -2 }); }, 10000);
  });
}

/**
 * Run all diagnostics. Returns a structured result object.
 */
export async function runDiagnostics() {
  const ts = new Date().toISOString();
  const issues = [];
  const warnings = [];
  const checks = {};

  // --- Process Health ---
  const mem = process.memoryUsage();
  const heapUsedMB = Math.round(mem.heapUsed / 1024 / 1024);
  const rssMB = Math.round(mem.rss / 1024 / 1024);
  const uptimeSeconds = Math.round(process.uptime());

  checks.process = {
    heapUsedMB,
    rssMB,
    uptimeSeconds,
    pid: process.pid,
    nodeVersion: process.version,
  };

  if (rssMB > 500) issues.push(`High RSS memory: ${rssMB}MB (threshold 500MB)`);
  else if (rssMB > 300) warnings.push(`Elevated RSS memory: ${rssMB}MB`);

  // Event loop lag (rough check)
  const lagStart = Date.now();
  await new Promise(r => setImmediate(r));
  const lagMs = Date.now() - lagStart;
  checks.process.eventLoopLagMs = lagMs;
  if (lagMs > 100) warnings.push(`Event loop lag: ${lagMs}ms`);
  if (lagMs > 500) issues.push(`Critical event loop lag: ${lagMs}ms`);

  // --- Worker Coherence ---
  const workers = getWorkers();
  const stats = getResourceStats();
  const runningWorkers = workers.filter(w => w.status === 'running');
  const deadWorkers = workers.filter(w => w.health === 'dead');
  const errorWorkers = workers.filter(w => w.status === 'error');

  checks.workers = {
    total: workers.length,
    running: runningWorkers.length,
    dead: deadWorkers.length,
    error: errorWorkers.length,
    ...stats,
  };

  if (deadWorkers.length > 0) {
    issues.push(`${deadWorkers.length} dead worker(s): ${deadWorkers.map(w => `${w.id}(${w.label})`).join(', ')}`);
  }
  if (errorWorkers.length > 0) {
    warnings.push(`${errorWorkers.length} error worker(s): ${errorWorkers.map(w => `${w.id}(${w.label})`).join(', ')}`);
  }

  // --- Tmux Session Liveness ---
  const tmuxResult = await tmuxCheck(['list-sessions', '-F', '#{session_name}']);
  const tmuxSessions = tmuxResult.code === 0
    ? tmuxResult.stdout.trim().split('\n').filter(Boolean)
    : [];
  const tmuxAlive = tmuxResult.code === 0;

  checks.tmux = {
    alive: tmuxAlive,
    sessionCount: tmuxSessions.length,
    sessions: tmuxSessions,
  };

  // Cross-check: every running worker should have a tmux session
  const orphanedWorkers = [];
  const orphanedSessions = [];

  for (const w of runningWorkers) {
    if (!tmuxSessions.includes(w.tmuxSession)) {
      orphanedWorkers.push(`${w.id}(${w.label}) missing session ${w.tmuxSession}`);
    }
  }

  // Sessions that exist but have no matching worker
  const workerSessions = new Set(workers.map(w => w.tmuxSession));
  for (const sess of tmuxSessions) {
    if (sess.startsWith('thea-worker-') && !workerSessions.has(sess)) {
      orphanedSessions.push(sess);
    }
  }

  if (orphanedWorkers.length > 0) {
    issues.push(`Workers without tmux sessions: ${orphanedWorkers.join(', ')}`);
  }
  if (orphanedSessions.length > 0) {
    warnings.push(`Orphaned tmux sessions (no matching worker): ${orphanedSessions.join(', ')}`);
  }

  checks.tmuxCoherence = { orphanedWorkers, orphanedSessions };

  // --- Circuit Breaker ---
  const cb = getCircuitBreakerStatus();
  checks.circuitBreaker = cb;
  if (cb.tripped) {
    issues.push(`Tmux circuit breaker TRIPPED (${cb.failCount} failures in ${cb.windowMs}ms)`);
  }

  // --- Worker-specific: check claude process is alive in running workers ---
  const processChecks = [];
  for (const w of runningWorkers.slice(0, 10)) { // cap at 10 to avoid slow diagnostics
    const paneResult = await tmuxCheck(['list-panes', '-t', w.tmuxSession, '-F', '#{pane_current_command}']);
    const cmd = paneResult.code === 0 ? paneResult.stdout.trim() : 'DEAD';
    processChecks.push({ id: w.id, label: w.label, paneCommand: cmd });
    if (cmd !== 'claude' && cmd !== 'DEAD') {
      warnings.push(`Worker ${w.id}(${w.label}) pane running '${cmd}' instead of 'claude'`);
    }
    if (cmd === 'DEAD') {
      issues.push(`Worker ${w.id}(${w.label}) tmux session dead`);
    }
  }
  checks.workerProcesses = processChecks;

  // --- Ralph Stall Detection ---
  const now = Date.now();
  const ralphStalls = [];
  for (const w of runningWorkers) {
    if (w.ralphMode && w.ralphStatus === 'pending') {
      const ageMs = now - new Date(w.createdAt).getTime();
      if (ageMs > 5 * 60 * 1000) { // 5 min without signaling
        ralphStalls.push(`${w.id}(${w.label}) — ${Math.round(ageMs / 60000)}min without Ralph signal`);
      }
    }
  }
  if (ralphStalls.length > 0) {
    warnings.push(`Ralph stalls: ${ralphStalls.join(', ')}`);
  }
  checks.ralphStalls = ralphStalls;

  // --- Summary ---
  const status = issues.length > 0 ? 'unhealthy' : (warnings.length > 0 ? 'degraded' : 'healthy');

  const result = {
    timestamp: ts,
    status,
    issues,
    warnings,
    checks,
    sentinelUptime: _startedAt ? Math.round((Date.now() - _startedAt) / 1000) : 0,
    historyLength: _history.length,
  };

  _lastResult = result;
  _history.push({ timestamp: ts, status, issueCount: issues.length, warningCount: warnings.length });
  if (_history.length > MAX_HISTORY) _history.shift();

  // Log if unhealthy
  if (status === 'unhealthy') {
    console.error(`[Sentinel] UNHEALTHY: ${issues.join(' | ')}`);
  } else if (status === 'degraded') {
    console.warn(`[Sentinel] DEGRADED: ${warnings.join(' | ')}`);
  }

  return result;
}

/**
 * Start the sentinel periodic check.
 */
export function startSentinel() {
  if (_interval) return;
  _startedAt = Date.now();
  console.log(`[Sentinel] Started (interval: ${SENTINEL_INTERVAL_MS / 1000}s)`);

  // Run first check after 30s (let server fully initialize)
  setTimeout(() => {
    runDiagnostics().catch(err => console.error(`[Sentinel] Diagnostic error: ${err.message}`));
  }, 30000);

  _interval = setInterval(() => {
    runDiagnostics().catch(err => console.error(`[Sentinel] Diagnostic error: ${err.message}`));
  }, SENTINEL_INTERVAL_MS);
}

/**
 * Stop the sentinel.
 */
export function stopSentinel() {
  if (_interval) {
    clearInterval(_interval);
    _interval = null;
    console.log('[Sentinel] Stopped');
  }
}

/**
 * Get the last diagnostics result (for API endpoint).
 */
export function getLastDiagnostics() {
  return _lastResult;
}

/**
 * Get diagnostics history (for trend analysis).
 */
export function getDiagnosticsHistory() {
  return _history;
}

/**
 * Get sentinel status (for toggle UI).
 */
export function getSentinelStatus() {
  return {
    enabled: _interval !== null,
    startedAt: _startedAt ? new Date(_startedAt).toISOString() : null,
    uptimeSeconds: _startedAt ? Math.round((Date.now() - _startedAt) / 1000) : 0,
    lastCheck: _lastResult?.timestamp || null,
    lastStatus: _lastResult?.status || null,
    checksRun: _history.length,
  };
}
