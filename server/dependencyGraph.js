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

/**
 * Validate dependencies for multiple tasks (for workflow creation)
 * @param {Object[]} tasks - Array of {id, dependsOn: []} objects
 * @returns {{valid: boolean, error?: string, cyclePath?: string[]}}
 */
export function validateDependencies(tasks) {
  // Build a temporary graph to check for cycles
  const taskIds = new Set(tasks.map(t => t.id));
  const adjList = new Map();

  for (const task of tasks) {
    adjList.set(task.id, new Set(task.dependsOn || []));

    // Check that dependencies reference valid task IDs
    for (const depId of (task.dependsOn || [])) {
      if (!taskIds.has(depId)) {
        return {
          valid: false,
          error: `Task "${task.id}" depends on unknown task "${depId}"`
        };
      }
    }
  }

  // Topological sort to detect cycles
  const visited = new Set();
  const recStack = new Set();
  const path = [];

  function hasCycleDFS(node) {
    visited.add(node);
    recStack.add(node);
    path.push(node);

    const deps = adjList.get(node) || new Set();
    for (const dep of deps) {
      if (!visited.has(dep)) {
        const result = hasCycleDFS(dep);
        if (result) return result;
      } else if (recStack.has(dep)) {
        const cycleStart = path.indexOf(dep);
        return path.slice(cycleStart).concat([dep]);
      }
    }

    path.pop();
    recStack.delete(node);
    return null;
  }

  for (const task of tasks) {
    if (!visited.has(task.id)) {
      const cyclePath = hasCycleDFS(task.id);
      if (cyclePath) {
        return {
          valid: false,
          error: `Circular dependency detected: ${cyclePath.join(' -> ')}`,
          cyclePath
        };
      }
    }
  }

  return { valid: true };
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
  // Validate dependencies exist (unless they're part of the same workflow being created)
  for (const depId of dependsOn) {
    // Check both existing workers and pending workflow workers
    if (!dependencyNodes.has(depId)) {
      // This might be a forward reference in a workflow - allow it
      // The workflow creation will validate this upfront
    }
  }

  // Check for circular dependencies
  for (const depId of dependsOn) {
    const cycleCheck = detectCycle(workerId, depId);
    if (cycleCheck.hasCycle) {
      return {
        success: false,
        error: `Circular dependency detected: ${cycleCheck.path.join(' -> ')}`
      };
    }
  }

  // Determine initial status
  let status = 'pending';
  if (dependsOn.length === 0) {
    status = 'ready';
  } else {
    // Check if all dependencies are already completed
    const allComplete = dependsOn.every(depId => {
      const depNode = dependencyNodes.get(depId);
      return depNode && depNode.status === 'completed';
    });
    status = allComplete ? 'ready' : 'waiting';
  }

  const node = {
    workerId,
    dependsOn,
    onComplete,
    status,
    completedAt: null,
    workflowId
  };

  dependencyNodes.set(workerId, node);

  // Register this worker as a dependent of its dependencies
  for (const depId of dependsOn) {
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

  node.status = 'completed';
  node.completedAt = new Date();

  // Find workers waiting on this one
  const waitingWorkers = dependents.get(workerId) || [];
  const nowReady = [];

  for (const waitingId of waitingWorkers) {
    const waitingNode = dependencyNodes.get(waitingId);
    if (!waitingNode || waitingNode.status !== 'waiting') continue;

    // Check if all dependencies are now complete
    const allComplete = waitingNode.dependsOn.every(depId => {
      const depNode = dependencyNodes.get(depId);
      return depNode && depNode.status === 'completed';
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
  const node = dependencyNodes.get(workerId);
  if (node) {
    node.status = 'failed';

    // Cascade failure to dependents
    const waitingWorkers = dependents.get(workerId) || [];
    for (const waitingId of waitingWorkers) {
      const waitingNode = dependencyNodes.get(waitingId);
      if (waitingNode && waitingNode.status === 'waiting') {
        waitingNode.status = 'failed';
      }
    }

    // Mark workflow as failed if applicable
    if (node.workflowId) {
      const workflow = workflows.get(node.workflowId);
      if (workflow) {
        workflow.status = 'failed';
      }
    }
  }
}

/**
 * Remove a worker from the dependency graph
 * @param {string} workerId
 */
export function removeWorkerDependencies(workerId) {
  const node = dependencyNodes.get(workerId);
  if (!node) return;

  // Remove from dependents lists
  for (const depId of node.dependsOn) {
    const depList = dependents.get(depId);
    if (depList) {
      const idx = depList.indexOf(workerId);
      if (idx !== -1) depList.splice(idx, 1);
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
 * Get all workers that are ready to run (dependencies satisfied)
 * @returns {string[]}
 */
export function getReadyWorkers() {
  const ready = [];
  for (const [workerId, node] of dependencyNodes) {
    if (node.status === 'ready') {
      ready.push(workerId);
    }
  }
  return ready;
}

/**
 * Get all workers waiting on dependencies
 * @returns {string[]}
 */
export function getWaitingWorkers() {
  const waiting = [];
  for (const [workerId, node] of dependencyNodes) {
    if (node.status === 'waiting') {
      waiting.push(workerId);
    }
  }
  return waiting;
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
 * Create a workflow with multiple dependent tasks
 * @param {Object} workflowDef
 * @param {string} workflowDef.name
 * @param {string} [workflowDef.description]
 * @param {Object[]} workflowDef.tasks - Task definitions
 * @returns {{success: boolean, workflow?: Workflow, error?: string}}
 */
export function createWorkflow(workflowDef) {
  const { name, description = '', tasks } = workflowDef;

  if (!name || !tasks || !Array.isArray(tasks) || tasks.length === 0) {
    return { success: false, error: 'Workflow requires name and tasks array' };
  }

  // Assign IDs to tasks if not provided
  const tasksWithIds = tasks.map((task, index) => ({
    ...task,
    id: task.id || `task-${index}`
  }));

  // Validate dependencies
  const validation = validateDependencies(tasksWithIds);
  if (!validation.valid) {
    return { success: false, error: validation.error, cyclePath: validation.cyclePath };
  }

  const workflowId = uuidv4().slice(0, 8);

  const workflow = {
    id: workflowId,
    name,
    description,
    tasks: tasksWithIds,
    status: 'pending',
    createdAt: new Date(),
    startedAt: null,
    completedAt: null,
    workerIds: [],
    taskToWorker: new Map() // Maps task IDs to worker IDs
  };

  workflows.set(workflowId, workflow);

  return { success: true, workflow };
}

/**
 * Start a workflow - spawn initial workers with no dependencies
 * Returns the tasks that are ready to start
 * @param {string} workflowId
 * @returns {{success: boolean, readyTasks?: Object[], error?: string}}
 */
export function startWorkflow(workflowId) {
  const workflow = workflows.get(workflowId);
  if (!workflow) {
    return { success: false, error: 'Workflow not found' };
  }

  if (workflow.status !== 'pending') {
    return { success: false, error: `Workflow already ${workflow.status}` };
  }

  workflow.status = 'running';
  workflow.startedAt = new Date();

  // Find tasks with no dependencies - these are ready to start
  const readyTasks = workflow.tasks.filter(task =>
    !task.dependsOn || task.dependsOn.length === 0
  );

  return { success: true, readyTasks, workflow };
}

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
 * Get worker ID for a workflow task
 * @param {string} workflowId
 * @param {string} taskId
 * @returns {string|null}
 */
export function getWorkerForTask(workflowId, taskId) {
  const workflow = workflows.get(workflowId);
  if (!workflow) return null;
  return workflow.taskToWorker.get(taskId) || null;
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
  } else if (allComplete && workflow.workerIds.length === workflow.tasks.length) {
    workflow.status = 'completed';
    workflow.completedAt = new Date();
  }
}

/**
 * Get workflow by ID
 * @param {string} workflowId
 * @returns {Workflow|null}
 */
export function getWorkflow(workflowId) {
  const workflow = workflows.get(workflowId);
  if (!workflow) return null;

  // Serialize taskToWorker map
  return {
    ...workflow,
    taskToWorker: Object.fromEntries(workflow.taskToWorker)
  };
}

/**
 * Get all workflows
 * @returns {Workflow[]}
 */
export function getWorkflows() {
  return Array.from(workflows.values()).map(w => ({
    ...w,
    taskToWorker: Object.fromEntries(w.taskToWorker)
  }));
}

/**
 * Get next ready tasks in a workflow (after a worker completes)
 * @param {string} workflowId
 * @param {string} completedTaskId
 * @returns {Object[]}
 */
export function getNextWorkflowTasks(workflowId, completedTaskId) {
  const workflow = workflows.get(workflowId);
  if (!workflow) return [];

  // Find tasks that depend on the completed task and are now ready
  const readyTasks = [];

  for (const task of workflow.tasks) {
    // Skip if already has a worker
    if (workflow.taskToWorker.has(task.id)) continue;

    // Check if this task depends on the completed task
    if (!task.dependsOn || !task.dependsOn.includes(completedTaskId)) continue;

    // Check if all dependencies are complete
    const allDepsComplete = (task.dependsOn || []).every(depTaskId => {
      const depWorkerId = workflow.taskToWorker.get(depTaskId);
      if (!depWorkerId) return false;
      const depNode = dependencyNodes.get(depWorkerId);
      return depNode && depNode.status === 'completed';
    });

    if (allDepsComplete) {
      readyTasks.push(task);
    }
  }

  return readyTasks;
}

// ============================================
// STATISTICS
// ============================================

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
