/**
 * Message Schema for Inter-Worker Communication
 *
 * Provides schema validation and message creation for Strategos worker communication.
 * Based on research: "Schema-validated JSON reduces failures from 37% to <5%"
 *
 * @module foundation/messageSchema
 */

import { v4 as uuidv4 } from "uuid";

/**
 * Message types for inter-worker communication
 * @enum {string}
 */
export const MessageTypes = {
  /** Request to perform a task */
  TASK_REQUEST: "task_request",
  /** Result of a completed task */
  TASK_RESULT: "task_result",
  /** Status update from a worker */
  STATUS_UPDATE: "status_update",
  /** Error report from a worker */
  ERROR_REPORT: "error_report",
  /** Request to verify output */
  VERIFICATION_REQUEST: "verification_request",
  /** Result of verification */
  VERIFICATION_RESULT: "verification_result",
  /** Share context between workers */
  CONTEXT_SHARE: "context_share",
  /** Escalation to coordinator or human */
  ESCALATION: "escalation",
};

/**
 * Valid target values for messages
 * @enum {string}
 */
export const MessageTargets = {
  ORCHESTRATOR: "orchestrator",
  BROADCAST: "broadcast",
};

/**
 * Task priority levels
 * @enum {string}
 */
export const TaskPriority = {
  LOW: "low",
  MEDIUM: "medium",
  HIGH: "high",
  CRITICAL: "critical",
};

/**
 * Task result status values
 * @enum {string}
 */
export const TaskStatus = {
  SUCCESS: "success",
  FAILURE: "failure",
  PARTIAL: "partial",
  BLOCKED: "blocked",
};

/**
 * Escalation urgency levels
 * @enum {string}
 */
export const EscalationUrgency = {
  LOW: "low",
  MEDIUM: "medium",
  HIGH: "high",
  CRITICAL: "critical",
};

/**
 * Escalation reason types
 * @enum {string}
 */
export const EscalationReasons = {
  CONFIDENCE_LOW: "confidence_low",
  HIGH_IMPACT: "high_impact",
  AMBIGUOUS: "ambiguous",
  OUT_OF_SCOPE: "out_of_scope",
  RETRIES_EXHAUSTED: "retries_exhausted",
  CONFLICTING_REQUIREMENTS: "conflicting_requirements",
};

/**
 * Payload schema definitions for each message type
 * @type {Object.<string, Object>}
 */
const PayloadSchemas = {
  [MessageTypes.TASK_REQUEST]: {
    required: ["task_id", "description"],
    optional: ["acceptance_criteria", "priority", "context", "timeout_ms"],
    types: {
      task_id: "string",
      description: "string",
      acceptance_criteria: "array",
      priority: "string",
      context: "object",
      timeout_ms: "number",
    },
    validators: {
      priority: (v) =>
        Object.values(TaskPriority).includes(v) ||
        `priority must be one of: ${Object.values(TaskPriority).join(", ")}`,
    },
  },
  [MessageTypes.TASK_RESULT]: {
    required: ["task_id", "status"],
    optional: ["output", "verification_result", "duration_ms", "error"],
    types: {
      task_id: "string",
      status: "string",
      output: "any",
      verification_result: "object",
      duration_ms: "number",
      error: "object",
    },
    validators: {
      status: (v) =>
        Object.values(TaskStatus).includes(v) ||
        `status must be one of: ${Object.values(TaskStatus).join(", ")}`,
    },
  },
  [MessageTypes.STATUS_UPDATE]: {
    required: ["phase"],
    optional: ["percent", "confidence", "current_step", "blockers", "details"],
    types: {
      phase: "string",
      percent: "number",
      confidence: "number",
      current_step: "string",
      blockers: "array",
      details: "object",
    },
    validators: {
      percent: (v) =>
        (v >= 0 && v <= 100) || "percent must be between 0 and 100",
      confidence: (v) =>
        (v >= 0 && v <= 1) || "confidence must be between 0 and 1",
    },
  },
  [MessageTypes.ERROR_REPORT]: {
    required: ["error_type", "message"],
    optional: ["stack", "recovery_attempted", "context", "severity"],
    types: {
      error_type: "string",
      message: "string",
      stack: "string",
      recovery_attempted: "boolean",
      context: "object",
      severity: "string",
    },
  },
  [MessageTypes.VERIFICATION_REQUEST]: {
    required: ["task_id", "output"],
    optional: ["task_type", "criteria", "context"],
    types: {
      task_id: "string",
      output: "any",
      task_type: "string",
      criteria: "array",
      context: "object",
    },
  },
  [MessageTypes.VERIFICATION_RESULT]: {
    required: ["task_id", "valid"],
    optional: ["critiques", "confidence", "evidence"],
    types: {
      task_id: "string",
      valid: "boolean",
      critiques: "array",
      confidence: "number",
      evidence: "array",
    },
    validators: {
      confidence: (v) =>
        (v >= 0 && v <= 1) || "confidence must be between 0 and 1",
    },
  },
  [MessageTypes.CONTEXT_SHARE]: {
    required: ["context_type", "content"],
    optional: ["scope", "ttl_ms", "visibility"],
    types: {
      context_type: "string",
      content: "any",
      scope: "string",
      ttl_ms: "number",
      visibility: "array",
    },
  },
  [MessageTypes.ESCALATION]: {
    required: ["reason", "urgency"],
    optional: ["context", "attempted_solutions", "recommendation", "options"],
    types: {
      reason: "string",
      urgency: "string",
      context: "object",
      attempted_solutions: "array",
      recommendation: "string",
      options: "array",
    },
    validators: {
      urgency: (v) =>
        Object.values(EscalationUrgency).includes(v) ||
        `urgency must be one of: ${Object.values(EscalationUrgency).join(", ")}`,
    },
  },
};

