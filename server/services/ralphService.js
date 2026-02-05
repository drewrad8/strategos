/**
 * RalphService - Autonomous AI Agent Loop
 *
 * Implements Ralph's autonomous execution pattern:
 * 1. Pick highest priority incomplete story from PRD
 * 2. Spawn a Claude Code worker with the story prompt and completion token
 * 3. Worker signals completion via API callback (/api/ralph/signal/:token)
 * 4. On completion: update status, store learnings, spawn next iteration
 * 5. Loop until all stories complete or max iterations reached
 *
 * Two modes:
 * - PRD Mode: Full autonomous loop with stories and progress tracking
 * - Standalone Mode: Any worker with ralphMode=true can signal completion
 */

import {
  spawnWorker,
  killWorker,
  getWorkerOutput,
  getWorker,
  updateWorkerRalphStatus
} from '../workerManager.js';

import {
  createPrd,
  getPrd,
  updatePrdData,
  listPrds,
  deletePrd,
  createRun,
  getRun,
  listRuns,
  getActiveRunsList,
  setRunStatus,
  setRunIteration,
  completeRun,
  setStoryStatus,
  completeStory,
  getStoryStatuses,
  storeProgress,
  getProgress,
  getLatestProgressEntry
} from '../ralphDb.js';

// Constants
const generateCompletionToken = () => Math.random().toString(36).substring(2, 12);
const HEALTH_CHECK_INTERVAL = 5000; // 5 seconds - check worker health
const WORKER_SPAWN_DELAY = 3000; // 3 seconds before starting health monitoring

// Map of completion tokens to their context
// token -> { runId, storyIndex, workerId }
const pendingCompletions = new Map();

/**
 * RalphService manages the autonomous PRD execution loop
 */
export class RalphService {
  constructor(io) {
    this.io = io;
    this.activeRuns = new Map(); // runId -> { prdId, iteration, currentWorkerId, currentStoryIndex, pollInterval }
  }

  // =====================
  // PRD Management
  // =====================

  /**
   * Create a new PRD
   */
  createPrd(name, description, projectPath, stories) {
    const prd = createPrd(name, description, projectPath, stories);
    this.io?.emit('ralph:prd:created', { prd });
    return prd;
  }

  /**
   * Get a PRD by ID
   */
  getPrd(prdId) {
    return getPrd(prdId);
  }

  /**
   * Update a PRD
   */
  updatePrd(prdId, updates) {
    const prd = updatePrdData(prdId, updates);
    this.io?.emit('ralph:prd:updated', { prd });
    return prd;
  }

  /**
   * List all PRDs
   */
  listPrds() {
    return listPrds();
  }

  /**
   * Delete a PRD
   */
  deletePrd(prdId) {
    const result = deletePrd(prdId);
    if (result) {
      this.io?.emit('ralph:prd:deleted', { prdId });
    }
    return result;
  }

  // =====================
  // Run Management
  // =====================

  /**
   * Start a new Ralph run for a PRD
   * @param {number} prdId - PRD ID
   * @param {number} maxIterations - Maximum iterations (default 10)
   * @returns {Object} Run object
   */
  async startRun(prdId, maxIterations = 10) {
    const prd = getPrd(prdId);
    if (!prd) {
      throw new Error(`PRD ${prdId} not found`);
    }

    // Create the run in database
    const run = createRun(prdId, maxIterations);

    // Initialize run state
    this.activeRuns.set(run.id, {
      prdId,
      iteration: 0,
      currentWorkerId: null,
      currentStoryIndex: null,
      pollInterval: null
    });

    // Update status to running
    setRunStatus(run.id, 'running');

    this.io?.emit('ralph:run:started', {
      runId: run.id,
      prdId,
      prdName: prd.name,
      projectPath: prd.project_path
    });

    console.log(`[RalphService] Started run ${run.id} for PRD "${prd.name}"`);

    // Start the first iteration
    await this.runIteration(run.id);

    return getRun(run.id);
  }

