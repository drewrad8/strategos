/**
 * VerificationPipeline - External verification of worker outputs
 *
 * Based on CRITIC Framework research: LLMs cannot reliably evaluate their own
 * outputs. Tool-assisted verification is mandatory for reliable self-correction.
 *
 * Key insight: External feedback is crucial - verification must use tools,
 * execution, and external sources rather than relying on LLM self-evaluation.
 */

import { spawn } from 'child_process';

/**
 * Task types requiring different verification strategies
 */
export const TaskTypes = {
  CODE: 'code',
  FACTUAL: 'factual',
  REASONING: 'reasoning',
  FORMAT: 'format'
};

/**
 * Critique types that can be identified during verification
 */
export const CritiqueTypes = {
  EXECUTION_ERROR: 'execution_error',
  TEST_FAILURE: 'test_failure',
  LINT_ERROR: 'lint_error',
  TYPE_ERROR: 'type_error',
  FACTUAL_ERROR: 'factual_error',
  LOGIC_ERROR: 'logic_error',
  CONSISTENCY_ERROR: 'consistency_error',
  SCHEMA_VIOLATION: 'schema_violation',
  CONSTRAINT_VIOLATION: 'constraint_violation',
  SECURITY_ISSUE: 'security_issue'
};

/**
 * Severity levels for critiques
 */
export const Severity = {
  ERROR: 'error',
  WARNING: 'warning',
  INFO: 'info'
};

/**
 * Create a structured critique object
 * @param {Object} params - Critique parameters
 * @returns {Object} Structured critique
 */
export function createCritique({
  type,
  severity = Severity.ERROR,
  location = null,
  message,
  evidence = null,
  suggestion = null
}) {
  return {
    type,
    severity,
    location,
    message,
    evidence,
    suggestion,
    timestamp: new Date().toISOString()
  };
}

/**
 * VerificationPipeline class for external verification of worker outputs
 */
export class VerificationPipeline {
  constructor(options = {}) {
    this.verifiers = new Map();
    this.options = {
      codeTimeout: options.codeTimeout || 30000,
      testTimeout: options.testTimeout || 60000,
      confidenceThresholds: {
        high: 0.9,
        medium: 0.7,
        low: 0.5,
        ...options.confidenceThresholds
      },
      ...options
    };

    // Register default verifiers for each task type
    this.registerDefaultVerifiers();
  }

  /**
   * Register default verifiers for all task types
   */
  registerDefaultVerifiers() {
    // CODE verification: syntax, lint, type check, execution
    this.registerVerifier(TaskTypes.CODE, this.createCodeVerifier());

    // FACTUAL verification: consistency checks, source validation
    this.registerVerifier(TaskTypes.FACTUAL, this.createFactualVerifier());

    // REASONING verification: logic validation, consistency
    this.registerVerifier(TaskTypes.REASONING, this.createReasoningVerifier());

    // FORMAT verification: schema validation, constraint checking
    this.registerVerifier(TaskTypes.FORMAT, this.createFormatVerifier());
  }

  /**
   * Register a verifier function for a specific task type
   * @param {string} taskType - The task type to register for
   * @param {Function} verifier - Async function that takes (output, context) and returns verification result
   */
  registerVerifier(taskType, verifier) {
    if (!Object.values(TaskTypes).includes(taskType)) {
      throw new Error(`Invalid task type: ${taskType}. Must be one of: ${Object.values(TaskTypes).join(', ')}`);
    }

    if (typeof verifier !== 'function') {
      throw new Error('Verifier must be a function');
    }

    this.verifiers.set(taskType, verifier);
  }

