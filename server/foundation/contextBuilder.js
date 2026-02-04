/**
 * ContextBuilder - Generates structured XML context for AI workers
 *
 * Based on research from 01-Initial Context Design:
 * - Primacy-recency effect: critical info at START (identity) and END (safety/boundaries)
 * - XML tags for Claude models (specifically trained with XML in training data)
 * - Explicit capability boundaries (CAN/CANNOT framework)
 *
 * @module foundation/contextBuilder
 */

/**
 * Default configuration for worker context
 */
const DEFAULT_CONFIG = {
  role: 'worker',
  workerId: null,
  system: 'Strategos AI Worker System',
  capabilities: [],
  primaryObjective: '',
  successCriteria: [],
  qualityStandards: [],
  workingDirectory: process.cwd(),
  project: '',
  availableTools: [],
  progressReporting: 'Report progress every major step',
  errorHandling: 'On error, classify and attempt recovery before escalating',
  verification: 'Verify outputs using available tools before completion',
  allowedActions: [],
  forbiddenActions: [],
  escalationTriggers: [],
  confidenceThreshold: 0.7,
  maxIterations: 10,
  timeout: 300000, // 5 minutes
  humanEscalation: 'When confidence below threshold or max iterations reached'
};

/**
 * Escapes special XML characters in text
 * @param {string} text - Text to escape
 * @returns {string} - XML-safe text
 */
function escapeXml(text) {
  if (text == null) return '';
  const str = String(text);
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Formats an array as XML list items
 * @param {Array} items - Items to format
 * @param {string} indent - Indentation string
 * @returns {string} - Formatted list
 */
function formatList(items, indent = '  ') {
  if (!Array.isArray(items) || items.length === 0) {
    return `${indent}(none specified)`;
  }
  return items.map(item => `${indent}- ${escapeXml(item)}`).join('\n');
}

/**
 * Estimates token count for text
 * Uses a rough approximation: ~4 characters per token for English text
 * This is a heuristic; actual tokenization varies by model
 *
 * @param {string} text - Text to estimate tokens for
 * @returns {number} - Estimated token count
 */
function estimateTokens(text) {
  if (!text || typeof text !== 'string') return 0;

  // Average approximation: ~4 characters per token for English
  // This accounts for:
  // - Common words: ~5-6 chars = 1-2 tokens
  // - Whitespace and punctuation: often separate tokens
  // - XML tags: tend to be multiple tokens
  const charCount = text.length;

  // Adjust for XML structure (tags are typically 2-3 tokens each)
  const tagCount = (text.match(/<[^>]+>/g) || []).length;
  const tagAdjustment = tagCount * 1.5; // Each tag adds ~1.5 extra tokens on average

  return Math.ceil(charCount / 4 + tagAdjustment);
}

/**
 * Builds the identity section (HIGHEST priority - primacy effect)
 * @param {Object} config - Worker configuration
 * @returns {string} - Identity XML section
 */
function buildIdentitySection(config) {
  const capabilities = Array.isArray(config.capabilities)
    ? config.capabilities.join(', ')
    : config.capabilities || '';

  return `<!-- SECTION 1: Identity (HIGH attention - primacy effect) -->
<identity>
  <role>${escapeXml(config.role)}</role>
  <worker_id>${escapeXml(config.workerId || 'unassigned')}</worker_id>
  <system>${escapeXml(config.system)}</system>
  <capabilities>${escapeXml(capabilities)}</capabilities>
</identity>`;
}

/**
 * Builds the mission section
 * @param {Object} config - Worker configuration
 * @returns {string} - Mission XML section
 */
function buildMissionSection(config) {
  return `<!-- SECTION 2: Mission & Objectives -->
<mission>
  <primary_objective>${escapeXml(config.primaryObjective)}</primary_objective>
  <success_criteria>
${formatList(config.successCriteria, '    ')}
  </success_criteria>
  <quality_standards>
${formatList(config.qualityStandards, '    ')}
  </quality_standards>
</mission>`;
}

/**
 * Builds the environment section
 * @param {Object} config - Worker configuration
 * @returns {string} - Environment XML section
 */
function buildEnvironmentSection(config) {
  const tools = Array.isArray(config.availableTools)
    ? config.availableTools.join(', ')
    : config.availableTools || '';

  return `<!-- SECTION 3: Environment -->
<environment>
  <working_directory>${escapeXml(config.workingDirectory)}</working_directory>
  <project>${escapeXml(config.project)}</project>
  <available_tools>${escapeXml(tools)}</available_tools>
</environment>`;
}

/**
 * Builds the task section (can be empty for base context)
 * @param {Object} task - Task details (optional)
 * @returns {string} - Task XML section
 */
function buildTaskSection(task = null) {
  if (!task) {
    return `<!-- SECTION 4: Current Task -->
<task>
  <id>awaiting_assignment</id>
  <description>No task currently assigned</description>
  <acceptance_criteria></acceptance_criteria>
  <output_format></output_format>
  <output_location></output_location>
</task>`;
  }

  return `<!-- SECTION 4: Current Task -->
<task>
  <id>${escapeXml(task.id)}</id>
  <description>${escapeXml(task.description)}</description>
  <acceptance_criteria>
${formatList(task.acceptanceCriteria, '    ')}
  </acceptance_criteria>
  <output_format>${escapeXml(task.outputFormat || '')}</output_format>
  <output_location>${escapeXml(task.outputLocation || '')}</output_location>
</task>`;
}

/**
 * Builds the behavior section
 * @param {Object} config - Worker configuration
 * @returns {string} - Behavior XML section
 */
function buildBehaviorSection(config) {
  return `<!-- SECTION 5: Behavioral Guidelines -->
<behavior>
  <progress_reporting>${escapeXml(config.progressReporting)}</progress_reporting>
  <error_handling>${escapeXml(config.errorHandling)}</error_handling>
  <verification>${escapeXml(config.verification)}</verification>
</behavior>`;
}

/**
 * Builds the boundaries section (HIGH priority - recency effect)
 * @param {Object} config - Worker configuration
 * @returns {string} - Boundaries XML section
 */
function buildBoundariesSection(config) {
  return `<!-- SECTION 6: Capability Boundaries (HIGH attention - recency effect) -->
<boundaries>
  <can>
${formatList(config.allowedActions, '    ')}
  </can>
  <cannot>
${formatList(config.forbiddenActions, '    ')}
  </cannot>
  <escalate_when>
${formatList(config.escalationTriggers, '    ')}
  </escalate_when>
</boundaries>`;
}

/**
 * Builds the safety section (FINAL position - highest recency)
 * @param {Object} config - Worker configuration
 * @returns {string} - Safety XML section
 */
function buildSafetySection(config) {
  return `<!-- SECTION 7: Safety Constraints (FINAL position) -->
<safety>
  <confidence_threshold>${config.confidenceThreshold}</confidence_threshold>
  <max_iterations>${config.maxIterations}</max_iterations>
  <timeout>${config.timeout}</timeout>
  <human_escalation>${escapeXml(config.humanEscalation)}</human_escalation>
</safety>`;
}

/**
 * Builds complete worker context XML from configuration
 *
 * Structure follows primacy-recency research:
 * 1. Identity (primacy - high attention)
 * 2. Mission & Objectives
 * 3. Environment
 * 4. Current Task
 * 5. Behavioral Guidelines
 * 6. Capability Boundaries (recency - high attention)
 * 7. Safety Constraints (final - highest recency)
 *
 * @param {Object} config - Worker configuration
 * @returns {string} - Complete XML context
 */
function buildWorkerContext(config = {}) {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };

  const sections = [
    buildIdentitySection(mergedConfig),
    buildMissionSection(mergedConfig),
    buildEnvironmentSection(mergedConfig),
    buildTaskSection(null), // Task section placeholder
    buildBehaviorSection(mergedConfig),
    buildBoundariesSection(mergedConfig),
    buildSafetySection(mergedConfig)
  ];

  return sections.join('\n\n');
}

