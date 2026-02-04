/**
 * Self-Correction Loop
 *
 * Iterative correction of worker outputs using external verification.
 * Based on CRITIC framework research - intrinsic self-correction fails,
 * tool-assisted correction succeeds.
 *
 * @see /research/11-critic-framework-self-correction.md
 * @see /research/IMPLEMENTATION_SPEC.md Section 2.2
 */

/**
 * Task types supported by the correction loop
 */
export const TaskTypes = {
  CODE: 'code',
  FACTUAL: 'factual',
  REASONING: 'reasoning',
  FORMAT: 'format'
};

/**
 * Stop reasons for correction loop termination
 */
export const StopReasons = {
  VALID_OUTPUT: 'valid_output',
  MAX_ITERATIONS: 'max_iterations',
  NO_NEW_CRITIQUES: 'no_new_critiques',
  CONFIDENCE_THRESHOLD: 'confidence_threshold',
  WORKER_UNAVAILABLE: 'worker_unavailable',
  VERIFICATION_ERROR: 'verification_error'
};

/**
 * Default configuration options
 */
const DEFAULT_OPTIONS = {
  maxIterations: {
    [TaskTypes.CODE]: 5,
    [TaskTypes.REASONING]: 3,
    [TaskTypes.FACTUAL]: 3,
    [TaskTypes.FORMAT]: 2
  },
  confidenceThreshold: 0.95
};

/**
 * SelfCorrectionLoop - Iterative correction using external verification
 *
 * Key insight from research: LLMs cannot reliably self-correct without
 * external feedback. This loop uses the verification pipeline to provide
 * tool-based feedback for corrections.
 */
export class SelfCorrectionLoop {
  /**
   * @param {Object} verificationPipeline - Dependency injection for verification
   * @param {Function} verificationPipeline.verify - Verify output, returns { valid, critiques, confidence }
   * @param {Function} verificationPipeline.formatCritique - Format critiques for worker
   * @param {Object} options - Configuration options
   * @param {Object} options.maxIterations - Max iterations per task type
   * @param {number} options.confidenceThreshold - Confidence level to accept output
   */
  constructor(verificationPipeline, options = {}) {
    if (!verificationPipeline) {
      throw new Error('verificationPipeline is required');
    }

    this.pipeline = verificationPipeline;
    this.options = {
      maxIterations: {
        ...DEFAULT_OPTIONS.maxIterations,
        ...(options.maxIterations || {})
      },
      confidenceThreshold: options.confidenceThreshold ?? DEFAULT_OPTIONS.confidenceThreshold
    };

    // Metrics tracking
    this.metrics = {
      totalLoops: 0,
      successfulCorrections: 0,
      failedCorrections: 0,
      iterationCounts: [],
      stopReasons: {}
    };
  }

  /**
   * Run the correction loop on worker output
   *
   * Loop Logic:
   * 1. Receive initial output
   * 2. Verify with external tools
   * 3. If valid OR max iterations: return
   * 4. Format critique and send to worker
   * 5. Receive revised output
   * 6. Go to step 2
   *
   * @param {Object} worker - Worker interface with sendCritique method
   * @param {string} output - Initial output to verify
   * @param {string} taskType - One of TaskTypes
   * @param {Object} context - Additional context for verification
   * @returns {Promise<Object>} { success, finalOutput, iterations, remainingIssues, stopReason, history }
   */
  async runCorrectionLoop(worker, output, taskType, context = {}) {
    // Validate task type
    if (!Object.values(TaskTypes).includes(taskType)) {
      throw new Error(`Invalid task type: ${taskType}. Must be one of: ${Object.values(TaskTypes).join(', ')}`);
    }

    const maxIterations = this.options.maxIterations[taskType];
    let currentOutput = output;
    let iteration = 0;
    const history = [];
    let lastCritiques = [];
    let stopReason = null;

    this.metrics.totalLoops++;

    let verification = null;

    while (iteration < maxIterations) {
      iteration++;

      // Step 2: Verify with external tools
      try {
        verification = await this.pipeline.verify(currentOutput, taskType, context);
      } catch (error) {
        // Verification error - exit loop
        stopReason = StopReasons.VERIFICATION_ERROR;
        history.push({
          iteration,
          output: currentOutput,
          verification: null,
          error: error.message
        });
        break;
      }

      // Record iteration history
      history.push({
        iteration,
        output: currentOutput,
        verification: {
          valid: verification.valid,
          confidence: verification.confidence,
          critiqueCount: verification.critiques?.length || 0
        }
      });

      // Step 3: Check if we should continue
      const continueResult = this.shouldContinue(iteration, taskType, verification, lastCritiques);

      if (!continueResult.continue) {
        stopReason = continueResult.reason;
        break;
      }

      // Step 4: Format critique and send to worker
      const formattedCritique = this.pipeline.formatCritique
        ? this.pipeline.formatCritique(verification.critiques)
        : this._defaultFormatCritique(verification.critiques);

      // Check worker availability
      if (!worker || typeof worker.sendCritique !== 'function') {
        stopReason = StopReasons.WORKER_UNAVAILABLE;
        break;
      }

      // Step 5: Receive revised output from worker
      try {
        currentOutput = await worker.sendCritique(formattedCritique, context);
        lastCritiques = verification.critiques;
      } catch (error) {
        // Worker error - exit with current output
        stopReason = StopReasons.WORKER_UNAVAILABLE;
        history.push({
          iteration,
          error: `Worker error: ${error.message}`
        });
        break;
      }
    }

    // Determine final stop reason if not set
    if (!stopReason) {
      stopReason = StopReasons.MAX_ITERATIONS;
    }

    // Final verification to determine success
    // Skip re-verification if we already have a valid result from the loop
    let finalVerification;
    if (verification && (stopReason === StopReasons.VALID_OUTPUT || stopReason === StopReasons.CONFIDENCE_THRESHOLD)) {
      finalVerification = verification;
    } else {
      try {
        finalVerification = await this.pipeline.verify(currentOutput, taskType, context);
      } catch (error) {
        finalVerification = { valid: false, critiques: [], confidence: 0 };
      }
    }

    const success = finalVerification.valid ||
                    finalVerification.confidence >= this.options.confidenceThreshold;

    // Update metrics
    if (success) {
      this.metrics.successfulCorrections++;
    } else {
      this.metrics.failedCorrections++;
    }
    this.metrics.iterationCounts.push(iteration);
    this.metrics.stopReasons[stopReason] = (this.metrics.stopReasons[stopReason] || 0) + 1;

    return {
      success,
      finalOutput: currentOutput,
      iterations: iteration,
      remainingIssues: finalVerification.critiques || [],
      stopReason,
      history,
      confidence: finalVerification.confidence
    };
  }