  /**
   * Verify output based on task type
   * @param {string|Object} output - The output to verify
   * @param {string} taskType - The type of task
   * @param {Object} context - Additional context for verification
   * @returns {Object} Verification result { valid, critiques, confidence }
   */
  async verify(output, taskType, context = {}) {
    if (!Object.values(TaskTypes).includes(taskType)) {
      throw new Error(`Invalid task type: ${taskType}. Must be one of: ${Object.values(TaskTypes).join(', ')}`);
    }

    const verifier = this.verifiers.get(taskType);
    if (!verifier) {
      throw new Error(`No verifier registered for task type: ${taskType}`);
    }

    try {
      const startTime = Date.now();
      const result = await verifier(output, context);
      const verificationTime = Date.now() - startTime;

      // Ensure result has required fields
      const critiques = result.critiques || [];
      const valid = result.valid !== undefined ? result.valid : this.determineValidity(critiques);
      const confidence = result.confidence !== undefined ? result.confidence : this.calculateConfidence(critiques, result);

      return {
        valid,
        critiques,
        confidence,
        taskType,
        verificationTime,
        metadata: {
          verifierUsed: taskType,
          contextProvided: Object.keys(context),
          timestamp: new Date().toISOString()
        }
      };
    } catch (error) {
      // Verification itself failed - this is critical
      return {
        valid: false,
        critiques: [
          createCritique({
            type: CritiqueTypes.EXECUTION_ERROR,
            severity: Severity.ERROR,
            message: `Verification failed: ${error.message}`,
            evidence: error.stack
          })
        ],
        confidence: 0,
        taskType,
        error: error.message
      };
    }
  }

  /**
   * Determine validity based on critiques
   * @param {Array} critiques - Array of critique objects
   * @returns {boolean} Whether the output is valid
   */
  determineValidity(critiques) {
    // Invalid if any ERROR severity critiques exist
    return !critiques.some(c => c.severity === Severity.ERROR);
  }

  /**
   * Calculate confidence score based on verification results
   * @param {Array} critiques - Array of critique objects
   * @param {Object} result - Full verification result
   * @returns {number} Confidence score between 0 and 1
   */
  calculateConfidence(critiques, result = {}) {
    if (!critiques || critiques.length === 0) {
      // No critiques means high confidence if verification succeeded
      return result.checksPerformed > 0 ? 0.95 : 0.5;
    }

    // Start with full confidence
    let confidence = 1.0;

    for (const critique of critiques) {
      switch (critique.severity) {
        case Severity.ERROR:
          confidence -= 0.3;
          break;
        case Severity.WARNING:
          confidence -= 0.1;
          break;
        case Severity.INFO:
          confidence -= 0.02;
          break;
      }
    }

    // Factor in how many checks were performed
    if (result.checksPerformed) {
      const checkBonus = Math.min(result.checksPerformed * 0.02, 0.1);
      confidence += checkBonus;
    }

    // Ensure confidence is within bounds
    return Math.max(0, Math.min(1, confidence));
  }

  /**
   * Format critiques for worker revision
   * @param {Array} critiques - Array of critique objects
   * @returns {string} Formatted critique text
   */
  formatCritique(critiques) {
    if (!critiques || critiques.length === 0) {
      return 'No issues found.';
    }

    const lines = ['## Verification Critiques\n'];

    // Group critiques by severity
    const errorCritiques = critiques.filter(c => c.severity === Severity.ERROR);
    const warningCritiques = critiques.filter(c => c.severity === Severity.WARNING);
    const infoCritiques = critiques.filter(c => c.severity === Severity.INFO);

    if (errorCritiques.length > 0) {
      lines.push('### Errors (Must Fix)\n');
      errorCritiques.forEach((c, i) => {
        lines.push(this.formatSingleCritique(c, i + 1));
      });
      lines.push('');
    }

    if (warningCritiques.length > 0) {
      lines.push('### Warnings (Should Fix)\n');
      warningCritiques.forEach((c, i) => {
        lines.push(this.formatSingleCritique(c, i + 1));
      });
      lines.push('');
    }

    if (infoCritiques.length > 0) {
      lines.push('### Info (Consider)\n');
      infoCritiques.forEach((c, i) => {
        lines.push(this.formatSingleCritique(c, i + 1));
      });
    }

    // Add summary
    lines.push('\n---');
    lines.push(`**Summary**: ${errorCritiques.length} error(s), ${warningCritiques.length} warning(s), ${infoCritiques.length} info`);

    return lines.join('\n');
  }