/**
 * Validate that a value is a valid UUID v4
 * @param {string} value - The value to validate
 * @returns {boolean} True if valid UUID
 */
function isValidUUID(value) {
  const uuidRegex =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return typeof value === "string" && uuidRegex.test(value);
}

/**
 * Validate that a value is a valid ISO 8601 timestamp
 * @param {string} value - The value to validate
 * @returns {boolean} True if valid ISO 8601 timestamp
 */
function isValidISO8601(value) {
  if (typeof value !== "string") return false;
  const date = new Date(value);
  return !isNaN(date.getTime()) && value.includes("T");
}

/**
 * Check if a value matches the expected type
 * @param {*} value - The value to check
 * @param {string} expectedType - The expected type
 * @returns {boolean} True if type matches
 */
function checkType(value, expectedType) {
  if (expectedType === "any") return true;
  if (expectedType === "array") return Array.isArray(value);
  if (expectedType === "object")
    return typeof value === "object" && value !== null && !Array.isArray(value);
  return typeof value === expectedType;
}

/**
 * Validate the source field of a message
 * @param {Object} source - The source object to validate
 * @returns {string[]} Array of error messages
 */
function validateSource(source) {
  const errors = [];
  if (!source || typeof source !== "object") {
    errors.push("source must be an object");
    return errors;
  }
  if (typeof source.worker_id !== "string" || source.worker_id.length === 0) {
    errors.push("source.worker_id is required and must be a non-empty string");
  }
  if (
    source.worker_type !== undefined &&
    typeof source.worker_type !== "string"
  ) {
    errors.push("source.worker_type must be a string if provided");
  }
  return errors;
}

/**
 * Validate the target field of a message
 * @param {string} target - The target to validate
 * @returns {string[]} Array of error messages
 */
function validateTarget(target) {
  const errors = [];
  if (typeof target !== "string" || target.length === 0) {
    errors.push("target is required and must be a non-empty string");
  }
  return errors;
}

/**
 * Validate payload against schema for a message type
 * @param {Object} payload - The payload to validate
 * @param {string} type - The message type
 * @returns {string[]} Array of error messages
 */
