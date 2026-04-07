/**
 * Learnings Database for Strategos
 *
 * Captures Ralph learnings from completed workers, enabling downstream
 * self-improvement. Stores learnings, outputs, artifacts, and metadata
 * from worker done signals.
 *
 * Uses the same DB patterns as metricsService.js (WAL, busy_timeout, journal_size_limit).
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { DB_JOURNAL_SIZE_LIMIT, DB_BUSY_TIMEOUT } from './validation.js';
import { detectWorkerType } from './workers/templates.js';

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
  const dbPath = path.join(__dirname, 'learnings.db');
  db = new Database(dbPath);

  db.pragma('journal_mode = WAL');
  db.pragma(`journal_size_limit = ${DB_JOURNAL_SIZE_LIMIT}`);
  db.pragma(`busy_timeout = ${DB_BUSY_TIMEOUT}`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS learnings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workerId TEXT,
      label TEXT,
      templateType TEXT,
      templateHash TEXT,
      learnings TEXT,
      outputs TEXT,
      artifacts TEXT,
      taskDescription TEXT,
      parentWorkerId TEXT,
      effortLevel TEXT,
      success INTEGER,
      uptime INTEGER,
      timestamp TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_learnings_templateType ON learnings(templateType);
    CREATE INDEX IF NOT EXISTS idx_learnings_timestamp ON learnings(timestamp);

    CREATE TABLE IF NOT EXISTS failure_reflections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workerId TEXT NOT NULL,
      templateType TEXT NOT NULL,
      taskDescription TEXT,
      reflection TEXT NOT NULL,
      outputSample TEXT,
      generatedAt TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(workerId)
    );

    CREATE INDEX IF NOT EXISTS idx_reflections_templateType ON failure_reflections(templateType);

    CREATE TABLE IF NOT EXISTS review_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workerId TEXT NOT NULL,
      stage1Flags TEXT,
      stage2Decision TEXT,
      stage2Verdict TEXT,
      stage2Raw TEXT,
      finalDecision TEXT NOT NULL,
      deliveredWithAnnotation INTEGER DEFAULT 0,
      durationMs INTEGER,
      timestamp TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(workerId)
    );

    CREATE INDEX IF NOT EXISTS idx_review_workerId ON review_results(workerId);
  `);

  // Migration: add parentWorkerId column if it doesn't exist (added 2026-04-04)
  try {
    db.prepare('ALTER TABLE learnings ADD COLUMN parentWorkerId TEXT').run();
  } catch {
    // Column already exists — expected on subsequent starts
  }

  // Migration: add taskQualityScore column if it doesn't exist (added 2026-04-05)
  // Tracks spawn-time quality score so we can correlate task structure with success rate over time.
  try {
    db.prepare('ALTER TABLE learnings ADD COLUMN taskQualityScore INTEGER').run();
  } catch {
    // Column already exists — expected on subsequent starts
  }

  // Auto-cleanup: delete entries older than 90 days
  db.prepare(`DELETE FROM learnings WHERE timestamp < datetime('now', '-90 days')`).run();
}

// ============================================
// WRITE FUNCTIONS
// ============================================

/**
 * Add a learning entry from a completed worker.
 * @param {Object} data - Learning data
 */
