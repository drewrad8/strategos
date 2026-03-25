/**
 * Health monitoring, crash detection/recovery, periodic cleanup, and respawn suggestions.
 */

import {
  workers, outputBuffers, commandQueues, ptyInstances,
  healthChecks, sessionFailCounts, pendingWorkers, inFlightSpawns,
  autoCleanupTimers, lastResizeSize, respawnAttempts, _contextWriteLocks,
  respawnSuggestions, MAX_RESPAWN_SUGGESTIONS,
  autoDismissTimers, AUTO_DISMISS_DELAY_MS,
  MAX_CONCURRENT_WORKERS, AUTO_CLEANUP_DELAY_MS, STALE_WORKER_THRESHOLD_MS,
  MAX_RESPAWN_ATTEMPTS, RESPAWN_COOLDOWN_MS,
  path, stripAnsiCodes, normalizeWorker, addActivity,
  spawnTmux, validateSessionName,
  getWorkerDeathCallback,
} from './state.js';

import { isProtectedWorker } from './templates.js';
import { stopPtyCapture, sendInputDirect } from './output.js';
import { tryAutoPromoteWorker } from './ralph.js';
import {
  getSystemResources, checkWorkerAges,
  CRITICAL_AVAILABLE_MB, SWAP_CRITICAL_PERCENT,
} from './resources.js';
import { clearWorkerContext } from '../summaryService.js';
import { getLogger } from '../logger.js';
import { recordWorkerSuccess, recordWorkerRespawn, recordWorkerFalseCrash, recordWorkerTaskDuration, recordWorkerRoleViolations, recordWorkerRalphSignals } from '../metricsService.js';
import { detectWorkerType as detectWorkerTypeForMetrics } from './templates.js';
import {
  markWorkerFailed,
  markWorkerCompleted,
  removeWorkerDependencies,
  cleanupFinishedWorkflows,
} from '../dependencyGraph.js';
import {
  endSession as dbEndSession,
} from '../workerOutputDb.js';

// Global health monitor interval
let globalHealthInterval = null;

// Periodic cleanup interval
let cleanupInterval = null;

// Resource monitoring interval (60s)
let resourceMonitorInterval = null;

// ============================================
// CRASH PATTERNS
// ============================================

export function getCrashPatterns(output) {
  const tail = output.slice(-2000);
  return [
    {
      // Only match "Cannot read properties of undefined" when accompanied by
      // Node.js/Claude Code crash indicators — not arbitrary JS errors in worker output
      test: () => tail.includes('Cannot read properties of undefined') && (
        tail.includes('UnhandledPromiseRejection') ||
        tail.includes('uncaughtException') ||
        tail.includes('TypeError:') && tail.includes('at Object.') ||
        tail.includes('node:internal/') ||
        tail.includes('process exited with code')
      ),
      reason: 'Claude Code internal error',
    },
    { test: () => tail.includes('FATAL') && tail.includes('out of memory'), reason: 'Out of memory' },
    { test: () => tail.includes('ERR_WORKER_OUT_OF_MEMORY'), reason: 'Worker out of memory' },
    { test: () => tail.includes('Maximum call stack size exceeded'), reason: 'Stack overflow' },
    { test: () => tail.includes('killed by signal') || tail.includes('received SIGTERM') || tail.includes('Killed: 9'), reason: 'Process killed by signal' },
    { test: () => tail.includes('context window') && tail.includes('exceeded'), reason: 'Context window exhausted' },
    { test: () => tail.includes('Disconnected from') && tail.includes('Claude'), reason: 'Disconnected from Claude API' },
  ];
}

// ============================================
// HEALTH MONITORING
// ============================================

export function startHealthMonitor(workerId, io) {
  healthChecks.add(workerId);

  if (!globalHealthInterval) {
    startGlobalHealthMonitor(io);
  }
}

function startGlobalHealthMonitor(io) {
  if (globalHealthInterval) return;
  console.log('[HealthMonitor] Starting global health interval (every 10s)');

  globalHealthInterval = setInterval(async () => {
    const workerIds = [...healthChecks];
    for (const workerId of workerIds) {
      try {
        await checkWorkerHealth(workerId, io);
      } catch (err) {
        console.error(`[HealthMonitor] Unhandled error for ${workerId}: ${err.message}`);
      }
    }
  }, 10000);

  if (globalHealthInterval.unref) {
    globalHealthInterval.unref();
  }
}

