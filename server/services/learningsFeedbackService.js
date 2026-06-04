/**
 * Learnings Feedback Service
 *
 * Distills successful worker learnings from learningsDb and injects them
 * into template-overrides.json as `append_to_mission` guidance.
 *
 * This creates a feedback loop: successful workers teach future workers.
 * Inspired by Meta's Hyperagents self-improvement research.
 *
 * Algorithm (v1 — no LLM required):
 *   1. Query learnings for success=1, last 7 days, grouped by templateType
 *   2. Tokenize each learning text into sentences/bullet points
 *   3. Score by frequency (same phrase appearing in N learnings) + recency
 *   4. Select top 5 unique, actionable learnings per template type
 *   5. Write into template-overrides.json append_to_mission
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getLearnings } from '../learningsDb.js';
import { getLogger } from '../logger.js';
import { updateOverridesSync } from './templateOverridesStore.js';

const logger = getLogger('learningsFeedback');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OVERRIDES_PATH = path.join(__dirname, '..', 'template-overrides.json');

const TEMPLATE_TYPES = ['impl', 'fix', 'research', 'colonel', 'general', 'test', 'review'];

// Minimum learning text length to be considered actionable
const MIN_LEARNING_LENGTH = 30;
// Max bullet points to include in append_to_mission per template type
const TOP_N = 5;
// Lookback window in days
const LOOKBACK_DAYS = 7;

// ============================================
// INTERNAL HELPERS
// ============================================

/**
 * Split a learning text blob into individual bullet/sentence candidates.
 * Handles newline-delimited bullets, numbered lists, and prose sentences.
 */
function splitIntoCandidates(text) {
  if (!text || typeof text !== 'string') return [];

  // Normalize line endings
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  const lines = normalized.split('\n');
  const candidates = [];

  for (const line of lines) {
    // Strip markdown bullets and numbering
    const stripped = line.replace(/^[\s\-\*\d\.]+/, '').trim();
    if (stripped.length >= MIN_LEARNING_LENGTH) {
      candidates.push(stripped);
    }
  }

  // If no line-based candidates, try splitting on periods for prose
  if (candidates.length === 0) {
    const sentences = text.split(/\.\s+/);
    for (const s of sentences) {
      const stripped = s.trim();
      if (stripped.length >= MIN_LEARNING_LENGTH) {
        candidates.push(stripped.endsWith('.') ? stripped : stripped + '.');
      }
    }
  }

  return candidates;
}

/**
 * Normalize a candidate string for deduplication comparison.
 * Lowercases, strips punctuation, collapses whitespace.
 */
function normalizeForComparison(text) {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Check if two normalized strings are similar enough to be duplicates.
 * Uses simple word-overlap ratio (Jaccard-like).
 */
function areSimilar(a, b, threshold = 0.6) {
  const wordsA = new Set(a.split(' ').filter(w => w.length > 3));
  const wordsB = new Set(b.split(' ').filter(w => w.length > 3));

  if (wordsA.size === 0 || wordsB.size === 0) return false;

  let overlap = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) overlap++;
  }

  const union = wordsA.size + wordsB.size - overlap;
  return overlap / union >= threshold;
}

/**
 * Distill learnings for a single template type.
 * Returns an array of top bullet point strings (at most TOP_N).
 *
 * @param {string} templateType
 * @returns {string[]}
 */
