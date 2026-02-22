/**
 * Metrics Service for Strategos
 *
 * Captures time and efficiency metrics to measure impact of AI improvements.
 * Tracks worker lifecycle, error rates, circuit breaker status, and performance.
 *
 * Metrics are stored in SQLite for persistence across restarts.
 */

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { DB_JOURNAL_SIZE_LIMIT, DB_BUSY_TIMEOUT } from './validation.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ============================================
// METRIC TYPES
// ============================================

export const MetricTypes = {
  WORKER_SPAWN_TIME: 'worker_spawn_time',       // Recorded in workerManager.js via recordWorkerSpawn
};

// ============================================
// METRICS SERVICE
// ============================================

class MetricsService {
  constructor(dbPath = null) {
    this.dbPath = dbPath || path.join(__dirname, 'metrics.db');
    this.db = null;
    this.inMemoryMetrics = new Map(); // For real-time metrics
    this.timers = new Map(); // For timing operations
    this.aggregationInterval = null;
    this._aggregationCount = 0; // Track cycles for periodic cleanup

    this._initDatabase();
    this._startAggregation();
  }

  // ============================================
  // DATABASE SETUP
  // ============================================

  _initDatabase() {
    this.db = new Database(this.dbPath);

    // Enable WAL mode for concurrent reads during writes
    this.db.pragma('journal_mode = WAL');
    this.db.pragma(`journal_size_limit = ${DB_JOURNAL_SIZE_LIMIT}`);
    this.db.pragma(`busy_timeout = ${DB_BUSY_TIMEOUT}`);

    // Create metrics table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        value REAL NOT NULL,
        labels TEXT,
        timestamp TEXT NOT NULL,
        session_id TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_metrics_type ON metrics(type);
      CREATE INDEX IF NOT EXISTS idx_metrics_timestamp ON metrics(timestamp);
      CREATE INDEX IF NOT EXISTS idx_metrics_session ON metrics(session_id);
      CREATE INDEX IF NOT EXISTS idx_metrics_type_timestamp ON metrics(type, timestamp);

      -- Aggregated metrics table (hourly summaries)
      CREATE TABLE IF NOT EXISTS metrics_aggregated (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        period_start TEXT NOT NULL,
        period_end TEXT NOT NULL,
        count INTEGER NOT NULL,
        sum REAL NOT NULL,
        min REAL NOT NULL,
        max REAL NOT NULL,
        avg REAL NOT NULL,
        p50 REAL,
        p95 REAL,
        p99 REAL,
        labels TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_agg_type ON metrics_aggregated(type);
      CREATE INDEX IF NOT EXISTS idx_agg_period ON metrics_aggregated(period_start);

      -- Sessions table for tracking test runs
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        start_time TEXT NOT NULL,
        end_time TEXT,
        description TEXT,
        metadata TEXT
      );
    `);

    // Prepare statements for performance
    this._stmts = {
      insertMetric: this.db.prepare(`
        INSERT INTO metrics (type, value, labels, timestamp, session_id)
        VALUES (?, ?, ?, ?, ?)
      `),
      getMetrics: this.db.prepare(`
        SELECT * FROM metrics
        WHERE type = ? AND timestamp >= ? AND timestamp <= ?
        ORDER BY timestamp DESC
        LIMIT ?
      `),
      getLatestMetric: this.db.prepare(`
        SELECT * FROM metrics WHERE type = ? ORDER BY timestamp DESC LIMIT 1
      `),
      insertSession: this.db.prepare(`
        INSERT INTO sessions (id, start_time, description, metadata)
        VALUES (?, ?, ?, ?)
      `),
      endSession: this.db.prepare(`
        UPDATE sessions SET end_time = ? WHERE id = ?
      `),
      // getSummary queries (called every 5s by metrics subscribers + every 5min by aggregation)
      getSummaryStats: this.db.prepare(`
        SELECT
          COUNT(*) as count,
          SUM(value) as sum,
          AVG(value) as avg,
          MIN(value) as min,
          MAX(value) as max
        FROM metrics
        WHERE type = ? AND timestamp >= ? AND timestamp <= ?
      `),
      getSummaryValues: this.db.prepare(`
        SELECT value FROM metrics
        WHERE type = ? AND timestamp >= ? AND timestamp <= ?
        ORDER BY value
        LIMIT 10000
      `),
      // Aggregation INSERT (called every 5min per metric type)
      insertAggregated: this.db.prepare(`
        INSERT INTO metrics_aggregated
        (type, period_start, period_end, count, sum, min, max, avg, p50, p95, p99)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      // Cleanup queries (called hourly)
      cleanupMetrics: this.db.prepare(`DELETE FROM metrics WHERE timestamp < ?`),
      cleanupAggregated: this.db.prepare(`DELETE FROM metrics_aggregated WHERE period_end < ?`),
      cleanupSessions: this.db.prepare(`DELETE FROM sessions WHERE start_time < ?`),
      // Session query (on API request)
      getSession: this.db.prepare(`SELECT * FROM sessions WHERE id = ?`),
      getSessionMetrics: this.db.prepare(`
        SELECT type, value, labels, timestamp
        FROM metrics
        WHERE session_id = ?
        ORDER BY timestamp
        LIMIT 50000
      `)
    };
  }

  // ============================================
  // CORE METRICS API
  // ============================================

  /**
   * Record a metric value
   * @param {string} type - Metric type from MetricTypes
   * @param {number} value - Metric value
   * @param {Object} labels - Optional labels/dimensions
   * @param {string} sessionId - Optional session ID
   */
  record(type, value, labels = {}, sessionId = null) {
    const timestamp = new Date().toISOString();
    const labelsJson = Object.keys(labels).length > 0 ? JSON.stringify(labels) : null;

    // Store in database
    this._stmts.insertMetric.run(type, value, labelsJson, timestamp, sessionId);

    // Update in-memory for real-time access
    if (!this.inMemoryMetrics.has(type)) {
      this.inMemoryMetrics.set(type, []);
    }
    const metrics = this.inMemoryMetrics.get(type);
    metrics.push({ value, labels, timestamp });

    // Keep only last 1000 in memory
    if (metrics.length > 1000) {
      metrics.shift();
    }
  }

  /**
   * Start a timer for measuring duration
   * @param {string} name - Timer name
   * @returns {string} - Timer ID
   */
  startTimer(name) {
    const timerId = `${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    this.timers.set(timerId, {
      name,
      startTime: process.hrtime.bigint(),
      startTimestamp: new Date().toISOString()
    });
    return timerId;
  }

  /**
   * End a timer and record the duration
   * @param {string} timerId - Timer ID from startTimer
   * @param {Object} labels - Optional labels
   * @param {string} sessionId - Optional session ID
   * @returns {number} - Duration in milliseconds
   */
  endTimer(timerId, labels = {}, sessionId = null) {
    const timer = this.timers.get(timerId);
    if (!timer) {
      console.warn(`Timer ${timerId} not found`);
      return 0;
    }

    const endTime = process.hrtime.bigint();
    const durationNs = endTime - timer.startTime;
    const durationMs = Number(durationNs) / 1_000_000;

    this.record(timer.name, durationMs, labels, sessionId);
    this.timers.delete(timerId);

    return durationMs;
  }

  /**
   * Increment a counter metric
   * @param {string} type - Metric type
   * @param {number} increment - Amount to increment (default 1)
   * @param {Object} labels - Optional labels
   */
  increment(type, increment = 1, labels = {}, sessionId = null) {
    this.record(type, increment, labels, sessionId);
  }

  // ============================================
  // QUERY API
  // ============================================

  /**
   * Get metrics for a specific type and time range
   */
  getMetrics(type, startTime, endTime, limit = 1000) {
    return this._stmts.getMetrics.all(type, startTime, endTime, limit);
  }

  /**
   * Get the latest metric for a type
   */
  getLatest(type) {
    return this._stmts.getLatestMetric.get(type);
  }

  /**
   * Get summary statistics for a metric type
   */
  getSummary(type, startTime = null, endTime = null) {
    const start = startTime || new Date(Date.now() - 3600000).toISOString(); // Last hour
    const end = endTime || new Date().toISOString();

    const stats = this._stmts.getSummaryStats.get(type, start, end);

    // Calculate percentiles (capped at 10k rows to prevent OOM)
    const values = this._stmts.getSummaryValues.all(type, start, end).map(r => r.value);

    const percentile = (arr, p) => {
      if (arr.length === 0) return null;
      const idx = Math.ceil(arr.length * p) - 1;
      return arr[Math.max(0, idx)];
    };

    return {
      ...stats,
      p50: percentile(values, 0.5),
      p95: percentile(values, 0.95),
      p99: percentile(values, 0.99),
      startTime: start,
      endTime: end
    };
  }

  /**
   * Get real-time metrics from memory
   */
  getRealtime(type) {
    return this.inMemoryMetrics.get(type) || [];
  }

  /**
   * Get all current metric summaries
   */
  getAllSummaries(periodMinutes = 60) {
    const startTime = new Date(Date.now() - periodMinutes * 60000).toISOString();
    const summaries = {};

    for (const type of Object.values(MetricTypes)) {
      summaries[type] = this.getSummary(type, startTime);
    }

    return {
      summaries,
      period: `${periodMinutes} minutes`,
      generatedAt: new Date().toISOString()
    };
  }

  // ============================================
  // SESSION MANAGEMENT
  // ============================================

  /**
   * Start a new metrics session (e.g., for a test run)
   */
  startSession(description = '', metadata = {}) {
    const id = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this._stmts.insertSession.run(
      id,
      new Date().toISOString(),
      description,
      JSON.stringify(metadata)
    );
    return id;
  }

  /**
   * End a metrics session
   */
  endSession(sessionId) {
    this._stmts.endSession.run(new Date().toISOString(), sessionId);
  }

  /**
   * Get metrics for a specific session
   */
  getSessionMetrics(sessionId) {
    const session = this._stmts.getSession.get(sessionId);

    if (!session) {
      return null;
    }

    const metrics = this._stmts.getSessionMetrics.all(sessionId);

    // Group by type — parse labels from JSON string back to object
    const byType = {};
    for (const m of metrics) {
      if (!byType[m.type]) {
        byType[m.type] = [];
      }
      if (m.labels && typeof m.labels === 'string') {
        try { m.labels = JSON.parse(m.labels); } catch { m.labels = {}; }
      }
      byType[m.type].push(m);
    }

    // Calculate summaries per type
    const summaries = {};
    for (const [type, values] of Object.entries(byType)) {
      const nums = values.map(v => v.value);
      // Use reduce instead of Math.min/max(...nums) — spread throws RangeError for >65k items
      let min = Infinity, max = -Infinity, sum = 0;
      for (const n of nums) {
        if (n < min) min = n;
        if (n > max) max = n;
        sum += n;
      }
      summaries[type] = {
        count: nums.length,
        sum,
        avg: sum / nums.length,
        min: nums.length > 0 ? min : null,
        max: nums.length > 0 ? max : null
      };
    }

    return {
      session,
      metrics: byType,
      summaries
    };
  }

  /**
   * Compare two sessions
   */
  compareSessions(sessionId1, sessionId2) {
    const s1 = this.getSessionMetrics(sessionId1);
    const s2 = this.getSessionMetrics(sessionId2);

    if (!s1 || !s2) {
      return null;
    }

    const comparison = {};
    const allTypes = new Set([
      ...Object.keys(s1.summaries),
      ...Object.keys(s2.summaries)
    ]);

    for (const type of allTypes) {
      const v1 = s1.summaries[type] || { avg: 0, count: 0 };
      const v2 = s2.summaries[type] || { avg: 0, count: 0 };

      const improvement = v1.avg > 0 ? ((v1.avg - v2.avg) / v1.avg) * 100 : 0;

      comparison[type] = {
        session1: v1,
        session2: v2,
        improvement: improvement.toFixed(2) + '%',
        improved: v2.avg < v1.avg // Lower is better for timing metrics
      };
    }

    return {
      session1: s1.session,
      session2: s2.session,
      comparison
    };
  }

  // ============================================
  // AGGREGATION
  // ============================================

  _startAggregation() {
    // Run aggregation every 5 minutes
    this.aggregationInterval = setInterval(() => {
      try {
        this._aggregate();
      } catch (err) {
        console.error(`[MetricsService] Aggregation failed: ${err.message}`);
      }
      // Checkpoint WAL after aggregation to prevent unbounded WAL growth.
      // Use PASSIVE first (non-blocking), escalate to RESTART if too many pages remain.
      try {
        const walResult = this.db.pragma('wal_checkpoint(PASSIVE)');
        const walInfo = walResult[0];
        if (walInfo && walInfo.log > 1000 && walInfo.checkpointed < walInfo.log) {
          this.db.pragma('wal_checkpoint(RESTART)');
        }
      } catch (e) { /* best effort */ }

      // Run cleanup every 12 cycles (once per hour) — 7 day retention
      this._aggregationCount++;
      if (this._aggregationCount % 12 === 0) {
        try {
          const removed = this.cleanup(7);
          if (removed > 0) {
            console.log(`[MetricsService] Cleaned up ${removed} metrics older than 7 days`);
          }
        } catch (err) {
          console.error(`[MetricsService] Cleanup failed: ${err.message}`);
        }
        // Prune stale timers (started > 10 min ago, never ended)
        const timerCutoff = Date.now() - 10 * 60 * 1000;
        let staleTimers = 0;
        for (const [timerId, timer] of this.timers) {
          const startTime = new Date(timer.startTimestamp).getTime();
          if (Number.isNaN(startTime) || startTime < timerCutoff) {
            this.timers.delete(timerId);
            staleTimers++;
          }
        }
        if (staleTimers > 0) {
          console.log(`[MetricsService] Pruned ${staleTimers} stale timers`);
        }
        // VACUUM when freelist pages exceed threshold
        try {
          const freelistCount = this.db.pragma('freelist_count')[0]?.freelist_count ?? 0;
          if (freelistCount > 500) { // ~2MB of dead pages
            this.db.exec('VACUUM');
            console.log(`[MetricsService] VACUUM reclaimed ${freelistCount} freelist pages`);
          }
        } catch { /* best effort */ }
      }
    }, 5 * 60 * 1000);

    // Allow Node.js to exit
    if (this.aggregationInterval.unref) {
      this.aggregationInterval.unref();
    }
  }

  _aggregate() {
    const now = new Date();
    // Aggregate the last 5-minute window (matches the aggregation interval).
    // Previously used a 1-hour lookback, which produced 12 overlapping windows per hour
    // with redundant/inflated data.
    const periodStart = new Date(now.getTime() - 5 * 60 * 1000);

    for (const type of Object.values(MetricTypes)) {
      try {
        const summary = this.getSummary(type, periodStart.toISOString(), now.toISOString());

        if (summary.count > 0) {
          this._stmts.insertAggregated.run(
            type,
            periodStart.toISOString(),
            now.toISOString(),
            summary.count,
            summary.sum,
            summary.min,
            summary.max,
            summary.avg,
            summary.p50,
            summary.p95,
            summary.p99
          );
        }
      } catch (err) {
        // Per-type catch: one failed type shouldn't block remaining types
        console.error(`[MetricsService] Aggregation failed for ${type}: ${err.message}`);
      }
    }
  }

  // ============================================
  // CLEANUP
  // ============================================

  /**
   * Clean up old metrics (older than specified days)
   */
  cleanup(daysToKeep = 30) {
    const cutoff = new Date(Date.now() - daysToKeep * 24 * 60 * 60 * 1000).toISOString();

    const result = this._stmts.cleanupMetrics.run(cutoff);

    // Also clean aggregated metrics (keep 30 days regardless)
    const aggResult = this._stmts.cleanupAggregated.run(cutoff);

    // Clean up old sessions (was previously skipped — sessions accumulated forever)
    const sessionsResult = this._stmts.cleanupSessions.run(cutoff);

    return result.changes + aggResult.changes + sessionsResult.changes;
  }

  /**
   * Close the database connection
   */
  close() {
    if (this.aggregationInterval) {
      clearInterval(this.aggregationInterval);
      this.aggregationInterval = null;
    }
    if (this.db) {
      try { this.db.pragma('wal_checkpoint(TRUNCATE)'); } catch (e) { /* best effort */ }
      this.db.close();
      this.db = null;
    }
    this.inMemoryMetrics.clear();
    this.timers.clear();
  }
}

// ============================================
// SINGLETON INSTANCE
// ============================================

let instance = null;

export function getMetricsService(dbPath = null) {
  if (!instance) {
    instance = new MetricsService(dbPath);
  }
  return instance;
}

export function resetMetricsService() {
  if (instance) {
    instance.close();
    instance = null;
  }
}

// ============================================
// CONVENIENCE FUNCTIONS
// ============================================

/**
 * Record worker spawn time
 */
export function recordWorkerSpawn(workerId, durationMs, labels = {}) {
  getMetricsService().record(
    MetricTypes.WORKER_SPAWN_TIME,
    durationMs,
    { workerId, ...labels }
  );
}

export default MetricsService;