async function checkWorkerHealth(workerId, io) {
  const worker = workers.get(workerId);
  if (!worker) {
    healthChecks.delete(workerId);
    return;
  }

  if (worker.health === 'dead' || worker.beingCleanedUp) {
    if (io) io.emit('worker:updated', normalizeWorker(worker));
    return;
  }

  if (worker.status === 'completed' || worker.status === 'stopped') {
    return;
  }

  const output = outputBuffers.get(workerId) || '';
  const crashPatterns = getCrashPatterns(output);

  let crashDetected = false;
  for (const pattern of crashPatterns) {
    if (pattern.test()) {
      if (worker.health !== 'crashed') {
        // Before declaring crashed, verify the tmux session is actually dead
        if (worker.tmuxSession) {
          try {
            await spawnTmux(['has-session', '-t', worker.tmuxSession]);
            // Session is alive — this is a false positive from output content
            console.warn(`[CrashDetect] Pattern matched for ${workerId} (${worker.label}): "${pattern.reason}" but tmux session is alive — ignoring false positive`);
            try {
              const typeInfo = detectWorkerTypeForMetrics(worker.label);
              recordWorkerFalseCrash(worker, typeInfo.prefix || 'unknown');
            } catch { /* best effort */ }
            break;
          } catch {
            // has-session failed — session is dead, crash is real
          }
        }
        console.error(`[CrashDetect] Worker ${workerId} (${worker.label}): ${pattern.reason}`);
        worker.health = 'crashed';
        worker.crashReason = pattern.reason;
        worker.crashedAt = new Date();
        if (io) {
          io.emit('worker:crashed', { workerId, label: worker.label, reason: worker.crashReason });
        }
        handleCrashedWorker(workerId, worker, io)
          .catch(err => console.error(`[CrashDetect] handleCrashedWorker failed for ${workerId}: ${err.message}`));
      }
      crashDetected = true;
      break;
    }
  }

  if (!crashDetected) {
    const timeSinceOutput = Date.now() - new Date(worker.lastOutput).getTime();
    const outputStalled = timeSinceOutput > 10 * 60 * 1000;

    // Determine if Ralph is recently active (within 30 min)
    const ralphRecentlyActive = worker.lastRalphSignalAt &&
      (Date.now() - new Date(worker.lastRalphSignalAt).getTime()) < 30 * 60 * 1000;

    if (!outputStalled) {
      worker.health = 'healthy';
      // Reset graduated stall recovery flags when healthy
      worker._stallNudged = false;
      worker._stallWarningNudged = false;
      worker._stallAutoKilled = false;
      worker._stallCommanderNotified = false;
    } else if (ralphRecentlyActive) {
      // Output stalled but Ralph recently signaled — worker is alive, just no terminal output
      worker.health = 'healthy';
      // Reset graduated stall recovery flags when healthy
      worker._stallNudged = false;
      worker._stallWarningNudged = false;
      worker._stallAutoKilled = false;
      worker._stallCommanderNotified = false;
    } else {
      // Output stalled AND no recent Ralph signal — truly stalled
      const stalledMinutes = Math.round(timeSinceOutput / 60000);
      if (worker.health !== 'stalled') {
        console.warn(`[HealthMonitor] Worker ${workerId} (${worker.label}) stalled for ${stalledMinutes}m`);
        worker.health = 'stalled';
        if (io) {
          io.emit('worker:stalled', { workerId, label: worker.label, stalledMinutes });
        }
      }

      // === Graduated stall recovery ===

      // GENERALs with no active children are legitimately idle (awaiting Commander orders).
      // Skip 10/20-min nudges for them — they have nothing to monitor.
      const isIdleGeneral = isProtectedWorker(worker) && !([...workers.values()].some(
        w => w.parentWorkerId === workerId && w.status === 'running'
      ));

      if (stalledMinutes >= 30 && !isProtectedWorker(worker) && !worker._stallAutoKilled) {
        // 30 min stalled (non-GENERAL): auto-kill with parent notification
        worker._stallAutoKilled = true;
        console.error(`[StallRecovery] Auto-killing stalled worker ${workerId} (${worker.label}) after ${stalledMinutes}m`);
        if (worker.parentWorkerId) {
          const parentNotification = `[STALL AUTO-KILL] Your child worker "${worker.label}" (${workerId}) was automatically terminated after ${stalledMinutes} minutes of inactivity. Consider respawning if the task is still needed.`;
          sendInputDirect(worker.parentWorkerId, parentNotification, 'health:stall_kill_notification').catch(e => {
            console.warn(`[StallRecovery] Could not notify parent ${worker.parentWorkerId}: ${e.message}`);
          });
        }
        import('./lifecycle.js').then(async ({ killWorker }) => {
          try {
            await killWorker(workerId, io);
            if (io) {
              io.emit('worker:auto-killed:stall', { workerId, label: worker.label, stalledMinutes });
            }
          } catch (err) {
            console.error(`[StallRecovery] Auto-kill failed for ${workerId}: ${err.message}`);
          }
        });
      } else if (stalledMinutes >= 30 && isProtectedWorker(worker)) {
        // GENERALs: never auto-kill, but notify Commander
        if (!worker._stallCommanderNotified) {
          worker._stallCommanderNotified = true;
          console.error(`[StallRecovery] GENERAL ${workerId} (${worker.label}) stalled for ${stalledMinutes}m — notifying Commander`);
          if (io) {
            io.emit('worker:general:stalled', {
              workerId,
              label: worker.label,
              stalledMinutes,
              message: `GENERAL worker stalled for ${stalledMinutes}m — requires human attention`,
            });
          }
        }
      } else if (stalledMinutes >= 20 && !worker._stallWarningNudged && !isIdleGeneral) {
        // 20 min stalled: send warning (skip for idle GENERALs with no active children)
        worker._stallWarningNudged = true;
        console.warn(`[StallRecovery] Sending stall WARNING to ${workerId} (${worker.label}) after ${stalledMinutes}m`);
        sendInputDirect(workerId, 'STALL WARNING: You have been idle for 20 minutes. Signal your status via Ralph immediately or you will be terminated. If you are working on something that does not produce output, signal in_progress with your current step.', 'health:stall_warning').catch(e => {
          console.warn(`[StallRecovery] Warning nudge failed for ${workerId}: ${e.message}`);
        });
      } else if (stalledMinutes >= 10 && !worker._stallNudged && !isIdleGeneral) {
        // 10 min stalled: send nudge (skip for idle GENERALs with no active children)
        worker._stallNudged = true;
        console.warn(`[StallRecovery] Sending stall nudge to ${workerId} (${worker.label}) after ${stalledMinutes}m`);
        sendInputDirect(workerId, 'You appear to be idle. If you are working on something that does not produce output, signal Ralph with your progress. If you are stuck, signal blocked via Ralph.', 'health:stall_nudge').catch(e => {
          console.warn(`[StallRecovery] Nudge failed for ${workerId}: ${e.message}`);
        });
      }
    }

    if (worker.ralphStatus === 'blocked' && !worker._blockedEmitted) {
      console.warn(`[HEALTH] Worker ${workerId} (${worker.label}) signaled BLOCKED: ${worker.ralphProgress}`);
      worker._blockedEmitted = true;
      if (io) {
        io.emit('worker:blocked', { workerId, label: worker.label, ralphStatus: worker.ralphStatus });
      }
    } else if (worker.ralphStatus !== 'blocked') {
      worker._blockedEmitted = false;
    }

    // === Mandatory early Ralph signal check ===
    // If a worker has a task but hasn't signaled Ralph within 5 minutes, send a nudge
    if (worker.task && worker.status === 'running' && !worker.firstRalphAt && !worker._earlyRalphNudged) {
      const taskTime = worker.taskReceivedAt || worker.createdAt;
      if (taskTime) {
        const msSinceTask = Date.now() - new Date(taskTime).getTime();
        if (msSinceTask > 5 * 60 * 1000) {
          worker._earlyRalphNudged = true;
          console.warn(`[HealthMonitor] Worker ${workerId} (${worker.label}) has not signaled Ralph within 5 minutes of receiving task`);
          if (io) {
            io.emit('worker:signal-overdue', { workerId, label: worker.label, minutesSinceTask: Math.round(msSinceTask / 60000) });
          }
          sendInputDirect(workerId, 'REMINDER: Signal your progress via Ralph. You have not sent any status updates since receiving your task. Signal in_progress with your current step so your parent knows you are alive.', 'health:early_ralph_nudge').catch(e => {
            console.warn(`[HealthMonitor] Early Ralph nudge failed for ${workerId}: ${e.message}`);
          });
        }
      }
    }
  }

  // Auto-promotion sweep — delegates to shared function which handles the full
  // done-path: status change, parent delivery, parent aggregation, socket events.
  // (P2/P3 fix: was previously inline and skipped parent delivery)
  tryAutoPromoteWorker(worker, io, 'health');

  const queue = commandQueues.get(workerId) || [];
  worker.queuedCommands = queue.length;
  if (queue.length > 0 && worker.lastActivity) {
    const msSinceActivity = Date.now() - new Date(worker.lastActivity).getTime();
    if (msSinceActivity > 30000) {
      console.warn(`[HealthMonitor] Worker ${workerId} (${worker.label}) has stuck queue: ${queue.length} commands, no activity for ${Math.round(msSinceActivity / 1000)}s`);
    }
  }

  if (io) {
    io.emit('worker:updated', normalizeWorker(worker));
  }
}