/**
 * Injects a task into existing worker context
 * Replaces the task section while preserving all other sections
 *
 * @param {Object} task - Task to inject
 * @param {string} workerContext - Existing worker context XML
 * @returns {string} - Updated context with task
 */
function buildTaskContext(task, workerContext) {
  if (!workerContext || typeof workerContext !== 'string') {
    throw new Error('workerContext must be a valid string');
  }

  if (!task || typeof task !== 'object') {
    throw new Error('task must be a valid object');
  }

  const newTaskSection = buildTaskSection(task);

  // Replace existing task section
  // Match from <!-- SECTION 4 to the end of </task>
  const taskSectionRegex = /<!-- SECTION 4: Current Task -->[\s\S]*?<\/task>/;

  if (taskSectionRegex.test(workerContext)) {
    return workerContext.replace(taskSectionRegex, newTaskSection);
  }

  // If no task section found, insert before boundaries section
  const boundariesIndex = workerContext.indexOf('<!-- SECTION 6:');
  if (boundariesIndex !== -1) {
    return workerContext.slice(0, boundariesIndex) +
           newTaskSection + '\n\n' +
           workerContext.slice(boundariesIndex);
  }

  // Fallback: append before safety section
  const safetyIndex = workerContext.indexOf('<!-- SECTION 7:');
  if (safetyIndex !== -1) {
    return workerContext.slice(0, safetyIndex) +
           newTaskSection + '\n\n' +
           workerContext.slice(safetyIndex);
  }

  // Last resort: append at end
  return workerContext + '\n\n' + newTaskSection;
}

/**
 * Compresses context to fit within target token limit
 *
 * Compression strategy (preserves primacy-recency structure):
 * 1. ALWAYS preserve identity section (primacy)
 * 2. ALWAYS preserve safety section (recency)
 * 3. ALWAYS preserve boundaries section (recency)
 * 4. Progressively summarize middle sections
 *
 * @param {string} context - Context to compress
 * @param {number} targetTokens - Target token count
 * @returns {Object} - { compressed: string, originalTokens: number, compressedTokens: number }
 */