  /**
   * Format a single critique
   * @param {Object} critique - Critique object
   * @param {number} index - Critique number
   * @returns {string} Formatted critique
   */
  formatSingleCritique(critique, index) {
    const parts = [];
    parts.push(`**${index}. ${critique.type}**`);

    if (critique.location) {
      parts.push(`   Location: ${critique.location}`);
    }

    parts.push(`   Issue: ${critique.message}`);

    if (critique.evidence) {
      parts.push(`   Evidence: ${critique.evidence}`);
    }

    if (critique.suggestion) {
      parts.push(`   Suggestion: ${critique.suggestion}`);
    }

    return parts.join('\n');
  }

  // ============================================================
  // Default Verifier Implementations
  // ============================================================

  /**
   * Create a verifier for CODE task type
   * Verifies: syntax, linting, type checking, execution
   */
  createCodeVerifier() {
    return async (output, context) => {
      const critiques = [];
      let checksPerformed = 0;

      // Extract code from output (handle string or object)
      const code = typeof output === 'string' ? output : (output.code || output.content || '');
      const language = context.language || this.detectLanguage(code);

      // 1. Syntax check
      checksPerformed++;
      const syntaxResult = this.checkSyntax(code, language);
      if (!syntaxResult.valid) {
        critiques.push(createCritique({
          type: CritiqueTypes.EXECUTION_ERROR,
          severity: Severity.ERROR,
          location: syntaxResult.location,
          message: syntaxResult.message,
          evidence: syntaxResult.error,
          suggestion: 'Fix the syntax error before proceeding'
        }));
      }

      // 2. Basic pattern checks (security, common errors)
      checksPerformed++;
      const patternIssues = this.checkCodePatterns(code, language);
      critiques.push(...patternIssues);

      // 3. If test command provided, run tests
      if (context.testCommand) {
        checksPerformed++;
        try {
          const testResult = await this.runCommand(context.testCommand, this.options.testTimeout);
          if (!testResult.success) {
            critiques.push(createCritique({
              type: CritiqueTypes.TEST_FAILURE,
              severity: Severity.ERROR,
              message: 'Tests failed',
              evidence: testResult.output.substring(0, 500),
              suggestion: 'Review failing tests and fix the code'
            }));
          }
        } catch (error) {
          critiques.push(createCritique({
            type: CritiqueTypes.TEST_FAILURE,
            severity: Severity.WARNING,
            message: `Could not run tests: ${error.message}`
          }));
        }
      }

      // 4. If lint command provided, run linter
      if (context.lintCommand) {
        checksPerformed++;
        try {
          const lintResult = await this.runCommand(context.lintCommand, this.options.codeTimeout);
          if (!lintResult.success) {
            critiques.push(createCritique({
              type: CritiqueTypes.LINT_ERROR,
              severity: Severity.WARNING,
              message: 'Linting issues found',
              evidence: lintResult.output.substring(0, 500),
              suggestion: 'Fix linting errors for code quality'
            }));
          }
        } catch (error) {
          // Lint failure is not critical
        }
      }

      // 5. If execution context provided, verify output
      if (context.expectedOutput !== undefined) {
        checksPerformed++;
        const actualOutput = context.actualOutput;
        if (actualOutput !== context.expectedOutput) {
          critiques.push(createCritique({
            type: CritiqueTypes.TEST_FAILURE,
            severity: Severity.ERROR,
            message: 'Output does not match expected result',
            evidence: `Expected: ${context.expectedOutput}, Got: ${actualOutput}`,
            suggestion: 'Review logic to produce correct output'
          }));
        }
      }

      return {
        critiques,
        checksPerformed,
        valid: !critiques.some(c => c.severity === Severity.ERROR)
      };
    };
  }

  /**
   * Create a verifier for FACTUAL task type
   * Verifies: consistency, known facts, contradictions
   */
  createFactualVerifier() {
    return async (output, context) => {
      const critiques = [];
      let checksPerformed = 0;

      const text = typeof output === 'string' ? output : (output.text || output.content || JSON.stringify(output));

      // 1. Self-consistency check (if multiple claims)
      checksPerformed++;
      const consistencyIssues = this.checkConsistency(text);
      critiques.push(...consistencyIssues);

      // 2. Check against provided facts/sources
      if (context.knownFacts && Array.isArray(context.knownFacts)) {
        checksPerformed++;
        const factIssues = this.checkAgainstFacts(text, context.knownFacts);
        critiques.push(...factIssues);
      }

      // 3. Check for common hallucination patterns
      checksPerformed++;
      const hallucinationIssues = this.checkHallucinationPatterns(text);
      critiques.push(...hallucinationIssues);

      // 4. Verify citations if provided
      if (context.requiredCitations) {
        checksPerformed++;
        const citationIssues = this.checkCitations(text, context.requiredCitations);
        critiques.push(...citationIssues);
      }

      return {
        critiques,
        checksPerformed,
        valid: !critiques.some(c => c.severity === Severity.ERROR)
      };
    };
  }