export function stopHealthMonitor(workerId) {
  healthChecks.delete(workerId);
}

export function stopAllHealthMonitors() {
  const count = healthChecks.size;
  healthChecks.clear();
  if (globalHealthInterval) {
    clearInterval(globalHealthInterval);
    globalHealthInterval = null;
  }
  if (count > 0) {
    console.log(`[Shutdown] Stopped health monitoring for ${count} worker(s)`);
  }
}

// ============================================
// RESPAWN SUGGESTIONS
// ============================================

export function addRespawnSuggestion(workerId, worker) {
  if (!worker.task || worker.ralphStatus !== 'in_progress') return;

  const suggestion = {
    workerId,
    label: worker.label,
    project: worker.project,
    task: worker.task,
    diedAt: new Date().toISOString(),
    ralphProgress: worker.ralphProgress || null,
    ralphCurrentStep: worker.ralphCurrentStep || null,
  };

  respawnSuggestions.unshift(suggestion);
  if (respawnSuggestions.length > MAX_RESPAWN_SUGGESTIONS) {
    respawnSuggestions.length = MAX_RESPAWN_SUGGESTIONS;
  }
  console.log(`[RespawnSuggestion] Added suggestion for ${worker.label} (${workerId})`);
}

// ============================================
// CRASH RECOVERY
// ============================================