function compressContext(context, targetTokens) {
  if (!context || typeof context !== 'string') {
    throw new Error('context must be a valid string');
  }

  if (typeof targetTokens !== 'number' || targetTokens <= 0) {
    throw new Error('targetTokens must be a positive number');
  }

  const originalTokens = estimateTokens(context);

  // If already under target, return as-is
  if (originalTokens <= targetTokens) {
    return {
      compressed: context,
      originalTokens,
      compressedTokens: originalTokens,
      wasCompressed: false
    };
  }

  // Extract sections for selective compression
  const sections = extractSections(context);

  // Calculate tokens per section
  const sectionTokens = {};
  for (const [name, content] of Object.entries(sections)) {
    sectionTokens[name] = estimateTokens(content);
  }

  // Protected sections (never compress): identity, boundaries, safety
  const protectedSections = ['identity', 'boundaries', 'safety'];
  const protectedTokens = protectedSections.reduce((sum, name) =>
    sum + (sectionTokens[name] || 0), 0);

  // Available budget for other sections
  const availableBudget = targetTokens - protectedTokens;

  if (availableBudget <= 0) {
    // Can only fit protected sections - return minimal context
    const minimalContext = [
      sections.identity || '',
      sections.boundaries || '',
      sections.safety || ''
    ].filter(Boolean).join('\n\n');

    return {
      compressed: minimalContext,
      originalTokens,
      compressedTokens: estimateTokens(minimalContext),
      wasCompressed: true,
      warning: 'Could only preserve protected sections (identity, boundaries, safety)'
    };
  }

  // Compress middle sections progressively
  const compressibleSections = ['mission', 'environment', 'task', 'behavior'];
  const compressedSections = { ...sections };

  // Calculate compression ratio needed for compressible sections
  const compressibleTokens = compressibleSections.reduce((sum, name) =>
    sum + (sectionTokens[name] || 0), 0);

  if (compressibleTokens > availableBudget) {
    const compressionRatio = availableBudget / compressibleTokens;

    for (const sectionName of compressibleSections) {
      if (compressedSections[sectionName]) {
        compressedSections[sectionName] = summarizeSection(
          compressedSections[sectionName],
          compressionRatio
        );
      }
    }
  }

  // Rebuild context in proper order
  const orderedSections = [
    'identity',
    'mission',
    'environment',
    'task',
    'behavior',
    'boundaries',
    'safety'
  ];

  const compressed = orderedSections
    .map(name => compressedSections[name])
    .filter(Boolean)
    .join('\n\n');

  return {
    compressed,
    originalTokens,
    compressedTokens: estimateTokens(compressed),
    wasCompressed: true
  };
}

/**
 * Extracts named sections from context XML
 * @param {string} context - Full context XML
 * @returns {Object} - Map of section name to content
 */
function extractSections(context) {
  const sections = {};

  const sectionPatterns = [
    { name: 'identity', pattern: /<!-- SECTION 1:[\s\S]*?<\/identity>/ },
    { name: 'mission', pattern: /<!-- SECTION 2:[\s\S]*?<\/mission>/ },
    { name: 'environment', pattern: /<!-- SECTION 3:[\s\S]*?<\/environment>/ },
    { name: 'task', pattern: /<!-- SECTION 4:[\s\S]*?<\/task>/ },
    { name: 'behavior', pattern: /<!-- SECTION 5:[\s\S]*?<\/behavior>/ },
    { name: 'boundaries', pattern: /<!-- SECTION 6:[\s\S]*?<\/boundaries>/ },
    { name: 'safety', pattern: /<!-- SECTION 7:[\s\S]*?<\/safety>/ }
  ];

  for (const { name, pattern } of sectionPatterns) {
    const match = context.match(pattern);
    if (match) {
      sections[name] = match[0];
    }
  }

  return sections;
}

/**
 * Summarizes a section to fit compression ratio
 * @param {string} section - Section content
 * @param {number} ratio - Target ratio (0-1)
 * @returns {string} - Summarized section
 */
function summarizeSection(section, ratio) {
  if (ratio >= 1) return section;

  // For very aggressive compression, strip list items but keep structure
  if (ratio < 0.3) {
    // Replace multi-line lists with single summary
    return section
      .replace(/(\s+- [^\n]+\n)+/g, '\n    (summarized for context limits)\n')
      .replace(/\n\s*\n\s*\n/g, '\n\n');
  }

  // For moderate compression, truncate long lists
  if (ratio < 0.7) {
    const lines = section.split('\n');
    const result = [];
    let listItemCount = 0;
    const maxListItems = Math.max(2, Math.floor(5 * ratio));

    for (const line of lines) {
      if (line.trim().startsWith('-')) {
        listItemCount++;
        if (listItemCount <= maxListItems) {
          result.push(line);
        } else if (listItemCount === maxListItems + 1) {
          result.push('    - (additional items omitted for brevity)');
        }
      } else {
        listItemCount = 0;
        result.push(line);
      }
    }

    return result.join('\n');
  }

  // Mild compression: just return as-is (structure preserved)
  return section;
}

// ESM Exports
export {
  buildWorkerContext,
  buildTaskContext,
  compressContext,
  estimateTokens,
  // Export helpers for testing
  escapeXml,
  extractSections,
  DEFAULT_CONFIG
};
