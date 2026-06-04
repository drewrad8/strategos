/**
 * Memory Database for Strategos
 *
 * Persistent memory scoped by project + worker role.
 * Auto-captures decisions and patterns from general/colonel done signals
 * via memoryService.js. Entries are injected into future worker contexts.
 *
 * Uses the same DB patterns as driftDb.js (WAL, busy_timeout, journal_size_limit).
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { DB_JOURNAL_SIZE_LIMIT, DB_BUSY_TIMEOUT } from './validation.js';
import { getLogger } from './logger.js';

const logger = getLogger('memory.db');

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
  const dbPath = path.join(__dirname, 'memory.db');
  db = new Database(dbPath);

  db.pragma('journal_mode = WAL');
  db.pragma(`journal_size_limit = ${DB_JOURNAL_SIZE_LIMIT}`);
  db.pragma(`busy_timeout = ${DB_BUSY_TIMEOUT}`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      namespace TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'pattern',
      content TEXT NOT NULL,
      source TEXT,
      worker_role TEXT,
      relevance_score REAL NOT NULL DEFAULT 1.0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_memory_namespace ON memory_entries(namespace);
    CREATE INDEX IF NOT EXISTS idx_memory_category ON memory_entries(category);
    CREATE INDEX IF NOT EXISTS idx_memory_worker_role ON memory_entries(worker_role);
    CREATE INDEX IF NOT EXISTS idx_memory_relevance ON memory_entries(namespace, relevance_score);
    CREATE INDEX IF NOT EXISTS idx_memory_created ON memory_entries(created_at);
  `);

  _setupMemoryFts(db);

  // Auto-cleanup entries older than 30 days
  db.prepare(`DELETE FROM memory_entries WHERE created_at < datetime('now', '-30 days')`).run();

  // Startup sweep: backfill program.md for all namespaces with existing memory entries.
  // scheduleDocUpdate only fires on memory_add inserts — without this, workers that
  // inherit project context (RESEARCH/COLONEL/GENERAL) get no <project-context> block
  // after a server restart if no memory_add has run since the restart.
  Promise.resolve().then(async () => {
    try {
      const { scheduleDocUpdate } = await import('./services/programDocService.js');
      const theaRoot = path.join(__dirname, '..', '..');
      const namespaces = db.prepare(`SELECT DISTINCT namespace FROM memory_entries`).all();
      for (const { namespace } of namespaces) {
        try {
          const projectPath = path.join(theaRoot, String(namespace));
          if (!fs.existsSync(projectPath)) continue;
          scheduleDocUpdate(String(namespace), projectPath);
        } catch { /* non-fatal per namespace */ }
      }
    } catch { /* non-fatal */ }
  });
}

/**
 * Replace the module-level DB instance. For testing only — inject an in-memory DB to
 * prevent test writes from reaching the production memory.db file.
 * @param {import('better-sqlite3').Database|null} database
 */
export function _setDb(database) {
  db = database;
}

/**
 * Set up (or verify) the FTS5 virtual table. Idempotent — safe to call multiple times.
 * Exported for testing purposes.
 * @param {import('better-sqlite3').Database} d
 */
export function _setupMemoryFts(d) {
  const ftsExists = d.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='memory_fts'`
  ).get();
  if (!ftsExists) {
    d.exec(`CREATE VIRTUAL TABLE memory_fts USING fts5(content, content='memory_entries', content_rowid='id')`);
    // Backfill existing rows only on first creation
    d.exec(`INSERT INTO memory_fts(rowid, content) SELECT id, content FROM memory_entries`);
  }
}

// ============================================
// WRITE FUNCTIONS
// ============================================

/**
 * Write a memory entry.
 * @param {Object} data
 * @param {string} data.namespace - Project name (e.g. "strategos", "financial_tracker")
 * @param {string} data.category - 'decision' | 'pattern' | 'approach' | 'warning'
 * @param {string} data.content - Memory content (max 2000 chars)
 * @param {string} [data.source] - WorkerId that created this entry
 * @param {string} [data.worker_role] - 'general' | 'colonel' | etc.
 * @param {number} [data.relevance_score] - 0.0–1.0, default 1.0
 * @returns {number} inserted row id
 */
export function writeMemoryEntry(data) {
  try {
    const d = getDb();
    const validCategories = new Set(['decision', 'pattern', 'approach', 'warning']);
    const category = validCategories.has(data.category) ? data.category : 'pattern';
    const content = String(data.content).slice(0, 2000);
    const result = d.prepare(`
      INSERT INTO memory_entries (namespace, category, content, source, worker_role, relevance_score)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      String(data.namespace).slice(0, 100),
      category,
      content,
      data.source ? String(data.source).slice(0, 50) : null,
      data.worker_role ? String(data.worker_role).slice(0, 50) : null,
      typeof data.relevance_score === 'number' ? Math.min(1.0, Math.max(0.0, data.relevance_score)) : 1.0,
    );
    const id = result.lastInsertRowid;
    // Sync FTS index — non-fatal if it fails
    try { d.prepare(`INSERT INTO memory_fts(rowid, content) VALUES (?, ?)`).run(id, content); } catch { /* ignore */ }
    // Non-blocking: regenerate program.md for this namespace on memory write
    Promise.resolve().then(async () => {
      try {
        const { scheduleDocUpdate } = await import('./services/programDocService.js');
        const theaRoot = path.join(__dirname, '..', '..');
        const projectPath = path.join(theaRoot, String(data.namespace));
        scheduleDocUpdate(String(data.namespace), projectPath);
      } catch { /* non-fatal */ }
    });
    return id;
  } catch (err) {
    logger.error('[memory.db] Failed to write memory entry', { error: err.message || String(err) });
    return null;
  }
}

