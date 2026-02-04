/**
 * ReflexionLoop - Verbal Reinforcement Learning for Workers
 *
 * Research basis: Shinn et al. (2023) "Reflexion: Language Agents
 * with Verbal Reinforcement Learning" - NeurIPS 2023
 *
 * Key insight: Agents that reflect on failures and store reflections
 * in memory significantly outperform those that don't.
 *
 * Results from paper:
 * - HumanEval (coding): 91% pass rate (vs 80% baseline)
 * - AlfWorld (decision making): 97% success (vs 75% baseline)
 * - HotPotQA (reasoning): +14% accuracy improvement
 *
 * @see /research/15-scientific-enhancements-plan.md Section 2
 */

import { SelfCorrectionLoop, TaskTypes, StopReasons } from './selfCorrectionLoop.js';
import { ReflectionGenerator, IssueCategory, PatternType } from './reflectionGenerator.js';
import { MemoryTypes } from './memoryManager.js';

/**
 * Memory type for reflections
 */
export const REFLECTION_MEMORY_TYPE = 'reflection';

/**
 * ReflexionLoop - Extends SelfCorrectionLoop with reflection memory
 *
 * Key additions:
 * 1. Retrieves relevant past reflections before correction attempts
 * 2. Includes reflections in worker context
 * 3. Generates and stores new reflections on failure
 * 4. Tracks improvement from reflection usage
 */
export class ReflexionLoop extends SelfCorrectionLoop {
  /**
   * @param {Object} verificationPipeline - Verification dependency
   * @param {Object} memoryManager - Memory storage dependency (MemoryManager instance)
   * @param {Object} options - Configuration
   * @param {number} options.maxReflectionsToRetrieve - Max past reflections to retrieve (default: 3)
   * @param {number} options.reflectionMinImportance - Min importance for reflection retrieval (default: 0.3)
   * @param {number} options.reflectionBoostOnSuccess - Importance boost for helpful reflections (default: 0.15)
   * @param {boolean} options.storeReflections - Whether to store new reflections (default: true)
   */
  constructor(verificationPipeline, memoryManager, options = {}) {
    super(verificationPipeline, options);

    if (!memoryManager) {
      console.warn('[ReflexionLoop] No memoryManager provided - reflection storage disabled');
    }

    this.memory = memoryManager;
    this.reflectionGenerator = new ReflectionGenerator({
      maxReflectionLength: options.maxReflectionLength || 800,
      maxLessons: options.maxLessons || 5
    });

    this.maxReflections = options.maxReflectionsToRetrieve || 3;
    this.reflectionMinImportance = options.reflectionMinImportance || 0.3;
    this.reflectionBoostOnSuccess = options.reflectionBoostOnSuccess || 0.15;
    this.storeReflections = options.storeReflections !== false;

    // Extended metrics for Reflexion
    this.reflexionMetrics = {
      reflectionsGenerated: 0,
      reflectionsRetrieved: 0,
      reflectionHits: 0,        // Times reflection was available
      successWithReflection: 0,
      successWithoutReflection: 0,
      failureWithReflection: 0,
      failureWithoutReflection: 0,
      reflectionsReinforced: 0
    };
  }

  /**
   * Run correction loop with reflection memory
   *
   * Extended Loop:
   * 1. Retrieve relevant past reflections for this task type
   * 2. Include reflections in context for worker
   * 3. Run standard correction loop
   * 4. If failed, generate and store reflection
   * 5. If succeeded with reflections, reinforce helpful ones
   * 6. Return result with reflection info
   *
   * @param {Object} worker - Worker interface with sendCritique method
   * @param {string} output - Initial output to verify
   * @param {string} taskType - One of TaskTypes
   * @param {Object} context - Additional context for verification
   * @returns {Promise<Object>} Extended result with reflection info
   */
  async runCorrectionLoop(worker, output, taskType, context = {}) {
    // Step 1: Retrieve relevant past reflections
    const reflections = await this.retrieveRelevantReflections(taskType, context);
    const hadReflections = reflections.length > 0;

    if (hadReflections) {
      this.reflexionMetrics.reflectionHits++;
      this.reflexionMetrics.reflectionsRetrieved += reflections.length;
    }

    // Step 2: Enhance context with reflections
    const enhancedContext = this.enhanceContextWithReflections(context, reflections);

    // Step 3: Run parent correction loop
    const result = await super.runCorrectionLoop(
      worker,
      output,
      taskType,
      enhancedContext
    );

    // Step 4: Handle post-loop reflection logic
    if (result.success) {
      // Track success metrics
      if (hadReflections) {
        this.reflexionMetrics.successWithReflection++;
        // Reinforce helpful reflections
        await this.reinforceReflections(reflections);
      } else {
        this.reflexionMetrics.successWithoutReflection++;
      }
    } else {
      // Track failure metrics
      if (hadReflections) {
        this.reflexionMetrics.failureWithReflection++;
      } else {
        this.reflexionMetrics.failureWithoutReflection++;
      }

      // Generate and store new reflection
      if (this.storeReflections && this.memory) {
        const reflection = await this.generateAndStoreReflection(
          taskType,
          context,
          output,
          result
        );
        result.reflection = reflection;
        this.reflexionMetrics.reflectionsGenerated++;
      }
    }

    // Add reflection info to result
    result.reflexion = {
      hadReflections,
      reflectionCount: reflections.length,
      reflections: reflections.map(r => ({
        id: r.id,
        preview: r.content?.substring(0, 100),
        importance: r.importance
      }))
    };

    return result;
  }

