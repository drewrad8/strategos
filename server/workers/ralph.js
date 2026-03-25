/**
 * Ralph signal handling: status updates, auto-promotion, parent aggregation.
 * Called when workers signal progress via the Ralph protocol.
 *
 * Query functions (getWorkers, getWorker, etc.) → queries.js
 * Delegation metrics (incrementDelegationMetric, etc.) → delegation.js
 */

import {
  workers, STRATEGOS_API, normalizeWorker,
  autoDismissTimers, AUTO_DISMISS_DELAY_MS,
} from './state.js';

import { sendInputDirect } from './output.js';
import { getLogger } from '../logger.js';

// Shared completion keyword regex — used for keyword-based auto-promotion.
// Centralized here so ralph.js, health.js, and persistence.js all use the same pattern.
const COMPLETION_RE = /\b(complete[d]?|done|finished|awaiting\s+(?:orders|further)|ready\s+for\s+next|all\b.*\bpassing)\b/i;

/**
 * Check if a worker is a persistent-tier worker (GENERAL/COLONEL) that should
 * NOT be auto-promoted based on completion keywords (they use these words routinely).
 */
function isPersistentTier(worker) {
  const upperLabel = (worker.label || '').toUpperCase();
  return upperLabel.startsWith('GENERAL:') || upperLabel.startsWith('GENERAL ') ||
    upperLabel.startsWith('COLONEL:') || upperLabel.startsWith('COL-') || upperLabel.startsWith('COL:');
}

/**
 * Build and deliver a structured result summary to a parent worker.
 * Centralizes the result formatting that was previously duplicated in
 * tryAutoPromoteWorker, updateWorkerRalphStatus, and _updateParentAggregation.
 *
 * @param {Object} worker - The completed worker object
 * @param {string} workerId - Worker ID
 * @param {string} statusNote - Status line (e.g. "Complete", "Complete (auto-promoted)")
 */
function deliverResultsToParent(worker, workerId, statusNote) {
  if (!worker.parentWorkerId) return;

  // Don't deliver results from dismissed/stopped workers (race: done signal after dismissal)
  if (worker.status === 'stopped' || worker.status === 'completed') {
    getLogger().warn(`Skipping result delivery from ${workerId} — worker status is "${worker.status}" (already dismissed/stopped)`, { workerId, parentWorkerId: worker.parentWorkerId });
    return;
  }

  // Don't deliver duplicate results (worker already in awaiting_review means results were already sent)
  if (worker.status === 'awaiting_review' && worker._resultsDelivered) {
    getLogger().warn(`Skipping duplicate result delivery from ${workerId} — results already delivered`, { workerId, parentWorkerId: worker.parentWorkerId });
    return;
  }

  // Don't deliver results to parents that can no longer act on them
  const parentWorker = workers.get(worker.parentWorkerId);
  if (parentWorker) {
    // Don't deliver cross-project results (e.g. financial_tracker child → thea GENERAL)
    if (worker.project && parentWorker.project && worker.project !== parentWorker.project) {
      getLogger().warn(`Skipping cross-project result delivery: child ${workerId} (project: ${worker.project}) -> parent ${worker.parentWorkerId} (project: ${parentWorker.project})`, { workerId, parentWorkerId: worker.parentWorkerId });
      return;
    }

    const terminalStatuses = new Set(['completed', 'stopped', 'error']);
    if (terminalStatuses.has(parentWorker.status)) {
      getLogger().warn(`Skipping result delivery to parent ${worker.parentWorkerId} — parent status is "${parentWorker.status}" (ralph: "${parentWorker.ralphStatus || 'n/a'}")`, { workerId, parentWorkerId: worker.parentWorkerId });
      return;
    }
  }

  const dm = worker.delegationMetrics;
  const delegationLine = dm
    ? `Delegation: spawned ${dm.spawnsIssued} workers, ${dm.roleViolations} role violations, ${dm.filesEdited} files edited, ${dm.commandsRun} commands run`
    : null;

  const resultSummary = [
    `[RESULTS FROM ${worker.label} (${workerId})]`,
    worker.ralphLearnings ? `Learnings: ${worker.ralphLearnings}` : null,
    worker.ralphOutputs ? `Outputs: ${typeof worker.ralphOutputs === 'string' ? worker.ralphOutputs : JSON.stringify(worker.ralphOutputs)}` : null,
    worker.ralphArtifacts ? `Artifacts: ${Array.isArray(worker.ralphArtifacts) ? worker.ralphArtifacts.join(', ') : worker.ralphArtifacts}` : null,
    delegationLine,
    `Status: ${statusNote}. Worker is alive for follow-up questions.`,
    `To dismiss: curl -s -X POST ${STRATEGOS_API}/api/workers/${workerId}/dismiss`,
  ].filter(Boolean).join('\n');

  // Mark results as delivered to prevent duplicate deliveries
  worker._resultsDelivered = true;

  sendInputDirect(worker.parentWorkerId, resultSummary, 'ralph:result_delivery').catch(e => {
    getLogger().warn(`Could not deliver results to parent ${worker.parentWorkerId}`, { workerId, parentWorkerId: worker.parentWorkerId, error: e.message });
  });
}

