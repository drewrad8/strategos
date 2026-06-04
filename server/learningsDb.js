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
import { createHash } from 'crypto';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { DB_JOURNAL_SIZE_LIMIT, DB_BUSY_TIMEOUT } from './validation.js';
import { detectWorkerType } from './workers/templates.js';
import { getLogger } from './logger.js';

const logger = getLogger('learnings.db');

// Regex for fixture/canary label prefixes — matches labels that start with these patterns.
// isFixtureOrShutdown() is the JS-level equivalent for row-by-row filtering;
// SQL queries must replicate this as LIKE conditions (SQLite has no JS function call).
const FIXTURE_LABEL_RE = /^(CANARY|E2E[-_]FIXTURE|TEST[-_]SPAWN|FIXTURE:|auto-bulldoze)/i;

// Garbage learnings patterns — reject short or known-bad phrases that pollute the feedback loop.
// Matched in addLearning() to null out the learnings field before DB insert.
const GARBAGE_LEARNINGS_PATTERNS = [
  /^completed?\s+successfully\.?$/i,
  /^done\.?$/i,
  /^works\.?$/i,
  /^learned\s+a\s+lot\.?$/i,
  /^task\s+complete[d]?\.?$/i,
  /^finished\.?$/i,
  /^no\s+issues\.?$/i,
  /^success\.?$/i,
  /^all\s+good\.?$/i,
  /^everything\s+works\.?$/i,
];

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

/**
 * Tag long-running null-learnings GENERAL/COLONEL rows as server_shutdown_inferred.
 * Heuristic: uptime > 4h, learnings IS NULL, no prior terminalReason → likely lost to server restart.
 * Called on startup to backfill existing rows. Exported for test verification.
 * @param {import('better-sqlite3').Database} d
 */
export function backfillServerShutdownInferred(d) {
  d.prepare(`
    UPDATE learnings SET terminalReason = 'server_shutdown_inferred'
    WHERE learnings IS NULL
      AND terminalReason IS NULL
      AND (templateType = 'general' OR templateType = 'colonel')
      AND uptime > 14400000
  `).run();
}

/**
 * Backfill terminalReason for historical failure rows via [auto-captured on <reason>] substrings.
 * Covers: killed, session_died, stall_kill, completion_guard_kill, server_shutdown (guard re-run).
 * Any success=0 row that still has no match gets terminalReason='unknown' so it is distinguishable
 * from rows that were written after the column existed (which have an explicit value or NULL=success).
 * Exported for unit-test verification. Idempotent — all UPDATEs guard on terminalReason IS NULL.
 * @param {import('better-sqlite3').Database} d
 */
export function backfillTerminalReasonPatterns(d) {
  const patterns = ['killed', 'session_died', 'stall_kill', 'completion_guard_kill', 'server_shutdown'];
  for (const reason of patterns) {
    d.prepare(`
      UPDATE learnings SET terminalReason = ?
      WHERE terminalReason IS NULL AND learnings LIKE ?
    `).run(reason, `%[auto-captured on ${reason}]%`);
  }
  // Fallback: success=0 rows with no matching pattern → 'unknown'
  d.prepare(`
    UPDATE learnings SET terminalReason = 'unknown'
    WHERE terminalReason IS NULL AND success = 0
  `).run();
}

