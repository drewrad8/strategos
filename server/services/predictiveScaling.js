/**
 * PredictiveScaling - Auto-scaling workers based on demand patterns
 *
 * Based on SYNTHESIS.md Phase 4: Optimization
 * - Monitors worker utilization and queue depth
 * - Uses simple exponential smoothing for demand prediction
 * - Automatically spawns/terminates workers to match predicted demand
 *
 * Key metrics from research:
 * - Target utilization: 60-80%
 * - Warning threshold: <30% or >90%
 * - Critical threshold: <10% or >95%
 */

import { EventEmitter } from 'events';

/**
 * Scaling states
 */
export const ScalingState = {
  IDLE: 'idle',
  SCALING_UP: 'scaling_up',
  SCALING_DOWN: 'scaling_down',
  COOLDOWN: 'cooldown'
};

/**
 * Default configuration based on research recommendations
 */
const DEFAULT_CONFIG = {
  // Utilization thresholds
  targetUtilization: 0.70,      // Target 70% utilization
  scaleUpThreshold: 0.85,       // Scale up when >85%
  scaleDownThreshold: 0.40,     // Scale down when <40%

  // Capacity limits
  minWorkers: 0,                // Minimum workers to maintain
  maxWorkers: 10,               // Maximum workers allowed

  // Timing (milliseconds)
  checkInterval: 30000,         // Check every 30 seconds
  scaleUpCooldown: 60000,       // Wait 1 minute between scale-up
  scaleDownCooldown: 180000,    // Wait 3 minutes between scale-down

  // Prediction parameters
  smoothingFactor: 0.3,         // Exponential smoothing alpha
  predictionWindow: 5,          // Number of samples for prediction

  // Queue-based scaling
  queueDepthThreshold: 3,       // Scale up if queue > 3 per worker
  queueEmptyThreshold: 300000,  // Scale down if queue empty for 5 min
};

/**
 * PredictiveScaling class for auto-scaling workers
 */
export class PredictiveScaling extends EventEmitter {
  /**
   * Create a PredictiveScaling instance
   * @param {Object} options - Configuration options
   * @param {Function} options.getWorkerStats - Function returning {running, idle, busy, queued}
   * @param {Function} options.spawnWorker - Function to spawn a new worker
   * @param {Function} options.terminateWorker - Function to terminate idle worker
   * @param {Object} options.io - Socket.io instance for notifications
   */
  constructor(options = {}) {
    super();

    this.config = { ...DEFAULT_CONFIG, ...options };
    this.getWorkerStats = options.getWorkerStats;
    this.spawnWorker = options.spawnWorker;
    this.terminateWorker = options.terminateWorker;
    this.io = options.io;

    // State tracking
    this.state = ScalingState.IDLE;
    this.lastScaleUp = 0;
    this.lastScaleDown = 0;
    this.checkTimer = null;

    // Metrics history for prediction
    this.utilizationHistory = [];
    this.queueHistory = [];
    this.predictedUtilization = null;

    // Scaling actions log
    this.scalingHistory = [];
  }

  /**
   * Start the predictive scaling monitor
   */
  start() {
    if (this.checkTimer) {
      this.stop();
    }

    console.log('[PredictiveScaling] Starting monitor');
    console.log(`  Check interval: ${this.config.checkInterval}ms`);
    console.log(`  Target utilization: ${this.config.targetUtilization * 100}%`);
    console.log(`  Scale up threshold: ${this.config.scaleUpThreshold * 100}%`);
    console.log(`  Scale down threshold: ${this.config.scaleDownThreshold * 100}%`);

    this.checkTimer = setInterval(() => {
      this._checkAndScale();
    }, this.config.checkInterval);

    // Initial check
    this._checkAndScale();

    this.emit('started');
  }

  /**
   * Stop the predictive scaling monitor
   */
  stop() {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
    this.state = ScalingState.IDLE;
    console.log('[PredictiveScaling] Stopped monitor');
    this.emit('stopped');
  }

