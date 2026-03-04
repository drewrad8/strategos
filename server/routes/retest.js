/**
 * Retest Routes - Auto-retest system trigger and run management
 * Base path: /api/retest
 */

import express from 'express';
import { sanitizeErrorMessage } from '../errorUtils.js';

const VALID_MODES = ['auto', 'manual', 'full'];

export function createRetestRoutes(retestService) {
  const router = express.Router();

  // POST /api/retest/trigger - Trigger a retest run
  router.post('/trigger', async (req, res) => {
    try {
      const { mode, files, specs, ref } = req.body;

      if (!mode || !VALID_MODES.includes(mode)) {
        return res.status(400).json({ error: `mode must be one of: ${VALID_MODES.join(', ')}` });
      }

      if (files !== undefined && !Array.isArray(files)) {
        return res.status(400).json({ error: 'files must be an array of strings' });
      }

      if (specs !== undefined && !Array.isArray(specs)) {
        return res.status(400).json({ error: 'specs must be an array of strings' });
      }

      if (files && !files.every(f => typeof f === 'string')) {
        return res.status(400).json({ error: 'files must contain only strings' });
      }

      if (specs && !specs.every(s => typeof s === 'string')) {
        return res.status(400).json({ error: 'specs must contain only strings' });
      }

      const run = await retestService.triggerRetest({ mode, files, specs, ref });
      res.status(201).json(run);
    } catch (error) {
      res.status(500).json({ error: sanitizeErrorMessage(error) });
    }
  });

  // GET /api/retest/runs - List recent retest runs
  router.get('/runs', async (req, res) => {
    try {
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
      const runs = await retestService.getRuns(limit);
      res.json(runs);
    } catch (error) {
      res.status(500).json({ error: sanitizeErrorMessage(error) });
    }
  });

  // POST /api/retest/runs/:runId/cancel - Cancel a running retest run
  router.post('/runs/:runId/cancel', (req, res) => {
    try {
      const result = retestService.cancelRun(req.params.runId);
      if (!result.success) {
        return res.status(400).json({ error: result.message });
      }
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: sanitizeErrorMessage(error) });
    }
  });

  // GET /api/retest/runs/:runId - Get single run detail
  router.get('/runs/:runId', async (req, res) => {
    try {
      const run = await retestService.getRun(req.params.runId);
      if (!run) {
        return res.status(404).json({ error: 'Run not found' });
      }
      res.json(run);
    } catch (error) {
      res.status(500).json({ error: sanitizeErrorMessage(error) });
    }
  });

  return router;
}
