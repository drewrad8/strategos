/**
 * Task Decomposer - Breaks complex tasks into subtasks with dependency analysis
 *
 * Based on research from:
 * - 07-task-decomposition.md: DAG analysis, critical path, parallelization
 * - IMPLEMENTATION_SPEC.md section 2.3: Interface requirements
 *
 * Designed to integrate with existing dependencyGraph.js for execution.
 */

import { v4 as uuidv4 } from 'uuid';

// ============================================
// CONSTANTS AND TYPES
// ============================================

export const DecompositionStrategy = {
  MECE: 'mece',           // Mutually exclusive, collectively exhaustive
  SEQUENTIAL: 'sequential', // Ordered steps that must run in sequence
  PARALLEL: 'parallel'     // Independent subtasks that can run concurrently
};

export const ComplexityLevel = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high'
};

export const AssignableType = {
  ANY: 'any',
  CODER: 'coder',
  RESEARCHER: 'researcher',
  REVIEWER: 'reviewer',
  TESTER: 'tester',
  ANALYST: 'analyst'
};

/**
 * @typedef {Object} Subtask
 * @property {string} id - Unique subtask identifier
 * @property {string} description - What the subtask accomplishes
 * @property {string[]} dependencies - Array of subtask IDs this task depends on
 * @property {'low'|'medium'|'high'} estimatedComplexity - Complexity estimate
 * @property {string[]} acceptanceCriteria - Criteria for subtask completion
 * @property {'any'|string} assignableTo - Worker type that can handle this
 * @property {number} [estimatedDuration] - Estimated duration in seconds
 */

/**
 * @typedef {Object} DecompositionResult
 * @property {Subtask[]} subtasks - Array of decomposed subtasks
 * @property {string[]} executionOrder - Topologically sorted execution order
 * @property {string[]} criticalPath - IDs of tasks on the critical path
 * @property {number} estimatedMakespan - Total estimated duration
 * @property {Object} parallelizationInfo - Info about parallel execution potential
 */

/**
 * @typedef {Object} DependencyGraph
 * @property {Map<string, Set<string>>} edges - adjacency list (task -> dependents)
 * @property {Map<string, Set<string>>} reverseEdges - reverse adjacency (task -> dependencies)
 * @property {Map<string, Object>} nodes - task ID -> task data
 */

// ============================================
// TASK DECOMPOSER CLASS
// ============================================

export class TaskDecomposer {
  constructor(options = {}) {
    this.options = {
      maxSubtasks: options.maxSubtasks || 10,
      minComplexity: options.minComplexity || ComplexityLevel.LOW,
      defaultDurations: {
        low: 60,      // 1 minute
        medium: 300,  // 5 minutes
        high: 900     // 15 minutes
      },
      ...options
    };
  }

  /**
   * Decompose a task into subtasks with dependencies
   *
   * @param {Object} task - Task to decompose
   * @param {string} task.description - Task description
   * @param {string} [task.type] - Task type (code, research, etc.)
   * @param {Object[]} [task.subtasks] - Pre-defined subtasks (optional)
   * @param {string} [task.strategy] - Decomposition strategy
   * @returns {DecompositionResult}
   */
  decompose(task) {
    const strategy = task.strategy || this._inferStrategy(task);
    let subtasks;

    if (task.subtasks && Array.isArray(task.subtasks) && task.subtasks.length > 0) {
      // Use pre-defined subtasks, normalizing them
      subtasks = this._normalizeSubtasks(task.subtasks);
    } else {
      // Generate subtasks based on strategy
      subtasks = this._generateSubtasks(task, strategy);
    }

    // Analyze dependencies and validate DAG
    const dependencyGraph = this.analyzeDependencies(subtasks);

    // Calculate execution order (topological sort)
    const executionOrder = this._topologicalSort(dependencyGraph);

    // Calculate critical path
    const criticalPathInfo = this._calculateCriticalPath(subtasks, dependencyGraph);

    // Calculate parallelization potential
    const parallelizationInfo = this._analyzeParallelization(subtasks, dependencyGraph);

    return {
      subtasks,
      executionOrder,
      criticalPath: criticalPathInfo.path,
      estimatedMakespan: criticalPathInfo.makespan,
      parallelizationInfo,
      strategy,
      dependencyGraph
    };
  }

