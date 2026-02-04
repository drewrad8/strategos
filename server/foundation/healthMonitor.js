/**
 * Enhanced Health Monitor for Strategos Worker System
 *
 * Provides comprehensive worker health tracking with:
 * - Multi-layer health checks (session, heartbeat, task duration, error rate)
 * - Weighted health score calculation
 * - State machine with thresholds for status transitions
 * - Callback system for unhealthy/recovery events
 * - Metrics for monitoring dashboards
 *
 * Based on research from 10-Error Recovery: multi-layer detection approach
 */

import { EventEmitter } from "events";

/**
 * Health status states for workers
 * @readonly
 * @enum {string}
 */
export const HealthStatus = {
  /** Worker is functioning normally */
  HEALTHY: "healthy",
  /** Worker shows warning signs but still functional */
  DEGRADED: "degraded",
  /** Worker has failed health checks repeatedly */
  UNHEALTHY: "unhealthy",
  /** Worker session no longer exists */
  DEAD: "dead",
};

/**
 * Weights for health check calculations
 * @readonly
 */
export const CHECK_WEIGHTS = {
  session: 1.0, // Critical - without session, worker is dead
  heartbeat: 0.8, // High - stale output indicates problems
  taskDuration: 0.7, // Medium-high - task timeout is concerning
  errorRate: 0.5, // Medium - errors happen but pattern matters
  consecutiveFailures: 0.6, // Medium - failure streaks are bad
};

/**
 * Calculate weighted health score from individual check results
 *
 * @param {Object} checks - Individual check results
 * @param {Object} checks.session - Session check result
 * @param {boolean} checks.session.passed - Whether session exists
 * @param {Object} checks.heartbeat - Heartbeat check result
 * @param {boolean} checks.heartbeat.passed - Whether heartbeat is within timeout
 * @param {Object} checks.taskDuration - Task duration check result
 * @param {boolean} checks.taskDuration.passed - Whether task is within timeout
 * @param {Object} checks.errorRate - Error rate check result
 * @param {boolean} checks.errorRate.passed - Whether error rate is acceptable
 * @param {number} [consecutiveFailures=0] - Number of consecutive health check failures
 * @returns {number} Health score between 0 and 1
 */
export function calculateHealthScore(checks, consecutiveFailures = 0) {
  // If session check fails, health is 0 (dead)
  if (!checks.session?.passed) {
    return 0;
  }

  let totalWeight = 0;
  let weightedScore = 0;

  // Session check (always passes if we get here)
  totalWeight += CHECK_WEIGHTS.session;
  weightedScore += CHECK_WEIGHTS.session * 1;

  // Heartbeat check
  if (checks.heartbeat) {
    totalWeight += CHECK_WEIGHTS.heartbeat;
    weightedScore += CHECK_WEIGHTS.heartbeat * (checks.heartbeat.passed ? 1 : 0);
  }

  // Task duration check
  if (checks.taskDuration) {
    totalWeight += CHECK_WEIGHTS.taskDuration;
    weightedScore +=
      CHECK_WEIGHTS.taskDuration * (checks.taskDuration.passed ? 1 : 0);
  }

  // Error rate check
  if (checks.errorRate) {
    totalWeight += CHECK_WEIGHTS.errorRate;
    weightedScore += CHECK_WEIGHTS.errorRate * (checks.errorRate.passed ? 1 : 0);
  }

  // Apply consecutive failures penalty
  // Each failure reduces score by 10%, capped at 50% reduction
  const failurePenalty = Math.min(consecutiveFailures * 0.1, 0.5);
  const baseScore = totalWeight > 0 ? weightedScore / totalWeight : 0;

  return Math.max(0, baseScore * (1 - failurePenalty));
}

/**
 * Determine health status from score
 *
 * @param {number} score - Health score between 0 and 1
 * @param {boolean} sessionExists - Whether the tmux session exists
 * @returns {HealthStatus} The determined health status
 */
export function scoreToStatus(score, sessionExists) {
  if (!sessionExists) {
    return HealthStatus.DEAD;
  }
  if (score >= 0.8) {
    return HealthStatus.HEALTHY;
  }
  if (score >= 0.5) {
    return HealthStatus.DEGRADED;
  }
  return HealthStatus.UNHEALTHY;
}

