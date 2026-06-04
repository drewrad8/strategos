// Anthropic rate-limit usage probing service.
//
// Probes /v1/messages with max_tokens:1 against haiku/sonnet/opus to derive
// per-model exhaustion. Anthropic does NOT expose per-model utilization headers
// (only `anthropic-ratelimit-unified-*`). Empirically:
//   • 200 + headers → model OK; unified headers carry session/weekly utilization
//   • 429 → probe_throttled (uncertain); probe uses a different OAuth rate-limit
//     window than worker sessions — 429 may mean probe is rate-limited, NOT that
//     the model bucket is exhausted. Workers succeed even when probe returns 429.
//   • 404 + error.type=not_found_error → model identifier wrong (skip)
//
// One probe per model per cache TTL = 3 × 1-token requests / 60s. Token cost negligible.
//
// Documented 2026-05-01 after Sonnet bucket exhaustion went silent under the
// unified-only metric. See memory entry on per-model token tracking gap.
//
// Exposes getUsage({ force = false, fetchImpl }) which returns:
//   {
//     status, session, weekly, ...legacy fields,
//     models: {
//       sonnet:  { id, utilization, exhausted, status, error },
//       opus_45: { id, utilization, exhausted, status, error },  // claude-opus-4-5
//       opus_47: { id, utilization, exhausted, status, error },  // claude-opus-4-7
//       opus:    <alias for opus_45 — backwards compat>,
//       haiku:   { id, utilization, exhausted, status, error }
//     },
//     fetchedAt, stale?
//   }
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CACHE_TTL_MS = 300_000; // 5 min — reduces probe pressure on OAuth token rate limit

// Anthropic maintains separate per-version quota buckets within a model family.
// opus-4-5 and opus-4-7 are billed from distinct buckets — probe both so
// modelFallbackService can guard against the fallback TARGET (opus-4-5) specifically.
const PROBE_MODELS = [
  { bucket: 'haiku',   id: 'claude-haiku-4-5-20251001' },
  { bucket: 'sonnet',  id: 'claude-sonnet-4-6' },
  { bucket: 'opus_45', id: 'claude-opus-4-5' },
  { bucket: 'opus_47', id: 'claude-opus-4-7' }
];

let _cache = null;
let _cacheTime = 0;
let _inflight = null;

export function _resetCacheForTest() {
  _cache = null;
  _cacheTime = 0;
  _inflight = null;
}

function loadToken() {
  const credsPath = path.join(os.homedir(), '.claude', '.credentials.json');
  if (!fs.existsSync(credsPath)) {
    const e = new Error('No Claude credentials found');
    e.code = 'NO_CREDS';
    throw e;
  }
  const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
  const token = creds.claudeAiOauth?.accessToken;
  if (!token) {
    const e = new Error('No access token in credentials');
    e.code = 'NO_TOKEN';
    throw e;
  }
  return { token, creds };
}

async function probeModel({ id, bucket }, token, fetchImpl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const apiRes = await fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'oauth-2025-04-20',
        'authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        model: id,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }]
      }),
      signal: controller.signal
    });
    clearTimeout(timeout);

    const h = (n) => apiRes.headers.get(n);
    const headers = {
      session: {
        status: h('anthropic-ratelimit-unified-5h-status'),
        utilization: parseFloat(h('anthropic-ratelimit-unified-5h-utilization') || 'NaN'),
        reset: parseInt(h('anthropic-ratelimit-unified-5h-reset') || '0', 10)
      },
      weekly: {
        status: h('anthropic-ratelimit-unified-7d-status'),
        utilization: parseFloat(h('anthropic-ratelimit-unified-7d-utilization') || 'NaN'),
        reset: parseInt(h('anthropic-ratelimit-unified-7d-reset') || '0', 10)
      },
      representativeClaim: h('anthropic-ratelimit-unified-representative-claim'),
      fallbackPercentage: parseFloat(h('anthropic-ratelimit-unified-fallback-percentage') || '0'),
      overageStatus: h('anthropic-ratelimit-unified-overage-status'),
      unifiedStatus: h('anthropic-ratelimit-unified-status') || null
    };
    const has5hUtil = !Number.isNaN(headers.session.utilization);
    const has7dUtil = !Number.isNaN(headers.weekly.utilization);
    const hasUtilization = has5hUtil || has7dUtil;

    if (apiRes.status === 200 && hasUtilization) {
      // Healthy probe: this model bucket is allowed. Use the higher of 5h / 7d
      // as the per-bucket utilization (representative of "how close to wall").
      const util = Math.max(
        Number.isNaN(headers.session.utilization) ? 0 : headers.session.utilization,
        Number.isNaN(headers.weekly.utilization) ? 0 : headers.weekly.utilization
      );
      return {
        bucket, id,
        utilization: util,
        exhausted: false,
        status: 'ok',
        error: null,
        headers
      };
    }

    if (apiRes.status === 429) {
      // The probe uses the main OAuth token which has a separate (more aggressive)
      // rate-limit window than worker Claude Code sessions. A 429 here means the
      // probe itself is throttled — NOT that the model bucket is exhausted.
      // Workers are observed making successful Sonnet/Opus calls during probe 429s.
      // Report as probe_throttled (uncertain) rather than falsely asserting exhaustion.
      // See research: docs/research/usage-probe-fix-options-2026-05-03.md, Option A+B.
      return {
        bucket, id,
        utilization: null,
        exhausted: false,
        status: 'probe_throttled',
        error: 'rate_limit_error',
        headers
      };
    }

    if (apiRes.status === 404) {
      return {
        bucket, id,
        utilization: 0,
        exhausted: false,
        status: 'unknown_model',
        error: 'not_found_error',
        headers
      };
    }

    return {
      bucket, id,
      utilization: 0,
      exhausted: false,
      status: `http_${apiRes.status}`,
      error: null,
      headers
    };
  } catch (err) {
    clearTimeout(timeout);
    return {
      bucket, id,
      utilization: 0,
      exhausted: false,
      status: 'error',
      error: err.name === 'AbortError' ? 'timeout' : (err.message || 'unknown'),
      headers: null
    };
  }
}

