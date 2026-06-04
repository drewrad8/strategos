import crypto from 'node:crypto';
import express from 'express';
import { sanitizeErrorMessage } from '../errorUtils.js';
import { getWorkerInternal, updateWorkerRalphStatus } from '../workerManager.js';
import { getLogger } from '../logger.js';

/**
 * Ralph routes for worker completion signaling
 * Base path: /api/ralph
 *
 * PRD/run management endpoints removed 2026-02-12.
 * See: tmp/ralph-prd-engine-evaluation.md
 */

/**
 * Validate and normalize signal body fields.
 * Returns { error: string } on failure, or { signalData } on success.
 */
function validateSignalBody(body) {
  const { status = 'done', progress, currentStep, reason, learnings, outputs, artifacts, inputTokens, outputTokens, totalCost, modelId } = body;

  // Accept "completed" as alias for "done" (workers frequently use the wrong term)
  const normalizedStatus = status === 'completed' ? 'done' : status;
  if (!['in_progress', 'done', 'blocked', 'held'].includes(normalizedStatus)) {
    return { error: 'status must be "in_progress", "done", "completed", "blocked", or "held"' };
  }

  // Validate progress range if provided
  if (progress !== undefined && (typeof progress !== 'number' || progress < 0 || progress > 100)) {
    return { error: 'progress must be a number between 0 and 100' };
  }

  // Validate string fields — cap sizes to prevent data amplification
  const MAX_SIGNAL_FIELD = 2000;
  if (currentStep !== undefined && (typeof currentStep !== 'string' || currentStep.length > MAX_SIGNAL_FIELD)) {
    return { error: `currentStep must be a string (max ${MAX_SIGNAL_FIELD} chars)` };
  }
  if (reason !== undefined && (typeof reason !== 'string' || reason.length > MAX_SIGNAL_FIELD)) {
    return { error: `reason must be a string (max ${MAX_SIGNAL_FIELD} chars)` };
  }
  if (learnings !== undefined && (typeof learnings !== 'string' || learnings.length > 10000)) {
    return { error: 'learnings must be a string (max 10000 chars)' };
  }

  // Validate structured outputs — must be object with bounded values
  if (outputs !== undefined) {
    if (typeof outputs !== 'object' || outputs === null || Array.isArray(outputs)) {
      return { error: 'outputs must be a plain object' };
    }
    const keys = Object.keys(outputs);
    if (keys.length > 50) {
      return { error: 'outputs must have at most 50 keys' };
    }
    for (const key of keys) {
      if (key.length > 200) {
        return { error: 'outputs key names must be under 200 characters' };
      }
      const val = outputs[key];
      if (typeof val === 'string' && val.length > 10000) {
        return { error: `outputs["${key.slice(0, 50)}"] exceeds max value length (10KB)` };
      }
    }
  }

  // Validate artifacts — must be array of strings
  if (artifacts !== undefined) {
    if (!Array.isArray(artifacts) || artifacts.length > 100) {
      return { error: 'artifacts must be an array (max 100 items)' };
    }
    if (!artifacts.every(a => typeof a === 'string' && a.length <= 500)) {
      return { error: 'each artifact must be a string (max 500 chars)' };
    }
  }

  // Validate token fields — all optional, but must be correct type if present
  if (inputTokens !== undefined && (typeof inputTokens !== 'number' || inputTokens < 0)) {
    return { error: 'inputTokens must be a non-negative number' };
  }
  if (outputTokens !== undefined && (typeof outputTokens !== 'number' || outputTokens < 0)) {
    return { error: 'outputTokens must be a non-negative number' };
  }
  if (totalCost !== undefined && (typeof totalCost !== 'number' || totalCost < 0)) {
    return { error: 'totalCost must be a non-negative number' };
  }
  if (modelId !== undefined && (typeof modelId !== 'string' || modelId.length > 100)) {
    return { error: 'modelId must be a string (max 100 chars)' };
  }

  return {
    signalData: { status: normalizedStatus, progress, currentStep, reason, learnings, outputs, artifacts, inputTokens, outputTokens, totalCost, modelId }
  };
}

