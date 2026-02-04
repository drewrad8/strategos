/**
 * SelfOptimizeService - Automated Test-Fix Cycles
 *
 * Implements the CRITIC framework pattern: LLMs cannot self-correct without
 * external feedback. This service provides that feedback through test execution,
 * enabling iterative improvement cycles.
 *
 * Core Loop:
 * 1. Run tests (external verification)
 * 2. Parse test output (external feedback)
 * 3. Spawn FIX: worker with failure details
 * 4. Wait for fix completion
 * 5. Re-run tests (verify correction)
 * 6. Repeat until success or max iterations
 *
 * Based on research from:
 * - 11-critic-framework-self-correction.md
 * - 05-self-testing-frameworks.md
 *
 * @see /research/11-critic-framework-self-correction.md
 * @see /research/05-self-testing-frameworks.md
 */

import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

const execAsync = promisify(exec);

// Optimization cycle states
export const CycleState = {
  IDLE: 'idle',
  RUNNING_TESTS: 'running_tests',
  PARSING_RESULTS: 'parsing_results',
  SPAWNING_FIX_WORKER: 'spawning_fix_worker',
  WAITING_FOR_FIX: 'waiting_for_fix',
  VERIFYING_FIX: 'verifying_fix',
  COMPLETED: 'completed',
  FAILED: 'failed'
};

// Stop reasons for cycle termination
export const StopReasons = {
  ALL_TESTS_PASS: 'all_tests_pass',
  MAX_ITERATIONS: 'max_iterations',
  NO_IMPROVEMENT: 'no_improvement',
  FIX_WORKER_FAILED: 'fix_worker_failed',
  TEST_EXECUTION_ERROR: 'test_execution_error',
  USER_CANCELLED: 'user_cancelled'
};

// Test framework detection patterns
const TEST_FRAMEWORKS = {
  jest: {
    detectFile: 'jest.config',
    command: 'npm test',
    failurePattern: /FAIL\s+(.+)/g,
    errorPattern: /●\s+(.+)/g,
    passPattern: /PASS\s+/g,
    summaryPattern: /Tests:\s+(\d+)\s+failed,\s+(\d+)\s+passed/,
    allPassPattern: /Tests:\s+(\d+)\s+passed/
  },
  playwright: {
    detectFile: 'playwright.config',
    command: 'npm test',
    failurePattern: /✘\s+\[.+\]\s+(.+)/g,
    errorPattern: /Error:.+/g,
    passPattern: /✓\s+/g,
    summaryPattern: /(\d+)\s+failed/,
    allPassPattern: /(\d+)\s+passed/
  },
  vitest: {
    detectFile: 'vitest.config',
    command: 'npm test',
    failurePattern: /FAIL\s+(.+)/g,
    errorPattern: /Error:.+/g,
    passPattern: /✓/g,
    summaryPattern: /(\d+)\s+failed/,
    allPassPattern: /(\d+)\s+passed/
  },
  mocha: {
    detectFile: '.mocharc',
    command: 'npm test',
    failurePattern: /failing/g,
    errorPattern: /\d+\)\s+(.+)/g,
    passPattern: /passing/g,
    summaryPattern: /(\d+)\s+failing/,
    allPassPattern: /(\d+)\s+passing/
  },
  generic: {
    detectFile: null,
    command: 'npm test',
    failurePattern: /fail|error|FAIL|ERROR/gi,
    errorPattern: /Error:.+/g,
    passPattern: /pass|PASS/gi,
    summaryPattern: /(\d+)\s+fail/i,
    allPassPattern: /(\d+)\s+pass/i
  }
};

/**
 * SelfOptimizeService - Coordinates automated test-fix cycles
 */