export async function handleCrashedWorker(workerId, worker, io) {
  const { writeWorkerCheckpoint } = await import('./persistence.js');
  writeWorkerCheckpoint(workerId, `crashed: ${worker.crashReason || 'unknown'}`);

  addRespawnSuggestion(workerId, worker);

  const attempts = respawnAttempts.get(workerId) || { count: 0, lastAttempt: 0 };
  const now = Date.now();

  if (now - attempts.lastAttempt > RESPAWN_COOLDOWN_MS * 3) {
    attempts.count = 0;
  }

  if (attempts.count >= MAX_RESPAWN_ATTEMPTS) {
    console.warn(`[CrashRecovery] Worker ${workerId} exceeded max respawn attempts (${MAX_RESPAWN_ATTEMPTS}), not respawning`);
    worker.status = 'error';
    worker.health = 'dead';
    try {
      const typeInfo = detectWorkerTypeForMetrics(worker.label);
      const template = typeInfo.prefix || 'unknown';
      recordWorkerSuccess(worker, false, template);
      if (worker.createdAt) {
        const durationMs = Date.now() - new Date(worker.createdAt).getTime();
        if (durationMs > 0) recordWorkerTaskDuration(worker, durationMs, template);
      }
      if (worker.ralphSignalCount > 0) recordWorkerRalphSignals(worker, worker.ralphSignalCount, template);
      if (worker.delegationMetrics?.roleViolations > 0) recordWorkerRoleViolations(worker, worker.delegationMetrics.roleViolations, template);
    } catch { /* best effort */ }
    try {
      const failedDependents = markWorkerFailed(workerId);
      for (const depId of failedDependents) {
        if (pendingWorkers.has(depId)) {
          console.log(`[CrashRecovery] Removing orphaned pending worker ${depId}`);
          pendingWorkers.delete(depId);
        }
      }
    } catch (e) { /* Worker may not be in dependency graph */ }
    if (io) {
      io.emit('worker:updated', normalizeWorker(worker));
    }
    return;
  }

  if (now - attempts.lastAttempt < RESPAWN_COOLDOWN_MS) {
    console.log(`[CrashRecovery] Worker ${workerId} in cooldown, waiting...`);
    return;
  }

  attempts.count++;
  attempts.lastAttempt = now;
  respawnAttempts.set(workerId, attempts);

  console.log(`[CrashRecovery] Respawning crashed worker ${workerId} (${worker.label}), attempt ${attempts.count}/${MAX_RESPAWN_ATTEMPTS}`);

  if (isProtectedWorker(worker)) {
    // Double-check: verify tmux session is actually dead before marking GENERAL as dead
    if (worker.tmuxSession) {
      try {
        await spawnTmux(['has-session', '-t', worker.tmuxSession]);
        // Session is alive — false positive crash detection
        console.warn(`[CrashRecovery] GENERAL ${workerId} (${worker.label}) tmux session is alive — resetting to healthy (false positive crash)`);
        try {
          const typeInfo = detectWorkerTypeForMetrics(worker.label);
          recordWorkerFalseCrash(worker, typeInfo.prefix || 'unknown');
        } catch { /* best effort */ }
        worker.health = 'healthy';
        worker.crashReason = null;
        worker.crashedAt = null;
        if (io) io.emit('worker:updated', normalizeWorker(worker));
        return;
      } catch {
        // Session is dead — proceed with marking dead
      }
    }
    console.error(`[CrashRecovery] GENERAL worker ${workerId} (${worker.label}) crashed. NOT respawning.`);
    worker.health = 'dead';
    worker.status = 'error';
    try {
      const typeInfo = detectWorkerTypeForMetrics(worker.label);
      const template = typeInfo.prefix || 'unknown';
      recordWorkerSuccess(worker, false, template);
      if (worker.createdAt) {
        const durationMs = Date.now() - new Date(worker.createdAt).getTime();
        if (durationMs > 0) recordWorkerTaskDuration(worker, durationMs, template);
      }
      if (worker.ralphSignalCount > 0) recordWorkerRalphSignals(worker, worker.ralphSignalCount, template);
    } catch { /* best effort */ }
    try {
      const failedDependents = markWorkerFailed(workerId);
      for (const depId of failedDependents) {
        if (pendingWorkers.has(depId)) {
          pendingWorkers.delete(depId);
        }
      }
    } catch (e) { /* Worker may not be in dependency graph */ }
    stopHealthMonitor(workerId);
    clearWorkerContext(workerId);
    if (io) {
      io.emit('worker:general:dead', { workerId, label: worker.label, message: 'GENERAL crashed - requires human intervention (crash recovery skipped)' });
    }
    return;
  }

  try {
    validateSessionName(worker.tmuxSession);
    await spawnTmux(['kill-session', '-t', worker.tmuxSession]);
  } catch (e) {
    // Session might already be dead
  }

  try {
    const { spawnWorker, cleanupWorker } = await import('./lifecycle.js');
    const newWorker = await spawnWorker(worker.workingDir, worker.label + ' (respawn)', io, {
      task: worker.task,
      parentWorkerId: worker.parentWorkerId,
      parentLabel: worker.parentLabel,
      autoAccept: worker.autoAccept,
      ralphMode: worker.ralphMode,
      backend: worker.backend || 'claude',
      initialInput: `You are respawning after a crash. Your previous task was: ${worker.task?.description || 'unknown'}. Continue where you left off or restart if needed.`
    });

    console.log(`[CrashRecovery] Respawned as ${newWorker.id} (${newWorker.label})`);
    try {
      const typeInfo = detectWorkerTypeForMetrics(worker.label);
      recordWorkerRespawn(worker, typeInfo.prefix || 'unknown');
    } catch { /* best effort */ }

    respawnAttempts.set(newWorker.id, { count: attempts.count, lastAttempt: attempts.lastAttempt });
    respawnAttempts.delete(workerId);

    if (worker.ralphMode && worker.parentWorkerId) {
      const parentWorker = workers.get(worker.parentWorkerId);
      if (parentWorker) {
        const msg = `[CrashRecovery] Your child worker "${worker.label}" (${workerId}) crashed and was respawned as ${newWorker.id}. Use GET /api/workers/${newWorker.id} to retrieve updated details.`;
        try {
          await sendInputDirect(worker.parentWorkerId, msg, 'health:death_notification');
        } catch (e) {
          console.warn(`[CrashRecovery] Could not notify parent ${worker.parentWorkerId}: ${e.message}`);
        }
      }
    }

    cleanupWorker(workerId, io);

    if (io) {
      io.emit('worker:respawned', {
        oldWorkerId: workerId,
        newWorkerId: newWorker.id,
        label: newWorker.label,
        attempt: attempts.count
      });
    }
  } catch (error) {
    console.error(`[CrashRecovery] Failed to respawn worker ${workerId}:`, error.message);
    if (attempts.count >= MAX_RESPAWN_ATTEMPTS) {
      worker.status = 'error';
      worker.health = 'dead';
      try {
        const failedDependents = markWorkerFailed(workerId);
        for (const depId of failedDependents) {
          if (pendingWorkers.has(depId)) {
            pendingWorkers.delete(depId);
          }
        }
      } catch (e) { /* Worker may not be in dependency graph */ }
      if (io) {
        io.emit('worker:updated', normalizeWorker(worker));
      }
    } else {
      const retryDelayMs = RESPAWN_COOLDOWN_MS + 5000;
      console.log(`[CrashRecovery] Scheduling retry for ${workerId} in ${retryDelayMs / 1000}s`);
      setTimeout(() => {
        const w = workers.get(workerId);
        if (w && w.health === 'crashed') {
          handleCrashedWorker(workerId, w, io)
            .catch(err => console.error(`[CrashRecovery] Retry failed for ${workerId}: ${err.message}`));
        }
      }, retryDelayMs);
    }
  }
}