/**
 * Health state for a single worker
 * @typedef {Object} HealthState
 * @property {string} workerId - The worker ID
 * @property {HealthStatus} status - Current health status
 * @property {Date} lastCheck - Timestamp of last health check
 * @property {number} consecutiveFailures - Count of consecutive failed checks
 * @property {number} consecutiveSuccesses - Count of consecutive successful checks
 * @property {Object} checks - Individual check results
 * @property {Object} checks.session - Session check result
 * @property {Object} checks.heartbeat - Heartbeat check result
 * @property {Object} checks.taskDuration - Task duration check result
 * @property {Object} checks.errorRate - Error rate check result
 * @property {number} healthScore - Calculated health score 0-1
 * @property {string|null} lastError - Last error message if any
 */

/**
 * Enhanced Health Monitor for worker systems
 *
 * Tracks health of workers using multiple check types:
 * - Session existence (tmux)
 * - Heartbeat/output recency
 * - Task duration vs timeout
 * - Error rate frequency
 *
 * @extends EventEmitter
 */
export class HealthMonitor extends EventEmitter {
  /**
   * Create a new HealthMonitor
   *
   * @param {Object} [options={}] - Configuration options
   * @param {number} [options.checkInterval=30000] - Interval between health checks (ms)
   * @param {number} [options.heartbeatTimeout=60000] - Max time since last output (ms)
   * @param {number} [options.unhealthyThreshold=3] - Consecutive failures to mark unhealthy
   * @param {number} [options.healthyThreshold=2] - Consecutive successes to recover
   * @param {number} [options.taskTimeoutMultiplier=2] - Multiplier for task timeout detection
   * @param {number} [options.errorRateThreshold=0.3] - Error rate threshold (0-1)
   * @param {number} [options.errorRateWindow=300000] - Window for error rate calculation (ms)
   */
  constructor(options = {}) {
    super();

    /** @type {Map<string, HealthState>} */
    this.healthStates = new Map();

    /** @type {Function[]} */
    this.unhealthyCallbacks = [];

    /** @type {Function[]} */
    this.recoveryCallbacks = [];

    /** @type {Map<string, Array<{timestamp: Date, isError: boolean}>>} */
    this.errorHistory = new Map();

    /** @type {Object} Configuration options */
    this.options = {
      checkInterval: 30000,
      heartbeatTimeout: 60000,
      unhealthyThreshold: 3,
      healthyThreshold: 2,
      taskTimeoutMultiplier: 2,
      errorRateThreshold: 0.3,
      errorRateWindow: 300000, // 5 minutes
      ...options,
    };

    /** @type {Object} Metrics for monitoring */
    this.metrics = {
      totalChecks: 0,
      totalFailures: 0,
      statusTransitions: 0,
      unhealthyEvents: 0,
      recoveryEvents: 0,
      averageHealthScore: 0,
      checkDurations: [],
    };

    /** @type {Map<string, NodeJS.Timer>} Active check intervals */
    this.checkIntervals = new Map();
  }

  /**
   * Initialize health state for a worker
   *
   * @param {string} workerId - The worker ID to initialize
   * @returns {HealthState} The initialized health state
   */
  initializeWorker(workerId) {
    const initialState = {
      workerId,
      status: HealthStatus.HEALTHY, // Start healthy, checks will verify
      lastCheck: null,
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
      checks: {
        session: { passed: true, details: "not checked yet" },
        heartbeat: { passed: true, ageMs: 0 },
        taskDuration: { passed: true, durationMs: 0 },
        errorRate: { passed: true, rate: 0 },
      },
      healthScore: 1.0,
      lastError: null,
    };

    this.healthStates.set(workerId, initialState);
    this.errorHistory.set(workerId, []);

    return initialState;
  }

