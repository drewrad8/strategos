import express from 'express';
import { sanitizeErrorMessage } from '../errorUtils.js';
import { getWorkerInternal } from '../workerManager.js';

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
  const { status = 'done', progress, currentStep, reason, learnings, outputs, artifacts } = body;

  // Accept "completed" as alias for "done" (workers frequently use the wrong term)
  const normalizedStatus = status === 'completed' ? 'done' : status;
  if (!['in_progress', 'done', 'blocked'].includes(normalizedStatus)) {
    return { error: 'status must be "in_progress", "done", "completed", or "blocked"' };
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

  return {
    signalData: { status: normalizedStatus, progress, currentStep, reason, learnings, outputs, artifacts }
  };
}

export function createRalphRoutes(ralphService) {
  const router = express.Router();

  /**
   * POST /api/ralph/signal/:token
   * Signal status from a worker (progress, completion, or blocked)
   * Workers call this endpoint to signal their status
   *
   * Body:
   *   - status: 'in_progress' | 'done' | 'blocked' (required)
   *   - progress: number 0-100 (optional, for in_progress)
   *   - currentStep: string (optional, describes current activity)
   *   - reason: string (optional, for blocked status)
   *   - learnings: string (optional, summary/notes)
   *   - outputs: object (optional, structured outputs { key: value })
   *   - artifacts: array (optional, file paths created)
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

      const result = await ralphService.handleCompletionSignal(token, validation.signalData);

      if (!result) {
        return res.status(404).json({ error: 'Unknown completion token' });
      }

      res.json({ success: true, message: `Status updated to ${validation.signalData.status}`, progress: validation.signalData.progress });
    } catch (error) {
      res.status(500).json({ error: sanitizeErrorMessage(error) });
    }
  });

  /**
   * POST /api/ralph/signal/by-worker/:workerId
   * Signal status using worker ID instead of ralph token.
   * Looks up the worker's ralph token and forwards to the signal handler.
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

      // Ensure token is registered (may be lost after server restart)
      ralphService.registerStandaloneWorker(worker.ralphToken, workerId);

      const validation = validateSignalBody(req.body);
      if (validation.error) {
        return res.status(400).json({ error: validation.error });
      }

      const result = await ralphService.handleCompletionSignal(worker.ralphToken, validation.signalData);

      if (!result) {
        return res.status(500).json({ error: 'Signal handling failed' });
      }

      res.json({ success: true, message: `Status updated to ${validation.signalData.status}`, progress: validation.signalData.progress });
    } catch (error) {
      res.status(500).json({ error: sanitizeErrorMessage(error) });
    }
  });

  return router;
}

export default createRalphRoutes;