// ============================================
// QUERY FUNCTIONS
// ============================================

/**
 * Get top N most relevant memory entries for a project + role.
 * Entries with null worker_role are considered universal (match all roles).
 * @param {string} namespace - Project name
 * @param {string|null} workerRole - 'general' | 'colonel' | null for all
 * @param {number} [limit=10]
 * @returns {Array}
 */
export function getMemoryEntries(namespace, workerRole = null, limit = 10) {
  try {
    const d = getDb();
    if (workerRole) {
      return d.prepare(`
        SELECT * FROM memory_entries
        WHERE namespace = ? AND (worker_role = ? OR worker_role IS NULL)
        ORDER BY relevance_score DESC, created_at DESC
        LIMIT ?
      `).all(namespace, workerRole, limit);
    }
    return d.prepare(`
      SELECT * FROM memory_entries
      WHERE namespace = ?
      ORDER BY relevance_score DESC, created_at DESC
      LIMIT ?
    `).all(namespace, limit);
  } catch {
    return [];
  }
}

/**
 * Get all memory entries for a project (API listing, no limit).
 * @param {string} namespace
 * @returns {Array}
 */
export function getAllMemoryEntries(namespace) {
  try {
    const d = getDb();
    return d.prepare(`
      SELECT * FROM memory_entries
      WHERE namespace = ?
      ORDER BY relevance_score DESC, created_at DESC
    `).all(namespace);
  } catch {
    return [];
  }
}

/**
 * Delete a memory entry by ID.
 * @param {number} id
 * @returns {boolean} true if a row was deleted
 */
export function deleteMemoryEntry(id) {
  try {
    const d = getDb();
    const result = d.prepare(`DELETE FROM memory_entries WHERE id = ?`).run(id);
    return result.changes > 0;
  } catch (err) {
    logger.error('[memory.db] Failed to delete memory entry', { error: err.message || String(err) });
    return false;
  }
}

/**
 * Get a single memory entry by ID.
 * @param {number} id
 * @returns {Object|null}
 */
export function getMemoryEntryById(id) {
  try {
    const d = getDb();
    return d.prepare(`SELECT * FROM memory_entries WHERE id = ?`).get(id) || null;
  } catch {
    return null;
  }
}

/**
 * Sanitize a user-supplied query for safe FTS5 MATCH use.
 * Wraps each whitespace-delimited token in double-quotes so FTS5 treats them
 * as literal phrases rather than operators. Hyphens (NOT), bare numbers
 * (column refs), *, +, ^, :, (, ) are all neutralized this way.
 * Embedded double-quotes inside a token are escaped by doubling them per
 * the FTS5 phrase-quote spec.
 * Returns empty string for whitespace-only or empty input — callers should
 * return [] without querying when this happens.
 */
function sanitizeFtsQuery(query) {
  const tokens = (query || '').split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return '';
  return tokens.map(t => `"${t.replace(/"/g, '""')}"`).join(' ');
}

/**
 * Full-text search across memory entries using FTS5.
 * @param {string} query - raw user query (will be sanitized before MATCH)
 * @param {string} namespace - Project namespace to filter
 * @param {number} [limit=10]
 * @returns {Array} matching entries with id, category, namespace, content, rank
 */
export function searchMemoryFts(query, namespace, limit = 10) {
  try {
    const sanitized = sanitizeFtsQuery(query);
    if (!sanitized) return [];
    const d = getDb();
    return d.prepare(`
      SELECT me.id, me.category, me.namespace, me.content, memory_fts.rank
      FROM memory_fts
      JOIN memory_entries me ON me.id = memory_fts.rowid
      WHERE memory_fts MATCH ? AND me.namespace = ?
      ORDER BY memory_fts.rank
      LIMIT ?
    `).all(sanitized, namespace, limit);
  } catch {
    return [];
  }
}
