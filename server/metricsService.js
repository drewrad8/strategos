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

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ============================================
// METRIC TYPES
// ============================================

export const MetricTypes = {
  // Worker lifecycle
  WORKER_SPAWN_TIME: 'worker_spawn_time',
  WORKER_READY_TIME: 'worker_ready_time',
  WORKER_COMPLETION_TIME: 'worker_completion_time',
  WORKER_IDLE_TIME: 'worker_idle_time',

  // Error tracking
  ERROR_COUNT: 'error_count',
  ERROR_RECOVERY_TIME: 'error_recovery_time',
  ERROR_RECOVERY_SUCCESS: 'error_recovery_success',

  // Circuit breaker
  CIRCUIT_BREAKER_TRIP: 'circuit_breaker_trip',
  CIRCUIT_BREAKER_RESET: 'circuit_breaker_reset',

  // API performance
  API_RESPONSE_TIME: 'api_response_time',
  API_ERROR_RATE: 'api_error_rate',

  // Health monitoring
  HEALTH_CHECK_LATENCY: 'health_check_latency',
  HEALTH_DEGRADATION_COUNT: 'health_degradation_count',

  // Task metrics
  TASK_QUEUE_DEPTH: 'task_queue_depth',
  TASK_PROCESSING_TIME: 'task_processing_time',

  // System metrics
  MEMORY_USAGE: 'memory_usage',
  ACTIVE_WORKERS: 'active_workers'
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

    this._initDatabase();
    this._startAggregation();
  }

  // ============================================
  // DATABASE SETUP
  // ============================================

  _initDatabase() {
    this.db = new Database(this.dbPath);

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

    const stats = this.db.prepare(`
      SELECT
        COUNT(*) as count,
        SUM(value) as sum,
        AVG(value) as avg,
        MIN(value) as min,
        MAX(value) as max
      FROM metrics
      WHERE type = ? AND timestamp >= ? AND timestamp <= ?
    `).get(type, start, end);

    // Calculate percentiles
    const values = this.db.prepare(`
      SELECT value FROM metrics
      WHERE type = ? AND timestamp >= ? AND timestamp <= ?
      ORDER BY value
    `).all(type, start, end).map(r => r.value);

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
    const session = this.db.prepare(`
      SELECT * FROM sessions WHERE id = ?
    `).get(sessionId);

    if (!session) {
      return null;
    }

    const metrics = this.db.prepare(`
      SELECT type, value, labels, timestamp
      FROM metrics
      WHERE session_id = ?
      ORDER BY timestamp
    `).all(sessionId);

    // Group by type
    const byType = {};
    for (const m of metrics) {
      if (!byType[m.type]) {
        byType[m.type] = [];
      }
      byType[m.type].push(m);
    }

    // Calculate summaries per type
    const summaries = {};
    for (const [type, values] of Object.entries(byType)) {
      const nums = values.map(v => v.value);
      summaries[type] = {
        count: nums.length,
        sum: nums.reduce((a, b) => a + b, 0),
        avg: nums.reduce((a, b) => a + b, 0) / nums.length,
        min: Math.min(...nums),
        max: Math.max(...nums)
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
      this._aggregate();
    }, 5 * 60 * 1000);

    // Allow Node.js to exit
    if (this.aggregationInterval.unref) {
      this.aggregationInterval.unref();
    }
  }

  _aggregate() {
    const now = new Date();
    const hourAgo = new Date(now.getTime() - 3600000);

    for (const type of Object.values(MetricTypes)) {
      const summary = this.getSummary(type, hourAgo.toISOString(), now.toISOString());

      if (summary.count > 0) {
        this.db.prepare(`
          INSERT INTO metrics_aggregated
          (type, period_start, period_end, count, sum, min, max, avg, p50, p95, p99)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          type,
          hourAgo.toISOString(),
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

    const result = this.db.prepare(`
      DELETE FROM metrics WHERE timestamp < ?
    `).run(cutoff);

    return result.changes;
  }

  /**
   * Close the database connection
   */
  close() {
    if (this.aggregationInterval) {
      clearInterval(this.aggregationInterval);
    }
    if (this.db) {
      this.db.close();
    }
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

/**
 * Record API response time
 */
export function recordApiResponse(endpoint, method, durationMs, statusCode) {
  getMetricsService().record(
    MetricTypes.API_RESPONSE_TIME,
    durationMs,
    { endpoint, method, statusCode }
  );
}

/**
 * Record error occurrence
 */
export function recordError(errorType, labels = {}) {
  getMetricsService().increment(MetricTypes.ERROR_COUNT, 1, { errorType, ...labels });
}

/**
 * Record circuit breaker trip
 */
export function recordCircuitBreakerTrip(name) {
  getMetricsService().increment(MetricTypes.CIRCUIT_BREAKER_TRIP, 1, { name });
}

/**
 * Record health check latency
 */
export function recordHealthCheck(workerId, latencyMs, status) {
  getMetricsService().record(
    MetricTypes.HEALTH_CHECK_LATENCY,
    latencyMs,
    { workerId, status }
  );
}

export default MetricsService;