  /**
   * Analyze dependencies between subtasks and build dependency graph
   *
   * @param {Subtask[]} subtasks - Array of subtasks
   * @returns {DependencyGraph}
   */
  analyzeDependencies(subtasks) {
    const edges = new Map();       // task -> Set of tasks that depend on it
    const reverseEdges = new Map(); // task -> Set of tasks it depends on
    const nodes = new Map();

    // Initialize all nodes
    for (const subtask of subtasks) {
      edges.set(subtask.id, new Set());
      reverseEdges.set(subtask.id, new Set(subtask.dependencies || []));
      nodes.set(subtask.id, subtask);
    }

    // Build forward edges from dependencies
    for (const subtask of subtasks) {
      for (const depId of (subtask.dependencies || [])) {
        if (edges.has(depId)) {
          edges.get(depId).add(subtask.id);
        }
      }
    }

    // Validate DAG (detect cycles)
    const cycleCheck = this._detectCycle(edges, reverseEdges);
    if (cycleCheck.hasCycle) {
      throw new Error(`Circular dependency detected: ${cycleCheck.path.join(' -> ')}`);
    }

    // Validate all dependencies exist
    for (const subtask of subtasks) {
      for (const depId of (subtask.dependencies || [])) {
        if (!nodes.has(depId)) {
          throw new Error(`Subtask "${subtask.id}" depends on unknown subtask "${depId}"`);
        }
      }
    }

    return { edges, reverseEdges, nodes };
  }

  /**
   * Estimate complexity of a task
   *
   * @param {Object} task - Task to estimate
   * @returns {'low'|'medium'|'high'}
   */
  estimateComplexity(task) {
    let score = 0;

    // Factor 1: Description length (proxy for scope)
    const description = task.description || '';
    if (description.length > 500) score += 2;
    else if (description.length > 200) score += 1;

    // Factor 2: Number of subtasks if pre-defined
    if (task.subtasks && Array.isArray(task.subtasks)) {
      if (task.subtasks.length > 7) score += 2;
      else if (task.subtasks.length > 3) score += 1;
    }

    // Factor 3: Keywords indicating complexity
    const highComplexityKeywords = [
      'refactor', 'migrate', 'redesign', 'architect', 'optimize',
      'integrate', 'security', 'performance', 'scalability'
    ];
    const mediumComplexityKeywords = [
      'implement', 'create', 'build', 'develop', 'add', 'fix',
      'update', 'modify', 'test', 'validate'
    ];

    const lowerDescription = description.toLowerCase();
    for (const keyword of highComplexityKeywords) {
      if (lowerDescription.includes(keyword)) score += 2;
    }
    for (const keyword of mediumComplexityKeywords) {
      if (lowerDescription.includes(keyword)) score += 1;
    }

    // Factor 4: Multiple acceptance criteria
    if (task.acceptanceCriteria && Array.isArray(task.acceptanceCriteria)) {
      if (task.acceptanceCriteria.length > 5) score += 2;
      else if (task.acceptanceCriteria.length > 2) score += 1;
    }

    // Factor 5: Explicit complexity hint
    if (task.complexity) {
      return task.complexity;
    }

    // Map score to complexity level
    if (score >= 6) return ComplexityLevel.HIGH;
    if (score >= 3) return ComplexityLevel.MEDIUM;
    return ComplexityLevel.LOW;
  }

  // ============================================
  // PRIVATE METHODS
  // ============================================

  /**
   * Infer decomposition strategy from task characteristics
   * @private
   */
  _inferStrategy(task) {
    const description = (task.description || '').toLowerCase();

    // Sequential indicators
    const sequentialIndicators = [
      'step by step', 'first', 'then', 'after', 'before',
      'sequence', 'pipeline', 'workflow', 'process'
    ];

    // Parallel indicators
    const parallelIndicators = [
      'independently', 'parallel', 'concurrent', 'simultaneously',
      'separate', 'multiple', 'various'
    ];

    let sequentialScore = 0;
    let parallelScore = 0;

    for (const indicator of sequentialIndicators) {
      if (description.includes(indicator)) sequentialScore++;
    }

    for (const indicator of parallelIndicators) {
      if (description.includes(indicator)) parallelScore++;
    }

    if (sequentialScore > parallelScore) return DecompositionStrategy.SEQUENTIAL;
    if (parallelScore > sequentialScore) return DecompositionStrategy.PARALLEL;

    // Default to MECE for comprehensive coverage
    return DecompositionStrategy.MECE;
  }