export class SelfOptimizeService {
  /**
   * @param {Object} options - Configuration options
   * @param {Object} options.workerManager - Worker management functions
   * @param {Object} options.io - Socket.io instance for real-time updates
   * @param {number} options.maxIterations - Maximum fix attempts (default: 5)
   * @param {number} options.testTimeout - Test execution timeout in ms (default: 120000)
   */
  constructor({ workerManager = null, io = null, maxIterations = 5, testTimeout = 120000 }) {
    this.workerManager = workerManager;
    this.io = io;
    this.maxIterations = maxIterations;
    this.testTimeout = testTimeout;

    // Active optimization cycles
    this.activeCycles = new Map();

    // Metrics tracking
    this.metrics = {
      cyclesStarted: 0,
      cyclesCompleted: 0,
      cyclesFailed: 0,
      totalIterations: 0,
      fixWorkersSpawned: 0,
      testsRun: 0
    };
  }

  /**
   * Set Socket.io instance for real-time updates
   * @param {Object} io - Socket.io instance
   */
  setSocketIO(io) {
    this.io = io;
  }

  /**
   * Set worker manager for spawning fix workers
   * @param {Object} workerManager - Worker manager module
   */
  setWorkerManager(workerManager) {
    this.workerManager = workerManager;
  }

  /**
   * Start an optimization cycle for a project
   *
   * @param {string} projectPath - Path to the project
   * @param {Object} options - Cycle options
   * @param {string} options.testCommand - Custom test command (optional)
   * @param {string} options.testPattern - Pattern to filter tests (optional)
   * @param {number} options.maxIterations - Override max iterations
   * @param {boolean} options.autoSpawnFix - Auto-spawn fix workers (default: true)
   * @returns {Promise<Object>} Cycle result
   */
  async startCycle(projectPath, options = {}) {
    const {
      testCommand = null,
      testPattern = null,
      maxIterations = this.maxIterations,
      autoSpawnFix = true
    } = options;

    const cycleId = uuidv4().slice(0, 8);
    const projectName = path.basename(projectPath);

    // Detect test framework if no custom command
    const framework = testCommand ? 'custom' : await this.detectTestFramework(projectPath);
    const finalTestCommand = testCommand || this.getTestCommand(framework, testPattern);

    const cycle = {
      id: cycleId,
      projectPath,
      projectName,
      framework,
      testCommand: finalTestCommand,
      state: CycleState.IDLE,
      iteration: 0,
      maxIterations,
      autoSpawnFix,
      history: [],
      startedAt: new Date(),
      completedAt: null,
      stopReason: null,
      lastTestResult: null,
      activeFixWorkerId: null
    };

    this.activeCycles.set(cycleId, cycle);
    this.metrics.cyclesStarted++;

    console.log(`[SelfOptimizeService] Starting optimization cycle ${cycleId} for ${projectName}`);

    // Emit start event
    if (this.io) {
      this.io.emit('optimize:start', {
        cycleId,
        projectName,
        framework,
        testCommand: finalTestCommand
      });
    }

    try {
      // Run the optimization loop
      const result = await this.runOptimizationLoop(cycleId);
      return result;
    } catch (error) {
      cycle.state = CycleState.FAILED;
      cycle.stopReason = StopReasons.TEST_EXECUTION_ERROR;
      cycle.completedAt = new Date();
      this.metrics.cyclesFailed++;

      if (this.io) {
        this.io.emit('optimize:error', {
          cycleId,
          error: error.message
        });
      }

      throw error;
    }
  }

