/**
 * Error Recovery System for Strategos
 *
 * Classifies errors and applies appropriate recovery strategies based on
 * research from 10-Error Recovery: tiered recovery strategies for AI agents.
 *
 * @module foundation/errorRecovery
 */

/**
 * Error type classifications for recovery strategy selection
 * @readonly
 * @enum {string}
 */
export const ERROR_TYPES = {
  /** Network errors, rate limits, temporary unavailability */
  TRANSIENT: "transient",
  /** Context overflow, validation failures, tool errors */
  RECOVERABLE: "recoverable",
  /** Auth failures, quota exceeded, invalid configuration */
  FATAL: "fatal",
  /** Unknown error types */
  UNKNOWN: "unknown",
};

/**
 * Recovery actions that can be taken for different error types
 * @readonly
 * @enum {string}
 */
export const RECOVERY_ACTIONS = {
  /** Retry the operation with backoff */
  RETRY: "retry",
  /** Compress/summarize context and retry */
  COMPRESS_CONTEXT: "compress_context",
  /** Re-prompt with constraints */
  REPROMPT: "reprompt",
  /** Decompose task into smaller pieces */
  DECOMPOSE: "decompose",
  /** Escalate to human or higher authority */
  ESCALATE: "escalate",
};

/**
 * Error patterns for classification
 * @private
 */
const ERROR_PATTERNS = {
  transient: {
    codes: ["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"],
    httpStatus: [429, 500, 502, 503, 504],
    messagePatterns: [
      /rate\s*limit/i,
      /too\s*many\s*requests/i,
      /temporarily\s*unavailable/i,
      /service\s*unavailable/i,
      /timeout/i,
      /connection\s*reset/i,
      /network\s*error/i,
      /overloaded/i,
    ],
  },
  recoverable: {
    codes: ["CONTEXT_OVERFLOW", "VALIDATION_FAILED", "TOKEN_LIMIT", "TOOL_ERROR"],
    httpStatus: [400, 413, 422],
    messagePatterns: [
      /context.*overflow/i,
      /context.*too\s*long/i,
      /token\s*limit/i,
      /max.*tokens/i,
      /validation\s*(failed|error)/i,
      /invalid\s*format/i,
      /tool.*error/i,
      /tool.*failed/i,
      /output.*validation/i,
      /content.*too\s*large/i,
    ],
  },
  fatal: {
    codes: ["EAUTH", "QUOTA_EXCEEDED", "INVALID_API_KEY", "PERMISSION_DENIED"],
    httpStatus: [401, 403],
    messagePatterns: [
      /auth(entication)?\s*(failed|error|invalid)/i,
      /unauthorized/i,
      /forbidden/i,
      /quota\s*exceeded/i,
      /billing/i,
      /invalid\s*api\s*key/i,
      /api\s*key.*invalid/i,
      /access\s*denied/i,
      /permission\s*denied/i,
      /account\s*(suspended|disabled)/i,
    ],
  },
};

/**
 * Recovery strategies mapped to error types
 * @private
 */
const RECOVERY_STRATEGIES = {
  [ERROR_TYPES.TRANSIENT]: {
    primaryAction: RECOVERY_ACTIONS.RETRY,
    maxRetries: 5,
    useBackoff: true,
    fallbackAction: RECOVERY_ACTIONS.ESCALATE,
  },
  [ERROR_TYPES.RECOVERABLE]: {
    primaryAction: RECOVERY_ACTIONS.REPROMPT,
    maxRetries: 3,
    useBackoff: false,
    fallbackAction: RECOVERY_ACTIONS.DECOMPOSE,
    strategies: {
      context_overflow: RECOVERY_ACTIONS.COMPRESS_CONTEXT,
      token_limit: RECOVERY_ACTIONS.DECOMPOSE,
      validation_failed: RECOVERY_ACTIONS.REPROMPT,
      tool_error: RECOVERY_ACTIONS.RETRY,
    },
  },
  [ERROR_TYPES.FATAL]: {
    primaryAction: RECOVERY_ACTIONS.ESCALATE,
    maxRetries: 0,
    useBackoff: false,
    fallbackAction: RECOVERY_ACTIONS.ESCALATE,
  },
  [ERROR_TYPES.UNKNOWN]: {
    primaryAction: RECOVERY_ACTIONS.RETRY,
    maxRetries: 2,
    useBackoff: true,
    fallbackAction: RECOVERY_ACTIONS.ESCALATE,
  },
};

/**
 * ErrorRecovery class for classifying errors and determining recovery strategies.
 *
 * Based on research showing 41-87% failure rates in production multi-agent systems,
 * this class provides intelligent error classification and tiered recovery.
 */
