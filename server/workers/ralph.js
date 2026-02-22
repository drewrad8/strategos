/**
 * Ralph status updates: signal handling, auto-promotion, parent aggregation.
 * Called when workers signal progress via the Ralph protocol.
 */

import {
  workers, outputBuffers, pendingWorkers, inFlightSpawns,
  STRATEGOS_API, MAX_CONCURRENT_WORKERS,
  path, normalizeWorker,
  respawnSuggestions,
  CHECKPOINT_DIR, readFileSync, existsSync,
} from './state.js';

import { isProtectedWorker } from './templates.js';
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

  worker.ralphProgress = 100;
  worker.ralphStatus = 'done';
  worker.ralphSignaledAt = new Date();
  worker.status = 'awaiting_review';
  worker.awaitingReviewAt = new Date();

  if (io) {
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

  // Deliver results to parent worker
  if (worker.parentWorkerId) {
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
      `Status: Complete (auto-promoted). Worker is alive for follow-up questions.`,
      `To dismiss: curl -s -X POST ${STRATEGOS_API}/api/workers/${workerId}/dismiss`,
    ].filter(Boolean).join('\n');

    sendInputDirect(worker.parentWorkerId, resultSummary).catch(e => {
      getLogger().warn(`Could not deliver auto-promoted results to parent ${worker.parentWorkerId}`, { workerId, parentWorkerId: worker.parentWorkerId, error: e.message });
    });
  }

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

  // Validate status — only known values are accepted
  const VALID_STATUSES = ['in_progress', 'done', 'blocked', 'pending'];
  if (!status || !VALID_STATUSES.includes(status)) {
    getLogger().warn(`Worker ${workerId} sent invalid Ralph status`, { workerId, status });
    return false;
  }

  // Validate progress range if provided
  if (progress !== undefined && (typeof progress !== 'number' || progress < 0 || progress > 100)) {
    getLogger().warn(`Worker ${workerId} sent invalid Ralph progress`, { workerId, progress });
    return false;
  }

  // Validate currentStep type if provided
  if (currentStep !== undefined && typeof currentStep !== 'string') {
    getLogger().warn(`Worker ${workerId} sent non-string Ralph currentStep`, { workerId });
    return false;
  }

  worker.ralphStatus = status;
  worker.lastActivity = new Date();

  // If worker is in awaiting_review and signals in_progress, revert to running.
  // This allows bulldoze to resume on workers that were previously done but got a new mission.
  if (status === 'in_progress' && worker.status === 'awaiting_review') {
    worker.status = 'running';
    worker.awaitingReviewAt = null;
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
        worker.ralphProgress = 100;
        worker.ralphStatus = 'done';
        worker.ralphSignaledAt = new Date();
        autoPromoted = true;
        getLogger().info(`Auto-promoted worker ${workerId} (${worker.label}) to done (all ${children.length} children complete)`, { workerId, label: worker.label, childCount: children.length });
      }
    }
  }

  // Emit update event (skip if auto-promoted or if done handler will emit below)
  const willEnterDoneHandler = (status === 'done' || autoPromoted) && worker.status !== 'awaiting_review';
  if (!autoPromoted && !willEnterDoneHandler && io) {
    io.emit('worker:updated', normalizeWorker(worker));
  }

  // On "done": transition to awaiting_review (only if not already handled by tryAutoPromoteWorker)
  if ((status === 'done' || autoPromoted) && worker.status !== 'awaiting_review') {
    worker.status = 'awaiting_review';
    worker.awaitingReviewAt = new Date();
    getLogger().info(`Worker ${workerId} (${worker.label}) → awaiting_review`, { workerId, label: worker.label });

    if (io) {
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

    // Auto-deliver structured results to parent worker
    if (worker.parentWorkerId) {
      // Include delegation metrics summary for generals
      const dm = worker.delegationMetrics;
      const delegationLine = dm
        ? `Delegation: spawned ${dm.spawnsIssued} workers, ${dm.roleViolations} role violations, ${dm.filesEdited} files edited, ${dm.commandsRun} commands run`
        : null;

      const resultSummary = [
        `[RESULTS FROM ${worker.label} (${workerId})]`,
        learnings ? `Learnings: ${learnings}` : null,
        outputs ? `Outputs: ${typeof outputs === 'string' ? outputs : JSON.stringify(outputs)}` : null,
        artifacts ? `Artifacts: ${Array.isArray(artifacts) ? artifacts.join(', ') : artifacts}` : null,
        delegationLine,
        `Status: Complete. Worker is alive for follow-up questions.`,
        `To dismiss: curl -s -X POST ${STRATEGOS_API}/api/workers/${workerId}/dismiss`
      ].filter(Boolean).join('\n');

      sendInputDirect(worker.parentWorkerId, resultSummary).catch(e => {
        getLogger().warn(`Could not deliver results to parent ${worker.parentWorkerId}`, { workerId, parentWorkerId: worker.parentWorkerId, error: e.message });
      });
    }
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
 * Extracted to avoid duplication between signal handler and tryAutoPromoteWorker.
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
  // If the parent has directly signaled via updateWorkerRalphStatus, _ralphManuallySignaled
  // is true — in that case, child aggregate should never DOWNGRADE parent progress.
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
    parent.ralphProgress = 100;
    parent.ralphStatus = 'done';
    parent.ralphSignaledAt = new Date();
    parent.status = 'awaiting_review';
    parent.awaitingReviewAt = new Date();
    getLogger().info(`Auto-promoted parent ${parentWorkerId} (${parent.label}) to done (all ${totalChildren} children complete, ${dismissedCount} dismissed)`, { parentWorkerId, label: parent.label, childCount: totalChildren });
    if (io) {
      io.emit('worker:updated', normalizeWorker(parent));
      io.emit('worker:awaiting_review', {
        workerId: parentWorkerId,
        label: parent.label,
        learnings: parent.ralphLearnings,
        outputs: parent.ralphOutputs,
        artifacts: parent.ralphArtifacts,
        parentWorkerId: parent.parentWorkerId
      });
    }
    // Deliver results to grandparent if exists
    if (parent.parentWorkerId) {
      const resultSummary = [
        `[RESULTS FROM ${parent.label} (${parentWorkerId})]`,
        parent.ralphLearnings ? `Learnings: ${parent.ralphLearnings}` : null,
        parent.ralphOutputs ? `Outputs: ${typeof parent.ralphOutputs === 'string' ? parent.ralphOutputs : JSON.stringify(parent.ralphOutputs)}` : null,
        `Status: Complete (auto-promoted — all children done). Worker is alive for follow-up.`,
        `To dismiss: curl -s -X POST ${STRATEGOS_API}/api/workers/${parentWorkerId}/dismiss`
      ].filter(Boolean).join('\n');
      sendInputDirect(parent.parentWorkerId, resultSummary).catch(e => {
        getLogger().warn(`Could not deliver auto-promoted results to grandparent ${parent.parentWorkerId}`, { parentWorkerId, grandparentWorkerId: parent.parentWorkerId, error: e.message });
      });
    }
  }
}