  /**
   * Run the optimization loop for a cycle
   * @param {string} cycleId - Cycle ID
   * @returns {Promise<Object>} Final result
   */
  async runOptimizationLoop(cycleId) {
    const cycle = this.activeCycles.get(cycleId);
    if (!cycle) {
      throw new Error(`Cycle ${cycleId} not found`);
    }

    let previousFailureCount = Infinity;

    while (cycle.iteration < cycle.maxIterations) {
      cycle.iteration++;
      this.metrics.totalIterations++;

      console.log(`[SelfOptimizeService] Cycle ${cycleId} iteration ${cycle.iteration}/${cycle.maxIterations}`);

      // Step 1: Run tests
      cycle.state = CycleState.RUNNING_TESTS;
      this.emitProgress(cycleId, 'Running tests...');

      const testResult = await this.runTests(cycle.projectPath, cycle.testCommand);
      cycle.lastTestResult = testResult;
      this.metrics.testsRun++;

      // Record iteration in history
      cycle.history.push({
        iteration: cycle.iteration,
        testResult: {
          passed: testResult.passed,
          failed: testResult.failed,
          errors: testResult.errors.slice(0, 5), // Limit stored errors
          allPassed: testResult.allPassed
        },
        timestamp: new Date()
      });

      // Step 2: Check if all tests pass
      if (testResult.allPassed) {
        cycle.state = CycleState.COMPLETED;
        cycle.stopReason = StopReasons.ALL_TESTS_PASS;
        cycle.completedAt = new Date();
        this.metrics.cyclesCompleted++;

        console.log(`[SelfOptimizeService] Cycle ${cycleId} completed - all tests pass!`);

        if (this.io) {
          this.io.emit('optimize:complete', {
            cycleId,
            stopReason: cycle.stopReason,
            iterations: cycle.iteration,
            history: cycle.history
          });
        }

        return this.getCycleResult(cycleId);
      }

      // Step 3: Check for improvement
      if (testResult.failed >= previousFailureCount) {
        // No improvement - but don't stop immediately, might need more tries
        if (cycle.iteration >= 3 && testResult.failed >= previousFailureCount) {
          cycle.state = CycleState.FAILED;
          cycle.stopReason = StopReasons.NO_IMPROVEMENT;
          cycle.completedAt = new Date();
          this.metrics.cyclesFailed++;

          console.log(`[SelfOptimizeService] Cycle ${cycleId} stopped - no improvement after 3 iterations`);

          if (this.io) {
            this.io.emit('optimize:failed', {
              cycleId,
              stopReason: cycle.stopReason,
              remainingFailures: testResult.failed,
              iterations: cycle.iteration
            });
          }

          return this.getCycleResult(cycleId);
        }
      }
      previousFailureCount = testResult.failed;

      // Step 4: Spawn fix worker if auto-spawn enabled
      if (cycle.autoSpawnFix && this.workerManager) {
        cycle.state = CycleState.SPAWNING_FIX_WORKER;
        this.emitProgress(cycleId, 'Spawning fix worker...');

        try {
          const fixWorker = await this.spawnFixWorker(cycle, testResult);
          cycle.activeFixWorkerId = fixWorker.id;
          this.metrics.fixWorkersSpawned++;

          // Step 5: Wait for fix worker to complete
          cycle.state = CycleState.WAITING_FOR_FIX;
          this.emitProgress(cycleId, `Waiting for fix worker ${fixWorker.id}...`);

          await this.waitForWorkerCompletion(fixWorker.id, cycle);

          cycle.history[cycle.history.length - 1].fixWorkerId = fixWorker.id;

        } catch (error) {
          console.error(`[SelfOptimizeService] Fix worker failed:`, error.message);
          // Continue to next iteration anyway
        }
      } else {
        // No auto-spawn - return partial result for manual intervention
        cycle.state = CycleState.COMPLETED;
        cycle.stopReason = 'manual_intervention_required';
        cycle.completedAt = new Date();

        if (this.io) {
          this.io.emit('optimize:manual_required', {
            cycleId,
            testResult,
            iteration: cycle.iteration
          });
        }

        return this.getCycleResult(cycleId);
      }
    }

    // Max iterations reached
    cycle.state = CycleState.FAILED;
    cycle.stopReason = StopReasons.MAX_ITERATIONS;
    cycle.completedAt = new Date();
    this.metrics.cyclesFailed++;

    console.log(`[SelfOptimizeService] Cycle ${cycleId} stopped - max iterations reached`);

    if (this.io) {
      this.io.emit('optimize:failed', {
        cycleId,
        stopReason: cycle.stopReason,
        iterations: cycle.iteration,
        remainingFailures: cycle.lastTestResult?.failed || 0
      });
    }

    return this.getCycleResult(cycleId);
  }

