import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Store database in server/.tmp directory (per CLAUDE.md rules)
const DB_DIR = path.join(__dirname, '.tmp');
const DB_PATH = path.join(DB_DIR, 'worker_outputs.db');

// Ensure directory exists
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true, mode: 0o700 });
}

// Initialize database
const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent read/write performance
db.pragma('journal_mode = WAL');
db.pragma('journal_size_limit = 50000000'); // 50MB WAL limit
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

// Create tables for worker output persistence
db.exec(`
  -- Worker sessions table - tracks each worker lifecycle
  CREATE TABLE IF NOT EXISTS worker_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    worker_id TEXT NOT NULL,
    session_name TEXT,
    label TEXT,
    project TEXT,
    working_dir TEXT,
    task_description TEXT,
    started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ended_at TEXT,
    final_status TEXT DEFAULT 'running',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  -- Worker outputs table - stores output chunks
  CREATE TABLE IF NOT EXISTS worker_outputs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    worker_id TEXT NOT NULL,
    timestamp TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    output_chunk TEXT NOT NULL,
    chunk_type TEXT DEFAULT 'stdout',
    chunk_hash TEXT,
    FOREIGN KEY (session_id) REFERENCES worker_sessions(id) ON DELETE CASCADE
  );

  -- Indexes for efficient queries
  CREATE INDEX IF NOT EXISTS idx_sessions_worker_id ON worker_sessions(worker_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_started_at ON worker_sessions(started_at);
  CREATE INDEX IF NOT EXISTS idx_sessions_project ON worker_sessions(project);
  CREATE INDEX IF NOT EXISTS idx_outputs_session_id ON worker_outputs(session_id);
  CREATE INDEX IF NOT EXISTS idx_outputs_worker_id ON worker_outputs(worker_id);
  CREATE INDEX IF NOT EXISTS idx_outputs_timestamp ON worker_outputs(timestamp);
  CREATE INDEX IF NOT EXISTS idx_outputs_chunk_hash ON worker_outputs(chunk_hash);
`);

// Prepared statements for performance
const insertSession = db.prepare(`
  INSERT INTO worker_sessions (worker_id, session_name, label, project, working_dir, task_description)
  VALUES (?, ?, ?, ?, ?, ?)
`);

const updateSessionEnd = db.prepare(`
  UPDATE worker_sessions
  SET ended_at = CURRENT_TIMESTAMP, final_status = ?
  WHERE id = ?
`);

const insertOutput = db.prepare(`
  INSERT INTO worker_outputs (session_id, worker_id, output_chunk, chunk_type, chunk_hash)
  VALUES (?, ?, ?, ?, ?)
`);

const getActiveSession = db.prepare(`
  SELECT * FROM worker_sessions
  WHERE worker_id = ? AND ended_at IS NULL
  ORDER BY started_at DESC
  LIMIT 1
`);

const getSessionById = db.prepare(`
  SELECT * FROM worker_sessions WHERE id = ?
`);

const getSessionsByWorkerId = db.prepare(`
  SELECT * FROM worker_sessions
  WHERE worker_id = ?
  ORDER BY started_at DESC
`);

const getSessionsByWorkerIdPaginated = db.prepare(`
  SELECT * FROM worker_sessions
  WHERE worker_id = ?
  ORDER BY started_at DESC
  LIMIT ? OFFSET ?
`);

const countSessionsByWorkerId = db.prepare(`
  SELECT COUNT(*) as count FROM worker_sessions WHERE worker_id = ?
`);

const getOutputsBySessionId = db.prepare(`
  SELECT * FROM worker_outputs
  WHERE session_id = ?
  ORDER BY timestamp ASC
`);

const getOutputsBySessionIdPaginated = db.prepare(`
  SELECT * FROM worker_outputs
  WHERE session_id = ?
  ORDER BY timestamp ASC
  LIMIT ? OFFSET ?
`);

const countOutputsBySessionId = db.prepare(`
  SELECT COUNT(*) as count FROM worker_outputs WHERE session_id = ?
`);

