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

const logger = getLogger();

// Colonel max lifetime — colonels that run longer than this without completing
// get a blocked signal with a scope-too-large warning. Only applies to colonels.
const COLONEL_MAX_LIFETIME_MS = 75 * 60 * 1000; // 75 minutes (extended from 55 for multi-wave pipelines)

// Completion guard defaults — workers running this long without signaling done get a nudge,
// then a kill. Type-specific overrides are applied via getCompletionGuard() below.
const COMPLETION_NUDGE_MS = 4 * 60 * 60 * 1000;  // 4 hours (GENERAL default)
const COMPLETION_KILL_MS  = 8 * 60 * 60 * 1000;  // 8 hours (GENERAL default)

/**
 * Returns type-specific stall detection thresholds (in ms).
 * RESEARCH workers get extra breathing room for silent read-heavy work.
 * All others use the historical 5/10/15 minute defaults.
 */
function getStallProfile(workerLabel) {
  const { prefix } = detectWorkerTypeForMetrics(workerLabel || '');
  if (prefix === 'RESEARCH') {
    return { nudgeMs: 8 * 60 * 1000, warnMs: 15 * 60 * 1000, killMs: 20 * 60 * 1000 };
  }
  // Default: IMPL, FIX, TEST, REVIEW, COLONEL, unknown
  return { nudgeMs: 5 * 60 * 1000, warnMs: 10 * 60 * 1000, killMs: 15 * 60 * 1000 };
}

/**
 * Returns type-specific completion guard thresholds (in ms).
 * IMPL/FIX get tighter limits — a 2-hour IMPL worker is almost certainly stuck.
 * GENERALs keep the generous 4h/8h defaults for long-running operations.
 */
function getCompletionGuard(workerLabel) {
  const { prefix } = detectWorkerTypeForMetrics(workerLabel || '');
  if (prefix === 'IMPL' || prefix === 'FIX') {
    return { nudgeMs: 45 * 60 * 1000, killMs: 90 * 60 * 1000 };
  }
  return { nudgeMs: COMPLETION_NUDGE_MS, killMs: COMPLETION_KILL_MS };
}

// Global health monitor interval
let globalHealthInterval = null;

// Periodic cleanup interval
let cleanupInterval = null;

// Resource monitoring interval (60s)
let resourceMonitorInterval = null;

