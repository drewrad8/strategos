import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Use the same database directory as workerOutputDb
const DB_DIR = path.join(__dirname, '.tmp');
const DB_PATH = path.join(DB_DIR, 'worker_outputs.db');

// Ensure directory exists
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

// Initialize database (same DB as worker_outputs, add Ralph tables)
const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent read/write performance
db.pragma('journal_mode = WAL');

// Create Ralph-specific tables
db.exec(`
  -- PRD definitions
  CREATE TABLE IF NOT EXISTS ralph_prds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    project_path TEXT NOT NULL,
    stories_json TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  -- Execution runs
  CREATE TABLE IF NOT EXISTS ralph_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    prd_id INTEGER NOT NULL,
    status TEXT DEFAULT 'pending',
    current_iteration INTEGER DEFAULT 0,
    max_iterations INTEGER DEFAULT 10,
    started_at TEXT,
    completed_at TEXT,
    error_message TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (prd_id) REFERENCES ralph_prds(id)
  );

  -- Story status within a run
  CREATE TABLE IF NOT EXISTS ralph_story_status (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL,
    story_index INTEGER NOT NULL,
    status TEXT DEFAULT 'pending',
    worker_id TEXT,
    started_at TEXT,
    completed_at TEXT,
    error_message TEXT,
    FOREIGN KEY (run_id) REFERENCES ralph_runs(id)
  );

  -- Progress/learnings between iterations
  CREATE TABLE IF NOT EXISTS ralph_progress (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL,
    iteration INTEGER NOT NULL,
    story_index INTEGER,
    content TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (run_id) REFERENCES ralph_runs(id)
  );

  -- Indexes
  CREATE INDEX IF NOT EXISTS idx_ralph_runs_prd_id ON ralph_runs(prd_id);
  CREATE INDEX IF NOT EXISTS idx_ralph_runs_status ON ralph_runs(status);
  CREATE INDEX IF NOT EXISTS idx_ralph_story_status_run ON ralph_story_status(run_id);
  CREATE INDEX IF NOT EXISTS idx_ralph_progress_run ON ralph_progress(run_id);
`);

// Prepared statements for PRDs
const insertPrd = db.prepare(`
  INSERT INTO ralph_prds (name, description, project_path, stories_json)
  VALUES (?, ?, ?, ?)
`);

const updatePrd = db.prepare(`
  UPDATE ralph_prds
  SET name = ?, description = ?, project_path = ?, stories_json = ?, updated_at = CURRENT_TIMESTAMP
  WHERE id = ?
`);

const getPrdById = db.prepare(`
  SELECT * FROM ralph_prds WHERE id = ?
`);

const getAllPrds = db.prepare(`
  SELECT * FROM ralph_prds ORDER BY created_at DESC
`);

const deletePrdById = db.prepare(`
  DELETE FROM ralph_prds WHERE id = ?
`);

// Prepared statements for runs
const insertRun = db.prepare(`
  INSERT INTO ralph_runs (prd_id, max_iterations)
  VALUES (?, ?)
`);

const updateRunStatus = db.prepare(`
  UPDATE ralph_runs
  SET status = ?, started_at = COALESCE(started_at, CURRENT_TIMESTAMP)
  WHERE id = ?
`);

const updateRunIteration = db.prepare(`
  UPDATE ralph_runs SET current_iteration = ? WHERE id = ?
`);

const updateRunComplete = db.prepare(`
  UPDATE ralph_runs
  SET status = ?, completed_at = CURRENT_TIMESTAMP, error_message = ?
  WHERE id = ?
`);

const getRunById = db.prepare(`
  SELECT * FROM ralph_runs WHERE id = ?
`);

const getRunsByPrdId = db.prepare(`
  SELECT * FROM ralph_runs WHERE prd_id = ? ORDER BY created_at DESC
`);

const getAllRuns = db.prepare(`
  SELECT r.*, p.name as prd_name, p.project_path
  FROM ralph_runs r
  JOIN ralph_prds p ON r.prd_id = p.id
  ORDER BY r.created_at DESC
`);

const getActiveRuns = db.prepare(`
  SELECT r.*, p.name as prd_name, p.project_path
  FROM ralph_runs r
  JOIN ralph_prds p ON r.prd_id = p.id
  WHERE r.status IN ('pending', 'running', 'paused')
  ORDER BY r.created_at DESC
`);

// Prepared statements for story status
const insertStoryStatus = db.prepare(`
  INSERT INTO ralph_story_status (run_id, story_index, status)
  VALUES (?, ?, 'pending')
`);

const updateStoryStatus = db.prepare(`
  UPDATE ralph_story_status
  SET status = ?, worker_id = ?, started_at = COALESCE(started_at, CURRENT_TIMESTAMP)
  WHERE run_id = ? AND story_index = ?
`);

const updateStoryComplete = db.prepare(`
  UPDATE ralph_story_status
  SET status = ?, completed_at = CURRENT_TIMESTAMP, error_message = ?
  WHERE run_id = ? AND story_index = ?
`);