  /**
   * Retrieve past reflections relevant to current task
   *
   * @param {string} taskType - Type of task
   * @param {Object} context - Task context
   * @returns {Promise<Array>} Relevant reflections
   */
  async retrieveRelevantReflections(taskType, context) {
    if (!this.memory) {
      return [];
    }

    try {
      // Build query for reflections
      const query = {
        type: MemoryTypes.EPISODIC, // Reflections are episodic memories
        content: REFLECTION_MEMORY_TYPE // Tag in content
      };

      // Add project filter if available
      if (context.projectId) {
        query.projectId = context.projectId;
      }

      const options = {
        limit: this.maxReflections * 2, // Get extra for filtering
        minImportance: this.reflectionMinImportance,
        updateAccess: true
      };

      let memories = this.memory.retrieve(query, options);

      // Filter to actual reflections and match task type
      memories = memories.filter(mem => {
        // Check if it's a reflection
        if (!mem.content?.includes('Reflection:') && !mem.content?.includes('## Reflection')) {
          return false;
        }

        // Check task type match if available in tags
        if (mem.tags && taskType) {
          if (mem.tags.includes(`taskType:${taskType}`)) {
            return true;
          }
          // Also accept if no task type specified
          if (!mem.tags.some(t => t.startsWith('taskType:'))) {
            return true;
          }
          return false;
        }

        return true;
      });

      // Sort by importance and recency
      memories.sort((a, b) => {
        const importanceDiff = (b.importance || 0) - (a.importance || 0);
        if (Math.abs(importanceDiff) > 0.1) return importanceDiff;
        // Secondary sort by access time
        return new Date(b.accessed_at || 0) - new Date(a.accessed_at || 0);
      });

      return memories.slice(0, this.maxReflections);
    } catch (error) {
      console.error('[ReflexionLoop] Failed to retrieve reflections:', error.message);
      return [];
    }
  }

  /**
   * Enhance correction context with past reflections
   *
   * @param {Object} context - Original context
   * @param {Array} reflections - Retrieved reflections
   * @returns {Object} Enhanced context
   */
  enhanceContextWithReflections(context, reflections) {
    if (reflections.length === 0) {
      return context;
    }

    // Format reflections for inclusion
    const reflectionText = reflections
      .map((r, i) => {
        const importance = r.importance ? ` (relevance: ${Math.round(r.importance * 100)}%)` : '';
        return `### Past Learning ${i + 1}${importance}\n${r.content}`;
      })
      .join('\n\n---\n\n');

    const reflectionContext = `
## Lessons from Past Similar Tasks

The following reflections from previous similar tasks may help avoid past mistakes.
Review these before generating your response.

${reflectionText}

---
Apply relevant lessons above to the current task.
`;

    return {
      ...context,
      pastReflections: reflections,
      reflectionContext,
      // Add to any existing preamble
      preamble: context.preamble
        ? `${context.preamble}\n\n${reflectionContext}`
        : reflectionContext
    };
  }

  /**
   * Generate reflection on failed attempt and store in memory
   *
   * @param {string} taskType - Type of task
   * @param {Object} context - Task context
   * @param {string} originalOutput - Initial output
   * @param {Object} result - Correction loop result
   * @returns {Promise<Object>} Generated reflection
   */
  async generateAndStoreReflection(taskType, context, originalOutput, result) {
    const reflection = await this.reflectionGenerator.generate({
      taskType,
      taskDescription: context.taskDescription || context.description || 'Unknown task',
      originalOutput: originalOutput?.substring(0, 500),
      finalOutput: result.finalOutput?.substring(0, 500),
      iterations: result.iterations,
      remainingIssues: result.remainingIssues,
      history: result.history,
      stopReason: result.stopReason,
      context
    });

    // Store in memory
    if (this.memory) {
      try {
        const importance = this.calculateReflectionImportance(result, reflection);

        const memoryId = this.memory.store({
          type: MemoryTypes.EPISODIC,
          content: reflection.content,
          importance,
          projectId: context.projectId,
          workerId: context.workerId,
          taskId: context.taskId,
          source: 'reflexion_loop',
          tags: [
            REFLECTION_MEMORY_TYPE,
            `taskType:${taskType}`,
            `stopReason:${result.stopReason}`,
            ...Object.keys(reflection.issueCategories).map(c => `issue:${c}`),
            ...reflection.patterns.map(p => `pattern:${p.type}`)
          ]
        });

        reflection.memoryId = memoryId;
      } catch (error) {
        console.error('[ReflexionLoop] Failed to store reflection:', error.message);
      }
    }

    return reflection;
  }