const getRecentOutputsByWorkerId = db.prepare(`
  SELECT wo.* FROM worker_outputs wo
  JOIN worker_sessions ws ON wo.session_id = ws.id
  WHERE wo.worker_id = ?
  ORDER BY wo.timestamp DESC
  LIMIT ?
`);

const getLastChunkHash = db.prepare(`
  SELECT chunk_hash FROM worker_outputs
  WHERE session_id = ?
  ORDER BY timestamp DESC
  LIMIT 1
`);

const getFullOutputBySessionId = db.prepare(
  'SELECT output_chunk FROM worker_outputs WHERE session_id = ? ORDER BY id ASC LIMIT 50000'
);

// Pre-cached stats queries (was inline db.prepare() on every getStats() call)
const stmtSessionCount = db.prepare('SELECT COUNT(*) as count FROM worker_sessions');
const stmtOutputCount = db.prepare('SELECT COUNT(*) as count FROM worker_outputs');
const stmtActiveSessionCount = db.prepare('SELECT COUNT(*) as count FROM worker_sessions WHERE ended_at IS NULL');
const stmtOldestSession = db.prepare('SELECT MIN(started_at) as oldest FROM worker_sessions');
const stmtNewestSession = db.prepare('SELECT MAX(started_at) as newest FROM worker_sessions');

// Pre-cached cleanup queries (was inline db.prepare() in cleanup functions)
const stmtOldSessions = db.prepare(`
  SELECT id FROM worker_sessions
  WHERE started_at < ? AND ended_at IS NOT NULL
`);
const stmtOrphanedSessions = db.prepare(`
  UPDATE worker_sessions
  SET ended_at = CURRENT_TIMESTAMP, final_status = 'orphaned'
  WHERE ended_at IS NULL AND started_at < ?
`);
const stmtDeleteOldestOutputs = db.prepare(`
  DELETE FROM worker_outputs WHERE id IN (
    SELECT id FROM worker_outputs ORDER BY timestamp ASC LIMIT 10000
  )
`);
const stmtOutputRowCount = db.prepare('SELECT COUNT(*) as c FROM worker_outputs');

// Track active session IDs for each worker
const activeSessionIds = new Map();

/**
 * Create a simple hash for deduplication
 */
function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash | 0; // Convert to 32-bit integer (was `hash & hash` which is a no-op)
  }
  return hash.toString(16);
}

/**
 * Start a new worker session
 * @param {Object} worker - Worker object with id, label, project, workingDir, tmuxSession
 * @param {string} taskDescription - Optional description of what this session is for
 * @returns {number} Session ID
 */
export function startSession(worker, taskDescription = null) {
  try {
    const result = insertSession.run(
      worker.id,
      worker.tmuxSession,
      worker.label,
      worker.project,
      worker.workingDir,
      taskDescription
    );

    const sessionId = result.lastInsertRowid;
    activeSessionIds.set(worker.id, sessionId);

    console.log(`[WorkerOutputDb] Started session ${sessionId} for worker ${worker.id} (${worker.label})`);
    return sessionId;
  } catch (err) {
    console.error('[WorkerOutputDb] Failed to start session:', err.message);
    return null;
  }
}

/**
 * End a worker session
 * @param {string} workerId - Worker ID
 * @param {string} finalStatus - Final status (stopped, error, completed)
 */
export function endSession(workerId, finalStatus = 'stopped') {
  try {
    const sessionId = activeSessionIds.get(workerId);

    if (sessionId) {
      updateSessionEnd.run(finalStatus, sessionId);
      activeSessionIds.delete(workerId);
      console.log(`[WorkerOutputDb] Ended session ${sessionId} for worker ${workerId} with status: ${finalStatus}`);
      return true;
    }

    // Try to find and close any active session for this worker
    const activeSession = getActiveSession.get(workerId);
    if (activeSession) {
      updateSessionEnd.run(finalStatus, activeSession.id);
      console.log(`[WorkerOutputDb] Ended orphan session ${activeSession.id} for worker ${workerId}`);
      return true;
    }

    return false;
  } catch (err) {
    console.error('[WorkerOutputDb] Failed to end session:', err.message);
    return false;
  }
}