/**
 * Emit the standard awaiting_review socket events for a completed worker.
 *
 * @param {Object} worker - The worker object
 * @param {string} workerId - Worker ID
 * @param {Object} io - Socket.io instance (nullable)
 */
function emitDoneEvents(worker, workerId, io) {
  if (!io) return;
  io.emit('worker:updated', normalizeWorker(worker));
  io.emit('worker:awaiting_review', {
    workerId,
    label: worker.label,
    learnings: worker.ralphLearnings,
    outputs: worker.ralphOutputs,
    artifacts: worker.ralphArtifacts,
    parentWorkerId: worker.parentWorkerId,
    delegationMetrics: worker.delegationMetrics || null,
  });
}

/**
 * Transition a worker to awaiting_review (done state).
 * Sets status fields, emits events, delivers results to parent.
 *
 * @param {Object} worker - The worker object
 * @param {string} workerId - Worker ID
 * @param {Object} io - Socket.io instance (nullable)
 * @param {string} statusNote - Status note for parent delivery
 */
function transitionToDone(worker, workerId, io, statusNote) {
  // Guard: don't transition dismissed/stopped workers (race with dismissal)
  if (worker.status === 'stopped' || worker.status === 'completed') {
    getLogger().warn(`Skipping transitionToDone for ${workerId} — already ${worker.status}`, { workerId, status: worker.status });
    return;
  }

  // Guard: already in awaiting_review = duplicate done signal, skip
  if (worker.status === 'awaiting_review') {
    getLogger().info(`Skipping transitionToDone for ${workerId} — already awaiting_review (duplicate done signal)`, { workerId });
    return;
  }

  worker.ralphProgress = 100;
  worker.ralphStatus = 'done';
  worker.ralphSignaledAt = new Date();
  worker.status = 'awaiting_review';
  worker.awaitingReviewAt = new Date();

  emitDoneEvents(worker, workerId, io);
  deliverResultsToParent(worker, workerId, statusNote);
  startAutoDismissTimer(workerId, io);
}

/**
 * Start an auto-dismiss countdown for a worker that has signaled done.
 * After AUTO_DISMISS_DELAY_MS (5 minutes), if no new input was received,
 * the worker is automatically dismissed.
 *
 * @param {string} workerId - Worker ID
 * @param {Object} io - Socket.io instance (nullable)
 */
