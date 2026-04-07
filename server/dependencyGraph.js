/**
 * Dependency Graph - Manages task dependencies and execution ordering
 *
 * Features:
 * - Track dependencies between workers
 * - Detect circular dependencies before they cause issues
 * - Determine which workers can be executed (dependencies satisfied)
 * - Track worker completion status for dependency resolution
 */

// ============================================
// STATE
// ============================================

// Map of workerId -> DependencyNode
const dependencyNodes = new Map();

// Map of workerId -> array of workerIds that depend on this worker
const dependents = new Map();

/**
 * @typedef {Object} DependencyNode
 * @property {string} workerId - The worker ID
 * @property {string[]} dependsOn - Array of worker IDs this worker depends on
 * @property {Object|null} onComplete - Action to trigger when worker completes
 * @property {'pending'|'waiting'|'ready'|'running'|'completed'|'failed'} status
 * @property {Date|null} completedAt
 */

/**
 * @typedef {Object} OnCompleteAction
 * @property {'spawn'|'webhook'|'emit'} type
 * @property {Object} config - Type-specific configuration
 */

// ============================================
// CIRCULAR DEPENDENCY DETECTION
// ============================================

/**
 * Detect if adding a dependency would create a cycle
 * Uses DFS to check for back edges
 *
 * @param {string} fromId - Worker that would depend on another
 * @param {string} toId - Worker being depended on
 * @returns {{hasCycle: boolean, path: string[]}}
 */
export function detectCycle(fromId, toId) {
  // Build adjacency list including the proposed edge
  const adjList = new Map();

  // Add existing edges
  for (const [workerId, node] of dependencyNodes) {
    if (!adjList.has(workerId)) {
      adjList.set(workerId, new Set());
    }
    for (const depId of node.dependsOn) {
      adjList.get(workerId).add(depId);
    }
  }

  // Add the proposed edge
  if (!adjList.has(fromId)) {
    adjList.set(fromId, new Set());
  }
  adjList.get(fromId).add(toId);

  // DFS to find cycle
  const visited = new Set();
  const recStack = new Set();
  const path = [];

  function dfs(node) {
    visited.add(node);
    recStack.add(node);
    path.push(node);

    const neighbors = adjList.get(node) || new Set();
    for (const neighbor of neighbors) {
      if (!visited.has(neighbor)) {
        const result = dfs(neighbor);
        if (result) return result;
      } else if (recStack.has(neighbor)) {
        // Found cycle - extract the cycle path
        const cycleStart = path.indexOf(neighbor);
        const cyclePath = path.slice(cycleStart);
        cyclePath.push(neighbor); // Complete the cycle
        return cyclePath;
      }
    }

    path.pop();
    recStack.delete(node);
    return null;
  }

  // Check from the node that would create the dependency
  const cyclePath = dfs(fromId);

  return {
    hasCycle: cyclePath !== null,
    path: cyclePath || []
  };
}

// ============================================
// DEPENDENCY NODE MANAGEMENT
// ============================================

/**
 * Register a worker with dependencies
 * @param {string} workerId
 * @param {string[]} dependsOn - Array of worker IDs to wait for
 * @param {Object|null} onComplete - Action to trigger on completion
 * @returns {{success: boolean, error?: string, node?: DependencyNode}}
 */