  /**
   * Pause a running Ralph run
   * @param {number} runId - Run ID
   */
  pauseRun(runId) {
    const runState = this.activeRuns.get(runId);
    if (!runState) {
      throw new Error(`Run ${runId} not found or not active`);
    }

    // Stop polling
    if (runState.pollInterval) {
      clearInterval(runState.pollInterval);
      runState.pollInterval = null;
    }

    setRunStatus(runId, 'paused');
    this.io?.emit('ralph:run:paused', { runId });
    console.log(`[RalphService] Paused run ${runId}`);
  }

  /**
   * Resume a paused Ralph run
   * @param {number} runId - Run ID
   */
  async resumeRun(runId) {
    const run = getRun(runId);
    if (!run) {
      throw new Error(`Run ${runId} not found`);
    }

    if (run.status !== 'paused') {
      throw new Error(`Run ${runId} is not paused (status: ${run.status})`);
    }

    // Re-initialize run state if needed
    if (!this.activeRuns.has(runId)) {
      this.activeRuns.set(runId, {
        prdId: run.prd_id,
        iteration: run.current_iteration,
        currentWorkerId: null,
        currentStoryIndex: null,
        pollInterval: null
      });
    }

    setRunStatus(runId, 'running');
    this.io?.emit('ralph:run:resumed', { runId });
    console.log(`[RalphService] Resumed run ${runId}`);

    // Continue with next iteration
    await this.runIteration(runId);
  }

  /**
   * Cancel/stop a Ralph run
   * @param {number} runId - Run ID
   */
  async cancelRun(runId) {
    const runState = this.activeRuns.get(runId);

    if (runState) {
      // Stop polling
      if (runState.pollInterval) {
        clearInterval(runState.pollInterval);
      }

      // Kill current worker if exists
      if (runState.currentWorkerId) {
        try {
          await killWorker(runState.currentWorkerId, this.io);
        } catch (err) {
          console.error(`[RalphService] Failed to kill worker ${runState.currentWorkerId}:`, err.message);
        }
      }

      this.activeRuns.delete(runId);
    }

    completeRun(runId, 'cancelled');
    this.io?.emit('ralph:run:cancelled', { runId });
    console.log(`[RalphService] Cancelled run ${runId}`);
  }

  /**
   * Get run status
   * @param {number} runId - Run ID
   * @returns {Object} Run with current state
   */
  getRunStatus(runId) {
    const run = getRun(runId);
    if (!run) return null;

    const runState = this.activeRuns.get(runId);
    return {
      ...run,
      isActive: !!runState,
      currentWorkerId: runState?.currentWorkerId,
      currentStoryIndex: runState?.currentStoryIndex
    };
  }

  /**
   * List all runs
   */
  listRuns() {
    return listRuns();
  }

  /**
   * Get progress for a run
   */
  getRunProgress(runId) {
    return getProgress(runId);
  }

  // =====================
  // Core Loop
  // =====================

  /**
   * Run a single iteration of the Ralph loop
   * @param {number} runId - Run ID
   */
  async runIteration(runId) {
    const runState = this.activeRuns.get(runId);
    if (!runState) {
      console.log(`[RalphService] Run ${runId} not active, skipping iteration`);
      return;
    }

    const run = getRun(runId);
    if (!run || run.status !== 'running') {
      console.log(`[RalphService] Run ${runId} not in running state, skipping`);
      return;
    }

    // Increment iteration
    runState.iteration++;
    setRunIteration(runId, runState.iteration);

    console.log(`[RalphService] Run ${runId} starting iteration ${runState.iteration}`);

    // Check max iterations
    if (runState.iteration > run.max_iterations) {
      await this.handleMaxIterationsReached(runId);
      return;
    }

    // Find next incomplete story
    const story = this.pickNextStory(runId);

    if (!story) {
      // All stories complete!
      await this.handleAllStoriesComplete(runId);
      return;
    }

    // Spawn worker for this story
    await this.spawnStoryWorker(runId, story);
  }