export function startAutoDismissTimer(workerId, io) {
  const worker = workers.get(workerId);
  if (!worker) return;

  // Don't auto-dismiss if the option is disabled
  if (worker.autoDismissAfterDone === false) {
    getLogger().info(`Auto-dismiss disabled for ${workerId} (${worker.label})`, { workerId });
    return;
  }

  // Don't auto-dismiss protected workers (GENERALs)
  if (isPersistentTier(worker)) {
    getLogger().info(`Skipping auto-dismiss for persistent-tier worker ${workerId} (${worker.label})`, { workerId });
    return;
  }

  // Cancel any existing timer
  cancelAutoDismissTimer(workerId);

  const timer = setTimeout(async () => {
    autoDismissTimers.delete(workerId);
    const w = workers.get(workerId);
    if (!w) return;

    // Only dismiss if still in awaiting_review (no new input reverted it to running)
    if (w.status !== 'awaiting_review') {
      getLogger().info(`Auto-dismiss cancelled for ${workerId} — status changed to ${w.status}`, { workerId });
      return;
    }

    getLogger().info(`Auto-dismissing worker ${workerId} (${w.label}) after done timeout`, { workerId, label: w.label });

    try {
      const { killWorker } = await import('./lifecycle.js');
      await killWorker(workerId, io);
      if (io) {
        io.emit('worker:auto-dismissed', {
          workerId,
          label: w.label,
          reason: 'Auto-dismissed after done signal (5 minute timeout)',
        });
      }
    } catch (err) {
      getLogger().warn(`Auto-dismiss failed for ${workerId}: ${err.message}`, { workerId, error: err.message });
    }
  }, AUTO_DISMISS_DELAY_MS);

  if (timer.unref) timer.unref();
  autoDismissTimers.set(workerId, timer);
  getLogger().info(`Started auto-dismiss timer for ${workerId} (${worker.label}) — ${AUTO_DISMISS_DELAY_MS / 60000}m countdown`, { workerId });
}

/**
 * Cancel an auto-dismiss timer (e.g., when the worker receives new input).
 * @param {string} workerId - Worker ID
 */
export function cancelAutoDismissTimer(workerId) {
  const timer = autoDismissTimers.get(workerId);
  if (timer) {
    clearTimeout(timer);
    autoDismissTimers.delete(workerId);
    getLogger().info(`Cancelled auto-dismiss timer for ${workerId}`, { workerId });
  }
}


/**
 * Shared auto-promotion: checks if a worker should be promoted to "done" based on
 * completion keywords in their currentStep, and if so, performs the full done-path
 * transition: status change, parent delivery, parent aggregation, socket events.
 *
 * Called from: ralph.js (on signal), health.js (periodic sweep), persistence.js (on restore).
 *
 * @param {Object} worker - The worker object (from workers Map)
 * @param {Object} io - Socket.io instance (nullable)
 * @param {string} source - Caller identifier for logging (e.g. 'signal', 'health', 'restore')
 * @returns {boolean} True if the worker was auto-promoted
 */
export function tryAutoPromoteWorker(worker, io, source = 'unknown') {
  if (!worker) return false;
  if (worker.ralphStatus !== 'in_progress') return false;
  if (worker.ralphProgress == null || worker.ralphProgress < 90) return false;
  if (!worker.ralphCurrentStep) return false;
  if (isPersistentTier(worker)) return false;
  if (!COMPLETION_RE.test(worker.ralphCurrentStep)) return false;

  const workerId = worker.id;
  getLogger().info(`Auto-promoted worker ${workerId} (${worker.label}) to done [${source}]`, { workerId, label: worker.label, source, currentStep: worker.ralphCurrentStep?.slice(0, 100) });

  transitionToDone(worker, workerId, io, 'Complete (auto-promoted)');

  // Update parent progress aggregation
  if (worker.parentWorkerId) {
    _updateParentAggregation(worker.parentWorkerId, io);
  }

  return true;
}

/**
 * Update a worker's Ralph status (called when worker signals).
 * @param {string} workerId - Worker ID
 * @param {Object} signalData - Signal data (status, progress, currentStep, learnings, outputs, artifacts, reason)
 * @param {Object} io - Socket.io instance for events
 * @returns {boolean} True if update succeeded
 */
