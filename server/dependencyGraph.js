/**
 * Dependency Graph - Manages task dependencies and execution ordering
 *
 * Features:
 * - Track dependencies between workers
 * - Detect circular dependencies before they cause issues
 * - Determine which workers can be executed (dependencies satisfied)
 * - Track worker completion status for dependency resolution
 */

import { v4 as uuidv4 } from 'uuid';

// ============================================
// STATE
// ============================================

// Map of workerId -> DependencyNode
const dependencyNodes = new Map();

// Map of workerId -> array of workerIds that depend on this worker
const dependents = new Map();

// Map of workflowId -> Workflow object
const workflows = new Map();

/**
 * @typedef {Object} DependencyNode
 * @property {string} workerId - The worker ID
 * @property {string[]} dependsOn - Array of worker IDs this worker depends on
 * @property {Object|null} onComplete - Action to trigger when worker completes
 * @property {'pending'|'waiting'|'ready'|'running'|'completed'|'failed'} status
 * @property {Date|null} completedAt
 * @property {string|null} workflowId - If part of a workflow
 */

/**
 * @typedef {Object} OnCompleteAction
 * @property {'spawn'|'webhook'|'emit'} type
 * @property {Object} config - Type-specific configuration
 */

/**
 * @typedef {Object} Workflow
 * @property {string} id
 * @property {string} name
 * @property {string} description
 * @property {Object[]} tasks - Task definitions with dependencies
 * @property {'pending'|'running'|'completed'|'failed'} status
 * @property {Date} createdAt
 * @property {Date|null} startedAt
 * @property {Date|null} completedAt
 * @property {string[]} workerIds - Worker IDs created by this workflow
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
 * @param {string|null} workflowId - Associated workflow ID
 * @returns {{success: boolean, error?: string, node?: DependencyNode}}
 */