  /**
   * Run tests and parse results
   * @param {string} projectPath - Project path
   * @param {string} testCommand - Test command to run
   * @returns {Promise<Object>} Test results
   */
  async runTests(projectPath, testCommand) {
    return new Promise((resolve) => {
      const result = {
        passed: 0,
        failed: 0,
        errors: [],
        rawOutput: '',
        allPassed: false,
        exitCode: null,
        duration: 0
      };

      const startTime = Date.now();

      // Run test command
      const proc = spawn('sh', ['-c', testCommand], {
        cwd: projectPath,
        env: { ...process.env, CI: 'true', FORCE_COLOR: '0' }
      });

      let output = '';

      proc.stdout.on('data', (data) => {
        output += data.toString();
      });

      proc.stderr.on('data', (data) => {
        output += data.toString();
      });

      proc.on('close', (code) => {
        result.exitCode = code;
        result.rawOutput = output;
        result.duration = Date.now() - startTime;

        // Parse results
        const parsed = this.parseTestOutput(output);
        result.passed = parsed.passed;
        result.failed = parsed.failed;
        result.errors = parsed.errors;
        result.allPassed = code === 0 && parsed.failed === 0;

        resolve(result);
      });

      proc.on('error', (err) => {
        result.errors.push(`Test execution error: ${err.message}`);
        resolve(result);
      });

      // Timeout
      setTimeout(() => {
        proc.kill();
        result.errors.push('Test execution timed out');
        resolve(result);
      }, this.testTimeout);
    });
  }

  /**
   * Parse test output to extract failures
   * @param {string} output - Raw test output
   * @returns {Object} Parsed results
   */
  parseTestOutput(output) {
    const result = {
      passed: 0,
      failed: 0,
      errors: []
    };

    // Try to extract numbers from common patterns
    const failMatch = output.match(/(\d+)\s*(failed|failing|failures?)/i);
    if (failMatch) {
      result.failed = parseInt(failMatch[1], 10);
    }

    const passMatch = output.match(/(\d+)\s*(passed|passing)/i);
    if (passMatch) {
      result.passed = parseInt(passMatch[1], 10);
    }

    // Extract error messages (lines starting with Error:, or lines with ✘/✗/×)
    const lines = output.split('\n');
    let inErrorBlock = false;
    let currentError = [];

    for (const line of lines) {
      // Detect error starts
      if (line.match(/^\s*(Error:|AssertionError:|TypeError:|ReferenceError:|✘|✗|×|FAIL)/)) {
        if (currentError.length > 0) {
          result.errors.push(currentError.join('\n').trim());
        }
        currentError = [line];
        inErrorBlock = true;
      } else if (inErrorBlock) {
        // Continue collecting error context
        if (line.match(/^\s*at\s+/) || line.trim().length > 0) {
          currentError.push(line);
          // Limit error context
          if (currentError.length > 10) {
            inErrorBlock = false;
            result.errors.push(currentError.join('\n').trim());
            currentError = [];
          }
        } else if (line.trim().length === 0) {
          // Empty line ends error block
          inErrorBlock = false;
          if (currentError.length > 0) {
            result.errors.push(currentError.join('\n').trim());
            currentError = [];
          }
        }
      }
    }

    // Add any remaining error
    if (currentError.length > 0) {
      result.errors.push(currentError.join('\n').trim());
    }

    // Limit total errors
    result.errors = result.errors.slice(0, 10);

    return result;
  }

