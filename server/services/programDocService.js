/**
 * Program Document Service
 *
 * Synthesizes a per-project program.md from the memory DB (decisions, approaches, warnings)
 * and recent learnings. Written to {projectPath}/.thea/program.md and injected into
 * RESEARCH/COLONEL/GENERAL workers at spawn time.
 */

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ~5K tokens = ~2.5% of Sonnet 4.6 200K context window;
// fits ~13 entries across categories with 2x growth headroom against current 51K chars of curated memory
export const PROGRAM_DOC_BUDGET = 20000;

// Base per-category char budgets; ~1000 reserved for header + section headings
const BASE_BUDGETS = {
  decision: 8000,
  warning: 8000,
  approach: 1500,
  learnings: 1500,
};

// Debounce timers: projectName -> setTimeout handle
const _pendingTimers = new Map();

/**
 * Select formatted bullet strings from a list up to a char budget.
 * Per-entry rule: if including an entry would exceed `budget` by >50%, skip it and try the next.
 * Never truncates mid-entry.
 */
function pickEntries(formatted, budget) {
  const picked = [];
  let used = 0;
  for (const text of formatted) {
    const len = text.length;
    if (used + len <= budget) {
      picked.push(text);
      used += len;
    } else {
      const overflow = (used + len) - budget;
      if (overflow > budget * 0.5) {
        continue; // Exceeds by >50% of budget — skip, try next
      }
      // Small overflow (≤50%) — include whole entry, stop filling this category
      picked.push(text);
      used += len;
      break;
    }
  }
  return { picked, used };
}

/**
 * Generate a program.md string from the memory DB for the given project.
 * Uses category-balanced selection to stay within PROGRAM_DOC_BUDGET chars.
 * @param {string} projectName - Namespace / project name (e.g. "strategos")
 * @returns {string}
 */
export async function generateProgramDoc(projectName) {
  const { getMemoryEntries } = await import('../memoryDb.js');
  const { getRecentSuccessesByType } = await import('../learningsDb.js');

  // Fetch enough entries to fill all categories after the 30-day filter
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const entries = getMemoryEntries(projectName, null, 500).filter(e => {
    const validCats = new Set(['decision', 'approach', 'warning']);
    if (!validCats.has(e.category)) return false;
    return new Date(e.created_at) >= cutoff;
  });

  // Group by category, most recent first
  const byCategory = { decision: [], approach: [], warning: [] };
  for (const e of entries) byCategory[e.category].push(e);
  for (const cat of Object.keys(byCategory)) {
    byCategory[cat].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  }

  // Recent done-worker learnings (any role that has them)
  const recentLearnings = [];
  for (const type of ['general', 'colonel', 'impl', 'fix', 'research', 'test']) {
    const rows = getRecentSuccessesByType(type, 2, 30);
    for (const r of rows) {
      if (r.learnings) recentLearnings.push(`[${type.toUpperCase()}] ${r.learnings.slice(0, 300)}`);
    }
    if (recentLearnings.length >= 5) break;
  }

  // Format all available entries per category as bullet strings
  const allFormatted = {
    decision: byCategory.decision.map(e => `- ${e.content}\n`),
    warning: byCategory.warning.map(e => `- ${e.content}\n`),
    approach: byCategory.approach.map(e => `- ${e.content}\n`),
    learnings: recentLearnings.slice(0, 5).map(s => `- ${s}\n`),
  };

  // Measure available content per category
  const available = {};
  for (const cat of Object.keys(BASE_BUDGETS)) {
    available[cat] = allFormatted[cat].reduce((s, t) => s + t.length, 0);
  }

  // Redistribute unused budget from under-filled categories to over-filled ones
  const budgets = { ...BASE_BUDGETS };
  let unused = 0;
  const overflowing = [];
  for (const cat of Object.keys(budgets)) {
    if (available[cat] < budgets[cat]) {
      unused += budgets[cat] - available[cat];
    } else {
      overflowing.push(cat);
    }
  }
  if (unused > 0 && overflowing.length > 0) {
    const bonus = Math.floor(unused / overflowing.length);
    for (const cat of overflowing) budgets[cat] += bonus;
  }

  // Pick entries per category up to their (possibly enlarged) budget
  const picked = {};
  for (const cat of Object.keys(budgets)) {
    picked[cat] = pickEntries(allFormatted[cat], budgets[cat]).picked;
  }

  // Build sections in priority order (highest priority first: decisions > warnings > approaches > learnings)
  const header = `# Project Context — ${projectName}\n`;
  const prioritySections = [
    { key: 'decision',  heading: '\n## Decisions\n' },
    { key: 'warning',   heading: '\n## Warnings\n' },
    { key: 'approach',  heading: '\n## Approaches\n' },
    { key: 'learnings', heading: '\n## Recent Learnings\n' },
  ];

  let doc = header;
  let truncated = false;
  for (const { key, heading } of prioritySections) {
    if (picked[key].length === 0) continue;
    const block = heading + picked[key].join('');
    if (doc.length + block.length <= PROGRAM_DOC_BUDGET) {
      doc += block;
    } else {
      truncated = true;
      console.warn(`[programDocService] dropping ${key} section: would exceed PROGRAM_DOC_BUDGET (${doc.length + block.length} > ${PROGRAM_DOC_BUDGET})`);
    }
  }
  if (truncated) {
    console.warn(`[programDocService] final doc length: ${doc.length} chars`);
  }

  return doc;
}

/**
 * Write program.md to {projectPath}/.thea/program.md. Non-fatal on error.
 * @param {string} projectPath
 */
export async function writeProgramDoc(projectPath) {
  try {
    if (!fs.existsSync(projectPath)) return;
    const projectName = path.basename(projectPath);
    const theaDir = path.join(projectPath, '.thea');
    const outPath = path.join(theaDir, 'program.md');
    const content = await generateProgramDoc(projectName);
    fs.mkdirSync(theaDir, { recursive: true });
    fs.writeFileSync(outPath, content, 'utf8');
  } catch {
    // Non-fatal
  }
}

/**
 * Read {projectPath}/.thea/program.md synchronously.
 * @param {string} projectPath
 * @returns {string|null}
 */
export function getProgramDoc(projectPath) {
  try {
    const filePath = path.join(projectPath, '.thea', 'program.md');
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Debounced regeneration: waits 500ms after last call before writing.
 * @param {string} projectName
 * @param {string} projectPath
 */
export function scheduleDocUpdate(projectName, projectPath) {
  if (_pendingTimers.has(projectName)) {
    clearTimeout(_pendingTimers.get(projectName));
  }
  const handle = setTimeout(async () => {
    _pendingTimers.delete(projectName);
    try {
      await writeProgramDoc(projectPath);
    } catch {
      // Non-fatal
    }
  }, 500);
  _pendingTimers.set(projectName, handle);
}