export function createRalphRoutes(ralphService) {
  const router = express.Router();

  /**
   * POST /api/ralph/signal/:token
   * Signal status from a worker using completion token (legacy path).
   * The by-worker/:workerId route below is preferred.
   */
  router.post('/signal/:token', async (req, res) => {
    try {
      const { token } = req.params;

      // Validate token format (32-char hex from crypto.randomBytes(16))
      if (!/^[a-f0-9]{32}$/.test(token)) {
        return res.status(400).json({ error: 'Invalid token format' });
      }

      const validation = validateSignalBody(req.body);
      if (validation.error) {
        return res.status(400).json({ error: validation.error });
      }

      // Cat E: soft-warn when done signal omits learnings — degrades feedback loop quality
      if (validation.signalData.status === 'done' && !validation.signalData.learnings) {
        getLogger().warn('[Ralph] done signal received without learnings field — feedback loop degraded', { token: token.slice(0, 8) });
      }

      const result = await ralphService.handleCompletionSignal(token, validation.signalData);

      if (!result) {
        return res.status(404).json({ error: 'Unknown completion token' });
      }

      // Persistent worker tried to signal done — return the rejection message so it knows to continue
      if (result.rejected) {
        return res.status(200).json({ success: false, rejected: true, message: result.message });
      }

      res.json({ success: true, message: `Status updated to ${validation.signalData.status}`, progress: validation.signalData.progress });
    } catch (error) {
      res.status(500).json({ error: sanitizeErrorMessage(error) });
    }
  });

  /**
   * POST /api/ralph/signal/by-worker/:workerId
   * Signal status using worker ID directly — primary signaling path.
   * Skips token lookup and calls updateWorkerRalphStatus directly.
   */
  router.post('/signal/by-worker/:workerId', async (req, res) => {
    try {
      const { workerId } = req.params;

      // Validate worker ID format (8-char hex)
      if (!/^[a-f0-9]{8}$/.test(workerId)) {
        return res.status(400).json({ error: 'Invalid worker ID format' });
      }

      const worker = getWorkerInternal(workerId);
      if (!worker) {
        return res.status(404).json({ error: 'Resource not found' });
      }

      if (!worker.ralphToken) {
        return res.status(400).json({ error: 'Worker does not have Ralph mode enabled' });
      }

      // Identity verification: prefer X-Ralph-Token header, fall back to body field (legacy)
      const headerToken = req.headers['x-ralph-token'];
      const bodyToken = typeof req.body?.ralphToken === 'string' ? req.body.ralphToken : undefined;

      let providedToken;
      if (headerToken !== undefined) {
        providedToken = headerToken;
      } else if (bodyToken !== undefined) {
        getLogger().warn(`[Ralph] Worker ${workerId} sent ralphToken in body — use X-Ralph-Token header instead`, { workerId });
        providedToken = bodyToken;
      } else {
        return res.status(403).json({ error: 'ralph token mismatch' });
      }

      const expected = worker.ralphToken;
      const maxLen = Math.max(providedToken.length, expected.length, 1);
      const bufA = Buffer.alloc(maxLen);
      const bufB = Buffer.alloc(maxLen);
      bufA.write(providedToken);
      bufB.write(expected);
      if (!crypto.timingSafeEqual(bufA, bufB) || providedToken.length !== expected.length) {
        return res.status(403).json({ error: 'ralph token mismatch' });
      }

      const validation = validateSignalBody(req.body);
      if (validation.error) {
        return res.status(400).json({ error: validation.error });
      }

      // Cat E: soft-warn when done signal omits learnings — degrades feedback loop quality
      if (validation.signalData.status === 'done' && !validation.signalData.learnings) {
        getLogger().warn(`[Ralph] Worker ${workerId} (${worker.label}) signaled done without learnings — feedback loop degraded`, { workerId, label: worker.label });
      }

      // Call updateWorkerRalphStatus directly — skip token roundtrip
      const result = updateWorkerRalphStatus(workerId, validation.signalData, ralphService.io);

      if (!result) {
        return res.status(500).json({ error: 'Signal handling failed' });
      }

      // Persistent worker tried to signal done — return the rejection message so it knows to continue
      if (result.rejected) {
        return res.status(200).json({ success: false, rejected: true, message: result.message });
      }

      res.json({ success: true, message: `Status updated to ${validation.signalData.status}`, progress: validation.signalData.progress });
    } catch (error) {
      res.status(500).json({ error: sanitizeErrorMessage(error) });
    }
  });

  return router;
}

export default createRalphRoutes;