function distillForType(templateType) {
  // Fetch successful learnings from last LOOKBACK_DAYS days
  let rows;
  try {
    rows = getLearnings(templateType, LOOKBACK_DAYS).filter(r => r.success === 1 && r.learnings);
  } catch (err) {
    logger.warn(`[learningsFeedback] getLearnings failed for template "${templateType}": ${err.message}`);
    return [];
  }

  if (rows.length === 0) return [];

  // Extract all candidate bullet points with timestamps for recency scoring
  const candidateMap = new Map(); // normalized text → { text, count, latestTs }

  for (const row of rows) {
    const candidates = splitIntoCandidates(row.learnings);
    const ts = row.timestamp ? new Date(row.timestamp).getTime() : 0;

    for (const candidate of candidates) {
      const norm = normalizeForComparison(candidate);
      if (!norm || norm.length < 10) continue;

      // Check if this is similar to an existing candidate
      let matched = false;
      for (const [existingNorm, entry] of candidateMap) {
        if (areSimilar(norm, existingNorm)) {
          entry.count++;
          if (ts > entry.latestTs) {
            entry.latestTs = ts;
            entry.text = candidate; // prefer more recent phrasing
          }
          matched = true;
          break;
        }
      }

      if (!matched) {
        candidateMap.set(norm, { text: candidate, count: 1, latestTs: ts });
      }
    }
  }

  if (candidateMap.size === 0) return [];

  // Score: frequency weighted by recency
  const now = Date.now();
  const oneWeekMs = LOOKBACK_DAYS * 86400000;

  const scored = Array.from(candidateMap.values()).map(entry => {
    // Recency: 0.0–1.0, decays linearly over LOOKBACK_DAYS
    const ageFraction = Math.max(0, Math.min(1, (now - entry.latestTs) / oneWeekMs));
    const recencyScore = 1 - ageFraction;
    // Combined score: frequency is primary, recency breaks ties
    const score = entry.count + recencyScore * 0.5;
    return { text: entry.text, score, count: entry.count };
  });

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  // Deduplicate by similarity in final pass, take top N
  const selected = [];
  const selectedNorms = [];

  for (const item of scored) {
    if (selected.length >= TOP_N) break;

    const norm = normalizeForComparison(item.text);
    const isDup = selectedNorms.some(existing => areSimilar(norm, existing));
    if (!isDup) {
      selected.push(item.text);
      selectedNorms.push(norm);
    }
  }

  return selected;
}

/**
 * Format distilled bullets into a mission-appendable string.
 * Returns empty string if no bullets.
 */
function formatBullets(bullets) {
  if (!bullets || bullets.length === 0) return '';
  return '\n\n## Distilled Learnings from Successful Workers\n' +
    bullets.map(b => `- ${b}`).join('\n');
}

// ============================================
// PUBLIC API
// ============================================

let lastSyncResult = null;

/**
 * Run the learnings feedback distillation and write results to template-overrides.json.
 *
 * @returns {{ syncedAt: string, perType: Object, overridesPath: string }}
 */
export function runFeedbackSync() {
  const perType = {};
  const syncedAt = new Date().toISOString();

  // Distill first (DB-derived, independent of the file) so the serialized
  // read→merge→write section stays minimal.
  const appendByType = {};
  for (const templateType of TEMPLATE_TYPES) {
    const bullets = distillForType(templateType);
    const appendText = formatBullets(bullets);
    appendByType[templateType] = appendText;
    perType[templateType] = {
      bulletCount: bullets.length,
      bullets,
      append_to_mission: appendText,
    };
  }

  // Serialized read → merge → atomic write via the shared store. This service
  // is the SINGLE owner of `append_to_mission`; all other fields are preserved.
  updateOverridesSync((overrides) => {
    overrides.overrides = overrides.overrides || {};
    for (const templateType of TEMPLATE_TYPES) {
      const existing = overrides.overrides[templateType] || {};
      overrides.overrides[templateType] = {
        ...existing,
        append_to_mission: appendByType[templateType],
        feedbackSyncedAt: syncedAt,
      };
    }
    overrides.version = (overrides.version || 0) + 1;
    overrides.updatedAt = syncedAt;
    return overrides;
  });

  lastSyncResult = { syncedAt, perType, overridesPath: OVERRIDES_PATH };
  return lastSyncResult;
}

/**
 * Return the status of the last feedback sync without running a new one.
 *
 * @returns {{ syncedAt: string|null, perType: Object|null, overridesPath: string }}
 */
export function getFeedbackStatus() {
  // Also pull feedbackSyncedAt from the file in case server restarted
  if (!lastSyncResult) {
    try {
      const raw = fs.readFileSync(OVERRIDES_PATH, 'utf8');
      const overrides = JSON.parse(raw);
      // Find most recent feedbackSyncedAt across any type
      let latestSync = null;
      const perType = {};
      for (const [type, data] of Object.entries(overrides.overrides || {})) {
        if (data.feedbackSyncedAt) {
          if (!latestSync || data.feedbackSyncedAt > latestSync) {
            latestSync = data.feedbackSyncedAt;
          }
          perType[type] = {
            append_to_mission: data.append_to_mission || '',
            feedbackSyncedAt: data.feedbackSyncedAt,
          };
        }
      }
      if (latestSync) {
        return { syncedAt: latestSync, perType, overridesPath: OVERRIDES_PATH };
      }
    } catch {
      // Fall through
    }
    return { syncedAt: null, perType: null, overridesPath: OVERRIDES_PATH };
  }

  return lastSyncResult;
}