// Per-worker cooldown for "age" log messages (10 min between logs per worker)
const _ageLogLastSeen = new Map();

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
  logger.info('[HealthMonitor] Starting global health interval (every 10s)');

  const HEALTH_CHECK_CONCURRENCY = 5;

  globalHealthInterval = setInterval(async () => {
    const workerIds = [...healthChecks];
    // Process health checks in parallel batches of HEALTH_CHECK_CONCURRENCY
    for (let i = 0; i < workerIds.length; i += HEALTH_CHECK_CONCURRENCY) {
      const batch = workerIds.slice(i, i + HEALTH_CHECK_CONCURRENCY);
      await Promise.all(batch.map(workerId =>
        checkWorkerHealth(workerId, io).catch(err => {
          logger.error(`[HealthMonitor] Unhandled error for ${workerId}: ${err.message}`);
        })
      ));
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
    if (io) io.to(`worker:${workerId}`).emit('worker:updated', normalizeWorker(worker));
    return;
  }

  if (worker.status === 'completed' || worker.status === 'stopped' || worker.status === 'awaiting_review') {
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
            logger.warn(`[CrashDetect] Pattern matched for ${workerId} (${worker.label}): "${pattern.reason}" but tmux session is alive — ignoring false positive`);
            try {
              const typeInfo = detectWorkerTypeForMetrics(worker.label);
              recordWorkerFalseCrash(worker, typeInfo.prefix || 'unknown');
            } catch { /* best effort */ }
            break;
          } catch {
            // has-session failed — session is dead, crash is real
          }
        }
        logger.error(`[CrashDetect] Worker ${workerId} (${worker.label}): ${pattern.reason}`);
        worker.health = 'crashed';
        worker.crashReason = pattern.reason;
        worker.crashedAt = new Date();
        if (io) {
          io.emit('worker:crashed', { workerId, label: worker.label, reason: worker.crashReason });
        }
        handleCrashedWorker(workerId, worker, io)
          .catch(err => logger.error(`[CrashDetect] handleCrashedWorker failed for ${workerId}: ${err.message}`));
      }
      crashDetected = true;
      break;
    }
  }

  if (!crashDetected) {
    const timeSinceOutput = Date.now() - new Date(worker.lastOutput).getTime();
    const outputStalled = timeSinceOutput > 5 * 60 * 1000;

    // Determine if Ralph is recently active (within 30 min)
    const ralphRecentlyActive = worker.lastRalphSignalAt &&
      (Date.now() - new Date(worker.lastRalphSignalAt).getTime()) < 30 * 60 * 1000;

    // GENERALs with no active children are legitimately idle (awaiting Commander orders).
    // Exempt them from stall detection entirely — they have nothing to monitor.
    const isIdleGeneral = isProtectedWorker(worker) && !([...workers.values()].some(
      w => w.parentWorkerId === workerId && w.status === 'running'
    ));

    if (!outputStalled || ralphRecentlyActive || isIdleGeneral) {
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
        logger.warn(`[HealthMonitor] Worker ${workerId} (${worker.label}) stalled for ${stalledMinutes}m`);
        worker.health = 'stalled';
        if (io) {
          io.emit('worker:stalled', { workerId, label: worker.label, stalledMinutes });
        }
      }

      // === Graduated stall recovery ===
      const stallProfile = getStallProfile(worker.label);
      const stallKillMin   = Math.round(stallProfile.killMs / 60000);
      const stallWarnMin   = Math.round(stallProfile.warnMs / 60000);
      const stallNudgeMin  = Math.round(stallProfile.nudgeMs / 60000);
      const timeSinceOutputMs = timeSinceOutput;

      if (timeSinceOutputMs >= stallProfile.killMs && !isProtectedWorker(worker) && !worker._stallAutoKilled) {
        // Kill threshold (non-GENERAL): auto-kill with parent notification
        worker._stallAutoKilled = true;
        logger.error(`[StallRecovery] Auto-killing stalled worker ${workerId} (${worker.label}) after ${stalledMinutes}m`);
        if (worker.parentWorkerId) {
          const parentNotification = `[STALL AUTO-KILL] Your child worker "${worker.label}" (${workerId}) was automatically terminated after ${stalledMinutes} minutes of inactivity. Consider respawning if the task is still needed.`;
          sendInputDirect(worker.parentWorkerId, parentNotification, 'health:stall_kill_notification').catch(e => {
            logger.warn(`[StallRecovery] Could not notify parent ${worker.parentWorkerId}: ${e.message}`);
          });
        }
        import('./lifecycle.js').then(async ({ killWorker }) => {
          try {
            await killWorker(workerId, io);
            if (io) {
              io.emit('worker:auto-killed:stall', { workerId, label: worker.label, stalledMinutes });
            }
          } catch (err) {
            logger.error(`[StallRecovery] Auto-kill failed for ${workerId}: ${err.message}`);
          }
        });
      } else if (timeSinceOutputMs >= stallProfile.killMs && isProtectedWorker(worker)) {
        // GENERALs: never auto-kill, but notify Commander
        if (!worker._stallCommanderNotified) {
          worker._stallCommanderNotified = true;
          logger.error(`[StallRecovery] GENERAL ${workerId} (${worker.label}) stalled for ${stalledMinutes}m — notifying Commander`);
          if (io) {
            io.emit('worker:general:stalled', {
              workerId,
              label: worker.label,
              stalledMinutes,
              message: `GENERAL worker stalled for ${stalledMinutes}m — requires human attention`,
            });
          }
        }
      } else if (timeSinceOutputMs >= stallProfile.warnMs && !worker._stallWarningNudged) {
        // Warning threshold: send warning (idle GENERALs never reach here — exempted above)
        worker._stallWarningNudged = true;
        logger.warn(`[StallRecovery] Sending stall WARNING to ${workerId} (${worker.label}) after ${stalledMinutes}m`);
        sendInputDirect(workerId, `STALL WARNING: You have been idle for ${stalledMinutes} minutes. Signal your status via Ralph immediately or you will be terminated. If you are working on something that does not produce output, signal in_progress with your current step.`, 'health:stall_warning').catch(e => {
          logger.warn(`[StallRecovery] Warning nudge failed for ${workerId}: ${e.message}`);
        });
      } else if (timeSinceOutputMs >= stallProfile.nudgeMs && !worker._stallNudged) {
        // Nudge threshold: send nudge (idle GENERALs never reach here — exempted above)
        worker._stallNudged = true;
        logger.warn(`[StallRecovery] Sending stall nudge to ${workerId} (${worker.label}) after ${stalledMinutes}m`);
        sendInputDirect(workerId, 'You appear to be idle. If you are working on something that does not produce output, signal Ralph with your progress. If you are stuck, signal blocked via Ralph.', 'health:stall_nudge').catch(e => {
          logger.warn(`[StallRecovery] Nudge failed for ${workerId}: ${e.message}`);
        });
      }
    }

    if (worker.ralphStatus === 'blocked' && !worker._blockedEmitted) {
      logger.warn(`[HEALTH] Worker ${workerId} (${worker.label}) signaled BLOCKED: ${worker.ralphProgress}`);
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
          logger.warn(`[HealthMonitor] Worker ${workerId} (${worker.label}) has not signaled Ralph within 5 minutes of receiving task`);
          if (io) {
            io.emit('worker:signal-overdue', { workerId, label: worker.label, minutesSinceTask: Math.round(msSinceTask / 60000) });
          }
          sendInputDirect(workerId, 'REMINDER: Signal your progress via Ralph. You have not sent any status updates since receiving your task. Signal in_progress with your current step so your parent knows you are alive.', 'health:early_ralph_nudge').catch(e => {
            logger.warn(`[HealthMonitor] Early Ralph nudge failed for ${workerId}: ${e.message}`);
          });
        }
      }
    }
  }

  // === Colonel max-lifetime check ===
  // If a colonel hasn't completed within COLONEL_MAX_LIFETIME_MS, signal blocked
  // so its parent knows the scope was too large.
  if (!worker._colonelMaxLifetimeTriggered && worker.status === 'running') {
    const upperLabel = (worker.label || '').toUpperCase();
    const isColonel = upperLabel.startsWith('COLONEL:') || upperLabel.startsWith('COL-') || upperLabel.startsWith('COL:');
    if (isColonel) {
      const startTime = worker.createdAt ? new Date(worker.createdAt).getTime() : null;
      if (startTime && (Date.now() - startTime) > COLONEL_MAX_LIFETIME_MS) {
        worker._colonelMaxLifetimeTriggered = true;
        const lifetimeMin = Math.round((Date.now() - startTime) / 60000);
        logger.error(`[ColonelLifetime] Colonel ${workerId} (${worker.label}) has been running for ${lifetimeMin}m — triggering max-lifetime blocked signal`);

        // Notify the colonel itself to signal blocked via Ralph
        const colonelMessage = `COLONEL MAX LIFETIME REACHED: You have been running for ${lifetimeMin} minutes without completing. Your scope may be too large. Signal blocked via Ralph immediately with reason: "Colonel max lifetime reached — scope may be too large. Consider splitting into smaller tasks." Your parent has also been notified.`;
        sendInputDirect(workerId, colonelMessage, 'health:colonel_max_lifetime').catch(e => {
          logger.warn(`[ColonelLifetime] Could not notify colonel ${workerId}: ${e.message}`);
        });

        // Notify the parent so it can act
        if (worker.parentWorkerId) {
          const parentMessage = `[COLONEL MAX LIFETIME] Your colonel worker "${worker.label}" (${workerId}) has been running for ${lifetimeMin} minutes without completing. The scope may be too large. Consider splitting the task into smaller colonels or specialists. The colonel has been instructed to signal blocked.`;
          sendInputDirect(worker.parentWorkerId, parentMessage, 'health:colonel_max_lifetime_parent').catch(e => {
            logger.warn(`[ColonelLifetime] Could not notify parent ${worker.parentWorkerId}: ${e.message}`);
          });
        }

        if (io) {
          io.emit('worker:colonel:max-lifetime', {
            workerId,
            label: worker.label,
            lifetimeMin,
            message: `Colonel exceeded max lifetime (${lifetimeMin}m) — scope may be too large`,
          });
        }
      }
    }
  }

  // === Completion guard (time-based, all worker types) ===
  // Workers that finish but forget to signal done accumulate idle runtime.
  // Thresholds are type-specific: IMPL/FIX get 45min/90min, others get 4h/8h.
  if (worker.status === 'running' && worker.ralphStatus !== 'done') {
    const startTime = worker.createdAt ? new Date(worker.createdAt).getTime() : null;
    if (startTime) {
      const runningMs = Date.now() - startTime;
      const completionGuard = getCompletionGuard(worker.label);

      // Skip CompletionGuard for generals that are actively reporting in_progress.
      // A bulldoze-mode general signals every 15-30 min and should never be killed
      // for running "too long". Only kill if the general has gone dark (>2h silence).
      const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
      const recentlySilent = !isProtectedWorker(worker) ||
        !worker.lastRalphSignalAt ||
        (Date.now() - new Date(worker.lastRalphSignalAt).getTime()) >= TWO_HOURS_MS;

      if (!recentlySilent) {
        const minutesAgo = Math.round((Date.now() - new Date(worker.lastRalphSignalAt).getTime()) / 60000);
        logger.info(`[CompletionGuard] Skipping GENERAL ${workerId} (${worker.label}) — recently active (${minutesAgo}m ago)`);
      } else if (runningMs >= completionGuard.killMs && !worker._completionKilled) {
        worker._completionKilled = true;
        const runningMin = Math.round(runningMs / 60000);
        const runningHours = Math.round(runningMs / 3600000);
        const runningDesc = runningMs < 3600000 ? `${runningMin} minutes` : `${runningHours} hours`;
        logger.error(`[CompletionGuard] Auto-killing ${workerId} (${worker.label}) after ${runningDesc} without done signal`);
        if (worker.parentWorkerId) {
          sendInputDirect(worker.parentWorkerId,
            `[COMPLETION AUTO-KILL] Your worker "${worker.label}" (${workerId}) was automatically terminated after ${runningDesc} without signaling done via Ralph. Consider respawning if the task is still needed.`,
            'health:completion_kill_notification'
          ).catch(e => {
            logger.warn(`[CompletionGuard] Could not notify parent ${worker.parentWorkerId}: ${e.message}`);
          });
        }
        import('./lifecycle.js').then(async ({ killWorker }) => {
          try {
            await killWorker(workerId, io, { force: true });
            if (io) {
              io.emit('worker:auto-killed:completion', { workerId, label: worker.label, runningHours });
            }
          } catch (err) {
            logger.error(`[CompletionGuard] Auto-kill failed for ${workerId}: ${err.message}`);
          }
        });
      } else if (runningMs >= completionGuard.nudgeMs && !worker._completionNudged) {
        worker._completionNudged = true;
        const runningMin = Math.round(runningMs / 60000);
        const runningHours = Math.round(runningMs / 3600000);
        const runningDesc = runningMs < 3600000 ? `${runningMin} minutes` : `${runningHours} hours`;
        logger.warn(`[CompletionGuard] Nudging ${workerId} (${worker.label}) after ${runningDesc} without done signal`);
        sendInputDirect(workerId,
          `You have been running for over ${runningDesc}. If you have completed your task, please signal done via Ralph now.`,
          'health:completion_nudge'
        ).catch(e => {
          logger.warn(`[CompletionGuard] Nudge failed for ${workerId}: ${e.message}`);
        });
        if (io) {
          io.emit('worker:completion-nudge', { workerId, label: worker.label, runningHours });
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
      logger.warn(`[HealthMonitor] Worker ${workerId} (${worker.label}) has stuck queue: ${queue.length} commands, no activity for ${Math.round(msSinceActivity / 1000)}s`);
    }
  }

  if (io) {
    io.to(`worker:${workerId}`).emit('worker:updated', normalizeWorker(worker));
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
    logger.info(`[Shutdown] Stopped health monitoring for ${count} worker(s)`);
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
  logger.info(`[RespawnSuggestion] Added suggestion for ${worker.label} (${workerId})`);
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
    logger.warn(`[CrashRecovery] Worker ${workerId} exceeded max respawn attempts (${MAX_RESPAWN_ATTEMPTS}), not respawning`);
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
    // Record failure in learnings DB — worker is truly dead
    try {
      const { persistFailureLearning } = await import('./ralph.js');
      persistFailureLearning(worker, workerId, `crashed: ${worker.crashReason || 'unknown'}`);
    } catch { /* best effort */ }
    try {
      const failedDependents = markWorkerFailed(workerId);
      for (const depId of failedDependents) {
        if (pendingWorkers.has(depId)) {
          logger.info(`[CrashRecovery] Removing orphaned pending worker ${depId}`);
          pendingWorkers.delete(depId);
        }
      }
    } catch (e) { /* Worker may not be in dependency graph */ }
    if (io) {
      io.to(`worker:${workerId}`).emit('worker:updated', normalizeWorker(worker));
    }
    return;
  }

  if (now - attempts.lastAttempt < RESPAWN_COOLDOWN_MS) {
    logger.info(`[CrashRecovery] Worker ${workerId} in cooldown, waiting...`);
    return;
  }

  attempts.count++;
  attempts.lastAttempt = now;
  respawnAttempts.set(workerId, attempts);

  logger.info(`[CrashRecovery] Respawning crashed worker ${workerId} (${worker.label}), attempt ${attempts.count}/${MAX_RESPAWN_ATTEMPTS}`);

  if (isProtectedWorker(worker)) {
    // Double-check: verify tmux session is actually dead before marking GENERAL as dead
    if (worker.tmuxSession) {
      try {
        await spawnTmux(['has-session', '-t', worker.tmuxSession]);
        // Session is alive — false positive crash detection
        logger.warn(`[CrashRecovery] GENERAL ${workerId} (${worker.label}) tmux session is alive — resetting to healthy (false positive crash)`);
        try {
          const typeInfo = detectWorkerTypeForMetrics(worker.label);
          recordWorkerFalseCrash(worker, typeInfo.prefix || 'unknown');
        } catch { /* best effort */ }
        worker.health = 'healthy';
        worker.crashReason = null;
        worker.crashedAt = null;
        if (io) io.to(`worker:${workerId}`).emit('worker:updated', normalizeWorker(worker));
        return;
      } catch {
        // Session is dead — proceed with marking dead
      }
    }
    logger.error(`[CrashRecovery] GENERAL worker ${workerId} (${worker.label}) crashed. NOT respawning (unless auto-respawn registered).`);

    // Trigger auto-respawn if the worker was registered for it
    if (worker.autoRespawn) {
      const workerSnapshot = {
        ralphProgress: worker.ralphProgress,
        ralphCurrentStep: worker.ralphCurrentStep,
        ralphLearnings: worker.ralphLearnings,
      };
      import('../services/autoRespawnService.js').then(({ handleGeneralDeath }) => {
        handleGeneralDeath(workerId, 'crashed', io, workerSnapshot).catch(e =>
          logger.error(`[AutoRespawn] handleGeneralDeath (crash) failed for ${workerId}: ${e.message}`)
        );
      }).catch(e => logger.error(`[AutoRespawn] Import failed in crash handler: ${e.message}`));
    }

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

    logger.info(`[CrashRecovery] Respawned as ${newWorker.id} (${newWorker.label})`);
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
          logger.warn(`[CrashRecovery] Could not notify parent ${worker.parentWorkerId}: ${e.message}`);
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
    logger.error(`[CrashRecovery] Failed to respawn worker ${workerId}:`, error.message);
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
        io.to(`worker:${workerId}`).emit('worker:updated', normalizeWorker(worker));
      }
    } else {
      const retryDelayMs = RESPAWN_COOLDOWN_MS + 5000;
      logger.info(`[CrashRecovery] Scheduling retry for ${workerId} in ${retryDelayMs / 1000}s`);
      setTimeout(() => {
        const w = workers.get(workerId);
        if (w && w.health === 'crashed') {
          handleCrashedWorker(workerId, w, io)
            .catch(err => logger.error(`[CrashRecovery] Retry failed for ${workerId}: ${err.message}`));
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
    logger.info('[PeriodicCleanup] Already running');
    return;
  }

  logger.info('[PeriodicCleanup] Starting periodic cleanup sweep (every 60s)');

  // Start resource monitor alongside periodic cleanup
  startResourceMonitor(io);

  let _cleanupRunning = false;
  cleanupInterval = setInterval(async () => {
    if (_cleanupRunning) {
      logger.warn('[PeriodicCleanup] Previous tick still running, skipping');
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
          logger.warn(`[PeriodicCleanup] GENERAL worker ${id} (${worker.label}) is marked completed but will NOT be auto-cleaned.`);
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
            logger.info(`[PeriodicCleanup] Skipping awaiting_review worker ${id} (${worker.label}) — has ${activeChildren.length} active children`);
          } else if (hadChildren) {
            logger.info(`[PeriodicCleanup] Skipping awaiting_review worker ${id} (${worker.label}) — has ${worker.childWorkerHistory.length} historical children, awaiting orders`);
          } else {
            logger.info(`[PeriodicCleanup] Auto-dismissing worker ${id} (${worker.label}) — awaiting_review for ${Math.round(reviewAge / 60000)}m`);
            workersToClean.push({ id, reason: 'auto-dismissed', label: worker.label });
          }
        }
      }

      if (worker.status === 'running' && worker.lastActivity) {
        const inactiveTime = now - new Date(worker.lastActivity).getTime();
        if (!Number.isNaN(inactiveTime) && inactiveTime > STALE_WORKER_THRESHOLD_MS && !worker._staleWarned) {
          worker._staleWarned = true;
          logger.warn(`[PeriodicCleanup] Worker ${id} (${worker.label}) has been inactive for ${Math.round(inactiveTime / 60000)} minutes`);
        }
      }
    }

    // Perform cleanup
    const { killWorker } = await import('./lifecycle.js');
    for (const { id, reason, label } of workersToClean) {
      try {
        logger.info(`[PeriodicCleanup] Cleaning up ${reason} worker ${id} (${label})`);
        await killWorker(id, io);
      } catch (error) {
        logger.error(`[PeriodicCleanup] Failed to cleanup worker ${id}:`, error.message);
      }
    }

    if (workersToClean.length > 0) {
      logger.info(`[PeriodicCleanup] Cleaned up ${workersToClean.length} workers`);
    }

    // Monitor aggregate output buffer memory usage
    let totalBufferBytes = 0;
    for (const output of outputBuffers.values()) {
      totalBufferBytes += typeof output === 'string' ? output.length * 2 : 0;
    }
    const bufferMB = totalBufferBytes / (1024 * 1024);
    if (bufferMB > 100) {
      logger.warn(`[MemoryMonitor] Output buffers using ${bufferMB.toFixed(1)}MB across ${outputBuffers.size} workers`);
    }

    // Periodic state save
    const { saveWorkerState } = await import('./persistence.js');
    try {
      await saveWorkerState();
    } catch (err) {
      logger.error(`[PeriodicCleanup] State save failed: ${err.message}`);
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
      logger.info(`[PeriodicCleanup] Cleaned ${respawnCleaned} stale respawnAttempts entries`);
    }

    // Clean up stuck pending workers
    const MAX_PENDING_TIMEOUT_MS = 30 * 60 * 1000;
    let pendingCleaned = 0;
    for (const [pendingId, pending] of pendingWorkers.entries()) {
      const deps = pending.dependsOn || [];

      const pendingAge = Date.now() - (pending.createdAt || 0);
      if (pendingAge > MAX_PENDING_TIMEOUT_MS) {
        logger.warn(`[PeriodicCleanup] Removing timed-out pending worker ${pendingId} (${pending.label})`);
        pendingWorkers.delete(pendingId);
        pendingCleaned++;
        continue;
      }

      const anyDepActive = deps.some(depId => {
        const dep = workers.get(depId);
        return dep && (dep.status === 'running' || dep.status === 'completed');
      });
      if (!anyDepActive && deps.length > 0) {
        logger.info(`[PeriodicCleanup] Removing stale pending worker ${pendingId} (${pending.label})`);
        pendingWorkers.delete(pendingId);
        pendingCleaned++;
      }
    }
    if (pendingCleaned > 0) {
      logger.info(`[PeriodicCleanup] Cleaned ${pendingCleaned} stale pending workers`);
    }

    const depCleanup = cleanupFinishedWorkflows();
    if (depCleanup.nodesCleaned > 0) {
      logger.info(`[PeriodicCleanup] Cleaned ${depCleanup.nodesCleaned} dep nodes`);
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
        logger.info(`[PeriodicCleanup] Cleaned ${locksCleaned} stale context write lock(s)`);
      }
    }

    } finally {
      _cleanupRunning = false;
      const tickDuration = Date.now() - tickStart;
      if (tickDuration > 50000) {
        logger.warn(`[PeriodicCleanup] Tick took ${tickDuration}ms (near 60s interval threshold)`);
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
    logger.info('[PeriodicCleanup] Stopped');
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
  logger.info('[ResourceMonitor] Starting periodic resource monitoring (every 60s)');

  resourceMonitorInterval = setInterval(async () => {
    try {
      // Check system memory/swap
      const resources = await getSystemResources();

      if (resources.availableMB < CRITICAL_AVAILABLE_MB) {
        logger.error(`[ResourceMonitor] CRITICAL: Only ${resources.availableMB}MB memory available (threshold: ${CRITICAL_AVAILABLE_MB}MB)`);
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
        logger.error(`[ResourceMonitor] CRITICAL: Swap ${resources.swapUsedPercent}% used (${resources.swapUsedMB}MB/${resources.swapTotalMB}MB)`);
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
      const now = Date.now();
      for (const aged of agedWorkers) {
        const lastLogged = _ageLogLastSeen.get(aged.id) ?? 0;
        if (now - lastLogged < 10 * 60 * 1000) continue;
        _ageLogLastSeen.set(aged.id, now);
        logger.warn(`[ResourceMonitor] Worker age ${aged.severity}: ${aged.id} (${aged.label}) — ${aged.message}`);
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
      logger.error(`[ResourceMonitor] Error during resource check: ${err.message}`);
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
    logger.info('[ResourceMonitor] Stopped');
  }
}