export function updateWorkerRalphStatus(workerId, signalData, io = null) {
  const worker = workers.get(workerId);
  if (!worker) {
    getLogger().warn(`Worker ${workerId} not found for Ralph signal`, { workerId });
    return false;
  }

  // Handle both old format (status, learnings) and new format (signalData object)
  const data = typeof signalData === 'string'
    ? { status: signalData }
    : signalData;

  const { status, progress, currentStep, learnings, outputs, artifacts, reason } = data;

  // Minimal guard — route layer validates fully via validateSignalBody
  if (!status) {
    getLogger().warn(`Worker ${workerId} sent empty Ralph status`, { workerId });
    return false;
  }

  worker.ralphStatus = status;
  worker.lastActivity = new Date();

  // If worker is in awaiting_review and signals in_progress, revert to running.
  // This allows bulldoze to resume on workers that were previously done but got a new mission.
  if (status === 'in_progress' && worker.status === 'awaiting_review') {
    cancelAutoDismissTimer(workerId);
    worker.status = 'running';
    worker.awaitingReviewAt = null;
    worker._resultsDelivered = false; // Reset so results can be delivered again if worker re-completes
    getLogger().info(`Worker ${workerId} (${worker.label}) reverted from awaiting_review → running (in_progress signal)`, { workerId, label: worker.label });
  }

  // Track that this worker has manually signaled (used to prevent child aggregation
  // from overwriting manually-reported progress — see _updateParentAggregation)
  worker._ralphManuallySignaled = true;

  // Efficiency tracking — count signals, track first signal time
  worker.ralphSignalCount = (worker.ralphSignalCount || 0) + 1;
  worker.lastRalphSignalAt = new Date();
  if (!worker.firstRalphAt) {
    worker.firstRalphAt = new Date();
  }

  // Only set signaled timestamp on terminal states
  if (status === 'done' || status === 'blocked') {
    worker.ralphSignaledAt = new Date();
  }

  // Auto-suppress forced autonomy nudges on done/blocked signals
  if ((status === 'done' || status === 'blocked') && worker.forcedAutonomy) {
    console.log(`[ForcedAutonomy] Auto-suppressing nudges for ${worker.label} — worker signaled ${status}`);
    worker._forcedAutonomySuppressed = true;
  }
  // Re-enable if worker goes back to in_progress
  if (status === 'in_progress' && worker._forcedAutonomySuppressed) {
    console.log(`[ForcedAutonomy] Re-enabling nudges for ${worker.label} — worker resumed work`);
    worker._forcedAutonomySuppressed = false;
    worker._forcedAutonomyNudgeCount = 0;  // Reset backoff
  }

  // Track blocked reason (P3 fix: was never stored before)
  if (status === 'blocked') {
    worker.ralphBlockedReason = (typeof reason === 'string' ? reason.slice(0, 2000) : null);
  } else {
    // Clear blocked reason when status changes away from blocked
    worker.ralphBlockedReason = null;
  }

  // Update optional fields if provided (with size caps to prevent memory bloat)
  if (progress !== undefined) worker.ralphProgress = progress;
  if (currentStep !== undefined) {
    worker.ralphCurrentStep = typeof currentStep === 'string' ? currentStep.slice(0, 500) : String(currentStep).slice(0, 500);
  }
  if (learnings !== undefined) {
    worker.ralphLearnings = typeof learnings === 'string' ? learnings.slice(0, 10000) : String(learnings).slice(0, 10000);
  }
  if (outputs !== undefined) {
    const outputStr = typeof outputs === 'string' ? outputs : JSON.stringify(outputs);
    if (outputStr.length > 100000) {
      getLogger().warn(`Outputs field for ${workerId} truncated`, { workerId, length: outputStr.length });
    }
    if (typeof outputs === 'string') {
      worker.ralphOutputs = outputs.slice(0, 100000);
    } else if (outputs && typeof outputs === 'object') {
      // Sanitize: strip prototype-polluting keys before storing
      const DANGEROUS_KEYS = ['__proto__', 'constructor', 'prototype'];
      const sanitized = Array.isArray(outputs) ? outputs : Object.fromEntries(
        Object.entries(outputs).filter(([k]) => !DANGEROUS_KEYS.includes(k))
      );
      // P3 fix: enforce 100KB size cap on object outputs (was only capped for strings)
      const sanitizedStr = JSON.stringify(sanitized);
      if (sanitizedStr.length > 100000) {
        getLogger().warn(`Object outputs for ${workerId} exceed 100KB — rejecting`, { workerId, length: sanitizedStr.length });
        worker.ralphOutputs = { _truncated: true, _reason: `Object outputs exceeded 100KB limit (${sanitizedStr.length} chars)` };
      } else {
        worker.ralphOutputs = sanitized;
      }
    } else {
      worker.ralphOutputs = outputs;
    }
  }
  if (artifacts !== undefined) {
    if (!Array.isArray(artifacts)) {
      getLogger().warn(`Worker ${workerId} sent non-array artifacts — ignoring`, { workerId });
    } else if (artifacts.length > 100) {
      getLogger().warn(`Artifacts array for ${workerId} truncated`, { workerId, length: artifacts.length });
      worker.ralphArtifacts = artifacts.slice(0, 100);
    } else {
      worker.ralphArtifacts = artifacts;
    }
  }

  getLogger().info(`Worker ${workerId} signaled: ${status}${progress !== undefined ? ` (${progress}%)` : ''}`, { workerId, status, progress });

  // === Auto-promotion: detect workers effectively done but not signaling it ===
  let autoPromoted = false;

  // 1. Keyword-based auto-promotion (uses shared tryAutoPromoteWorker)
  if (status === 'in_progress') {
    autoPromoted = tryAutoPromoteWorker(worker, io, 'signal');
  }

  // 2. Parent self-check: worker with all children done + progress >= 80
  // Skip persistent tiers (GENERAL/COLONEL) — they manage their own lifecycle
  if (!autoPromoted && status === 'in_progress' && worker.ralphProgress >= 80 && !isPersistentTier(worker)) {
    const childIds = worker.childWorkerIds || [];
    if (childIds.length > 0) {
      const children = childIds.map(cid => workers.get(cid)).filter(Boolean);
      const allChildrenDone = children.length > 0 && children.every(c =>
        c.ralphStatus === 'done' || c.status === 'awaiting_review' || c.status === 'completed'
      );
      if (allChildrenDone) {
        autoPromoted = true;
        getLogger().info(`Auto-promoted worker ${workerId} (${worker.label}) to done (all ${children.length} children complete)`, { workerId, label: worker.label, childCount: children.length });
        transitionToDone(worker, workerId, io, `Complete (all ${children.length} children done)`);
      }
    }
  }

  // Emit update event (skip if auto-promoted or if done handler will emit below)
  const willEnterDoneHandler = (status === 'done' || autoPromoted) && worker.status !== 'awaiting_review';
  if (!autoPromoted && !willEnterDoneHandler && io) {
    io.emit('worker:updated', normalizeWorker(worker));
  }

  // On "done": transition to awaiting_review (only if not already handled by auto-promotion)
  if ((status === 'done' || autoPromoted) && worker.status !== 'awaiting_review') {
    worker.status = 'awaiting_review';
    worker.awaitingReviewAt = new Date();
    getLogger().info(`Worker ${workerId} (${worker.label}) → awaiting_review`, { workerId, label: worker.label });

    emitDoneEvents(worker, workerId, io);

    // Auto-deliver structured results to parent worker
    deliverResultsToParent(worker, workerId, 'Complete');

    // Start auto-dismiss countdown
    startAutoDismissTimer(workerId, io);
  }

  // Also notify parent worker if exists (for non-done signals)
  if (worker.parentWorkerId && status !== 'done' && !autoPromoted) {
    const parent = workers.get(worker.parentWorkerId);
    if (parent && io) {
      io.emit('worker:child:signaled', {
        parentWorkerId: worker.parentWorkerId,
        childWorkerId: workerId,
        childLabel: worker.label,
        status,
        progress: worker.ralphProgress,
        currentStep: worker.ralphCurrentStep,
        learnings: worker.ralphLearnings,
        outputs: worker.ralphOutputs
      });
    }
  }

  // Auto-update parent Ralph progress from aggregate of children's progress
  if (worker.parentWorkerId) {
    _updateParentAggregation(worker.parentWorkerId, io);
  }

  // Lazy import to avoid circular dependency (persistence → output → persistence)
  import('./persistence.js').then(({ saveWorkerState }) => {
    saveWorkerState().catch(err => getLogger().error(`State save failed after Ralph signal`, { error: err.message }));
  });
  return true;
}

