/**
 * Multi-Agent Review System
 *
 * Purpose: Spawn review workers for reasoning task verification.
 *
 * Research Basis: 11-CRITIC Framework - "Multi-agent validation for complex decisions"
 *
 * Key insights from research:
 * - LLMs alone cannot reliably self-critique without external feedback
 * - Multi-agent validation provides diverse perspectives
 * - Different roles catch different types of errors
 * - External grounding prevents echo chambers
 */

import { v4 as uuidv4 } from 'uuid';

// ============================================
// REVIEW ROLES
// ============================================

export const ReviewRoles = {
  REVIEWER: 'reviewer',
  DEVIL_ADVOCATE: 'devil_advocate',
  FACT_CHECKER: 'fact_checker',
  LOGIC_VALIDATOR: 'logic_validator'
};

// ============================================
// VERDICT TYPES
// ============================================

export const Verdicts = {
  APPROVE: 'approve',
  REVISE: 'revise',
  REJECT: 'reject'
};

// ============================================
// SEVERITY LEVELS
// ============================================

export const Severity = {
  ERROR: 'error',
  WARNING: 'warning',
  INFO: 'info'
};

// ============================================
// ROLE-SPECIFIC PROMPTS
// ============================================

const ROLE_PROMPTS = {
  [ReviewRoles.REVIEWER]: `You are a quality reviewer. Analyze the output for:
1. COMPLETENESS: Does it fully address the requirements?
2. CLARITY: Is it well-organized and understandable?
3. QUALITY: Does it meet professional standards?
4. ACCURACY: Are there obvious errors or issues?

Provide specific, actionable feedback.`,

  [ReviewRoles.DEVIL_ADVOCATE]: `You are a devil's advocate. Your job is to challenge assumptions and find weaknesses:
1. ASSUMPTIONS: What unstated assumptions could be wrong?
2. EDGE CASES: What scenarios might cause failure?
3. ALTERNATIVES: What better approaches exist?
4. BLIND SPOTS: What has been overlooked?

Be constructively critical - find problems others might miss.`,

  [ReviewRoles.FACT_CHECKER]: `You are a fact checker. Verify factual claims:
1. CLAIMS: Identify all factual assertions
2. ACCURACY: Which claims can you verify or refute?
3. SOURCES: Are claims properly supported?
4. OUTDATED: Could any information be outdated?

Flag any claims that appear incorrect or unverifiable.`,

  [ReviewRoles.LOGIC_VALIDATOR]: `You are a logic validator. Check logical consistency:
1. PREMISES: Are the starting assumptions valid?
2. REASONING: Does each step follow logically?
3. CONSISTENCY: Are there contradictions?
4. CONCLUSIONS: Do conclusions follow from the reasoning?

Identify any logical fallacies or reasoning errors.`
};

// ============================================
// MULTI-AGENT REVIEW CLASS
// ============================================

export class MultiAgentReview {
  /**
   * @param {Object} workerManager - Worker manager instance with runHeadless method
   * @param {Object} options - Configuration options
   * @param {number} options.reviewerCount - Number of reviewers to spawn (default: 2)
   * @param {string[]} options.roles - Roles to use (default: ['reviewer', 'devil_advocate'])
   * @param {number} options.consensusThreshold - Threshold for consensus (default: 0.7)
   * @param {number} options.timeout - Timeout in ms for each reviewer (default: 60000)
   * @param {string} options.projectPath - Path for running headless reviews
   */
  constructor(workerManager, options = {}) {
    if (!workerManager) {
      throw new Error('workerManager is required');
    }

    this.workerManager = workerManager;
    this.options = {
      reviewerCount: 2,
      roles: [ReviewRoles.REVIEWER, ReviewRoles.DEVIL_ADVOCATE],
      consensusThreshold: 0.7,
      timeout: 60000,
      projectPath: process.cwd(),
      ...options
    };

    // Validate roles
    for (const role of this.options.roles) {
      if (!Object.values(ReviewRoles).includes(role)) {
        throw new Error(`Invalid role: ${role}`);
      }
    }
  }