export function registerWorkerDependencies(workerId, dependsOn = [], onComplete = null, workflowId = null) {
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
    completedAt: null,
    workflowId
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

  // Check if workflow is complete
  if (node.workflowId) {
    checkWorkflowCompletion(node.workflowId);
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

        // Mark workflow as failed if applicable — but never regress a completed workflow
        if (waitingNode.workflowId) {
          const workflow = workflows.get(waitingNode.workflowId);
          if (workflow && workflow.status !== 'completed') {
            workflow.status = 'failed';
            if (!workflow.completedAt) workflow.completedAt = new Date();
          }
        }
      }
    }
  }

  // Mark workflow as failed if applicable — but never regress a completed workflow
  if (node.workflowId) {
    const workflow = workflows.get(node.workflowId);
    if (workflow && workflow.status !== 'completed') {
      workflow.status = 'failed';
      if (!workflow.completedAt) workflow.completedAt = new Date();
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
    workflowId: node.workflowId,
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
// WORKFLOW MANAGEMENT
// ============================================

/**
 * Register a worker as part of a workflow task
 * @param {string} workflowId
 * @param {string} taskId
 * @param {string} workerId
 */
export function registerWorkflowWorker(workflowId, taskId, workerId) {
  const workflow = workflows.get(workflowId);
  if (!workflow) return;

  workflow.workerIds.push(workerId);
  workflow.taskToWorker.set(taskId, workerId);
}

/**
 * Check if workflow is complete and update status
 * @param {string} workflowId
 */
function checkWorkflowCompletion(workflowId) {
  const workflow = workflows.get(workflowId);
  if (!workflow || workflow.status !== 'running') return;

  // Check if all workers are completed
  let allComplete = true;
  let anyFailed = false;

  for (const workerId of workflow.workerIds) {
    const node = dependencyNodes.get(workerId);
    if (!node) continue;

    if (node.status === 'failed') {
      anyFailed = true;
      break;
    }
    if (node.status !== 'completed') {
      allComplete = false;
    }
  }

  if (anyFailed) {
    workflow.status = 'failed';
    if (!workflow.completedAt) workflow.completedAt = new Date();
  } else if (allComplete && workflow.workerIds.length >= workflow.tasks.length) {
    // Use >= because a single task may spawn multiple workers (parallel execution)
    workflow.status = 'completed';
    workflow.completedAt = new Date();
  }
}

// ============================================
// STATISTICS
// ============================================

/**
 * Clean up finished workflows and their completed/failed dependency nodes.
 * Prevents unbounded memory growth from accumulated workflows.
 * Called every 60s by startPeriodicCleanup() in workerManager.js.
 * @param {number} maxAgeMs - Max age for completed/failed workflows (default 1 hour)
 * @returns {{workflowsCleaned: number, nodesCleaned: number}}
 */
export function cleanupFinishedWorkflows(maxAgeMs = 60 * 60 * 1000) {
  const now = Date.now();
  let workflowsCleaned = 0;
  let nodesCleaned = 0;

  // Snapshot keys before iterating — Map mutation during iteration is unsafe
  const workflowIds = Array.from(workflows.keys());
  for (const workflowId of workflowIds) {
    const workflow = workflows.get(workflowId);
    if (!workflow) continue; // Deleted by concurrent operation

    // Clean up completed/failed workflows after maxAgeMs
    // Also clean up stuck 'running' workflows after 24 hours (likely orphaned)
    const STUCK_WORKFLOW_AGE = 24 * 60 * 60 * 1000;
    if (workflow.status === 'completed' || workflow.status === 'failed') {
      const finishedAt = workflow.completedAt || workflow.startedAt || workflow.createdAt;
      if (!finishedAt || now - finishedAt.getTime() < maxAgeMs) continue;
    } else {
      // Running/pending — only clean if stuck for 24h
      const startedAt = workflow.startedAt || workflow.createdAt;
      if (!startedAt || now - startedAt.getTime() < STUCK_WORKFLOW_AGE) continue;
      console.warn(`[DepGraph] Cleaning stuck workflow ${workflowId} (status: ${workflow.status}, age: ${Math.round((now - startedAt.getTime()) / 3600000)}h)`);
    }

    // Clean up dependency nodes for this workflow's workers
    // But skip nodes that have active dependents outside this workflow
    for (const workerId of workflow.workerIds) {
      if (!dependencyNodes.has(workerId)) continue;
      const deps = dependents.get(workerId) || [];
      const hasExternalActiveDeps = deps.some(depId => {
        const depNode = dependencyNodes.get(depId);
        return depNode && depNode.workflowId !== workflowId &&
          depNode.status !== 'completed' && depNode.status !== 'failed';
      });
      if (hasExternalActiveDeps) continue;
      removeWorkerDependencies(workerId);
      nodesCleaned++;
    }

    workflows.delete(workflowId);
    workflowsCleaned++;
  }

  // Also clean up completed/failed nodes NOT part of any workflow (standalone deps)
  // Snapshot keys before iterating — removeWorkerDependencies mutates dependencyNodes
  const standaloneNodeIds = Array.from(dependencyNodes.keys());
  for (const workerId of standaloneNodeIds) {
    const node = dependencyNodes.get(workerId);
    if (!node) continue; // Already removed
    if (node.workflowId) continue; // Already handled above
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

  return { workflowsCleaned, nodesCleaned };
}

/**
 * Get dependency graph statistics
 * @returns {Object}
 */
export function getDependencyStats() {
  const nodes = Array.from(dependencyNodes.values());

  return {
    totalNodes: nodes.length,
    byStatus: {
      pending: nodes.filter(n => n.status === 'pending').length,
      waiting: nodes.filter(n => n.status === 'waiting').length,
      ready: nodes.filter(n => n.status === 'ready').length,
      running: nodes.filter(n => n.status === 'running').length,
      completed: nodes.filter(n => n.status === 'completed').length,
      failed: nodes.filter(n => n.status === 'failed').length
    },
    workflows: {
      total: workflows.size,
      pending: Array.from(workflows.values()).filter(w => w.status === 'pending').length,
      running: Array.from(workflows.values()).filter(w => w.status === 'running').length,
      completed: Array.from(workflows.values()).filter(w => w.status === 'completed').length,
      failed: Array.from(workflows.values()).filter(w => w.status === 'failed').length
    }
  };
}
