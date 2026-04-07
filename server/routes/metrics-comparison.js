/**
 * Metrics Comparison Routes - Baseline snapshots and before/after comparison
 * Mounted at /api/metrics (via routes.js)
 *
 * Endpoints:
 *   GET  /api/metrics/snapshot    - Read current baseline snapshot
 *   POST /api/metrics/snapshot    - Capture a new baseline snapshot
 *   GET  /api/metrics/comparison  - Compare current metrics against baseline
 */

import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getSummaryStats, getLearnings } from '../learningsDb.js';
import { sanitizeErrorMessage } from '../errorUtils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = path.join(__dirname, '..', 'metrics-baseline.json');

/**
 * Query learnings DB and compute aggregate metrics.
 * If afterTimestamp is provided, only includes entries created after that time.
 */
function computeMetrics(afterTimestamp) {
  // Get all learnings (up to 90 days, the DB auto-cleanup window).
  // Apply the R1 infrastructure filter: exclude test scaffold workers (e.g. "IMPL: TEST: ...")
  // and orphaned infrastructure artifacts (no task description AND no parent worker).
  // This matches the filter used by getSummaryStats() so baseline snapshots reflect real work only.
  const allLearnings = getLearnings(null, 90).filter(l =>
    !(l.label && l.label.includes(': TEST: ')) &&
    !(l.taskDescription == null && l.parentWorkerId == null)
  );

  // Filter by timestamp if needed
  const entries = afterTimestamp
    ? allLearnings.filter(l => l.timestamp > afterTimestamp)
    : allLearnings;

  if (entries.length === 0) {
    return {
      totalWorkers: 0,
      byType: {},
      overallSuccessRate: null,
      overallAvgUptime: null,
      effortDistribution: {},
    };
  }

  // Group by template type
  const byType = {};
  let totalSuccess = 0;
  let totalWithStatus = 0;
  let totalUptime = 0;
  let uptimeCount = 0;
  const effortCounts = {};

  for (const entry of entries) {
    const type = entry.templateType || 'unknown';

    if (!byType[type]) {
      byType[type] = { total: 0, successes: 0, failures: 0, successRate: null, avgUptime: null, uptimeSum: 0, uptimeCount: 0 };
    }

    byType[type].total++;

    if (entry.success === 1) {
      byType[type].successes++;
      totalSuccess++;
      totalWithStatus++;
    } else if (entry.success === 0) {
      byType[type].failures++;
      totalWithStatus++;
    }

    if (entry.uptime != null && entry.uptime > 0) {
      byType[type].uptimeSum += entry.uptime;
      byType[type].uptimeCount++;
      totalUptime += entry.uptime;
      uptimeCount++;
    }

    if (entry.effortLevel) {
      effortCounts[entry.effortLevel] = (effortCounts[entry.effortLevel] || 0) + 1;
    }
  }

  // Compute rates
  for (const type of Object.keys(byType)) {
    const t = byType[type];
    const withStatus = t.successes + t.failures;
    t.successRate = withStatus > 0 ? t.successes / withStatus : null;
    t.avgUptime = t.uptimeCount > 0 ? Math.round(t.uptimeSum / t.uptimeCount) : null;
    // Clean up internal fields
    delete t.uptimeSum;
    delete t.uptimeCount;
  }

  return {
    totalWorkers: entries.length,
    byType,
    overallSuccessRate: totalWithStatus > 0 ? totalSuccess / totalWithStatus : null,
    overallAvgUptime: uptimeCount > 0 ? Math.round(totalUptime / uptimeCount) : null,
    effortDistribution: effortCounts,
  };
}

/**
 * Read the saved baseline from disk.
 * Returns null if no baseline exists.
 */