  /**
   * Pick the highest priority incomplete story
   * @param {number} runId - Run ID
   * @returns {Object|null} Story with index, or null if all complete
   */
  pickNextStory(runId) {
    const run = getRun(runId);
    if (!run || !run.prd) return null;

    const storyStatuses = getStoryStatuses(runId);
    const stories = run.prd.stories;

    // Find stories that are still pending
    const pendingIndices = storyStatuses
      .filter(s => s.status === 'pending')
      .map(s => s.story_index);

    if (pendingIndices.length === 0) {
      return null;
    }

    // Sort by priority (lower number = higher priority)
    pendingIndices.sort((a, b) => {
      const priorityA = stories[a]?.priority ?? 999;
      const priorityB = stories[b]?.priority ?? 999;
      return priorityA - priorityB;
    });

    const storyIndex = pendingIndices[0];
    return {
      ...stories[storyIndex],
      index: storyIndex
    };
  }

  /**
   * Spawn a worker for a story
   * @param {number} runId - Run ID
   * @param {Object} story - Story object with index
   */
  async spawnStoryWorker(runId, story) {
    const runState = this.activeRuns.get(runId);
    const run = getRun(runId);

    if (!runState || !run) {
      console.error(`[RalphService] Run ${runId} state lost`);
      return;
    }

    const prd = run.prd;
    const projectPath = prd.project_path;

    // Generate unique completion token for this worker
    const completionToken = generateCompletionToken();

    // Build the prompt with the token
    const previousProgress = getLatestProgressEntry(runId);
    const prompt = this.buildStoryPrompt(story, previousProgress, prd, completionToken);

    console.log(`[RalphService] Spawning worker for story ${story.index}: ${story.title} (token: ${completionToken})`);

    try {
      // Spawn worker
      const worker = await spawnWorker(projectPath, `RALPH: ${story.title}`, this.io, {
        autoAccept: true,
        task: {
          description: story.title,
          type: 'implementation',
          context: previousProgress?.content || ''
        },
        initialInput: prompt
      });

      runState.currentWorkerId = worker.id;
      runState.currentStoryIndex = story.index;
      runState.completionToken = completionToken;

      // Register completion token for API callback
      pendingCompletions.set(completionToken, {
        runId,
        storyIndex: story.index,
        workerId: worker.id
      });

      // Update story status
      setStoryStatus(runId, story.index, 'in_progress', worker.id);

      this.io?.emit('ralph:story:started', {
        runId,
        storyIndex: story.index,
        storyTitle: story.title,
        workerId: worker.id,
        iteration: runState.iteration
      });

      // Start health monitoring (completion is signaled via API)
      setTimeout(() => {
        this.monitorWorkerHealth(runId, worker.id, story.index, completionToken);
      }, WORKER_SPAWN_DELAY);

    } catch (err) {
      console.error(`[RalphService] Failed to spawn worker:`, err.message);
      completeStory(runId, story.index, 'failed', err.message);
      this.io?.emit('ralph:story:failed', {
        runId,
        storyIndex: story.index,
        error: err.message
      });

      // Try next story
      await this.runIteration(runId);
    }
  }