// ============================================
// PERIODIC CLEANUP
// ============================================

export function startPeriodicCleanup(io = null) {
  if (cleanupInterval) {
    console.log('[PeriodicCleanup] Already running');
    return;
  }

  console.log('[PeriodicCleanup] Starting periodic cleanup sweep (every 60s)');

  // Start resource monitor alongside periodic cleanup
  startResourceMonitor(io);

  let _cleanupRunning = false;
  cleanupInterval = setInterval(async () => {
    if (_cleanupRunning) {
      console.warn('[PeriodicCleanup] Previous tick still running, skipping');
      return;
    }
    _cleanupRunning = true;
    const tickStart = Date.now();

    try {
    const now = Date.now();
    const workersToClean = [];

    for (const [id, worker] of workers.entries()) {
      if (worker.beingCleanedUp) continue;

      if (isProtectedWorker(worker)) {
        if (worker.status === 'completed') {
          console.warn(`[PeriodicCleanup] GENERAL worker ${id} (${worker.label}) is marked completed but will NOT be auto-cleaned.`);
        }
        continue;
      }

      if (worker.status === 'completed' && worker.completedAt) {
        const completedAge = now - new Date(worker.completedAt).getTime();
        if (completedAge > AUTO_CLEANUP_DELAY_MS + 10000) {
          workersToClean.push({ id, reason: 'completed', label: worker.label });
        }
      }

      if (worker.status === 'awaiting_review' && worker.awaitingReviewAt && !isProtectedWorker(worker)) {
        const reviewAge = now - new Date(worker.awaitingReviewAt).getTime();
        const hasParent = !!worker.parentWorkerId;
        const timeoutMs = hasParent ? 30 * 60 * 1000 : 15 * 60 * 1000;

        if (reviewAge > timeoutMs) {
          const activeChildren = (worker.childWorkerIds || []).filter(cid => {
            const child = workers.get(cid);
            return child && (child.status === 'running' || child.status === 'awaiting_review');
          });
          // Don't auto-dismiss workers that had children (they completed work, may be awaiting orders)
          const hadChildren = (worker.childWorkerHistory || []).length > 0;
          if (activeChildren.length > 0) {
            console.log(`[PeriodicCleanup] Skipping awaiting_review worker ${id} (${worker.label}) — has ${activeChildren.length} active children`);
          } else if (hadChildren) {
            console.log(`[PeriodicCleanup] Skipping awaiting_review worker ${id} (${worker.label}) — has ${worker.childWorkerHistory.length} historical children, awaiting orders`);
          } else {
            console.log(`[PeriodicCleanup] Auto-dismissing worker ${id} (${worker.label}) — awaiting_review for ${Math.round(reviewAge / 60000)}m`);
            workersToClean.push({ id, reason: 'auto-dismissed', label: worker.label });
          }
        }
      }

      if (worker.status === 'running' && worker.lastActivity) {
        const inactiveTime = now - new Date(worker.lastActivity).getTime();
        if (!Number.isNaN(inactiveTime) && inactiveTime > STALE_WORKER_THRESHOLD_MS && !worker._staleWarned) {
          worker._staleWarned = true;
          console.warn(`[PeriodicCleanup] Worker ${id} (${worker.label}) has been inactive for ${Math.round(inactiveTime / 60000)} minutes`);
        }
      }
    }

    // Perform cleanup
    const { killWorker } = await import('./lifecycle.js');
    for (const { id, reason, label } of workersToClean) {
      try {
        console.log(`[PeriodicCleanup] Cleaning up ${reason} worker ${id} (${label})`);
        await killWorker(id, io);
      } catch (error) {
        console.error(`[PeriodicCleanup] Failed to cleanup worker ${id}:`, error.message);
      }
    }

    if (workersToClean.length > 0) {
      console.log(`[PeriodicCleanup] Cleaned up ${workersToClean.length} workers`);
    }

    // Monitor aggregate output buffer memory usage
    let totalBufferBytes = 0;
    for (const output of outputBuffers.values()) {
      totalBufferBytes += typeof output === 'string' ? output.length * 2 : 0;
    }
    const bufferMB = totalBufferBytes / (1024 * 1024);
    if (bufferMB > 100) {
      console.warn(`[MemoryMonitor] Output buffers using ${bufferMB.toFixed(1)}MB across ${outputBuffers.size} workers`);
    }

    // Periodic state save
    const { saveWorkerState } = await import('./persistence.js');
    try {
      await saveWorkerState();
    } catch (err) {
      console.error(`[PeriodicCleanup] State save failed: ${err.message}`);
    }

    // Clean stale respawnAttempts
    const RESPAWN_STALE_MS = 60 * 60 * 1000;
    let respawnCleaned = 0;
    for (const [workerId, attempts] of respawnAttempts.entries()) {
      if (now - attempts.lastAttempt > RESPAWN_STALE_MS) {
        respawnAttempts.delete(workerId);
        respawnCleaned++;
      }
    }
    if (respawnCleaned > 0) {
      console.log(`[PeriodicCleanup] Cleaned ${respawnCleaned} stale respawnAttempts entries`);
    }

    // Clean up stuck pending workers
    const MAX_PENDING_TIMEOUT_MS = 30 * 60 * 1000;
    let pendingCleaned = 0;
    for (const [pendingId, pending] of pendingWorkers.entries()) {
      const deps = pending.dependsOn || [];

      const pendingAge = Date.now() - (pending.createdAt || 0);
      if (pendingAge > MAX_PENDING_TIMEOUT_MS) {
        console.warn(`[PeriodicCleanup] Removing timed-out pending worker ${pendingId} (${pending.label})`);
        pendingWorkers.delete(pendingId);
        pendingCleaned++;
        continue;
      }

      const anyDepActive = deps.some(depId => {
        const dep = workers.get(depId);
        return dep && (dep.status === 'running' || dep.status === 'completed');
      });
      if (!anyDepActive && deps.length > 0) {
        console.log(`[PeriodicCleanup] Removing stale pending worker ${pendingId} (${pending.label})`);
        pendingWorkers.delete(pendingId);
        pendingCleaned++;
      }
    }
    if (pendingCleaned > 0) {
      console.log(`[PeriodicCleanup] Cleaned ${pendingCleaned} stale pending workers`);
    }

    const depCleanup = cleanupFinishedWorkflows();
    if (depCleanup.workflowsCleaned > 0 || depCleanup.nodesCleaned > 0) {
      console.log(`[PeriodicCleanup] Cleaned ${depCleanup.workflowsCleaned} finished workflows, ${depCleanup.nodesCleaned} dep nodes`);
    }

    if (_contextWriteLocks.size > 0) {
      const activeProjectPaths = new Set();
      for (const w of workers.values()) {
        if (w.workingDir) activeProjectPaths.add(w.workingDir);
      }
      let locksCleaned = 0;
      for (const projectPath of _contextWriteLocks.keys()) {
        if (!activeProjectPaths.has(projectPath)) {
          _contextWriteLocks.delete(projectPath);
          locksCleaned++;
        }
      }
      if (locksCleaned > 0) {
        console.log(`[PeriodicCleanup] Cleaned ${locksCleaned} stale context write lock(s)`);
      }
    }

    } finally {
      _cleanupRunning = false;
      const tickDuration = Date.now() - tickStart;
      if (tickDuration > 50000) {
        console.warn(`[PeriodicCleanup] Tick took ${tickDuration}ms (near 60s interval threshold)`);
      }
    }
  }, 60000);

  if (cleanupInterval.unref) {
    cleanupInterval.unref();
  }
}