export function registerWorkerDependencies(workerId, dependsOn = [], onComplete = null) {
  // Reject self-dependencies and deduplicate
  const filteredDeps = [...new Set(dependsOn.filter(depId => depId !== workerId))];
  if (filteredDeps.length !== dependsOn.length) {
    console.warn(`[DependencyGraph] Self-dependency or duplicate removed for worker ${workerId}`);
  }

  // If already registered, clean up old registration first to prevent duplicate dependents
  if (dependencyNodes.has(workerId)) {
    removeWorkerDependencies(workerId);
  }

  // Check for circular dependencies
  for (const depId of filteredDeps) {
    const cycleCheck = detectCycle(workerId, depId);
    if (cycleCheck.hasCycle) {
      return {
        success: false,
        error: `Circular dependency detected: ${cycleCheck.path.join(' -> ')}`
      };
    }
  }

  // Validate that all dependency IDs actually exist in the graph.
  // Non-existent deps create permanent deadlocks (waiting forever for something that will never complete).
  // Treat missing deps as already-completed (they may have been cleaned up after finishing).
  const validDeps = [];
  for (const depId of filteredDeps) {
    if (!dependencyNodes.has(depId)) {
      console.warn(`[DependencyGraph] Worker ${workerId} depends on unknown worker ${depId} — treating as completed (may have been cleaned up)`);
    } else {
      validDeps.push(depId);
    }
  }

  // Determine initial status
  let status = 'pending';
  if (validDeps.length === 0) {
    status = 'ready';
  } else {
    // Check if all dependencies are already completed
    const allComplete = validDeps.every(depId => {
      const depNode = dependencyNodes.get(depId);
      return depNode && depNode.status === 'completed';
    });
    status = allComplete ? 'ready' : 'waiting';
  }

  const node = {
    workerId,
    dependsOn: validDeps,
    onComplete,
    status,
    completedAt: null
  };

  dependencyNodes.set(workerId, node);

  // Register this worker as a dependent of its dependencies
  for (const depId of validDeps) {
    if (!dependents.has(depId)) {
      dependents.set(depId, []);
    }
    dependents.get(depId).push(workerId);
  }

  return { success: true, node };
}

/**
 * Mark a worker as started (running)
 * @param {string} workerId
 */
export function markWorkerStarted(workerId) {
  const node = dependencyNodes.get(workerId);
  if (node && (node.status === 'ready' || node.status === 'pending')) {
    node.status = 'running';
  }
}

/**
 * Mark a worker as completed and check for triggered actions
 * @param {string} workerId
 * @returns {{triggeredWorkers: string[], onCompleteAction: Object|null}}
 */
export function markWorkerCompleted(workerId) {
  const node = dependencyNodes.get(workerId);
  if (!node) {
    return { triggeredWorkers: [], onCompleteAction: null };
  }

  // Idempotent: if already completed, don't re-trigger dependents/onComplete
  if (node.status === 'completed') {
    return { triggeredWorkers: [], onCompleteAction: null };
  }

  node.status = 'completed';
  node.completedAt = new Date();

  // Find workers waiting on this one
  const waitingWorkers = dependents.get(workerId) || [];
  const nowReady = [];

  for (const waitingId of waitingWorkers) {
    const waitingNode = dependencyNodes.get(waitingId);
    if (!waitingNode || waitingNode.status !== 'waiting') continue;

    // Check if all dependencies are now complete
    // Treat missing deps (cleaned up) as completed — consistent with registerWorkerDependencies
    // which treats unknown deps as completed at registration time (line 162-166)
    const allComplete = waitingNode.dependsOn.every(depId => {
      const depNode = dependencyNodes.get(depId);
      return !depNode || depNode.status === 'completed';
    });

    if (allComplete) {
      waitingNode.status = 'ready';
      nowReady.push(waitingId);
    }
  }

  return {
    triggeredWorkers: nowReady,
    onCompleteAction: node.onComplete
  };
}

/**
 * Mark a worker as failed
 * @param {string} workerId
 */
export function markWorkerFailed(workerId) {
  const allFailedDependents = [];
  const node = dependencyNodes.get(workerId);
  if (!node) return allFailedDependents;

  // Don't regress a completed node to failed — this happens when auto-cleanup
  // kills a worker after it already completed (completeWorker→killWorker→markWorkerFailed)
  if (node.status === 'completed' || node.status === 'failed') {
    return allFailedDependents;
  }

  node.status = 'failed';
  node.completedAt = new Date();

  // Recursively cascade failure to dependents (BFS)
  const queue = [workerId];
  const visited = new Set([workerId]);

  while (queue.length > 0) {
    const currentId = queue.shift();
    const waitingWorkers = dependents.get(currentId) || [];

    for (const waitingId of waitingWorkers) {
      if (visited.has(waitingId)) continue;
      visited.add(waitingId);

      const waitingNode = dependencyNodes.get(waitingId);
      if (waitingNode && waitingNode.status !== 'completed' && waitingNode.status !== 'failed') {
        waitingNode.status = 'failed';
        waitingNode.completedAt = new Date();
        allFailedDependents.push(waitingId);
        // Continue cascading from this newly failed node
        queue.push(waitingId);
      }
    }
  }

  return allFailedDependents;
}

