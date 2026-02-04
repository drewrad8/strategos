/**
 * Coordination Layer - Multi-Agent Coordination Components
 *
 * Provides multi-agent review, debate protocol, state synchronization, and escalation.
 * Based on research: Inter-worker communication, error recovery, self-awareness.
 */

// Multi-Agent Review - Spawn review workers for validation
export {
  MultiAgentReview,
  ReviewRoles,
  Verdicts,
  Severity,
  createMultiAgentReview
} from './multiAgentReview.js';

// Multi-Agent Debate - Structured debate for improved accuracy
// Research: Du et al. (ICML 2024) "Improving Factuality and Reasoning through Multiagent Debate"
export {
  DebateProtocol,
  ConsensusMethod,
  DebatePhase
} from './debateProtocol.js';

// State Sync - Versioned shared state with locking
export {
  StateSync,
  VersionConflictError,
  LockHeldError,
  KeyNotFoundError,
  getStateSync,
  resetStateSync
} from './stateSync.js';

// Escalation System - Route issues to human review
export {
  EscalationSystem,
  EscalationReasons,
  UrgencyLevels,
  EscalationStatus,
  URGENCY_PRIORITY
} from './escalationSystem.js';
