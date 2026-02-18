/**
 * Settings Routes - Application-level settings
 * Base path: /api/settings
 */

import express from 'express';
import {
  getSummariesEnabled,
  setSummariesEnabled
} from '../summaryService.js';
import { sanitizeErrorMessage } from '../errorUtils.js';

export function createSettingsRoutes() {
  const router = express.Router();

  // GET /api/settings/summaries - Get summaries enabled state
  router.get('/summaries', (req, res) => {
    try {
      res.json({ enabled: getSummariesEnabled() });
    } catch (error) {
      res.status(500).json({ error: sanitizeErrorMessage(error) });
    }
  });

  // POST /api/settings/summaries - Set summaries enabled state
  router.post('/summaries', (req, res) => {
    try {
      const { enabled } = req.body;
      if (typeof enabled !== 'boolean') {
        return res.status(400).json({ error: 'enabled (boolean) is required' });
      }
      const newState = setSummariesEnabled(enabled);
      res.json({ enabled: newState });
    } catch (error) {
      res.status(500).json({ error: sanitizeErrorMessage(error) });
    }
  });

  return router;
}