// ============================================
// GETTER FUNCTIONS (read-only views of worker state)
// ============================================

let _cachedWorkers = null;
let _cacheTime = 0;
const CACHE_TTL_MS = 1000;

export function getWorkers() {
  const now = Date.now();
  if (_cachedWorkers && (now - _cacheTime < CACHE_TTL_MS)) {
    return _cachedWorkers;
  }
  const active = Array.from(workers.values()).map(normalizeWorker);
  const pending = getPendingWorkers();
  _cachedWorkers = [...active, ...pending];
  _cacheTime = now;
  return _cachedWorkers;
}

export function getWorker(workerId) {
  const worker = workers.get(workerId);
  if (worker) return normalizeWorker(worker);
  const pending = pendingWorkers.get(workerId);
  if (pending) {
    return {
      id: workerId,
      label: pending.label,
      project: path.basename(pending.projectPath),
      workingDir: pending.projectPath,
      status: 'pending',
      dependsOn: pending.dependsOn,
      workflowId: pending.workflowId,
      taskId: pending.taskId,
      createdAt: pending.createdAt ? new Date(pending.createdAt).toISOString() : null,
    };
  }
  return null;
}

/**
 * Get raw worker with internal fields (ralphToken etc.) — for server-side use only.
 * NEVER send this to clients.
 */