/**
 * Store an output chunk for a worker
 * @param {string} workerId - Worker ID
 * @param {string} output - Output content
 * @param {string} chunkType - Type of output (stdout/stderr)
 * @returns {boolean} Success status
 */
export function storeOutput(workerId, output, chunkType = 'stdout') {
  try {
    let sessionId = activeSessionIds.get(workerId);

    // If no active session, try to find one or skip
    if (!sessionId) {
      const activeSession = getActiveSession.get(workerId);
      if (activeSession) {
        sessionId = activeSession.id;
        activeSessionIds.set(workerId, sessionId);
      } else {
        // No session to store output against
        return false;
      }
    }

    // Create hash for deduplication
    const chunkHash = simpleHash(output);

    // Check if this is a duplicate of the last chunk
    const lastHash = getLastChunkHash.get(sessionId);
    if (lastHash && lastHash.chunk_hash === chunkHash) {
      // Skip duplicate
      return true;
    }

    insertOutput.run(sessionId, workerId, output, chunkType, chunkHash);
    return true;
  } catch (err) {
    console.error('[WorkerOutputDb] Failed to store output:', err.message);
    return false;
  }
}

/**
 * Get all sessions for a worker
 * @param {string} workerId - Worker ID
 * @param {Object} options - Pagination options
 * @returns {Object} Sessions with pagination info
 */
export function getWorkerSessions(workerId, options = {}) {
  const { limit: rawLimit = 20, offset = 0 } = options;
  const limit = Math.min(Math.max(1, rawLimit), 500); // Cap at 500

  try {
    const sessions = getSessionsByWorkerIdPaginated.all(workerId, limit, offset);
    const totalCount = countSessionsByWorkerId.get(workerId).count;

    return {
      sessions,
      pagination: {
        total: totalCount,
        limit,
        offset,
        hasMore: offset + sessions.length < totalCount
      }
    };
  } catch (err) {
    console.error('[WorkerOutputDb] Failed to get sessions:', err.message);
    return { sessions: [], pagination: { total: 0, limit, offset, hasMore: false } };
  }
}

/**
 * Get output history for a worker session
 * @param {number} sessionId - Session ID
 * @param {Object} options - Pagination options
 * @returns {Object} Output chunks with pagination info
 */
export function getSessionOutput(sessionId, options = {}) {
  const { limit: rawLimit = 100, offset = 0 } = options;
  const limit = Math.min(Math.max(1, rawLimit), 10000); // Cap at 10000

  try {
    const outputs = getOutputsBySessionIdPaginated.all(sessionId, limit, offset);
    const totalCount = countOutputsBySessionId.get(sessionId).count;

    return {
      outputs,
      pagination: {
        total: totalCount,
        limit,
        offset,
        hasMore: offset + outputs.length < totalCount
      }
    };
  } catch (err) {
    console.error('[WorkerOutputDb] Failed to get session output:', err.message);
    return { outputs: [], pagination: { total: 0, limit, offset, hasMore: false } };
  }
}

/**
 * Get recent output history for a worker (across all sessions)
 * @param {string} workerId - Worker ID
 * @param {Object} options - Options
 * @returns {Object} Output data
 */
export function getWorkerHistory(workerId, options = {}) {
  const { limit: rawLimit = 100, sessionId = null, offset = 0 } = options;
  const limit = Math.min(Math.max(1, rawLimit), 10000); // Cap at 10000

  try {
    if (sessionId) {
      // Get output for specific session
      return getSessionOutput(sessionId, { limit, offset });
    }

    // Get recent outputs across all sessions
    const outputs = getRecentOutputsByWorkerId.all(workerId, limit);

    // Reverse to chronological order
    outputs.reverse();

    return {
      outputs,
      pagination: {
        total: outputs.length,
        limit,
        offset: 0,
        hasMore: false
      }
    };
  } catch (err) {
    console.error('[WorkerOutputDb] Failed to get worker history:', err.message);
    return { outputs: [], pagination: { total: 0, limit, offset: 0, hasMore: false } };
  }
}