/**
 * Remove a worker from the dependency graph
 * @param {string} workerId
 */
export function removeWorkerDependencies(workerId) {
  const node = dependencyNodes.get(workerId);
  if (!node) return;

  // Remove from dependents lists — delete empty arrays to prevent memory leak
  for (const depId of node.dependsOn) {
    const depList = dependents.get(depId);
    if (depList) {
      const idx = depList.indexOf(workerId);
      if (idx !== -1) depList.splice(idx, 1);
      if (depList.length === 0) dependents.delete(depId);
    }
  }

  dependencyNodes.delete(workerId);
  dependents.delete(workerId);
}

// ============================================
// QUERIES
// ============================================

/**
 * Get dependency info for a worker
 * @param {string} workerId
 * @returns {Object|null}
 */
export function getWorkerDependencies(workerId) {
  const node = dependencyNodes.get(workerId);
  if (!node) return null;

  // Get detailed status of each dependency
  const dependencies = node.dependsOn.map(depId => {
    const depNode = dependencyNodes.get(depId);
    return {
      workerId: depId,
      status: depNode ? depNode.status : 'unknown',
      completedAt: depNode?.completedAt || null
    };
  });

  // Get workers that depend on this one
  const dependentWorkers = (dependents.get(workerId) || []).map(depId => {
    const depNode = dependencyNodes.get(depId);
    return {
      workerId: depId,
      status: depNode ? depNode.status : 'unknown'
    };
  });

  return {
    workerId,
    status: node.status,
    dependencies,
    dependents: dependentWorkers,
    onComplete: node.onComplete,
    completedAt: node.completedAt
  };
}

/**
 * Check if a worker can start (all dependencies satisfied)
 * @param {string} workerId
 * @returns {boolean}
 */
export function canWorkerStart(workerId) {
  const node = dependencyNodes.get(workerId);
  if (!node) return true; // No dependencies registered
  return node.status === 'ready' || node.status === 'running' || node.status === 'completed';
}

// ============================================
// STATISTICS
// ============================================

/**
 * Clean up completed/failed dependency nodes to prevent unbounded memory growth.
 * Called every 60s by startPeriodicCleanup() in health.js.
 * @param {number} maxAgeMs - Max age for completed/failed nodes (default 1 hour)
 * @returns {{workflowsCleaned: number, nodesCleaned: number}}
 */
export function cleanupFinishedWorkflows(maxAgeMs = 60 * 60 * 1000) {
  const now = Date.now();
  let nodesCleaned = 0;

  // Snapshot keys before iterating — removeWorkerDependencies mutates dependencyNodes
  const nodeIds = Array.from(dependencyNodes.keys());
  for (const workerId of nodeIds) {
    const node = dependencyNodes.get(workerId);
    if (!node) continue; // Already removed
    if (node.status !== 'completed' && node.status !== 'failed') continue;
    if (node.completedAt && now - node.completedAt.getTime() < maxAgeMs) continue;

    // Only remove if no other nodes still depend on this one
    const deps = dependents.get(workerId) || [];
    const hasActiveDependents = deps.some(depId => {
      const depNode = dependencyNodes.get(depId);
      return depNode && depNode.status !== 'completed' && depNode.status !== 'failed';
    });
    if (hasActiveDependents) continue;

    removeWorkerDependencies(workerId);
    nodesCleaned++;
  }

  return { workflowsCleaned: 0, nodesCleaned };
}

/**
 * Get dependency graph statistics
 * @returns {Object}
 */
export function getDependencyStats() {
  const nodeStatus = { pending: 0, waiting: 0, ready: 0, running: 0, completed: 0, failed: 0 };
  for (const node of dependencyNodes.values()) {
    if (node.status in nodeStatus) nodeStatus[node.status]++;
  }

  return {
    totalNodes: dependencyNodes.size,
    byStatus: nodeStatus
  };
}
