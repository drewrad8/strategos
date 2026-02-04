/**
 * Circuit Breaker Pattern Implementation
 *
 * Prevents cascade failures by wrapping external calls with circuit breaker pattern.
 * Based on research: 10-Error Recovery - "41-87% failure rate in production multi-agent systems"
 *
 * @module foundation/circuitBreaker
 */

import { EventEmitter } from 'events';

/**
 * Circuit breaker states
 * @readonly
 * @enum {string}
 */
export const CircuitState = {
  /** Normal operation, requests pass through */
  CLOSED: 'closed',
  /** Requests fail immediately without execution */
  OPEN: 'open',
  /** Limited requests allowed to test recovery */
  HALF_OPEN: 'half-open'
};

/**
 * Error thrown when circuit breaker is open and execution is blocked
 * @extends Error
 */
export class CircuitOpenError extends Error {
  /**
   * @param {string} name - Circuit breaker name
   * @param {number} remainingTime - Time in ms until half-open state
   */
  constructor(name, remainingTime = 0) {
    super(`Circuit breaker '${name}' is open. Retry after ${remainingTime}ms`);
    this.name = 'CircuitOpenError';
    this.circuitName = name;
    this.remainingTime = remainingTime;
    this.code = 'CIRCUIT_OPEN';
  }
}

/**
 * General circuit breaker error
 * @extends Error
 */
export class CircuitBreakerError extends Error {
  /**
   * @param {string} message - Error message
   * @param {string} [code] - Error code
   * @param {Error} [cause] - Original error that caused this
   */
  constructor(message, code = 'CIRCUIT_BREAKER_ERROR', cause = null) {
    super(message);
    this.name = 'CircuitBreakerError';
    this.code = code;
    this.cause = cause;
  }
}

/**
 * Circuit Breaker implementation with state machine
 *
 * State transitions:
 * - CLOSED: Normal, track failures. Opens after failureThreshold failures.
 * - OPEN: Fail fast, wait for timeout. Transitions to HALF_OPEN after timeout.
 * - HALF_OPEN: Allow limited requests to test recovery. Closes after successThreshold
 *              successes, reopens on any failure.
 *
 * @extends EventEmitter
 * @fires CircuitBreaker#stateChange
 * @fires CircuitBreaker#success
 * @fires CircuitBreaker#failure
 * @fires CircuitBreaker#rejected
 */
export class CircuitBreaker extends EventEmitter {
  /**
   * Create a new circuit breaker
   * @param {string} name - Unique name for this circuit breaker
   * @param {Object} [options={}] - Configuration options
   * @param {number} [options.failureThreshold=5] - Number of failures before opening
   * @param {number} [options.successThreshold=2] - Number of successes in half-open to close
   * @param {number} [options.timeout=30000] - Time in ms before trying half-open
   * @param {number} [options.slowCallDurationThreshold=0] - Calls exceeding this (ms) count as failures. 0 disables.
   * @param {number} [options.volumeThreshold=0] - Minimum calls before circuit can open. 0 disables.
   */
  constructor(name, options = {}) {
    super();

    if (!name || typeof name !== 'string') {
      throw new CircuitBreakerError('Circuit breaker name is required', 'INVALID_NAME');
    }

    this.name = name;
    this.state = CircuitState.CLOSED;
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureTime = null;
    this.lastStateChange = Date.now();

    // Configuration with defaults
    this.options = {
      failureThreshold: 5,
      successThreshold: 2,
      timeout: 30000,
      slowCallDurationThreshold: 0,
      volumeThreshold: 0,
      ...options
    };

    // Metrics tracking
    this._metrics = {
      totalCalls: 0,
      successfulCalls: 0,
      failedCalls: 0,
      rejectedCalls: 0,
      slowCalls: 0,
      stateChanges: 0,
      lastCallTime: null,
      averageCallDuration: 0,
      _callDurations: []  // Keep last N for averaging
    };

    // Lock for preventing race conditions in half-open state
    this._halfOpenLock = false;
    this._halfOpenSuccessCount = 0;
  }