export function addLearning(data) {
  const d = getDb();
  const stmt = d.prepare(`
    INSERT INTO learnings (workerId, label, templateType, templateHash, learnings, outputs, artifacts, taskDescription, parentWorkerId, effortLevel, success, uptime, taskQualityScore)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const outputs = data.outputs != null
    ? (typeof data.outputs === 'string' ? data.outputs : JSON.stringify(data.outputs))
    : null;
  const artifacts = data.artifacts != null
    ? (Array.isArray(data.artifacts) ? data.artifacts.join(', ') : String(data.artifacts))
    : null;

  stmt.run(
    data.workerId || null,
    data.label || null,
    data.templateType || null,
    data.templateHash || null,
    data.learnings || null,
    outputs,
    artifacts,
    data.taskDescription || null,
    data.parentWorkerId || null,
    data.effortLevel || null,
    data.success != null ? (data.success ? 1 : 0) : null,
    data.uptime || null,
    data.taskQualityScore != null ? Number(data.taskQualityScore) : null,
  );
}

// ============================================
// QUERY FUNCTIONS
// ============================================

/**
 * Get learnings filtered by template type and recency.
 * @param {string} [type] - Template type filter (null = all)
 * @param {number} [days=30] - How many days back to look
 * @returns {Array} Learning entries
 */
export function getLearnings(type, days = 30) {
  const d = getDb();
  if (type) {
    return d.prepare(`
      SELECT * FROM learnings
      WHERE templateType = ? AND timestamp > datetime('now', '-' || ? || ' days')
      ORDER BY timestamp DESC
    `).all(type, days);
  }
  return d.prepare(`
    SELECT * FROM learnings
    WHERE timestamp > datetime('now', '-' || ? || ' days')
    ORDER BY timestamp DESC
  `).all(days);
}

/**
 * Get recent failures (success = 0) within the given time window.
 * @param {number} [days=7] - How many days back to look
 * @returns {Array} Failed learning entries
 */
export function getRecentFailures(days = 7) {
  const d = getDb();
  // Exclude test scaffold workers (e.g. "IMPL: TEST: ...") — deliberately killed
  // during system validation, not real task failures.
  // Exclude ephemeral fixtures: workers with no task description (pure API scaffolding)
  // or killed in under 120s before Claude could start working (test harness cleanup).
  return d.prepare(`
    SELECT * FROM learnings
    WHERE success = 0 AND timestamp > datetime('now', '-' || ? || ' days')
      AND label NOT LIKE '%: TEST: %'
      AND taskDescription IS NOT NULL
      AND (uptime IS NULL OR uptime >= 120000)
    ORDER BY timestamp DESC
  `).all(days);
}

/**
 * Get recent failures for a specific template type.
 * @param {string} type - Template type (e.g. 'impl', 'fix')
 * @param {number} [days=30] - How many days back to look
 * @returns {Array} Failed learning entries for this type
 */
export function getRecentFailuresByType(type, days = 30) {
  const d = getDb();
  // Exclude test scaffold workers (e.g. "IMPL: TEST: ...") — deliberately killed
  // during system validation, not real task failures.
  // Exclude ephemeral fixtures: workers with no task description or killed in under 120s.
  return d.prepare(`
    SELECT * FROM learnings
    WHERE success = 0 AND templateType = ? AND timestamp > datetime('now', '-' || ? || ' days')
      AND label NOT LIKE '%: TEST: %'
      AND taskDescription IS NOT NULL
      AND (uptime IS NULL OR uptime >= 120000)
    ORDER BY timestamp DESC
  `).all(type, days);
}

/**
 * Get success rate for a given template type within a time window.
 * @param {string} [type] - Template type (null = all types)
 * @param {number} [days=30] - How many days back to look
 * @returns {{ total: number, successes: number, failures: number, rate: number }}
 */
export function getSuccessRate(type, days = 30) {
  const d = getDb();
  // Ephemeral exclusion: same criteria as getSummaryStats — no task description or
  // killed in under 120s. These are test fixtures, not real task outcomes.
  let row;
  if (type) {
    row = d.prepare(`
      SELECT
        COUNT(DISTINCT workerId) as total,
        COUNT(DISTINCT CASE WHEN success = 1 THEN workerId END) as successes,
        COUNT(DISTINCT CASE WHEN success = 0 THEN workerId END) as failures
      FROM learnings
      WHERE templateType = ? AND timestamp > datetime('now', '-' || ? || ' days')
        AND label NOT LIKE '%: TEST: %'
        AND taskDescription IS NOT NULL
        AND (uptime IS NULL OR uptime >= 120000)
    `).get(type, days);
  } else {
    row = d.prepare(`
      SELECT
        COUNT(DISTINCT workerId) as total,
        COUNT(DISTINCT CASE WHEN success = 1 THEN workerId END) as successes,
        COUNT(DISTINCT CASE WHEN success = 0 THEN workerId END) as failures
      FROM learnings
      WHERE timestamp > datetime('now', '-' || ? || ' days')
        AND label NOT LIKE '%: TEST: %'
        AND taskDescription IS NOT NULL
        AND (uptime IS NULL OR uptime >= 120000)
    `).get(days);
  }

  return {
    total: row.total,
    successes: row.successes || 0,
    failures: row.failures || 0,
    rate: row.total > 0 ? (row.successes || 0) / row.total : 0,
  };
}

/**
 * Get summary statistics across all template types.
 * @returns {Array}
 */
export function getSummaryStats() {
  const d = getDb();
  // Exclude test scaffold workers (e.g. "IMPL: TEST: ...") — deliberately killed
  // during system validation, would inflate failure rates.
  // Exclude ephemeral fixtures: workers with no task description (pure API scaffolding)
  // or killed in under 120s before Claude could start working (test harness cleanup).
  // These are never real task failures and must not affect reported success rates.
  return d.prepare(`
    SELECT
      templateType,
      COUNT(DISTINCT workerId) as total,
      COUNT(DISTINCT CASE WHEN success = 1 THEN workerId END) as successes,
      COUNT(DISTINCT CASE WHEN success = 0 THEN workerId END) as failures,
      ROUND(CAST(COUNT(DISTINCT CASE WHEN success = 1 THEN workerId END) AS REAL) / COUNT(DISTINCT workerId), 3) as rate,
      ROUND(AVG(uptime)) as avgUptime
    FROM learnings
    WHERE label NOT LIKE '%: TEST: %'
      AND taskDescription IS NOT NULL
      AND (uptime IS NULL OR uptime >= 120000)
    GROUP BY templateType
    ORDER BY total DESC
  `).all();
}

/**
 * Get recent successful completions for a specific template type.
 * Returns entries with non-empty learnings, ordered by most recent.
 * @param {string} type - Template type (e.g. 'impl', 'fix', 'research')
 * @param {number} [limit=3] - Max entries to return
 * @param {number} [days=30] - How many days back to look
 * @returns {Array} Successful learning entries with task snippets and learnings
 */
export function getRecentSuccessesByType(type, limit = 3, days = 30) {
  const d = getDb();
  // GROUP BY workerId deduplicates the R5 double-entry rows (same worker stored twice).
  // LENGTH >= 100 filters garbage entries ("works", "learned a lot", etc.).
  // label NOT LIKE '%: TEST: %' excludes test scaffold entries (same filter as failure queries).
  return d.prepare(`
    SELECT taskDescription, learnings, label
    FROM learnings
    WHERE success = 1
      AND templateType = ?
      AND learnings IS NOT NULL
      AND learnings != ''
      AND LENGTH(learnings) >= 100
      AND label NOT LIKE '%: TEST: %'
      AND timestamp > datetime('now', '-' || ? || ' days')
    GROUP BY workerId
    ORDER BY MAX(timestamp) DESC
    LIMIT ?
  `).all(type, days, limit);
}

// ============================================
// FAILURE REFLECTIONS
// ============================================

/**
 * Store a structured failure reflection generated by reflexionService.
 * @param {Object} data
 */
export function addFailureReflection(data) {
  const d = getDb();
  d.prepare(`
    INSERT OR REPLACE INTO failure_reflections
      (workerId, templateType, taskDescription, reflection, outputSample)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    data.workerId,
    data.templateType,
    data.taskDescription || null,
    data.reflection,
    data.outputSample || null,
  );
}

