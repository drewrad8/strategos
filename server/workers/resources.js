/**
 * System resource monitoring and spawn gating.
 * Prevents workers from exhausting system memory/swap.
 * 
 * Key safeguards:
 * 1. Pre-spawn resource check — blocks spawns when memory is critically low
 * 2. Periodic system health monitoring — warns when resources are depleting
 * 3. Worker max-age enforcement — flags workers running beyond safe limits
 * 4. Aggregate RSS tracking — monitors total memory used by all worker processes
 */

import { execAsync, workers } from './state.js';

// ============================================
// CONSTANTS
// ============================================

// Memory thresholds (in MB)
export const SPAWN_MIN_AVAILABLE_MB = 1024;      // Require 1GB free before spawning
export const WARN_AVAILABLE_MB = 2048;            // Warn when below 2GB free
export const CRITICAL_AVAILABLE_MB = 512;         // Critical: should kill idle workers

// Swap thresholds (percentage used)
export const SWAP_WARN_PERCENT = 70;              // Warn when swap > 70% used
export const SWAP_CRITICAL_PERCENT = 90;          // Critical when swap > 90% used

// Worker age limits (in hours)
export const WORKER_MAX_AGE_HOURS = 24;           // Warn after 24 hours
export const WORKER_CRITICAL_AGE_HOURS = 72;      // Critical after 72 hours

// Per-worker estimated RSS (MB) — used when actual RSS is unavailable
export const ESTIMATED_WORKER_RSS_MB = 450;

// Cache for system resource checks (avoid hammering /proc every 5s)
let _lastResourceCheck = null;
let _lastResourceCheckAt = 0;
const RESOURCE_CHECK_CACHE_MS = 15_000; // Cache for 15s

// ============================================
// SYSTEM RESOURCE CHECKS
// ============================================

/**
 * Get system memory and swap info from /proc/meminfo.
 * Returns { totalMB, availableMB, swapTotalMB, swapFreeMB, swapUsedPercent }.
 * Cached for 15s to avoid excessive reads.
 */
export async function getSystemResources() {
  const now = Date.now();
  if (_lastResourceCheck && (now - _lastResourceCheckAt) < RESOURCE_CHECK_CACHE_MS) {
    return _lastResourceCheck;
  }

  try {
    const { stdout } = await execAsync('cat /proc/meminfo');
    const lines = stdout.split('\n');
    const get = (key) => {
      const line = lines.find(l => l.startsWith(key + ':'));
      if (!line) return 0;
      const match = line.match(/(\d+)/);
      return match ? parseInt(match[1]) / 1024 : 0; // kB to MB
    };

    const totalMB = get('MemTotal');
    const availableMB = get('MemAvailable');
    const swapTotalMB = get('SwapTotal');
    const swapFreeMB = get('SwapFree');
    const swapUsedMB = swapTotalMB - swapFreeMB;
    const swapUsedPercent = swapTotalMB > 0 ? Math.round((swapUsedMB / swapTotalMB) * 100) : 0;

    const result = {
      totalMB: Math.round(totalMB),
      availableMB: Math.round(availableMB),
      usedPercent: Math.round(((totalMB - availableMB) / totalMB) * 100),
      swapTotalMB: Math.round(swapTotalMB),
      swapFreeMB: Math.round(swapFreeMB),
      swapUsedMB: Math.round(swapUsedMB),
      swapUsedPercent,
      checkedAt: new Date().toISOString(),
    };

    _lastResourceCheck = result;
    _lastResourceCheckAt = now;
    return result;
  } catch (err) {
    console.error(`[Resources] Failed to read /proc/meminfo: ${err.message}`);
    // Return a permissive default so we don't block spawns on read failure
    return {
      totalMB: 0, availableMB: Infinity, usedPercent: 0,
      swapTotalMB: 0, swapFreeMB: Infinity, swapUsedMB: 0, swapUsedPercent: 0,
      checkedAt: new Date().toISOString(),
      error: err.message,
    };
  }
}

/**
 * Get aggregate RSS of all worker processes (Claude Code / gemini / aider).
 * Searches for processes matching worker tools.
 */
export async function getWorkerProcessRSS() {
  try {
    // ps output: RSS(KB) PID COMMAND
    const { stdout } = await execAsync(
      "ps aux --no-headers | grep -E '(claude|gemini-cli|aider)' | grep -v grep | awk '{print $6, $2, $11}'"
    );

    const processes = stdout.trim().split('\n').filter(Boolean).map(line => {
      const [rssKB, pid, cmd] = line.trim().split(/\s+/);
      return { rssKB: parseInt(rssKB) || 0, pid, cmd };
    });

    const totalRSSMB = Math.round(processes.reduce((sum, p) => sum + p.rssKB, 0) / 1024);

    return {
      processCount: processes.length,
      totalRSSMB,
      processes: processes.map(p => ({
        pid: p.pid,
        rssMB: Math.round(p.rssKB / 1024),
        cmd: p.cmd,
      })),
    };
  } catch {
    return { processCount: 0, totalRSSMB: 0, processes: [] };
  }
}

