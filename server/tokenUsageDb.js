/**
 * Token Usage Database
 *
 * Records token usage from worker Ralph signals.
 * Workers can optionally report token counts and costs in their done signals.
 * This provides session-level tracking for model usage and cost analysis.
 *
 * Uses same DB patterns as driftDb.js (WAL, busy_timeout, journal_size_limit).
 */

import Database from 'better-sqlite3';
import path from 'path';
import { DB_JOURNAL_SIZE_LIMIT, DB_BUSY_TIMEOUT } from './validation.js';

const __dirname = path.dirname(new URL(import.meta.url).pathname);

// ============================================
// DATABASE SETUP
// ============================================

let db = null;

function getDb() {
  if (!db) {
    _initDatabase();
  }
  return db;
}

function _initDatabase() {
  const dbPath = path.join(__dirname, 'tokenUsage.db');
  db = new Database(dbPath);

  db.pragma('journal_mode = WAL');
  db.pragma(`journal_size_limit = ${DB_JOURNAL_SIZE_LIMIT}`);
  db.pragma(`busy_timeout = ${DB_BUSY_TIMEOUT}`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS token_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      worker_id TEXT NOT NULL,
      worker_label TEXT,
      template_type TEXT,
      model_id TEXT NOT NULL,
      backend TEXT NOT NULL,
      request_timestamp TEXT NOT NULL,

      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER GENERATED ALWAYS AS (input_tokens + output_tokens) STORED,
      cache_read_tokens INTEGER DEFAULT 0,
      cache_creation_tokens INTEGER DEFAULT 0,

      input_cost REAL DEFAULT 0,
      output_cost REAL DEFAULT 0,
      total_cost REAL GENERATED ALWAYS AS (input_cost + output_cost) STORED,

      session_id TEXT,
      response_type TEXT DEFAULT 'normal',
      timestamp TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_token_worker_id ON token_usage(worker_id);
    CREATE INDEX IF NOT EXISTS idx_token_timestamp ON token_usage(timestamp);
    CREATE INDEX IF NOT EXISTS idx_token_model ON token_usage(model_id);
    CREATE INDEX IF NOT EXISTS idx_token_backend ON token_usage(backend);
    CREATE INDEX IF NOT EXISTS idx_token_session ON token_usage(session_id);

    CREATE VIEW IF NOT EXISTS token_usage_hourly AS
    SELECT
      date(timestamp, 'start of hour') as hour_start,
      model_id,
      backend,
      COUNT(*) as request_count,
      SUM(input_tokens) as total_input_tokens,
      SUM(output_tokens) as total_output_tokens,
      SUM(total_tokens) as total_tokens,
      SUM(total_cost) as total_cost_usd,
      AVG(total_cost) as avg_cost_per_request
    FROM token_usage
    GROUP BY
      date(timestamp, 'start of hour'),
      model_id,
      backend;

    CREATE VIEW IF NOT EXISTS token_usage_daily AS
    SELECT
      date(timestamp) as date,
      model_id,
      backend,
      COUNT(*) as request_count,
      SUM(input_tokens) as total_input_tokens,
      SUM(output_tokens) as total_output_tokens,
      SUM(total_tokens) as total_tokens,
      SUM(total_cost) as total_cost_usd
    FROM token_usage
    GROUP BY
      date(timestamp),
      model_id,
      backend;

    CREATE VIEW IF NOT EXISTS token_usage_weekly AS
    SELECT
      date(timestamp, 'weekday 0', '-6 days') as week_start,
      model_id,
      backend,
      COUNT(*) as request_count,
      SUM(input_tokens) as total_input_tokens,
      SUM(output_tokens) as total_output_tokens,
      SUM(total_tokens) as total_tokens,
      SUM(total_cost) as total_cost_usd
    FROM token_usage
    GROUP BY
      date(timestamp, 'weekday 0', '-6 days'),
      model_id,
      backend;
  `);

  // Auto-cleanup: delete entries older than 90 days
  db.prepare(`DELETE FROM token_usage WHERE timestamp < datetime('now', '-90 days')`).run();
}

// ============================================
// WRITE FUNCTIONS
// ============================================

/**
 * Record a token usage entry from a Ralph done signal.
 * All fields are optional — only present fields are stored.
 * @param {Object} data
 * @param {string} data.workerId
 * @param {string} [data.workerLabel]
 * @param {string} [data.templateType]
 * @param {string} data.modelId - e.g., "glm-4.7", "claude-sonnet-4-6"
 * @param {string} data.backend - "claude", "glm", "gemini", "aider"
 * @param {string} [data.sessionId]
 * @param {number} [data.inputTokens]
 * @param {number} [data.outputTokens]
 * @param {number} [data.inputCost]
 * @param {number} [data.outputCost]
 * @param {number} [data.cacheReadTokens]
 * @param {number} [data.cacheCreationTokens]
 * @param {string} [data.responseType] - 'normal', 'compacted', 'rate_limited'
 */
export function recordTokenUsage(data) {
  try {
    const d = getDb();
    d.prepare(`
      INSERT INTO token_usage (worker_id, worker_label, template_type, model_id, backend,
                              request_timestamp, session_id, response_type,
                              input_tokens, output_tokens, input_cost, output_cost,
                              cache_read_tokens, cache_creation_tokens)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      data.workerId || null,
      data.workerLabel ? String(data.workerLabel).slice(0, 200) : null,
      data.templateType ? String(data.templateType).slice(0, 50) : null,
      data.modelId || 'unknown',
      data.backend || 'unknown',
      data.requestTimestamp || new Date().toISOString(),
      data.sessionId ? String(data.sessionId).slice(0, 100) : null,
      data.responseType || 'normal',
      data.inputTokens || 0,
      data.outputTokens || 0,
      data.inputCost || 0, // Changed from totalCost to inputCost
      data.outputCost || 0, // Added separate outputCost
      data.cacheReadTokens || 0,
      data.cacheCreationTokens || 0
    );
  } catch {
    // Non-fatal: token recording should never affect signal processing
  }
}

