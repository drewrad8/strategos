/**
 * ConfidenceEstimator - Uncertainty Quantification through Consistency
 *
 * Purpose: Estimate confidence in LLM outputs using multi-sample consistency.
 *
 * Research Basis:
 * - "A Survey of Confidence Estimation and Calibration in Large Language Models" (NAACL 2024)
 * - "Can LLMs Express Their Uncertainty?" (ICLR 2024)
 * - "Uncertainty Quantification and Confidence Calibration in LLMs: A Survey" (KDD 2025)
 *
 * Key Insights:
 * 1. LLMs are OVERCONFIDENT when verbalizing confidence
 * 2. Self-consistency (multiple samples) correlates with correctness
 * 3. Consistency-based confidence outperforms verbalized confidence
 */

// ============================================
// CONFIDENCE LEVELS
// ============================================

export const ConfidenceLevel = {
  HIGH: 'high',         // >0.8 consistency
  MEDIUM: 'medium',     // 0.5-0.8 consistency
  LOW: 'low',           // <0.5 consistency
  UNCERTAIN: 'uncertain' // No clear majority or insufficient data
};

// ============================================
// SIMILARITY METHODS
// ============================================

export const SimilarityMethod = {
  EXACT: 'exact',         // Exact match (for structured output)
  SEMANTIC: 'semantic',   // Semantic similarity (for free-form text)
  STRUCTURAL: 'structural' // Structure comparison (for code/JSON)
};

// ============================================
// CONFIDENCE ESTIMATOR CLASS
// ============================================

export class ConfidenceEstimator {
  /**
   * @param {Object} options - Configuration options
   * @param {number} options.numSamples - Number of samples to generate (default: 3)
   * @param {number} options.highThreshold - Threshold for high confidence (default: 0.8)
   * @param {number} options.lowThreshold - Threshold for low confidence (default: 0.5)
   * @param {string} options.similarityMethod - How to compare responses (default: 'semantic')
   * @param {number} options.timeout - Timeout per sample generation in ms (default: 30000)
   */
  constructor(options = {}) {
    this.numSamples = options.numSamples || 3;
    this.highThreshold = options.highThreshold || 0.8;
    this.lowThreshold = options.lowThreshold || 0.5;
    this.similarityMethod = options.similarityMethod || SimilarityMethod.SEMANTIC;
    this.timeout = options.timeout || 30000;

    // Metrics tracking
    this.metrics = {
      estimationsRun: 0,
      highConfidenceCount: 0,
      mediumConfidenceCount: 0,
      lowConfidenceCount: 0,
      uncertainCount: 0,
      escalationsTriggered: 0,
      averageConfidence: 0,
      totalConfidence: 0
    };
  }

  /**
   * Estimate confidence for a task through multi-sample consistency
   *
   * @param {Function} generateFn - Async function that generates a response
   * @param {Object} context - Task context passed to generateFn
   * @returns {Promise<ConfidenceResult>}
   */
  async estimateConfidence(generateFn, context = {}) {
    this.metrics.estimationsRun++;

    // Generate multiple responses
    const responses = await this.generateSamples(generateFn, context);

    // Filter successful responses
    const validResponses = responses.filter(r => r.content !== null && !r.error);

    if (validResponses.length < 2) {
      return this.createResult({
        confidence: 0,
        level: ConfidenceLevel.UNCERTAIN,
        reason: 'Insufficient valid responses',
        needsReview: true,
        responses
      });
    }

    // Calculate consistency
    const consistency = await this.calculateConsistency(validResponses);

    // Determine confidence level
    const level = this.determineLevel(consistency.score);

    // Track metrics
    this.updateMetrics(level, consistency.score);

    const needsReview = level === ConfidenceLevel.LOW || level === ConfidenceLevel.UNCERTAIN;
    if (needsReview) {
      this.metrics.escalationsTriggered++;
    }

    return this.createResult({
      confidence: consistency.score,
      level,
      needsReview,
      majorityResponse: consistency.majority,
      agreement: consistency.agreement,
      divergentPoints: consistency.divergentPoints,
      responses: validResponses,
      method: this.similarityMethod
    });
  }

  /**
   * Generate multiple samples
   */
  async generateSamples(generateFn, context) {
    const responses = [];

    for (let i = 0; i < this.numSamples; i++) {
      try {
        const response = await this.withTimeout(
          generateFn(context),
          this.timeout
        );
        responses.push({
          content: response,
          index: i,
          timestamp: Date.now()
        });
      } catch (error) {
        responses.push({
          content: null,
          index: i,
          error: error.message,
          timestamp: Date.now()
        });
      }
    }

    return responses;
  }

