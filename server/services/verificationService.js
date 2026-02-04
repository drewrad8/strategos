/**
 * VerificationService - CRITIC Framework Integration for Workers
 *
 * Integrates the VerificationPipeline and SelfCorrectionLoop with the
 * worker management system. Based on research finding that LLMs cannot
 * self-correct without external feedback.
 *
 * @see /research/11-critic-framework-self-correction.md
 */

import { sendInput, getWorkerOutput, getWorker } from '../workerManager.js';

// Task types for verification
export const TaskTypes = {
  CODE: 'code',
  FACTUAL: 'factual',
  REASONING: 'reasoning',
  FORMAT: 'format'
};

// Worker task context storage
const workerTaskContexts = new Map();

/**
 * VerificationService - Coordinates verification and correction for workers
 */
export class VerificationService {
  /**
   * @param {Object} options - Configuration options
   * @param {Object} options.verificationPipeline - VerificationPipeline instance
   * @param {Object} options.selfCorrectionLoop - SelfCorrectionLoop instance
   * @param {Object} options.io - Socket.io instance for real-time updates
   */
  constructor({ verificationPipeline, selfCorrectionLoop, io = null }) {
    if (!verificationPipeline) {
      throw new Error('verificationPipeline is required');
    }
    if (!selfCorrectionLoop) {
      throw new Error('selfCorrectionLoop is required');
    }

    this.pipeline = verificationPipeline;
    this.correctionLoop = selfCorrectionLoop;
    this.io = io;

    // Metrics tracking
    this.metrics = {
      verificationsRun: 0,
      verificationsValid: 0,
      correctionLoopsRun: 0,
      correctionLoopsSuccessful: 0
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
   * Register task context for a worker (call during spawn)
   *
   * @param {string} workerId - Worker ID
   * @param {Object} context - Task context
   * @param {string} context.taskType - One of TaskTypes (code, factual, reasoning, format)
   * @param {Object} context.verificationContext - Additional context for verification
   * @param {string} context.testCommand - Optional test command for code verification
   * @param {string} context.lintCommand - Optional lint command for code verification
   * @param {Array} context.requiredFields - Optional required fields for format verification
   * @param {Object} context.schema - Optional JSON schema for format verification
   */
  registerTaskContext(workerId, context) {
    const taskContext = {
      taskType: context.taskType || TaskTypes.CODE,
      verificationContext: context.verificationContext || {},
      testCommand: context.testCommand || null,
      lintCommand: context.lintCommand || null,
      requiredFields: context.requiredFields || null,
      schema: context.schema || null,
      registeredAt: new Date().toISOString()
    };

    workerTaskContexts.set(workerId, taskContext);

    console.log(`[VerificationService] Registered task context for worker ${workerId}: ${taskContext.taskType}`);

    return taskContext;
  }

  /**
   * Get task context for a worker
   * @param {string} workerId - Worker ID
   * @returns {Object|null} Task context or null if not registered
   */
  getTaskContext(workerId) {
    return workerTaskContexts.get(workerId) || null;
  }

  /**
   * Remove task context when worker is cleaned up
   * @param {string} workerId - Worker ID
   */
  removeTaskContext(workerId) {
    workerTaskContexts.delete(workerId);
  }

  /**
   * Verify worker output using the VerificationPipeline
   *
   * @param {string} workerId - Worker ID
   * @param {string|Object} output - Output to verify (or null to use captured output)
   * @returns {Promise<Object>} Verification result { valid, critiques, confidence, taskType }
   */
  async verifyWorkerOutput(workerId, output = null) {
    const worker = getWorker(workerId);
    if (!worker) {
      throw new Error(`Worker ${workerId} not found`);
    }

    // Get task context or use default
    const taskContext = this.getTaskContext(workerId) || {
      taskType: TaskTypes.CODE,
      verificationContext: {}
    };

    // Get output if not provided
    const outputToVerify = output || getWorkerOutput(workerId);
    if (!outputToVerify) {
      return {
        valid: false,
        critiques: [{
          type: 'no_output',
          severity: 'error',
          message: 'No output available to verify'
        }],
        confidence: 0,
        taskType: taskContext.taskType
      };
    }

    // Build verification context
    const verificationContext = {
      ...taskContext.verificationContext,
      workerId,
      workerLabel: worker.label,
      project: worker.project,
      workingDir: worker.workingDir
    };

    // Add test/lint commands if available
    if (taskContext.testCommand) {
      verificationContext.testCommand = taskContext.testCommand;
    }
    if (taskContext.lintCommand) {
      verificationContext.lintCommand = taskContext.lintCommand;
    }
    if (taskContext.requiredFields) {
      verificationContext.requiredFields = taskContext.requiredFields;
    }
    if (taskContext.schema) {
      verificationContext.schema = taskContext.schema;
    }

    // Run verification
    this.metrics.verificationsRun++;

    try {
      const result = await this.pipeline.verify(
        outputToVerify,
        taskContext.taskType,
        verificationContext
      );

      if (result.valid) {
        this.metrics.verificationsValid++;
      }

      // Emit verification event
      if (this.io) {
        this.io.emit('verification:complete', {
          workerId,
          valid: result.valid,
          confidence: result.confidence,
          critiqueCount: result.critiques?.length || 0,
          taskType: taskContext.taskType
        });
      }

      console.log(`[VerificationService] Verified worker ${workerId}: valid=${result.valid}, confidence=${result.confidence?.toFixed(2)}`);

      return result;
    } catch (error) {
      console.error(`[VerificationService] Verification error for ${workerId}:`, error.message);
      throw error;
    }
  }

  /**
   * Create a worker interface compatible with SelfCorrectionLoop
   *
   * The SelfCorrectionLoop expects an object with a sendCritique method
   * that sends feedback to the worker and returns the revised output.
   *
   * @param {string} workerId - Worker ID
   * @returns {Object} Worker interface with sendCritique method
   */
  createWorkerInterface(workerId) {
    const worker = getWorker(workerId);
    if (!worker) {
      throw new Error(`Worker ${workerId} not found`);
    }

    return {
      workerId,
      workerLabel: worker.label,

      /**
       * Send critique to worker and wait for revised output
       * @param {string} critique - Formatted critique text
       * @param {Object} context - Additional context
       * @returns {Promise<string>} Revised output
       */
      sendCritique: async (critique, context = {}) => {
        // Format the critique message for the worker
        const critiqueMessage = this.formatCritiqueMessage(critique, context);

        // Send to worker via tmux
        await sendInput(workerId, critiqueMessage);

        // Wait for worker to process and provide new output
        // This is a simplified implementation - in production you'd want
        // to watch for specific completion signals
        const waitTime = context.waitTime || 30000; // 30 second default
        const pollInterval = context.pollInterval || 2000; // 2 second poll

        return new Promise((resolve, reject) => {
          let elapsed = 0;
          let previousOutput = getWorkerOutput(workerId);
          let stableCount = 0;

          const checkInterval = setInterval(() => {
            elapsed += pollInterval;

            const currentOutput = getWorkerOutput(workerId);

            // Check if output has stabilized (same for 2 consecutive polls)
            if (currentOutput === previousOutput) {
              stableCount++;
              if (stableCount >= 2 && currentOutput !== previousOutput) {
                clearInterval(checkInterval);
                resolve(currentOutput);
                return;
              }
            } else {
              stableCount = 0;
              previousOutput = currentOutput;
            }

            // Timeout
            if (elapsed >= waitTime) {
              clearInterval(checkInterval);
              // Return whatever we have
              resolve(getWorkerOutput(workerId));
            }
          }, pollInterval);
        });
      }
    };
  }

  /**
   * Format a critique message for the worker
   * @param {string} critique - Raw critique text
   * @param {Object} context - Additional context
   * @returns {string} Formatted message
   */
  formatCritiqueMessage(critique, context = {}) {
    const lines = [
      '<verification_feedback>',
      '<status>REVISION_REQUIRED</status>',
      '',
      '<issues>',
      critique,
      '</issues>',
      '',
      '<instructions>',
      'Please address the issues identified above and provide a revised output.',
      'After making corrections, clearly indicate that you have completed the revision.',
      '</instructions>',
      '</verification_feedback>'
    ];

    return lines.join('\n');
  }

  /**
   * Run the full correction loop for a worker
   *
   * This is the main entry point for CRITIC-based correction.
   * It will verify the worker's output and iteratively request
   * corrections until the output is valid or max iterations reached.
   *
   * @param {string} workerId - Worker ID
   * @param {string|Object} initialOutput - Initial output to verify (or null)
   * @returns {Promise<Object>} Correction result
   */
  async runCorrectionLoop(workerId, initialOutput = null) {
    const worker = getWorker(workerId);
    if (!worker) {
      throw new Error(`Worker ${workerId} not found`);
    }

    const taskContext = this.getTaskContext(workerId) || {
      taskType: TaskTypes.CODE,
      verificationContext: {}
    };

    // Get output if not provided
    const output = initialOutput || getWorkerOutput(workerId);
    if (!output) {
      return {
        success: false,
        error: 'No output available to verify',
        iterations: 0
      };
    }

    // Create worker interface for the correction loop
    const workerInterface = this.createWorkerInterface(workerId);

    // Build verification context
    const verificationContext = {
      ...taskContext.verificationContext,
      workerId,
      workerLabel: worker.label,
      project: worker.project
    };

    // Add test/lint commands if available
    if (taskContext.testCommand) {
      verificationContext.testCommand = taskContext.testCommand;
    }
    if (taskContext.lintCommand) {
      verificationContext.lintCommand = taskContext.lintCommand;
    }

    // Emit correction loop start event
    if (this.io) {
      this.io.emit('correction:start', {
        workerId,
        taskType: taskContext.taskType
      });
    }

    this.metrics.correctionLoopsRun++;

    try {
      // Run the correction loop
      const result = await this.correctionLoop.runCorrectionLoop(
        workerInterface,
        output,
        taskContext.taskType,
        verificationContext
      );

      if (result.success) {
        this.metrics.correctionLoopsSuccessful++;
      }

      // Emit completion event
      if (this.io) {
        this.io.emit('correction:complete', {
          workerId,
          success: result.success,
          iterations: result.iterations,
          stopReason: result.stopReason,
          confidence: result.confidence,
          remainingIssueCount: result.remainingIssues?.length || 0
        });
      }

      console.log(`[VerificationService] Correction loop for ${workerId}: success=${result.success}, iterations=${result.iterations}, stopReason=${result.stopReason}`);

      return result;
    } catch (error) {
      console.error(`[VerificationService] Correction loop error for ${workerId}:`, error.message);

      if (this.io) {
        this.io.emit('correction:error', {
          workerId,
          error: error.message
        });
      }

      throw error;
    }
  }

  /**
   * Verify worker completion and optionally run correction loop
   *
   * This is intended to be called from completeWorker() to ensure
   * outputs are verified before marking as complete.
   *
   * @param {string} workerId - Worker ID
   * @param {Object} options - Options
   * @param {boolean} options.runCorrection - Whether to run correction loop if invalid
   * @param {string} options.output - Specific output to verify
   * @returns {Promise<Object>} { verified, correctionRun, result }
   */
  async verifyCompletion(workerId, options = {}) {
    const { runCorrection = false, output = null } = options;

    // First, run verification
    const verificationResult = await this.verifyWorkerOutput(workerId, output);

    // If valid, we're done
    if (verificationResult.valid) {
      return {
        verified: true,
        correctionRun: false,
        result: verificationResult
      };
    }

    // If not valid and correction requested, run correction loop
    if (runCorrection) {
      const correctionResult = await this.runCorrectionLoop(workerId, output);
      return {
        verified: correctionResult.success,
        correctionRun: true,
        result: correctionResult
      };
    }

    // Not valid, no correction
    return {
      verified: false,
      correctionRun: false,
      result: verificationResult
    };
  }

  /**
   * Get service metrics
   * @returns {Object} Metrics summary
   */
  getMetrics() {
    const correctionMetrics = this.correctionLoop.getMetrics();

    return {
      ...this.metrics,
      verificationRate: this.metrics.verificationsRun > 0
        ? this.metrics.verificationsValid / this.metrics.verificationsRun
        : 0,
      correctionSuccessRate: this.metrics.correctionLoopsRun > 0
        ? this.metrics.correctionLoopsSuccessful / this.metrics.correctionLoopsRun
        : 0,
      correctionLoop: correctionMetrics,
      activeContexts: workerTaskContexts.size
    };
  }

  /**
   * Reset metrics
   */
  resetMetrics() {
    this.metrics = {
      verificationsRun: 0,
      verificationsValid: 0,
      correctionLoopsRun: 0,
      correctionLoopsSuccessful: 0
    };
    this.correctionLoop.resetMetrics();
  }
}

// Singleton instance holder
let verificationServiceInstance = null;

/**
 * Get or create the VerificationService singleton
 * @param {Object} options - Options for creation
 * @returns {VerificationService|null} Service instance or null if deps not available
 */
export function getVerificationService(options = {}) {
  if (!verificationServiceInstance && options.verificationPipeline && options.selfCorrectionLoop) {
    verificationServiceInstance = new VerificationService(options);
  }
  return verificationServiceInstance;
}

/**
 * Create a new VerificationService (for testing or custom instances)
 * @param {Object} options - Options
 * @returns {VerificationService} New instance
 */
export function createVerificationService(options) {
  return new VerificationService(options);
}

export default VerificationService;
