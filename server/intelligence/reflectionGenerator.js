/**
 * ReflectionGenerator - Generate verbal reflections on failed tasks
 *
 * Research basis: Shinn et al. (2023) "Reflexion: Language Agents with
 * Verbal Reinforcement Learning" - NeurIPS 2023
 *
 * Produces structured reflections that can be retrieved and used
 * in future similar tasks to avoid repeating mistakes.
 *
 * @see /research/15-scientific-enhancements-plan.md Section 2
 */

/**
 * Issue categories for classification
 */
export const IssueCategory = {
  LOGIC: 'logic',
  SYNTAX: 'syntax',
  FACTUAL: 'factual',
  FORMAT: 'format',
  COMPLETENESS: 'completeness',
  PERFORMANCE: 'performance',
  SECURITY: 'security',
  OTHER: 'other'
};

/**
 * Pattern types detected across correction history
 */
export const PatternType = {
  RECURRING_ISSUE: 'recurring_issue',
  DEGRADATION: 'degradation',
  OSCILLATION: 'oscillation',
  STAGNATION: 'stagnation',
  PARTIAL_FIX: 'partial_fix'
};

/**
 * ReflectionGenerator - Generate verbal reflections on failed tasks
 */
export class ReflectionGenerator {
  /**
   * @param {Object} options
   * @param {number} options.maxReflectionLength - Max length of reflection text
   * @param {number} options.maxLessons - Max lessons to extract
   * @param {boolean} options.includeEvidence - Include evidence snippets
   */
  constructor(options = {}) {
    this.maxReflectionLength = options.maxReflectionLength || 800;
    this.maxLessons = options.maxLessons || 5;
    this.includeEvidence = options.includeEvidence !== false;
  }

  /**
   * Generate a reflection on a failed task
   *
   * @param {Object} params
   * @param {string} params.taskType - Type of task (code, factual, reasoning, format)
   * @param {string} params.taskDescription - What was attempted
   * @param {string} params.originalOutput - Initial output
   * @param {string} params.finalOutput - Final output after corrections
   * @param {number} params.iterations - Number of correction iterations
   * @param {Array} params.remainingIssues - Issues that couldn't be fixed
   * @param {Array} params.history - Correction history
   * @param {string} params.stopReason - Why the loop stopped
   * @param {Object} params.context - Additional context
   * @returns {Promise<Object>} Structured reflection
   */
  async generate(params) {
    const {
      taskType,
      taskDescription,
      originalOutput,
      finalOutput,
      iterations,
      remainingIssues,
      history,
      stopReason,
      context = {}
    } = params;

    // Analyze what went wrong
    const issueCategories = this.categorizeIssues(remainingIssues);
    const patterns = this.identifyPatterns(history);
    const rootCauses = this.analyzeRootCauses(issueCategories, patterns, history);
    const lessonsLearned = this.extractLessons(issueCategories, patterns, stopReason, rootCauses);

    // Generate reflection text
    const content = this.formatReflection({
      taskType,
      taskDescription,
      issueCategories,
      patterns,
      rootCauses,
      lessonsLearned,
      iterations,
      stopReason
    });

    return {
      content,
      taskType,
      taskDescription: taskDescription?.substring(0, 200),
      issueCategories,
      patterns,
      rootCauses,
      lessonsLearned,
      metadata: {
        iterations,
        stopReason,
        issueCount: remainingIssues?.length || 0,
        timestamp: Date.now()
      }
    };
  }