  /**
   * Spawn a FIX: worker to address test failures
   * @param {Object} cycle - Current cycle
   * @param {Object} testResult - Test results with failures
   * @returns {Promise<Object>} Spawned worker
   */
  async spawnFixWorker(cycle, testResult) {
    if (!this.workerManager?.spawnWorker) {
      throw new Error('Worker manager not available');
    }

    // Format error details for the fix worker
    const errorSummary = testResult.errors.slice(0, 5).join('\n\n---\n\n');

    const task = `FIX TEST FAILURES

## Test Results
- Failed: ${testResult.failed}
- Passed: ${testResult.passed}
- Iteration: ${cycle.iteration}/${cycle.maxIterations}

## Errors to Fix
\`\`\`
${errorSummary}
\`\`\`

## Instructions
1. Analyze the test failures above
2. Identify the root cause of each failure
3. Make the minimal changes necessary to fix the tests
4. Run \`${cycle.testCommand}\` to verify your fixes work
5. Do NOT modify tests to make them pass - fix the actual code

## Important
- Focus on the errors shown above
- Make incremental fixes
- Verify each fix before moving to the next
- If a fix requires significant changes, explain why`;

    const label = `FIX: Test Failures (Iteration ${cycle.iteration})`;

    const worker = await this.workerManager.spawnWorker(
      cycle.projectPath,
      label,
      this.io,
      { onComplete: null }
    );

    // Send task to the worker
    if (this.workerManager.sendInput) {
      await this.workerManager.sendInput(worker.id, task);
    }

    return worker;
  }

  /**
   * Wait for a worker to complete
   * @param {string} workerId - Worker ID
   * @param {Object} cycle - Current cycle
   * @param {number} timeout - Timeout in ms (default: 5 minutes)
   * @returns {Promise<void>}
   */
  async waitForWorkerCompletion(workerId, cycle, timeout = 300000) {
    const startTime = Date.now();
    const pollInterval = 5000;

    return new Promise((resolve, reject) => {
      const checkInterval = setInterval(async () => {
        try {
          if (!this.workerManager?.getWorker) {
            clearInterval(checkInterval);
            resolve();
            return;
          }

          const worker = this.workerManager.getWorker(workerId);

          if (!worker) {
            // Worker was deleted or doesn't exist
            clearInterval(checkInterval);
            resolve();
            return;
          }

          if (worker.status === 'completed' || worker.status === 'stopped') {
            clearInterval(checkInterval);
            resolve();
            return;
          }

          // Check timeout
          if (Date.now() - startTime > timeout) {
            clearInterval(checkInterval);
            console.log(`[SelfOptimizeService] Fix worker ${workerId} timed out`);
            resolve(); // Continue anyway
            return;
          }

          // Emit progress
          this.emitProgress(cycle.id, `Waiting for fix worker... (${Math.floor((Date.now() - startTime) / 1000)}s)`);

        } catch (err) {
          // Continue even on errors
        }
      }, pollInterval);
    });
  }

  /**
   * Detect the test framework used in a project
   * @param {string} projectPath - Project path
   * @returns {Promise<string>} Framework name
   */
  async detectTestFramework(projectPath) {
    try {
      const { stdout } = await execAsync(`ls -la "${projectPath}"`, { encoding: 'utf8' });

      for (const [framework, config] of Object.entries(TEST_FRAMEWORKS)) {
        if (config.detectFile && stdout.includes(config.detectFile)) {
          return framework;
        }
      }

      // Check package.json for test framework dependencies
      try {
        const { stdout: pkgJson } = await execAsync(`cat "${path.join(projectPath, 'package.json')}"`, { encoding: 'utf8' });
        if (pkgJson.includes('playwright')) return 'playwright';
        if (pkgJson.includes('vitest')) return 'vitest';
        if (pkgJson.includes('jest')) return 'jest';
        if (pkgJson.includes('mocha')) return 'mocha';
      } catch {
        // No package.json
      }

    } catch {
      // Fall through to generic
    }

    return 'generic';
  }

  /**
   * Get the test command for a framework
   * @param {string} framework - Framework name
   * @param {string} pattern - Optional test pattern filter
   * @returns {string} Test command
   */
  getTestCommand(framework, pattern = null) {
    const config = TEST_FRAMEWORKS[framework] || TEST_FRAMEWORKS.generic;
    let command = config.command;

    if (pattern) {
      command += ` -- --grep "${pattern}"`;
    }

    return command;
  }