  /**
   * Monitor worker health (completion is signaled via API callback)
   * @param {number} runId - Run ID
   * @param {string} workerId - Worker ID
   * @param {number} storyIndex - Story index
   * @param {string} completionToken - Token for this worker
   */
  monitorWorkerHealth(runId, workerId, storyIndex, completionToken) {
    const runState = this.activeRuns.get(runId);
    if (!runState) return;

    console.log(`[RalphService] Monitoring worker ${workerId} health (token: ${completionToken})`);

    // Clear any existing poll interval
    if (runState.pollInterval) {
      clearInterval(runState.pollInterval);
    }

    runState.pollInterval = setInterval(async () => {
      // Check if run is still active
      if (!this.activeRuns.has(runId)) {
        clearInterval(runState.pollInterval);
        return;
      }

      // Check if worker still exists
      const worker = getWorker(workerId);
      if (!worker || worker.status !== 'running') {
        console.log(`[RalphService] Worker ${workerId} no longer running`);
        clearInterval(runState.pollInterval);
        runState.pollInterval = null;

        // Clean up pending completion
        pendingCompletions.delete(completionToken);

        // Worker died unexpectedly (if not already completed via API)
        const storyStatuses = getStoryStatuses(runId);
        const story = storyStatuses.find(s => s.story_index === storyIndex);
        if (story && story.status === 'in_progress') {
          await this.handleStoryFailed(runId, storyIndex, 'Worker terminated unexpectedly');
        }
        return;
      }

      // Emit progress update
      this.io?.emit('ralph:run:progress', {
        runId,
        iteration: runState.iteration,
        storyIndex,
        status: 'working'
      });
    }, HEALTH_CHECK_INTERVAL);
  }

  /**
   * Handle completion signal from API callback
   * @param {string} token - Completion token
   * @param {string} status - 'done' or 'blocked'
   * @param {Object} signalData - Signal data object containing:
   *   - status: 'in_progress', 'done', or 'blocked'
   *   - progress: 0-100 percentage (optional)
   *   - currentStep: Current step description (optional)
   *   - reason: Reason if blocked (optional)
   *   - learnings: Summary/notes (optional)
   *   - outputs: Structured outputs { key: value } (optional)
   *   - artifacts: Array of file paths created (optional)
   * @returns {boolean} True if token was valid
   */
  async handleCompletionSignal(token, signalData) {
    const context = pendingCompletions.get(token);
    if (!context) {
      console.log(`[RalphService] Unknown completion token: ${token}`);
      return false;
    }

    const { runId, storyIndex, workerId, standalone } = context;
    const { status, progress, currentStep, reason, learnings, outputs, artifacts } = signalData;
    console.log(`[RalphService] Completion signal received for worker ${workerId}: ${status}${progress !== undefined ? ` (${progress}%)` : ''} (standalone: ${!!standalone})`);

    // Don't delete token for in_progress signals - only for terminal states
    if (status === 'done' || status === 'blocked') {
      pendingCompletions.delete(token);
    }

    // Handle standalone worker (not part of a PRD run)
    if (standalone) {
      // Update worker's Ralph status for parent workers to query
      updateWorkerRalphStatus(workerId, signalData, this.io);

      this.io?.emit('ralph:worker:signaled', {
        workerId,
        status,
        progress,
        currentStep,
        reason,
        learnings,
        outputs,
        artifacts
      });
      console.log(`[RalphService] Standalone worker ${workerId} signaled: ${status}`);
      return true;
    }

    // PRD run handling
    // Stop health monitoring
    const runState = this.activeRuns.get(runId);
    if (runState?.pollInterval) {
      clearInterval(runState.pollInterval);
      runState.pollInterval = null;
    }

    // Get worker output for learnings extraction
    const output = getWorkerOutput(workerId);

    if (status === 'done') {
      await this.handleStoryComplete(runId, storyIndex, workerId, output, learnings);
    } else if (status === 'blocked') {
      await this.handleStoryBlocked(runId, storyIndex, reason || 'Unknown reason');
    }

    return true;
  }

  // =====================
  // Standalone Worker Ralph Mode
  // =====================

  /**
   * Register a standalone worker for Ralph completion signaling
   * @param {string} token - Completion token
   * @param {string} workerId - Worker ID
   */
  registerStandaloneWorker(token, workerId) {
    pendingCompletions.set(token, {
      workerId,
      standalone: true
    });
    console.log(`[RalphService] Registered standalone worker ${workerId} with token ${token}`);
  }