function _initDatabase() {
  const dbPath = path.join(__dirname, 'learnings.db');
  db = new Database(dbPath);

  db.pragma('journal_mode = WAL');
  db.pragma(`journal_size_limit = ${DB_JOURNAL_SIZE_LIMIT}`);
  db.pragma(`busy_timeout = ${DB_BUSY_TIMEOUT}`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      applied_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  function runMigration(db, name, fn) {
    if (db.prepare('SELECT id FROM schema_migrations WHERE name = ?').get(name)) return;
    fn();
    db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(name);
  }

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

    CREATE TABLE IF NOT EXISTS compliance_violations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workerId TEXT NOT NULL,
      workerLabel TEXT,
      templateType TEXT,
      violationType TEXT NOT NULL,
      description TEXT NOT NULL,
      severity TEXT DEFAULT 'warning',
      timestamp TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_compliance_workerId ON compliance_violations(workerId);
    CREATE INDEX IF NOT EXISTS idx_compliance_violationType ON compliance_violations(violationType);
  `);

  // Migration: add parentWorkerId column (added 2026-04-04)
  runMigration(db, 'add_parentWorkerId_to_learnings', () => {
    try { db.prepare('ALTER TABLE learnings ADD COLUMN parentWorkerId TEXT').run(); } catch { /* column exists */ }
  });

  // Migration: add taskQualityScore column (added 2026-04-05)
  runMigration(db, 'add_taskQualityScore_to_learnings', () => {
    try { db.prepare('ALTER TABLE learnings ADD COLUMN taskQualityScore INTEGER').run(); } catch { /* column exists */ }
  });

  // Migration: add completionScore column to review_results (added 2026-04-13)
  runMigration(db, 'add_completionScore_to_review_results', () => {
    try { db.prepare('ALTER TABLE review_results ADD COLUMN completionScore INTEGER').run(); } catch { /* column exists */ }
  });

  // Migration: add content_hash column for dedup (added 2026-04-19)
  runMigration(db, 'add_content_hash_to_learnings', () => {
    try { db.prepare('ALTER TABLE learnings ADD COLUMN content_hash TEXT').run(); } catch { /* column exists */ }
  });

  // Migration: add terminalReason column (added 2026-04-21)
  runMigration(db, 'add_terminalReason_to_learnings', () => {
    try { db.prepare('ALTER TABLE learnings ADD COLUMN terminalReason TEXT').run(); } catch { /* column exists */ }
  });

  // Backfill: tag existing server_shutdown auto-capture records so SQL filters can use the column
  try {
    db.prepare(`
      UPDATE learnings SET terminalReason = 'server_shutdown'
      WHERE learnings LIKE '%[auto-captured on server_shutdown]%' AND terminalReason IS NULL
    `).run();
  } catch { /* non-fatal */ }

  // Backfill: tag remaining auto-captured termination patterns (RC-1, 2026-04-21)
  // Covers killed, session_died, stall_kill, completion_guard_kill — plus a fallback
  // 'unknown' for success=0 rows with no matching pattern, to distinguish from un-migrated records.
  try {
    backfillTerminalReasonPatterns(db);
  } catch { /* non-fatal */ }

  // Backfill: tag long-running null-learnings GENERAL/COLONEL as server_shutdown_inferred (Class A1)
  try {
    backfillServerShutdownInferred(db);
  } catch { /* non-fatal */ }

  // Migration: dedup existing rows, keeping oldest per (workerId, learnings) pair
  try {
    db.prepare(`
      DELETE FROM learnings
      WHERE id NOT IN (
        SELECT MIN(id) FROM learnings GROUP BY workerId, COALESCE(learnings, '')
      )
    `).run();
  } catch { /* non-fatal */ }

  // Migration: partial unique index — enforces dedup only for rows with content_hash set
  try {
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_learnings_dedup ON learnings(workerId, content_hash) WHERE content_hash IS NOT NULL`);
  } catch { /* non-fatal — may already exist */ }

  // Auto-cleanup: delete entries older than 90 days
  db.prepare(`DELETE FROM learnings WHERE timestamp < datetime('now', '-90 days')`).run();
}

// ============================================
// FIXTURE / SHUTDOWN FILTER
// ============================================

/**
 * Returns true if a learnings row should be excluded from aggregate metrics.
 * Excludes: test fixture workers (CANARY, E2E_FIXTURE, TEST-SPAWN, FIXTURE: prefixes)
 * and server_shutdown auto-capture records (collateral from restarts, not real failures).
 *
 * SQL queries replicate this logic as LIKE/terminalReason conditions since SQLite
 * cannot call JS functions. Keep this helper in sync with those WHERE clauses.
 *
 * @param {{ label?: string, terminalReason?: string }} row
 * @returns {boolean}
 */
