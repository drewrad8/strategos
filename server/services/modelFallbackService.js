// modelFallbackService — auto-fallback at spawn time when target model is exhausted.
//
// Reads cached per-model utilization from usageService.getCachedUsage() (does NOT
// probe inline — spawn must be fast). When target model utilization >= threshold
// (default 0.85, env STRATEGOS_FALLBACK_THRESHOLD) OR exhausted=true, substitutes:
//
//   sonnet exhausted → claude-opus-4-5 / medium
//
// Fallback is only applied for Sonnet-class workers in v1. Opus/Haiku exhaustion
// does NOT auto-fallback (no cheaper Opus tier; Haiku is already cheapest). When
// no fallback applies, returns { fallback: false }.
//
// Spawn pipeline calls shouldFallback(model, label) right before invoking the
// claude CLI — see server/workers/lifecycle.js spawnWorker().
import { getCachedUsage } from './usageService.js';

const DEFAULT_THRESHOLD = 0.85;
const FALLBACK_MODEL = 'claude-opus-4-5';
const FALLBACK_EFFORT = 'medium';
// Explicit bucket name for the fallback target model (see usageService PROBE_MODELS).
// Guards against misreading an exhausted opus-4-7 bucket as "fallback target unavailable"
// when opus-4-5 is actually healthy. See memory #114.
const FALLBACK_TARGET_BUCKET = 'opus_45';

/**
 * Map a Claude model identifier to a per-model bucket.
 * Returns 'sonnet' | 'opus' | 'haiku' | null.
 */
export function mapModelToBucket(model) {
  if (!model || typeof model !== 'string') return null;
  const m = model.toLowerCase();
  if (m.includes('sonnet')) return 'sonnet';
  if (m.includes('opus'))   return 'opus';
  if (m.includes('haiku'))  return 'haiku';
  return null;
}

function getThreshold() {
  const raw = process.env.STRATEGOS_FALLBACK_THRESHOLD;
  if (!raw) return DEFAULT_THRESHOLD;
  const n = parseFloat(raw);
  if (Number.isNaN(n) || n <= 0 || n > 1) return DEFAULT_THRESHOLD;
  return n;
}

/**
 * Decide whether a worker about to spawn with `model` should be substituted.
 *
 * Returns:
 *   { fallback: false }                                                 // no substitution
 *   { fallback: true, replacementModel, replacementEffort, reason }     // substitute
 *
 * options.usage — inject usage payload (tests). Defaults to getCachedUsage().
 */
export function shouldFallback(model, label, options = {}) {
  const usage = options.usage !== undefined ? options.usage : getCachedUsage();

  // No usage data → conservative no-fallback. We never substitute on a guess.
  if (!usage || !usage.models) return { fallback: false };

  const bucket = mapModelToBucket(model);
  if (bucket !== 'sonnet') return { fallback: false }; // v1: only sonnet→opus

  const bucketState = usage.models[bucket];
  if (!bucketState) return { fallback: false };

  const threshold = getThreshold();
  const util = typeof bucketState.utilization === 'number' ? bucketState.utilization : 0;
  const exhausted = bucketState.exhausted === true;

  if (!exhausted && util < threshold) return { fallback: false };

  // Don't fall back if the replacement bucket (opus-4-5) is also exhausted.
  // Prefer the per-version bucket (opus_45) over the legacy alias (models.opus)
  // so that an exhausted opus-4-7 bucket does not falsely block fallback to opus-4-5.
  // models.opus is kept as a backwards-compat fallback for stale cache payloads
  // that predate the per-version split (memory #114).
  const fallbackTargetState = usage.models[FALLBACK_TARGET_BUCKET] ?? usage.models.opus;
  if (fallbackTargetState && fallbackTargetState.exhausted === true) {
    return { fallback: false };
  }

  return {
    fallback: true,
    replacementModel: FALLBACK_MODEL,
    replacementEffort: FALLBACK_EFFORT,
    reason: exhausted
      ? `sonnet bucket exhausted (status=${bucketState.status})`
      : `sonnet utilization ${(util * 100).toFixed(1)}% >= threshold ${(threshold * 100).toFixed(0)}%`,
    originalBucket: bucket,
    label: label || null
  };
}

export const _internal = { DEFAULT_THRESHOLD, FALLBACK_MODEL, FALLBACK_EFFORT, FALLBACK_TARGET_BUCKET, getThreshold };
