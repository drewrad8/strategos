/**
 * Escalation System
 *
 * Routes unresolvable issues to human review.
 * Based on research: "Human escalation is a feature, not a failure"
 *
 * @module coordination/escalationSystem
 */

import crypto from 'crypto';
import { EventEmitter } from 'events';

/**
 * Escalation reasons enum
 * Defines the types of situations that warrant human escalation
 */
const EscalationReasons = {
  CONFIDENCE_LOW: 'confidence_low',         // Worker confidence below threshold
  HIGH_IMPACT: 'high_impact',               // Decision affects critical system
  AMBIGUOUS: 'ambiguous',                   // Requirements unclear
  OUT_OF_SCOPE: 'out_of_scope',             // Task beyond worker capabilities
  RETRIES_EXHAUSTED: 'retries_exhausted',   // Max retries reached
  CONFLICTING_REQUIREMENTS: 'conflicting_requirements' // Contradictory constraints
};

/**
 * Urgency levels for escalations
 * Higher urgency = requires faster response
 */
const UrgencyLevels = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical'
};

/**
 * Priority weights for urgency sorting (higher = more urgent)
 */
const URGENCY_PRIORITY = {
  [UrgencyLevels.CRITICAL]: 4,
  [UrgencyLevels.HIGH]: 3,
  [UrgencyLevels.MEDIUM]: 2,
  [UrgencyLevels.LOW]: 1
};

/**
 * Escalation status enum
 */
const EscalationStatus = {
  PENDING: 'pending',
  RESOLVED: 'resolved'
};

/**
 * EscalationSystem - Routes unresolvable issues to human review
 *
 * Design principles:
 * - Human escalation reduces catastrophic errors
 * - Well-structured escalation requests enable faster resolution
 * - Urgency-based prioritization ensures critical issues get attention first
 */
class EscalationSystem extends EventEmitter {
  /**
   * Create an EscalationSystem instance
   * @param {Object} options - Configuration options
   * @param {number} options.maxPendingEscalations - Maximum pending escalations before warning (default: 100)
   * @param {boolean} options.persistHistory - Whether to persist history (default: true)
   */
  constructor(options = {}) {
    super();

    this.options = {
      maxPendingEscalations: 100,
      persistHistory: true,
      ...options
    };

    // In-memory storage for escalations
    // Key: escalation ID, Value: escalation object
    this.escalations = new Map();

    // Handlers registered for new escalations
    this.escalationHandlers = [];
  }

  /**
   * Generate a unique escalation ID
   * @returns {string} UUID-format escalation ID
   */
  _generateId() {
    return crypto.randomUUID();
  }

  /**
   * Validate escalation request structure
   * @param {Object} request - The escalation request to validate
   * @throws {Error} If request is invalid
   */
  _validateRequest(request) {
    if (!request) {
      throw new Error('Escalation request is required');
    }

    // Required fields
    if (!request.workerId) {
      throw new Error('workerId is required');
    }
    if (!request.taskId) {
      throw new Error('taskId is required');
    }
    if (!request.reason) {
      throw new Error('reason is required');
    }
    if (!Object.values(EscalationReasons).includes(request.reason)) {
      throw new Error(`Invalid escalation reason: ${request.reason}. Must be one of: ${Object.values(EscalationReasons).join(', ')}`);
    }
    if (!request.urgency) {
      throw new Error('urgency is required');
    }
    if (!Object.values(UrgencyLevels).includes(request.urgency)) {
      throw new Error(`Invalid urgency level: ${request.urgency}. Must be one of: ${Object.values(UrgencyLevels).join(', ')}`);
    }
    if (!request.requiredFromHuman || typeof request.requiredFromHuman !== 'string') {
      throw new Error('requiredFromHuman is required and must be a string describing what decision is needed');
    }

    // Context validation (optional but should be object if provided)
    if (request.context !== undefined && typeof request.context !== 'object') {
      throw new Error('context must be an object if provided');
    }
  }