function validatePayload(payload, type) {
  const errors = [];
  const schema = PayloadSchemas[type];

  if (!schema) {
    // No specific schema, just ensure payload is an object
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      errors.push("payload must be an object");
    }
    return errors;
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    errors.push("payload must be an object");
    return errors;
  }

  // Check required fields
  for (const field of schema.required) {
    if (payload[field] === undefined || payload[field] === null) {
      errors.push(`payload.${field} is required for ${type}`);
    }
  }

  // Check types and run validators for all present fields
  const allFields = [...schema.required, ...(schema.optional || [])];
  for (const field of allFields) {
    const value = payload[field];
    if (value === undefined || value === null) continue;

    // Type check
    const expectedType = schema.types?.[field];
    if (expectedType && !checkType(value, expectedType)) {
      errors.push(`payload.${field} must be of type ${expectedType}`);
    }

    // Custom validator
    const validator = schema.validators?.[field];
    if (validator) {
      const result = validator(value);
      if (result !== true) {
        errors.push(`payload.${field}: ${result}`);
      }
    }
  }

  return errors;
}

/**
 * Validate an inter-worker message
 * @param {Object} message - The message to validate
 * @returns {{valid: boolean, errors: string[]}} Validation result
 */
export function validateMessage(message) {
  const errors = [];

  // Check message is an object
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return { valid: false, errors: ["message must be an object"] };
  }

  // Validate id (UUID)
  if (!message.id) {
    errors.push("id is required");
  } else if (!isValidUUID(message.id)) {
    errors.push("id must be a valid UUID v4");
  }

  // Validate timestamp (ISO 8601)
  if (!message.timestamp) {
    errors.push("timestamp is required");
  } else if (!isValidISO8601(message.timestamp)) {
    errors.push("timestamp must be a valid ISO 8601 string");
  }

  // Validate source
  errors.push(...validateSource(message.source));

  // Validate target
  errors.push(...validateTarget(message.target));

  // Validate type
  if (!message.type) {
    errors.push("type is required");
  } else if (!Object.values(MessageTypes).includes(message.type)) {
    errors.push(
      `type must be one of: ${Object.values(MessageTypes).join(", ")}`
    );
  }

  // Validate payload
  if (message.payload === undefined) {
    errors.push("payload is required");
  } else if (message.type && Object.values(MessageTypes).includes(message.type)) {
    errors.push(...validatePayload(message.payload, message.type));
  }

  // Validate optional fields
  if (
    message.correlation_id !== undefined &&
    typeof message.correlation_id !== "string"
  ) {
    errors.push("correlation_id must be a string if provided");
  }

  if (message.parent_id !== undefined && typeof message.parent_id !== "string") {
    errors.push("parent_id must be a string if provided");
  }

  if (
    message.requires_ack !== undefined &&
    typeof message.requires_ack !== "boolean"
  ) {
    errors.push("requires_ack must be a boolean if provided");
  }

  if (message.ttl_ms !== undefined) {
    if (typeof message.ttl_ms !== "number" || message.ttl_ms <= 0) {
      errors.push("ttl_ms must be a positive number if provided");
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Create a new message with auto-generated id and timestamp
 * @param {string} type - The message type (from MessageTypes)
 * @param {Object} payload - The message payload
 * @param {Object} metadata - Message metadata
 * @param {Object} metadata.source - Source worker info { worker_id, worker_type? }
 * @param {string} metadata.target - Target worker ID, "orchestrator", or "broadcast"
 * @param {string} [metadata.correlation_id] - ID to correlate related messages
 * @param {string} [metadata.parent_id] - Parent message ID for replies
 * @param {boolean} [metadata.requires_ack=false] - Whether acknowledgment is required
 * @param {number} [metadata.ttl_ms] - Time-to-live in milliseconds
 * @returns {Object} The created message
 * @throws {Error} If validation fails
 */
export function createMessage(type, payload, metadata) {
  if (!type || !Object.values(MessageTypes).includes(type)) {
    throw new Error(
      `Invalid message type: ${type}. Must be one of: ${Object.values(MessageTypes).join(", ")}`
    );
  }

  if (!metadata || typeof metadata !== "object") {
    throw new Error("metadata is required and must be an object");
  }

  const message = {
    id: uuidv4(),
    timestamp: new Date().toISOString(),
    source: metadata.source,
    target: metadata.target,
    type,
    payload: payload || {},
    requires_ack: metadata.requires_ack ?? false,
  };

  // Add optional fields if provided
  if (metadata.correlation_id !== undefined) {
    message.correlation_id = metadata.correlation_id;
  }
  if (metadata.parent_id !== undefined) {
    message.parent_id = metadata.parent_id;
  }
  if (metadata.ttl_ms !== undefined) {
    message.ttl_ms = metadata.ttl_ms;
  }

  // Validate the created message
  const validation = validateMessage(message);
  if (!validation.valid) {
    throw new Error(`Invalid message: ${validation.errors.join("; ")}`);
  }

  return message;
}

/**
 * Create a task request message
 * @param {string} taskId - Unique task identifier
 * @param {string} description - Task description
 * @param {Object} options - Additional options
 * @param {string[]} [options.criteria] - Acceptance criteria
 * @param {string} [options.priority="medium"] - Task priority
 * @param {Object} [options.context] - Additional context
 * @param {number} [options.timeout_ms] - Task timeout
 * @param {Object} options.source - Source worker info
 * @param {string} options.target - Target worker ID
 * @param {string} [options.correlation_id] - Correlation ID
 * @returns {Object} The task request message
 */
export function createTaskRequest(taskId, description, options = {}) {
  const payload = {
    task_id: taskId,
    description,
  };

  if (options.criteria) {
    payload.acceptance_criteria = options.criteria;
  }
  if (options.priority) {
    payload.priority = options.priority;
  }
  if (options.context) {
    payload.context = options.context;
  }
  if (options.timeout_ms) {
    payload.timeout_ms = options.timeout_ms;
  }

  return createMessage(MessageTypes.TASK_REQUEST, payload, {
    source: options.source,
    target: options.target,
    correlation_id: options.correlation_id,
    requires_ack: options.requires_ack ?? true,
    ttl_ms: options.ttl_ms,
  });
}

/**
 * Create a task result message
 * @param {string} taskId - Task identifier
 * @param {string} status - Result status (success, failure, partial, blocked)
 * @param {*} output - Task output
 * @param {Object} options - Additional options
 * @param {Object} [options.verification] - Verification result
 * @param {number} [options.duration_ms] - Task duration
 * @param {Object} [options.error] - Error details if failed
 * @param {Object} options.source - Source worker info
 * @param {string} options.target - Target (usually orchestrator)
 * @param {string} [options.correlation_id] - Correlation ID from request
 * @param {string} [options.parent_id] - Parent message ID (the request)
 * @returns {Object} The task result message
 */
export function createTaskResult(taskId, status, output, options = {}) {
  const payload = {
    task_id: taskId,
    status,
  };

  if (output !== undefined) {
    payload.output = output;
  }
  if (options.verification) {
    payload.verification_result = options.verification;
  }
  if (options.duration_ms !== undefined) {
    payload.duration_ms = options.duration_ms;
  }
  if (options.error) {
    payload.error = options.error;
  }

  return createMessage(MessageTypes.TASK_RESULT, payload, {
    source: options.source,
    target: options.target || MessageTargets.ORCHESTRATOR,
    correlation_id: options.correlation_id,
    parent_id: options.parent_id,
    requires_ack: options.requires_ack ?? false,
  });
}

/**
 * Create a status update message
 * @param {string} workerId - Worker identifier
 * @param {string} phase - Current phase/state
 * @param {Object} options - Additional options
 * @param {number} [options.percent] - Progress percentage (0-100)
 * @param {number} [options.confidence] - Confidence level (0-1)
 * @param {string} [options.current_step] - Current step description
 * @param {string[]} [options.blockers] - Current blockers
 * @param {Object} [options.details] - Additional details
 * @param {string} [options.worker_type] - Worker type
 * @param {string} [options.target="orchestrator"] - Target
 * @param {string} [options.correlation_id] - Correlation ID
 * @returns {Object} The status update message
 */
export function createStatusUpdate(workerId, phase, options = {}) {
  const payload = {
    phase,
  };

  if (options.percent !== undefined) {
    payload.percent = options.percent;
  }
  if (options.confidence !== undefined) {
    payload.confidence = options.confidence;
  }
  if (options.current_step) {
    payload.current_step = options.current_step;
  }
  if (options.blockers) {
    payload.blockers = options.blockers;
  }
  if (options.details) {
    payload.details = options.details;
  }

  return createMessage(MessageTypes.STATUS_UPDATE, payload, {
    source: {
      worker_id: workerId,
      worker_type: options.worker_type,
    },
    target: options.target || MessageTargets.ORCHESTRATOR,
    correlation_id: options.correlation_id,
    requires_ack: false,
  });
}

/**
 * Create an error report message
 * @param {string} workerId - Worker identifier
 * @param {Object} error - Error details
 * @param {string} error.type - Error type/classification
 * @param {string} error.message - Error message
 * @param {string} [error.stack] - Stack trace
 * @param {Object} options - Additional options
 * @param {boolean} [options.recovery_attempted=false] - Whether recovery was attempted
 * @param {Object} [options.context] - Error context
 * @param {string} [options.severity] - Error severity
 * @param {string} [options.worker_type] - Worker type
 * @param {string} [options.target="orchestrator"] - Target
 * @param {string} [options.correlation_id] - Correlation ID
 * @returns {Object} The error report message
 */
export function createErrorReport(workerId, error, options = {}) {
  const payload = {
    error_type: error.type,
    message: error.message,
  };

  if (error.stack) {
    payload.stack = error.stack;
  }
  if (options.recovery_attempted !== undefined) {
    payload.recovery_attempted = options.recovery_attempted;
  }
  if (options.context) {
    payload.context = options.context;
  }
  if (options.severity) {
    payload.severity = options.severity;
  }

  return createMessage(MessageTypes.ERROR_REPORT, payload, {
    source: {
      worker_id: workerId,
      worker_type: options.worker_type,
    },
    target: options.target || MessageTargets.ORCHESTRATOR,
    correlation_id: options.correlation_id,
    requires_ack: options.requires_ack ?? true,
  });
}

/**
 * Create an escalation message
 * @param {string} workerId - Worker identifier
 * @param {string} reason - Escalation reason (from EscalationReasons)
 * @param {Object} options - Additional options
 * @param {string} [options.urgency="medium"] - Urgency level
 * @param {Object} [options.context] - Escalation context
 * @param {string[]} [options.attempted_solutions] - Solutions already tried
 * @param {string} [options.recommendation] - Recommended action
 * @param {Object[]} [options.options] - Available options
 * @param {string} [options.worker_type] - Worker type
 * @param {string} [options.target="orchestrator"] - Target
 * @param {string} [options.correlation_id] - Correlation ID
 * @returns {Object} The escalation message
 */
export function createEscalation(workerId, reason, options = {}) {
  const payload = {
    reason,
    urgency: options.urgency || EscalationUrgency.MEDIUM,
  };

  if (options.context) {
    payload.context = options.context;
  }
  if (options.attempted_solutions) {
    payload.attempted_solutions = options.attempted_solutions;
  }
  if (options.recommendation) {
    payload.recommendation = options.recommendation;
  }
  if (options.options) {
    payload.options = options.options;
  }

  return createMessage(MessageTypes.ESCALATION, payload, {
    source: {
      worker_id: workerId,
      worker_type: options.worker_type,
    },
    target: options.target || MessageTargets.ORCHESTRATOR,
    correlation_id: options.correlation_id,
    requires_ack: true,
  });
}

/**
 * Create a verification request message
 * @param {string} taskId - Task identifier
 * @param {*} output - Output to verify
 * @param {Object} options - Additional options
 * @param {string} [options.task_type] - Type of task (code, factual, etc.)
 * @param {string[]} [options.criteria] - Verification criteria
 * @param {Object} [options.context] - Additional context
 * @param {Object} options.source - Source worker info
 * @param {string} options.target - Target verifier
 * @param {string} [options.correlation_id] - Correlation ID
 * @returns {Object} The verification request message
 */
export function createVerificationRequest(taskId, output, options = {}) {
  const payload = {
    task_id: taskId,
    output,
  };

  if (options.task_type) {
    payload.task_type = options.task_type;
  }
  if (options.criteria) {
    payload.criteria = options.criteria;
  }
  if (options.context) {
    payload.context = options.context;
  }

  return createMessage(MessageTypes.VERIFICATION_REQUEST, payload, {
    source: options.source,
    target: options.target,
    correlation_id: options.correlation_id,
    requires_ack: true,
  });
}

/**
 * Create a verification result message
 * @param {string} taskId - Task identifier
 * @param {boolean} valid - Whether output is valid
 * @param {Object} options - Additional options
 * @param {Object[]} [options.critiques] - List of critiques
 * @param {number} [options.confidence] - Confidence in result (0-1)
 * @param {Object[]} [options.evidence] - Supporting evidence
 * @param {Object} options.source - Source verifier info
 * @param {string} options.target - Target (requesting worker)
 * @param {string} [options.correlation_id] - Correlation ID
 * @param {string} [options.parent_id] - Parent request ID
 * @returns {Object} The verification result message
 */
export function createVerificationResult(taskId, valid, options = {}) {
  const payload = {
    task_id: taskId,
    valid,
  };

  if (options.critiques) {
    payload.critiques = options.critiques;
  }
  if (options.confidence !== undefined) {
    payload.confidence = options.confidence;
  }
  if (options.evidence) {
    payload.evidence = options.evidence;
  }

  return createMessage(MessageTypes.VERIFICATION_RESULT, payload, {
    source: options.source,
    target: options.target,
    correlation_id: options.correlation_id,
    parent_id: options.parent_id,
    requires_ack: false,
  });
}

/**
 * Create a context share message
 * @param {string} contextType - Type of context being shared
 * @param {*} content - Context content
 * @param {Object} options - Additional options
 * @param {string} [options.scope] - Scope of sharing
 * @param {number} [options.ttl_ms] - Time-to-live
 * @param {string[]} [options.visibility] - Worker IDs that can see this
 * @param {Object} options.source - Source worker info
 * @param {string} [options.target="broadcast"] - Target
 * @returns {Object} The context share message
 */
export function createContextShare(contextType, content, options = {}) {
  const payload = {
    context_type: contextType,
    content,
  };

  if (options.scope) {
    payload.scope = options.scope;
  }
  if (options.ttl_ms) {
    payload.ttl_ms = options.ttl_ms;
  }
  if (options.visibility) {
    payload.visibility = options.visibility;
  }

  return createMessage(MessageTypes.CONTEXT_SHARE, payload, {
    source: options.source,
    target: options.target || MessageTargets.BROADCAST,
    requires_ack: false,
    ttl_ms: options.message_ttl_ms,
  });
}

/**
 * Link a message to a parent message via correlation
 * @param {Object} message - The message to link
 * @param {Object} parentMessage - The parent message
 * @returns {Object} The message with correlation set
 */
export function linkToParent(message, parentMessage) {
  return {
    ...message,
    correlation_id: parentMessage.correlation_id || parentMessage.id,
    parent_id: parentMessage.id,
  };
}

/**
 * Check if two messages are correlated (part of same conversation)
 * @param {Object} message1 - First message
 * @param {Object} message2 - Second message
 * @returns {boolean} True if messages are correlated
 */
export function areCorrelated(message1, message2) {
  // Same correlation ID
  if (
    message1.correlation_id &&
    message1.correlation_id === message2.correlation_id
  ) {
    return true;
  }
  // One is parent of the other
  if (message1.id === message2.parent_id || message2.id === message1.parent_id) {
    return true;
  }
  // One's ID matches other's correlation
  if (
    message1.id === message2.correlation_id ||
    message2.id === message1.correlation_id
  ) {
    return true;
  }
  return false;
}

export default {
  MessageTypes,
  MessageTargets,
  TaskPriority,
  TaskStatus,
  EscalationUrgency,
  EscalationReasons,
  validateMessage,
  createMessage,
  createTaskRequest,
  createTaskResult,
  createStatusUpdate,
  createErrorReport,
  createEscalation,
  createVerificationRequest,
  createVerificationResult,
  createContextShare,
  linkToParent,
  areCorrelated,
};