  /**
   * Normalize subtasks to ensure all required fields
   * @private
   */
  _normalizeSubtasks(subtasks) {
    return subtasks.map((subtask, index) => ({
      id: subtask.id || `subtask-${index + 1}`,
      description: subtask.description || `Subtask ${index + 1}`,
      dependencies: subtask.dependencies || [],
      estimatedComplexity: subtask.estimatedComplexity || this._estimateSubtaskComplexity(subtask),
      acceptanceCriteria: subtask.acceptanceCriteria || [],
      assignableTo: subtask.assignableTo || AssignableType.ANY,
      estimatedDuration: subtask.estimatedDuration || this._estimateDuration(subtask.estimatedComplexity)
    }));
  }

  /**
   * Generate subtasks based on strategy (placeholder for LLM integration)
   * @private
   */
  _generateSubtasks(task, strategy) {
    // This is a rule-based fallback. In production, this would call an LLM
    // to intelligently decompose the task.

    const complexity = this.estimateComplexity(task);
    const subtaskCount = complexity === ComplexityLevel.HIGH ? 5 :
                         complexity === ComplexityLevel.MEDIUM ? 3 : 2;

    const subtasks = [];

    switch (strategy) {
      case DecompositionStrategy.SEQUENTIAL:
        // Create sequential chain: 1 -> 2 -> 3 -> ...
        for (let i = 0; i < subtaskCount; i++) {
          subtasks.push({
            id: `subtask-${i + 1}`,
            description: `Step ${i + 1}: ${this._generateStepDescription(task, i, subtaskCount)}`,
            dependencies: i > 0 ? [`subtask-${i}`] : [],
            estimatedComplexity: this._distributeComplexity(complexity, i, subtaskCount),
            acceptanceCriteria: [`Step ${i + 1} completed successfully`],
            assignableTo: AssignableType.ANY,
            estimatedDuration: this._estimateDuration(this._distributeComplexity(complexity, i, subtaskCount))
          });
        }
        break;

      case DecompositionStrategy.PARALLEL:
        // Create independent tasks with final aggregation
        for (let i = 0; i < subtaskCount - 1; i++) {
          subtasks.push({
            id: `subtask-${i + 1}`,
            description: `Parallel task ${i + 1}: ${this._generateParallelDescription(task, i)}`,
            dependencies: [],
            estimatedComplexity: this._distributeComplexity(complexity, i, subtaskCount),
            acceptanceCriteria: [`Task ${i + 1} completed`],
            assignableTo: AssignableType.ANY,
            estimatedDuration: this._estimateDuration(this._distributeComplexity(complexity, i, subtaskCount))
          });
        }
        // Final aggregation task depends on all parallel tasks
        subtasks.push({
          id: `subtask-${subtaskCount}`,
          description: 'Aggregate and finalize results',
          dependencies: subtasks.map(s => s.id),
          estimatedComplexity: ComplexityLevel.LOW,
          acceptanceCriteria: ['All results combined', 'Final output validated'],
          assignableTo: AssignableType.ANY,
          estimatedDuration: this._estimateDuration(ComplexityLevel.LOW)
        });
        break;

      case DecompositionStrategy.MECE:
      default:
        // MECE: Create distinct, non-overlapping subtasks
        // Typically: Research -> Design -> Implement -> Test -> Review
        const phases = this._getMECEPhases(task);
        for (let i = 0; i < Math.min(phases.length, this.options.maxSubtasks); i++) {
          const phase = phases[i];
          subtasks.push({
            id: `subtask-${i + 1}`,
            description: phase.description,
            dependencies: phase.dependencies.map(d => `subtask-${d}`),
            estimatedComplexity: phase.complexity,
            acceptanceCriteria: phase.criteria,
            assignableTo: phase.assignableTo,
            estimatedDuration: this._estimateDuration(phase.complexity)
          });
        }
        break;
    }

    return subtasks;
  }