export function stopPeriodicCleanup() {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
    console.log('[PeriodicCleanup] Stopped');
  }
  stopResourceMonitor();
}

// ============================================
// RESOURCE MONITORING (every 60s)
// ============================================

/**
 * Periodic system resource check.
 * Emits socket events when memory is critically low or workers exceed age thresholds.
 */
export function startResourceMonitor(io) {
  if (resourceMonitorInterval) return;
  console.log('[ResourceMonitor] Starting periodic resource monitoring (every 60s)');

  resourceMonitorInterval = setInterval(async () => {
    try {
      // Check system memory/swap
      const resources = await getSystemResources();

      if (resources.availableMB < CRITICAL_AVAILABLE_MB) {
        console.error(`[ResourceMonitor] CRITICAL: Only ${resources.availableMB}MB memory available (threshold: ${CRITICAL_AVAILABLE_MB}MB)`);
        if (io) {
          io.emit('system:resource:critical', {
            type: 'memory',
            availableMB: resources.availableMB,
            thresholdMB: CRITICAL_AVAILABLE_MB,
            message: `System memory critically low: ${resources.availableMB}MB available`,
            timestamp: new Date().toISOString(),
          });
        }
      }

      if (resources.swapUsedPercent > 90) {
        console.error(`[ResourceMonitor] CRITICAL: Swap ${resources.swapUsedPercent}% used (${resources.swapUsedMB}MB/${resources.swapTotalMB}MB)`);
        if (io) {
          io.emit('system:resource:critical', {
            type: 'swap',
            swapUsedPercent: resources.swapUsedPercent,
            swapUsedMB: resources.swapUsedMB,
            swapTotalMB: resources.swapTotalMB,
            message: `Swap critically full: ${resources.swapUsedPercent}% used`,
            timestamp: new Date().toISOString(),
          });
        }
      }

      // Check worker ages
      const agedWorkers = checkWorkerAges();
      for (const aged of agedWorkers) {
        console.warn(`[ResourceMonitor] Worker age ${aged.severity}: ${aged.id} (${aged.label}) — ${aged.message}`);
        if (io) {
          io.emit('worker:age:warning', {
            workerId: aged.id,
            label: aged.label,
            ageHours: aged.ageHours,
            severity: aged.severity,
            message: aged.message,
            timestamp: new Date().toISOString(),
          });
        }
      }
    } catch (err) {
      console.error(`[ResourceMonitor] Error during resource check: ${err.message}`);
    }
  }, 60000);

  if (resourceMonitorInterval.unref) {
    resourceMonitorInterval.unref();
  }
}

export function stopResourceMonitor() {
  if (resourceMonitorInterval) {
    clearInterval(resourceMonitorInterval);
    resourceMonitorInterval = null;
    console.log('[ResourceMonitor] Stopped');
  }
}