const getStoryStatusByRun = db.prepare(`
  SELECT * FROM ralph_story_status WHERE run_id = ? ORDER BY story_index
`);

const getStoryStatus = db.prepare(`
  SELECT * FROM ralph_story_status WHERE run_id = ? AND story_index = ?
`);

// Prepared statements for progress
const insertProgress = db.prepare(`
  INSERT INTO ralph_progress (run_id, iteration, story_index, content)
  VALUES (?, ?, ?, ?)
`);

const getProgressByRun = db.prepare(`
  SELECT * FROM ralph_progress WHERE run_id = ? ORDER BY iteration DESC
`);

const getLatestProgress = db.prepare(`
  SELECT * FROM ralph_progress WHERE run_id = ? ORDER BY iteration DESC LIMIT 1
`);

// =====================
// PRD Functions
// =====================

/**
 * Create a new PRD
 * @param {string} name - PRD name
 * @param {string} description - PRD description
 * @param {string} projectPath - Path to the project
 * @param {Array} stories - Array of user story objects
 * @returns {Object} Created PRD
 */
export function createPrd(name, description, projectPath, stories) {
  try {
    const storiesJson = JSON.stringify(stories);
    const result = insertPrd.run(name, description, projectPath, storiesJson);
    const prd = getPrdById.get(result.lastInsertRowid);
    console.log(`[RalphDb] Created PRD ${prd.id}: ${name}`);
    return {
      ...prd,
      stories: JSON.parse(prd.stories_json)
    };
  } catch (err) {
    console.error('[RalphDb] Failed to create PRD:', err.message);
    throw err;
  }
}

/**
 * Get a PRD by ID
 * @param {number} prdId - PRD ID
 * @returns {Object|null} PRD with parsed stories
 */
export function getPrd(prdId) {
  try {
    const prd = getPrdById.get(prdId);
    if (!prd) return null;
    return {
      ...prd,
      stories: JSON.parse(prd.stories_json)
    };
  } catch (err) {
    console.error('[RalphDb] Failed to get PRD:', err.message);
    return null;
  }
}

/**
 * Update a PRD
 * @param {number} prdId - PRD ID
 * @param {Object} updates - Fields to update
 * @returns {Object|null} Updated PRD
 */
export function updatePrdData(prdId, updates) {
  try {
    const existing = getPrd(prdId);
    if (!existing) return null;

    const name = updates.name ?? existing.name;
    const description = updates.description ?? existing.description;
    const projectPath = updates.projectPath ?? existing.project_path;
    const stories = updates.stories ?? existing.stories;
    const storiesJson = JSON.stringify(stories);

    updatePrd.run(name, description, projectPath, storiesJson, prdId);
    return getPrd(prdId);
  } catch (err) {
    console.error('[RalphDb] Failed to update PRD:', err.message);
    throw err;
  }
}

/**
 * List all PRDs
 * @returns {Array} Array of PRDs with parsed stories
 */
export function listPrds() {
  try {
    const prds = getAllPrds.all();
    return prds.map(prd => ({
      ...prd,
      stories: JSON.parse(prd.stories_json)
    }));
  } catch (err) {
    console.error('[RalphDb] Failed to list PRDs:', err.message);
    return [];
  }
}

/**
 * Delete a PRD
 * @param {number} prdId - PRD ID
 * @returns {boolean} Success
 */
export function deletePrd(prdId) {
  try {
    const result = deletePrdById.run(prdId);
    return result.changes > 0;
  } catch (err) {
    console.error('[RalphDb] Failed to delete PRD:', err.message);
    return false;
  }
}

// =====================
// Run Functions
// =====================

/**
 * Create a new run for a PRD
 * @param {number} prdId - PRD ID
 * @param {number} maxIterations - Maximum iterations
 * @returns {Object} Created run with story statuses initialized
 */
export function createRun(prdId, maxIterations = 10) {
  try {
    const prd = getPrd(prdId);
    if (!prd) throw new Error(`PRD ${prdId} not found`);

    const result = insertRun.run(prdId, maxIterations);
    const runId = result.lastInsertRowid;

    // Initialize story status for each story
    for (let i = 0; i < prd.stories.length; i++) {
      insertStoryStatus.run(runId, i);
    }

    const run = getRunById.get(runId);
    console.log(`[RalphDb] Created run ${runId} for PRD ${prdId}`);
    return {
      ...run,
      stories: getStoryStatusByRun.all(runId)
    };
  } catch (err) {
    console.error('[RalphDb] Failed to create run:', err.message);
    throw err;
  }
}

/**
 * Get a run by ID
 * @param {number} runId - Run ID
 * @returns {Object|null} Run with story statuses
 */
export function getRun(runId) {
  try {
    const run = getRunById.get(runId);
    if (!run) return null;

    const prd = getPrd(run.prd_id);
    return {
      ...run,
      prd,
      stories: getStoryStatusByRun.all(runId)
    };
  } catch (err) {
    console.error('[RalphDb] Failed to get run:', err.message);
    return null;
  }
}