  /**
   * Get MECE phases for a task
   * @private
   */
  _getMECEPhases(task) {
    const description = (task.description || '').toLowerCase();

    // Detect task type
    const isCodeTask = description.includes('code') || description.includes('implement') ||
                       description.includes('build') || description.includes('develop');
    const isResearchTask = description.includes('research') || description.includes('investigate') ||
                           description.includes('analyze') || description.includes('study');
    const isTestTask = description.includes('test') || description.includes('verify') ||
                       description.includes('validate');

    if (isCodeTask) {
      return [
        {
          description: 'Research and understand requirements',
          dependencies: [],
          complexity: ComplexityLevel.LOW,
          criteria: ['Requirements documented', 'Approach identified'],
          assignableTo: AssignableType.RESEARCHER
        },
        {
          description: 'Design solution architecture',
          dependencies: [1],
          complexity: ComplexityLevel.MEDIUM,
          criteria: ['Design documented', 'Edge cases considered'],
          assignableTo: AssignableType.ANALYST
        },
        {
          description: 'Implement core functionality',
          dependencies: [2],
          complexity: ComplexityLevel.HIGH,
          criteria: ['Code written', 'Compiles/runs without errors'],
          assignableTo: AssignableType.CODER
        },
        {
          description: 'Write and run tests',
          dependencies: [3],
          complexity: ComplexityLevel.MEDIUM,
          criteria: ['Tests written', 'All tests pass'],
          assignableTo: AssignableType.TESTER
        },
        {
          description: 'Review and refine',
          dependencies: [4],
          complexity: ComplexityLevel.LOW,
          criteria: ['Code reviewed', 'Final approval'],
          assignableTo: AssignableType.REVIEWER
        }
      ];
    }

    if (isResearchTask) {
      return [
        {
          description: 'Define research scope and questions',
          dependencies: [],
          complexity: ComplexityLevel.LOW,
          criteria: ['Research questions defined'],
          assignableTo: AssignableType.ANALYST
        },
        {
          description: 'Gather information from sources',
          dependencies: [1],
          complexity: ComplexityLevel.MEDIUM,
          criteria: ['Sources identified', 'Data collected'],
          assignableTo: AssignableType.RESEARCHER
        },
        {
          description: 'Analyze and synthesize findings',
          dependencies: [2],
          complexity: ComplexityLevel.HIGH,
          criteria: ['Analysis complete', 'Key insights identified'],
          assignableTo: AssignableType.ANALYST
        },
        {
          description: 'Document conclusions and recommendations',
          dependencies: [3],
          complexity: ComplexityLevel.MEDIUM,
          criteria: ['Report written', 'Recommendations clear'],
          assignableTo: AssignableType.RESEARCHER
        }
      ];
    }

    // Default generic phases
    return [
      {
        description: 'Analyze and plan approach',
        dependencies: [],
        complexity: ComplexityLevel.LOW,
        criteria: ['Approach planned'],
        assignableTo: AssignableType.ANY
      },
      {
        description: 'Execute main task',
        dependencies: [1],
        complexity: ComplexityLevel.MEDIUM,
        criteria: ['Task executed'],
        assignableTo: AssignableType.ANY
      },
      {
        description: 'Verify and validate results',
        dependencies: [2],
        complexity: ComplexityLevel.LOW,
        criteria: ['Results verified'],
        assignableTo: AssignableType.ANY
      }
    ];
  }

  /**
   * Generate step description for sequential decomposition
   * @private
   */
  _generateStepDescription(task, stepIndex, totalSteps) {
    const phases = ['Preparation', 'Execution', 'Verification', 'Finalization', 'Review'];
    const phaseIndex = Math.floor(stepIndex * phases.length / totalSteps);
    return phases[Math.min(phaseIndex, phases.length - 1)];
  }

  /**
   * Generate description for parallel task
   * @private
   */
  _generateParallelDescription(task, index) {
    const aspects = ['Component A', 'Component B', 'Component C', 'Component D'];
    return aspects[index % aspects.length];
  }

  /**
   * Distribute complexity across subtasks
   * @private
   */
  _distributeComplexity(overallComplexity, index, totalCount) {
    // Middle tasks tend to be more complex
    const middleIndex = Math.floor(totalCount / 2);
    const distanceFromMiddle = Math.abs(index - middleIndex);

    if (overallComplexity === ComplexityLevel.HIGH) {
      if (distanceFromMiddle === 0) return ComplexityLevel.HIGH;
      if (distanceFromMiddle <= 1) return ComplexityLevel.MEDIUM;
      return ComplexityLevel.LOW;
    }

    if (overallComplexity === ComplexityLevel.MEDIUM) {
      if (distanceFromMiddle === 0) return ComplexityLevel.MEDIUM;
      return ComplexityLevel.LOW;
    }

    return ComplexityLevel.LOW;
  }

