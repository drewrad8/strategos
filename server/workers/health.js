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

import { isProtectedWorker, isProtectedOrColonel as _isProtectedOrColonelFromTemplates, generateAnchorPrompt } from './templates.js';
import { stopPtyCapture, sendInputDirect } from './output.js';
import { generateConsolidationMessage } from '../services/consolidationService.js';
import { tryAutoPromoteWorker, persistFailureLearning } from './ralph.js';
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

// Re-exported from templates.js so callers that import from health.js keep working.
export const isProtectedOrColonel = _isProtectedOrColonelFromTemplates;

// GENERAL/COLONEL lifetime enforcement thresholds.
// Policy: held/blocked workers are never interrupted — they are intentionally waiting.
// Enforcement only fires against workers that have gone dark (no Ralph signals).
const GENERAL_COLONEL_STUCK_WARN_MS  = 4  * 60 * 60 * 1000; // 4h without Ralph signal → warn
const GENERAL_COLONEL_IDLE_NOTIFY_MS = 24 * 60 * 60 * 1000; // 24h without Ralph signal → blocked notification
const GENERAL_COLONEL_HARD_CAP_MS    = 48 * 60 * 60 * 1000; // 48h total runtime → hard enforcement

// Completion guard defaults — workers running this long without signaling done get a nudge,
// then a kill. Type-specific overrides are applied via getCompletionGuard() below.
const COMPLETION_NUDGE_MS = 4 * 60 * 60 * 1000;  // 4 hours (GENERAL default)
const COMPLETION_KILL_MS  = 8 * 60 * 60 * 1000;  // 8 hours (GENERAL default)

/**
 * Returns type-specific stall detection thresholds (in ms).
 * RESEARCH workers get extra breathing room for silent read-heavy work.
 * All others use the historical 5/10/15 minute defaults.
 */
export function getStallProfile(workerLabel, contextTokens) {
  const { prefix } = detectWorkerTypeForMetrics(workerLabel || '');
  let profile;
  if (prefix === 'RESEARCH') {
    profile = { nudgeMs: 8 * 60 * 1000, warnMs: 15 * 60 * 1000, killMs: 20 * 60 * 1000 };
  } else if (prefix === 'COLONEL') {
    // COLONELs have a natural 15-30 min monitoring cycle — IMPL defaults (5/10/15 min) cause false stall kills
    profile = { nudgeMs: 20 * 60 * 1000, warnMs: 40 * 60 * 1000, killMs: 60 * 60 * 1000 };
  } else {
    // Default: IMPL, FIX, TEST, REVIEW, unknown
    profile = { nudgeMs: 5 * 60 * 1000, warnMs: 10 * 60 * 1000, killMs: 15 * 60 * 1000 };
  }
  // Scale thresholds for workers near context compaction. contextTokens is in thousands (k);
  // total context window is ~200k. Workers at 70–95% fill are legitimately slow; >95% are
  // actively compacting — apply patience multipliers to prevent false-positive stall kills.
  const contextPct = (contextTokens != null && contextTokens > 0)
    ? Math.min(100, (contextTokens / 200) * 100)
    : 0;
  let multiplier = 1;
  if (contextPct >= 95) {
    multiplier = 2;   // >95%: actively compacting — maximum patience
  } else if (contextPct >= 70) {
    multiplier = 1.5; // 70–95%: near compaction — legitimately slow
  }
  if (multiplier === 1) return profile;
  return {
    nudgeMs: profile.nudgeMs * multiplier,
    warnMs:  profile.warnMs  * multiplier,
    killMs:  profile.killMs  * multiplier,
  };
}

/**
 * Returns type-specific completion guard thresholds (in ms).
 * All worker types use the safe 4h/8h defaults. The recent-Ralph-signal check
 * (applied at call site) provides the primary protection against killing active workers.
 */
