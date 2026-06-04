/**
 * Drift Events Database
 *
 * Records role boundary violations detected during Ralph signal processing.
 * A "drift event" is when a worker's currentStep description is inconsistent
 * with its declared role — e.g. a GENERAL reporting "editing file" or an
 * IMPL worker reporting "spawning worker".
 *
 * Uses the same DB patterns as learningsDb.js (WAL, busy_timeout, journal_size_limit).
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { DB_JOURNAL_SIZE_LIMIT, DB_BUSY_TIMEOUT } from './validation.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
  const dbPath = path.join(__dirname, 'drift.db');
  db = new Database(dbPath);

  db.pragma('journal_mode = WAL');
  db.pragma(`journal_size_limit = ${DB_JOURNAL_SIZE_LIMIT}`);
  db.pragma(`busy_timeout = ${DB_BUSY_TIMEOUT}`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS drift_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workerId TEXT NOT NULL,
      workerLabel TEXT,
      workerType TEXT,
      timestamp TEXT DEFAULT CURRENT_TIMESTAMP,
      eventType TEXT NOT NULL,
      description TEXT NOT NULL,
      currentStep TEXT,
      severity TEXT NOT NULL DEFAULT 'warning'
    );

    CREATE INDEX IF NOT EXISTS idx_drift_workerId ON drift_events(workerId);
    CREATE INDEX IF NOT EXISTS idx_drift_timestamp ON drift_events(timestamp);
    CREATE INDEX IF NOT EXISTS idx_drift_workerType ON drift_events(workerType);
    CREATE INDEX IF NOT EXISTS idx_drift_eventType ON drift_events(eventType);
  `);

  // Auto-cleanup: delete entries older than 90 days
  db.prepare(`DELETE FROM drift_events WHERE timestamp < datetime('now', '-90 days')`).run();
}

// ============================================
// WRITE FUNCTIONS
// ============================================

/**
 * Record a drift event for a worker.
 * @param {Object} data
 * @param {string} data.workerId
 * @param {string} [data.workerLabel]
 * @param {string} [data.workerType] - e.g. 'general', 'colonel', 'impl', 'fix'
 * @param {string} data.eventType - Currently only 'boundary_violation' is emitted by callers. Reserved future values: 'redundant_work', 'off_task' (not yet implemented).
 * @param {string} data.description - Human-readable description of the violation
 * @param {string} [data.currentStep] - The currentStep value that triggered the violation
 * @param {string} [data.severity] - 'warning' | 'critical'
 */
export function recordDriftEvent(data) {
  try {
    const d = getDb();
    d.prepare(`
      INSERT INTO drift_events (workerId, workerLabel, workerType, eventType, description, currentStep, severity)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      data.workerId || null,
      data.workerLabel ? String(data.workerLabel).slice(0, 200) : null,
      data.workerType ? String(data.workerType).slice(0, 50) : null,
      data.eventType || 'boundary_violation',
      String(data.description).slice(0, 500),
      data.currentStep ? String(data.currentStep).slice(0, 500) : null,
      data.severity === 'critical' ? 'critical' : 'warning',
    );
  } catch {
    // Non-fatal: drift recording should never affect signal processing
  }
}

// ============================================
// QUERY FUNCTIONS
// ============================================

/**
 * Get all drift events for a specific worker.
 * @param {string} workerId
 * @returns {Array}
 */
export function getDriftEvents(workerId) {
  const d = getDb();
  return d.prepare(`
    SELECT * FROM drift_events WHERE workerId = ? ORDER BY timestamp DESC
  `).all(workerId);
}

/**
 * Get a summary of drift events since a given timestamp.
 * Returns counts grouped by eventType and workerType.
 * @param {string|null} since - ISO timestamp (null = all time / last 30 days)
 * @returns {{ total: number, byEventType: Object, byWorkerType: Object, recentEvents: Array }}
 */
export function getDriftEventsSummary(since) {
  const d = getDb();
  const cutoff = since || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const rows = d.prepare(`
    SELECT eventType, workerType, severity, COUNT(*) as count
    FROM drift_events
    WHERE timestamp >= ?
    GROUP BY eventType, workerType, severity
  `).all(cutoff);

  const byEventType = {};
  const byWorkerType = {};
  let total = 0;

  for (const row of rows) {
    total += row.count;

    if (!byEventType[row.eventType]) byEventType[row.eventType] = 0;
    byEventType[row.eventType] += row.count;

    if (row.workerType) {
      if (!byWorkerType[row.workerType]) byWorkerType[row.workerType] = 0;
      byWorkerType[row.workerType] += row.count;
    }
  }

  const recentEvents = d.prepare(`
    SELECT id, workerId, workerLabel, workerType, timestamp, eventType, description, currentStep, severity
    FROM drift_events
    WHERE timestamp >= ?
    ORDER BY timestamp DESC
    LIMIT 50
  `).all(cutoff);

  return { total, byEventType, byWorkerType, recentEvents };
}