  /**
   * Get cycle result
   * @param {string} cycleId - Cycle ID
   * @returns {Object} Cycle result
   */
  getCycleResult(cycleId) {
    const cycle = this.activeCycles.get(cycleId);
    if (!cycle) {
      return null;
    }

    return {
      cycleId: cycle.id,
      projectName: cycle.projectName,
      projectPath: cycle.projectPath,
      framework: cycle.framework,
      state: cycle.state,
      stopReason: cycle.stopReason,
      iterations: cycle.iteration,
      maxIterations: cycle.maxIterations,
      history: cycle.history,
      lastTestResult: cycle.lastTestResult ? {
        passed: cycle.lastTestResult.passed,
        failed: cycle.lastTestResult.failed,
        allPassed: cycle.lastTestResult.allPassed
      } : null,
      startedAt: cycle.startedAt,
      completedAt: cycle.completedAt,
      duration: cycle.completedAt
        ? cycle.completedAt - cycle.startedAt
        : Date.now() - cycle.startedAt
    };
  }

  /**
   * Cancel an active cycle
   * @param {string} cycleId - Cycle ID
   * @returns {boolean} Success
   */
  cancelCycle(cycleId) {
    const cycle = this.activeCycles.get(cycleId);
    if (!cycle) {
      return false;
    }

    cycle.state = CycleState.FAILED;
    cycle.stopReason = StopReasons.USER_CANCELLED;
    cycle.completedAt = new Date();

    if (this.io) {
      this.io.emit('optimize:cancelled', { cycleId });
    }

    return true;
  }

  /**
   * Get active cycles
   * @returns {Array} Active cycle summaries
   */
  getActiveCycles() {
    return Array.from(this.activeCycles.values()).map(cycle => ({
      cycleId: cycle.id,
      projectName: cycle.projectName,
      state: cycle.state,
      iteration: cycle.iteration,
      maxIterations: cycle.maxIterations
    }));
  }

  /**
   * Get service metrics
   * @returns {Object} Metrics
   */
  getMetrics() {
    return {
      ...this.metrics,
      activeCycles: this.activeCycles.size,
      successRate: this.metrics.cyclesStarted > 0
        ? this.metrics.cyclesCompleted / this.metrics.cyclesStarted
        : 0,
      avgIterationsPerCycle: this.metrics.cyclesStarted > 0
        ? this.metrics.totalIterations / this.metrics.cyclesStarted
        : 0
    };
  }

  /**
   * Reset metrics
   */
  resetMetrics() {
    this.metrics = {
      cyclesStarted: 0,
      cyclesCompleted: 0,
      cyclesFailed: 0,
      totalIterations: 0,
      fixWorkersSpawned: 0,
      testsRun: 0
    };
  }

  /**
   * Emit progress update
   * @param {string} cycleId - Cycle ID
   * @param {string} message - Progress message
   */
  emitProgress(cycleId, message) {
    if (this.io) {
      this.io.emit('optimize:progress', { cycleId, message });
    }
  }
}

// Singleton instance holder
let selfOptimizeServiceInstance = null;

/**
 * Get or create the SelfOptimizeService singleton
 * @param {Object} options - Options for creation
 * @returns {SelfOptimizeService} Service instance
 */
export function getSelfOptimizeService(options = {}) {
  if (!selfOptimizeServiceInstance) {
    selfOptimizeServiceInstance = new SelfOptimizeService(options);
  }
  return selfOptimizeServiceInstance;
}

/**
 * Create a new SelfOptimizeService instance
 * @param {Object} options - Options
 * @returns {SelfOptimizeService} New instance
 */
export function createSelfOptimizeService(options) {
  return new SelfOptimizeService(options);
}

export default SelfOptimizeService;