  /**
   * Perform a comprehensive health check on a worker
   *
   * @param {string} workerId - The worker ID to check
   * @param {Object} workerState - Current worker state
   * @param {string} workerState.tmuxSession - tmux session name
   * @param {Date|string} workerState.lastOutput - Timestamp of last output
   * @param {Date|string} [workerState.taskStartTime] - When current task started
   * @param {number} [workerState.taskTimeout] - Timeout for current task (ms)
   * @param {Function} [sessionExistsChecker] - Async function to check if session exists
   * @returns {Promise<HealthState>} Updated health state
   */
  async checkWorker(workerId, workerState, sessionExistsChecker = null) {
    const startTime = Date.now();

    // Get or initialize health state
    let healthState = this.healthStates.get(workerId);
    if (!healthState) {
      healthState = this.initializeWorker(workerId);
    }

    const previousStatus = healthState.status;

    // Perform individual checks
    const checks = {
      session: await this._checkSession(workerState, sessionExistsChecker),
      heartbeat: this._checkHeartbeat(workerState),
      taskDuration: this._checkTaskDuration(workerState),
      errorRate: this._checkErrorRate(workerId),
    };

    // Calculate health score
    const healthScore = calculateHealthScore(checks, healthState.consecutiveFailures);

    // Determine if this check passed overall
    // Score must be above 0.5 (not equal) since 0.5 maps to DEGRADED status
    const checkPassed = checks.session.passed && healthScore > 0.5;

    // Update consecutive counters
    if (checkPassed) {
      healthState.consecutiveSuccesses++;
      healthState.consecutiveFailures = 0;
    } else {
      healthState.consecutiveFailures++;
      healthState.consecutiveSuccesses = 0;
    }

    // Determine new status based on score and thresholds
    const newStatus = this._determineStatus(healthState, checks, healthScore);

    // Update health state
    healthState.status = newStatus;
    healthState.lastCheck = new Date();
    healthState.checks = checks;
    healthState.healthScore = healthScore;

    if (!checkPassed && !checks.session.passed) {
      healthState.lastError = "Session no longer exists";
    } else if (!checkPassed) {
      healthState.lastError = this._summarizeFailures(checks);
    } else {
      healthState.lastError = null;
    }

    this.healthStates.set(workerId, healthState);

    // Update metrics
    this._updateMetrics(startTime, checkPassed);

    // Fire events on status change
    if (previousStatus !== newStatus) {
      this.metrics.statusTransitions++;
      this.emit("statusChange", {
        workerId,
        previousStatus,
        newStatus,
        healthState,
      });

      if (
        newStatus === HealthStatus.UNHEALTHY ||
        newStatus === HealthStatus.DEAD
      ) {
        this._fireUnhealthyCallbacks(workerId, healthState);
      } else if (
        previousStatus === HealthStatus.UNHEALTHY ||
        previousStatus === HealthStatus.DEAD
      ) {
        if (newStatus === HealthStatus.HEALTHY) {
          this._fireRecoveryCallbacks(workerId, healthState);
        }
      }
    }

    return healthState;
  }

  /**
   * Check if tmux session exists
   * @private
   */
  async _checkSession(workerState, sessionExistsChecker) {
    if (!workerState?.tmuxSession) {
      return { passed: false, details: "No session configured" };
    }

    try {
      if (sessionExistsChecker) {
        const exists = await sessionExistsChecker(workerState.tmuxSession);
        return {
          passed: exists,
          details: exists ? "Session active" : "Session not found",
        };
      }
      // If no checker provided, assume session exists
      return { passed: true, details: "Session check skipped (no checker)" };
    } catch (error) {
      return {
        passed: false,
        details: `Session check error: ${error.message}`,
      };
    }
  }

  /**
   * Check heartbeat (time since last output)
   * @private
   */
  _checkHeartbeat(workerState) {
    if (!workerState?.lastOutput) {
      return { passed: true, ageMs: 0 }; // No output yet is ok for new workers
    }

    const lastOutput = new Date(workerState.lastOutput);
    const ageMs = Date.now() - lastOutput.getTime();
    const passed = ageMs < this.options.heartbeatTimeout;

    return { passed, ageMs };
  }

  /**
   * Check task duration against timeout
   * @private
   */
  _checkTaskDuration(workerState) {
    if (!workerState?.taskStartTime || !workerState?.taskTimeout) {
      return { passed: true, durationMs: 0 }; // No active task is ok
    }

    const taskStart = new Date(workerState.taskStartTime);
    const durationMs = Date.now() - taskStart.getTime();
    const effectiveTimeout =
      workerState.taskTimeout * this.options.taskTimeoutMultiplier;
    const passed = durationMs < effectiveTimeout;

    return { passed, durationMs, timeoutMs: effectiveTimeout };
  }

  /**
   * Check error rate in recent window
   * @private
   */
  _checkErrorRate(workerId) {
    const history = this.errorHistory.get(workerId) || [];
    const windowStart = Date.now() - this.options.errorRateWindow;

    // Filter to recent history
    const recentHistory = history.filter(
      (entry) => entry.timestamp.getTime() > windowStart
    );

    if (recentHistory.length === 0) {
      return { passed: true, rate: 0, sampleSize: 0 };
    }

    const errorCount = recentHistory.filter((entry) => entry.isError).length;
    const rate = errorCount / recentHistory.length;
    const passed = rate < this.options.errorRateThreshold;

    return { passed, rate, sampleSize: recentHistory.length };
  }