export class ErrorRecovery {
  /**
   * Create an ErrorRecovery instance
   * @param {Object} options - Configuration options
   * @param {number} [options.backoffBase=1000] - Base delay for backoff in ms
   * @param {number} [options.backoffMultiplier=2] - Multiplier for exponential backoff
   * @param {number} [options.backoffMax=30000] - Maximum backoff delay in ms
   * @param {number} [options.maxRetries=5] - Maximum retry attempts
   * @param {number} [options.jitterFactor=0.2] - Jitter factor (±percentage)
   */
  constructor(options = {}) {
    this.options = {
      backoffBase: 1000,
      backoffMultiplier: 2,
      backoffMax: 30000,
      maxRetries: 5,
      jitterFactor: 0.2,
      ...options,
    };

    // Metrics tracking
    this.metrics = {
      classifications: {
        [ERROR_TYPES.TRANSIENT]: 0,
        [ERROR_TYPES.RECOVERABLE]: 0,
        [ERROR_TYPES.FATAL]: 0,
        [ERROR_TYPES.UNKNOWN]: 0,
      },
      recoveryAttempts: 0,
      successfulRecoveries: 0,
      escalations: 0,
    };
  }

  /**
   * Classify an error into one of the ERROR_TYPES
   * @param {Error|Object} error - The error to classify
   * @returns {string} The error type (one of ERROR_TYPES values)
   */
  classify(error) {
    if (!error) {
      return ERROR_TYPES.UNKNOWN;
    }

    const errorInfo = this._extractErrorInfo(error);

    // Check transient patterns first (network issues, rate limits)
    if (this._matchesPatterns(errorInfo, ERROR_PATTERNS.transient)) {
      this.metrics.classifications[ERROR_TYPES.TRANSIENT]++;
      return ERROR_TYPES.TRANSIENT;
    }

    // Check fatal patterns (auth, quota)
    if (this._matchesPatterns(errorInfo, ERROR_PATTERNS.fatal)) {
      this.metrics.classifications[ERROR_TYPES.FATAL]++;
      return ERROR_TYPES.FATAL;
    }

    // Check recoverable patterns (context, validation)
    if (this._matchesPatterns(errorInfo, ERROR_PATTERNS.recoverable)) {
      this.metrics.classifications[ERROR_TYPES.RECOVERABLE]++;
      return ERROR_TYPES.RECOVERABLE;
    }

    // Unknown error type
    this.metrics.classifications[ERROR_TYPES.UNKNOWN]++;
    return ERROR_TYPES.UNKNOWN;
  }

  /**
   * Handle an error and determine the appropriate recovery action
   * @param {Error|Object} error - The error to handle
   * @param {Object} context - Context about the current operation
   * @param {number} [context.attempt=0] - Current retry attempt number
   * @param {string} [context.operation] - Name of the operation that failed
   * @param {Object} [context.metadata] - Additional metadata
   * @returns {Promise<Object>} Recovery action with delay and constraints
   */
  async handleError(error, context = {}) {
    const errorType = this.classify(error);
    const attempt = context.attempt || 0;
    const strategy = this.getRecoveryStrategy(errorType, context);

    this.metrics.recoveryAttempts++;

    // Check if we've exhausted retries
    const maxRetries = context.maxRetries ?? this.options.maxRetries;
    if (attempt >= maxRetries) {
      this.metrics.escalations++;
      return {
        action: RECOVERY_ACTIONS.ESCALATE,
        reason: "max_retries_exceeded",
        attempt,
        errorType,
        errorInfo: this._extractErrorInfo(error),
      };
    }

    // For fatal errors, always escalate
    if (errorType === ERROR_TYPES.FATAL) {
      this.metrics.escalations++;
      return {
        action: RECOVERY_ACTIONS.ESCALATE,
        reason: "fatal_error",
        attempt,
        errorType,
        errorInfo: this._extractErrorInfo(error),
      };
    }

    // Determine specific recovery action based on error details
    const action = this._selectRecoveryAction(error, errorType, context);
    const result = {
      action,
      attempt: attempt + 1,
      errorType,
    };

    // Add delay for retry actions
    if (action === RECOVERY_ACTIONS.RETRY && strategy.useBackoff) {
      result.delay = this.calculateBackoff(attempt);
    }

    // Add constraints for reprompt actions
    if (action === RECOVERY_ACTIONS.REPROMPT) {
      result.constraints = this._generateConstraints(error, context);
    }

    // Add compression target for context compression
    if (action === RECOVERY_ACTIONS.COMPRESS_CONTEXT) {
      result.targetTokenReduction = 0.5; // Reduce by 50%
    }

    return result;
  }

  /**
   * Calculate exponential backoff delay with jitter
   * @param {number} attempt - Current attempt number (0-indexed)
   * @returns {number} Delay in milliseconds
   */
  calculateBackoff(attempt) {
    const { backoffBase, backoffMultiplier, backoffMax, jitterFactor } = this.options;

    // Exponential delay: base * multiplier^attempt
    const exponentialDelay = backoffBase * Math.pow(backoffMultiplier, attempt);

    // Apply maximum cap
    const cappedDelay = Math.min(exponentialDelay, backoffMax);

    // Apply jitter: ±jitterFactor (e.g., ±20%)
    const jitterRange = cappedDelay * jitterFactor;
    const jitter = (Math.random() * 2 - 1) * jitterRange;

    // Ensure delay is at least 0
    return Math.max(0, Math.round(cappedDelay + jitter));
  }