  /**
   * Unregister a standalone worker's token
   * @param {string} token - Completion token
   */
  unregisterStandaloneWorker(token) {
    if (pendingCompletions.has(token)) {
      pendingCompletions.delete(token);
      console.log(`[RalphService] Unregistered standalone token ${token}`);
    }
  }

  /**
   * Handle story completion
   * @param {number} runId - Run ID
   * @param {number} storyIndex - Story index
   * @param {string} workerId - Worker ID
   * @param {string} output - Worker output
   * @param {string} providedLearnings - Optional learnings from API callback
   */
  async handleStoryComplete(runId, storyIndex, workerId, output, providedLearnings = null) {
    const runState = this.activeRuns.get(runId);

    // Mark story as complete
    completeStory(runId, storyIndex, 'completed');

    // Store learnings (prefer provided learnings, fall back to extraction)
    const learnings = providedLearnings || this.extractLearnings(output);
    if (learnings) {
      storeProgress(runId, runState?.iteration || 0, learnings, storyIndex);
    }

    // Kill the worker (it's done)
    try {
      await killWorker(workerId, this.io);
    } catch (err) {
      console.error(`[RalphService] Failed to kill worker ${workerId}:`, err.message);
    }

    // Clear current worker
    if (runState) {
      runState.currentWorkerId = null;
      runState.currentStoryIndex = null;
    }

    this.io?.emit('ralph:story:complete', {
      runId,
      storyIndex,
      success: true
    });

    console.log(`[RalphService] Story ${storyIndex} completed for run ${runId}`);

    // Start next iteration
    await this.runIteration(runId);
  }

  /**
   * Handle story blocked
   * @param {number} runId - Run ID
   * @param {number} storyIndex - Story index
   * @param {string} reason - Block reason
   */
  async handleStoryBlocked(runId, storyIndex, reason) {
    const runState = this.activeRuns.get(runId);

    // Mark story as blocked (we'll retry it later)
    completeStory(runId, storyIndex, 'blocked', reason);

    // Store the block reason as progress
    storeProgress(runId, runState?.iteration || 0, `BLOCKED: ${reason}`, storyIndex);

    // Kill current worker
    if (runState?.currentWorkerId) {
      try {
        await killWorker(runState.currentWorkerId, this.io);
      } catch (err) {
        console.error(`[RalphService] Failed to kill worker:`, err.message);
      }
      runState.currentWorkerId = null;
      runState.currentStoryIndex = null;
    }

    this.io?.emit('ralph:story:blocked', {
      runId,
      storyIndex,
      reason
    });

    console.log(`[RalphService] Story ${storyIndex} blocked: ${reason}`);

    // Continue with next story
    await this.runIteration(runId);
  }

  /**
   * Handle story failure
   * @param {number} runId - Run ID
   * @param {number} storyIndex - Story index
   * @param {string} error - Error message
   */
  async handleStoryFailed(runId, storyIndex, error) {
    const runState = this.activeRuns.get(runId);

    completeStory(runId, storyIndex, 'failed', error);

    if (runState) {
      runState.currentWorkerId = null;
      runState.currentStoryIndex = null;
    }

    this.io?.emit('ralph:story:failed', {
      runId,
      storyIndex,
      error
    });

    console.log(`[RalphService] Story ${storyIndex} failed: ${error}`);

    // Continue with next story
    await this.runIteration(runId);
  }

  /**
   * Handle all stories complete
   * @param {number} runId - Run ID
   */
  async handleAllStoriesComplete(runId) {
    this.activeRuns.delete(runId);
    completeRun(runId, 'completed');

    this.io?.emit('ralph:run:completed', {
      runId,
      success: true,
      message: 'All stories completed successfully'
    });

    console.log(`[RalphService] Run ${runId} completed - all stories done!`);
  }

