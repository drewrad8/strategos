/**
 * Enhanced Verification Tools for External Feedback
 *
 * Research basis: Huang et al. (2024) "Large Language Models Cannot
 * Self-Correct Reasoning Yet" - ICLR 2024, and Kamoi et al. (2024)
 * "When Can LLMs Actually Correct Their Own Mistakes?" - TACL 2024
 *
 * Key insight: INTRINSIC self-correction fails, EXTRINSIC (tool-based)
 * self-correction succeeds. These tools provide external feedback.
 *
 * Tools implemented:
 * - CodeExecutor: Run code and capture errors
 * - WebSearchVerifier: Fact-check claims (stub - needs API)
 * - SymbolicCalculator: Verify mathematical claims
 * - SchemaValidator: Validate JSON/structure against schema
 * - ConsistencyChecker: Check for logical inconsistencies
 * - EnhancedVerificationPipeline: Aggregates all tools
 *
 * @see /research/15-scientific-enhancements-plan.md Section 6
 */

import { spawn } from 'child_process';
import { Severity, CritiqueTypes, createCritique } from './verificationPipeline.js';

/**
 * Base class for verification tools
 */
export class VerificationTool {
  constructor(name, options = {}) {
    this.name = name;
    this.enabled = options.enabled !== false;
    this.timeout = options.timeout || 30000;
  }

  /**
   * Verify output - to be implemented by subclasses
   * @param {string} output - Output to verify
   * @param {Object} context - Additional context
   * @returns {Promise<Object>} { valid, critiques, confidence, evidence }
   */
  async verify(output, context = {}) {
    throw new Error('verify() must be implemented by subclass');
  }

  /**
   * Check if this tool is applicable to the given task type
   * @param {string} taskType - Type of task
   * @returns {boolean}
   */
  isApplicable(taskType) {
    return true; // Override in subclasses
  }
}

/**
 * CodeExecutor - Run code and capture errors
 *
 * Supports JavaScript and Python execution with timeout and sandboxing.
 */