function getCompletionGuard(_workerLabel) {
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

/** Returns true if the parent is present in the workers map and not dead. Exported for testing. */
export function _stallNotifyGuard(worker, workersMap) {
  return !!(
    worker.parentWorkerId &&
    workersMap.has(worker.parentWorkerId) &&
    workersMap.get(worker.parentWorkerId).health !== 'dead'
  );
}

function hasSpawnedSuccessor(worker) {
  return !!(worker._successorId);
}

/** Returns true if the worker is held for Commander direction and must be skipped by CompletionGuard. Exported for testing. */
export function _completionGuardIsExempt(worker) {
  return worker.ralphStatus === 'held' || worker._missionComplete === true || hasSpawnedSuccessor(worker);
}

export async function checkWorkerHealth(workerId, io) {
  const worker = workers.get(workerId);
  if (!worker) {
    healthChecks.delete(workerId);
    return;
  }

  if (worker.health === 'dead' || worker.beingCleanedUp) {
    if (io) io.to(`worker:${workerId}`).emit('worker:updated', normalizeWorker(worker));
    return;
  }

  // awaiting_review = task done, awaiting dismiss. Covered by startPeriodicCleanup(); revertFromDone() re-arms health state before re-entering running.
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
            } catch (err) { getLogger().error('[health.monitor] recordWorkerFalseCrash metrics failed', err?.message); }
            break;
          } catch {
            getLogger().debug('[health.monitor] has-session failed — session confirmed dead, crash is real');
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
    // Use type-specific nudgeMs as the stall-entry threshold so the health flip and first action
    // align. RESEARCH workers get 8 min breathing room instead of the global 5 min.
    // STALL_OUTPUT_MS env var overrides all type-specific thresholds (emergency escape hatch).
    const stallProfile = getStallProfile(worker.label, worker.contextTokens);
    const STALL_OUTPUT_MS = Number(process.env.STALL_OUTPUT_MS) || stallProfile.nudgeMs;
    const outputStalled = timeSinceOutput > STALL_OUTPUT_MS;

    // Determine if Ralph is recently active (within 30 min)
    const ralphRecentlyActive = worker.lastRalphSignalAt &&
      (Date.now() - new Date(worker.lastRalphSignalAt).getTime()) < 30 * 60 * 1000;

    // GENERALs/COLONELs with active children are legitimately silent (monitoring, waiting for output).
    // Exempt them from stall detection — silent monitoring is not a stall.
    // Only fires for orchestrators whose children are all terminal (done/blocked/dismissed).
    const hasActiveChildren = [...workers.values()].some(
      w => w.parentWorkerId === workerId &&
           ['running', 'pending', 'awaiting_review'].includes(w.status)
    );
    const isIdleOrchestrator = isProtectedOrColonel(worker) && hasActiveChildren;

    if (!outputStalled || ralphRecentlyActive || isIdleOrchestrator || worker.ralphStatus === 'held' || worker.autoAcceptPaused) {
      worker.health = 'healthy';
      // Reset graduated stall recovery flags when healthy
      worker._stallNudged = false;
      worker._stallWarningNudged = false;
      worker._stallParentWarned = false;
      worker._stallAutoKilled = false;
      worker._stallCommanderNotified = false;
      // Clear stall-alert dedup only on genuine output recovery (not just Ralph signal or idle-general
      // exemption). This prevents the stall toast from re-firing every time a Ralph signal briefly
      // makes the worker appear healthy before it stalls again.
      if (!outputStalled) {
        worker._stallAlertedAt = null;
      }
    } else {
      // Output stalled AND no recent Ralph signal — truly stalled
      const stalledMinutes = Math.round(timeSinceOutput / 60000);
      if (worker.health !== 'stalled') {
        logger.warn(`[HealthMonitor] Worker ${workerId} (${worker.label}) stalled for ${stalledMinutes}m`);
        worker.health = 'stalled';
      }
      // Emit the stall toast only once per stall episode. _stallAlertedAt is cleared only when
      // the worker produces actual output (not just a Ralph signal), so a single episode does not
      // spam the Commander even if health oscillates between 'stalled' and 'healthy' via Ralph signals.
      if (io && !worker._stallAlertedAt) {
        worker._stallAlertedAt = Date.now();
        io.emit('worker:stalled', { workerId, label: worker.label, stalledMinutes });
      }

      // === Graduated stall recovery ===
      const stallKillMin   = Math.round(stallProfile.killMs / 60000);
      const stallWarnMin   = Math.round(stallProfile.warnMs / 60000);
      const stallNudgeMin  = Math.round(stallProfile.nudgeMs / 60000);
      const timeSinceOutputMs = timeSinceOutput;

      // Extreme stall threshold: 60 min of zero activity is the safety net for truly dead workers
      const EXTREME_STALL_MS = 60 * 60 * 1000;

      if (timeSinceOutputMs >= EXTREME_STALL_MS && !isProtectedOrColonel(worker) && !_completionGuardIsExempt(worker) && !worker._stallAutoKilled) {
        // Extreme stall (60+ min): auto-kill as last-resort safety net (held workers are exempt)
        worker._stallAutoKilled = true;
        logger.error(`[StallRecovery] Auto-killing stalled worker ${workerId} (${worker.label}) after ${stalledMinutes}m (extreme stall threshold)`);
        if (_stallNotifyGuard(worker, workers)) {
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
      } else if (timeSinceOutputMs >= stallProfile.killMs && !isProtectedOrColonel(worker) && !worker._stallParentWarned) {
        // Stall threshold reached: warn the parent and let them decide — do not kill yet
        worker._stallParentWarned = true;
        logger.warn(`[StallRecovery] Stall warning sent to parent of ${workerId} (${worker.label}) after ${stalledMinutes}m`);
        if (_stallNotifyGuard(worker, workers)) {
          const parentWarning = `[STALL WARNING] Your child worker "${worker.label}" (${workerId}) has been inactive for ${stalledMinutes} minutes. Consider checking its status or respawning if needed.`;
          sendInputDirect(worker.parentWorkerId, parentWarning, 'health:stall_parent_warning').catch(e => {
            logger.warn(`[StallRecovery] Could not send stall warning to parent ${worker.parentWorkerId}: ${e.message}`);
          });
        }
      } else if (timeSinceOutputMs >= stallProfile.killMs && isProtectedOrColonel(worker) && !isProtectedWorker(worker)) {
        // COLONELs: never auto-kill, but notify Commander UI
        if (!worker._stallCommanderNotified) {
          worker._stallCommanderNotified = true;
          logger.error(`[StallRecovery] COLONEL ${workerId} (${worker.label}) stalled for ${stalledMinutes}m — notifying Commander`);
          if (io) {
            io.emit('worker:general:stalled', {
              workerId,
              label: worker.label,
              stalledMinutes,
              tier: 'COLONEL',
              message: `COLONEL worker stalled for ${stalledMinutes}m — requires human attention`,
            });
          }
        }
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
              tier: 'GENERAL',
              message: `GENERAL worker stalled for ${stalledMinutes}m — requires human attention`,
            });
          }
        }
      } else if (timeSinceOutputMs >= stallProfile.warnMs && !worker._stallWarningNudged) {
        // Warning threshold: send warning (idle GENERALs never reach here — exempted above)
        worker._stallWarningNudged = true;
        logger.warn(`[StallRecovery] Sending stall WARNING to ${workerId} (${worker.label}) after ${stalledMinutes}m`);
        if (worker.waitingAtPrompt) {
          // Suppress text injection — worker is at an interactive TUI prompt; injecting text corrupts menu state
          logger.warn(`[StallRecovery] Suppressed stall WARNING for ${workerId} (waitingAtPrompt — would corrupt TUI)`);
        } else {
          sendInputDirect(workerId, `STALL WARNING: You have been idle for ${stalledMinutes} minutes. Signal your status via Ralph immediately or you will be terminated. If you are working on something that does not produce output, signal in_progress with your current step.`, 'health:stall_warning').catch(e => {
            logger.warn(`[StallRecovery] Warning nudge failed for ${workerId}: ${e.message}`);
          });
        }
      } else if (timeSinceOutputMs >= stallProfile.nudgeMs && !worker._stallNudged) {
        // Nudge threshold: send nudge (idle GENERALs never reach here — exempted above)
        worker._stallNudged = true;
        logger.warn(`[StallRecovery] Sending stall nudge to ${workerId} (${worker.label}) after ${stalledMinutes}m`);
        if (worker.waitingAtPrompt) {
          // Suppress text injection — worker is at an interactive TUI prompt; injecting text corrupts menu state
          logger.warn(`[StallRecovery] Suppressed stall nudge for ${workerId} (waitingAtPrompt — would corrupt TUI)`);
        } else {
          const anchorPrefix = generateAnchorPrompt(worker);
          sendInputDirect(workerId, `${anchorPrefix}You appear to be idle. If you are working on something that does not produce output, signal Ralph with your progress. If you are stuck, signal blocked via Ralph.`, 'health:stall_nudge').catch(e => {
            logger.warn(`[StallRecovery] Nudge failed for ${workerId}: ${e.message}`);
          });
        }
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

  // === GENERAL/COLONEL lifetime enforcement ===
  // Policy (updated 2026-04-18): Held and blocked workers are NEVER interrupted — they are
  // intentionally waiting for Commander direction or already aware of a blockage. Enforcement
  // only fires against workers that have gone dark (no Ralph signals) for extended periods:
  //
  //   held / blocked status    → skip entirely (worker is legitimately paused)
  //   No signal for 4+ hours   → warn (stuck without progress)
  //   No signal for 24+ hours  → send blocked notification (idle, may be abandoned)
  //   48+ hours total runtime  → hard cap enforcement regardless of signal recency
  if (worker.status === 'running') {
    const upperLabel = (worker.label || '').toUpperCase();
    const isGeneralOrColonel = isProtectedWorker(worker) ||
      upperLabel.startsWith('COLONEL:') || upperLabel.startsWith('COL-') || upperLabel.startsWith('COL:');

    if (isGeneralOrColonel) {
      // Held = waiting for Commander review; blocked = already self-reported a blockage.
      // Both are intentional waiting states — enforcing lifetime limits here wastes completed work.
      const isWaiting = worker.ralphStatus === 'held' || worker.ralphStatus === 'blocked';

      if (!isWaiting) {
        const startTime = worker.createdAt ? new Date(worker.createdAt).getTime() : null;
        const totalRunningMs = startTime ? Date.now() - startTime : 0;
        // Treat "never signaled" as idle since creation so new workers aren't exempt
        const lastSignalMs = worker.lastRalphSignalAt
          ? Date.now() - new Date(worker.lastRalphSignalAt).getTime()
          : totalRunningMs;

        const workerTypeLabel = isProtectedWorker(worker) ? 'GENERAL' : 'COLONEL';

        if (totalRunningMs >= GENERAL_COLONEL_HARD_CAP_MS && !worker._generalColonelHardCapTriggered) {
          // Hard cap: 48+ hours total runtime — enforce regardless of recent signals
          worker._generalColonelHardCapTriggered = true;
          const lifetimeHours = Math.round(totalRunningMs / 3600000);

          // Recompute here — hasActiveChildren from the crash-detection block is out of scope.
          const hardCapHasActiveChildren = [...workers.values()].some(
            w => w.parentWorkerId === workerId &&
                 ['running', 'pending', 'awaiting_review'].includes(w.status)
          );

          logger.error(`[LifetimeEnforcement] ${workerTypeLabel} ${workerId} (${worker.label}) reached 48h hard cap (${lifetimeHours}h total runtime) — instructing signal`);

          const hardCapMsg = hardCapHasActiveChildren
            ? `${workerTypeLabel} LIFETIME NOTICE (${lifetimeHours}h): You have active children still running. When they complete, signal held if awaiting Commander direction or done if your mission is finished. No immediate action required while children are in-flight.`
            : `${workerTypeLabel} HARD CAP (48h): You have been running for ${lifetimeHours} hours. Signal done if your task is complete, held if waiting for Commander direction, or blocked if stuck.`;

          sendInputDirect(workerId, hardCapMsg, 'health:general_colonel_hard_cap')
            .catch(e => logger.warn(`[LifetimeEnforcement] Could not notify ${workerId}: ${e.message}`));

          if (_stallNotifyGuard(worker, workers)) {
            sendInputDirect(worker.parentWorkerId,
              `[LIFETIME HARD CAP] Your ${workerTypeLabel} worker "${worker.label}" (${workerId}) has been running for ${lifetimeHours} hours. It has been instructed to signal its current status.`,
              'health:general_colonel_hard_cap_parent'
            ).catch(e => logger.warn(`[LifetimeEnforcement] Could not notify parent ${worker.parentWorkerId}: ${e.message}`));
          }

          if (io) {
            io.emit('worker:general_colonel:hard_cap', { workerId, label: worker.label, lifetimeHours });
          }
        } else if (lastSignalMs >= GENERAL_COLONEL_IDLE_NOTIFY_MS && !worker._generalColonelIdleNotified) {
          // 24+ hours without any Ralph signal — worker may be abandoned
          worker._generalColonelIdleNotified = true;
          const idleHours = Math.round(lastSignalMs / 3600000);
          logger.error(`[LifetimeEnforcement] ${workerTypeLabel} ${workerId} (${worker.label}) idle for ${idleHours}h with no Ralph signals — sending blocked notification`);

          sendInputDirect(workerId,
            `${workerTypeLabel} IDLE ALERT: You have not sent any Ralph signals for ${idleHours} hours. Signal done if complete, held if awaiting Commander direction, or blocked if stuck. Your parent has been notified.`,
            'health:general_colonel_idle_notify'
          ).catch(e => logger.warn(`[LifetimeEnforcement] Could not notify ${workerId}: ${e.message}`));

          if (_stallNotifyGuard(worker, workers)) {
            sendInputDirect(worker.parentWorkerId,
              `[IDLE ALERT] Your ${workerTypeLabel} worker "${worker.label}" (${workerId}) has not sent any Ralph signals for ${idleHours} hours. Consider checking its status or respawning.`,
              'health:general_colonel_idle_parent'
            ).catch(e => logger.warn(`[LifetimeEnforcement] Could not notify parent ${worker.parentWorkerId}: ${e.message}`));
          }

          if (io) {
            io.emit('worker:general_colonel:idle', { workerId, label: worker.label, idleHours });
          }
        } else if (lastSignalMs >= GENERAL_COLONEL_STUCK_WARN_MS && !worker._generalColonelStuckWarned) {
          // 4+ hours without a Ralph signal — warn and prompt for status update
          worker._generalColonelStuckWarned = true;
          const stuckHours = Math.round(lastSignalMs / 3600000);
          logger.warn(`[LifetimeEnforcement] ${workerTypeLabel} ${workerId} (${worker.label}) no Ralph signals for ${stuckHours}h — sending progress check`);

          sendInputDirect(workerId,
            `PROGRESS CHECK: You have not sent any Ralph signals for ${stuckHours} hours. If working, signal in_progress with your current step. If done, signal done. If waiting for Commander, signal held.`,
            'health:general_colonel_stuck_warn'
          ).catch(e => logger.warn(`[LifetimeEnforcement] Could not notify ${workerId}: ${e.message}`));
        }
      }
    }
  }

  // === Completion guard (time-based, all worker types) ===
  // Workers that finish but forget to signal done accumulate idle runtime.
  // All types use 4h nudge / 8h kill. Workers with recent Ralph signals (<2h) are always skipped.
  // Held workers are intentionally paused awaiting Commander direction — exempt regardless of uptime.
  if (worker.status === 'running' && _completionGuardIsExempt(worker)) {
    logger.info(`[CompletionGuard] Skipping ${workerId} (${worker.label}) — held for Commander`);
  } else if (worker.status === 'running' && worker.ralphStatus !== 'done') {
    const startTime = worker.createdAt ? new Date(worker.createdAt).getTime() : null;
    if (startTime) {
      const runningMs = Date.now() - startTime;
      const completionGuard = getCompletionGuard(worker.label);

      // Skip CompletionGuard for ANY worker that has signaled Ralph within the last 2 hours.
      // An actively signaling worker is alive and working — it should never be auto-killed
      // regardless of total uptime. Only kill workers that have gone completely dark.
      const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
      const hasRecentRalphSignal = worker.lastRalphSignalAt &&
        (Date.now() - new Date(worker.lastRalphSignalAt).getTime()) < TWO_HOURS_MS;
      const recentlySilent = !hasRecentRalphSignal;

      if (!recentlySilent) {
        const minutesAgo = Math.round((Date.now() - new Date(worker.lastRalphSignalAt).getTime()) / 60000);
        logger.info(`[CompletionGuard] Skipping ${workerId} (${worker.label}) — recently active (${minutesAgo}m ago)`);
      } else if (runningMs >= completionGuard.killMs && !worker._completionKilled) {
        worker._completionKilled = true;
        const runningMin = Math.round(runningMs / 60000);
        const runningHours = Math.round(runningMs / 3600000);
        const runningDesc = runningMs < 3600000 ? `${runningMin} minutes` : `${runningHours} hours`;
        const ageMin = runningMin;

        if (isProtectedOrColonel(worker)) {
          // GENERALs and COLONELs are long-lived by design — skip force-kill, log only.
          logger.warn(`[CompletionGuard] skipping kill for protected/colonel worker ${workerId} (${worker.template || worker.label}) age=${ageMin}m — notifying only`);
          if (io) {
            io.emit('worker:completion-guard:protected-skip', { workerId, label: worker.label, ageMin });
          }
        } else {
          logger.error(`[CompletionGuard] Auto-killing ${workerId} (${worker.label}) after ${runningDesc} without done signal`);
          if (_stallNotifyGuard(worker, workers)) {
            sendInputDirect(worker.parentWorkerId,
              `[COMPLETION AUTO-KILL] Your worker "${worker.label}" (${workerId}) was automatically terminated after ${runningDesc} without signaling done via Ralph. Consider respawning if the task is still needed.`,
              'health:completion_kill_notification'
            ).catch(e => {
              logger.warn(`[CompletionGuard] Could not notify parent ${worker.parentWorkerId}: ${e.message}`);
            });
          }
          try {
            persistFailureLearning(worker, workerId, 'completion_guard_kill');
          } catch (err) {
            logger.warn(`[CompletionGuard] persistFailureLearning failed for ${workerId}: ${err.message}`);
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
        }
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

  // === Post-compaction re-orientation injection ===
  // If the PTY capture loop detected a context compaction event, inject a structured
  // summary so the worker can re-orient without task drift. Clear the flag after
  // injection to avoid sending it on every health cycle.
  if (worker._compactionDetected && worker.status === 'running') {
    worker._compactionDetected = false;
    const message = await generateConsolidationMessage(worker);
    logger.info(`[Compaction] Injecting re-orientation message for ${workerId} (${worker.label})`);
    sendInputDirect(workerId, message, 'health:post_compaction_reorientation').catch(e => {
      logger.warn(`[Compaction] Re-orientation injection failed for ${workerId}: ${e.message}`);
    });
    if (io) {
      io.emit('worker:compaction:reoriented', { workerId, label: worker.label });
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
      if (!worker._stuckQueueLogged) {
        worker._stuckQueueLogged = true;
        logger.warn(`[HealthMonitor] Worker ${workerId} (${worker.label}) has stuck queue: ${queue.length} commands, no activity for ${Math.round(msSinceActivity / 1000)}s`);
      }
    } else {
      worker._stuckQueueLogged = false;
    }
  } else {
    worker._stuckQueueLogged = false;
  }

  if (io) {
    io.to(`worker:${workerId}`).emit('worker:updated', normalizeWorker(worker));
  }
}

export function stopHealthMonitor(workerId) {
  healthChecks.delete(workerId);
  _ageLogLastSeen.delete(workerId);
}

export function stopAllHealthMonitors() {
  const count = healthChecks.size;
  healthChecks.clear();
  _ageLogLastSeen.clear();
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
    } catch (err) { getLogger().error('[health.monitor] metrics recording failed for crashed worker', err?.message); }
    // Record failure in learnings DB — worker is truly dead
    try {
      const { persistFailureLearning } = await import('./ralph.js');
      persistFailureLearning(worker, workerId, `crashed: ${worker.crashReason || 'unknown'}`);
    } catch (err) { getLogger().error('[health.monitor] persistFailureLearning failed', err?.message); }
    try {
      const failedDependents = markWorkerFailed(workerId);
      for (const depId of failedDependents) {
        if (pendingWorkers.has(depId)) {
          logger.info(`[CrashRecovery] Removing orphaned pending worker ${depId}`);
          pendingWorkers.delete(depId);
        }
      }
    } catch (e) { getLogger().error('[health.monitor] markWorkerFailed failed (worker may not be in dependency graph)', e?.message); }
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

  if (isProtectedOrColonel(worker)) {
    // Double-check: verify tmux session is actually dead before marking GENERAL/COLONEL as dead
    if (worker.tmuxSession) {
      try {
        await spawnTmux(['has-session', '-t', worker.tmuxSession]);
        // Session is alive — false positive crash detection
        logger.warn(`[CrashRecovery] ${isProtectedWorker(worker) ? 'GENERAL' : 'COLONEL'} ${workerId} (${worker.label}) tmux session is alive — resetting to healthy (false positive crash)`);
        try {
          const typeInfo = detectWorkerTypeForMetrics(worker.label);
          recordWorkerFalseCrash(worker, typeInfo.prefix || 'unknown');
        } catch (err) { getLogger().error('[health.monitor] recordWorkerFalseCrash metrics failed', err?.message); }
        worker.health = 'healthy';
        worker.crashReason = null;
        worker.crashedAt = null;
        if (io) io.to(`worker:${workerId}`).emit('worker:updated', normalizeWorker(worker));
        return;
      } catch {
        getLogger().debug('[health.monitor] has-session failed — GENERAL session confirmed dead');
      }
    }
    logger.error(`[CrashRecovery] ${isProtectedWorker(worker) ? 'GENERAL' : 'COLONEL'} worker ${workerId} (${worker.label}) crashed. NOT respawning (unless auto-respawn registered).`);

    // Trigger auto-respawn if the worker was registered for it
    if (worker.autoRespawn) {
      const workerSnapshot = {
        ralphProgress: worker.ralphProgress,
        ralphCurrentStep: worker.ralphCurrentStep,
        ralphLearnings: worker.ralphLearnings,
        ralphBlockedReason: worker.ralphBlockedReason,
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
    } catch (err) { getLogger().error('[health.monitor] metrics recording failed for GENERAL crash', err?.message); }
    try {
      const failedDependents = markWorkerFailed(workerId);
      for (const depId of failedDependents) {
        if (pendingWorkers.has(depId)) {
          pendingWorkers.delete(depId);
        }
      }
    } catch (e) { getLogger().error('[health.monitor] markWorkerFailed failed (worker may not be in dependency graph)', e?.message); }
    stopHealthMonitor(workerId);
    clearWorkerContext(workerId);
    // Kill the tmux session to free Claude Code process RAM.
    // workers Map entry is intentionally retained for human inspection.
    if (worker.tmuxSession) {
      try {
        validateSessionName(worker.tmuxSession);
        await spawnTmux(['kill-session', '-t', worker.tmuxSession]);
      } catch (e) {
        getLogger().debug('[health.monitor] tmux kill-session failed on protected crash (session may already be dead)', e?.message);
      }
    }
    if (io) {
      if (isProtectedWorker(worker)) {
        io.emit('worker:general:dead', { workerId, label: worker.label, message: 'GENERAL crashed - requires human intervention (crash recovery skipped)' });
      } else {
        io.emit('worker:colonel:dead', { workerId, label: worker.label, message: 'COLONEL crashed - requires human intervention (crash recovery skipped)' });
      }
    }
    return;
  }

  // Non-general/colonel workers: use rich handoff if registered for auto-respawn
  if (worker.autoRespawn) {
    const workerSnapshot = {
      ralphProgress: worker.ralphProgress,
      ralphCurrentStep: worker.ralphCurrentStep,
      ralphLearnings: worker.ralphLearnings,
      ralphBlockedReason: worker.ralphBlockedReason,
    };
    import('../services/autoRespawnService.js').then(({ handleGeneralDeath }) => {
      handleGeneralDeath(workerId, 'crashed', io, workerSnapshot).catch(e =>
        logger.error(`[AutoRespawn] handleGeneralDeath (crash) failed for ${workerId}: ${e.message}`)
      );
    }).catch(e => logger.error(`[AutoRespawn] Import failed in crash handler: ${e.message}`));
    return;
  }

  try {
    validateSessionName(worker.tmuxSession);
    await spawnTmux(['kill-session', '-t', worker.tmuxSession]);
  } catch (e) {
    getLogger().debug('[health.monitor] tmux kill-session failed (session may already be dead)', e?.message);
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
    } catch (err) { getLogger().error('[health.monitor] recordWorkerRespawn metrics failed', err?.message); }

    respawnAttempts.set(newWorker.id, { count: attempts.count, lastAttempt: attempts.lastAttempt });
    respawnAttempts.delete(workerId);

    if (worker.ralphMode && _stallNotifyGuard(worker, workers)) {
      const msg = `[CrashRecovery] Your child worker "${worker.label}" (${workerId}) crashed and was respawned as ${newWorker.id}. Use GET /api/workers/${newWorker.id} to retrieve updated details.`;
      try {
        await sendInputDirect(worker.parentWorkerId, msg, 'health:death_notification');
      } catch (e) {
        logger.warn(`[CrashRecovery] Could not notify parent ${worker.parentWorkerId}: ${e.message}`);
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
      } catch (e) { getLogger().error('[health.monitor] markWorkerFailed failed (worker may not be in dependency graph)', e?.message); }
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

      if (isProtectedOrColonel(worker)) {
        if (worker.status === 'completed') {
          if (isProtectedWorker(worker)) {
            logger.warn(`[PeriodicCleanup] GENERAL worker ${id} (${worker.label}) is marked completed but will NOT be auto-cleaned.`);
          } else {
            logger.warn(`[PeriodicCleanup] COLONEL worker ${id} (${worker.label}) is marked completed but will NOT be auto-cleaned.`);
          }
        }
        continue;
      }

      if (worker.status === 'completed' && worker.completedAt) {
        const completedAge = now - new Date(worker.completedAt).getTime();
        if (completedAge > AUTO_CLEANUP_DELAY_MS + 10000) {
          workersToClean.push({ id, reason: 'completed', label: worker.label });
        }
      }

      if (worker.status === 'awaiting_review' && worker.awaitingReviewAt && !isProtectedOrColonel(worker)) {
        const reviewAge = now - new Date(worker.awaitingReviewAt).getTime();
        const hasParent = !!worker.parentWorkerId;
        const timeoutMs = hasParent ? 2 * 60 * 60 * 1000 : 60 * 60 * 1000; // 2h parented / 60min parentless

        if (reviewAge > timeoutMs) {
          const activeChildren = (worker.childWorkerIds || []).filter(cid => {
            const child = workers.get(cid);
            return child && (child.status === 'running' || child.status === 'awaiting_review');
          });
          // Don't auto-dismiss workers that had children (they completed work, may be awaiting orders)
          const hadChildren = (worker.childWorkerHistory || []).length > 0;
          const MAX_HADCHILDREN_AWAITING_MS = 24 * 60 * 60 * 1000; // 24h
          if (activeChildren.length > 0) {
            logger.info(`[PeriodicCleanup] Skipping awaiting_review worker ${id} (${worker.label}) — has ${activeChildren.length} active children`);
          } else if (hadChildren) {
            if (reviewAge > MAX_HADCHILDREN_AWAITING_MS) {
              logger.info(`[PeriodicCleanup] hadChildren exemption expired for ${id} (${worker.label}) — awaiting_review for ${Math.round(reviewAge / 60000)}m (>${Math.round(MAX_HADCHILDREN_AWAITING_MS / 60000)}m bound)`);
              try { persistFailureLearning(worker, id, 'hadchildren_timeout'); } catch (e) { logger.warn(`[PeriodicCleanup] persistFailureLearning failed for ${id}: ${e.message}`); }
              workersToClean.push({ id, reason: 'hadchildren-timeout', label: worker.label });
            } else {
              logger.info(`[PeriodicCleanup] Skipping awaiting_review worker ${id} (${worker.label}) — has ${worker.childWorkerHistory.length} historical children, awaiting orders`);
            }
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
        try { persistFailureLearning(pending, pendingId, 'pending_timeout_kill'); } catch (e) { logger.warn(`[PeriodicCleanup] persistFailureLearning failed for ${pendingId}: ${e.message}`); }
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
        try { persistFailureLearning(pending, pendingId, 'pending_stale_deps_kill'); } catch (e) { logger.warn(`[PeriodicCleanup] persistFailureLearning failed for ${pendingId}: ${e.message}`); }
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