  /**
   * Create a verifier for REASONING task type
   * Verifies: logical consistency, argument structure
   */
  createReasoningVerifier() {
    return async (output, context) => {
      const critiques = [];
      let checksPerformed = 0;

      const text = typeof output === 'string' ? output : (output.reasoning || output.content || JSON.stringify(output));

      // 1. Check logical structure
      checksPerformed++;
      const structureIssues = this.checkLogicalStructure(text);
      critiques.push(...structureIssues);

      // 2. Check for logical fallacies
      checksPerformed++;
      const fallacyIssues = this.checkLogicalFallacies(text);
      critiques.push(...fallacyIssues);

      // 3. Check conclusion follows from premises
      if (context.premises && context.expectedConclusion) {
        checksPerformed++;
        const conclusionIssue = this.checkConclusionValidity(text, context.premises, context.expectedConclusion);
        if (conclusionIssue) {
          critiques.push(conclusionIssue);
        }
      }

      // 4. Check for self-contradictions
      checksPerformed++;
      const contradictionIssues = this.checkSelfContradictions(text);
      critiques.push(...contradictionIssues);

      return {
        critiques,
        checksPerformed,
        valid: !critiques.some(c => c.severity === Severity.ERROR)
      };
    };
  }

  /**
   * Create a verifier for FORMAT task type
   * Verifies: schema compliance, constraints
   */
  createFormatVerifier() {
    return async (output, context) => {
      const critiques = [];
      let checksPerformed = 0;

      // 1. Check JSON validity if expected
      if (context.expectJson) {
        checksPerformed++;
        const jsonResult = this.validateJson(output);
        if (!jsonResult.valid) {
          critiques.push(createCritique({
            type: CritiqueTypes.SCHEMA_VIOLATION,
            severity: Severity.ERROR,
            message: 'Invalid JSON format',
            evidence: jsonResult.error,
            suggestion: 'Ensure output is valid JSON'
          }));
        }
      }

      // 2. Schema validation
      if (context.schema) {
        checksPerformed++;
        const schemaResult = this.validateSchema(output, context.schema);
        critiques.push(...schemaResult);
      }

      // 3. Constraint checking
      if (context.constraints) {
        checksPerformed++;
        const constraintResult = this.validateConstraints(output, context.constraints);
        critiques.push(...constraintResult);
      }

      // 4. Required fields check
      if (context.requiredFields) {
        checksPerformed++;
        const fieldResult = this.checkRequiredFields(output, context.requiredFields);
        critiques.push(...fieldResult);
      }

      // 5. Length constraints
      if (context.minLength !== undefined || context.maxLength !== undefined) {
        checksPerformed++;
        const lengthResult = this.checkLengthConstraints(output, context.minLength, context.maxLength);
        if (lengthResult) {
          critiques.push(lengthResult);
        }
      }

      return {
        critiques,
        checksPerformed,
        valid: !critiques.some(c => c.severity === Severity.ERROR)
      };
    };
  }

  // ============================================================
  // Helper Methods
  // ============================================================

  /**
   * Detect programming language from code
   */
  detectLanguage(code) {
    if (code.includes('function') || code.includes('const ') || code.includes('let ')) {
      return 'javascript';
    }
    if (code.includes('def ') || code.includes('import ') && code.includes(':')) {
      return 'python';
    }
    if (code.includes('fn ') || code.includes('let mut')) {
      return 'rust';
    }
    return 'unknown';
  }