  /**
   * Determine if the correction loop should continue
   *
   * Stopping conditions:
   * - Output is valid (all tests pass)
   * - No new critiques compared to previous iteration
   * - Confidence exceeds threshold
   * - Max iterations reached
   *
   * @param {number} iteration - Current iteration number
   * @param {string} taskType - Type of task
   * @param {Object} verification - Verification result { valid, critiques, confidence }
   * @param {Array} previousCritiques - Critiques from previous iteration
   * @returns {Object} { continue: boolean, reason: string }
   */
  shouldContinue(iteration, taskType, verification, previousCritiques = []) {
    const maxIterations = this.options.maxIterations[taskType];

    // Check if output is valid
    if (verification.valid) {
      return { continue: false, reason: StopReasons.VALID_OUTPUT };
    }

    // Check confidence threshold
    if (verification.confidence >= this.options.confidenceThreshold) {
      return { continue: false, reason: StopReasons.CONFIDENCE_THRESHOLD };
    }

    // Check for max iterations
    if (iteration >= maxIterations) {
      return { continue: false, reason: StopReasons.MAX_ITERATIONS };
    }

    // Check for no new critiques (stagnation detection)
    if (previousCritiques.length > 0 && verification.critiques.length > 0) {
      const newCritiques = this._hasNewCritiques(previousCritiques, verification.critiques);
      if (!newCritiques) {
        return { continue: false, reason: StopReasons.NO_NEW_CRITIQUES };
      }
    }

    return { continue: true, reason: null };
  }

  /**
   * Check if there are new/different critiques compared to previous
   * @private
   */
  _hasNewCritiques(previous, current) {
    if (current.length === 0) return false;
    if (previous.length === 0) return true;

    // Compare critique messages/types
    const previousSet = new Set(previous.map(c => `${c.type}:${c.message}`));
    const currentSet = new Set(current.map(c => `${c.type}:${c.message}`));

    // Check if any current critique is not in previous
    for (const critique of currentSet) {
      if (!previousSet.has(critique)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Default critique formatter when pipeline doesn't provide one
   * @private
   */
  _defaultFormatCritique(critiques) {
    if (!critiques || critiques.length === 0) {
      return 'No specific issues found, but the output needs improvement.';
    }

    const lines = ['The following issues were found in your output:'];

    critiques.forEach((critique, index) => {
      const severity = critique.severity ? `[${critique.severity.toUpperCase()}]` : '';
      const location = critique.location ? ` at ${critique.location}` : '';
      lines.push(`${index + 1}. ${severity} ${critique.message}${location}`);

      if (critique.suggestion) {
        lines.push(`   Suggestion: ${critique.suggestion}`);
      }
      if (critique.evidence) {
        lines.push(`   Evidence: ${critique.evidence}`);
      }
    });

    lines.push('');
    lines.push('Please revise your output to address these issues.');

    return lines.join('\n');
  }

  /**
   * Get current metrics
   * @returns {Object} Metrics summary
   */
  getMetrics() {
    const avgIterations = this.metrics.iterationCounts.length > 0
      ? this.metrics.iterationCounts.reduce((a, b) => a + b, 0) / this.metrics.iterationCounts.length
      : 0;

    return {
      ...this.metrics,
      averageIterations: avgIterations,
      successRate: this.metrics.totalLoops > 0
        ? this.metrics.successfulCorrections / this.metrics.totalLoops
        : 0
    };
  }

  /**
   * Reset metrics
   */
  resetMetrics() {
    this.metrics = {
      totalLoops: 0,
      successfulCorrections: 0,
      failedCorrections: 0,
      iterationCounts: [],
      stopReasons: {}
    };
  }
}

export default SelfCorrectionLoop;