/**
 * Get the most recent failure reflections for a given worker template type.
 * @param {string} type - Template type (e.g. 'fix', 'colonel')
 * @param {number} [limit=3] - Max entries to return
 * @returns {Array}
 */
export function getRecentReflectionsByType(type, limit = 3) {
  const d = getDb();
  return d.prepare(`
    SELECT * FROM failure_reflections
    WHERE templateType = ?
    ORDER BY generatedAt DESC
    LIMIT ?
  `).all(type, limit);
}

// ============================================
// REVIEW GATE RESULTS
// ============================================

/**
 * Store a review gate result for a completed worker.
 * Uses INSERT OR REPLACE so each worker has exactly one row.
 * @param {Object} data
 */
export function addReviewResult(data) {
  const d = getDb();
  d.prepare(`
    INSERT OR REPLACE INTO review_results
      (workerId, stage1Flags, stage2Decision, stage2Verdict, stage2Raw,
       finalDecision, deliveredWithAnnotation, durationMs)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    data.workerId,
    data.stage1Flags || null,
    data.stage2Decision || null,
    data.stage2Verdict || null,
    data.stage2Raw || null,
    data.finalDecision,
    data.deliveredWithAnnotation || 0,
    data.durationMs || null,
  );
}

/**
 * Get the review result for a specific worker.
 * @param {string} workerId
 * @returns {Object|null}
 */
export function getReviewResult(workerId) {
  const d = getDb();
  return d.prepare('SELECT * FROM review_results WHERE workerId = ?').get(workerId) || null;
}

/**
 * Get aggregate review stats for a time window.
 * @param {number} [days=30]
 * @returns {Array}
 */
export function getReviewStats(days = 30) {
  const d = getDb();
  const since = new Date(Date.now() - days * 86400000).toISOString();
  return d.prepare(`
    SELECT finalDecision, COUNT(*) as n
    FROM review_results
    WHERE timestamp > ?
    GROUP BY finalDecision
  `).all(since);
}

// ============================================
// CHECKPOINT SEEDING
// ============================================

/**
 * Seed the learnings DB from existing checkpoint files.
 * Reads checkpoint JSON files from server/.tmp/checkpoints/ and inserts
 * any that don't already exist (by workerId).
 * @returns {number} Number of entries seeded
 */
export function seedFromCheckpoints() {
  const d = getDb();
  const checkpointDir = path.join(__dirname, '.tmp', 'checkpoints');

  if (!fs.existsSync(checkpointDir)) return 0;

  let files;
  try {
    files = fs.readdirSync(checkpointDir).filter(f => f.endsWith('.json'));
  } catch {
    return 0;
  }

  const existingIds = new Set(
    d.prepare('SELECT workerId FROM learnings').all().map(r => r.workerId)
  );

  let seeded = 0;
  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(checkpointDir, file), 'utf8'));
      if (!data.workerId || existingIds.has(data.workerId)) continue;

      const typeInfo = detectWorkerType(data.label);
      const taskDesc = data.task?.description || data.task || null;

      addLearning({
        workerId: data.workerId,
        label: data.label || null,
        templateType: typeInfo.prefix ? typeInfo.prefix.toLowerCase() : null,
        templateHash: null,
        learnings: data.ralphLearnings || null,
        outputs: data.ralphOutputs || null,
        artifacts: data.ralphArtifacts || null,
        taskDescription: typeof taskDesc === 'string' ? taskDesc : (taskDesc ? JSON.stringify(taskDesc) : null),
        effortLevel: null,
        success: data.ralphStatus === 'done' ? 1 : 0,
        uptime: data.uptime || null,
      });
      seeded++;
    } catch {
      // Skip malformed checkpoints
    }
  }

  console.log(`[LearningsDB] Seeded ${seeded} entries from checkpoints`);
  return seeded;
}

// ============================================
// LIFECYCLE
// ============================================

/**
 * Close the database connection and checkpoint WAL.
 */
export function close() {
  if (db) {
    try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* best effort */ }
    db.close();
    db = null;
  }
}