  /**
   * Run multi-agent review on output
   * @param {string} output - The output to review
   * @param {Object} context - Context for the review
   * @param {string} context.task - Original task description
   * @param {string} context.taskType - Type of task (reasoning, factual, code, etc.)
   * @param {string[]} context.requirements - Acceptance criteria
   * @returns {Promise<ReviewResult>}
   */
  async review(output, context = {}) {
    const reviewId = uuidv4().slice(0, 8);
    const startTime = Date.now();

    // Determine which roles to use
    const rolesToUse = this._selectRoles(context);

    // Spawn review workers in parallel
    const reviewPromises = rolesToUse.map((role, index) =>
      this._spawnReviewer(reviewId, role, output, context, index)
    );

    // Wait for all reviews with timeout handling
    const reviews = await Promise.allSettled(reviewPromises);

    // Process results
    const successfulReviews = [];
    const failedReviews = [];

    for (let i = 0; i < reviews.length; i++) {
      const result = reviews[i];
      if (result.status === 'fulfilled') {
        successfulReviews.push(result.value);
      } else {
        failedReviews.push({
          role: rolesToUse[i],
          error: result.reason?.message || 'Unknown error'
        });
      }
    }

    // Aggregate critiques from successful reviews
    const aggregatedCritiques = this.aggregateCritiques(successfulReviews);

    // Calculate consensus and confidence
    const consensus = this._calculateConsensus(successfulReviews);
    const confidence = this._calculateConfidence(successfulReviews, failedReviews.length);

    // Determine verdict
    const verdict = this._determineVerdict(aggregatedCritiques, consensus, confidence);

    return {
      reviewId,
      verdict,
      confidence,
      critiques: aggregatedCritiques,
      consensus: consensus.hasConsensus,
      consensusDetails: consensus,
      reviews: successfulReviews,
      failedReviews,
      metadata: {
        reviewerCount: rolesToUse.length,
        successfulCount: successfulReviews.length,
        failedCount: failedReviews.length,
        durationMs: Date.now() - startTime,
        roles: rolesToUse
      }
    };
  }

  /**
   * Aggregate critiques from multiple reviews
   * @param {Object[]} reviews - Array of review results
   * @returns {Critique[]} - Aggregated and prioritized critiques
   */
  aggregateCritiques(reviews) {
    if (!reviews || reviews.length === 0) {
      return [];
    }

    const allCritiques = [];

    // Collect all critiques from reviews
    for (const review of reviews) {
      if (review.critiques && Array.isArray(review.critiques)) {
        for (const critique of review.critiques) {
          allCritiques.push({
            ...critique,
            source: review.role,
            sourceId: review.reviewerId
          });
        }
      }
    }

    // Deduplicate similar critiques
    const deduped = this._deduplicateCritiques(allCritiques);

    // Sort by severity (error > warning > info), then by frequency
    const sorted = deduped.sort((a, b) => {
      const severityOrder = { error: 0, warning: 1, info: 2 };
      const aSeverity = severityOrder[a.severity] ?? 2;
      const bSeverity = severityOrder[b.severity] ?? 2;

      if (aSeverity !== bSeverity) {
        return aSeverity - bSeverity;
      }

      // Higher agreement count = more important
      return (b.agreementCount || 1) - (a.agreementCount || 1);
    });

    return sorted;
  }

  /**
   * Select roles based on context and options
   * @private
   */
  _selectRoles(context) {
    const { taskType } = context;
    let roles = [...this.options.roles];

    // Add task-specific roles if not already included
    if (taskType === 'factual' && !roles.includes(ReviewRoles.FACT_CHECKER)) {
      roles.push(ReviewRoles.FACT_CHECKER);
    }

    if (taskType === 'reasoning' && !roles.includes(ReviewRoles.LOGIC_VALIDATOR)) {
      roles.push(ReviewRoles.LOGIC_VALIDATOR);
    }

    // Limit to reviewerCount
    return roles.slice(0, this.options.reviewerCount);
  }

  /**
   * Spawn a single reviewer worker
   * @private
   */
  async _spawnReviewer(reviewId, role, output, context, index) {
    const reviewerId = `${reviewId}-${role}-${index}`;
    const rolePrompt = ROLE_PROMPTS[role] || ROLE_PROMPTS[ReviewRoles.REVIEWER];

    const prompt = this._buildReviewPrompt(rolePrompt, output, context);

    try {
      // Create timeout promise
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Review timed out')), this.options.timeout);
      });