function readBaseline() {
  try {
    if (!fs.existsSync(BASELINE_PATH)) return null;
    return JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Save a baseline snapshot to disk.
 */
function writeBaseline(snapshot) {
  fs.writeFileSync(BASELINE_PATH, JSON.stringify(snapshot, null, 2), 'utf8');
}

/**
 * Compute deltas between baseline and current metrics.
 */
function computeComparison(baseline, current) {
  const delta = (curr, base) => {
    if (curr == null || base == null) return null;
    return curr - base;
  };

  const comparison = {
    baseline: {
      capturedAt: baseline.capturedAt,
      metrics: baseline.metrics,
    },
    current: {
      capturedAt: new Date().toISOString(),
      afterTimestamp: baseline.capturedAt,
      metrics: current,
    },
    deltas: {
      overallSuccessRate: delta(current.overallSuccessRate, baseline.metrics.overallSuccessRate),
      overallAvgUptime: delta(current.overallAvgUptime, baseline.metrics.overallAvgUptime),
      totalWorkers: {
        baseline: baseline.metrics.totalWorkers,
        current: current.totalWorkers,
      },
    },
    byType: {},
    effortDistribution: {
      baseline: baseline.metrics.effortDistribution || {},
      current: current.effortDistribution || {},
    },
    warnings: [],
  };

  // Per-type deltas
  const allTypes = new Set([
    ...Object.keys(baseline.metrics.byType || {}),
    ...Object.keys(current.byType || {}),
  ]);

  for (const type of allTypes) {
    const base = baseline.metrics.byType?.[type] || {};
    const curr = current.byType?.[type] || {};

    comparison.byType[type] = {
      baseline: { total: base.total || 0, successRate: base.successRate, avgUptime: base.avgUptime },
      current: { total: curr.total || 0, successRate: curr.successRate, avgUptime: curr.avgUptime },
      deltas: {
        successRate: delta(curr.successRate, base.successRate),
        avgUptime: delta(curr.avgUptime, base.avgUptime),
      },
      sampleSize: curr.total || 0,
    };
  }

  // Statistical warnings
  if (current.totalWorkers < 10) {
    comparison.warnings.push(
      `Low sample size: only ${current.totalWorkers} workers since baseline (need >= 10 for meaningful comparison)`
    );
  }

  for (const type of allTypes) {
    const curr = current.byType?.[type];
    if (curr && curr.total < 10) {
      comparison.warnings.push(
        `Low sample for type "${type}": ${curr.total} workers (need >= 10)`
      );
    }
  }

  return comparison;
}

export function createMetricsComparisonRoutes() {
  const router = express.Router();

  // GET /api/metrics/snapshot - Read current baseline
  router.get('/snapshot', (req, res) => {
    try {
      const baseline = readBaseline();
      if (!baseline) {
        return res.json({ exists: false, message: 'No baseline snapshot found. POST to /api/metrics/snapshot to create one.' });
      }
      res.json({ exists: true, ...baseline });
    } catch (error) {
      res.status(500).json({ error: sanitizeErrorMessage(error) });
    }
  });

  // POST /api/metrics/snapshot - Capture new baseline
  router.post('/snapshot', (req, res) => {
    try {
      const metrics = computeMetrics(null);
      const snapshot = {
        capturedAt: new Date().toISOString(),
        metrics,
      };
      writeBaseline(snapshot);
      res.json({
        success: true,
        message: 'Baseline snapshot captured',
        ...snapshot,
      });
    } catch (error) {
      res.status(500).json({ error: sanitizeErrorMessage(error) });
    }
  });

  // GET /api/metrics/comparison - Compare current vs baseline
  router.get('/comparison', (req, res) => {
    try {
      const baseline = readBaseline();
      if (!baseline) {
        return res.status(404).json({
          error: 'No baseline snapshot found. POST to /api/metrics/snapshot first to capture a baseline.',
        });
      }

      // Query only entries created after the baseline timestamp
      const currentMetrics = computeMetrics(baseline.capturedAt);
      const comparison = computeComparison(baseline, currentMetrics);

      res.json(comparison);
    } catch (error) {
      res.status(500).json({ error: sanitizeErrorMessage(error) });
    }
  });

  return router;
}