  /**
   * Wrap promise with timeout
   */
  async withTimeout(promise, ms) {
    return Promise.race([
      promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Generation timeout')), ms)
      )
    ]);
  }

  /**
   * Calculate consistency across responses
   */
  async calculateConsistency(responses) {
    if (responses.length === 0) {
      return { score: 0, majority: null, agreement: 0, divergentPoints: [] };
    }

    if (responses.length === 1) {
      return {
        score: 0.5, // Unknown consistency with single sample
        majority: responses[0].content,
        agreement: 1,
        divergentPoints: []
      };
    }

    switch (this.similarityMethod) {
      case SimilarityMethod.EXACT:
        return this.calculateExactConsistency(responses);
      case SimilarityMethod.SEMANTIC:
        return this.calculateSemanticConsistency(responses);
      case SimilarityMethod.STRUCTURAL:
        return this.calculateStructuralConsistency(responses);
      default:
        return this.calculateSemanticConsistency(responses);
    }
  }

  /**
   * Exact match consistency (for structured outputs)
   */
  calculateExactConsistency(responses) {
    const counts = new Map();

    for (const response of responses) {
      const normalized = this.normalizeResponse(response.content);
      counts.set(normalized, (counts.get(normalized) || 0) + 1);
    }

    // Find majority
    let maxCount = 0;
    let majority = null;
    let majorityNormalized = null;
    for (const [normalized, count] of counts) {
      if (count > maxCount) {
        maxCount = count;
        majorityNormalized = normalized;
      }
    }

    // Find original content for majority
    majority = responses.find(
      r => this.normalizeResponse(r.content) === majorityNormalized
    )?.content;

    const score = maxCount / responses.length;
    const divergent = responses
      .filter(r => this.normalizeResponse(r.content) !== majorityNormalized)
      .map(r => r.content?.substring(0, 100) || '');

    return {
      score,
      majority,
      agreement: maxCount,
      divergentPoints: divergent
    };
  }

  /**
   * Semantic similarity consistency (for free-form text)
   */
  calculateSemanticConsistency(responses) {
    // Extract key assertions from each response
    const assertions = responses.map(r => this.extractKeyAssertions(r.content));

    // Find common assertions
    const allAssertions = new Set(assertions.flat());
    const assertionCounts = new Map();

    for (const assertion of allAssertions) {
      let count = 0;
      for (const responseAssertions of assertions) {
        if (responseAssertions.some(a => this.assertionsSimilar(a, assertion))) {
          count++;
        }
      }
      assertionCounts.set(assertion, count);
    }

    // Score based on how many assertions are shared
    const totalAssertions = allAssertions.size;
    const threshold = Math.ceil(responses.length / 2);
    const sharedAssertions = [...assertionCounts.values()]
      .filter(c => c >= threshold).length;

    const score = totalAssertions > 0 ? sharedAssertions / totalAssertions : 0;

    // Identify divergent points (assertions only in one response)
    const divergent = [...assertionCounts.entries()]
      .filter(([_, count]) => count === 1)
      .map(([assertion]) => assertion)
      .slice(0, 5);

    // Find most representative response (most shared assertions)
    let bestResponse = responses[0];
    let bestScore = 0;
    for (const response of responses) {
      const responseAssertions = this.extractKeyAssertions(response.content);
      const sharedCount = responseAssertions.filter(a =>
        (assertionCounts.get(a) || 0) >= threshold
      ).length;
      if (sharedCount > bestScore) {
        bestScore = sharedCount;
        bestResponse = response;
      }
    }

    return {
      score,
      majority: bestResponse.content,
      agreement: sharedAssertions,
      divergentPoints: divergent
    };
  }

  /**
   * Structural consistency (for code/JSON)
   */
  calculateStructuralConsistency(responses) {
    // Compare structure rather than exact content
    const structures = responses.map(r => this.extractStructure(r.content));

    const structureCounts = new Map();
    for (const structure of structures) {
      const key = JSON.stringify(structure);
      structureCounts.set(key, (structureCounts.get(key) || 0) + 1);
    }

    let maxCount = 0;
    let majorityKey = null;
    for (const [key, count] of structureCounts) {
      if (count > maxCount) {
        maxCount = count;
        majorityKey = key;
      }
    }

    // Find a response with the majority structure
    const majorityResponse = responses.find(r =>
      JSON.stringify(this.extractStructure(r.content)) === majorityKey
    );

    return {
      score: maxCount / responses.length,
      majority: majorityResponse?.content,
      agreement: maxCount,
      divergentPoints: []
    };
  }

  /**
   * Extract key assertions from text
   */
  extractKeyAssertions(text) {
    if (!text) return [];

    // Split into sentences
    const sentences = text.split(/[.!?]+/)
      .map(s => s.trim())
      .filter(s => s.length > 10);

    // Filter to declarative sentences (simple heuristic)
    return sentences
      .filter(s => !s.includes('?'))
      .filter(s => !s.toLowerCase().startsWith('i think'))
      .filter(s => !s.toLowerCase().startsWith('perhaps'))
      .filter(s => !s.toLowerCase().startsWith('maybe'))
      .slice(0, 10);
  }

  /**
   * Check if two assertions are semantically similar
   */
  assertionsSimilar(a, b) {
    if (!a || !b) return false;

    // Simple: significant word overlap
    const wordsA = new Set(
      a.toLowerCase().split(/\s+/).filter(w => w.length > 3)
    );
    const wordsB = new Set(
      b.toLowerCase().split(/\s+/).filter(w => w.length > 3)
    );

    if (wordsA.size === 0 || wordsB.size === 0) return false;

    let overlap = 0;
    for (const word of wordsA) {
      if (wordsB.has(word)) overlap++;
    }

    const similarity = overlap / Math.max(wordsA.size, wordsB.size);
    return similarity > 0.5;
  }

  /**
   * Extract structure from code/JSON
   */
  extractStructure(content) {
    if (!content) return { type: 'empty' };

    // Try to parse as JSON
    try {
      const parsed = JSON.parse(content);
      return this.getObjectStructure(parsed);
    } catch {
      // For code: extract function signatures, class names, etc.
      const functions = content.match(/function\s+\w+|const\s+\w+\s*=|let\s+\w+\s*=/g) || [];
      const classes = content.match(/class\s+\w+/g) || [];
      const imports = content.match(/import\s+/g) || [];
      return {
        type: 'code',
        functions: functions.length,
        classes: classes.length,
        imports: imports.length
      };
    }
  }

  /**
   * Get structure of an object (for JSON comparison)
   */
  getObjectStructure(obj, depth = 0) {
    if (depth > 3) return 'nested';
    if (obj === null) return 'null';
    if (Array.isArray(obj)) {
      return {
        type: 'array',
        length: obj.length,
        itemType: obj.length > 0 ? this.getObjectStructure(obj[0], depth + 1) : 'empty'
      };
    }
    if (typeof obj === 'object') {
      const keys = Object.keys(obj).sort();
      const structure = { type: 'object', keys: [] };
      for (const key of keys) {
        structure.keys.push({
          name: key,
          valueType: this.getObjectStructure(obj[key], depth + 1)
        });
      }
      return structure;
    }
    return typeof obj;
  }

  /**
   * Normalize response for comparison
   */
  normalizeResponse(content) {
    if (!content) return '';
    return content.toLowerCase().replace(/\s+/g, ' ').trim();
  }

  /**
   * Determine confidence level from score
   */
  determineLevel(score) {
    if (score >= this.highThreshold) return ConfidenceLevel.HIGH;
    if (score >= this.lowThreshold) return ConfidenceLevel.MEDIUM;
    if (score > 0) return ConfidenceLevel.LOW;
    return ConfidenceLevel.UNCERTAIN;
  }

  /**
   * Update metrics
   */
  updateMetrics(level, confidence) {
    switch (level) {
      case ConfidenceLevel.HIGH:
        this.metrics.highConfidenceCount++;
        break;
      case ConfidenceLevel.MEDIUM:
        this.metrics.mediumConfidenceCount++;
        break;
      case ConfidenceLevel.LOW:
        this.metrics.lowConfidenceCount++;
        break;
      case ConfidenceLevel.UNCERTAIN:
        this.metrics.uncertainCount++;
        break;
    }

    // Update running average
    this.metrics.totalConfidence += confidence;
    this.metrics.averageConfidence =
      this.metrics.totalConfidence / this.metrics.estimationsRun;
  }

  /**
   * Create standardized result object
   */
  createResult(data) {
    return {
      confidence: data.confidence,
      level: data.level,
      needsReview: data.needsReview,
      majorityResponse: data.majorityResponse || null,
      agreement: data.agreement || 0,
      divergentPoints: data.divergentPoints || [],
      responses: data.responses || [],
      method: data.method || this.similarityMethod,
      reason: data.reason || null
    };
  }

  /**
   * Quick confidence check (single sample comparison to expected)
   * For use when multi-sample is too expensive
   */
  quickConfidenceCheck(response, expectedPattern) {
    if (!response || !expectedPattern) {
      return {
        confidence: 0,
        level: ConfidenceLevel.UNCERTAIN,
        matches: false
      };
    }

    // Check if response matches expected pattern
    const matches = expectedPattern instanceof RegExp
      ? expectedPattern.test(response)
      : response.toLowerCase().includes(expectedPattern.toLowerCase());

    return {
      confidence: matches ? 0.7 : 0.3,
      level: matches ? ConfidenceLevel.MEDIUM : ConfidenceLevel.LOW,
      matches
    };
  }

  /**
   * Get metrics
   */
  getMetrics() {
    return {
      ...this.metrics,
      escalationRate: this.metrics.estimationsRun > 0
        ? this.metrics.escalationsTriggered / this.metrics.estimationsRun
        : 0,
      highConfidenceRate: this.metrics.estimationsRun > 0
        ? this.metrics.highConfidenceCount / this.metrics.estimationsRun
        : 0
    };
  }

  /**
   * Reset metrics
   */
  resetMetrics() {
    this.metrics = {
      estimationsRun: 0,
      highConfidenceCount: 0,
      mediumConfidenceCount: 0,
      lowConfidenceCount: 0,
      uncertainCount: 0,
      escalationsTriggered: 0,
      averageConfidence: 0,
      totalConfidence: 0
    };
  }
}

export default ConfidenceEstimator;