  /**
   * Calculate importance score for a reflection
   *
   * Higher importance for:
   * - More iterations (harder problems)
   * - More remaining issues (significant learning opportunity)
   * - Detected patterns (systematic insights)
   * - Security or logic issues (critical)
   */
  calculateReflectionImportance(result, reflection) {
    let importance = 0.5; // Base importance

    // More iterations = harder problem = more important to remember
    importance += Math.min(result.iterations * 0.08, 0.25);

    // Many remaining issues = significant learning opportunity
    const issueCount = result.remainingIssues?.length || 0;
    if (issueCount >= 5) {
      importance += 0.15;
    } else if (issueCount >= 2) {
      importance += 0.08;
    }

    // Detected patterns = systematic insight
    if (reflection.patterns?.length > 0) {
      importance += 0.1;
    }

    // Critical issue categories get higher importance
    const categories = reflection.issueCategories || {};
    if (categories[IssueCategory.SECURITY]?.length > 0) {
      importance += 0.15;
    }
    if (categories[IssueCategory.LOGIC]?.length > 0) {
      importance += 0.1;
    }

    // Stop reason adjustments
    if (result.stopReason === StopReasons.NO_NEW_CRITIQUES) {
      importance += 0.1; // Stagnation is valuable to remember
    }

    return Math.min(importance, 1.0);
  }

  /**
   * Reinforce reflections that helped achieve success
   *
   * @param {Array} reflections - Reflections that were used
   */
  async reinforceReflections(reflections) {
    if (!this.memory || reflections.length === 0) {
      return;
    }

    for (const reflection of reflections) {
      if (reflection.id) {
        try {
          const reinforced = this.memory.reinforce(reflection.id, this.reflectionBoostOnSuccess);
          if (reinforced) {
            this.reflexionMetrics.reflectionsReinforced++;
          }
        } catch (error) {
          // Non-critical error
          console.warn('[ReflexionLoop] Failed to reinforce reflection:', reflection.id);
        }
      }
    }
  }

  /**
   * Get extended metrics including Reflexion stats
   *
   * @returns {Object} Combined metrics
   */
  getMetrics() {
    const baseMetrics = super.getMetrics();

    // Calculate derived metrics
    const totalWithReflection =
      this.reflexionMetrics.successWithReflection +
      this.reflexionMetrics.failureWithReflection;

    const totalWithoutReflection =
      this.reflexionMetrics.successWithoutReflection +
      this.reflexionMetrics.failureWithoutReflection;

    const successRateWithReflection = totalWithReflection > 0
      ? this.reflexionMetrics.successWithReflection / totalWithReflection
      : 0;

    const successRateWithoutReflection = totalWithoutReflection > 0
      ? this.reflexionMetrics.successWithoutReflection / totalWithoutReflection
      : 0;

    const reflectionImprovement = successRateWithoutReflection > 0
      ? (successRateWithReflection - successRateWithoutReflection) / successRateWithoutReflection
      : 0;

    return {
      ...baseMetrics,
      reflexion: {
        ...this.reflexionMetrics,
        successRateWithReflection,
        successRateWithoutReflection,
        reflectionImprovement, // Positive = reflections helping
        reflectionHitRate: baseMetrics.totalLoops > 0
          ? this.reflexionMetrics.reflectionHits / baseMetrics.totalLoops
          : 0
      }
    };
  }

  /**
   * Reset all metrics including Reflexion stats
   */
  resetMetrics() {
    super.resetMetrics();
    this.reflexionMetrics = {
      reflectionsGenerated: 0,
      reflectionsRetrieved: 0,
      reflectionHits: 0,
      successWithReflection: 0,
      successWithoutReflection: 0,
      failureWithReflection: 0,
      failureWithoutReflection: 0,
      reflectionsReinforced: 0
    };
  }

  /**
   * Get summary of reflection effectiveness
   *
   * @returns {Object} Summary statistics
   */
  getReflectionEffectiveness() {
    const metrics = this.getMetrics();
    const r = metrics.reflexion;

    return {
      isEffective: r.reflectionImprovement > 0,
      improvement: `${(r.reflectionImprovement * 100).toFixed(1)}%`,
      recommendation: r.reflectionImprovement > 0.1
        ? 'Reflections significantly improving outcomes'
        : r.reflectionImprovement > 0
          ? 'Reflections providing modest improvement'
          : r.reflectionImprovement < -0.1
            ? 'Reflections may be counterproductive - review quality'
            : 'Insufficient data to determine effectiveness',
      stats: {
        tasksWithReflections: r.successWithReflection + r.failureWithReflection,
        tasksWithoutReflections: r.successWithoutReflection + r.failureWithoutReflection,
        reflectionsStored: r.reflectionsGenerated,
        reflectionsReinforced: r.reflectionsReinforced
      }
    };
  }
}

// Re-export dependencies for convenience
export { TaskTypes, StopReasons } from './selfCorrectionLoop.js';
export { IssueCategory, PatternType } from './reflectionGenerator.js';

export default ReflexionLoop;