  /**
   * Estimate subtask complexity from its properties
   * @private
   */
  _estimateSubtaskComplexity(subtask) {
    const description = (subtask.description || '').toLowerCase();

    if (description.includes('implement') || description.includes('build') ||
        description.includes('create') || description.includes('develop')) {
      return ComplexityLevel.MEDIUM;
    }

    if (description.includes('refactor') || description.includes('optimize') ||
        description.includes('migrate')) {
      return ComplexityLevel.HIGH;
    }

    return ComplexityLevel.LOW;
  }

  /**
   * Estimate duration based on complexity
   * @private
   */
  _estimateDuration(complexity) {
    return this.options.defaultDurations[complexity] || this.options.defaultDurations.medium;
  }

  /**
   * Detect cycles in the dependency graph using DFS
   * @private
   */
  _detectCycle(edges, reverseEdges) {
    const WHITE = 0; // Unvisited
    const GRAY = 1;  // In progress
    const BLACK = 2; // Complete

    const color = new Map();
    const path = [];

    // Initialize all nodes as white
    for (const nodeId of edges.keys()) {
      color.set(nodeId, WHITE);
    }

    const dfs = (node) => {
      color.set(node, GRAY);
      path.push(node);

      const dependencies = reverseEdges.get(node) || new Set();
      for (const dep of dependencies) {
        if (color.get(dep) === GRAY) {
          // Found a back edge - cycle detected
          const cycleStart = path.indexOf(dep);
          const cyclePath = path.slice(cycleStart);
          cyclePath.push(dep);
          return { hasCycle: true, path: cyclePath };
        }

        if (color.get(dep) === WHITE) {
          const result = dfs(dep);
          if (result.hasCycle) return result;
        }
      }

      path.pop();
      color.set(node, BLACK);
      return { hasCycle: false, path: [] };
    };

    for (const nodeId of edges.keys()) {
      if (color.get(nodeId) === WHITE) {
        const result = dfs(nodeId);
        if (result.hasCycle) return result;
      }
    }

    return { hasCycle: false, path: [] };
  }

  /**
   * Perform topological sort using Kahn's algorithm
   * @private
   */
  _topologicalSort(dependencyGraph) {
    const { edges, reverseEdges, nodes } = dependencyGraph;

    // Calculate in-degree for each node
    const inDegree = new Map();
    for (const nodeId of nodes.keys()) {
      inDegree.set(nodeId, reverseEdges.get(nodeId)?.size || 0);
    }

    // Start with nodes that have no dependencies
    const queue = [];
    for (const [nodeId, degree] of inDegree) {
      if (degree === 0) {
        queue.push(nodeId);
      }
    }

    const result = [];

    while (queue.length > 0) {
      const node = queue.shift();
      result.push(node);

      // For each dependent of this node
      const dependents = edges.get(node) || new Set();
      for (const dependent of dependents) {
        const newDegree = inDegree.get(dependent) - 1;
        inDegree.set(dependent, newDegree);

        if (newDegree === 0) {
          queue.push(dependent);
        }
      }
    }

    // If not all nodes are in result, there's a cycle (shouldn't happen if _detectCycle passed)
    if (result.length !== nodes.size) {
      throw new Error('Cycle detected during topological sort');
    }

    return result;
  }

