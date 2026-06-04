/**
 * Insights Routes - Token usage and cost analytics
 * Mounted at /api/insights (via routes.js)
 *
 * Endpoints:
 *   GET /api/insights/token-usage - Get token usage aggregates
 */

import express from 'express';
import { getTokenUsageAggregates, getTokenUsageSummary } from '../tokenUsageDb.js';
import { sanitizeErrorMessage } from '../errorUtils.js';

/**
 * GET /api/insights/token-usage
 * Query params:
 *   period: 'hourly' | 'daily' | 'weekly' (default: 'daily')
 *   model: optional model_id filter (e.g., 'glm-4.7')
 *   backend: optional backend filter (e.g., 'claude', 'glm')
 *   limit: optional max rows to return (default varies by period)
 */
function getTokenUsage(req, res) {
  try {
    const { period = 'daily', model, backend, limit } = req.query;

    // Validate period
    if (!['hourly', 'daily', 'weekly'].includes(period)) {
      return res.status(400).json({ error: 'period must be "hourly", "daily", or "weekly"' });
    }

    // Validate limit if provided
    const limitNum = limit !== undefined ? parseInt(limit, 10) : undefined;
    if (limit !== undefined && (isNaN(limitNum) || limitNum < 1 || limitNum > 1000)) {
      return res.status(400).json({ error: 'limit must be a number between 1 and 1000' });
    }

    const aggregates = getTokenUsageAggregates(period, {
      model,
      backend,
      limit: limitNum,
    });

    res.json({ period, count: aggregates.length, data: aggregates });
  } catch (error) {
    res.status(500).json({ error: sanitizeErrorMessage(error) });
  }
}

/**
 * GET /api/insights/token-summary
 * Get overall token usage summary by model
 * Query params:
 *   since: optional ISO timestamp (filter to entries after this time)
 */
function getTokenSummary(req, res) {
  try {
    const { since } = req.query;

    const summary = getTokenUsageSummary({ since });

    res.json(summary);
  } catch (error) {
    res.status(500).json({ error: sanitizeErrorMessage(error) });
  }
}

export function createInsightsRoutes() {
  const router = express.Router();

  router.get('/token-usage', getTokenUsage);
  router.get('/token-summary', getTokenSummary);

  return router;
}

export default createInsightsRoutes;
