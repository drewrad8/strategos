/**
 * Foundation Layer - Core Infrastructure Components
 *
 * Provides fundamental patterns for reliability, communication, and monitoring.
 * Based on research synthesis: Error recovery, health monitoring, circuit breaking.
 */

// Circuit Breaker - Prevents cascade failures
export {
  CircuitBreaker,
  CircuitOpenError,
  CircuitBreakerError,
  circuitBreakers,
  getBreaker,
  removeBreaker,
  clearBreakers,
  getAllMetrics as getCircuitBreakerMetrics
} from './circuitBreaker.js';

// Error Recovery - Tiered error classification and recovery
export {
  ErrorRecovery,
  ERROR_TYPES,
  RECOVERY_ACTIONS,
  createErrorRecovery
} from './errorRecovery.js';

// Message Schema - Validated inter-worker communication
export {
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
  areCorrelated
} from './messageSchema.js';

// Context Builder - Structured XML context for workers
export {
  buildWorkerContext,
  buildTaskContext,
  compressContext,
  estimateTokens,
  DEFAULT_CONFIG as DEFAULT_CONTEXT_CONFIG
} from './contextBuilder.js';

// Health Monitor - Enhanced worker health tracking
export {
  HealthMonitor,
  HealthStatus,
  calculateHealthScore,
  CHECK_WEIGHTS
} from './healthMonitor.js';