  /**
   * Check current metrics and scale if needed
   * @private
   */
  async _checkAndScale() {
    if (!this.getWorkerStats) {
      console.warn('[PredictiveScaling] No getWorkerStats function configured');
      return;
    }

    try {
      const stats = await this.getWorkerStats();
      const now = Date.now();

      // Calculate current utilization
      const utilization = this._calculateUtilization(stats);
      const queueDepth = stats.queued || 0;

      // Update history
      this.utilizationHistory.push({ time: now, value: utilization });
      this.queueHistory.push({ time: now, value: queueDepth });

      // Keep only recent history
      const maxHistory = this.config.predictionWindow * 2;
      if (this.utilizationHistory.length > maxHistory) {
        this.utilizationHistory = this.utilizationHistory.slice(-maxHistory);
      }
      if (this.queueHistory.length > maxHistory) {
        this.queueHistory = this.queueHistory.slice(-maxHistory);
      }

      // Predict future utilization
      this.predictedUtilization = this._predictUtilization();

      // Check if in cooldown
      const inScaleUpCooldown = now - this.lastScaleUp < this.config.scaleUpCooldown;
      const inScaleDownCooldown = now - this.lastScaleDown < this.config.scaleDownCooldown;

      // Determine scaling action
      const action = this._determineScalingAction(stats, utilization, queueDepth, {
        inScaleUpCooldown,
        inScaleDownCooldown
      });

      if (action.scale !== 0) {
        await this._executeScaling(action, stats);
      }

      // Emit metrics for monitoring
      this.emit('metrics', {
        utilization,
        predictedUtilization: this.predictedUtilization,
        queueDepth,
        workerCount: stats.running,
        state: this.state,
        action: action.reason
      });

    } catch (err) {
      console.error('[PredictiveScaling] Check failed:', err.message);
      this.emit('error', err);
    }
  }

  /**
   * Calculate current worker utilization
   * @private
   */
  _calculateUtilization(stats) {
    const { running = 0, busy = 0 } = stats;
    if (running === 0) return 0;
    return busy / running;
  }

  /**
   * Predict future utilization using exponential smoothing
   * @private
   */
  _predictUtilization() {
    if (this.utilizationHistory.length < 2) {
      return this.utilizationHistory[0]?.value ?? 0;
    }

    const alpha = this.config.smoothingFactor;
    let smoothed = this.utilizationHistory[0].value;

    for (let i = 1; i < this.utilizationHistory.length; i++) {
      smoothed = alpha * this.utilizationHistory[i].value + (1 - alpha) * smoothed;
    }

    // Project forward based on trend
    const recent = this.utilizationHistory.slice(-3);
    if (recent.length >= 2) {
      const trend = (recent[recent.length - 1].value - recent[0].value) / recent.length;
      smoothed += trend; // Add one period of trend
    }

    return Math.max(0, Math.min(1, smoothed));
  }

  /**
   * Determine what scaling action to take
   * @private
   */
  _determineScalingAction(stats, utilization, queueDepth, cooldowns) {
    const { running, idle } = stats;
    const { minWorkers, maxWorkers, scaleUpThreshold, scaleDownThreshold, queueDepthThreshold } = this.config;

    // Check scale-up conditions
    if (!cooldowns.inScaleUpCooldown) {
      // High utilization or predicted utilization
      if (utilization > scaleUpThreshold || this.predictedUtilization > scaleUpThreshold) {
        if (running < maxWorkers) {
          return { scale: 1, reason: 'high_utilization' };
        }
      }

      // High queue depth relative to workers
      if (running > 0 && queueDepth / running > queueDepthThreshold) {
        if (running < maxWorkers) {
          return { scale: 1, reason: 'queue_depth' };
        }
      }

      // No workers but there are queued tasks
      if (running === 0 && queueDepth > 0) {
        return { scale: 1, reason: 'no_workers_with_queue' };
      }
    }

    // Check scale-down conditions
    if (!cooldowns.inScaleDownCooldown) {
      // Low utilization with idle workers
      if (utilization < scaleDownThreshold && idle > 0) {
        if (running > minWorkers) {
          return { scale: -1, reason: 'low_utilization' };
        }
      }

      // All workers idle for extended period
      if (utilization === 0 && running > minWorkers) {
        const allIdleDuration = this._checkIdleDuration();
        if (allIdleDuration > this.config.queueEmptyThreshold) {
          return { scale: -1, reason: 'extended_idle' };
        }
      }
    }

    return { scale: 0, reason: 'no_action_needed' };
  }

