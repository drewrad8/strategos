/**
 * Worker query functions — read-only views of worker state.
 * Extracted from ralph.js to separate concerns.
 */

import {
  workers, outputBuffers, pendingWorkers, inFlightSpawns,
  MAX_CONCURRENT_WORKERS,
  path, normalizeWorker,
  respawnSuggestions,
  CHECKPOINT_DIR, readFileSync, existsSync,
} from './state.js';

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
