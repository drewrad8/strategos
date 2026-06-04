/**
 * Learnings Feedback Routes
 *
 * POST /api/learnings/feedback-sync  — triggers distillation and writes template-overrides.json
 * GET  /api/learnings/feedback-status — returns when feedback was last synced and what was written
 */

import express from 'express';
import { runFeedbackSync, getFeedbackStatus } from '../services/learningsFeedbackService.js';
import { runReflexionFeedbackSync, getReflexionFeedbackStatus } from '../services/reflexionFeedbackService.js';
import { sanitizeErrorMessage } from '../errorUtils.js';

export function createLearningsRoutes() {
  const router = express.Router();

  /**
   * POST /api/learnings/feedback-sync
   * Distills successful learnings from the last 7 days and writes
   * append_to_mission into template-overrides.json for each template type.
   */
  router.post('/feedback-sync', (req, res) => {
    try {
      const result = runFeedbackSync();
      res.json({
        ok: true,
        syncedAt: result.syncedAt,
        overridesPath: result.overridesPath,
        perType: result.perType,
      });
    } catch (err) {
      res.status(500).json({ error: sanitizeErrorMessage(err.message) });
    }
  });

  /**
   * GET /api/learnings/feedback-status
   * Returns the last sync timestamp and per-type append_to_mission content.
   */
  router.get('/feedback-status', (req, res) => {
    try {
      const status = getFeedbackStatus();
      res.json({
        ok: true,
        syncedAt: status.syncedAt,
        overridesPath: status.overridesPath,
        perType: status.perType,
      });
    } catch (err) {
      res.status(500).json({ error: sanitizeErrorMessage(err.message) });
    }
  });

  /**
   * POST /api/learnings/reflexion-feedback-sync
   * Distills avoidNextTime bullets from failure_reflections (last 14 days) and writes
   * failure_warnings into template-overrides.json for each template type.
   */
  router.post('/reflexion-feedback-sync', (req, res) => {
    try {
      const result = runReflexionFeedbackSync();
      res.json({
        ok: true,
        syncedAt: result.syncedAt,
        overridesPath: result.overridesPath,
        perType: result.perType,
      });
    } catch (err) {
      res.status(500).json({ error: sanitizeErrorMessage(err.message) });
    }
  });

  /**
   * GET /api/learnings/reflexion-feedback-status
   * Returns the last reflexion sync timestamp and per-type failure_warnings content.
   */
  router.get('/reflexion-feedback-status', (req, res) => {
    try {
      const status = getReflexionFeedbackStatus();
      res.json({
        ok: true,
        syncedAt: status.syncedAt,
        overridesPath: status.overridesPath,
        perType: status.perType,
      });
    } catch (err) {
      res.status(500).json({ error: sanitizeErrorMessage(err.message) });
    }
  });

  return router;
}