// ============================================
// QUERY FUNCTIONS
// ============================================

/**
 * Get aggregated token usage for a time period.
 * @param {string} period - 'hourly' | 'daily' | 'weekly'
 * @param {Object} options
 * @param {string} [options.model] - Filter by model_id
 * @param {string} [options.backend] - Filter by backend
 * @param {number} [options.limit] - Max rows to return (default varies by period)
 * @returns {Array}
 */
export function getTokenUsageAggregates(period, options = {}) {
  const { model, backend, limit } = options;
  const d = getDb();

  let viewName, dateColumn, defaultLimit;
  switch (period) {
    case 'hourly':
      viewName = 'token_usage_hourly';
      dateColumn = 'hour_start';
      defaultLimit = 168; // 7 days
      break;
    case 'weekly':
      viewName = 'token_usage_weekly';
      dateColumn = 'week_start';
      defaultLimit = 12; // 12 weeks
      break;
    case 'daily':
    default:
      viewName = 'token_usage_daily';
      dateColumn = 'date';
      defaultLimit = 90; // 90 days
      break;
  }

  let query = `SELECT * FROM ${viewName}`;
  const conditions = [];
  const params = [];

  if (model) {
    conditions.push('model_id = ?');
    params.push(model);
  }
  if (backend) {
    conditions.push('backend = ?');
    params.push(backend);
  }

  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ');
  }

  query += ` ORDER BY ${dateColumn} DESC LIMIT ?`;
  params.push(limit !== undefined ? limit : defaultLimit);

  return d.prepare(query).all(...params);
}

/**
 * Get raw token usage entries for a specific worker.
 * @param {string} workerId
 * @returns {Array}
 */
export function getWorkerTokenUsage(workerId) {
  const d = getDb();
  return d.prepare(`
    SELECT * FROM token_usage
    WHERE worker_id = ?
    ORDER BY timestamp DESC
  `).all(workerId);
}

/**
 * Get token usage summary by model.
 * @param {Object} options
 * @param {string} [options.since] - ISO timestamp (null = all time)
 * @returns {{ totalCost: number, totalTokens: number, byModel: Object }}
 */
export function getTokenUsageSummary(options = {}) {
  const d = getDb();
  const cutoff = options.since;

  let query = `
    SELECT model_id, backend,
           SUM(total_tokens) as total_tokens,
           SUM(total_cost) as total_cost,
           COUNT(*) as request_count
    FROM token_usage
  `;
  const params = [];

  if (cutoff) {
    query += ' WHERE timestamp >= ?';
    params.push(cutoff);
  }

  query += ' GROUP BY model_id, backend ORDER BY total_cost DESC';

  const rows = d.prepare(query).all(...params);

  let totalCost = 0;
  let totalTokens = 0;
  const byModel = {};

  for (const row of rows) {
    totalCost += row.total_cost || 0;
    totalTokens += row.total_tokens || 0;

    if (!byModel[row.model_id]) {
      byModel[row.model_id] = { cost: 0, tokens: 0, requests: 0, backends: {} };
    }
    byModel[row.model_id].cost += row.total_cost || 0;
    byModel[row.model_id].tokens += row.total_tokens || 0;
    byModel[row.model_id].requests += row.request_count || 0;
    byModel[row.model_id].backends[row.backend] = (byModel[row.model_id].backends[row.backend] || 0) + row.request_count;
  }

  return { totalCost, totalTokens, byModel };
}