/**
 * Get full output for a session as concatenated text
 * @param {number} sessionId - Session ID
 * @returns {string} Concatenated output
 */
export function getSessionFullOutput(sessionId) {
  try {
    // Stream rows via .iterate() instead of .all() to avoid loading 50K rows into memory.
    // The 5MB cap stops iteration early — no need to pre-load the full result set.
    const MAX_OUTPUT_SIZE = 5 * 1024 * 1024;
    let totalSize = 0;
    const chunks = [];
    for (const o of getFullOutputBySessionId.iterate(sessionId)) {
      totalSize += o.output_chunk.length;
      if (totalSize > MAX_OUTPUT_SIZE) break;
      chunks.push(o.output_chunk);
    }
    return chunks.join('');
  } catch (err) {
    console.error('[WorkerOutputDb] Failed to get full output:', err.message);
    return '';
  }
}

/**
 * Clean up old data (older than specified days)
 * @param {number} daysToKeep - Number of days of data to retain
 * @returns {Object} Cleanup statistics
 */
export function cleanupOldData(daysToKeep = 7) {
  // Validate parameter to prevent accidental full deletion
  if (typeof daysToKeep !== 'number' || daysToKeep < 1 || daysToKeep > 365) {
    console.warn(`[WorkerOutputDb] Invalid daysToKeep=${daysToKeep}, using default 7`);
    daysToKeep = 7;
  }
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);
  const cutoffStr = cutoffDate.toISOString();

  try {
    // Get IDs of old sessions to delete
    const oldSessions = stmtOldSessions.all(cutoffStr);

    const sessionIds = oldSessions.map(s => s.id);

    if (sessionIds.length === 0) {
      return { sessionsDeleted: 0, outputsDeleted: 0 };
    }

    // Batch deletes in chunks of 400 to stay under SQLite's SQLITE_MAX_VARIABLE_NUMBER limit
    // (default 999 in many builds). ON DELETE CASCADE handles outputs automatically.
    // Wrap in transaction for atomicity — prevents orphaned outputs if crash mid-cleanup.
    const BATCH_SIZE = 400;
    const cleanupTx = db.transaction(() => {
      let totalOutputsDeleted = 0;
      let totalSessionsDeleted = 0;

      for (let i = 0; i < sessionIds.length; i += BATCH_SIZE) {
        const batch = sessionIds.slice(i, i + BATCH_SIZE);
        const placeholders = batch.map(() => '?').join(',');

        // Delete outputs first (redundant if CASCADE works, but safe for FK enforcement)
        const outputResult = db.prepare(
          `DELETE FROM worker_outputs WHERE session_id IN (${placeholders})`
        ).run(...batch);
        totalOutputsDeleted += outputResult.changes;

        // Delete sessions
        const sessionResult = db.prepare(
          `DELETE FROM worker_sessions WHERE id IN (${placeholders})`
        ).run(...batch);
        totalSessionsDeleted += sessionResult.changes;
      }

      return { totalOutputsDeleted, totalSessionsDeleted };
    });

    const { totalOutputsDeleted, totalSessionsDeleted } = cleanupTx();

    console.log(`[WorkerOutputDb] Cleanup: deleted ${totalSessionsDeleted} sessions, ${totalOutputsDeleted} output chunks`);

    // Size management (VACUUM) is handled by enforceDbSizeLimit() which runs
    // in the same periodic cleanup cycle. Don't VACUUM here to avoid double-VACUUM.

    return {
      sessionsDeleted: totalSessionsDeleted,
      outputsDeleted: totalOutputsDeleted
    };
  } catch (err) {
    console.error('[WorkerOutputDb] Cleanup failed:', err.message);
    return { sessionsDeleted: 0, outputsDeleted: 0, error: err.message };
  }
}