  /**
   * Check how long utilization has been zero
   * @private
   */
  _checkIdleDuration() {
    const now = Date.now();
    for (let i = this.utilizationHistory.length - 1; i >= 0; i--) {
      if (this.utilizationHistory[i].value > 0) {
        return now - this.utilizationHistory[i].time;
      }
    }
    // All history is zero
    if (this.utilizationHistory.length > 0) {
      return now - this.utilizationHistory[0].time;
    }
    return 0;
  }

  /**
   * Execute a scaling action
   * @private
   */
  async _executeScaling(action, stats) {
    const now = Date.now();

    if (action.scale > 0) {
      // Scale up
      this.state = ScalingState.SCALING_UP;
      console.log(`[PredictiveScaling] Scaling UP: ${action.reason}`);

      try {
        if (this.spawnWorker) {
          await this.spawnWorker({ reason: action.reason });
        }
        this.lastScaleUp = now;
        this._logScalingAction('scale_up', action.reason, stats);
        this.emit('scaled_up', { reason: action.reason });
      } catch (err) {
        console.error('[PredictiveScaling] Scale up failed:', err.message);
      }

    } else if (action.scale < 0) {
      // Scale down
      this.state = ScalingState.SCALING_DOWN;
      console.log(`[PredictiveScaling] Scaling DOWN: ${action.reason}`);

      try {
        if (this.terminateWorker) {
          await this.terminateWorker({ reason: action.reason });
        }
        this.lastScaleDown = now;
        this._logScalingAction('scale_down', action.reason, stats);
        this.emit('scaled_down', { reason: action.reason });
      } catch (err) {
        console.error('[PredictiveScaling] Scale down failed:', err.message);
      }
    }

    // Return to idle after cooldown
    setTimeout(() => {
      if (this.state !== ScalingState.IDLE) {
        this.state = ScalingState.COOLDOWN;
        setTimeout(() => {
          this.state = ScalingState.IDLE;
        }, 5000);
      }
    }, 1000);
  }

  /**
   * Log a scaling action to history
   * @private
   */
  _logScalingAction(type, reason, stats) {
    this.scalingHistory.push({
      timestamp: new Date().toISOString(),
      type,
      reason,
      workerCount: stats.running,
      utilization: this._calculateUtilization(stats),
      queueDepth: stats.queued || 0
    });

    // Keep last 100 actions
    if (this.scalingHistory.length > 100) {
      this.scalingHistory = this.scalingHistory.slice(-100);
    }
  }

  /**
   * Get current scaling state and metrics
   */
  getStatus() {
    const latestUtilization = this.utilizationHistory[this.utilizationHistory.length - 1];
    const latestQueue = this.queueHistory[this.queueHistory.length - 1];

    return {
      state: this.state,
      isRunning: this.checkTimer !== null,
      currentUtilization: latestUtilization?.value ?? null,
      predictedUtilization: this.predictedUtilization,
      currentQueueDepth: latestQueue?.value ?? null,
      lastScaleUp: this.lastScaleUp ? new Date(this.lastScaleUp).toISOString() : null,
      lastScaleDown: this.lastScaleDown ? new Date(this.lastScaleDown).toISOString() : null,
      config: {
        targetUtilization: this.config.targetUtilization,
        scaleUpThreshold: this.config.scaleUpThreshold,
        scaleDownThreshold: this.config.scaleDownThreshold,
        minWorkers: this.config.minWorkers,
        maxWorkers: this.config.maxWorkers
      },
      recentActions: this.scalingHistory.slice(-10)
    };
  }

  /**
   * Update configuration
   */
  updateConfig(newConfig) {
    this.config = { ...this.config, ...newConfig };
    console.log('[PredictiveScaling] Config updated:', newConfig);
    this.emit('config_updated', this.config);
  }

  /**
   * Force a scaling check (bypasses interval)
   */
  async forceCheck() {
    await this._checkAndScale();
  }

  /**
   * Get scaling history
   */
  getHistory() {
    return {
      utilizationHistory: this.utilizationHistory.slice(-50),
      queueHistory: this.queueHistory.slice(-50),
      scalingActions: this.scalingHistory
    };
  }
}

/**
 * Create a predictive scaling instance
 */
export function createPredictiveScaling(options) {
  return new PredictiveScaling(options);
}

export default PredictiveScaling;
