/**
 * Intelligence Layer - AI Enhancement Components
 *
 * Provides verification, self-correction, task decomposition, memory,
 * and scientifically-backed enhancements (Reflexion, Enhanced Verification).
 *
 * Based on research:
 * - CRITIC framework (Kamoi et al., TACL 2024)
 * - Reflexion (Shinn et al., NeurIPS 2023)
 * - Self-Correction limitations (Huang et al., ICLR 2024)
 *
 * @see /research/15-scientific-enhancements-plan.md
 */

// Verification Pipeline - External verification of outputs
export {
  VerificationPipeline,
  TaskTypes,
  Severity,
  CritiqueTypes,
  createCritique
} from './verificationPipeline.js';

// Self-Correction Loop - Iterative improvement with verification
export {
  SelfCorrectionLoop,
  StopReasons
} from './selfCorrectionLoop.js';

// Reflexion Loop - Extended self-correction with reflection memory
// Research: Shinn et al. (2023) "Reflexion: Language Agents with Verbal Reinforcement Learning"
export {
  ReflexionLoop,
  REFLECTION_MEMORY_TYPE
} from './reflexionLoop.js';

// Reflection Generator - Generate verbal reflections on failed tasks
export {
  ReflectionGenerator,
  IssueCategory,
  PatternType
} from './reflectionGenerator.js';

// Enhanced Verification Tools - External feedback tools
// Research: Huang et al. (2024) "LLMs Cannot Self-Correct Reasoning Yet"
export {
  VerificationTool,
  CodeExecutor,
  SymbolicCalculator,
  SchemaValidator,
  ConsistencyChecker,
  WebSearchVerifier,
  EnhancedVerificationPipeline
} from './verificationTools.js';

// Task Decomposer - Break complex tasks into subtasks
export {
  TaskDecomposer,
  DecompositionStrategy,
  ComplexityLevel,
  AssignableType,
  toWorkflowTasks,
  createDecomposer
} from './taskDecomposer.js';

// Memory Manager - Persistent knowledge with decay
export {
  MemoryManager,
  MemoryTypes,
  RelationshipTypes
} from './memoryManager.js';

// Confidence Estimator - Uncertainty quantification through consistency
// Research: "Can LLMs Express Their Uncertainty?" (ICLR 2024)
export {
  ConfidenceEstimator,
  ConfidenceLevel,
  SimilarityMethod
} from './confidenceEstimator.js';