// ============================================
// SPAWN GATING
// ============================================

/**
 * Check if system has enough resources to spawn a new worker.
 * Returns { allowed: boolean, reason?: string, resources: object }.
 * Called from lifecycle.js before spawning.
 */
export async function checkSpawnResources() {
  const resources = await getSystemResources();

  // Check available memory
  if (resources.availableMB < SPAWN_MIN_AVAILABLE_MB) {
    return {
      allowed: false,
      reason: `Insufficient memory: ${resources.availableMB}MB available, need ${SPAWN_MIN_AVAILABLE_MB}MB. ` +
        `Kill idle workers or wait for memory to free up.`,
      resources,
      severity: 'critical',
    };
  }

  // Check swap usage
  if (resources.swapUsedPercent >= SWAP_CRITICAL_PERCENT) {
    return {
      allowed: false,
      reason: `Swap critically full: ${resources.swapUsedPercent}% used (${resources.swapUsedMB}MB/${resources.swapTotalMB}MB). ` +
        `System at risk of becoming unresponsive. Kill workers to free memory.`,
      resources,
      severity: 'critical',
    };
  }

  // Warnings (allow spawn but log)
  const warnings = [];
  if (resources.availableMB < WARN_AVAILABLE_MB) {
    warnings.push(`Low memory: ${resources.availableMB}MB available`);
  }
  if (resources.swapUsedPercent >= SWAP_WARN_PERCENT) {
    warnings.push(`High swap usage: ${resources.swapUsedPercent}%`);
  }

  if (warnings.length > 0) {
    console.warn(`[Resources] Spawn allowed with warnings: ${warnings.join(', ')}`);
  }

  return {
    allowed: true,
    warnings: warnings.length > 0 ? warnings : undefined,
    resources,
    severity: warnings.length > 0 ? 'warning' : 'ok',
  };
}

// ============================================
// WORKER AGE MONITORING
// ============================================

/**
 * Check all running workers for age-related issues.
 * Returns list of workers exceeding age thresholds.
 */
export function checkWorkerAges() {
  const now = Date.now();
  const aged = [];

  for (const [id, worker] of workers.entries()) {
    if (worker.status !== 'running') continue;
    if (!worker.createdAt) continue;

    const ageMs = now - new Date(worker.createdAt).getTime();
    const ageHours = ageMs / 3600000;

    if (ageHours >= WORKER_CRITICAL_AGE_HOURS) {
      aged.push({
        id,
        label: worker.label,
        ageHours: Math.round(ageHours * 10) / 10,
        severity: 'critical',
        message: `Worker running for ${Math.round(ageHours)}h (limit: ${WORKER_CRITICAL_AGE_HOURS}h)`,
      });
    } else if (ageHours >= WORKER_MAX_AGE_HOURS) {
      aged.push({
        id,
        label: worker.label,
        ageHours: Math.round(ageHours * 10) / 10,
        severity: 'warning',
        message: `Worker running for ${Math.round(ageHours)}h (recommended max: ${WORKER_MAX_AGE_HOURS}h)`,
      });
    }
  }

  return aged;
}

// ============================================
// COMPREHENSIVE RESOURCE REPORT
// ============================================

/**
 * Full system resource report for the dashboard / health endpoint.
 */
export async function getResourceReport() {
  const [systemResources, workerRSS] = await Promise.all([
    getSystemResources(),
    getWorkerProcessRSS(),
  ]);

  const agedWorkers = checkWorkerAges();
  const runningCount = Array.from(workers.values()).filter(w => w.status === 'running').length;

  // Overall severity
  let severity = 'ok';
  if (systemResources.availableMB < CRITICAL_AVAILABLE_MB ||
      systemResources.swapUsedPercent >= SWAP_CRITICAL_PERCENT ||
      agedWorkers.some(w => w.severity === 'critical')) {
    severity = 'critical';
  } else if (systemResources.availableMB < WARN_AVAILABLE_MB ||
             systemResources.swapUsedPercent >= SWAP_WARN_PERCENT ||
             agedWorkers.some(w => w.severity === 'warning')) {
    severity = 'warning';
  }

  return {
    severity,
    system: systemResources,
    workers: {
      running: runningCount,
      totalRSSMB: workerRSS.totalRSSMB,
      processCount: workerRSS.processCount,
      processes: workerRSS.processes,
    },
    agedWorkers,
    thresholds: {
      spawnMinAvailableMB: SPAWN_MIN_AVAILABLE_MB,
      warnAvailableMB: WARN_AVAILABLE_MB,
      criticalAvailableMB: CRITICAL_AVAILABLE_MB,
      swapWarnPercent: SWAP_WARN_PERCENT,
      swapCriticalPercent: SWAP_CRITICAL_PERCENT,
      workerMaxAgeHours: WORKER_MAX_AGE_HOURS,
      workerCriticalAgeHours: WORKER_CRITICAL_AGE_HOURS,
    },
  };
}
