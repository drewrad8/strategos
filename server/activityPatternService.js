import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { getActivityLog } from './workerManager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Store database in server/.tmp directory (per CLAUDE.md rules)
const DB_DIR = path.join(__dirname, '.tmp');
const DB_PATH = path.join(DB_DIR, 'activity_patterns.db');

// Ensure directory exists
import fs from 'fs';
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

// Initialize database
const db = new Database(DB_PATH);

// Create tables for pattern storage
db.exec(`
  -- Raw activity events for pattern mining
  CREATE TABLE IF NOT EXISTS activity_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT UNIQUE,
    timestamp TEXT NOT NULL,
    type TEXT NOT NULL,
    worker_id TEXT,
    worker_label TEXT,
    project TEXT,
    message TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  -- Detected activity sequences
  CREATE TABLE IF NOT EXISTS activity_sequences (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sequence_hash TEXT UNIQUE,
    sequence_types TEXT NOT NULL,  -- JSON array of event types
    sequence_projects TEXT,        -- JSON array of projects involved
    occurrence_count INTEGER DEFAULT 1,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    avg_duration_ms INTEGER,
    suggested_workflow TEXT,       -- Generated workflow suggestion
    workflow_confidence REAL DEFAULT 0.0
  );

  -- Workflow suggestions derived from patterns
  CREATE TABLE IF NOT EXISTS workflow_suggestions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    source_sequence_id INTEGER,
    workflow_yaml TEXT NOT NULL,   -- thea-architect workflow YAML
    confidence_score REAL DEFAULT 0.0,
    times_suggested INTEGER DEFAULT 0,
    times_accepted INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (source_sequence_id) REFERENCES activity_sequences(id)
  );

  -- Index for faster lookups
  CREATE INDEX IF NOT EXISTS idx_events_type ON activity_events(type);
  CREATE INDEX IF NOT EXISTS idx_events_project ON activity_events(project);
  CREATE INDEX IF NOT EXISTS idx_events_timestamp ON activity_events(timestamp);
  CREATE INDEX IF NOT EXISTS idx_sequences_count ON activity_sequences(occurrence_count DESC);
`);