/**
 * Get database statistics
 * @returns {Object} Stats
 */
export function getStats() {
  try {
    const sessionCount = stmtSessionCount.get().count;
    const outputCount = stmtOutputCount.get().count;
    const activeSessions = stmtActiveSessionCount.get().count;

    const dbSize = fs.statSync(DB_PATH).size;

    // Get oldest and newest records
    const oldest = stmtOldestSession.get().oldest;
    const newest = stmtNewestSession.get().newest;

    return {
      totalSessions: sessionCount,
      activeSessions,
      totalOutputChunks: outputCount,
      databaseSizeBytes: dbSize,
      databaseSizeMB: (dbSize / 1024 / 1024).toFixed(2),
      oldestSession: oldest,
      newestSession: newest
    };
  } catch (err) {
    console.error('[WorkerOutputDb] Failed to get stats:', err.message);
    return { error: err.message };
  }
}

/**
 * Get session by ID
 * @param {number} sessionId - Session ID
 * @returns {Object|null} Session data
 */
export function getSession(sessionId) {
  try {
    return getSessionById.get(sessionId);
  } catch (err) {
    console.error('[WorkerOutputDb] Failed to get session:', err.message);
    return null;
  }
}

/**
 * Clean up orphaned sessions (active sessions older than specified hours)
 * This addresses sessions that were never properly ended due to server restarts,
 * worker crashes, or external tmux session termination.
 * @param {number} maxAgeHours - Maximum age in hours for "active" sessions
 * @returns {Object} Cleanup statistics
 */
export function cleanupOrphanedSessions(maxAgeHours = 24) {
  if (typeof maxAgeHours !== 'number' || maxAgeHours < 1 || maxAgeHours > 720) {
    console.warn(`[WorkerOutputDb] Invalid maxAgeHours=${maxAgeHours}, using default 24`);
    maxAgeHours = 24;
  }
  try {
    const cutoffDate = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000);
    const cutoffStr = cutoffDate.toISOString();

    // Mark orphaned sessions as ended with 'orphaned' status
    const result = stmtOrphanedSessions.run(cutoffStr);

    if (result.changes > 0) {
      console.log(`[WorkerOutputDb] Marked ${result.changes} orphaned sessions as ended`);
    }

    return { orphansCleaned: result.changes };
  } catch (err) {
    console.error('[WorkerOutputDb] Failed to cleanup orphaned sessions:', err.message);
    return { orphansCleaned: 0, error: err.message };
  }
}

// Max DB size: 200MB. If exceeded, aggressively delete oldest data.
const MAX_DB_SIZE_BYTES = 200 * 1024 * 1024;

/**
 * Size-based cleanup: if DB exceeds MAX_DB_SIZE_BYTES, delete oldest output
 * chunks until under limit. This prevents unbounded growth regardless of age.
 */
