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
  fs.mkdirSync(DB_DIR, { recursive: true });
}

// Initialize database
const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent read/write performance
db.pragma('journal_mode = WAL');

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
    hash = hash & hash;
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
  const { limit = 20, offset = 0 } = options;

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
  const { limit = 100, offset = 0 } = options;

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
  const { limit = 100, sessionId = null, offset = 0 } = options;

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
    const outputs = getOutputsBySessionId.all(sessionId);
    return outputs.map(o => o.output_chunk).join('');
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
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);
  const cutoffStr = cutoffDate.toISOString();

  try {
    // Get IDs of old sessions to delete
    const oldSessions = db.prepare(`
      SELECT id FROM worker_sessions
      WHERE started_at < ? AND ended_at IS NOT NULL
    `).all(cutoffStr);

    const sessionIds = oldSessions.map(s => s.id);

    if (sessionIds.length === 0) {
      return { sessionsDeleted: 0, outputsDeleted: 0 };
    }

    // Delete outputs first (foreign key constraint)
    const outputResult = db.prepare(`
      DELETE FROM worker_outputs
      WHERE session_id IN (${sessionIds.join(',')})
    `).run();

    // Delete sessions
    const sessionResult = db.prepare(`
      DELETE FROM worker_sessions
      WHERE id IN (${sessionIds.join(',')})
    `).run();

    console.log(`[WorkerOutputDb] Cleanup: deleted ${sessionResult.changes} sessions, ${outputResult.changes} output chunks`);

    return {
      sessionsDeleted: sessionResult.changes,
      outputsDeleted: outputResult.changes
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
    const sessionCount = db.prepare('SELECT COUNT(*) as count FROM worker_sessions').get().count;
    const outputCount = db.prepare('SELECT COUNT(*) as count FROM worker_outputs').get().count;
    const activeSessions = db.prepare('SELECT COUNT(*) as count FROM worker_sessions WHERE ended_at IS NULL').get().count;

    const dbSize = fs.statSync(DB_PATH).size;

    // Get oldest and newest records
    const oldest = db.prepare('SELECT MIN(started_at) as oldest FROM worker_sessions').get().oldest;
    const newest = db.prepare('SELECT MAX(started_at) as newest FROM worker_sessions').get().newest;

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
 * Update session task description
 * @param {string} workerId - Worker ID
 * @param {string} taskDescription - Task description
 */
export function updateSessionTask(workerId, taskDescription) {
  try {
    const sessionId = activeSessionIds.get(workerId);
    if (sessionId) {
      db.prepare(`
        UPDATE worker_sessions SET task_description = ? WHERE id = ?
      `).run(taskDescription, sessionId);
      return true;
    }
    return false;
  } catch (err) {
    console.error('[WorkerOutputDb] Failed to update task:', err.message);
    return false;
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
  try {
    const cutoffDate = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000);
    const cutoffStr = cutoffDate.toISOString();

    // Mark orphaned sessions as ended with 'orphaned' status
    const result = db.prepare(`
      UPDATE worker_sessions
      SET ended_at = CURRENT_TIMESTAMP, final_status = 'orphaned'
      WHERE ended_at IS NULL
      AND started_at < ?
    `).run(cutoffStr);

    if (result.changes > 0) {
      console.log(`[WorkerOutputDb] Marked ${result.changes} orphaned sessions as ended`);
    }

    return { orphansCleaned: result.changes };
  } catch (err) {
    console.error('[WorkerOutputDb] Failed to cleanup orphaned sessions:', err.message);
    return { orphansCleaned: 0, error: err.message };
  }
}

// Run cleanup on startup (in background)
setTimeout(() => {
  // First, mark orphaned sessions as ended (sessions >24h old that are still "active")
  const orphanResult = cleanupOrphanedSessions(24);
  if (orphanResult.orphansCleaned > 0) {
    console.log(`[WorkerOutputDb] Startup: Marked ${orphanResult.orphansCleaned} orphaned sessions as ended`);
  }

  // Then delete old ended sessions (>3 days)
  const result = cleanupOldData(3);
  if (result.sessionsDeleted > 0 || result.outputsDeleted > 0) {
    console.log(`[WorkerOutputDb] Startup cleanup: ${result.sessionsDeleted} old sessions, ${result.outputsDeleted} output chunks removed`);
  }
}, 5000);

// Schedule periodic cleanup (every 6 hours)
setInterval(() => {
  cleanupOldData(3);
}, 6 * 60 * 60 * 1000);

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
  getStats,
  getSession,
  updateSessionTask
};