export function getWorkerInternal(workerId) {
  const worker = workers.get(workerId);
  if (!worker) return null;
  return {
    ...worker,
    childWorkerIds: [...(worker.childWorkerIds || [])],
    childWorkerHistory: [...(worker.childWorkerHistory || [])],
    dependsOn: [...(worker.dependsOn || [])],
    settings: worker.settings ? { ...worker.settings } : {},
  };
}

export function getWorkersByProject(projectName) {
  return getWorkers().filter(w => w.project === projectName);
}

export function getWorkerOutput(workerId) {
  return outputBuffers.get(workerId) || '';
}

export function getChildWorkers(parentWorkerId) {
  const parent = workers.get(parentWorkerId);
  if (!parent) return [];

  const childIds = parent.childWorkerIds || [];
  const liveChildren = childIds.map(childId => {
    const child = workers.get(childId);
    if (!child) return null;
    return {
      id: child.id,
      label: child.label,
      status: child.status,
      ralphMode: child.ralphMode,
      ralphStatus: child.ralphStatus,
      ralphSignaledAt: child.ralphSignaledAt,
      ralphLearnings: child.ralphLearnings,
      ralphProgress: child.ralphProgress,
      ralphCurrentStep: child.ralphCurrentStep,
      ralphOutputs: child.ralphOutputs,
      ralphArtifacts: child.ralphArtifacts,
      taskDescription: child.task?.description?.substring(0, 200) || null,
      createdAt: child.createdAt,
      lastActivity: child.lastActivity,
      durationMs: Math.max(0, Date.now() - new Date(child.createdAt).getTime()) || 0,
      health: child.health,
    };
  }).filter(Boolean);

  // Include historical children from checkpoints (dismissed/killed)
  const historyIds = parent.childWorkerHistory || [];
  const liveIdSet = new Set(childIds);
  const historicalChildren = historyIds
    .filter(hid => !liveIdSet.has(hid)) // Only those no longer live
    .map(hid => {
      try {
        const checkpointPath = path.join(CHECKPOINT_DIR, `${hid}.json`);
        if (!existsSync(checkpointPath)) return null;
        const checkpoint = JSON.parse(readFileSync(checkpointPath, 'utf-8'));
        return {
          id: checkpoint.workerId,
          label: checkpoint.label || hid,
          status: 'dismissed',
          ralphMode: true,
          ralphStatus: checkpoint.ralphStatus || 'done',
          ralphSignaledAt: checkpoint.diedAt || null,
          ralphLearnings: checkpoint.ralphLearnings || null,
          ralphProgress: checkpoint.ralphProgress ?? 100,
          ralphCurrentStep: checkpoint.ralphCurrentStep || 'Dismissed',
          ralphOutputs: checkpoint.ralphOutputs || null,
          ralphArtifacts: checkpoint.ralphArtifacts || null,
          taskDescription: checkpoint.task?.description?.substring(0, 200) || null,
          createdAt: checkpoint.createdAt || null,
          lastActivity: checkpoint.diedAt || null,
          durationMs: checkpoint.uptime || 0,
          health: 'dismissed',
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  return [...liveChildren, ...historicalChildren];
}

export function getSiblingWorkers(workerId) {
  const worker = workers.get(workerId);
  if (!worker || !worker.parentWorkerId) return [];

  const parent = workers.get(worker.parentWorkerId);
  if (!parent) return [];

  const siblingIds = (parent.childWorkerIds || []).filter(id => id !== workerId);
  return siblingIds.map(siblingId => {
    const sibling = workers.get(siblingId);
    if (!sibling) return null;
    return {
      id: sibling.id,
      label: sibling.label,
      status: sibling.status,
      ralphStatus: sibling.ralphStatus,
      ralphProgress: sibling.ralphProgress,
      ralphCurrentStep: sibling.ralphCurrentStep,
      taskDescription: sibling.task?.description?.substring(0, 100) || null,
    };
  }).filter(Boolean);
}

export function getPendingWorkers() {
  return Array.from(pendingWorkers.entries()).map(([id, pending]) => ({
    id,
    label: pending.label,
    project: path.basename(pending.projectPath),
    workingDir: pending.projectPath,
    status: 'pending',
    dependsOn: pending.dependsOn,
    workflowId: pending.workflowId,
    taskId: pending.taskId,
    createdAt: pending.createdAt ? new Date(pending.createdAt).toISOString() : null,
    waitTimeMs: pending.createdAt ? Date.now() - pending.createdAt : null
  }));
}

export function getResourceStats() {
  const allWorkers = Array.from(workers.values());
  const running = allWorkers.filter(w => w.status === 'running').length;
  const completed = allWorkers.filter(w => w.status === 'completed').length;
  const error = allWorkers.filter(w => w.status === 'error').length;
  const pending = pendingWorkers.size;
  const spawning = inFlightSpawns.size;

  return {
    running,
    completed,
    error,
    pending,
    spawning,
    total: allWorkers.length + pending,
    maxConcurrent: MAX_CONCURRENT_WORKERS,
    availableSlots: Math.max(0, MAX_CONCURRENT_WORKERS - running - pending - spawning)
  };
}

export function getRespawnSuggestions() {
  return [...respawnSuggestions];
}

export function removeRespawnSuggestion(workerId) {
  const idx = respawnSuggestions.findIndex(s => s.workerId === workerId);
  if (idx === -1) return false;
  respawnSuggestions.splice(idx, 1);
  return true;
}

export function getWorkerEfficiency() {
  return Array.from(workers.values())
    .filter(w => w.status === 'running')
    .map(w => ({
      id: w.id,
      label: w.label,
      spawnedAt: w.createdAt,
      firstRalphAt: w.firstRalphAt || null,
      timeToFirstRalph: w.firstRalphAt ? (Math.max(0, new Date(w.firstRalphAt).getTime() - new Date(w.createdAt).getTime()) || 0) : null,
      ralphSignalCount: w.ralphSignalCount || 0,
      ralphStatus: w.ralphStatus || null,
      uptime: Math.max(0, Date.now() - new Date(w.createdAt).getTime()) || 0,
    }));
}

// ============================================
// DELEGATION METRICS (for tracking general behavior)
// ============================================

const VALID_DELEGATION_FIELDS = ['roleViolations', 'filesEdited', 'commandsRun'];

/**
 * Increment a delegation metric for a worker.
 * Called by sentinel role-violation detection to record general misbehavior.
 * @param {string} workerId - Worker ID
 * @param {string} field - One of: roleViolations, filesEdited, commandsRun
 * @param {number} [amount=1] - Amount to increment by
 * @returns {boolean} True if metric was incremented
 */
export function incrementDelegationMetric(workerId, field, amount = 1) {
  if (!VALID_DELEGATION_FIELDS.includes(field)) {
    getLogger().warn(`Invalid delegation metric field: ${field}`, { workerId, field });
    return false;
  }
  const worker = workers.get(workerId);
  if (!worker) return false;
  if (!worker.delegationMetrics) {
    worker.delegationMetrics = { spawnsIssued: 0, roleViolations: 0, filesEdited: 0, commandsRun: 0 };
  }
  worker.delegationMetrics[field] += amount;
  getLogger().info(`Delegation metric ${field} incremented for ${workerId} (${worker.label}): now ${worker.delegationMetrics[field]}`, { workerId, field, value: worker.delegationMetrics[field] });
  return true;
}

/**
 * Get delegation metrics for a worker.
 * Returns null if worker not found.
 */
export function getDelegationMetrics(workerId) {
  const worker = workers.get(workerId);
  if (!worker) return null;
  const metrics = worker.delegationMetrics || { spawnsIssued: 0, roleViolations: 0, filesEdited: 0, commandsRun: 0 };
  const upperLabel = (worker.label || '').toUpperCase();
  const isGeneral = upperLabel.startsWith('GENERAL:') || upperLabel.startsWith('GENERAL ');
  return {
    workerId,
    label: worker.label,
    isGeneral,
    metrics: { ...metrics },
    status: worker.status,
    ralphStatus: worker.ralphStatus,
    childCount: (worker.childWorkerIds || []).length,
  };
}