/**
 * List all runs
 * @returns {Array} Array of runs
 */
export function listRuns() {
  try {
    return getAllRuns.all();
  } catch (err) {
    console.error('[RalphDb] Failed to list runs:', err.message);
    return [];
  }
}

/**
 * Get active runs (pending, running, paused)
 * @returns {Array} Array of active runs
 */
export function getActiveRunsList() {
  try {
    return getActiveRuns.all();
  } catch (err) {
    console.error('[RalphDb] Failed to get active runs:', err.message);
    return [];
  }
}

/**
 * Update run status
 * @param {number} runId - Run ID
 * @param {string} status - New status
 */
export function setRunStatus(runId, status) {
  try {
    updateRunStatus.run(status, runId);
    console.log(`[RalphDb] Run ${runId} status: ${status}`);
  } catch (err) {
    console.error('[RalphDb] Failed to update run status:', err.message);
  }
}

/**
 * Update run iteration
 * @param {number} runId - Run ID
 * @param {number} iteration - Current iteration
 */
export function setRunIteration(runId, iteration) {
  try {
    updateRunIteration.run(iteration, runId);
  } catch (err) {
    console.error('[RalphDb] Failed to update run iteration:', err.message);
  }
}

/**
 * Mark run as complete
 * @param {number} runId - Run ID
 * @param {string} status - Final status (completed, failed)
 * @param {string} errorMessage - Error message if failed
 */
export function completeRun(runId, status, errorMessage = null) {
  try {
    updateRunComplete.run(status, errorMessage, runId);
    console.log(`[RalphDb] Run ${runId} completed: ${status}`);
  } catch (err) {
    console.error('[RalphDb] Failed to complete run:', err.message);
  }
}

// =====================
// Story Status Functions
// =====================

/**
 * Update story status
 * @param {number} runId - Run ID
 * @param {number} storyIndex - Story index
 * @param {string} status - New status
 * @param {string} workerId - Worker ID (optional)
 */
export function setStoryStatus(runId, storyIndex, status, workerId = null) {
  try {
    updateStoryStatus.run(status, workerId, runId, storyIndex);
    console.log(`[RalphDb] Run ${runId} story ${storyIndex}: ${status}`);
  } catch (err) {
    console.error('[RalphDb] Failed to update story status:', err.message);
  }
}

/**
 * Mark story as complete
 * @param {number} runId - Run ID
 * @param {number} storyIndex - Story index
 * @param {string} status - Final status (completed, failed)
 * @param {string} errorMessage - Error message if failed
 */
export function completeStory(runId, storyIndex, status, errorMessage = null) {
  try {
    updateStoryComplete.run(status, errorMessage, runId, storyIndex);
    console.log(`[RalphDb] Run ${runId} story ${storyIndex} completed: ${status}`);
  } catch (err) {
    console.error('[RalphDb] Failed to complete story:', err.message);
  }
}

/**
 * Get story statuses for a run
 * @param {number} runId - Run ID
 * @returns {Array} Array of story statuses
 */
export function getStoryStatuses(runId) {
  try {
    return getStoryStatusByRun.all(runId);
  } catch (err) {
    console.error('[RalphDb] Failed to get story statuses:', err.message);
    return [];
  }
}

// =====================
// Progress Functions
// =====================

/**
 * Store progress/learnings for an iteration
 * @param {number} runId - Run ID
 * @param {number} iteration - Iteration number
 * @param {string} content - Progress content
 * @param {number} storyIndex - Story index (optional)
 */
export function storeProgress(runId, iteration, content, storyIndex = null) {
  try {
    insertProgress.run(runId, iteration, storyIndex, content);
    console.log(`[RalphDb] Stored progress for run ${runId} iteration ${iteration}`);
  } catch (err) {
    console.error('[RalphDb] Failed to store progress:', err.message);
  }
}

/**
 * Get progress history for a run
 * @param {number} runId - Run ID
 * @returns {Array} Array of progress entries
 */
export function getProgress(runId) {
  try {
    return getProgressByRun.all(runId);
  } catch (err) {
    console.error('[RalphDb] Failed to get progress:', err.message);
    return [];
  }
}

/**
 * Get the most recent progress for a run
 * @param {number} runId - Run ID
 * @returns {Object|null} Latest progress entry
 */
export function getLatestProgressEntry(runId) {
  try {
    return getLatestProgress.get(runId);
  } catch (err) {
    console.error('[RalphDb] Failed to get latest progress:', err.message);
    return null;
  }
}

export default {
  // PRDs
  createPrd,
  getPrd,
  updatePrd: updatePrdData,
  listPrds,
  deletePrd,

  // Runs
  createRun,
  getRun,
  listRuns,
  getActiveRuns: getActiveRunsList,
  setRunStatus,
  setRunIteration,
  completeRun,

  // Story Status
  setStoryStatus,
  completeStory,
  getStoryStatuses,

  // Progress
  storeProgress,
  getProgress,
  getLatestProgress: getLatestProgressEntry
};