  /**
   * Check code syntax
   */
  checkSyntax(code, language) {
    if (language === 'javascript') {
      try {
        // Use Function constructor to check syntax
        new Function(code);
        return { valid: true };
      } catch (error) {
        const match = error.message.match(/at position (\d+)/);
        return {
          valid: false,
          message: 'JavaScript syntax error',
          error: error.message,
          location: match ? `position ${match[1]}` : 'unknown'
        };
      }
    }

    // For other languages, basic bracket matching
    const brackets = { '(': ')', '[': ']', '{': '}' };
    const stack = [];

    for (let i = 0; i < code.length; i++) {
      const char = code[i];
      if (brackets[char]) {
        stack.push({ char, pos: i, expected: brackets[char] });
      } else if (Object.values(brackets).includes(char)) {
        const last = stack.pop();
        if (!last || last.expected !== char) {
          return {
            valid: false,
            message: 'Unmatched bracket',
            error: `Unexpected '${char}' at position ${i}`,
            location: `position ${i}`
          };
        }
      }
    }

    if (stack.length > 0) {
      const unclosed = stack[stack.length - 1];
      return {
        valid: false,
        message: 'Unclosed bracket',
        error: `Expected '${unclosed.expected}' to close '${unclosed.char}' at position ${unclosed.pos}`,
        location: `position ${unclosed.pos}`
      };
    }

    return { valid: true };
  }