export function isFixtureOrShutdown(row) {
  if (FIXTURE_LABEL_RE.test(row.label ?? '')) return true;
  if (row.terminalReason === 'server_shutdown') return true;
  if (row.terminalReason === 'server_shutdown_inferred') return true;
  return false;
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
    INSERT OR IGNORE INTO learnings (workerId, label, templateType, templateHash, learnings, outputs, artifacts, taskDescription, parentWorkerId, effortLevel, success, uptime, taskQualityScore, content_hash, terminalReason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Quality gate: reject garbage learnings (too short or known-bad phrases).
  // Null out the learnings field but still store the record for success/failure tracking.
  let learningsValue = data.learnings || null;
  if (learningsValue) {
    const text = learningsValue.trim();
    const tooShort = text.length < 50;
    const isGarbage = GARBAGE_LEARNINGS_PATTERNS.some(p => p.test(text));
    if (tooShort || isGarbage) {
      try {
        getLogger().warn(`[LearningsDB] Rejected low-quality learnings for ${data.workerId} (${data.label}): "${text.slice(0, 80)}" — ${tooShort ? 'too short' : 'garbage pattern matched'}`);
      } catch { /* non-fatal */ }
      learningsValue = null;
    }
  }

  const outputs = data.outputs != null
    ? (typeof data.outputs === 'string' ? data.outputs : JSON.stringify(data.outputs))
    : null;
  const artifacts = data.artifacts != null
    ? (Array.isArray(data.artifacts) ? data.artifacts.join(', ') : String(data.artifacts))
    : null;

  // Dedup guard: hash the learnings text so the UNIQUE(workerId, content_hash) index
  // can reject duplicate done-signal rows from the same worker. Null learnings are
  // excluded from dedup (the partial index only covers non-null content_hash rows).
  const contentHash = learningsValue
    ? createHash('sha256').update(learningsValue).digest('hex').slice(0, 32)
    : null;

  stmt.run(
    data.workerId || null,
    data.label || null,
    data.templateType || null,
    data.templateHash || null,
    learningsValue,
    outputs,
    artifacts,
    data.taskDescription || null,
    data.parentWorkerId || null,
    data.effortLevel || null,
    data.success != null ? (data.success ? 1 : 0) : null,
    data.uptime || null,
    data.taskQualityScore != null ? Number(data.taskQualityScore) : null,
    contentHash,
    data.terminalReason || null,
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
 * @param {number} [hours=6] - How many hours back to look
 * @returns {Array} Failed learning entries
 */
export function getRecentFailures(hours = 6) {
  const d = getDb();
  // Exclude test scaffold workers (e.g. "IMPL: TEST: ...") — deliberately killed
  // during system validation, not real task failures.
  // Exclude ephemeral fixtures: workers with no task description (pure API scaffolding)
  // or killed in under 120s before Claude could start working (test harness cleanup).
  return d.prepare(`
    SELECT * FROM learnings
    WHERE success = 0 AND timestamp > datetime('now', '-' || ? || ' hours')
      AND label NOT LIKE '%: TEST: %'
      AND label NOT LIKE '%E2E_FIXTURE:%'
      AND taskDescription IS NOT NULL
      AND (uptime IS NULL OR uptime >= 120000)
    ORDER BY timestamp DESC
  `).all(hours);
}

/**
 * Get recent failures for a specific template type.
 * @param {string} type - Template type (e.g. 'impl', 'fix')
 * @param {number} [hours=6] - How many hours back to look
 * @returns {Array} Failed learning entries for this type
 */
export function getRecentFailuresByType(type, hours = 6) {
  const d = getDb();
  // Exclude test scaffold workers (e.g. "IMPL: TEST: ...") — deliberately killed
  // during system validation, not real task failures.
  // Exclude ephemeral fixtures: workers with no task description or killed in under 120s.
  return d.prepare(`
    SELECT * FROM learnings
    WHERE success = 0 AND templateType = ? AND timestamp > datetime('now', '-' || ? || ' hours')
      AND label NOT LIKE '%: TEST: %'
      AND label NOT LIKE '%E2E_FIXTURE:%'
      AND taskDescription IS NOT NULL
      AND (uptime IS NULL OR uptime >= 120000)
    ORDER BY timestamp DESC
  `).all(type, hours);
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
        AND label NOT LIKE '%E2E_FIXTURE:%'
        AND label NOT LIKE 'auto-bulldoze%'
        AND label NOT LIKE 'CANARY%'
        AND label NOT LIKE 'E2E-FIXTURE%'
        AND label NOT LIKE 'TEST-SPAWN%'
        AND label NOT LIKE 'FIXTURE:%'
        AND (terminalReason IS NULL OR (terminalReason != 'server_shutdown' AND terminalReason != 'server_shutdown_inferred'))
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
        AND label NOT LIKE '%E2E_FIXTURE:%'
        AND label NOT LIKE 'auto-bulldoze%'
        AND label NOT LIKE 'CANARY%'
        AND label NOT LIKE 'E2E-FIXTURE%'
        AND label NOT LIKE 'TEST-SPAWN%'
        AND label NOT LIKE 'FIXTURE:%'
        AND (terminalReason IS NULL OR (terminalReason != 'server_shutdown' AND terminalReason != 'server_shutdown_inferred'))
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
 * Internal: Get summary statistics, accepting a database parameter for testing.
 * @param {import('better-sqlite3').Database} [d] - Database to query (uses global if not provided)
 * @returns {Array}
 */
export function _getSummaryStatsInternal(d) {
  const db = d || getDb();
  // Exclude test scaffold workers (e.g. "IMPL: TEST: ...") — deliberately killed
  // during system validation, would inflate failure rates.
  // Exclude ephemeral fixtures: workers with no task description (pure API scaffolding)
  // or killed in under 120s before Claude could start working (test harness cleanup).
  // These are never real task failures and must not affect reported success rates.
  return db.prepare(`
    SELECT
      templateType,
      COUNT(DISTINCT workerId) as total,
      COUNT(DISTINCT CASE WHEN success = 1 THEN workerId END) as successes,
      COUNT(DISTINCT CASE WHEN success = 0 THEN workerId END) as failures,
      ROUND(CAST(COUNT(DISTINCT CASE WHEN success = 1 THEN workerId END) AS REAL) / COUNT(DISTINCT workerId), 3) as rate,
      ROUND(AVG(uptime)) as avgUptime
    FROM learnings
    WHERE label NOT LIKE '%: TEST: %'
      AND label NOT LIKE '%E2E_FIXTURE:%'
      AND label NOT LIKE 'auto-bulldoze%'
      AND label NOT LIKE 'CANARY%'
      AND label NOT LIKE 'E2E-FIXTURE%'
      AND label NOT LIKE 'TEST-SPAWN%'
      AND label NOT LIKE 'FIXTURE:%'
      AND label NOT LIKE 'TEST:%'
      AND (terminalReason IS NULL OR (terminalReason != 'server_shutdown' AND terminalReason != 'server_shutdown_inferred'))
      AND (learnings IS NULL OR learnings NOT LIKE '%[auto-captured on server_shutdown]%')
      AND taskDescription IS NOT NULL
      AND taskDescription NOT LIKE 'TEST:%'
      AND (uptime IS NULL OR uptime >= 120000)
    GROUP BY templateType
    ORDER BY total DESC
  `).all();
}

/**
 * Get summary statistics across all template types.
 * @returns {Array}
 */
export function getSummaryStats() {
  return _getSummaryStatsInternal();
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
      AND label NOT LIKE '%E2E_FIXTURE:%'
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

/**
 * Get failure reflections for a given template type within a lookback window.
 * @param {string} type - Template type (e.g. 'fix', 'colonel')
 * @param {number} [days=14] - How many days back to look
 * @returns {Array}
 */
export function getReflectionsByType(type, days = 14) {
  const d = getDb();
  return d.prepare(`
    SELECT * FROM failure_reflections
    WHERE templateType = ? AND generatedAt > datetime('now', '-' || ? || ' days')
    ORDER BY generatedAt DESC
  `).all(type, days);
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
       finalDecision, deliveredWithAnnotation, durationMs, completionScore)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    data.workerId,
    data.stage1Flags || null,
    data.stage2Decision || null,
    data.stage2Verdict || null,
    data.stage2Raw || null,
    data.finalDecision,
    data.deliveredWithAnnotation || 0,
    data.durationMs || null,
    data.completionScore != null ? Number(data.completionScore) : null,
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
// COMPLIANCE VIOLATIONS
// ============================================

/**
 * Store a compliance violation detected during done-signal handling.
 * Records role violations: generals making git commits, researchers editing non-report files, etc.
 * @param {Object} data
 */
export function addComplianceViolation(data) {
  const d = getDb();
  d.prepare(`
    INSERT INTO compliance_violations (workerId, workerLabel, templateType, violationType, description, severity)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    data.workerId,
    data.workerLabel || null,
    data.templateType || null,
    data.violationType,
    data.description,
    data.severity || 'warning',
  );
}

/**
 * Get compliance violations for a specific worker.
 * @param {string} workerId
 * @returns {Array}
 */
export function getComplianceViolations(workerId) {
  const d = getDb();
  return d.prepare('SELECT * FROM compliance_violations WHERE workerId = ? ORDER BY timestamp DESC').all(workerId);
}

/**
 * Get recent compliance violations across all workers.
 * @param {number} [days=30]
 * @returns {Array}
 */
export function getRecentComplianceViolations(days = 30) {
  const d = getDb();
  const since = new Date(Date.now() - days * 86400000).toISOString();
  return d.prepare(`
    SELECT * FROM compliance_violations
    WHERE timestamp > ?
    ORDER BY timestamp DESC
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

  logger.info('[learnings.db] Seeded entries from checkpoints', { seeded });
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