  /**
   * Get the recovery strategy for an error type
   * @param {string} errorType - The error type
   * @param {Object} [context={}] - Additional context
   * @returns {Object} Recovery strategy configuration
   */
  getRecoveryStrategy(errorType, context = {}) {
    const baseStrategy = RECOVERY_STRATEGIES[errorType] || RECOVERY_STRATEGIES[ERROR_TYPES.UNKNOWN];

    // Allow context to override max retries
    return {
      ...baseStrategy,
      maxRetries: context.maxRetries ?? baseStrategy.maxRetries,
    };
  }

  /**
   * Get current metrics
   * @returns {Object} Metrics object
   */
  getMetrics() {
    return { ...this.metrics };
  }

  /**
   * Reset metrics
   */
  resetMetrics() {
    this.metrics = {
      classifications: {
        [ERROR_TYPES.TRANSIENT]: 0,
        [ERROR_TYPES.RECOVERABLE]: 0,
        [ERROR_TYPES.FATAL]: 0,
        [ERROR_TYPES.UNKNOWN]: 0,
      },
      recoveryAttempts: 0,
      successfulRecoveries: 0,
      escalations: 0,
    };
  }

  /**
   * Record a successful recovery
   */
  recordSuccessfulRecovery() {
    this.metrics.successfulRecoveries++;
  }

  /**
   * Extract normalized error information from various error formats
   * @private
   * @param {Error|Object} error - The error object
   * @returns {Object} Normalized error info
   */
  _extractErrorInfo(error) {
    if (!error) {
      return { code: null, status: null, message: "" };
    }

    // Handle standard Error objects
    if (error instanceof Error) {
      return {
        code: error.code || null,
        status: error.status || error.statusCode || null,
        message: error.message || "",
        name: error.name || "Error",
        stack: error.stack,
      };
    }

    // Handle plain objects (e.g., API response errors)
    return {
      code: error.code || error.error_code || null,
      status: error.status || error.statusCode || error.http_status || null,
      message: error.message || error.error || error.error_message || String(error),
      type: error.type || error.error_type || null,
    };
  }

  /**
   * Check if error info matches any patterns in a pattern set
   * @private
   * @param {Object} errorInfo - Normalized error info
   * @param {Object} patterns - Pattern set to match against
   * @returns {boolean} True if any pattern matches
   */
  _matchesPatterns(errorInfo, patterns) {
    const { code, status, message } = errorInfo;

    // Check error codes
    if (code && patterns.codes.includes(code)) {
      return true;
    }

    // Check HTTP status codes
    if (status && patterns.httpStatus.includes(Number(status))) {
      return true;
    }

    // Check message patterns
    if (message) {
      for (const pattern of patterns.messagePatterns) {
        if (pattern.test(message)) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Select the specific recovery action based on error details
   * @private
   * @param {Error|Object} error - The error
   * @param {string} errorType - Classified error type
   * @param {Object} context - Operation context
   * @returns {string} Recovery action
   */
  _selectRecoveryAction(error, errorType, context) {
    const strategy = RECOVERY_STRATEGIES[errorType];
    const errorInfo = this._extractErrorInfo(error);
    const message = errorInfo.message.toLowerCase();

    // For recoverable errors, select specific action based on error details
    if (errorType === ERROR_TYPES.RECOVERABLE) {
      if (/context.*overflow|context.*too\s*long/i.test(message)) {
        return RECOVERY_ACTIONS.COMPRESS_CONTEXT;
      }
      if (/token\s*limit|max.*tokens/i.test(message)) {
        return RECOVERY_ACTIONS.DECOMPOSE;
      }
      if (/validation|invalid\s*format/i.test(message)) {
        return RECOVERY_ACTIONS.REPROMPT;
      }
      if (/tool.*error|tool.*failed/i.test(message)) {
        return RECOVERY_ACTIONS.RETRY;
      }
    }

    return strategy.primaryAction;
  }

  /**
   * Generate constraints for reprompt action
   * @private
   * @param {Error|Object} error - The error
   * @param {Object} context - Operation context
   * @returns {Object} Constraints for the reprompt
   */
  _generateConstraints(error, context) {
    const errorInfo = this._extractErrorInfo(error);
    const message = errorInfo.message.toLowerCase();

    const constraints = {
      addedContext: [],
      removedFeatures: [],
      formatRequirements: [],
    };

    // Add format requirements based on error
    if (/invalid\s*json/i.test(message)) {
      constraints.formatRequirements.push("Ensure output is valid JSON");
    }
    if (/missing\s*field/i.test(message)) {
      constraints.formatRequirements.push("Include all required fields");
    }
    if (/type\s*error/i.test(message)) {
      constraints.formatRequirements.push("Ensure correct data types");
    }

    // Add context about the error
    constraints.addedContext.push(`Previous attempt failed with: ${errorInfo.message}`);

    return constraints;
  }
}

/**
 * Create a default ErrorRecovery instance
 * @returns {ErrorRecovery} Default configured instance
 */
export function createErrorRecovery(options = {}) {
  return new ErrorRecovery(options);
}

export default ErrorRecovery;