// Prepared statements for performance
const insertEvent = db.prepare(`
  INSERT OR IGNORE INTO activity_events (event_id, timestamp, type, worker_id, worker_label, project, message)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const insertSequence = db.prepare(`
  INSERT INTO activity_sequences (sequence_hash, sequence_types, sequence_projects, first_seen, last_seen, avg_duration_ms)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(sequence_hash) DO UPDATE SET
    occurrence_count = occurrence_count + 1,
    last_seen = excluded.last_seen,
    avg_duration_ms = (avg_duration_ms + excluded.avg_duration_ms) / 2
`);

const updateSequenceWorkflow = db.prepare(`
  UPDATE activity_sequences
  SET suggested_workflow = ?, workflow_confidence = ?
  WHERE id = ?
`);

const insertWorkflow = db.prepare(`
  INSERT INTO workflow_suggestions (name, description, source_sequence_id, workflow_yaml, confidence_score)
  VALUES (?, ?, ?, ?, ?)
`);

/**
 * Store a single activity event
 */
export function storeActivityEvent(event) {
  try {
    insertEvent.run(
      event.id,
      new Date(event.timestamp).toISOString(),
      event.type,
      event.workerId,
      event.workerLabel,
      event.project,
      event.message
    );
    return true;
  } catch (err) {
    console.error('Failed to store activity event:', err.message);
    return false;
  }
}

/**
 * Sync current activity log to database
 */
export function syncActivityLog() {
  const log = getActivityLog();
  let synced = 0;

  const insertMany = db.transaction((events) => {
    for (const event of events) {
      const result = insertEvent.run(
        event.id,
        new Date(event.timestamp).toISOString(),
        event.type,
        event.workerId,
        event.workerLabel,
        event.project,
        event.message
      );
      if (result.changes > 0) synced++;
    }
  });

  insertMany(log);
  return synced;
}

/**
 * Create a hash for a sequence of event types
 */
function hashSequence(types) {
  return types.join('->');
}

/**
 * Detect common sequences in activity data
 */
export function detectSequences(windowSize = 3, minOccurrences = 2) {
  // Get recent events
  const events = db.prepare(`
    SELECT * FROM activity_events
    ORDER BY timestamp DESC
    LIMIT 1000
  `).all();

  if (events.length < windowSize) {
    return [];
  }

  // Reverse to chronological order
  events.reverse();

  // Sliding window to find sequences
  const sequenceCounts = new Map();

  for (let i = 0; i <= events.length - windowSize; i++) {
    const window = events.slice(i, i + windowSize);
    const types = window.map(e => e.type);
    const projects = [...new Set(window.map(e => e.project))];
    const hash = hashSequence(types);

    const firstTime = new Date(window[0].timestamp).getTime();
    const lastTime = new Date(window[window.length - 1].timestamp).getTime();
    const duration = lastTime - firstTime;

    if (!sequenceCounts.has(hash)) {
      sequenceCounts.set(hash, {
        types,
        projects: new Set(projects),
        count: 0,
        firstSeen: window[0].timestamp,
        lastSeen: window[window.length - 1].timestamp,
        durations: []
      });
    }

    const seq = sequenceCounts.get(hash);
    seq.count++;
    seq.projects = new Set([...seq.projects, ...projects]);
    seq.lastSeen = window[window.length - 1].timestamp;
    seq.durations.push(duration);
  }

  // Filter by minimum occurrences and store
  const frequentSequences = [];

  for (const [hash, data] of sequenceCounts) {
    if (data.count >= minOccurrences) {
      const avgDuration = data.durations.reduce((a, b) => a + b, 0) / data.durations.length;

      insertSequence.run(
        hash,
        JSON.stringify(data.types),
        JSON.stringify([...data.projects]),
        data.firstSeen,
        data.lastSeen,
        Math.round(avgDuration)
      );

      frequentSequences.push({
        hash,
        types: data.types,
        projects: [...data.projects],
        count: data.count,
        avgDurationMs: Math.round(avgDuration)
      });
    }
  }

  return frequentSequences;
}

/**
 * Generate a thea-architect workflow from a detected sequence
 */
function generateWorkflowFromSequence(sequence) {
  const { types, projects } = sequence;

  // Map activity types to workflow steps
  const stepTemplates = {
    'worker_started': {
      action: 'spawn_worker',
      template: (project) => ({
        name: `Start worker for ${project}`,
        action: 'spawn',
        project: project,
        wait_for: 'ready'
      })
    },
    'worker_stopped': {
      action: 'cleanup',
      template: (project) => ({
        name: `Stop worker for ${project}`,
        action: 'kill',
        project: project
      })
    },
    'command_sent': {
      action: 'execute',
      template: (project) => ({
        name: `Execute task on ${project}`,
        action: 'send_command',
        project: project,
        command: '{{task_description}}'
      })
    },
    'error': {
      action: 'handle_error',
      template: (project) => ({
        name: `Handle error in ${project}`,
        action: 'error_handler',
        project: project,
        on_error: 'notify'
      })
    }
  };

  // Build workflow steps
  const steps = [];
  const seenProjects = new Set();

  for (let i = 0; i < types.length; i++) {
    const type = types[i];
    const project = projects[i % projects.length] || projects[0] || 'project';
    const template = stepTemplates[type];

    if (template) {
      steps.push(template.template(project));
      seenProjects.add(project);
    }
  }

  // Generate workflow name from pattern
  const actionVerbs = types.map(t => {
    switch(t) {
      case 'worker_started': return 'start';
      case 'worker_stopped': return 'stop';
      case 'command_sent': return 'execute';
      case 'error': return 'handle-error';
      default: return t;
    }
  });

  const workflowName = `auto-${actionVerbs.join('-then-')}`;

  // Build YAML workflow
  const workflow = {
    name: workflowName,
    description: `Auto-generated workflow from observed pattern: ${types.join(' → ')}`,
    triggers: {
      manual: true,
      schedule: null
    },
    variables: {
      target_projects: [...seenProjects]
    },
    steps: steps
  };

  // Convert to YAML-like string (simplified)
  const yamlStr = `name: ${workflow.name}
description: "${workflow.description}"
triggers:
  manual: true
variables:
  target_projects:
${[...seenProjects].map(p => `    - ${p}`).join('\n')}
steps:
${steps.map((step, i) => `  - name: "${step.name}"
    action: ${step.action}
    project: ${step.project}${step.command ? `
    command: "${step.command}"` : ''}${step.wait_for ? `
    wait_for: ${step.wait_for}` : ''}${step.on_error ? `
    on_error: ${step.on_error}` : ''}`).join('\n')}
`;

  return {
    name: workflowName,
    description: workflow.description,
    yaml: yamlStr,
    confidence: calculateConfidence(sequence)
  };
}

/**
 * Calculate confidence score for a workflow suggestion
 */
function calculateConfidence(sequence) {
  let score = 0;

  // Higher occurrence count = higher confidence
  score += Math.min(sequence.count / 10, 0.4);

  // More diverse projects = potentially more useful
  if (sequence.projects && sequence.projects.length > 1) {
    score += 0.1;
  }

  // Certain patterns are more valuable
  const hasStart = sequence.types.includes('worker_started');
  const hasStop = sequence.types.includes('worker_stopped');

  if (hasStart && hasStop) {
    score += 0.2; // Complete lifecycle patterns are valuable
  }

  // Reasonable duration indicates intentional workflow
  if (sequence.avgDurationMs > 1000 && sequence.avgDurationMs < 300000) {
    score += 0.2;
  }

  return Math.min(score, 1.0);
}

/**
 * Analyze activity patterns and generate workflow suggestions
 */
export function analyzeAndSuggestWorkflows(options = {}) {
  const {
    windowSize = 3,
    minOccurrences = 2,
    minConfidence = 0.3
  } = options;

  // First sync any new activity
  const synced = syncActivityLog();

  // Detect sequences
  const sequences = detectSequences(windowSize, minOccurrences);

  // Generate workflows for high-confidence sequences
  const suggestions = [];

  for (const seq of sequences) {
    const workflow = generateWorkflowFromSequence(seq);

    if (workflow.confidence >= minConfidence) {
      // Get sequence ID for linking
      const seqRow = db.prepare(`
        SELECT id FROM activity_sequences WHERE sequence_hash = ?
      `).get(seq.hash);

      if (seqRow) {
        // Update sequence with workflow
        updateSequenceWorkflow.run(workflow.yaml, workflow.confidence, seqRow.id);

        // Store workflow suggestion
        insertWorkflow.run(
          workflow.name,
          workflow.description,
          seqRow.id,
          workflow.yaml,
          workflow.confidence
        );
      }

      suggestions.push({
        name: workflow.name,
        description: workflow.description,
        yaml: workflow.yaml,
        confidence: workflow.confidence,
        sourcePattern: {
          types: seq.types,
          projects: seq.projects,
          occurrences: seq.count
        }
      });
    }
  }

  return {
    eventsSynced: synced,
    sequencesDetected: sequences.length,
    workflowsGenerated: suggestions.length,
    suggestions: suggestions.sort((a, b) => b.confidence - a.confidence)
  };
}

/**
 * Get stored workflow suggestions
 */
export function getWorkflowSuggestions(limit = 10) {
  return db.prepare(`
    SELECT
      ws.*,
      aseq.sequence_types,
      aseq.sequence_projects,
      aseq.occurrence_count
    FROM workflow_suggestions ws
    LEFT JOIN activity_sequences aseq ON ws.source_sequence_id = aseq.id
    ORDER BY ws.confidence_score DESC, ws.times_suggested DESC
    LIMIT ?
  `).all(limit);
}

/**
 * Get pattern statistics
 */
export function getPatternStats() {
  const eventCount = db.prepare('SELECT COUNT(*) as count FROM activity_events').get();
  const sequenceCount = db.prepare('SELECT COUNT(*) as count FROM activity_sequences').get();
  const workflowCount = db.prepare('SELECT COUNT(*) as count FROM workflow_suggestions').get();

  const topSequences = db.prepare(`
    SELECT sequence_types, occurrence_count, workflow_confidence
    FROM activity_sequences
    ORDER BY occurrence_count DESC
    LIMIT 5
  `).all();

  const recentEvents = db.prepare(`
    SELECT type, project, timestamp
    FROM activity_events
    ORDER BY timestamp DESC
    LIMIT 10
  `).all();

  return {
    totalEvents: eventCount.count,
    totalSequences: sequenceCount.count,
    totalWorkflows: workflowCount.count,
    topSequences: topSequences.map(s => ({
      types: JSON.parse(s.sequence_types),
      occurrences: s.occurrence_count,
      confidence: s.workflow_confidence
    })),
    recentEvents
  };
}

/**
 * Mark a workflow as accepted by user
 */
export function acceptWorkflow(workflowId) {
  db.prepare(`
    UPDATE workflow_suggestions
    SET times_accepted = times_accepted + 1
    WHERE id = ?
  `).run(workflowId);
}

/**
 * Clear all pattern data (for testing/reset)
 */
export function clearPatternData() {
  db.exec(`
    DELETE FROM workflow_suggestions;
    DELETE FROM activity_sequences;
    DELETE FROM activity_events;
  `);
}