  /**
   * Queue an escalation request for human review
   *
   * @param {Object} request - The escalation request
   * @param {string} request.workerId - ID of the worker requesting escalation
   * @param {string} request.taskId - ID of the task that needs escalation
   * @param {string} request.reason - Reason for escalation (from EscalationReasons)
   * @param {string} request.urgency - Urgency level (low|medium|high|critical)
   * @param {Object} [request.context] - Additional context
   * @param {string} [request.context.taskDescription] - Description of the task
   * @param {string} [request.context.progressSoFar] - Progress made before escalation
   * @param {string} [request.context.blocker] - What is blocking progress
   * @param {string[]} [request.context.attemptedSolutions] - Solutions already tried
   * @param {Object[]} [request.context.optionsConsidered] - Options the worker considered
   * @param {string} [request.context.recommendation] - Worker's recommendation if any
   * @param {string} request.requiredFromHuman - What decision is needed from human
   * @returns {string} The escalation ID
   */
  escalate(request) {
    this._validateRequest(request);

    const id = this._generateId();
    const now = new Date().toISOString();

    const escalation = {
      id,
      workerId: request.workerId,
      taskId: request.taskId,
      reason: request.reason,
      urgency: request.urgency,
      context: {
        taskDescription: request.context?.taskDescription || null,
        progressSoFar: request.context?.progressSoFar || null,
        blocker: request.context?.blocker || null,
        attemptedSolutions: request.context?.attemptedSolutions || [],
        optionsConsidered: request.context?.optionsConsidered || [],
        recommendation: request.context?.recommendation || null
      },
      requiredFromHuman: request.requiredFromHuman,
      status: EscalationStatus.PENDING,
      createdAt: now,
      resolvedAt: null,
      resolution: null
    };

    // Store the escalation
    this.escalations.set(id, escalation);

    // Notify handlers
    this._notifyHandlers(escalation);

    // Emit event
    this.emit('escalation', escalation);

    // Warn if approaching limit
    const pendingCount = this.getPending().length;
    if (pendingCount >= this.options.maxPendingEscalations) {
      this.emit('warning', {
        type: 'pending_limit_reached',
        message: `Pending escalations (${pendingCount}) reached max limit (${this.options.maxPendingEscalations})`
      });
    }

    return id;
  }

  /**
   * Notify registered handlers of a new escalation
   * @param {Object} escalation - The escalation object
   * @private
   */
  _notifyHandlers(escalation) {
    for (const handler of this.escalationHandlers) {
      try {
        // Execute handler asynchronously to not block the escalate call
        Promise.resolve(handler(escalation)).catch(err => {
          this.emit('error', {
            type: 'handler_error',
            message: `Escalation handler error: ${err.message}`,
            error: err
          });
        });
      } catch (err) {
        this.emit('error', {
          type: 'handler_error',
          message: `Escalation handler error: ${err.message}`,
          error: err
        });
      }
    }
  }

  /**
   * Resolve an escalation with the human's decision
   *
   * @param {string} escalationId - ID of the escalation to resolve
   * @param {Object} resolution - The resolution details
   * @param {string} resolution.decision - The decision made
   * @param {string} [resolution.resolvedBy] - Who resolved it
   * @param {string} [resolution.notes] - Additional notes
   * @throws {Error} If escalation not found or already resolved
   */
  resolve(escalationId, resolution) {
    if (!escalationId) {
      throw new Error('escalationId is required');
    }
    if (!resolution) {
      throw new Error('resolution is required');
    }
    if (!resolution.decision) {
      throw new Error('resolution.decision is required');
    }

    const escalation = this.escalations.get(escalationId);

    if (!escalation) {
      throw new Error(`Escalation not found: ${escalationId}`);
    }

    if (escalation.status === EscalationStatus.RESOLVED) {
      throw new Error(`Escalation already resolved: ${escalationId}`);
    }

    const now = new Date().toISOString();

    // Update escalation
    escalation.status = EscalationStatus.RESOLVED;
    escalation.resolvedAt = now;
    escalation.resolution = {
      decision: resolution.decision,
      resolvedBy: resolution.resolvedBy || null,
      notes: resolution.notes || null,
      resolvedAt: now
    };

    // Update in storage
    this.escalations.set(escalationId, escalation);

    // Emit event
    this.emit('resolved', escalation);
  }

  /**
   * Get all pending escalations, sorted by urgency (most urgent first)
   *
   * Sorting priority:
   * 1. Urgency level (critical > high > medium > low)
   * 2. Creation time (older first within same urgency)
   *
   * @returns {Object[]} Array of pending escalation objects
   */
  getPending() {
    const pending = [];

    for (const escalation of this.escalations.values()) {
      if (escalation.status === EscalationStatus.PENDING) {
        pending.push(escalation);
      }
    }

    // Sort by urgency (descending) then by creation time (ascending)
    pending.sort((a, b) => {
      const urgencyDiff = URGENCY_PRIORITY[b.urgency] - URGENCY_PRIORITY[a.urgency];
      if (urgencyDiff !== 0) {
        return urgencyDiff;
      }
      // Same urgency - older escalations first
      return new Date(a.createdAt) - new Date(b.createdAt);
    });

    return pending;
  }

  /**
   * Register a callback handler for new escalations
   *
   * @param {Function} callback - Function to call when new escalation is created
   *                              Receives the escalation object as argument
   */
  onEscalation(callback) {
    if (typeof callback !== 'function') {
      throw new Error('callback must be a function');
    }
    this.escalationHandlers.push(callback);
  }

  /**
   * Remove an escalation handler
   *
   * @param {Function} callback - The callback to remove
   * @returns {boolean} True if handler was found and removed
   */
  offEscalation(callback) {
    const index = this.escalationHandlers.indexOf(callback);
    if (index !== -1) {
      this.escalationHandlers.splice(index, 1);
      return true;
    }
    return false;
  }