  /**
   * Determine health status based on state, checks, and thresholds
   * @private
   */
  _determineStatus(healthState, checks, healthScore) {
    // Dead if session doesn't exist
    if (!checks.session.passed) {
      return HealthStatus.DEAD;
    }

    // Check for recovery from unhealthy/dead
    if (
      healthState.status === HealthStatus.UNHEALTHY ||
      healthState.status === HealthStatus.DEAD
    ) {
      if (healthState.consecutiveSuccesses >= this.options.healthyThreshold) {
        return scoreToStatus(healthScore, true);
      }
      // Stay unhealthy until recovery threshold met
      return healthState.status === HealthStatus.DEAD
        ? HealthStatus.UNHEALTHY
        : healthState.status;
    }

    // Check for degradation to unhealthy
    if (healthState.consecutiveFailures >= this.options.unhealthyThreshold) {
      return HealthStatus.UNHEALTHY;
    }

    // Use score-based status
    return scoreToStatus(healthScore, true);
  }

  /**
   * Summarize check failures for error message
   * @private
   */
  _summarizeFailures(checks) {
    const failures = [];

    if (!checks.session.passed) {
      failures.push(`Session: ${checks.session.details}`);
    }
    if (!checks.heartbeat.passed) {
      failures.push(
        `Heartbeat: ${Math.round(checks.heartbeat.ageMs / 1000)}s since last output`
      );
    }
    if (!checks.taskDuration.passed) {
      failures.push(
        `Task timeout: ${Math.round(checks.taskDuration.durationMs / 1000)}s elapsed`
      );
    }
    if (!checks.errorRate.passed) {
      failures.push(
        `Error rate: ${(checks.errorRate.rate * 100).toFixed(1)}%`
      );
    }

    return failures.length > 0 ? failures.join("; ") : null;
  }

  /**
   * Update internal metrics
   * @private
   */
  _updateMetrics(startTime, checkPassed) {
    const duration = Date.now() - startTime;

    this.metrics.totalChecks++;
    if (!checkPassed) {
      this.metrics.totalFailures++;
    }

    // Keep last 100 check durations for averaging
    this.metrics.checkDurations.push(duration);
    if (this.metrics.checkDurations.length > 100) {
      this.metrics.checkDurations.shift();
    }

    // Calculate average health score across all workers
    const scores = Array.from(this.healthStates.values()).map(
      (s) => s.healthScore
    );
    this.metrics.averageHealthScore =
      scores.length > 0
        ? scores.reduce((a, b) => a + b, 0) / scores.length
        : 0;
  }

  /**
   * Fire unhealthy callbacks
   * @private
   */
  _fireUnhealthyCallbacks(workerId, healthState) {
    this.metrics.unhealthyEvents++;
    this.emit("unhealthy", { workerId, healthState });

    for (const callback of this.unhealthyCallbacks) {
      try {
        callback(workerId, healthState);
      } catch (error) {
        this.emit("error", {
          type: "callback_error",
          callback: "unhealthy",
          error,
        });
      }
    }
  }

  /**
   * Fire recovery callbacks
   * @private
   */
  _fireRecoveryCallbacks(workerId, healthState) {
    this.metrics.recoveryEvents++;
    this.emit("recovered", { workerId, healthState });

    for (const callback of this.recoveryCallbacks) {
      try {
        callback(workerId, healthState);
      } catch (error) {
        this.emit("error", {
          type: "callback_error",
          callback: "recovery",
          error,
        });
      }
    }
  }

  /**
   * Get current health state for a worker
   *
   * @param {string} workerId - The worker ID
   * @returns {HealthState|null} Current health state or null if not tracked
   */
  getWorkerHealth(workerId) {
    return this.healthStates.get(workerId) || null;
  }

  /**
   * Get health summary for all tracked workers
   *
   * @returns {Object} Health summary
   */
  getAllHealth() {
    const workers = Array.from(this.healthStates.entries()).map(
      ([id, state]) => ({
        workerId: id,
        status: state.status,
        healthScore: state.healthScore,
        lastCheck: state.lastCheck,
        lastError: state.lastError,
      })
    );

    const statusCounts = {
      [HealthStatus.HEALTHY]: 0,
      [HealthStatus.DEGRADED]: 0,
      [HealthStatus.UNHEALTHY]: 0,
      [HealthStatus.DEAD]: 0,
    };

    for (const state of this.healthStates.values()) {
      statusCounts[state.status]++;
    }

    return {
      total: workers.length,
      statusCounts,
      workers,
      averageHealthScore: this.metrics.averageHealthScore,
    };
  }