      // Run headless review
      const reviewPromise = this.workerManager.runHeadless(
        this.options.projectPath,
        prompt,
        {
          outputFormat: 'json',
          systemPrompt: `You are a ${role.replace('_', ' ')} in a multi-agent review system. Always respond in valid JSON format.`,
          timeout: this.options.timeout
        }
      );

      // Race between review and timeout
      const result = await Promise.race([reviewPromise, timeoutPromise]);

      // Parse and validate result
      return this._parseReviewResult(result, role, reviewerId);
    } catch (error) {
      throw new Error(`Reviewer ${role} failed: ${error.message}`);
    }
  }

  /**
   * Build the review prompt
   * @private
   */
  _buildReviewPrompt(rolePrompt, output, context) {
    const parts = [
      rolePrompt,
      '',
      '---',
      '',
      'TASK CONTEXT:',
      context.task || 'No task description provided',
      ''
    ];

    if (context.requirements && context.requirements.length > 0) {
      parts.push('REQUIREMENTS:');
      for (const req of context.requirements) {
        parts.push(`- ${req}`);
      }
      parts.push('');
    }

    parts.push(
      'OUTPUT TO REVIEW:',
      '```',
      output,
      '```',
      '',
      'Provide your review as JSON with this structure:',
      '```json',
      '{',
      '  "verdict": "approve" | "revise" | "reject",',
      '  "confidence": 0.0-1.0,',
      '  "summary": "Brief summary of findings",',
      '  "critiques": [',
      '    {',
      '      "type": "string (e.g., logical_error, factual_error, incompleteness)",',
      '      "severity": "error" | "warning" | "info",',
      '      "location": "Where in the output (optional)",',
      '      "message": "What is wrong",',
      '      "evidence": "Supporting evidence (optional)",',
      '      "suggestion": "How to fix (optional)"',
      '    }',
      '  ]',
      '}',
      '```'
    );

    return parts.join('\n');
  }

  /**
   * Parse and validate review result
   * @private
   */
  _parseReviewResult(result, role, reviewerId) {
    // Handle both parsed JSON and raw string
    let parsed = result;
    if (typeof result === 'string') {
      try {
        parsed = JSON.parse(result);
      } catch {
        // Try to extract JSON from response
        const jsonMatch = result.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          try {
            parsed = JSON.parse(jsonMatch[0]);
          } catch {
            // Fallback to basic structure
            parsed = {
              verdict: Verdicts.REVISE,
              confidence: 0.5,
              summary: result.slice(0, 200),
              critiques: []
            };
          }
        }
      }
    }

    // Normalize and validate
    const normalized = {
      reviewerId,
      role,
      verdict: this._normalizeVerdict(parsed.verdict),
      confidence: this._normalizeConfidence(parsed.confidence),
      summary: parsed.summary || '',
      critiques: this._normalizeCritiques(parsed.critiques || [])
    };

    return normalized;
  }

  /**
   * Normalize verdict to valid enum value
   * @private
   */
  _normalizeVerdict(verdict) {
    const v = String(verdict).toLowerCase();
    if (v === 'approve' || v === 'approved' || v === 'pass') {
      return Verdicts.APPROVE;
    }
    if (v === 'reject' || v === 'rejected' || v === 'fail') {
      return Verdicts.REJECT;
    }
    return Verdicts.REVISE;
  }

  /**
   * Normalize confidence to 0.0-1.0 range
   * @private
   */
  _normalizeConfidence(confidence) {
    const c = parseFloat(confidence);
    if (isNaN(c)) return 0.5;
    if (c < 0) return 0;
    if (c > 1) return 1;
    return c;
  }

  /**
   * Normalize critiques array
   * @private
   */
  _normalizeCritiques(critiques) {
    if (!Array.isArray(critiques)) return [];

    return critiques.map(c => ({
      type: c.type || 'general',
      severity: this._normalizeSeverity(c.severity),
      location: c.location || null,
      message: c.message || 'No message provided',
      evidence: c.evidence || null,
      suggestion: c.suggestion || null
    }));
  }

  /**
   * Normalize severity to valid enum value
   * @private
   */
  _normalizeSeverity(severity) {
    const s = String(severity).toLowerCase();
    if (s === 'error' || s === 'critical' || s === 'high') {
      return Severity.ERROR;
    }
    if (s === 'warning' || s === 'medium' || s === 'warn') {
      return Severity.WARNING;
    }
    return Severity.INFO;
  }

  /**
   * Deduplicate similar critiques
   * @private
   */
  _deduplicateCritiques(critiques) {
    const grouped = new Map();

    for (const critique of critiques) {
      // Create a key based on type and similar message
      const key = `${critique.type}:${critique.message.toLowerCase().slice(0, 50)}`;

      if (grouped.has(key)) {
        const existing = grouped.get(key);
        existing.agreementCount = (existing.agreementCount || 1) + 1;
        existing.sources = existing.sources || [existing.source];
        existing.sources.push(critique.source);

        // Upgrade severity if higher
        if (this._severityRank(critique.severity) < this._severityRank(existing.severity)) {
          existing.severity = critique.severity;
        }
      } else {
        grouped.set(key, { ...critique, agreementCount: 1, sources: [critique.source] });
      }
    }

    return Array.from(grouped.values());
  }

  /**
   * Get numeric rank for severity (lower = more severe)
   * @private
   */
  _severityRank(severity) {
    const ranks = { error: 0, warning: 1, info: 2 };
    return ranks[severity] ?? 2;
  }

  /**
   * Calculate consensus among reviewers
   * @private
   */
  _calculateConsensus(reviews) {
    if (reviews.length === 0) {
      return { hasConsensus: false, agreement: 0, verdicts: {} };
    }

    // Count verdicts
    const verdictCounts = {};
    for (const review of reviews) {
      verdictCounts[review.verdict] = (verdictCounts[review.verdict] || 0) + 1;
    }

    // Find majority
    let maxCount = 0;
    let majorityVerdict = null;
    for (const [verdict, count] of Object.entries(verdictCounts)) {
      if (count > maxCount) {
        maxCount = count;
        majorityVerdict = verdict;
      }
    }

    const agreement = maxCount / reviews.length;
    const hasConsensus = agreement >= this.options.consensusThreshold;

    return {
      hasConsensus,
      agreement,
      majorityVerdict,
      verdicts: verdictCounts
    };
  }

  /**
   * Calculate overall confidence
   * @private
   */
  _calculateConfidence(successfulReviews, failedCount) {
    if (successfulReviews.length === 0) {
      return 0;
    }

    // Average confidence from reviewers
    const avgConfidence = successfulReviews.reduce(
      (sum, r) => sum + r.confidence, 0
    ) / successfulReviews.length;

    // Penalize for failed reviewers
    const totalReviewers = successfulReviews.length + failedCount;
    const successRate = successfulReviews.length / totalReviewers;

    // Weighted combination
    return avgConfidence * successRate;
  }

  /**
   * Determine final verdict based on critiques and consensus
   * @private
   */
  _determineVerdict(critiques, consensus, confidence) {
    // If there are error-level critiques, recommend revision
    const hasErrors = critiques.some(c => c.severity === Severity.ERROR);
    if (hasErrors) {
      return Verdicts.REVISE;
    }

    // Check for many warnings - even with consensus, too many warnings means revision
    const warningCount = critiques.filter(c => c.severity === Severity.WARNING).length;
    if (warningCount >= 3) {
      return Verdicts.REVISE;
    }

    // If consensus reached, use majority verdict
    if (consensus.hasConsensus) {
      return consensus.majorityVerdict;
    }

    // If low confidence, recommend revision
    if (confidence < 0.5) {
      return Verdicts.REVISE;
    }

    // Default to approval if no significant issues
    return Verdicts.APPROVE;
  }
}

// ============================================
// FACTORY FUNCTION
// ============================================

/**
 * Create a MultiAgentReview instance
 * @param {Object} workerManager
 * @param {Object} options
 * @returns {MultiAgentReview}
 */
export function createMultiAgentReview(workerManager, options = {}) {
  return new MultiAgentReview(workerManager, options);
}

export default MultiAgentReview;