export function enforceDbSizeLimit() {
  try {
    // Checkpoint WAL first so size reflects actual data
    try { db.pragma('wal_checkpoint(PASSIVE)'); } catch (e) { /* ignore */ }

    // Check total size including WAL file
    const mainSize = fs.statSync(DB_PATH).size;
    const walPath = DB_PATH + '-wal';
    const walSize = fs.existsSync(walPath) ? fs.statSync(walPath).size : 0;
    const dbSize = mainSize + walSize;
    if (dbSize <= MAX_DB_SIZE_BYTES) return { trimmed: false, dbSizeMB: (dbSize / 1024 / 1024).toFixed(0) };

    console.log(`[WorkerOutputDb] DB is ${(dbSize / 1024 / 1024).toFixed(0)}MB (limit: ${(MAX_DB_SIZE_BYTES / 1024 / 1024)}MB) - trimming...`);

    // Delete oldest output chunks in batches until under limit
    const deleteOldest = stmtDeleteOldestOutputs;

    let rounds = 0;
    const maxRounds = 50; // Safety limit
    while (rounds < maxRounds) {
      try {
        const result = deleteOldest.run();
        if (result.changes === 0) break;
        rounds++;

        // Check size after each batch (WAL mode means size may not shrink immediately)
        const currentRows = stmtOutputRowCount.get().c;
        if (currentRows < 5000) break; // Keep at least some data
      } catch (deleteErr) {
        console.error(`[WorkerOutputDb] Delete batch failed (round ${rounds}): ${deleteErr.message}`);
        break; // Don't loop forever if DELETE itself fails (e.g. SQLITE_FULL)
      }
    }

    // VACUUM to reclaim space
    db.exec('VACUUM');
    const newSize = fs.statSync(DB_PATH).size;
    console.log(`[WorkerOutputDb] Trimmed: ${(dbSize / 1024 / 1024).toFixed(0)}MB → ${(newSize / 1024 / 1024).toFixed(0)}MB (${rounds} rounds)`);
    return { trimmed: true, oldSizeMB: (dbSize / 1024 / 1024).toFixed(0), newSizeMB: (newSize / 1024 / 1024).toFixed(0) };
  } catch (err) {
    console.error('[WorkerOutputDb] Size enforcement failed:', err.message);
    return { trimmed: false, error: err.message };
  }
}

// Run cleanup on startup (in background)
let _startupCleanupTimer = setTimeout(() => {
  if (_dbClosed) return;
  // First, mark orphaned sessions as ended (sessions >12h old that are still "active")
  const orphanResult = cleanupOrphanedSessions(12);
  if (orphanResult.orphansCleaned > 0) {
    console.log(`[WorkerOutputDb] Startup: Marked ${orphanResult.orphansCleaned} orphaned sessions as ended`);
  }

  // Delete old ended sessions (>1 day instead of 3)
  const result = cleanupOldData(1);
  if (result.sessionsDeleted > 0 || result.outputsDeleted > 0) {
    console.log(`[WorkerOutputDb] Startup cleanup: ${result.sessionsDeleted} old sessions, ${result.outputsDeleted} output chunks removed`);
  }

  // Enforce size limit
  enforceDbSizeLimit();
}, 5000);

// Schedule periodic cleanup (every 30 minutes instead of 6 hours)
let _periodicCleanupInterval = setInterval(() => {
  try {
    cleanupOldData(1);
    cleanupOrphanedSessions(12); // Catch sessions orphaned mid-run (not just at startup)
    enforceDbSizeLimit();
  } catch (err) {
    console.error('[WorkerOutputDb] Periodic cleanup failed:', err.message);
  }
  // Checkpoint WAL to prevent unbounded WAL growth
  // Escalate to RESTART if PASSIVE leaves too many pages uncheckpointed (active readers block PASSIVE)
  try {
    const walResult = db.pragma('wal_checkpoint(PASSIVE)');
    const walInfo = walResult[0];
    if (walInfo && walInfo.log > 1000 && walInfo.checkpointed < walInfo.log) {
      db.pragma('wal_checkpoint(RESTART)');
    }
  } catch (e) { /* best effort */ }
}, 30 * 60 * 1000);
if (_periodicCleanupInterval.unref) _periodicCleanupInterval.unref();

let _dbClosed = false;
export function closeDatabase() {
  if (_startupCleanupTimer) {
    clearTimeout(_startupCleanupTimer);
    _startupCleanupTimer = null;
  }
  if (_periodicCleanupInterval) {
    clearInterval(_periodicCleanupInterval);
    _periodicCleanupInterval = null;
  }
  if (_dbClosed) return;
  _dbClosed = true;
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
    console.log('[WorkerOutputDb] Database closed cleanly');
  } catch (err) {
    console.error('[WorkerOutputDb] Error closing database:', err.message);
  }
}

export default {
  startSession,
  endSession,
  storeOutput,
  getWorkerSessions,
  getSessionOutput,
  getWorkerHistory,
  getSessionFullOutput,
  cleanupOldData,
  cleanupOrphanedSessions,
  enforceDbSizeLimit,
  getStats,
  getSession,
  closeDatabase
};
