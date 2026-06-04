/**
 * AI proxy routes — /api/ai/stream and /api/ai/complete
 *
 * Authentication: Requires the `X-Strategos-Token` request header to match
 * the `STRATEGOS_AI_TOKEN` environment variable. If the env var is unset,
 * both routes return 503 (fail-closed — no open access). Requests from
 * localhost (127.0.0.1 / ::1) bypass the token check because same-host
 * callers already have full API access.
 *
 * Rate limiting: 20 requests per IP per minute (in-memory, resets every 60s).
 *
 * Input caps: model must be in the allowlist; max_tokens clamped to 4096;
 * messages ≤ 20 items, each ≤ 20 000 chars; system ≤ 10 000 chars.
 */

import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { getLogger } from '../logger.js';

const logger = getLogger('[ai.route]');

const ALLOWED_MODELS = new Set([
  'claude-opus-4-7',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
]);

const MAX_TOKENS_CAP = 4096;
const MAX_MESSAGES = 20;
const MAX_MESSAGE_CHARS = 20_000;
const MAX_SYSTEM_CHARS = 10_000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 20;

// In-memory rate-limit state: ip → { count, windowStart }
const rateLimitMap = new Map();

function getRateLimit(ip) {
  const now = Date.now();
  let entry = rateLimitMap.get(ip);
  if (!entry || now - entry.windowStart >= RATE_LIMIT_WINDOW_MS) {
    entry = { count: 0, windowStart: now };
    rateLimitMap.set(ip, entry);
  }
  return entry;
}

function isLocalhost(req) {
  const ip = req.ip || req.connection?.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function authMiddleware(req, res, next) {
  const token = process.env.STRATEGOS_AI_TOKEN;
  if (!token) {
    return res.status(503).json({ error: 'ai proxy not configured' });
  }
  if (isLocalhost(req)) {
    return next();
  }
  if (req.headers['x-strategos-token'] !== token) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

function rateLimitMiddleware(req, res, next) {
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  const entry = getRateLimit(ip);
  entry.count++;
  if (entry.count > RATE_LIMIT_MAX) {
    const retryAfter = Math.ceil(
      (RATE_LIMIT_WINDOW_MS - (Date.now() - entry.windowStart)) / 1000
    );
    res.set('Retry-After', String(retryAfter));
    return res.status(429).json({ error: 'rate limit exceeded' });
  }
  next();
}

function validateInput(req, res) {
  const { model, system, messages, max_tokens } = req.body;

  if (model !== undefined && !ALLOWED_MODELS.has(model)) {
    res.status(400).json({ error: `model must be one of: ${[...ALLOWED_MODELS].join(', ')}` });
    return null;
  }

  if (system !== undefined) {
    if (typeof system !== 'string' || system.length > MAX_SYSTEM_CHARS) {
      res.status(400).json({ error: `system must be a string ≤ ${MAX_SYSTEM_CHARS} characters` });
      return null;
    }
  }

  if (messages !== undefined) {
    if (!Array.isArray(messages) || messages.length > MAX_MESSAGES) {
      res.status(400).json({ error: `messages must be an array of ≤ ${MAX_MESSAGES} items` });
      return null;
    }
    for (const msg of messages) {
      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content ?? '');
      if (content.length > MAX_MESSAGE_CHARS) {
        res.status(400).json({ error: `each message content must be ≤ ${MAX_MESSAGE_CHARS} characters` });
        return null;
      }
    }
  }

  const resolvedMaxTokens = Math.min(Number(max_tokens) || 512, MAX_TOKENS_CAP);

  return {
    model: model || 'claude-sonnet-4-6',
    messages: messages || [],
    max_tokens: resolvedMaxTokens,
    system,
  };
}

let _client = null;

function getClient() {
  if (!_client) _client = new Anthropic();
  return _client;
}

export function createAiRoutes() {
  const router = express.Router();

  router.use(authMiddleware);
  router.use(rateLimitMiddleware);

  // POST /api/ai/stream — SSE relay to Anthropic streaming API
  router.post('/stream', async (req, res) => {
    const validated = validateInput(req, res);
    if (!validated) return;

    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(503).json({ error: 'llm_unavailable' });
    }

    const { model, messages, max_tokens, system } = validated;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    try {
      const client = getClient();
      const params = { model, messages, max_tokens };
      if (system) params.system = system;

      const stream = client.messages.stream(params);

      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          res.write(`data: ${JSON.stringify({ type: 'content_block_delta', delta: { text: event.delta.text } })}\n\n`);
        }
      }

      res.write(`data: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
      res.end();
    } catch (err) {
      logger.error('Upstream streaming error', { error: err.message ?? String(err) });
      res.write(`data: ${JSON.stringify({ type: 'error', error: 'upstream error' })}\n\n`);
      res.end();
    }
  });

  // POST /api/ai/complete — non-streaming Anthropic completion
  router.post('/complete', async (req, res) => {
    const validated = validateInput(req, res);
    if (!validated) return;

    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(503).json({ error: 'llm_unavailable' });
    }

    const { model, messages, max_tokens, system } = validated;

    try {
      const client = getClient();
      const params = { model, messages, max_tokens };
      if (system) params.system = system;

      const response = await client.messages.create(params);
      const content = response.content[0]?.type === 'text' ? response.content[0].text : '';
      res.json({ content, model: response.model, isMock: false });
    } catch (err) {
      logger.error('Upstream completion error', { error: err.message ?? String(err) });
      res.status(500).json({ error: 'upstream error' });
    }
  });

  return router;
}