  /**
   * Get escalation history with optional filtering
   *
   * @param {Object} [options] - Query options
   * @param {string} [options.status] - Filter by status ('pending' | 'resolved')
   * @param {string} [options.workerId] - Filter by worker ID
   * @param {string} [options.taskId] - Filter by task ID
   * @param {string} [options.reason] - Filter by escalation reason
   * @param {string} [options.urgency] - Filter by urgency level
   * @param {Date|string} [options.since] - Only return escalations created after this date
   * @param {Date|string} [options.until] - Only return escalations created before this date
   * @param {number} [options.limit] - Maximum number of results to return
   * @param {number} [options.offset] - Number of results to skip (for pagination)
   * @param {string} [options.sortBy] - Field to sort by ('createdAt' | 'resolvedAt' | 'urgency')
   * @param {string} [options.sortOrder] - Sort order ('asc' | 'desc')
   * @returns {Object} Query result with escalations and metadata
   */
  getHistory(options = {}) {
    let results = Array.from(this.escalations.values());

    // Apply filters
    if (options.status) {
      results = results.filter(e => e.status === options.status);
    }
    if (options.workerId) {
      results = results.filter(e => e.workerId === options.workerId);
    }
    if (options.taskId) {
      results = results.filter(e => e.taskId === options.taskId);
    }
    if (options.reason) {
      results = results.filter(e => e.reason === options.reason);
    }
    if (options.urgency) {
      results = results.filter(e => e.urgency === options.urgency);
    }
    if (options.since) {
      const sinceDate = new Date(options.since);
      results = results.filter(e => new Date(e.createdAt) >= sinceDate);
    }
    if (options.until) {
      const untilDate = new Date(options.until);
      results = results.filter(e => new Date(e.createdAt) <= untilDate);
    }

    const totalCount = results.length;

    // Apply sorting
    const sortBy = options.sortBy || 'createdAt';
    const sortOrder = options.sortOrder || 'desc';

    results.sort((a, b) => {
      let comparison = 0;

      if (sortBy === 'urgency') {
        comparison = URGENCY_PRIORITY[a.urgency] - URGENCY_PRIORITY[b.urgency];
      } else if (sortBy === 'resolvedAt') {
        const aDate = a.resolvedAt ? new Date(a.resolvedAt) : new Date(0);
        const bDate = b.resolvedAt ? new Date(b.resolvedAt) : new Date(0);
        comparison = aDate - bDate;
      } else {
        // Default: createdAt
        comparison = new Date(a.createdAt) - new Date(b.createdAt);
      }

      return sortOrder === 'asc' ? comparison : -comparison;
    });

    // Apply pagination
    const offset = options.offset || 0;
    const limit = options.limit;

    if (offset > 0) {
      results = results.slice(offset);
    }
    if (limit && limit > 0) {
      results = results.slice(0, limit);
    }

    return {
      escalations: results,
      total: totalCount,
      offset: offset,
      limit: limit || totalCount,
      hasMore: offset + results.length < totalCount
    };
  }

  /**
   * Get a single escalation by ID
   *
   * @param {string} escalationId - The escalation ID
   * @returns {Object|null} The escalation object or null if not found
   */
  get(escalationId) {
    return this.escalations.get(escalationId) || null;
  }

  /**
   * Get statistics about escalations
   *
   * @returns {Object} Statistics object
   */
  getStats() {
    const stats = {
      total: this.escalations.size,
      pending: 0,
      resolved: 0,
      byReason: {},
      byUrgency: {},
      avgResolutionTimeMs: null
    };

    // Initialize counters
    for (const reason of Object.values(EscalationReasons)) {
      stats.byReason[reason] = { pending: 0, resolved: 0 };
    }
    for (const urgency of Object.values(UrgencyLevels)) {
      stats.byUrgency[urgency] = { pending: 0, resolved: 0 };
    }

    let totalResolutionTime = 0;
    let resolvedCount = 0;

    for (const escalation of this.escalations.values()) {
      if (escalation.status === EscalationStatus.PENDING) {
        stats.pending++;
        stats.byReason[escalation.reason].pending++;
        stats.byUrgency[escalation.urgency].pending++;
      } else {
        stats.resolved++;
        stats.byReason[escalation.reason].resolved++;
        stats.byUrgency[escalation.urgency].resolved++;

        // Calculate resolution time
        if (escalation.resolvedAt && escalation.createdAt) {
          const resolutionTime = new Date(escalation.resolvedAt) - new Date(escalation.createdAt);
          totalResolutionTime += resolutionTime;
          resolvedCount++;
        }
      }
    }

    if (resolvedCount > 0) {
      stats.avgResolutionTimeMs = Math.round(totalResolutionTime / resolvedCount);
    }

    return stats;
  }

  /**
   * Clear all escalations (useful for testing)
   */
  clear() {
    this.escalations.clear();
  }

  /**
   * Get the number of pending escalations
   * @returns {number}
   */
  get pendingCount() {
    let count = 0;
    for (const escalation of this.escalations.values()) {
      if (escalation.status === EscalationStatus.PENDING) {
        count++;
      }
    }
    return count;
  }
}

export {
  EscalationSystem,
  EscalationReasons,
  UrgencyLevels,
  EscalationStatus,
  URGENCY_PRIORITY
};
