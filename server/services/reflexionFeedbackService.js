/**
 * Reflexion Feedback Service
 *
 * Distills failure analyses from failure_reflections and injects them
 * into template-overrides.json as `failure_warnings` guidance.
 *
 * This closes the failure-reflexion loop: failed workers teach future workers.
 * Mirrors learningsFeedbackService.js — same Jaccard dedup, same scoring.
 *
 * Algorithm (v1 — no LLM required):
 *   1. Query failure_reflections for last 14 days, grouped by templateType
 *   2. Extract avoidNextTime bullets from each reflection JSON
 *   3. Score by frequency (same phrase appearing in N reflections) + recency
 *   4. Select top 5 unique warnings per template type
 *   5. Write into template-overrides.json failure_warnings
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getReflectionsByType } from '../learningsDb.js';
import { getLogger } from '../logger.js';
import { updateOverridesSync } from './templateOverridesStore.js';

const logger = getLogger('reflexionFeedback');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OVERRIDES_PATH = path.join(__dirname, '..', 'template-overrides.json');

const TEMPLATE_TYPES = ['impl', 'fix', 'research', 'colonel', 'general', 'test', 'review'];

const MIN_WARNING_LENGTH = 30;
const TOP_N = 5;
const LOOKBACK_DAYS = 14;

// ============================================
// INTERNAL HELPERS
// ============================================

/**
 * Split an avoidNextTime text blob into individual bullet/sentence candidates.
 */
function splitIntoCandidates(text) {
  if (!text || typeof text !== 'string') return [];

  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');
  const candidates = [];

  for (const line of lines) {
    const stripped = line.replace(/^[\s\-\*\d\.]+/, '').trim();
    if (stripped.length >= MIN_WARNING_LENGTH) {
      candidates.push(stripped);
    }
  }

  if (candidates.length === 0) {
    const sentences = text.split(/\.\s+/);
    for (const s of sentences) {
      const stripped = s.trim();
      if (stripped.length >= MIN_WARNING_LENGTH) {
        candidates.push(stripped.endsWith('.') ? stripped : stripped + '.');
      }
    }
  }

  return candidates;
}

/**
 * Normalize a candidate string for deduplication comparison.
 */
function normalizeForComparison(text) {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Jaccard-like word-overlap similarity check.
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
 * Distill failure warnings for a single template type.
 * Returns an array of top avoidNextTime bullet strings (at most TOP_N).
 *
 * @param {string} templateType
 * @returns {string[]}
 */
function distillForType(templateType) {
  let rows;
  try {
    rows = getReflectionsByType(templateType, LOOKBACK_DAYS);
  } catch (err) {
    logger.warn(`[reflexionFeedback] getReflectionsByType failed for template "${templateType}": ${err.message}`);
    return [];
  }

  if (rows.length === 0) return [];

  const candidateMap = new Map();

  for (const row of rows) {
    let parsed;
    try {
      parsed = JSON.parse(row.reflection);
    } catch {
      continue;
    }

    const avoidText = parsed.avoidNextTime;
    if (!avoidText || typeof avoidText !== 'string') continue;

    const ts = row.generatedAt ? new Date(row.generatedAt).getTime() : 0;
    const candidates = splitIntoCandidates(avoidText);

    for (const candidate of candidates) {
      const norm = normalizeForComparison(candidate);
      if (!norm || norm.length < 10) continue;

      let matched = false;
      for (const [existingNorm, entry] of candidateMap) {
        if (areSimilar(norm, existingNorm)) {
          entry.count++;
          if (ts > entry.latestTs) {
            entry.latestTs = ts;
            entry.text = candidate;
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

  const now = Date.now();
  const lookbackMs = LOOKBACK_DAYS * 86400000;

  const scored = Array.from(candidateMap.values()).map(entry => {
    const ageFraction = Math.max(0, Math.min(1, (now - entry.latestTs) / lookbackMs));
    const recencyScore = 1 - ageFraction;
    const score = entry.count + recencyScore * 0.5;
    return { text: entry.text, score, count: entry.count };
  });

  scored.sort((a, b) => b.score - a.score);

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
 * Format distilled warnings into a mission-prepend string.
 * Returns empty string if no warnings.
 */
function formatWarnings(warnings) {
  if (!warnings || warnings.length === 0) return '';
  return '## Failure Warnings — Learned from Past Workers\n' +
    warnings.map(w => `- ${w}`).join('\n') + '\n\n';
}

// ============================================
// PUBLIC API
// ============================================

let lastSyncResult = null;

/**
 * Run the reflexion feedback distillation and write results to template-overrides.json.
 *
 * @returns {{ syncedAt: string, perType: Object, overridesPath: string }}
 */
export function runReflexionFeedbackSync() {
  const perType = {};
  const syncedAt = new Date().toISOString();

  // Distill first (DB-derived) so the serialized read→merge→write stays minimal.
  const warningByType = {};
  for (const templateType of TEMPLATE_TYPES) {
    const warnings = distillForType(templateType);
    const warningText = formatWarnings(warnings);
    warningByType[templateType] = warningText;
    perType[templateType] = {
      warningCount: warnings.length,
      warnings,
      failure_warnings: warningText,
    };
  }

  // Serialized read → merge → atomic write via the shared store. This service is
  // the SINGLE owner of `failure_warnings`; all other fields are preserved.
  updateOverridesSync((overrides) => {
    overrides.overrides = overrides.overrides || {};
    for (const templateType of TEMPLATE_TYPES) {
      const existing = overrides.overrides[templateType] || {};
      overrides.overrides[templateType] = {
        ...existing,
        failure_warnings: warningByType[templateType],
        reflexionSyncedAt: syncedAt,
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
 * Return the status of the last reflexion feedback sync without running a new one.
 *
 * @returns {{ syncedAt: string|null, perType: Object|null, overridesPath: string }}
 */
export function getReflexionFeedbackStatus() {
  if (!lastSyncResult) {
    try {
      const raw = fs.readFileSync(OVERRIDES_PATH, 'utf8');
      const overrides = JSON.parse(raw);
      let latestSync = null;
      const perType = {};
      for (const [type, data] of Object.entries(overrides.overrides || {})) {
        if (data.reflexionSyncedAt) {
          if (!latestSync || data.reflexionSyncedAt > latestSync) {
            latestSync = data.reflexionSyncedAt;
          }
          perType[type] = {
            failure_warnings: data.failure_warnings || '',
            reflexionSyncedAt: data.reflexionSyncedAt,
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