  /**
   * Categorize issues by type
   * @param {Array} issues - Array of issue objects or strings
   * @returns {Object} Categorized issues
   */
  categorizeIssues(issues) {
    const categories = {};

    for (const category of Object.values(IssueCategory)) {
      categories[category] = [];
    }

    if (!issues || !Array.isArray(issues)) {
      return categories;
    }

    for (const issue of issues) {
      const message = typeof issue === 'string' ? issue : (issue.message || String(issue));
      const explicitType = issue?.type?.toLowerCase();

      // Check explicit type first
      if (explicitType && categories[explicitType]) {
        categories[explicitType].push(message);
        continue;
      }

      // Infer category from message content
      const lowerMessage = message.toLowerCase();
      let categorized = false;

      if (this.matchesLogicPatterns(lowerMessage)) {
        categories[IssueCategory.LOGIC].push(message);
        categorized = true;
      }
      if (this.matchesSyntaxPatterns(lowerMessage)) {
        categories[IssueCategory.SYNTAX].push(message);
        categorized = true;
      }
      if (this.matchesFactualPatterns(lowerMessage)) {
        categories[IssueCategory.FACTUAL].push(message);
        categorized = true;
      }
      if (this.matchesFormatPatterns(lowerMessage)) {
        categories[IssueCategory.FORMAT].push(message);
        categorized = true;
      }
      if (this.matchesCompletenessPatterns(lowerMessage)) {
        categories[IssueCategory.COMPLETENESS].push(message);
        categorized = true;
      }
      if (this.matchesSecurityPatterns(lowerMessage)) {
        categories[IssueCategory.SECURITY].push(message);
        categorized = true;
      }
      if (this.matchesPerformancePatterns(lowerMessage)) {
        categories[IssueCategory.PERFORMANCE].push(message);
        categorized = true;
      }

      if (!categorized) {
        categories[IssueCategory.OTHER].push(message);
      }
    }

    // Filter out empty categories
    return Object.fromEntries(
      Object.entries(categories).filter(([_, v]) => v.length > 0)
    );
  }

  // Pattern matching helpers
  matchesLogicPatterns(msg) {
    return /logic|reason|incorrect|wrong|invalid|condition|should be|expected|actual|assertion|fail/i.test(msg);
  }

  matchesSyntaxPatterns(msg) {
    return /syntax|parse|token|unexpected|unterminated|missing|bracket|semicolon|indent/i.test(msg);
  }

  matchesFactualPatterns(msg) {
    return /fact|incorrect|outdated|inaccurate|source|reference|claim|verify|false/i.test(msg);
  }

  matchesFormatPatterns(msg) {
    return /format|schema|structure|json|xml|yaml|type|field|property|required/i.test(msg);
  }

  matchesCompletenessPatterns(msg) {
    return /missing|incomplete|omit|forgot|need|require|lack|absent|todo|implement/i.test(msg);
  }

  matchesSecurityPatterns(msg) {
    return /security|injection|xss|csrf|auth|permission|vulnerability|escape|sanitize/i.test(msg);
  }

