/**
 * Ralph status updates: signal handling, auto-promotion, parent aggregation.
 * Called when workers signal progress via the Ralph protocol.
 */

import {
  workers, outputBuffers, pendingWorkers, inFlightSpawns,
  STRATEGOS_API, MAX_CONCURRENT_WORKERS,
  path, normalizeWorker,
  respawnSuggestions,
} from './state.js';

import { isProtectedWorker } from './templates.js';
import { sendInputDirect } from './output.js';

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
    console.log(`[RalphStatus] Worker ${workerId} not found`);
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
    console.warn(`[RalphStatus] Worker ${workerId} sent invalid status: ${JSON.stringify(status)}`);
    return false;
  }

  // Validate progress range if provided
  if (progress !== undefined && (typeof progress !== 'number' || progress < 0 || progress > 100)) {
    console.warn(`[RalphStatus] Worker ${workerId} sent invalid progress: ${JSON.stringify(progress)}`);
    return false;
  }

  // Validate currentStep type if provided
  if (currentStep !== undefined && typeof currentStep !== 'string') {
    console.warn(`[RalphStatus] Worker ${workerId} sent non-string currentStep`);
    return false;
  }

  worker.ralphStatus = status;
  worker.lastActivity = new Date();

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
      console.warn(`[RalphStatus] Outputs field for ${workerId} truncated (${outputStr.length} chars)`);
    }
    if (typeof outputs === 'string') {
      worker.ralphOutputs = outputs.slice(0, 100000);
    } else if (outputs && typeof outputs === 'object') {
      // Sanitize: strip prototype-polluting keys before storing
      const DANGEROUS_KEYS = ['__proto__', 'constructor', 'prototype'];
      const sanitized = Array.isArray(outputs) ? outputs : Object.fromEntries(
        Object.entries(outputs).filter(([k]) => !DANGEROUS_KEYS.includes(k))
      );
      worker.ralphOutputs = sanitized;
    } else {
      worker.ralphOutputs = outputs;
    }
  }
  if (artifacts !== undefined) {
    if (!Array.isArray(artifacts)) {
      console.warn(`[RalphStatus] Worker ${workerId} sent non-array artifacts — ignoring`);
    } else if (artifacts.length > 100) {
      console.warn(`[RalphStatus] Artifacts array for ${workerId} truncated (${artifacts.length} items)`);
      worker.ralphArtifacts = artifacts.slice(0, 100);
    } else {
      worker.ralphArtifacts = artifacts;
    }
  }

  console.log(`[RalphStatus] Worker ${workerId} signaled: ${status}${progress !== undefined ? ` (${progress}%)` : ''}`);

  // === Auto-promotion: detect workers effectively done but not signaling it ===
  let autoPromoted = false;

  // Persistent tiers (GENERAL, COLONEL) should NOT be auto-promoted based on completion keywords
  const upperLabel = (worker.label || '').toUpperCase();
  const isPersistentTier = upperLabel.startsWith('GENERAL:') || upperLabel.startsWith('GENERAL ') ||
    upperLabel.startsWith('COLONEL:') || upperLabel.startsWith('COL-') || upperLabel.startsWith('COL:');

  // 1. Keyword-based: worker at >= 90% with completion phrases in currentStep
  if (!isPersistentTier && status === 'in_progress' && worker.ralphProgress >= 90 && worker.ralphCurrentStep) {
    const COMPLETION_RE = /\b(complete[d]?|done|finished|awaiting\s+(?:orders|further)|ready\s+for\s+next|all\b.*\bpassing)\b/i;
    if (COMPLETION_RE.test(worker.ralphCurrentStep)) {
      worker.ralphProgress = 100;
      worker.ralphStatus = 'done';
      worker.ralphSignaledAt = new Date();
      autoPromoted = true;
      console.log(`[RalphStatus] Auto-promoted worker ${workerId} (${worker.label}) to done (completion keywords detected in: "${worker.ralphCurrentStep.slice(0, 100)}")`);
    }
  }

  // 2. Parent self-check: worker with all children done + progress >= 80
  if (!autoPromoted && status === 'in_progress' && worker.ralphProgress >= 80) {
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
        console.log(`[RalphStatus] Auto-promoted worker ${workerId} (${worker.label}) to done (all ${children.length} children complete)`);
      }
    }
  }

  // Emit update event
  if (io) {
    io.emit('worker:updated', normalizeWorker(worker));
  }

  // On "done": transition to awaiting_review
  if (status === 'done' || autoPromoted) {
    worker.status = 'awaiting_review';
    worker.awaitingReviewAt = new Date();
    console.log(`[RalphStatus] Worker ${workerId} (${worker.label}) → awaiting_review`);

    if (io) {
      io.emit('worker:awaiting_review', {
        workerId,
        label: worker.label,
        learnings: worker.ralphLearnings,
        outputs: worker.ralphOutputs,
        artifacts: worker.ralphArtifacts,
        parentWorkerId: worker.parentWorkerId
      });
    }

    // Auto-deliver structured results to parent worker
    if (worker.parentWorkerId) {
      const resultSummary = [
        `[RESULTS FROM ${worker.label} (${workerId})]`,
        learnings ? `Learnings: ${learnings}` : null,
        outputs ? `Outputs: ${typeof outputs === 'string' ? outputs : JSON.stringify(outputs)}` : null,
        artifacts ? `Artifacts: ${Array.isArray(artifacts) ? artifacts.join(', ') : artifacts}` : null,
        `Status: Complete. Worker is alive for follow-up questions.`,
        `To dismiss: curl -s -X POST ${STRATEGOS_API}/api/workers/${workerId}/dismiss`
      ].filter(Boolean).join('\n');

      sendInputDirect(worker.parentWorkerId, resultSummary).catch(e => {
        console.warn(`[RalphStatus] Could not deliver results to parent ${worker.parentWorkerId}: ${e.message}`);
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
    const parent = workers.get(worker.parentWorkerId);
    if (parent && parent.childWorkerIds && parent.childWorkerIds.length > 0) {
      const children = parent.childWorkerIds
        .map(cid => workers.get(cid))
        .filter(Boolean);
      if (children.length > 0) {
        let totalProgress = 0;
        let doneCount = 0;
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
        const avgProgress = Math.round(totalProgress / children.length);
        const stepSummary = doneCount === children.length
          ? `All ${doneCount} children complete`
          : `${doneCount}/${children.length} done` + (steps.length > 0 ? ` | ${steps[0]}` : '');

        // Only auto-update if parent hasn't manually signaled recently (within 30s)
        const parentLastSignal = parent.lastRalphSignalAt ? new Date(parent.lastRalphSignalAt).getTime() : 0;
        const childDriven = !parentLastSignal || (Date.now() - parentLastSignal > 30000);
        if (childDriven) {
          parent.ralphProgress = avgProgress;
          parent.ralphCurrentStep = stepSummary.slice(0, 500);
          if (io) {
            io.emit('worker:updated', normalizeWorker(parent));
          }
        }

        // Auto-promote parent to done when ALL children are done and parent is at >= 80%
        if (doneCount === children.length && parent.ralphStatus !== 'done' &&
            parent.status !== 'awaiting_review' && (parent.ralphProgress >= 80 || avgProgress >= 100)) {
          parent.ralphProgress = 100;
          parent.ralphStatus = 'done';
          parent.ralphSignaledAt = new Date();
          parent.status = 'awaiting_review';
          parent.awaitingReviewAt = new Date();
          console.log(`[RalphStatus] Auto-promoted parent ${worker.parentWorkerId} (${parent.label}) to done (all ${children.length} children complete)`);
          if (io) {
            io.emit('worker:updated', normalizeWorker(parent));
            io.emit('worker:awaiting_review', {
              workerId: worker.parentWorkerId,
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
              `[RESULTS FROM ${parent.label} (${worker.parentWorkerId})]`,
              parent.ralphLearnings ? `Learnings: ${parent.ralphLearnings}` : null,
              parent.ralphOutputs ? `Outputs: ${typeof parent.ralphOutputs === 'string' ? parent.ralphOutputs : JSON.stringify(parent.ralphOutputs)}` : null,
              `Status: Complete (auto-promoted — all children done). Worker is alive for follow-up.`,
              `To dismiss: curl -s -X POST ${STRATEGOS_API}/api/workers/${worker.parentWorkerId}/dismiss`
            ].filter(Boolean).join('\n');
            sendInputDirect(parent.parentWorkerId, resultSummary).catch(e => {
              console.warn(`[RalphStatus] Could not deliver auto-promoted results to grandparent ${parent.parentWorkerId}: ${e.message}`);
            });
          }
        }
      }
    }
  }

  // Lazy import to avoid circular dependency (persistence → output → persistence)
  import('./persistence.js').then(({ saveWorkerState }) => {
    saveWorkerState().catch(err => console.error(`[SignalProgress] State save failed: ${err.message}`));
  });
  return true;
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
  return childIds.map(childId => {
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