  /**
   * Execute a function through the circuit breaker
   * @param {Function} fn - Async function to execute
   * @returns {Promise<*>} - Result from the function
   * @throws {CircuitOpenError} When circuit is open
   * @throws {Error} When the wrapped function throws
   */
  async execute(fn) {
    if (!this.canExecute()) {
      const remainingTime = this._getRemainingTimeout();
      this._metrics.rejectedCalls++;
      this.emit('rejected', { name: this.name, remainingTime });
      throw new CircuitOpenError(this.name, remainingTime);
    }

    // In half-open state, only allow one call at a time
    if (this.state === CircuitState.HALF_OPEN) {
      if (this._halfOpenLock) {
        const remainingTime = this._getRemainingTimeout();
        this._metrics.rejectedCalls++;
        this.emit('rejected', { name: this.name, reason: 'half-open-locked' });
        throw new CircuitOpenError(this.name, remainingTime);
      }
      this._halfOpenLock = true;
    }

    const startTime = Date.now();
    this._metrics.totalCalls++;
    this._metrics.lastCallTime = startTime;

    try {
      const result = await fn();
      const duration = Date.now() - startTime;

      // Check for slow calls
      if (this.options.slowCallDurationThreshold > 0 &&
          duration > this.options.slowCallDurationThreshold) {
        this._metrics.slowCalls++;
        this.recordFailure(new CircuitBreakerError('Slow call', 'SLOW_CALL'));
        this._updateCallDuration(duration);
        // Still return the result even if it was slow
        return result;
      }

      this.recordSuccess();
      this._updateCallDuration(duration);
      return result;

    } catch (error) {
      const duration = Date.now() - startTime;
      this._updateCallDuration(duration);
      this.recordFailure(error);
      throw error;

    } finally {
      if (this.state === CircuitState.HALF_OPEN || this._halfOpenLock) {
        this._halfOpenLock = false;
      }
    }
  }

  /**
   * Record a successful execution
   */
  recordSuccess() {
    this._metrics.successfulCalls++;
    this.emit('success', { name: this.name, state: this.state });

    switch (this.state) {
      case CircuitState.CLOSED:
        // Reset failure count on success in closed state
        this.failureCount = 0;
        break;

      case CircuitState.HALF_OPEN:
        this._halfOpenSuccessCount++;
        if (this._halfOpenSuccessCount >= this.options.successThreshold) {
          this._transitionTo(CircuitState.CLOSED);
        }
        break;

      case CircuitState.OPEN:
        // Should not happen, but handle gracefully
        break;
    }
  }

  /**
   * Record a failed execution
   * @param {Error} error - The error that occurred
   */
  recordFailure(error) {
    this._metrics.failedCalls++;
    this.lastFailureTime = Date.now();
    this.emit('failure', { name: this.name, state: this.state, error });

    switch (this.state) {
      case CircuitState.CLOSED:
        this.failureCount++;
        // Check volume threshold before opening
        if (this.options.volumeThreshold > 0 &&
            this._metrics.totalCalls < this.options.volumeThreshold) {
          break;
        }
        if (this.failureCount >= this.options.failureThreshold) {
          this._transitionTo(CircuitState.OPEN);
        }
        break;

      case CircuitState.HALF_OPEN:
        // Any failure in half-open immediately reopens
        this._transitionTo(CircuitState.OPEN);
        break;

      case CircuitState.OPEN:
        // Already open, just update timestamp
        break;
    }
  }

  /**
   * Check if execution is allowed
   * @returns {boolean} True if execution is allowed
   */
  canExecute() {
    switch (this.state) {
      case CircuitState.CLOSED:
        return true;

      case CircuitState.OPEN:
        // Check if timeout has elapsed to transition to half-open
        if (this._hasTimeoutElapsed()) {
          this._transitionTo(CircuitState.HALF_OPEN);
          return true;
        }
        return false;

      case CircuitState.HALF_OPEN:
        // Allow execution if not locked
        return !this._halfOpenLock;

      default:
        return false;
    }
  }

  /**
   * Get the current state of the circuit breaker
   * @returns {string} Current state (closed, open, or half-open)
   */
  getState() {
    // Check for automatic state transition
    if (this.state === CircuitState.OPEN && this._hasTimeoutElapsed()) {
      this._transitionTo(CircuitState.HALF_OPEN);
    }
    return this.state;
  }

  /**
   * Get comprehensive metrics for the circuit breaker
   * @returns {Object} Metrics object
   */
  getMetrics() {
    return {
      name: this.name,
      state: this.getState(),
      failureCount: this.failureCount,
      successCount: this._halfOpenSuccessCount,
      lastFailureTime: this.lastFailureTime,
      lastStateChange: this.lastStateChange,
      timeSinceLastStateChange: Date.now() - this.lastStateChange,
      options: { ...this.options },
      stats: {
        totalCalls: this._metrics.totalCalls,
        successfulCalls: this._metrics.successfulCalls,
        failedCalls: this._metrics.failedCalls,
        rejectedCalls: this._metrics.rejectedCalls,
        slowCalls: this._metrics.slowCalls,
        stateChanges: this._metrics.stateChanges,
        failureRate: this._metrics.totalCalls > 0
          ? (this._metrics.failedCalls / this._metrics.totalCalls) * 100
          : 0,
        averageCallDuration: this._metrics.averageCallDuration,
        lastCallTime: this._metrics.lastCallTime
      }
    };
  }