  /**
   * Register a callback for when a worker becomes unhealthy
   *
   * @param {Function} callback - Callback function (workerId, healthState) => void
   * @returns {Function} Unsubscribe function
   */
  onUnhealthy(callback) {
    this.unhealthyCallbacks.push(callback);
    return () => {
      const index = this.unhealthyCallbacks.indexOf(callback);
      if (index > -1) {
        this.unhealthyCallbacks.splice(index, 1);
      }
    };
  }

  /**
   * Register a callback for when a worker recovers from unhealthy state
   *
   * @param {Function} callback - Callback function (workerId, healthState) => void
   * @returns {Function} Unsubscribe function
   */
  onRecovered(callback) {
    this.recoveryCallbacks.push(callback);
    return () => {
      const index = this.recoveryCallbacks.indexOf(callback);
      if (index > -1) {
        this.recoveryCallbacks.splice(index, 1);
      }
    };
  }

  /**
   * Record an error event for a worker (for error rate tracking)
   *
   * @param {string} workerId - The worker ID
   * @param {boolean} [isError=true] - Whether this is an error (false for success)
   */
  recordEvent(workerId, isError = true) {
    if (!this.errorHistory.has(workerId)) {
      this.errorHistory.set(workerId, []);
    }

    const history = this.errorHistory.get(workerId);
    history.push({
      timestamp: new Date(),
      isError,
    });

    // Prune old entries outside window
    const windowStart = Date.now() - this.options.errorRateWindow;
    const pruned = history.filter(
      (entry) => entry.timestamp.getTime() > windowStart
    );
    this.errorHistory.set(workerId, pruned);
  }

  /**
   * Get metrics for monitoring dashboards
   *
   * @returns {Object} Health monitoring metrics
   */
  getMetrics() {
    const avgCheckDuration =
      this.metrics.checkDurations.length > 0
        ? this.metrics.checkDurations.reduce((a, b) => a + b, 0) /
          this.metrics.checkDurations.length
        : 0;

    return {
      totalChecks: this.metrics.totalChecks,
      totalFailures: this.metrics.totalFailures,
      failureRate:
        this.metrics.totalChecks > 0
          ? this.metrics.totalFailures / this.metrics.totalChecks
          : 0,
      statusTransitions: this.metrics.statusTransitions,
      unhealthyEvents: this.metrics.unhealthyEvents,
      recoveryEvents: this.metrics.recoveryEvents,
      averageHealthScore: this.metrics.averageHealthScore,
      averageCheckDurationMs: avgCheckDuration,
      trackedWorkers: this.healthStates.size,
      options: { ...this.options },
    };
  }

  /**
   * Start automatic periodic health checks for a worker
   *
   * @param {string} workerId - The worker ID
   * @param {Function} getWorkerState - Function to get current worker state
   * @param {Function} [sessionExistsChecker] - Function to check if session exists
   */
  startPeriodicCheck(workerId, getWorkerState, sessionExistsChecker = null) {
    if (this.checkIntervals.has(workerId)) {
      return; // Already running
    }

    const interval = setInterval(async () => {
      try {
        const workerState = await getWorkerState(workerId);
        if (workerState) {
          await this.checkWorker(workerId, workerState, sessionExistsChecker);
        } else {
          // Worker no longer exists, clean up
          this.stopPeriodicCheck(workerId);
          this.removeWorker(workerId);
        }
      } catch (error) {
        this.emit("error", {
          type: "periodic_check_error",
          workerId,
          error,
        });
      }
    }, this.options.checkInterval);

    this.checkIntervals.set(workerId, interval);

    // Initialize health state if not exists
    if (!this.healthStates.has(workerId)) {
      this.initializeWorker(workerId);
    }
  }

  /**
   * Stop automatic periodic health checks for a worker
   *
   * @param {string} workerId - The worker ID
   */
  stopPeriodicCheck(workerId) {
    const interval = this.checkIntervals.get(workerId);
    if (interval) {
      clearInterval(interval);
      this.checkIntervals.delete(workerId);
    }
  }

  /**
   * Remove a worker from health tracking
   *
   * @param {string} workerId - The worker ID
   */
  removeWorker(workerId) {
    this.stopPeriodicCheck(workerId);
    this.healthStates.delete(workerId);
    this.errorHistory.delete(workerId);
  }

  /**
   * Stop all periodic checks and clean up
   */
  shutdown() {
    for (const workerId of this.checkIntervals.keys()) {
      this.stopPeriodicCheck(workerId);
    }
    this.removeAllListeners();
  }
}

export default HealthMonitor;