  /**
   * Handle max iterations reached
   * @param {number} runId - Run ID
   */
  async handleMaxIterationsReached(runId) {
    const runState = this.activeRuns.get(runId);

    // Kill current worker if any
    if (runState?.currentWorkerId) {
      try {
        await killWorker(runState.currentWorkerId, this.io);
      } catch (err) {
        console.error(`[RalphService] Failed to kill worker:`, err.message);
      }
    }

    this.activeRuns.delete(runId);
    completeRun(runId, 'max_iterations', 'Maximum iterations reached');

    this.io?.emit('ralph:run:completed', {
      runId,
      success: false,
      message: 'Maximum iterations reached'
    });

    console.log(`[RalphService] Run ${runId} stopped - max iterations reached`);
  }

  // =====================
  // Prompt Building
  // =====================

  /**
   * Build the prompt for a story
   * @param {Object} story - Story object
   * @param {Object} previousProgress - Previous progress entry
   * @param {Object} prd - PRD object
   * @param {string} completionToken - Unique token for completion signal
   * @returns {string} Prompt text
   */
  buildStoryPrompt(story, previousProgress, prd, completionToken) {
    const acceptanceCriteria = (story.acceptanceCriteria || [])
      .map((c, i) => `${i + 1}. ${c}`)
      .join('\n');

    const progressSection = previousProgress
      ? `\n### Learnings from Previous Iterations\n${previousProgress.content}\n`
      : '';

    return `## Your Task: ${story.title}

Priority: ${story.priority || 'N/A'}
PRD: ${prd.name}

### Description
${story.description || 'No description provided.'}

### Acceptance Criteria
${acceptanceCriteria || 'No acceptance criteria specified.'}
${progressSection}
## Workflow

1. Implement the feature to satisfy ALL acceptance criteria
2. Run quality checks (tests, lint, typecheck as applicable)
3. If all checks pass, commit your changes with a descriptive message
4. Signal completion by running this curl command:
   curl -X POST http://localhost:38007/api/ralph/signal/${completionToken} -H "Content-Type: application/json" -d '{"status":"done"}'

If blocked, signal with:
   curl -X POST http://localhost:38007/api/ralph/signal/${completionToken} -H "Content-Type: application/json" -d '{"status":"blocked","reason":"describe the blocker"}'

## Important Notes

- Focus only on this story - do not implement other stories
- Keep changes minimal and focused on the acceptance criteria
- Commit frequently as you make progress
- Document any important decisions or patterns discovered
`;
  }

  /**
   * Extract learnings from worker output
   * @param {string} output - Worker output
   * @returns {string|null} Extracted learnings
   */
  extractLearnings(output) {
    // Look for patterns that indicate learnings
    const learningPatterns = [
      /(?:learned?|discovered?|noted?|important):\s*(.+)/gi,
      /(?:pattern|convention|gotcha):\s*(.+)/gi,
      /(?:commit(?:ted)?|pushed?):\s*(.+)/gi
    ];

    const learnings = [];

    for (const pattern of learningPatterns) {
      let match;
      while ((match = pattern.exec(output)) !== null) {
        learnings.push(match[1].trim());
      }
    }

    if (learnings.length === 0) {
      // Just store a summary that the story was completed
      return 'Story completed successfully.';
    }

    return learnings.join('\n');
  }

  /**
   * Cleanup - called on shutdown
   */
  async cleanup() {
    console.log('[RalphService] Cleaning up...');

    for (const [runId, runState] of this.activeRuns) {
      if (runState.pollInterval) {
        clearInterval(runState.pollInterval);
      }
      // Don't kill workers on shutdown - they can continue
      setRunStatus(runId, 'paused');
    }

    this.activeRuns.clear();
  }
}

/**
 * Create and return a RalphService instance
 * @param {Object} io - Socket.io instance
 * @returns {RalphService} Service instance
 */
export function createRalphService(io) {
  return new RalphService(io);
}

export default RalphService;