  /**
   * Reset the circuit breaker to closed state
   */
  reset() {
    const previousState = this.state;
    this.state = CircuitState.CLOSED;
    this.failureCount = 0;
    this.successCount = 0;
    this._halfOpenSuccessCount = 0;
    this._halfOpenLock = false;
    this.lastFailureTime = null;
    this.lastStateChange = Date.now();

    if (previousState !== CircuitState.CLOSED) {
      this._metrics.stateChanges++;
      this.emit('stateChange', {
        name: this.name,
        from: previousState,
        to: CircuitState.CLOSED,
        timestamp: this.lastStateChange,
        reason: 'manual-reset'
      });
    }
  }

  /**
   * Transition to a new state
   * @private
   * @param {string} newState - The state to transition to
   */
  _transitionTo(newState) {
    const previousState = this.state;

    if (previousState === newState) {
      return;
    }

    this.state = newState;
    this.lastStateChange = Date.now();
    this._metrics.stateChanges++;

    // Reset counters based on state
    switch (newState) {
      case CircuitState.CLOSED:
        this.failureCount = 0;
        this._halfOpenSuccessCount = 0;
        this._halfOpenLock = false;
        break;

      case CircuitState.OPEN:
        this._halfOpenSuccessCount = 0;
        this._halfOpenLock = false;
        break;

      case CircuitState.HALF_OPEN:
        this._halfOpenSuccessCount = 0;
        this._halfOpenLock = false;
        break;
    }

    /**
     * State change event
     * @event CircuitBreaker#stateChange
     * @type {Object}
     * @property {string} name - Circuit breaker name
     * @property {string} from - Previous state
     * @property {string} to - New state
     * @property {number} timestamp - Transition timestamp
     */
    this.emit('stateChange', {
      name: this.name,
      from: previousState,
      to: newState,
      timestamp: this.lastStateChange
    });
  }

  /**
   * Check if the timeout has elapsed since last failure
   * @private
   * @returns {boolean}
   */
  _hasTimeoutElapsed() {
    if (!this.lastFailureTime) {
      return true;
    }
    return Date.now() - this.lastFailureTime >= this.options.timeout;
  }

  /**
   * Get remaining time until circuit can try half-open
   * @private
   * @returns {number} Remaining time in ms
   */
  _getRemainingTimeout() {
    if (!this.lastFailureTime) {
      return 0;
    }
    const elapsed = Date.now() - this.lastFailureTime;
    return Math.max(0, this.options.timeout - elapsed);
  }

  /**
   * Update call duration metrics
   * @private
   * @param {number} duration - Call duration in ms
   */
  _updateCallDuration(duration) {
    const durations = this._metrics._callDurations;
    durations.push(duration);

    // Keep only last 100 calls for averaging
    if (durations.length > 100) {
      durations.shift();
    }

    this._metrics.averageCallDuration =
      durations.reduce((a, b) => a + b, 0) / durations.length;
  }
}

/**
 * Singleton registry for named circuit breakers
 * @type {Map<string, CircuitBreaker>}
 */
export const circuitBreakers = new Map();

/**
 * Get or create a named circuit breaker
 * @param {string} name - Unique name for the circuit breaker
 * @param {Object} [options={}] - Configuration options (only used on first creation)
 * @returns {CircuitBreaker} The circuit breaker instance
 */
export function getBreaker(name, options = {}) {
  if (!circuitBreakers.has(name)) {
    circuitBreakers.set(name, new CircuitBreaker(name, options));
  }
  return circuitBreakers.get(name);
}

/**
 * Remove a circuit breaker from the registry
 * @param {string} name - Name of the circuit breaker to remove
 * @returns {boolean} True if removed, false if not found
 */
export function removeBreaker(name) {
  const breaker = circuitBreakers.get(name);
  if (breaker) {
    breaker.removeAllListeners();
  }
  return circuitBreakers.delete(name);
}

/**
 * Clear all circuit breakers from the registry
 */
export function clearBreakers() {
  for (const breaker of circuitBreakers.values()) {
    breaker.removeAllListeners();
  }
  circuitBreakers.clear();
}

/**
 * Get metrics for all registered circuit breakers
 * @returns {Object[]} Array of metrics objects
 */
export function getAllMetrics() {
  return Array.from(circuitBreakers.values()).map(breaker => breaker.getMetrics());
}

export default CircuitBreaker;