  /**
   * Calculate critical path using CPM algorithm
   * @private
   */
  _calculateCriticalPath(subtasks, dependencyGraph) {
    const { edges, reverseEdges, nodes } = dependencyGraph;
    const executionOrder = this._topologicalSort(dependencyGraph);

    // Get duration for each task
    const durations = new Map();
    for (const subtask of subtasks) {
      durations.set(subtask.id, subtask.estimatedDuration || this._estimateDuration(subtask.estimatedComplexity));
    }

    // Forward pass: Calculate Early Start (ES) and Early Finish (EF)
    const es = new Map();
    const ef = new Map();

    for (const taskId of executionOrder) {
      const dependencies = reverseEdges.get(taskId) || new Set();
      if (dependencies.size === 0) {
        es.set(taskId, 0);
      } else {
        const maxPredEF = Math.max(...[...dependencies].map(d => ef.get(d) || 0));
        es.set(taskId, maxPredEF);
      }
      ef.set(taskId, es.get(taskId) + durations.get(taskId));
    }

    // Project end time (makespan)
    const makespan = Math.max(...[...ef.values()]);

    // Backward pass: Calculate Late Start (LS) and Late Finish (LF)
    const ls = new Map();
    const lf = new Map();

    for (const taskId of [...executionOrder].reverse()) {
      const dependents = edges.get(taskId) || new Set();
      if (dependents.size === 0) {
        lf.set(taskId, makespan);
      } else {
        const minSuccLS = Math.min(...[...dependents].map(d => ls.get(d)));
        lf.set(taskId, minSuccLS);
      }
      ls.set(taskId, lf.get(taskId) - durations.get(taskId));
    }

    // Calculate slack and identify critical path
    const slack = new Map();
    const criticalPath = [];

    for (const taskId of executionOrder) {
      const taskSlack = ls.get(taskId) - es.get(taskId);
      slack.set(taskId, taskSlack);

      // Tasks with zero slack are on the critical path
      if (Math.abs(taskSlack) < 0.001) {
        criticalPath.push(taskId);
      }
    }

    return {
      path: criticalPath,
      makespan,
      slack,
      es,
      ef,
      ls,
      lf
    };
  }

  /**
   * Analyze parallelization potential
   * @private
   */
  _analyzeParallelization(subtasks, dependencyGraph) {
    const { reverseEdges } = dependencyGraph;

    // Find tasks with no dependencies (can start immediately in parallel)
    const parallelizable = [];
    for (const subtask of subtasks) {
      const deps = reverseEdges.get(subtask.id) || new Set();
      if (deps.size === 0) {
        parallelizable.push(subtask.id);
      }
    }

    // Calculate maximum parallelism at any point
    // This requires simulating the schedule
    const executionOrder = this._topologicalSort(dependencyGraph);
    const criticalPathInfo = this._calculateCriticalPath(subtasks, dependencyGraph);

    // Group tasks by their early start time (tasks that could run together)
    const timeSlots = new Map();
    for (const taskId of executionOrder) {
      const startTime = criticalPathInfo.es.get(taskId);
      if (!timeSlots.has(startTime)) {
        timeSlots.set(startTime, []);
      }
      timeSlots.get(startTime).push(taskId);
    }

    const maxParallelism = Math.max(...[...timeSlots.values()].map(tasks => tasks.length));

    // Calculate speedup potential
    const totalSequentialTime = subtasks.reduce((sum, s) =>
      sum + (s.estimatedDuration || this._estimateDuration(s.estimatedComplexity)), 0);
    const speedup = totalSequentialTime / criticalPathInfo.makespan;

    return {
      initiallyParallel: parallelizable,
      maxParallelism,
      speedup: Math.round(speedup * 100) / 100,
      totalSequentialTime,
      criticalPathLength: criticalPathInfo.path.length,
      timeSlots: Object.fromEntries(timeSlots)
    };
  }
}

// ============================================
// UTILITY FUNCTIONS
// ============================================

/**
 * Convert decomposition result to format compatible with dependencyGraph.js
 *
 * @param {DecompositionResult} result - Result from decompose()
 * @param {string} taskId - Parent task ID
 * @returns {Object[]} Array of task definitions for dependencyGraph.createWorkflow
 */
export function toWorkflowTasks(result, taskId) {
  return result.subtasks.map(subtask => ({
    id: `${taskId}-${subtask.id}`,
    prompt: subtask.description,
    dependsOn: subtask.dependencies.map(dep => `${taskId}-${dep}`),
    metadata: {
      complexity: subtask.estimatedComplexity,
      acceptanceCriteria: subtask.acceptanceCriteria,
      assignableTo: subtask.assignableTo,
      estimatedDuration: subtask.estimatedDuration
    }
  }));
}

/**
 * Create a task decomposer with default options
 */
export function createDecomposer(options = {}) {
  return new TaskDecomposer(options);
}

// Default export
export default TaskDecomposer;