  /**
   * Check code for common problematic patterns
   */
  checkCodePatterns(code, language) {
    const critiques = [];

    // Security patterns
    const securityPatterns = [
      { pattern: /eval\s*\(/gi, message: 'Use of eval() is a security risk', type: CritiqueTypes.SECURITY_ISSUE },
      { pattern: /exec\s*\(/gi, message: 'Use of exec() may be dangerous', type: CritiqueTypes.SECURITY_ISSUE },
      { pattern: /innerHTML\s*=/gi, message: 'Direct innerHTML assignment may allow XSS', type: CritiqueTypes.SECURITY_ISSUE },
      { pattern: /document\.write\s*\(/gi, message: 'document.write() is generally discouraged', type: CritiqueTypes.SECURITY_ISSUE }
    ];

    // Common error patterns
    const errorPatterns = [
      { pattern: /console\.log/gi, message: 'Debug console.log statement found', type: CritiqueTypes.LINT_ERROR, severity: Severity.INFO },
      { pattern: /TODO|FIXME|HACK/gi, message: 'Unresolved code comment found', type: CritiqueTypes.LINT_ERROR, severity: Severity.INFO },
      { pattern: /debugger;/gi, message: 'Debugger statement found', type: CritiqueTypes.LINT_ERROR, severity: Severity.WARNING }
    ];

    [...securityPatterns, ...errorPatterns].forEach(({ pattern, message, type, severity = Severity.WARNING }) => {
      const matches = code.match(pattern);
      if (matches) {
        critiques.push(createCritique({
          type,
          severity,
          message,
          evidence: `Found ${matches.length} occurrence(s)`,
          suggestion: type === CritiqueTypes.SECURITY_ISSUE ? 'Consider safer alternatives' : 'Review and remove if not needed'
        }));
      }
    });

    return critiques;
  }

  /**
   * Run a command and return result
   */
  runCommand(command, timeout) {
    return new Promise((resolve, reject) => {
      const parts = command.split(' ');
      const proc = spawn(parts[0], parts.slice(1), {
        timeout,
        shell: true
      });

      let output = '';
      let errorOutput = '';

      proc.stdout.on('data', (data) => {
        output += data.toString();
      });

      proc.stderr.on('data', (data) => {
        errorOutput += data.toString();
      });

      proc.on('close', (code) => {
        resolve({
          success: code === 0,
          output: output + errorOutput,
          exitCode: code
        });
      });

      proc.on('error', (error) => {
        reject(error);
      });

      setTimeout(() => {
        proc.kill();
        reject(new Error('Command timed out'));
      }, timeout);
    });
  }

  /**
   * Check text for self-consistency
   */
  checkConsistency(text) {
    const critiques = [];

    // Look for contradictory statements
    const contradictionPatterns = [
      { patterns: [/is not/, /is /], message: 'Potential contradiction: both affirming and negating' },
      { patterns: [/always/, /never/], message: 'Potential contradiction: absolute statements' },
      { patterns: [/definitely/, /maybe|perhaps/], message: 'Potential contradiction: conflicting certainty' }
    ];

    // This is a simplified check - real implementation would use NLP
    const lowerText = text.toLowerCase();

    contradictionPatterns.forEach(({ patterns, message }) => {
      const hasAll = patterns.every(p => p.test(lowerText));
      if (hasAll) {
        critiques.push(createCritique({
          type: CritiqueTypes.CONSISTENCY_ERROR,
          severity: Severity.WARNING,
          message,
          suggestion: 'Review for logical consistency'
        }));
      }
    });

    return critiques;
  }

  /**
   * Check text against known facts
   */
  checkAgainstFacts(text, facts) {
    const critiques = [];
    const lowerText = text.toLowerCase();

    facts.forEach(fact => {
      // Check if the text contradicts known facts
      if (fact.assertion && fact.keywords) {
        const hasKeywords = fact.keywords.some(kw => lowerText.includes(kw.toLowerCase()));
        if (hasKeywords && fact.check) {
          const passes = fact.check(text);
          if (!passes) {
            critiques.push(createCritique({
              type: CritiqueTypes.FACTUAL_ERROR,
              severity: Severity.ERROR,
              message: `Contradicts known fact: ${fact.assertion}`,
              evidence: `Keywords found but assertion violated`,
              suggestion: `Verify accuracy of claims about ${fact.keywords.join(', ')}`
            }));
          }
        }
      }
    });

    return critiques;
  }

  /**
   * Check for common hallucination patterns
   */
  checkHallucinationPatterns(text) {
    const critiques = [];

    // Patterns that often indicate hallucination
    const hallucinationIndicators = [
      { pattern: /\b(definitely|certainly|absolutely|undoubtedly)\b.*\b(showed?|proved?|demonstrated?)\b/gi,
        message: 'Overly confident claim about evidence' },
      { pattern: /according to (the latest|recent) (studies|research)/gi,
        message: 'Vague citation of studies without specifics' },
      { pattern: /it is (well-known|common knowledge|widely accepted) that/gi,
        message: 'Appeal to common knowledge without citation' }
    ];

    hallucinationIndicators.forEach(({ pattern, message }) => {
      if (pattern.test(text)) {
        critiques.push(createCritique({
          type: CritiqueTypes.FACTUAL_ERROR,
          severity: Severity.WARNING,
          message,
          suggestion: 'Provide specific citations or reduce certainty of claims'
        }));
      }
    });

    return critiques;
  }

  /**
   * Check citations in text
   */
  checkCitations(text, requiredCitations) {
    const critiques = [];

    requiredCitations.forEach(citation => {
      if (!text.includes(citation)) {
        critiques.push(createCritique({
          type: CritiqueTypes.FACTUAL_ERROR,
          severity: Severity.WARNING,
          message: `Missing required citation: ${citation}`,
          suggestion: 'Include all required citations'
        }));
      }
    });

    return critiques;
  }

  /**
   * Check logical structure of reasoning
   */
  checkLogicalStructure(text) {
    const critiques = [];

    // Check for presence of structured reasoning markers
    const hasConclusion = /therefore|thus|hence|in conclusion|consequently/i.test(text);
    const hasPremises = /because|since|given that|if .* then/i.test(text);

    if (text.length > 200 && !hasConclusion && !hasPremises) {
      critiques.push(createCritique({
        type: CritiqueTypes.LOGIC_ERROR,
        severity: Severity.INFO,
        message: 'Reasoning lacks explicit logical markers',
        suggestion: 'Consider adding explicit premise-conclusion structure'
      }));
    }

    return critiques;
  }

  /**
   * Check for common logical fallacies
   */
  checkLogicalFallacies(text) {
    const critiques = [];
    const lowerText = text.toLowerCase();

    const fallacyPatterns = [
      { pattern: /everyone knows|everybody agrees|no one disputes/i,
        fallacy: 'Appeal to popularity (argumentum ad populum)',
        suggestion: 'Provide evidence rather than appealing to popular opinion' },
      { pattern: /has always been|will always be|never changes/i,
        fallacy: 'Appeal to tradition',
        suggestion: 'Consider whether historical precedent is relevant' },
      { pattern: /if we allow .*, then .* will/i,
        fallacy: 'Slippery slope',
        suggestion: 'Show causal chain between events' }
    ];

    fallacyPatterns.forEach(({ pattern, fallacy, suggestion }) => {
      if (pattern.test(lowerText)) {
        critiques.push(createCritique({
          type: CritiqueTypes.LOGIC_ERROR,
          severity: Severity.WARNING,
          message: `Possible logical fallacy: ${fallacy}`,
          suggestion
        }));
      }
    });

    return critiques;
  }

  /**
   * Check if conclusion follows from premises
   */
  checkConclusionValidity(text, premises, expectedConclusion) {
    const lowerText = text.toLowerCase();
    const hasConclusion = lowerText.includes(expectedConclusion.toLowerCase());

    if (!hasConclusion) {
      return createCritique({
        type: CritiqueTypes.LOGIC_ERROR,
        severity: Severity.ERROR,
        message: 'Expected conclusion not found in reasoning',
        evidence: `Expected: ${expectedConclusion}`,
        suggestion: 'Ensure reasoning leads to the expected conclusion'
      });
    }

    return null;
  }

  /**
   * Check for self-contradictions in text
   */
  checkSelfContradictions(text) {
    const critiques = [];
    const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0);

    // Very basic contradiction check
    // Real implementation would use NLP/semantic analysis
    const statements = [];
    sentences.forEach((sentence, i) => {
      const lower = sentence.toLowerCase().trim();

      // Check for negation patterns
      const negationMatch = lower.match(/(.+)\s+is not\s+(.+)/);
      const affirmationMatch = lower.match(/(.+)\s+is\s+(.+)/);

      if (negationMatch) {
        statements.push({ type: 'negation', subject: negationMatch[1], predicate: negationMatch[2], index: i });
      }
      if (affirmationMatch && !lower.includes('is not')) {
        statements.push({ type: 'affirmation', subject: affirmationMatch[1], predicate: affirmationMatch[2], index: i });
      }
    });

    // Look for contradicting statements
    statements.forEach(s1 => {
      statements.forEach(s2 => {
        if (s1.index !== s2.index &&
            s1.subject === s2.subject &&
            s1.predicate === s2.predicate &&
            s1.type !== s2.type) {
          critiques.push(createCritique({
            type: CritiqueTypes.CONSISTENCY_ERROR,
            severity: Severity.ERROR,
            message: 'Self-contradiction detected',
            location: `Sentences ${s1.index + 1} and ${s2.index + 1}`,
            evidence: `Subject "${s1.subject}" both is and is not "${s1.predicate}"`,
            suggestion: 'Remove or reconcile contradictory statements'
          }));
        }
      });
    });

    return critiques;
  }

  /**
   * Validate JSON format
   */
  validateJson(output) {
    try {
      const str = typeof output === 'string' ? output : JSON.stringify(output);
      JSON.parse(str);
      return { valid: true };
    } catch (error) {
      return { valid: false, error: error.message };
    }
  }

  /**
   * Validate against a schema
   */
  validateSchema(output, schema) {
    const critiques = [];

    try {
      const obj = typeof output === 'string' ? JSON.parse(output) : output;

      // Check required properties
      if (schema.required) {
        schema.required.forEach(prop => {
          if (!(prop in obj)) {
            critiques.push(createCritique({
              type: CritiqueTypes.SCHEMA_VIOLATION,
              severity: Severity.ERROR,
              message: `Missing required property: ${prop}`,
              suggestion: `Add the "${prop}" property to the output`
            }));
          }
        });
      }

      // Check property types
      if (schema.properties) {
        Object.entries(schema.properties).forEach(([prop, propSchema]) => {
          if (prop in obj) {
            const actualType = Array.isArray(obj[prop]) ? 'array' : typeof obj[prop];
            const expectedType = propSchema.type;

            if (expectedType && actualType !== expectedType) {
              critiques.push(createCritique({
                type: CritiqueTypes.SCHEMA_VIOLATION,
                severity: Severity.ERROR,
                location: prop,
                message: `Invalid type for property "${prop}"`,
                evidence: `Expected ${expectedType}, got ${actualType}`,
                suggestion: `Change "${prop}" to type ${expectedType}`
              }));
            }
          }
        });
      }
    } catch (error) {
      critiques.push(createCritique({
        type: CritiqueTypes.SCHEMA_VIOLATION,
        severity: Severity.ERROR,
        message: 'Cannot validate schema: invalid output format',
        evidence: error.message
      }));
    }

    return critiques;
  }

  /**
   * Validate against constraints
   */
  validateConstraints(output, constraints) {
    const critiques = [];

    try {
      const obj = typeof output === 'string' ? JSON.parse(output) : output;

      constraints.forEach(constraint => {
        const { field, condition, value, message } = constraint;
        const fieldValue = field.split('.').reduce((o, k) => o?.[k], obj);

        let passes = true;
        switch (condition) {
          case 'equals':
            passes = fieldValue === value;
            break;
          case 'notEquals':
            passes = fieldValue !== value;
            break;
          case 'greaterThan':
            passes = fieldValue > value;
            break;
          case 'lessThan':
            passes = fieldValue < value;
            break;
          case 'contains':
            passes = Array.isArray(fieldValue) ? fieldValue.includes(value) : String(fieldValue).includes(value);
            break;
          case 'matches':
            passes = new RegExp(value).test(String(fieldValue));
            break;
          case 'oneOf':
            passes = Array.isArray(value) && value.includes(fieldValue);
            break;
        }

        if (!passes) {
          critiques.push(createCritique({
            type: CritiqueTypes.CONSTRAINT_VIOLATION,
            severity: Severity.ERROR,
            location: field,
            message: message || `Constraint violation: ${field} ${condition} ${value}`,
            evidence: `Actual value: ${JSON.stringify(fieldValue)}`,
            suggestion: `Ensure ${field} satisfies: ${condition} ${value}`
          }));
        }
      });
    } catch (error) {
      critiques.push(createCritique({
        type: CritiqueTypes.CONSTRAINT_VIOLATION,
        severity: Severity.ERROR,
        message: 'Cannot validate constraints: invalid output format',
        evidence: error.message
      }));
    }

    return critiques;
  }

  /**
   * Check for required fields
   */
  checkRequiredFields(output, requiredFields) {
    const critiques = [];

    try {
      const obj = typeof output === 'string' ? JSON.parse(output) : output;

      requiredFields.forEach(field => {
        const value = field.split('.').reduce((o, k) => o?.[k], obj);

        if (value === undefined || value === null) {
          critiques.push(createCritique({
            type: CritiqueTypes.SCHEMA_VIOLATION,
            severity: Severity.ERROR,
            location: field,
            message: `Missing required field: ${field}`,
            suggestion: `Add the "${field}" field to the output`
          }));
        } else if (value === '') {
          critiques.push(createCritique({
            type: CritiqueTypes.SCHEMA_VIOLATION,
            severity: Severity.WARNING,
            location: field,
            message: `Required field "${field}" is empty`,
            suggestion: `Provide a value for "${field}"`
          }));
        }
      });
    } catch (error) {
      critiques.push(createCritique({
        type: CritiqueTypes.SCHEMA_VIOLATION,
        severity: Severity.ERROR,
        message: 'Cannot check required fields: invalid output format',
        evidence: error.message
      }));
    }

    return critiques;
  }

  /**
   * Check length constraints
   */
  checkLengthConstraints(output, minLength, maxLength) {
    const str = typeof output === 'string' ? output : JSON.stringify(output);
    const length = str.length;

    if (minLength !== undefined && length < minLength) {
      return createCritique({
        type: CritiqueTypes.CONSTRAINT_VIOLATION,
        severity: Severity.ERROR,
        message: `Output too short: ${length} characters (minimum: ${minLength})`,
        suggestion: `Expand the output to at least ${minLength} characters`
      });
    }

    if (maxLength !== undefined && length > maxLength) {
      return createCritique({
        type: CritiqueTypes.CONSTRAINT_VIOLATION,
        severity: Severity.ERROR,
        message: `Output too long: ${length} characters (maximum: ${maxLength})`,
        suggestion: `Reduce the output to at most ${maxLength} characters`
      });
    }

    return null;
  }
}

// Default export for convenience
export default VerificationPipeline;