/**
 * Internal helper: update parent's aggregate progress from children's progress.
 */
function _updateParentAggregation(parentWorkerId, io) {
  const parent = workers.get(parentWorkerId);
  if (!parent || !parent.childWorkerIds || parent.childWorkerIds.length === 0) return;

  const children = parent.childWorkerIds
    .map(cid => workers.get(cid))
    .filter(Boolean);
  if (children.length === 0) return;

  // Use childWorkerHistory for total count (includes dismissed children)
  const historyCount = (parent.childWorkerHistory || []).length;
  const dismissedCount = historyCount - children.filter(c => (parent.childWorkerHistory || []).includes(c.id)).length;

  let totalProgress = 0;
  let doneCount = dismissedCount; // Dismissed children count as done
  const steps = [];
  for (const child of children) {
    const cp = child.ralphProgress || 0;
    const cs = child.ralphStatus;
    if (cs === 'done' || child.status === 'awaiting_review' || child.status === 'completed') {
      totalProgress += 100;
      doneCount++;
    } else {
      totalProgress += cp;
      if (child.ralphCurrentStep) {
        steps.push(`${child.label.slice(0, 30)}: ${child.ralphCurrentStep.slice(0, 60)}`);
      }
    }
  }
  // Total includes dismissed (scored at 100%) + live children
  const totalChildren = Math.max(children.length + dismissedCount, 1);
  totalProgress += dismissedCount * 100; // Each dismissed child = 100% progress
  const avgProgress = Math.round(totalProgress / totalChildren);
  const stepSummary = doneCount === totalChildren
    ? `All ${doneCount} children complete`
    : `${doneCount}/${totalChildren} done` + (steps.length > 0 ? ` | ${steps[0]}` : '');

  // Only auto-update if parent hasn't manually signaled, OR if aggregate is higher.
  if (parent._ralphManuallySignaled) {
    // Parent has manually signaled — only update if aggregate is higher
    if (avgProgress > (parent.ralphProgress || 0)) {
      parent.ralphProgress = avgProgress;
      parent.ralphCurrentStep = stepSummary.slice(0, 500);
      if (io) {
        io.emit('worker:updated', normalizeWorker(parent));
      }
    }
  } else {
    // No manual signal — child-driven updates take full control
    parent.ralphProgress = avgProgress;
    parent.ralphCurrentStep = stepSummary.slice(0, 500);
    if (io) {
      io.emit('worker:updated', normalizeWorker(parent));
    }
  }

  // Auto-promote parent to done when ALL children are done and parent is at >= 80%
  // Skip persistent tiers (GENERAL/COLONEL) — they manage their own lifecycle
  if (doneCount === totalChildren && parent.ralphStatus !== 'done' &&
      parent.status !== 'awaiting_review' && !isPersistentTier(parent) &&
      (parent.ralphProgress >= 80 || avgProgress >= 100)) {
    getLogger().info(`Auto-promoted parent ${parentWorkerId} (${parent.label}) to done (all ${totalChildren} children complete, ${dismissedCount} dismissed)`, { parentWorkerId, label: parent.label, childCount: totalChildren });
    transitionToDone(parent, parentWorkerId, io, `Complete (auto-promoted — all children done)`);
  }
}