/**
 * Returns combined per-model usage. Cached for CACHE_TTL_MS.
 * options.force — bypass cache.
 * options.fetchImpl — inject custom fetch (tests).
 */
export async function getUsage(options = {}) {
  const { force = false, fetchImpl = globalThis.fetch } = options;
  const now = Date.now();
  if (!force && _cache && (now - _cacheTime) < CACHE_TTL_MS) {
    return _cache;
  }
  if (_inflight && !force) return _inflight;

  _inflight = (async () => {
    let token, creds;
    try {
      ({ token, creds } = loadToken());
    } catch (err) {
      throw err;
    }

    const probes = await Promise.all(
      PROBE_MODELS.map(p => probeModel(p, token, fetchImpl))
    );

    // Pick a representative healthy probe to fill legacy session/weekly fields.
    const healthy = probes.find(p => p.status === 'ok');

    const models = {};
    for (const p of probes) {
      models[p.bucket] = {
        id: p.id,
        utilization: p.utilization,
        exhausted: p.exhausted,
        status: p.status,
        error: p.error
      };
    }
    // Backwards-compat alias: models.opus → opus_45 (the Sonnet fallback target).
    // Consumers that predate the per-version split can still read models.opus safely.
    if (models.opus_45) models.opus = models.opus_45;

    let payload;
    if (!healthy) {
      // No probe returned ratelimit headers. Either creds invalid or every probe
      // was throttled. Fall back to stale cache if present, else build graceful payload.
      if (_cache) {
        return { ..._cache, stale: true, fetchedAt: new Date().toISOString(), models };
      }
      const allThrottled = probes.every(p => p.status === 'probe_throttled');
      if (!allThrottled) {
        const e = new Error('No probe returned rate limit headers');
        e.code = 'NO_HEADERS';
        e.probes = probes;
        throw e;
      }
      // All probes throttled — cannot determine bucket state. Return uncertain payload
      // with zero utilization rather than falsely asserting exhaustion.
      payload = {
        status: 'probe_throttled',
        session: { status: 'unknown', utilization: 0, reset: 0 },
        weekly: { status: 'unknown', utilization: 0, reset: 0 },
        representativeClaim: null,
        fallbackPercentage: 0,
        overageStatus: null,
        subscription: creds?.claudeAiOauth?.subscriptionType || 'unknown',
        tier: creds?.claudeAiOauth?.rateLimitTier || 'unknown',
        policy: (process.env.STRATEGOS_USAGE_POLICY || 'unlimited').toLowerCase(),
        models,
        fetchedAt: new Date().toISOString()
      };
    } else {
      payload = {
        status: healthy.headers.unifiedStatus || 'unknown',
        session: {
          status: healthy.headers.session.status,
          utilization: healthy.headers.session.utilization,
          reset: healthy.headers.session.reset
        },
        weekly: {
          status: healthy.headers.weekly.status,
          utilization: healthy.headers.weekly.utilization,
          reset: healthy.headers.weekly.reset
        },
        representativeClaim: healthy.headers.representativeClaim,
        fallbackPercentage: healthy.headers.fallbackPercentage,
        overageStatus: healthy.headers.overageStatus,
        subscription: creds?.claudeAiOauth?.subscriptionType || 'unknown',
        tier: creds?.claudeAiOauth?.rateLimitTier || 'unknown',
        policy: (process.env.STRATEGOS_USAGE_POLICY || 'unlimited').toLowerCase(),
        models,
        fetchedAt: new Date().toISOString()
      };
    }

    _cache = payload;
    _cacheTime = Date.now();
    return payload;
  })().finally(() => { _inflight = null; });

  return _inflight;
}

/**
 * Synchronous read of last cached usage payload (no probing).
 * Returns null if cache is empty or older than maxAgeMs.
 * Used by modelFallbackService at spawn time — never refreshes inline.
 */
export function getCachedUsage(maxAgeMs = 5 * 60_000) {
  if (!_cache) return null;
  if (Date.now() - _cacheTime > maxAgeMs) return null;
  return _cache;
}