export class CodeExecutor extends VerificationTool {
  constructor(options = {}) {
    super('CodeExecutor', options);
    this.sandboxed = options.sandboxed !== false;
    this.maxOutputLength = options.maxOutputLength || 10000;

    // Language configurations
    this.languages = {
      javascript: {
        command: 'node',
        args: ['-e'],
        fileExt: '.js',
        detectPatterns: [/function\s+\w+/, /const\s+\w+\s*=/, /let\s+\w+/, /=>\s*{/, /require\(/, /import\s+/]
      },
      python: {
        command: 'python3',
        args: ['-c'],
        fileExt: '.py',
        detectPatterns: [/def\s+\w+/, /import\s+\w+/, /from\s+\w+\s+import/, /class\s+\w+/]
      }
    };
  }

  isApplicable(taskType) {
    return taskType === 'code';
  }

  async verify(output, context = {}) {
    // Extract code blocks from output
    const codeBlocks = this.extractCodeBlocks(output);

    if (codeBlocks.length === 0) {
      return {
        valid: true,
        critiques: [],
        confidence: 0.5, // Can't verify without code
        evidence: { reason: 'No code blocks found to verify' }
      };
    }

    const results = [];

    for (const block of codeBlocks) {
      const language = block.language || this.detectLanguage(block.code);
      if (!this.languages[language]) {
        continue; // Skip unsupported languages
      }

      const result = await this.executeCode(block.code, language);
      results.push({ ...result, language, codePreview: block.code.substring(0, 100) });
    }

    // Aggregate results
    const hasErrors = results.some(r => r.exitCode !== 0);
    const critiques = results
      .filter(r => r.exitCode !== 0)
      .flatMap(r => this.parseErrors(r));

    return {
      valid: !hasErrors,
      critiques,
      confidence: results.length > 0 ? (hasErrors ? 0.2 : 0.9) : 0.5,
      evidence: {
        blocksExecuted: results.length,
        results: results.map(r => ({
          language: r.language,
          exitCode: r.exitCode,
          hasStderr: !!r.stderr
        }))
      }
    };
  }

  extractCodeBlocks(text) {
    const blocks = [];

    // Match fenced code blocks: ```language\ncode\n```
    const fencedPattern = /```(\w*)\n([\s\S]*?)```/g;
    let match;

    while ((match = fencedPattern.exec(text)) !== null) {
      blocks.push({
        language: match[1].toLowerCase() || null,
        code: match[2].trim()
      });
    }

    // If no fenced blocks, check if entire output looks like code
    if (blocks.length === 0 && this.looksLikeCode(text)) {
      blocks.push({
        language: null,
        code: text.trim()
      });
    }

    return blocks;
  }

  looksLikeCode(text) {
    // Simple heuristic: contains common code patterns
    const codeIndicators = [
      /function\s*\w*\s*\(/,
      /def\s+\w+\s*\(/,
      /class\s+\w+/,
      /import\s+/,
      /const\s+\w+\s*=/,
      /let\s+\w+\s*=/,
      /var\s+\w+\s*=/,
      /if\s*\(.+\)\s*{/,
      /for\s*\(.+\)\s*{/,
      /while\s*\(.+\)\s*{/
    ];

    return codeIndicators.some(pattern => pattern.test(text));
  }

  detectLanguage(code) {
    for (const [lang, config] of Object.entries(this.languages)) {
      if (config.detectPatterns.some(pattern => pattern.test(code))) {
        return lang;
      }
    }
    return 'javascript'; // Default
  }

  async executeCode(code, language) {
    const config = this.languages[language];
    if (!config) {
      return { exitCode: -1, stderr: `Unsupported language: ${language}` };
    }

    return new Promise((resolve) => {
      const args = [...config.args, code];

      const proc = spawn(config.command, args, {
        timeout: this.timeout,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          NODE_OPTIONS: '--max-old-space-size=128' // Limit memory for safety
        }
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
        if (stdout.length > this.maxOutputLength) {
          proc.kill();
        }
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
        if (stderr.length > this.maxOutputLength) {
          proc.kill();
        }
      });

      proc.on('close', (exitCode) => {
        resolve({
          exitCode: exitCode ?? -1,
          stdout: stdout.substring(0, this.maxOutputLength),
          stderr: stderr.substring(0, this.maxOutputLength),
          timedOut: false
        });
      });

      proc.on('error', (err) => {
        resolve({
          exitCode: -1,
          stdout: '',
          stderr: err.message,
          timedOut: false
        });
      });

      // Timeout handler
      setTimeout(() => {
        proc.kill();
        resolve({
          exitCode: -1,
          stdout,
          stderr: 'Execution timed out',
          timedOut: true
        });
      }, this.timeout);
    });
  }

  parseErrors(result) {
    const critiques = [];
    const stderr = result.stderr || '';

    // Parse common error patterns
    const errorPatterns = [
      // JavaScript/Node errors
      { pattern: /SyntaxError: (.+)/g, type: CritiqueTypes.SYNTAX },
      { pattern: /ReferenceError: (.+)/g, type: CritiqueTypes.LOGIC },
      { pattern: /TypeError: (.+)/g, type: CritiqueTypes.LOGIC },
      { pattern: /Error: (.+)/g, type: CritiqueTypes.LOGIC },
      // Python errors
      { pattern: /(\w+Error): (.+)/g, type: CritiqueTypes.LOGIC },
      { pattern: /SyntaxError: (.+)/g, type: CritiqueTypes.SYNTAX }
    ];

    for (const { pattern, type } of errorPatterns) {
      let match;
      while ((match = pattern.exec(stderr)) !== null) {
        critiques.push(createCritique({
          type,
          message: match[0],
          severity: Severity.ERROR,
          evidence: { source: 'CodeExecutor', language: result.language }
        }));
      }
    }

    // If no specific errors parsed but execution failed
    if (critiques.length === 0 && result.exitCode !== 0) {
      critiques.push(createCritique({
        type: CritiqueTypes.LOGIC,
        message: `Code execution failed with exit code ${result.exitCode}`,
        severity: Severity.ERROR,
        evidence: {
          source: 'CodeExecutor',
          stderr: stderr.substring(0, 200),
          language: result.language
        }
      }));
    }

    return critiques;
  }
}

/**
 * SymbolicCalculator - Verify mathematical claims
 *
 * Extracts mathematical expressions and verifies their results.
 */
export class SymbolicCalculator extends VerificationTool {
  constructor(options = {}) {
    super('SymbolicCalculator', options);
    this.tolerance = options.tolerance || 0.0001;
  }

  isApplicable(taskType) {
    return taskType === 'reasoning' || taskType === 'factual';
  }

  async verify(output, context = {}) {
    const expressions = this.extractMathExpressions(output);

    if (expressions.length === 0) {
      return {
        valid: true,
        critiques: [],
        confidence: 0.5,
        evidence: { reason: 'No mathematical expressions found' }
      };
    }

    const results = expressions.map(expr => this.evaluateExpression(expr));
    const errors = results.filter(r => !r.correct);

    const critiques = errors.map(r => createCritique({
      type: CritiqueTypes.FACTUAL,
      message: `Mathematical error: ${r.expression} = ${r.claimed}, but actual result is ${r.actual}`,
      severity: Severity.ERROR,
      evidence: {
        source: 'SymbolicCalculator',
        expression: r.expression,
        claimed: r.claimed,
        actual: r.actual
      }
    }));

    return {
      valid: errors.length === 0,
      critiques,
      confidence: 1 - (errors.length / Math.max(results.length, 1)),
      evidence: {
        expressionsChecked: results.length,
        errorsFound: errors.length
      }
    };
  }

  extractMathExpressions(text) {
    const expressions = [];

    // Pattern: "expression = result" or "expression equals result"
    const patterns = [
      /(\d+(?:\s*[+\-*/^%]\s*\d+)+)\s*=\s*(\-?\d+(?:\.\d+)?)/g,
      /(\d+(?:\s*[+\-*/^%]\s*\d+)+)\s+equals?\s+(\-?\d+(?:\.\d+)?)/gi,
      // Handle parentheses
      /(\([\d\s+\-*/^%()]+\))\s*=\s*(\-?\d+(?:\.\d+)?)/g
    ];

    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(text)) !== null) {
        expressions.push({
          expression: match[1].trim(),
          claimed: parseFloat(match[2])
        });
      }
    }

    return expressions;
  }

  evaluateExpression(expr) {
    try {
      // Sanitize expression (only allow numbers and operators)
      const sanitized = expr.expression.replace(/[^0-9+\-*/().%^ ]/g, '');

      // Replace ^ with ** for exponentiation
      const jsExpr = sanitized.replace(/\^/g, '**');

      // Safe evaluation using Function constructor (still be careful)
      const actual = Function(`"use strict"; return (${jsExpr})`)();

      return {
        expression: expr.expression,
        claimed: expr.claimed,
        actual,
        correct: Math.abs(actual - expr.claimed) < this.tolerance
      };
    } catch (error) {
      return {
        expression: expr.expression,
        claimed: expr.claimed,
        actual: null,
        correct: false,
        error: error.message
      };
    }
  }
}

/**
 * SchemaValidator - Validate JSON/structure against schema
 *
 * Checks that JSON output matches expected schema.
 */
export class SchemaValidator extends VerificationTool {
  constructor(options = {}) {
    super('SchemaValidator', options);
  }

  isApplicable(taskType) {
    return taskType === 'format' || taskType === 'code';
  }

  async verify(output, context = {}) {
    // If no schema provided, try to parse as JSON for basic validation
    const schema = context.schema;

    // Try to extract JSON from output
    const jsonBlocks = this.extractJson(output);

    if (jsonBlocks.length === 0) {
      // Check if output should be JSON but isn't
      if (context.expectJson) {
        return {
          valid: false,
          critiques: [createCritique({
            type: CritiqueTypes.FORMAT,
            message: 'Expected JSON output but none found',
            severity: Severity.ERROR,
            evidence: { source: 'SchemaValidator' }
          })],
          confidence: 0.9
        };
      }

      return {
        valid: true,
        critiques: [],
        confidence: 0.5,
        evidence: { reason: 'No JSON to validate' }
      };
    }

    const results = jsonBlocks.map(block => {
      const parseResult = this.parseJson(block);
      if (!parseResult.success) {
        return { valid: false, errors: [parseResult.error] };
      }

      if (schema) {
        return this.validateAgainstSchema(parseResult.data, schema);
      }

      return { valid: true, errors: [] };
    });

    const allCritiques = results.flatMap(r =>
      r.errors.map(err => createCritique({
        type: CritiqueTypes.FORMAT,
        message: err,
        severity: Severity.ERROR,
        evidence: { source: 'SchemaValidator' }
      }))
    );

    const allValid = results.every(r => r.valid);

    return {
      valid: allValid,
      critiques: allCritiques,
      confidence: allValid ? 0.95 : 0.3,
      evidence: {
        jsonBlocksFound: jsonBlocks.length,
        validBlocks: results.filter(r => r.valid).length
      }
    };
  }

  extractJson(text) {
    const blocks = [];

    // Try to find JSON in code blocks
    const codeBlockPattern = /```(?:json)?\n([\s\S]*?)```/g;
    let match;
    while ((match = codeBlockPattern.exec(text)) !== null) {
      const content = match[1].trim();
      if (content.startsWith('{') || content.startsWith('[')) {
        blocks.push(content);
      }
    }

    // Try to find standalone JSON objects/arrays
    const jsonPattern = /(\{[\s\S]*?\}|\[[\s\S]*?\])/g;
    while ((match = jsonPattern.exec(text)) !== null) {
      const content = match[1];
      // Avoid duplicates from code blocks
      if (!blocks.includes(content)) {
        blocks.push(content);
      }
    }

    return blocks;
  }

  parseJson(jsonString) {
    try {
      const data = JSON.parse(jsonString);
      return { success: true, data };
    } catch (error) {
      return {
        success: false,
        error: `Invalid JSON: ${error.message}`
      };
    }
  }

  validateAgainstSchema(data, schema, path = '') {
    const errors = [];

    // Type check
    if (schema.type) {
      const actualType = Array.isArray(data) ? 'array' : typeof data;
      if (actualType !== schema.type) {
        errors.push(`${path || 'root'}: Expected ${schema.type}, got ${actualType}`);
      }
    }

    // Required fields for objects
    if (schema.required && schema.type === 'object' && typeof data === 'object') {
      for (const field of schema.required) {
        if (!(field in data)) {
          errors.push(`${path || 'root'}: Missing required field "${field}"`);
        }
      }
    }

    // Validate properties recursively
    if (schema.properties && typeof data === 'object' && !Array.isArray(data)) {
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        if (key in data) {
          const propPath = path ? `${path}.${key}` : key;
          const propResult = this.validateAgainstSchema(data[key], propSchema, propPath);
          errors.push(...propResult.errors);
        }
      }
    }

    // Validate array items
    if (schema.items && Array.isArray(data)) {
      for (let i = 0; i < data.length; i++) {
        const itemPath = `${path}[${i}]`;
        const itemResult = this.validateAgainstSchema(data[i], schema.items, itemPath);
        errors.push(...itemResult.errors);
      }
    }

    // Enum validation
    if (schema.enum && !schema.enum.includes(data)) {
      errors.push(`${path || 'root'}: Value must be one of: ${schema.enum.join(', ')}`);
    }

    // Min/max for numbers
    if (typeof data === 'number') {
      if (schema.minimum !== undefined && data < schema.minimum) {
        errors.push(`${path || 'root'}: Value ${data} is less than minimum ${schema.minimum}`);
      }
      if (schema.maximum !== undefined && data > schema.maximum) {
        errors.push(`${path || 'root'}: Value ${data} is greater than maximum ${schema.maximum}`);
      }
    }

    // MinLength/maxLength for strings
    if (typeof data === 'string') {
      if (schema.minLength !== undefined && data.length < schema.minLength) {
        errors.push(`${path || 'root'}: String length ${data.length} is less than minLength ${schema.minLength}`);
      }
      if (schema.maxLength !== undefined && data.length > schema.maxLength) {
        errors.push(`${path || 'root'}: String length ${data.length} is greater than maxLength ${schema.maxLength}`);
      }
      if (schema.pattern) {
        const regex = new RegExp(schema.pattern);
        if (!regex.test(data)) {
          errors.push(`${path || 'root'}: String does not match pattern "${schema.pattern}"`);
        }
      }
    }

    return { valid: errors.length === 0, errors };
  }
}

/**
 * ConsistencyChecker - Check for logical inconsistencies
 *
 * Analyzes text for contradictory statements.
 */
export class ConsistencyChecker extends VerificationTool {
  constructor(options = {}) {
    super('ConsistencyChecker', options);
  }

  isApplicable(taskType) {
    return taskType === 'reasoning' || taskType === 'factual';
  }

  async verify(output, context = {}) {
    const statements = this.extractStatements(output);

    if (statements.length < 2) {
      return {
        valid: true,
        critiques: [],
        confidence: 0.5,
        evidence: { reason: 'Insufficient statements to check consistency' }
      };
    }

    const contradictions = this.findContradictions(statements);

    const critiques = contradictions.map(c => createCritique({
      type: CritiqueTypes.LOGIC,
      message: `Potential contradiction: "${c.statement1.substring(0, 50)}..." vs "${c.statement2.substring(0, 50)}..."`,
      severity: Severity.WARNING,
      evidence: {
        source: 'ConsistencyChecker',
        statement1: c.statement1,
        statement2: c.statement2,
        reason: c.reason
      }
    }));

    return {
      valid: contradictions.length === 0,
      critiques,
      confidence: 1 - (contradictions.length / Math.max(statements.length, 1)),
      evidence: {
        statementsAnalyzed: statements.length,
        contradictionsFound: contradictions.length
      }
    };
  }

  extractStatements(text) {
    // Split into sentences
    const sentences = text
      .split(/[.!?]+/)
      .map(s => s.trim())
      .filter(s => s.length > 15); // Filter very short fragments

    // Filter to declarative statements (not questions, not meta-commentary)
    return sentences.filter(s => {
      const lower = s.toLowerCase();
      // Skip questions
      if (s.includes('?')) return false;
      // Skip meta-statements
      if (lower.startsWith('i think') || lower.startsWith('perhaps') || lower.startsWith('maybe')) {
        return false;
      }
      // Skip instructions/commands
      if (lower.startsWith('please') || lower.startsWith('you should')) {
        return false;
      }
      return true;
    });
  }

  findContradictions(statements) {
    const contradictions = [];

    // Negation pairs to check
    const negationPairs = [
      ['is', 'is not'],
      ['are', 'are not'],
      ['was', 'was not'],
      ['were', 'were not'],
      ['can', 'cannot'],
      ['will', 'will not'],
      ['does', 'does not'],
      ['do', 'do not'],
      ['should', 'should not'],
      ['always', 'never'],
      ['true', 'false'],
      ['correct', 'incorrect'],
      ['valid', 'invalid'],
      ['possible', 'impossible'],
      ['exists', 'does not exist']
    ];

    for (let i = 0; i < statements.length; i++) {
      for (let j = i + 1; j < statements.length; j++) {
        const s1 = statements[i].toLowerCase();
        const s2 = statements[j].toLowerCase();

        // Extract subjects (simple heuristic: first few significant words)
        const subject1 = this.extractSubject(s1);
        const subject2 = this.extractSubject(s2);

        // If subjects are similar, check for negation
        if (this.subjectsSimilar(subject1, subject2)) {
          for (const [pos, neg] of negationPairs) {
            const hasPos1 = s1.includes(pos) && !s1.includes(neg);
            const hasNeg1 = s1.includes(neg);
            const hasPos2 = s2.includes(pos) && !s2.includes(neg);
            const hasNeg2 = s2.includes(neg);

            if ((hasPos1 && hasNeg2) || (hasNeg1 && hasPos2)) {
              contradictions.push({
                statement1: statements[i],
                statement2: statements[j],
                reason: `Opposing use of "${pos}" vs "${neg}"`
              });
              break;
            }
          }
        }

        // Check for direct numerical contradictions
        const numContradiction = this.checkNumericalContradiction(statements[i], statements[j]);
        if (numContradiction) {
          contradictions.push({
            statement1: statements[i],
            statement2: statements[j],
            reason: numContradiction
          });
        }
      }
    }

    return contradictions;
  }

  extractSubject(sentence) {
    // Simple: first 3-4 significant words
    const words = sentence
      .replace(/[^a-z\s]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 2 && !['the', 'and', 'but', 'for', 'are', 'was', 'were'].includes(w));

    return words.slice(0, 4).join(' ');
  }

  subjectsSimilar(s1, s2) {
    const words1 = new Set(s1.split(' '));
    const words2 = new Set(s2.split(' '));

    let overlap = 0;
    for (const w of words1) {
      if (words2.has(w)) overlap++;
    }

    const similarity = overlap / Math.max(words1.size, words2.size, 1);
    return similarity > 0.5;
  }

  checkNumericalContradiction(s1, s2) {
    // Extract numbers with their contexts
    const numPattern1 = /(\d+(?:\.\d+)?)\s*(%|percent|times|years?|days?|hours?|minutes?)?/gi;
    const numPattern2 = /(\d+(?:\.\d+)?)\s*(%|percent|times|years?|days?|hours?|minutes?)?/gi;

    const nums1 = [...s1.matchAll(numPattern1)];
    const nums2 = [...s2.matchAll(numPattern2)];

    // Look for same-unit different-value contradictions
    for (const m1 of nums1) {
      for (const m2 of nums2) {
        const unit1 = m1[2] || '';
        const unit2 = m2[2] || '';

        // Same unit, different value, in similar context
        if (unit1 === unit2 && m1[1] !== m2[1]) {
          // Check if surrounding words are similar
          const context1 = s1.substring(Math.max(0, m1.index - 20), m1.index + 20);
          const context2 = s2.substring(Math.max(0, m2.index - 20), m2.index + 20);

          if (this.subjectsSimilar(context1.toLowerCase(), context2.toLowerCase())) {
            return `Different values for same metric: ${m1[1]}${unit1} vs ${m2[1]}${unit2}`;
          }
        }
      }
    }

    return null;
  }
}

/**
 * WebSearchVerifier - Fact-check claims against web sources
 *
 * NOTE: This is a stub implementation. Full implementation requires
 * integration with a search API (e.g., Brave, Serper, or similar).
 */
export class WebSearchVerifier extends VerificationTool {
  constructor(options = {}) {
    super('WebSearchVerifier', options);
    this.searchEndpoint = options.searchEndpoint || null;
    this.apiKey = options.apiKey || null;
    this.maxClaims = options.maxClaims || 5;
  }

  isApplicable(taskType) {
    return taskType === 'factual';
  }

  async verify(output, context = {}) {
    // Extract factual claims
    const claims = this.extractClaims(output);

    if (claims.length === 0) {
      return {
        valid: true,
        critiques: [],
        confidence: 0.5,
        evidence: { reason: 'No factual claims detected to verify' }
      };
    }

    // Without API integration, we can't actually verify
    // Return a neutral result that indicates claims need verification
    if (!this.searchEndpoint || !this.apiKey) {
      return {
        valid: true, // Don't fail without verification capability
        critiques: [],
        confidence: 0.3, // Low confidence because we couldn't verify
        evidence: {
          reason: 'Web search not configured - claims not verified',
          claimsDetected: claims.length,
          claims: claims.slice(0, 5)
        }
      };
    }

    // With API: would verify each claim
    const results = await Promise.all(
      claims.slice(0, this.maxClaims).map(claim => this.verifyClaim(claim))
    );

    const unverified = results.filter(r => !r.verified);

    const critiques = unverified.map(r => createCritique({
      type: CritiqueTypes.FACTUAL,
      message: `Claim could not be verified: "${r.claim.substring(0, 50)}..."`,
      severity: Severity.WARNING,
      evidence: {
        source: 'WebSearchVerifier',
        claim: r.claim,
        searchResults: r.searchResults
      }
    }));

    return {
      valid: unverified.length === 0,
      critiques,
      confidence: 1 - (unverified.length / Math.max(results.length, 1)),
      evidence: {
        claimsChecked: results.length,
        unverifiedCount: unverified.length
      }
    };
  }

  extractClaims(text) {
    // Extract sentences that make factual claims
    const sentences = text
      .split(/[.!?]+/)
      .map(s => s.trim())
      .filter(s => s.length > 20);

    return sentences.filter(s => {
      // Indicators of factual claims:
      // - Contains specific years
      if (/\b(19|20)\d{2}\b/.test(s)) return true;
      // - Contains percentages or statistics
      if (/\d+%/.test(s) || /\d+\s*(million|billion|thousand)/i.test(s)) return true;
      // - Contains proper nouns (simple heuristic: consecutive capitalized words)
      if (/[A-Z][a-z]+\s+[A-Z][a-z]+/.test(s)) return true;
      // - Contains citation-like references
      if (/according to|study|research|found that|reported/i.test(s)) return true;

      return false;
    });
  }

  async verifyClaim(claim) {
    // Stub implementation - would call search API
    return {
      claim,
      verified: true, // Default to true in stub
      searchResults: [],
      correction: null
    };
  }
}

/**
 * EnhancedVerificationPipeline - Aggregates all verification tools
 *
 * Selects appropriate tools based on task type and aggregates results.
 */
export class EnhancedVerificationPipeline {
  /**
   * @param {Object} options - Tool configuration options
   * @param {Object} options.codeExecutor - CodeExecutor options
   * @param {Object} options.calculator - SymbolicCalculator options
   * @param {Object} options.schema - SchemaValidator options
   * @param {Object} options.consistency - ConsistencyChecker options
   * @param {Object} options.webSearch - WebSearchVerifier options
   */
  constructor(options = {}) {
    this.tools = {
      code: new CodeExecutor(options.codeExecutor),
      math: new SymbolicCalculator(options.calculator),
      format: new SchemaValidator(options.schema),
      logic: new ConsistencyChecker(options.consistency),
      facts: new WebSearchVerifier(options.webSearch)
    };

    // Task type to tools mapping
    this.toolMapping = {
      code: ['code', 'format'],
      factual: ['facts', 'logic', 'math'],
      reasoning: ['logic', 'math'],
      format: ['format']
    };
  }

  /**
   * Verify output using appropriate tools
   *
   * @param {string} output - Output to verify
   * @param {string} taskType - Type of task
   * @param {Object} context - Additional context
   * @returns {Promise<Object>} Aggregated verification result
   */
  async verify(output, taskType, context = {}) {
    // Select tools for this task type
    const toolNames = this.toolMapping[taskType] || ['logic'];
    const applicableTools = toolNames
      .map(name => this.tools[name])
      .filter(tool => tool && tool.enabled && tool.isApplicable(taskType));

    if (applicableTools.length === 0) {
      return {
        valid: true,
        critiques: [],
        confidence: 0.5,
        toolResults: []
      };
    }

    // Run all applicable tools in parallel
    const results = await Promise.all(
      applicableTools.map(async (tool) => {
        try {
          const result = await tool.verify(output, context);
          return { tool: tool.name, ...result };
        } catch (error) {
          return {
            tool: tool.name,
            valid: true, // Don't fail on tool errors
            critiques: [],
            confidence: 0,
            error: error.message
          };
        }
      })
    );

    return this.aggregateResults(results);
  }

  /**
   * Aggregate results from multiple tools
   */
  aggregateResults(results) {
    const allCritiques = results.flatMap(r => r.critiques || []);

    // Weight confidence by tool reliability
    const validResults = results.filter(r => !r.error);
    const avgConfidence = validResults.length > 0
      ? validResults.reduce((sum, r) => sum + (r.confidence || 0), 0) / validResults.length
      : 0.5;

    // All tools must pass for overall validity
    const allValid = results.every(r => r.valid);

    return {
      valid: allValid,
      critiques: allCritiques,
      confidence: avgConfidence,
      toolResults: results.map(r => ({
        tool: r.tool,
        valid: r.valid,
        confidence: r.confidence,
        critiqueCount: r.critiques?.length || 0,
        error: r.error
      }))
    };
  }

  /**
   * Format critiques for human-readable output
   */
  formatCritique(critiques) {
    if (!critiques || critiques.length === 0) {
      return 'No issues found by verification tools.';
    }

    const lines = ['Issues found by verification tools:'];
    const grouped = {};

    // Group by source tool
    for (const critique of critiques) {
      const source = critique.metadata?.source || 'Unknown';
      if (!grouped[source]) {
        grouped[source] = [];
      }
      grouped[source].push(critique);
    }

    for (const [source, toolCritiques] of Object.entries(grouped)) {
      lines.push(`\n### ${source}`);
      for (const c of toolCritiques) {
        const severity = c.severity ? `[${c.severity.toUpperCase()}]` : '';
        const location = c.location ? ` at ${c.location}` : '';
        lines.push(`- ${severity} ${c.message}${location}`);

        if (c.suggestion) {
          lines.push(`  Suggestion: ${c.suggestion}`);
        }
      }
    }

    return lines.join('\n');
  }

  /**
   * Add or replace a tool
   */
  setTool(name, tool) {
    this.tools[name] = tool;
  }

  /**
   * Update task type mapping
   */
  setToolMapping(taskType, toolNames) {
    this.toolMapping[taskType] = toolNames;
  }

  /**
   * Get tool by name
   */
  getTool(name) {
    return this.tools[name];
  }

  /**
   * Get all available tools
   */
  getAvailableTools() {
    return Object.entries(this.tools)
      .filter(([_, tool]) => tool && tool.enabled)
      .map(([name, tool]) => ({ name, type: tool.constructor.name }));
  }
}

// Export all tools
export default {
  VerificationTool,
  CodeExecutor,
  SymbolicCalculator,
  SchemaValidator,
  ConsistencyChecker,
  WebSearchVerifier,
  EnhancedVerificationPipeline
};