  matchesPerformancePatterns(msg) {
    return /performance|slow|timeout|memory|cpu|optimize|efficient|complexity|O\(n/i.test(msg);
  }

  /**
   * Identify patterns across correction history
   * @param {Array} history - Correction iteration history
   * @returns {Array} Detected patterns
   */
  identifyPatterns(history) {
    const patterns = [];

    if (!history || history.length < 2) {
      return patterns;
    }

    // Collect all critique messages across history
    const issuesByIteration = history.map(h => {
      const critiques = h.verification?.critiques || [];
      return critiques.map(c => c.message || String(c));
    });

    // Count issue frequencies across iterations
    const issueCounts = new Map();
    for (const iterationIssues of issuesByIteration) {
      for (const issue of iterationIssues) {
        const normalized = this.normalizeIssue(issue);
        issueCounts.set(normalized, (issueCounts.get(normalized) || 0) + 1);
      }
    }

    // Detect recurring issues (appear in >1 iteration)
    for (const [issue, count] of issueCounts) {
      if (count > 1) {
        patterns.push({
          type: PatternType.RECURRING_ISSUE,
          description: `Issue persisted across ${count} iterations`,
          evidence: issue.substring(0, 100),
          severity: count >= 3 ? 'high' : 'medium'
        });
      }
    }

    // Detect degradation (issue count increasing)
    const issueCounts2 = issuesByIteration.map(issues => issues.length);
    let degrading = true;
    for (let i = 1; i < issueCounts2.length; i++) {
      if (issueCounts2[i] <= issueCounts2[i - 1]) {
        degrading = false;
        break;
      }
    }
    if (degrading && issueCounts2.length >= 2) {
      patterns.push({
        type: PatternType.DEGRADATION,
        description: `Issues increased from ${issueCounts2[0]} to ${issueCounts2[issueCounts2.length - 1]}`,
        severity: 'high'
      });
    }

    // Detect oscillation (issues alternating)
    if (history.length >= 3) {
      const confidences = history
        .map(h => h.verification?.confidence)
        .filter(c => c !== undefined);

      if (confidences.length >= 3) {
        let oscillating = true;
        for (let i = 2; i < confidences.length; i++) {
          const diff1 = confidences[i - 1] - confidences[i - 2];
          const diff2 = confidences[i] - confidences[i - 1];
          if (diff1 * diff2 >= 0) { // Same direction = not oscillating
            oscillating = false;
            break;
          }
        }
        if (oscillating) {
          patterns.push({
            type: PatternType.OSCILLATION,
            description: 'Corrections oscillating between states',
            severity: 'medium'
          });
        }
      }
    }

    // Detect stagnation (no change in issue count)
    const uniqueCounts = new Set(issueCounts2);
    if (uniqueCounts.size === 1 && history.length >= 3) {
      patterns.push({
        type: PatternType.STAGNATION,
        description: `Issue count unchanged at ${issueCounts2[0]} across ${history.length} iterations`,
        severity: 'medium'
      });
    }

    return patterns;
  }

  /**
   * Normalize an issue message for comparison
   */
  normalizeIssue(issue) {
    return issue
      .toLowerCase()
      .replace(/line \d+/g, 'line N')
      .replace(/\d+/g, 'N')
      .replace(/["'`]/g, '')
      .trim();
  }

  /**
   * Analyze root causes from issues and patterns
   */
  analyzeRootCauses(issueCategories, patterns, history) {
    const rootCauses = [];

    // Infer causes from issue categories
    if (issueCategories[IssueCategory.LOGIC]?.length > 0) {
      rootCauses.push({
        cause: 'Flawed reasoning or algorithm',
        evidence: 'Logic errors in output',
        recommendation: 'Break down complex logic into smaller verifiable steps'
      });
    }

    if (issueCategories[IssueCategory.COMPLETENESS]?.length > 0) {
      rootCauses.push({
        cause: 'Incomplete understanding of requirements',
        evidence: 'Missing required elements',
        recommendation: 'Create explicit checklist of all requirements before starting'
      });
    }

    if (issueCategories[IssueCategory.FACTUAL]?.length > 0) {
      rootCauses.push({
        cause: 'Unverified or outdated information',
        evidence: 'Factual inaccuracies detected',
        recommendation: 'Verify claims with authoritative sources before including'
      });
    }

    // Infer causes from patterns
    for (const pattern of patterns) {
      if (pattern.type === PatternType.RECURRING_ISSUE) {
        rootCauses.push({
          cause: 'Fundamental approach incompatible with requirement',
          evidence: pattern.description,
          recommendation: 'Step back and reconsider the overall approach'
        });
      }

      if (pattern.type === PatternType.DEGRADATION) {
        rootCauses.push({
          cause: 'Corrections introducing new issues',
          evidence: pattern.description,
          recommendation: 'Make smaller, more targeted changes'
        });
      }

      if (pattern.type === PatternType.OSCILLATION) {
        rootCauses.push({
          cause: 'Conflicting requirements or feedback',
          evidence: pattern.description,
          recommendation: 'Clarify requirements before attempting more corrections'
        });
      }
    }

    return rootCauses;
  }

  /**
   * Extract actionable lessons from analysis
   */
  extractLessons(issueCategories, patterns, stopReason, rootCauses) {
    const lessons = [];

    // Lessons from root causes
    for (const cause of rootCauses) {
      if (cause.recommendation) {
        lessons.push(cause.recommendation);
      }
    }

    // Lessons from stop reason
    switch (stopReason) {
      case 'max_iterations':
        lessons.push('Task complexity exceeded correction capacity - consider task decomposition');
        break;
      case 'no_new_critiques':
        lessons.push('Reached correction plateau - fundamentally different approach needed');
        break;
      case 'verification_error':
        lessons.push('Verification tools failed - ensure tools are available and configured');
        break;
      case 'worker_unavailable':
        lessons.push('Worker became unavailable - check resource limits and worker health');
        break;
    }

    // Task-type-specific lessons
    if (issueCategories[IssueCategory.LOGIC]?.length > 0) {
      lessons.push('Break down logic into smaller verifiable steps');
    }

    if (issueCategories[IssueCategory.COMPLETENESS]?.length > 0) {
      lessons.push('Create explicit checklist of all requirements before starting');
    }

    if (issueCategories[IssueCategory.SYNTAX]?.length > 0) {
      lessons.push('Validate syntax incrementally rather than at the end');
    }

    if (issueCategories[IssueCategory.SECURITY]?.length > 0) {
      lessons.push('Apply security best practices (input validation, output escaping) from the start');
    }

    // Deduplicate and limit
    const uniqueLessons = [...new Set(lessons)];
    return uniqueLessons.slice(0, this.maxLessons);
  }

  /**
   * Format reflection as readable text
   */
  formatReflection(params) {
    const {
      taskType,
      taskDescription,
      issueCategories,
      patterns,
      rootCauses,
      lessonsLearned,
      iterations,
      stopReason
    } = params;

    const lines = [];

    // Header
    lines.push(`## Reflection: ${taskType} Task Failure`);
    lines.push('');

    // Context
    if (taskDescription) {
      lines.push(`**Task**: ${taskDescription.substring(0, 150)}${taskDescription.length > 150 ? '...' : ''}`);
    }
    lines.push(`**Iterations**: ${iterations} | **Stop Reason**: ${stopReason}`);
    lines.push('');

    // Persistent Issues
    const issueEntries = Object.entries(issueCategories);
    if (issueEntries.length > 0) {
      lines.push('### Persistent Issues');
      for (const [category, issues] of issueEntries) {
        const sample = issues.slice(0, 2).join('; ');
        const truncated = sample.length > 100 ? sample.substring(0, 100) + '...' : sample;
        lines.push(`- **${category}** (${issues.length}): ${truncated}`);
      }
      lines.push('');
    }

    // Patterns
    if (patterns.length > 0) {
      lines.push('### Patterns Observed');
      for (const pattern of patterns.slice(0, 3)) {
        lines.push(`- [${pattern.severity || 'medium'}] ${pattern.description}`);
      }
      lines.push('');
    }

    // Root Causes
    if (rootCauses.length > 0) {
      lines.push('### Root Causes');
      for (const cause of rootCauses.slice(0, 3)) {
        lines.push(`- ${cause.cause}`);
      }
      lines.push('');
    }

    // Lessons
    lines.push('### Lessons Learned');
    for (const lesson of lessonsLearned) {
      lines.push(`- ${lesson}`);
    }

    let reflection = lines.join('\n');

    // Truncate if too long
    if (reflection.length > this.maxReflectionLength) {
      reflection = reflection.substring(0, this.maxReflectionLength - 50);
      // Find last complete line
      const lastNewline = reflection.lastIndexOf('\n');
      if (lastNewline > 0) {
        reflection = reflection.substring(0, lastNewline);
      }
      reflection += '\n\n[Truncated]';
    }

    return reflection;
  }

  /**
   * Generate a quick summary for logging
   */
  generateSummary(reflection) {
    const issueCount = Object.values(reflection.issueCategories)
      .reduce((sum, arr) => sum + arr.length, 0);

    return {
      taskType: reflection.taskType,
      issueCount,
      patternCount: reflection.patterns.length,
      lessonCount: reflection.lessonsLearned.length,
      topIssueCategory: Object.keys(reflection.issueCategories)[0] || 'none',
      topPattern: reflection.patterns[0]?.type || 'none'
    };
  }
}

export default ReflectionGenerator;
