/**
 * Worker Routes - CRUD, spawn, kill, input, output, dependencies, hierarchy
 * Base path: /api/workers
 */

import express from 'express';
import {
  getWorkers,
  getWorker,
  getWorkerInternal,
  spawnWorker,
  killWorker,
  dismissWorker,
  updateWorkerLabel,
  updateWorkerSettings,
  sendInput,
  interruptWorker,
  getWorkerOutput,
  completeWorker,
  getWorkerDependencies,
  getPendingWorkers,
  getChildWorkers,
  getSiblingWorkers,
  getWorkerEfficiency,
  normalizeWorker,
  processQueue
} from '../workerManager.js';
import {
  safeResolvePath,
  projectExists
} from '../projectScanner.js';
import {
  generateSummary,
  getWorkerContext,
  getQuickStatus,
  executePrompt
} from '../summaryService.js';
import {
  getWorkerSessions,
  getWorkerHistory
} from '../workerOutputDb.js';
import { sanitizeErrorMessage } from '../errorUtils.js';
import {
  VALID_WORKER_ID, VALID_SIMPLE_ID, CONTROL_CHAR_RE, MULTILINE_CONTROL_CHAR_RE,
  MAX_TASK_LENGTH, MAX_LABEL_LENGTH, MAX_INPUT_LENGTH, MAX_PROMPT_LENGTH,
  isValidSessionId
} from '../validation.js';
import { getReviewResult, addReviewResult } from '../learningsDb.js';

// =============================================
// SPAWN TEMPLATES - Simplified worker spawning
// =============================================

const SPAWN_TEMPLATES = {
  research: {
    prefix: 'RESEARCH',
    autoAccept: true,
    ralphMode: true,
    model: 'sonnet'
  },
  impl: {
    prefix: 'IMPL',
    autoAccept: true,
    ralphMode: true,
    model: 'sonnet'
  },
  test: {
    prefix: 'TEST',
    autoAccept: true,
    ralphMode: true,
    model: 'haiku'
  },
  review: {
    prefix: 'REVIEW',
    autoAccept: true,
    ralphMode: true,
    model: 'haiku'
  },
  fix: {
    prefix: 'FIX',
    autoAccept: true,
    ralphMode: true,
    model: 'sonnet'
  },
  general: {
    prefix: 'GENERAL',
    autoAccept: true, // GENERALs need auto-accept to run curl commands; pause-keywords provide safety
    ralphMode: true,
    forcedAutonomy: true, // GENERALs are continuous-ops workers — always nudge them to find more work
    model: 'sonnet'
  },
  colonel: {
    prefix: 'COLONEL',
    autoAccept: true,
    ralphMode: true,
    model: 'sonnet'
  },
  captain: {
    prefix: 'CAPTAIN',
    autoAccept: true,
    ralphMode: true,
    model: 'sonnet'
  },
  // Gemini CLI backend templates
  'gemini-research': {
    prefix: 'RESEARCH',
    autoAccept: true,
    ralphMode: true,
    backend: 'gemini'
  },
  'gemini-impl': {
    prefix: 'IMPL',
    autoAccept: true,
    ralphMode: true,
    backend: 'gemini'
  },
  'gemini-test': {
    prefix: 'TEST',
    autoAccept: true,
    ralphMode: true,
    backend: 'gemini'
  },
  'gemini-review': {
    prefix: 'REVIEW',
    autoAccept: true,
    ralphMode: true,
    backend: 'gemini'
  },
  'gemini-fix': {
    prefix: 'FIX',
    autoAccept: true,
    ralphMode: true,
    backend: 'gemini'
  },
  'gemini-general': {
    prefix: 'GENERAL',
    autoAccept: true,
    ralphMode: true,
    backend: 'gemini'
  },
  'gemini-colonel': {
    prefix: 'COLONEL',
    autoAccept: true,
    ralphMode: true,
    backend: 'gemini'
  },
  // Aider (Ollama) backend templates
  'aider-research': {
    prefix: 'RESEARCH',
    autoAccept: true,
    ralphMode: true,
    backend: 'aider'
  },
  'aider-impl': {
    prefix: 'IMPL',
    autoAccept: true,
    ralphMode: true,
    backend: 'aider'
  },
  'aider-test': {
    prefix: 'TEST',
    autoAccept: true,
    ralphMode: true,
    backend: 'aider'
  },
  'aider-review': {
    prefix: 'REVIEW',
    autoAccept: true,
    ralphMode: true,
    backend: 'aider'
  },
  'aider-fix': {
    prefix: 'FIX',
    autoAccept: true,
    ralphMode: true,
    backend: 'aider'
  },
  'aider-general': {
    prefix: 'GENERAL',
    autoAccept: true,
    ralphMode: true,
    backend: 'aider'
  },
  'aider-colonel': {
    prefix: 'COLONEL',
    autoAccept: true,
    ralphMode: true,
    backend: 'aider'
  }
};

// =============================================
// TASK QUALITY VALIDATION
// =============================================

const MIN_TASK_LENGTH = 50;

const END_STATE_PATTERNS = /\b(end state|success|done when|verify|commit|result|deliver|complet|output)\b/i;
const PURPOSE_PATTERNS = /\b(purpose|because|why|so that|in order to|motivation|goal|objective)\b/i;
const FILE_REF_PATTERNS = /\b[\w-]+\.(js|ts|jsx|tsx|py|rs|go|json|yaml|yml|md|css|html|sql|sh)\b|\/[\w/-]+\.\w+/;
const CONSTRAINT_PATTERNS = /\b(must not|do not|never|avoid|constraint|limit|only|require|boundary)\b/i;

// Marathon / continuous-ops language patterns (colonel failure predictor)
// Catches explicit open-ended operation instructions from failed colonel post-mortems.
// Intentionally narrow: only blocks commands like "run forever", "never stop", "keep N workers
// running at all times" — NOT normal task language like "fix any failures" or "document others".
// Removed: "bulldoze" (system feature name, appears in valid task descriptions about the bulldoze
// protocol), "ongoing" (common adjective in bounded tasks like "fix ongoing failures").
const MARATHON_PATTERNS = /\b(continuous(?:ly)?\s+(?:run|loop|spawn|monitor|operat)|keep\s+running|never\s+stop|marathon|weekend[- ]long|run\s+indefinitely|run\s+forever|always\s+be\s+running|perpetual|24\/7|nonstop|non[- ]stop)\b|keep\s+\d+\+?\s+workers?\s+running\s+at\s+all\s+times|run\s+until\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday|tonight|morning|end\s+of\s+day|midnight|tomorrow)|zero\s+active\s+children\s*[=:]\s*(fail|failure|bad|wrong)|when\s+one\s+finishes[^.]*spawn\s+another|spawn\s+another\s+immediately/i;

// Introspection patterns — tasks that require a worker to observe its own spawn-time configuration
// (model assignment, effort level, context sections) which cannot be verified from inside the session
const INTROSPECTION_PATTERNS = /verif\w*\s+(?:that\s+)?(?:\w+\s+){0,3}(?:template\s+)?workers?\s+(?:receives?|are\s+assigned|gets?)\b|verify\s+model\s+routing|test(?:s)?\s+(?:that\s+)?context\s+tieri?ng|verif\w*\s+(?:that\s+)?context\s+tieri?ng|effort\s+level\s+(?:tuning|check|verif|assign)|verify\s+effort\s+level|check\s+(?:that\s+)?model\s+(?:is\s+)?(?:correctly\s+)?(?:assigned|routed)|assigned\s+(?:the\s+)?(?:correct\s+)?(?:\w+\s+)?(?:language\s+)?model|model\s+(?:is\s+)?(?:correctly\s+)?(?:assigned|routed|routing)|test\s+(?:that\s+)?(?:the\s+)?(?:model|effort|context)\s+(?:is\s+)?(?:correctly\s+)?(?:assigned|set|routed|tiered)/i;

/**
 * Assess task description quality and return warnings + score.
 * @param {object} taskObj - The validated task object (always has .description)
 * @param {object} [options] - Additional context
 * @param {string} [options.templateKey] - Template type (e.g. 'colonel', 'impl')
 * @returns {{ warnings: string[], taskQualityScore: number, hardReject: boolean, hardRejectReason: string|null }}
 */
function assessTaskQuality(taskObj, options = {}) {
  const warnings = [];
  const desc = taskObj.description || '';
  const { templateKey } = options;

  // Combine all text fields for richer analysis
  const allText = [
    desc,
    taskObj.purpose || '',
    taskObj.endState || '',
    taskObj.context || '',
    ...(taskObj.keyTasks || []),
    ...(taskObj.constraints || []),
  ].join(' ');

  let score = 0;

  // --- Length scoring (0-25 points) ---
  // Linear ramp from 50 chars (0 pts) to 300 chars (25 pts), capped
  const len = desc.length;
  score += Math.min(25, Math.round(((len - MIN_TASK_LENGTH) / 250) * 25));

  // --- End state / completion criteria (0-25 points) ---
  const hasEndStateField = !!taskObj.endState;
  const hasEndStateInText = END_STATE_PATTERNS.test(allText);
  if (hasEndStateField) {
    score += 25;
  } else if (hasEndStateInText) {
    score += 15;
  } else {
    warnings.push('No clear completion criteria — consider adding "end state", "done when", or "verify" language so the worker knows when to stop.');
  }

  // --- Purpose / motivation (0-20 points) ---
  const hasPurposeField = !!taskObj.purpose;
  const hasPurposeInText = PURPOSE_PATTERNS.test(allText);
  if (hasPurposeField) {
    score += 20;
  } else if (hasPurposeInText) {
    score += 12;
  } else {
    warnings.push('No stated purpose or motivation — consider adding "purpose", "because", or "so that" to explain why this task matters.');
  }

  // --- Specificity: file/function references (0-15 points) ---
  const hasFileRefs = FILE_REF_PATTERNS.test(allText);
  if (hasFileRefs) {
    score += 15;
  }

  // --- Constraints (0-15 points) ---
  const hasConstraintField = Array.isArray(taskObj.constraints) && taskObj.constraints.length > 0;
  const hasConstraintInText = CONSTRAINT_PATTERNS.test(allText);
  if (hasConstraintField) {
    score += 15;
  } else if (hasConstraintInText) {
    score += 8;
  }

  // --- Colonel-specific checks (failure pattern detection) ---
  let hardReject = false;
  let hardRejectReason = null;
  const isColonel = templateKey === 'colonel';
  if (isColonel) {
    // R3: Colonel tasks without completion criteria — hard reject (86% failure rate for unbounded colonels)
    if (!hasEndStateField && !hasEndStateInText) {
      score -= 20;
      hardReject = true;
      hardRejectReason = 'Colonel spawn rejected: no END STATE or completion criteria detected. Colonels without completion criteria fail at 86% vs near-100% for bounded tasks. Add an endState field or include "end state", "done when", "success criteria", or similar language in the task description.';
      warnings.push(hardRejectReason);
    }

    // R1: Marathon / open-ended language is the #1 colonel failure pattern — hard reject
    if (MARATHON_PATTERNS.test(allText)) {
      score -= 20;
      hardReject = true;
      const marathonReason = 'Colonel spawn rejected: task contains open-ended/marathon language (e.g. "keep N workers running at all times", "run until [day]", "zero active children = failure", "when one finishes spawn another"). These patterns are a GENERAL\'s job — colonels need bounded scope with a finite deliverable list.';
      hardRejectReason = hardRejectReason ? hardRejectReason + ' Additionally: ' + marathonReason : marathonReason;
      warnings.push(marathonReason);
    }
  }

  // --- Commander's Intent format check (soft warning, cross-type) ---
  // Research R45: Tasks using PURPOSE/KEY TASKS/END STATE structure have a 97.1% success
  // rate vs 24.6% without — a 72.5pp gap. Warn when fewer than 2 of the 3 markers are present.
  const COMMANDER_INTENT_MARKERS = [
    /\bpurpose\s*:/i,
    /\bkey\s+tasks?\s*:/i,
    /\bend\s+state\s*:/i,
  ];
  const intentMarkerCount = COMMANDER_INTENT_MARKERS.filter(p => p.test(allText)).length;
  if (intentMarkerCount < 2) {
    warnings.push(
      'Tasks using Commander\'s Intent format (PURPOSE/KEY TASKS/END STATE) have a 97% success rate vs 25% without. Consider restructuring your task description to include these three sections.'
    );
  }

  // --- Introspection pattern detection (soft warning, not hard reject) ---
  // Tasks that ask a worker to verify its own model, effort level, or context sections
  // cannot be verified from inside the session — these conditions are set at spawn time.
  if (INTROSPECTION_PATTERNS.test(allText)) {
    warnings.push('This task may require observing conditions set at spawn time (model assignment, effort level, context sections), which cannot be reliably verified from within the worker. Consider using server logs or an external observer instead.');
  }

  // --- KEY TASKS bullet count penalty (-10 points for >5 bullets) ---
  // Overly broad impl tasks with many bullet points correlate with scope creep and failure.
  const keyTasksMatch = allText.match(/\bkey\s+tasks?\s*:([\s\S]*?)(?:\bend\s+state\s*:|$)/i);
  if (keyTasksMatch) {
    const keyTasksBody = keyTasksMatch[1];
    const bulletCount = (keyTasksBody.match(/^\s*[-*•]|\n\s*[-*•]|\n\s*\d+\./g) || []).length;
    if (bulletCount > 5) {
      score -= 10;
      warnings.push(`KEY TASKS section has ${bulletCount} bullet points (max recommended: 5). Overly broad tasks increase scope creep and failure rate — consider splitting into multiple focused workers.`);
    }
  }

  // Clamp to 0-100
  score = Math.max(0, Math.min(100, score));

  return { warnings, taskQualityScore: score, hardReject, hardRejectReason };
}

export function createWorkerRoutes(theaRoot, io) {
  const router = express.Router();

  // GET /api/workers - List all workers
  // Query params: ?status=running, ?project=strategos, ?fields=id,label,status,ralphProgress
  router.get('/', (req, res) => {
    try {
      let workers = getWorkers();

      // Filter by status
      if (req.query.status) {
        workers = workers.filter(w => w.status === req.query.status);
      }

      // Filter by project
      if (req.query.project) {
        workers = workers.filter(w => w.project === req.query.project);
      }

      // Select specific fields
      if (req.query.fields) {
        const fields = req.query.fields.split(',').map(f => f.trim()).filter(Boolean);
        if (fields.length > 0) {
          workers = workers.map(w => {
            const filtered = {};
            for (const f of fields) {
              if (f in w) filtered[f] = w[f];
            }
            return filtered;
          });
        }
      }

      res.json(workers);
    } catch (error) {
      res.status(500).json({ error: sanitizeErrorMessage(error) });
    }
  });

  // GET /api/workers/pending - List all pending workers (waiting on dependencies)
  // NOTE: This route MUST be before /api/workers/:id to avoid matching "pending" as an ID
  router.get('/pending', (req, res) => {
    try {
      const pending = getPendingWorkers();
      res.json(pending);
    } catch (error) {
      res.status(500).json({ error: sanitizeErrorMessage(error) });
    }
  });

  /**
   * GET /api/workers/tree
   * Get hierarchical view of all workers showing parent-child relationships
   */
  router.get('/tree', (req, res) => {
    try {
      const allWorkers = getWorkers();

      // Build a map for quick lookup
      const workerMap = new Map(allWorkers.map(w => [w.id, w]));

      // Find root workers (no parent)
      const roots = allWorkers.filter(w => !w.parentWorkerId);

      // Recursive function to build tree (depth-guarded to prevent stack overflow from cycles)
      const MAX_TREE_DEPTH = 20;
      function buildTree(worker, depth = 0) {
        if (depth >= MAX_TREE_DEPTH) {
          return { id: worker.id, label: worker.label, status: worker.status, _truncated: true };
        }
        const children = (worker.childWorkerIds || [])
          .map(id => workerMap.get(id))
          .filter(Boolean)
          .map(child => buildTree(child, depth + 1));

        return {
          id: worker.id,
          label: worker.label,
          status: worker.status,
          ralphStatus: worker.ralphStatus,
          ralphProgress: worker.ralphProgress,
          health: worker.health,
          createdAt: worker.createdAt,
          childCount: children.length,
          children: children.length > 0 ? children : undefined
        };
      }

      const tree = roots.map(buildTree);

      // Calculate stats
      const stats = {
        total: allWorkers.length,
        roots: roots.length,
        withChildren: allWorkers.filter(w => (w.childWorkerIds || []).length > 0).length,
        byStatus: {
          running: allWorkers.filter(w => w.status === 'running').length,
          completed: allWorkers.filter(w => w.status === 'completed').length
        },
        byRalphStatus: {
          pending: allWorkers.filter(w => w.ralphStatus === 'pending').length,
          inProgress: allWorkers.filter(w => w.ralphStatus === 'in_progress').length,
          done: allWorkers.filter(w => w.ralphStatus === 'done').length,
          blocked: allWorkers.filter(w => w.ralphStatus === 'blocked').length
        }
      };

      res.json({ tree, stats });
    } catch (error) {
      res.status(500).json({ error: sanitizeErrorMessage(error) });
    }
  });

  /**
   * GET /api/workers/templates
   * List available spawn templates
   */
  router.get('/templates', (req, res) => {
    try {
      const templates = Object.entries(SPAWN_TEMPLATES).map(([name, config]) => ({
        name,
        prefix: config.prefix,
        autoAccept: config.autoAccept,
        ralphMode: config.ralphMode,
        backend: config.backend || 'claude',
        model: config.model || null
      }));
      res.json({ templates });
    } catch (error) {
      res.status(500).json({ error: sanitizeErrorMessage(error) });
    }
  });

  // GET /api/workers/efficiency - Ralph efficiency metrics (Feature 4)
  router.get('/efficiency', (req, res) => {
    try {
      res.json(getWorkerEfficiency());
    } catch (error) {
      res.status(500).json({ error: sanitizeErrorMessage(error) });
    }
  });

  // NOTE: This route MUST be before /api/workers/:id to avoid Express matching "auto-respawn" as the :id param.
  /**
   * GET /api/workers/auto-respawn/status
   * Returns current auto-respawn registrations and chain states.
   */
  router.get('/auto-respawn/status', async (_req, res) => {
    try {
      const { getAutoRespawnStatus } = await import('../services/autoRespawnService.js');
      res.json(getAutoRespawnStatus());
    } catch (error) {
      res.status(500).json({ error: sanitizeErrorMessage(error) });
    }
  });

  // GET /api/workers/:id - Get single worker
  router.get('/:id', (req, res) => {
    try {
      const worker = getWorker(req.params.id);

      if (!worker) {
        return res.status(404).json({ error: 'Resource not found' });
      }

      res.json(worker);
    } catch (error) {
      res.status(500).json({ error: sanitizeErrorMessage(error) });
    }
  });

  // GET /api/workers/:id/status - Minimal text status line for AI consumers
  // Returns: "running healthy 40% doing stuff" (plain text, no JSON)
  router.get('/:id/status', (req, res) => {
    try {
      const worker = getWorker(req.params.id);

      if (!worker) {
        return res.status(404).type('text/plain').send('not_found');
      }

      const status = worker.status || 'unknown';
      const health = worker.health || 'unknown';
      const progress = worker.ralphProgress != null ? `${worker.ralphProgress}%` : '-';
      const step = worker.ralphCurrentStep || worker.label || '';

      res.type('text/plain').send(`${status} ${health} ${progress} ${step}`);
    } catch (error) {
      res.status(500).type('text/plain').send('error');
    }
  });

  // POST /api/workers - Spawn new worker (with optional dependencies)
  router.post('/', async (req, res) => {
    try {
      const {
        projectPath,
        label,
        dependsOn,
        onComplete,
        workflowId,
        taskId,
        // Context passing for worker-to-worker spawning
        task,           // { description, type, context, constraints }
        parentWorkerId, // ID of spawning worker
        parentLabel,    // Label of spawning worker
        initialInput,   // Optional first message after prompt
        autoAccept,     // Auto-accept permission prompts (default false)
        ralphMode,      // Enable Ralph autonomous completion signaling (default false)
        allowDuplicate, // Allow spawning duplicate label+project workers (default false)
        backend,        // 'claude' (default), 'gemini', or 'aider'
        model,          // Model name for aider backend (e.g. 'ollama_chat/qwen2.5-coder:7b')
        effortLevel,    // 'low', 'medium', or 'high' — overrides type-based default
      } = req.body;

      if (!projectPath) {
        return res.status(400).json({ error: 'projectPath is required' });
      }

      // Validate label — prevent newlines/control chars that could break context files
      if (label !== undefined) {
        if (typeof label !== 'string' || label.length > 200) {
          return res.status(400).json({ error: 'label must be a string of 200 characters or less' });
        }
        if (CONTROL_CHAR_RE.test(label)) {
          return res.status(400).json({ error: 'label must not contain control characters' });
        }
      }

      // Validate initialInput size
      if (initialInput !== undefined && (typeof initialInput !== 'string' || initialInput.length > MAX_INPUT_LENGTH)) {
        return res.status(400).json({ error: 'initialInput must be a string under 1MB' });
      }

      // SECURITY: Safely resolve project path with traversal prevention
      const resolvedPath = safeResolvePath(projectPath, theaRoot);
      if (!resolvedPath) {
        return res.status(400).json({ error: 'Invalid project path - path traversal not allowed' });
      }

      if (!projectExists(resolvedPath)) {
        return res.status(400).json({ error: 'Project path does not exist' });
      }

      // Validate dependsOn array
      if (dependsOn !== undefined) {
        if (!Array.isArray(dependsOn) || dependsOn.length > 50) {
          return res.status(400).json({ error: 'dependsOn must be an array with at most 50 entries' });
        }
        if (!dependsOn.every(id => typeof id === 'string' && VALID_WORKER_ID.test(id))) {
          return res.status(400).json({ error: 'dependsOn entries must be valid worker IDs' });
        }
      }

      // Validate pass-through spawn fields (defense-in-depth: strip invalid, don't reject)
      const validTask = (() => {
        if (task === undefined || task === null) return undefined;
        if (typeof task === 'string') {
          return (task.length <= MAX_TASK_LENGTH && !MULTILINE_CONTROL_CHAR_RE.test(task)) ? task : undefined;
        }
        if (typeof task === 'object' && !Array.isArray(task)) {
          // Validate object task sub-fields (parity with spawn-from-template)
          const obj = {};
          if (task.description !== undefined) {
            if (typeof task.description !== 'string' || task.description.length > MAX_TASK_LENGTH || MULTILINE_CONTROL_CHAR_RE.test(task.description)) return undefined;
            obj.description = task.description;
          }
          for (const field of ['type', 'context', 'purpose', 'endState', 'riskTolerance', 'detailLevel']) {
            if (task[field] !== undefined) {
              if (typeof task[field] !== 'string' || task[field].length > MAX_TASK_LENGTH || MULTILINE_CONTROL_CHAR_RE.test(task[field])) return undefined;
              obj[field] = task[field];
            }
          }
          if (task.keyTasks !== undefined) {
            if (!Array.isArray(task.keyTasks) || task.keyTasks.length > 20) return undefined;
            if (!task.keyTasks.every(kt => typeof kt === 'string' && kt.length <= 500 && !MULTILINE_CONTROL_CHAR_RE.test(kt))) return undefined;
            obj.keyTasks = task.keyTasks;
          }
          if (task.constraints !== undefined) {
            if (typeof task.constraints === 'string') {
              if (task.constraints.length > 500 || MULTILINE_CONTROL_CHAR_RE.test(task.constraints)) return undefined;
              obj.constraints = [task.constraints];
            } else if (Array.isArray(task.constraints)) {
              if (task.constraints.length > 20) return undefined;
              if (!task.constraints.every(c => typeof c === 'string' && c.length <= 500 && !MULTILINE_CONTROL_CHAR_RE.test(c))) return undefined;
              obj.constraints = task.constraints;
            } else {
              return undefined;
            }
          }
          if (task.requireBackbrief !== undefined) {
            if (typeof task.requireBackbrief !== 'boolean') return undefined;
            obj.requireBackbrief = task.requireBackbrief;
          }
          return Object.keys(obj).length > 0 ? obj : undefined;
        }
        return undefined;
      })();
      const validWorkflowId = (workflowId !== undefined && workflowId !== null) ?
        (typeof workflowId === 'string' && workflowId.length <= 100 && VALID_SIMPLE_ID.test(workflowId) ? workflowId : undefined) : undefined;
      const validTaskId = (taskId !== undefined && taskId !== null) ?
        (typeof taskId === 'string' && taskId.length <= 100 && VALID_SIMPLE_ID.test(taskId) ? taskId : undefined) : undefined;
      const validParentWorkerId = (parentWorkerId !== undefined && parentWorkerId !== null) ?
        (typeof parentWorkerId === 'string' && VALID_WORKER_ID.test(parentWorkerId) ? parentWorkerId : undefined) : undefined;
      const validParentLabel = (parentLabel !== undefined && parentLabel !== null) ?
        (typeof parentLabel === 'string' && parentLabel.length <= MAX_LABEL_LENGTH && !CONTROL_CHAR_RE.test(parentLabel) ? parentLabel : undefined) : undefined;
      // Validate onComplete: type must be one of the known action types,
      // and total JSON size capped to prevent memory abuse via deeply nested config
      const VALID_ONCOMPLETE_TYPES = ['spawn', 'webhook', 'emit'];
      const MAX_ONCOMPLETE_SIZE = 10000; // 10KB
      const validOnComplete = (() => {
        if (onComplete === undefined || onComplete === null) return undefined;
        if (typeof onComplete !== 'object' || Array.isArray(onComplete)) return undefined;
        if (typeof onComplete.type !== 'string' || !VALID_ONCOMPLETE_TYPES.includes(onComplete.type)) return undefined;
        try {
          if (JSON.stringify(onComplete).length > MAX_ONCOMPLETE_SIZE) return undefined;
        } catch { return undefined; }
        return { type: onComplete.type, config: onComplete.config || {} };
      })();

      // Spawn with optional dependency and context options
      const options = {};
      if (dependsOn) options.dependsOn = dependsOn;
      if (validOnComplete) options.onComplete = validOnComplete;
      if (validWorkflowId) options.workflowId = validWorkflowId;
      if (validTaskId) options.taskId = validTaskId;
      // Context passing options
      if (validTask) options.task = validTask;
      if (validParentWorkerId) options.parentWorkerId = validParentWorkerId;
      if (validParentLabel) options.parentLabel = validParentLabel;
      if (initialInput) options.initialInput = initialInput;
      // Default autoAccept and ralphMode to TRUE for all spawns
      options.autoAccept = autoAccept !== false; // true unless explicitly false
      options.ralphMode = ralphMode !== false;   // true unless explicitly false
      // Backend selection: explicit > parent inheritance > 'claude' default
      if (backend === 'gemini' || backend === 'aider') {
        options.backend = backend;
      } else if (!backend && validParentWorkerId) {
        const parentWorker = getWorker(validParentWorkerId);
        if (parentWorker?.backend && parentWorker.backend !== 'claude') {
          options.backend = parentWorker.backend;
        }
      }
      // Model: explicit > parent inheritance
      if (model) {
        options.model = model;
      } else if (validParentWorkerId) {
        const parentWorker = getWorker(validParentWorkerId);
        if (parentWorker?.model) options.model = parentWorker.model;
      }
      // Duplicate detection is ON by default — callers must opt-in to duplicates
      options.allowDuplicate = allowDuplicate === true;
      // Effort level override (validated; type-based default applied in lifecycle.js)
      const validEfforts = ['low', 'medium', 'high'];
      if (effortLevel !== undefined) {
        if (validEfforts.includes(effortLevel)) {
          options.effortLevel = effortLevel;
        } else {
          return res.status(400).json({ error: `effortLevel must be one of: ${validEfforts.join(', ')}` });
        }
      }

      const worker = await spawnWorker(resolvedPath, label, io, options);

      // If Ralph mode enabled, register with ralphService and send instructions
      if (worker.ralphMode && worker.ralphToken) {
        const ralphService = req.app.locals.ralphService;
        if (ralphService) {
          ralphService.registerStandaloneWorker(worker.ralphToken, worker.id);
        }
      }

      // Build response — use normalizeWorker allowlist to strip internal fields (ralphToken etc.)
      const response = normalizeWorker(worker);
      if (!parentWorkerId) {
        response._warning = 'No parentWorkerId provided. Include parentWorkerId from your project instructions to enable parent-child tracking.';
        console.warn(`[SPAWN] Worker ${worker.id} spawned without parentWorkerId - parent-child tracking disabled`);
      }

      res.status(201).json(response);
    } catch (error) {
      res.status(500).json({ error: sanitizeErrorMessage(error) });
    }
  });

  /**
   * POST /api/workers/spawn-from-template
   * Spawn a worker using a predefined template
   *
   * Body:
   *   - template: string (required) - Template name (research, impl, test, etc.)
   *   - label: string (required) - Descriptive label (without prefix)
   *   - projectPath: string (optional) - Defaults to parent's project or theaRoot
   *   - task: string | object (required) - Task description or full task object
   *   - parentWorkerId: string (optional) - Parent worker ID
   */
  router.post('/spawn-from-template', async (req, res) => {
    try {
      const { template: templateField, role, label, projectPath, task, parentWorkerId, allowDuplicate, model, effortLevel } = req.body;

      // Accept 'role' as alias for 'template'
      const template = templateField || role;

      if (!template) {
        return res.status(400).json({ success: false, error: 'template (or role) is required' });
      }

      const templateKey = template.toLowerCase();
      if (!Object.hasOwn(SPAWN_TEMPLATES, templateKey)) {
        return res.status(400).json({
          error: `Unknown template: ${template}`,
          availableTemplates: Object.keys(SPAWN_TEMPLATES)
        });
      }
      const tmpl = SPAWN_TEMPLATES[templateKey];

      if (!label || typeof label !== 'string') {
        return res.status(400).json({ error: 'label is required' });
      }
      if (label.length > 200) {
        return res.status(400).json({ error: 'label must be 200 characters or less' });
      }
      if (CONTROL_CHAR_RE.test(label)) {
        return res.status(400).json({ error: 'label must not contain control characters' });
      }

      if (!task) {
        return res.status(400).json({ error: 'task is required' });
      }

      // Validate task — same rules as main spawn route (string: size + multiline control chars; object: validate description)
      if (typeof task === 'string') {
        if (task.length > MAX_TASK_LENGTH) {
          return res.status(400).json({ error: `task must be under ${MAX_TASK_LENGTH} characters` });
        }
        if (MULTILINE_CONTROL_CHAR_RE.test(task)) {
          return res.status(400).json({ error: 'task must not contain control characters' });
        }
      } else if (task && typeof task === 'object' && !Array.isArray(task)) {
        // Validate object task: check description field size + control chars
        if (task.description !== undefined) {
          if (typeof task.description !== 'string') {
            return res.status(400).json({ error: 'task.description must be a string' });
          }
          if (task.description.length > MAX_TASK_LENGTH) {
            return res.status(400).json({ error: `task.description must be under ${MAX_TASK_LENGTH} characters` });
          }
          if (MULTILINE_CONTROL_CHAR_RE.test(task.description)) {
            return res.status(400).json({ error: 'task.description must not contain control characters' });
          }
        }
        // Validate other string fields if present (constraints validated separately as array)
        for (const field of ['type', 'context', 'purpose', 'endState', 'riskTolerance', 'detailLevel']) {
          if (task[field] !== undefined) {
            if (typeof task[field] !== 'string' || task[field].length > MAX_TASK_LENGTH) {
              return res.status(400).json({ error: `task.${field} must be a string under ${MAX_TASK_LENGTH} characters` });
            }
            if (MULTILINE_CONTROL_CHAR_RE.test(task[field])) {
              return res.status(400).json({ error: `task.${field} must not contain control characters` });
            }
          }
        }
        // Validate keyTasks (array of strings)
        if (task.keyTasks !== undefined) {
          if (!Array.isArray(task.keyTasks) || task.keyTasks.length > 20) {
            return res.status(400).json({ error: 'task.keyTasks must be an array with at most 20 items' });
          }
          for (const kt of task.keyTasks) {
            if (typeof kt !== 'string' || kt.length > 500 || MULTILINE_CONTROL_CHAR_RE.test(kt)) {
              return res.status(400).json({ error: 'task.keyTasks items must be strings under 500 chars without control characters' });
            }
          }
        }
        // Validate constraints (array of strings, or string converted to single-item array)
        if (task.constraints !== undefined) {
          if (typeof task.constraints === 'string') {
            // Convert string to single-item array for consistency with initializeWorker()
            if (task.constraints.length > 500 || MULTILINE_CONTROL_CHAR_RE.test(task.constraints)) {
              return res.status(400).json({ error: 'task.constraints must not contain control characters and be under 500 chars' });
            }
            task.constraints = [task.constraints];
          } else if (Array.isArray(task.constraints)) {
            if (task.constraints.length > 20) {
              return res.status(400).json({ error: 'task.constraints must be an array with at most 20 items' });
            }
            for (const c of task.constraints) {
              if (typeof c !== 'string' || c.length > 500 || MULTILINE_CONTROL_CHAR_RE.test(c)) {
                return res.status(400).json({ error: 'task.constraints items must be strings under 500 chars without control characters' });
              }
            }
          } else {
            return res.status(400).json({ error: 'task.constraints must be a string or array of strings' });
          }
        }
        // Validate requireBackbrief (boolean)
        if (task.requireBackbrief !== undefined && typeof task.requireBackbrief !== 'boolean') {
          return res.status(400).json({ error: 'task.requireBackbrief must be a boolean' });
        }
      } else {
        return res.status(400).json({ error: 'task must be a string or plain object' });
      }

      // Build a temporary task object for quality assessment (merge structured fields if present)
      const qualityInput = typeof task === 'string'
        ? { description: task }
        : task;
      const { warnings: qualityWarnings, taskQualityScore, hardReject, hardRejectReason } = assessTaskQuality(qualityInput, { templateKey });

      // R1/R3: Hard reject colonel spawns with marathon patterns or missing END STATE
      if (hardReject) {
        return res.status(400).json({
          error: hardRejectReason,
          taskQualityScore,
          warnings: qualityWarnings,
        });
      }

      // Get parent worker for context inheritance
      const parent = parentWorkerId ? getWorker(parentWorkerId) : null;

      // Determine project path: explicit > parent's > theaRoot
      let resolvedPath = projectPath;
      if (!resolvedPath && parent) {
        resolvedPath = parent.workingDir;
      }
      if (!resolvedPath) {
        resolvedPath = theaRoot;
      }
      resolvedPath = safeResolvePath(resolvedPath, theaRoot);

      if (!resolvedPath) {
        return res.status(400).json({ error: 'Invalid project path' });
      }

      // Construct full label with prefix — strip prefix from label if already present
      const prefixUpper = tmpl.prefix.toUpperCase() + ':';
      const cleanLabel = label.toUpperCase().startsWith(prefixUpper)
        ? label.slice(prefixUpper.length).trim()
        : label;
      const fullLabel = `${tmpl.prefix}: ${cleanLabel}`;

      // Construct task object — only copy known fields from validated task object
      const taskObj = typeof task === 'string'
        ? { description: task }
        : {
            ...(task.description !== undefined && { description: task.description }),
            ...(task.type !== undefined && { type: task.type }),
            ...(task.constraints !== undefined && { constraints: task.constraints }),
            ...(task.context !== undefined && { context: task.context }),
            // Commander's Intent fields (Mission Command doctrine)
            ...(task.purpose !== undefined && { purpose: task.purpose }),
            ...(task.endState !== undefined && { endState: task.endState }),
            ...(task.keyTasks !== undefined && { keyTasks: task.keyTasks }),
            ...(task.riskTolerance !== undefined && { riskTolerance: task.riskTolerance }),
            // Prompt control fields
            ...(task.detailLevel !== undefined && { detailLevel: task.detailLevel }),
            ...(task.requireBackbrief !== undefined && { requireBackbrief: task.requireBackbrief }),
          };

      // Spawn with template settings
      // Backend priority: template explicit > parent inheritance > 'claude' default
      // Backend priority: template explicit > parent inheritance > 'claude' default
      const resolvedBackend = tmpl.backend || (parent?.backend && parent.backend !== 'claude' ? parent.backend : 'claude');
      // Validate effortLevel if provided
      const validEfforts = ['low', 'medium', 'high'];
      if (effortLevel !== undefined && !validEfforts.includes(effortLevel)) {
        return res.status(400).json({ error: `effortLevel must be one of: ${validEfforts.join(', ')}` });
      }

      // Parse autoRespawn option — GENERAL workers default to true for respawn resilience
      const autoRespawnEnabled = req.body.autoRespawn === true || (req.body.autoRespawn === undefined && templateKey === 'general');
      let autoRespawnConfig = null;
      if (autoRespawnEnabled) {
        const taskDesc = typeof taskObj === 'string' ? taskObj : (taskObj.description || '');
        autoRespawnConfig = {
          taskDescription: taskDesc,
          projectPath: resolvedPath,
          label: fullLabel,
          maxRespawns: typeof req.body.autoRespawnMaxRespawns === 'number' ? req.body.autoRespawnMaxRespawns : 10,
          cooldownMs: typeof req.body.autoRespawnCooldownMs === 'number' ? req.body.autoRespawnCooldownMs : 120000,
          effortLevel: effortLevel || null,
          autoAccept: tmpl.autoAccept,
          forcedAutonomy: !!(req.body.forcedAutonomy || tmpl.forcedAutonomy),
          bulldozeMode: !!req.body.bulldozeMode,
        };
      }

      const options = {
        autoAccept: tmpl.autoAccept,
        ralphMode: tmpl.ralphMode,
        backend: resolvedBackend,
        model: model || tmpl.model || null,
        task: taskObj,
        parentWorkerId,
        parentLabel: parent?.label,
        allowDuplicate: allowDuplicate === true,
        effortLevel: effortLevel || null,
        autoRespawn: autoRespawnEnabled,
        autoRespawnConfig,
      };

      const worker = await spawnWorker(resolvedPath, fullLabel, io, options);

      // Register with Ralph if enabled
      if (tmpl.ralphMode && worker.ralphToken) {
        const ralphService = req.app.locals.ralphService;
        if (ralphService) {
          ralphService.registerStandaloneWorker(worker.ralphToken, worker.id);
        }
      }

      // Atomically enable forced autonomy if requested or if the template requires it
      if (req.body.forcedAutonomy || tmpl.forcedAutonomy) {
        updateWorkerSettings(worker.id, { forcedAutonomy: true }, io);
      }

      // Atomically enable bulldoze if requested (avoids two-step spawn + settings dance)
      if (req.body.bulldozeMode) {
        const bulldozeSettings = { bulldozeMode: true };
        if (req.body.bulldozeMission) bulldozeSettings.bulldozeMission = String(req.body.bulldozeMission).slice(0, MAX_TASK_LENGTH);
        if (req.body.bulldozeBacklog) bulldozeSettings.bulldozeBacklog = String(req.body.bulldozeBacklog).slice(0, MAX_TASK_LENGTH);
        if (req.body.bulldozeStandingOrders) bulldozeSettings.bulldozeStandingOrders = String(req.body.bulldozeStandingOrders).slice(0, MAX_TASK_LENGTH);
        updateWorkerSettings(worker.id, bulldozeSettings, io);
      }

      // Store task quality score on worker for metrics tracking
      worker.taskQualityScore = taskQualityScore;

      // Build response — use normalizeWorker allowlist to strip internal fields (ralphToken etc.)
      const response = normalizeWorker(worker);
      if (!parentWorkerId) {
        response._warning = 'No parentWorkerId provided. Include parentWorkerId from your project instructions to enable parent-child tracking.';
        console.warn(`[SPAWN] Worker ${worker.id} spawned without parentWorkerId - parent-child tracking disabled`);
      }

      // Include task quality data in spawn response
      response.taskQualityScore = taskQualityScore;
      if (qualityWarnings.length > 0) {
        response.warnings = qualityWarnings;
      }

      res.status(201).json(response);
    } catch (error) {
      res.status(500).json({ error: sanitizeErrorMessage(error) });
    }
  });

  // DELETE /api/workers/:id - Kill worker
  // GENERAL PROTECTION: Requires ?force=true query param to kill GENERAL-tier workers
  // HIERARCHY PROTECTION: If callerWorkerId is provided, caller must be ancestor of target
  router.delete('/:id', async (req, res) => {
    try {
      const worker = getWorker(req.params.id);
      if (!worker) {
        return res.status(404).json({ error: 'Resource not found' });
      }
      const force = req.query.force === 'true' || req.body?.force === true;
      const callerWorkerId = req.query.callerWorkerId || req.body?.callerWorkerId || null;
      await killWorker(req.params.id, io, { force, callerWorkerId });
      res.json({ success: true });
    } catch (error) {
      if (error.message.includes('not found')) {
        return res.status(404).json({ error: 'Resource not found' });
      }
      if (error.message.includes('Cannot kill GENERAL-tier')) {
        return res.status(403).json({
          error: 'Cannot kill GENERAL-tier worker without force flag',
          hint: 'Add ?force=true to confirm deletion of a GENERAL-tier worker'
        });
      }
      if (error.message.includes('cannot kill') || error.message.includes('Workers cannot kill themselves')) {
        return res.status(403).json({
          error: error.message,
          hint: 'Workers can only kill their own children/descendants. Only human operators can kill peer or parent workers.'
        });
      }
      res.status(500).json({ error: sanitizeErrorMessage(error) });
    }
  });

  // POST /api/workers/:id/dismiss - Commander dismisses a worker after reviewing results
  // Worker must be in awaiting_review state. Checks for uncommitted work.
  router.post('/:id/dismiss', async (req, res) => {
    try {
      const result = await dismissWorker(req.params.id, io);
      res.json(result);
    } catch (error) {
      if (error.message.includes('not found')) {
        return res.status(404).json({ error: 'Resource not found' });
      }
      res.status(500).json({ error: sanitizeErrorMessage(error) });
    }
  });

  // PATCH /api/workers/:id - Update worker label
  router.patch('/:id', (req, res) => {
    try {
      const { label } = req.body;

      if (!label || typeof label !== 'string') {
        return res.status(400).json({ error: 'label is required and must be a string' });
      }
      if (label.length > 200) {
        return res.status(400).json({ error: 'label must be 200 characters or less' });
      }
      if (CONTROL_CHAR_RE.test(label)) {
        return res.status(400).json({ error: 'label must not contain control characters' });
      }

      const worker = updateWorkerLabel(req.params.id, label, io);
      res.json(worker);
    } catch (error) {
      if (error.message.includes('not found')) {
        return res.status(404).json({ error: 'Resource not found' });
      }
      res.status(500).json({ error: sanitizeErrorMessage(error) });
    }
  });

  // POST /api/workers/:id/settings - Update worker settings (autoAccept, ralphMode, etc.)
  router.post('/:id/settings', async (req, res) => {
    try {
      const { autoAccept, autoAcceptPaused, ralphMode, bulldozeMode, bulldozePaused,
        bulldozeMission, bulldozeBacklog, bulldozeStandingOrders, forcedAutonomy } = req.body;
      const settings = {};
      if (autoAccept !== undefined) {
        if (typeof autoAccept !== 'boolean') return res.status(400).json({ error: 'autoAccept must be a boolean' });
        settings.autoAccept = autoAccept;
      }
      if (autoAcceptPaused !== undefined) {
        if (typeof autoAcceptPaused !== 'boolean') return res.status(400).json({ error: 'autoAcceptPaused must be a boolean' });
        settings.autoAcceptPaused = autoAcceptPaused;
      }
      if (ralphMode !== undefined) {
        if (typeof ralphMode !== 'boolean') return res.status(400).json({ error: 'ralphMode must be a boolean' });
        settings.ralphMode = ralphMode;
      }
      if (bulldozeMode !== undefined) {
        if (typeof bulldozeMode !== 'boolean') return res.status(400).json({ error: 'bulldozeMode must be a boolean' });
        settings.bulldozeMode = bulldozeMode;
      }
      if (forcedAutonomy !== undefined) {
        if (typeof forcedAutonomy !== 'boolean') return res.status(400).json({ error: 'forcedAutonomy must be a boolean' });
        settings.forcedAutonomy = forcedAutonomy;
      }
      if (bulldozePaused !== undefined) {
        if (typeof bulldozePaused !== 'boolean') return res.status(400).json({ error: 'bulldozePaused must be a boolean' });
        settings.bulldozePaused = bulldozePaused;
      }
      // Bulldoze text fields are multiline — use shared MULTILINE_CONTROL_CHAR_RE from validation.js
      if (bulldozeMission !== undefined) {
        if (typeof bulldozeMission !== 'string' || bulldozeMission.length > 10000) {
          return res.status(400).json({ error: 'bulldozeMission must be a string under 10000 chars' });
        }
        if (MULTILINE_CONTROL_CHAR_RE.test(bulldozeMission)) {
          return res.status(400).json({ error: 'bulldozeMission must not contain control characters' });
        }
        settings.bulldozeMission = bulldozeMission;
      }
      if (bulldozeBacklog !== undefined) {
        if (typeof bulldozeBacklog !== 'string' || bulldozeBacklog.length > 10000) {
          return res.status(400).json({ error: 'bulldozeBacklog must be a string under 10000 chars' });
        }
        if (MULTILINE_CONTROL_CHAR_RE.test(bulldozeBacklog)) {
          return res.status(400).json({ error: 'bulldozeBacklog must not contain control characters' });
        }
        settings.bulldozeBacklog = bulldozeBacklog;
      }
      if (bulldozeStandingOrders !== undefined) {
        if (typeof bulldozeStandingOrders !== 'string' || bulldozeStandingOrders.length > 10000) {
          return res.status(400).json({ error: 'bulldozeStandingOrders must be a string under 10000 chars' });
        }
        if (MULTILINE_CONTROL_CHAR_RE.test(bulldozeStandingOrders)) {
          return res.status(400).json({ error: 'bulldozeStandingOrders must not contain control characters' });
        }
        settings.bulldozeStandingOrders = bulldozeStandingOrders;
      }

      if (Object.keys(settings).length === 0) {
        return res.status(400).json({ error: 'No valid settings provided' });
      }

      // Get worker before update to check previous Ralph state (internal — needs ralphToken)
      const workerBefore = getWorkerInternal(req.params.id);
      const wasRalphEnabled = workerBefore?.ralphMode;
      const previousToken = workerBefore?.ralphToken;

      const worker = updateWorkerSettings(req.params.id, settings, io);

      // Handle Ralph mode changes via API
      if (ralphMode !== undefined) {
        const ralphService = req.app.locals.ralphService;

        if (ralphMode && !wasRalphEnabled) {
          // Ralph mode just enabled - register and send instructions
          if (ralphService && worker.ralphToken) {
            ralphService.registerStandaloneWorker(worker.ralphToken, worker.id);

            // Send Ralph instructions to the worker
            const instructions = `

=== RALPH MODE ENABLED ===
When you complete your current task, signal completion by running:

curl -X POST http://localhost:38007/api/ralph/signal/${worker.ralphToken} -H "Content-Type: application/json" -d '{"status":"done"}'

If blocked, signal:
curl -X POST http://localhost:38007/api/ralph/signal/${worker.ralphToken} -H "Content-Type: application/json" -d '{"status":"blocked","reason":"brief description"}'
===========================

`;
            await sendInput(req.params.id, instructions, null, { source: 'complete_instructions' });
          }
        } else if (!ralphMode && wasRalphEnabled) {
          // Ralph mode just disabled - unregister
          if (ralphService && previousToken) {
            ralphService.unregisterStandaloneWorker(previousToken);
          }
        }
      }

      res.json({
        success: true,
        worker: {
          id: worker.id,
          autoAccept: worker.autoAccept,
          autoAcceptPaused: worker.autoAcceptPaused,
          ralphMode: worker.ralphMode,
          bulldozeMode: worker.bulldozeMode,
          forcedAutonomy: worker.forcedAutonomy,
          bulldozePaused: worker.bulldozePaused,
          bulldozePauseReason: worker.bulldozePauseReason,
          bulldozeCyclesCompleted: worker.bulldozeCyclesCompleted,
          bulldozeStartedAt: worker.bulldozeStartedAt,
          bulldozeLastCycleAt: worker.bulldozeLastCycleAt
        }
      });
    } catch (error) {
      if (error.message.includes('not found')) {
        return res.status(404).json({ error: 'Resource not found' });
      }
      res.status(500).json({ error: sanitizeErrorMessage(error) });
    }
  });

  // POST /api/workers/:id/input - Send input to worker
  router.post('/:id/input', async (req, res) => {
    try {
      const { input, fromWorkerId } = req.body;

      if (!input || typeof input !== 'string') {
        return res.status(400).json({ error: 'input must be a non-empty string' });
      }

      // Match socket handler's 1MB limit
      if (input.length > 1024 * 1024) {
        return res.status(400).json({ error: 'Input too large (max 1MB)' });
      }

      // Cross-project guard: block workers from sending input to workers in different projects
      if (fromWorkerId) {
        const sender = getWorker(fromWorkerId);
        const receiver = getWorker(req.params.id);
        if (sender && receiver && sender.project && receiver.project && sender.project !== receiver.project) {
          console.warn(`[INPUT] Cross-project input blocked: worker ${fromWorkerId} (${sender.project}) tried to send input to worker ${req.params.id} (${receiver.project})`);
          return res.status(403).json({
            error: `Cross-project input blocked: sender project (${sender.project}) does not match receiver project (${receiver.project})`
          });
        }
      }

      await sendInput(req.params.id, input, null, { fromWorkerId, source: fromWorkerId ? `rest_api:worker:${fromWorkerId}` : 'rest_api' });
      res.json({ success: true });
    } catch (error) {
      if (error.message.includes('not found')) {
        return res.status(404).json({ error: 'Resource not found' });
      }
      res.status(500).json({ error: sanitizeErrorMessage(error) });
    }
  });

  // POST /api/workers/:id/interrupt - Send Ctrl+C to interrupt a blocking command
  // Unlike DELETE (kill), this just sends the interrupt signal — the worker stays alive.
  // Optionally accepts a followUp message to send after the interrupt takes effect.
  router.post('/:id/interrupt', async (req, res) => {
    try {
      const worker = getWorker(req.params.id);
      if (!worker) {
        return res.status(404).json({ error: 'Resource not found' });
      }

      if (worker.status !== 'running') {
        return res.status(409).json({
          error: `Worker is not running (status: ${worker.status})`,
          hint: 'Can only interrupt workers that are currently running'
        });
      }

      // Validate optional followUp input
      const { followUp } = req.body || {};
      if (followUp !== undefined && followUp !== null) {
        if (typeof followUp !== 'string') {
          return res.status(400).json({ error: 'followUp must be a string' });
        }
        if (followUp.length > MAX_INPUT_LENGTH) {
          return res.status(400).json({ error: 'followUp too large (max 1MB)' });
        }
      }

      await interruptWorker(req.params.id, followUp || null, io);
      res.json({
        success: true,
        message: `Interrupt signal (C-c) sent to worker ${req.params.id}`,
        followUpSent: !!followUp
      });
    } catch (error) {
      if (error.message.includes('not found')) {
        return res.status(404).json({ error: 'Resource not found' });
      }
      if (error.message.includes('not running')) {
        return res.status(409).json({ error: error.message });
      }
      res.status(500).json({ error: sanitizeErrorMessage(error) });
    }
  });

  // POST /api/workers/execute - Execute a prompt via LLM (for testing/evaluation)
  // This endpoint provides synchronous LLM execution for promptfoo testing
  router.post('/execute', async (req, res) => {
    try {
      const {
        prompt,
        model,
        maxTokens,
        temperature,
        systemPrompt
      } = req.body;

      if (!prompt || typeof prompt !== 'string') {
        return res.status(400).json({ error: 'prompt is required' });
      }
      if (prompt.length > MAX_PROMPT_LENGTH) {
        return res.status(400).json({ error: `prompt must be under ${MAX_PROMPT_LENGTH} characters` });
      }
      if (systemPrompt !== undefined && (typeof systemPrompt !== 'string' || systemPrompt.length > 10000)) {
        return res.status(400).json({ error: 'systemPrompt must be a string under 10000 characters' });
      }
      // Validate model name format (alphanumeric + common Ollama model separators)
      if (model !== undefined && (typeof model !== 'string' || model.length > 100 || !/^[a-zA-Z0-9._:/-]+$/.test(model))) {
        return res.status(400).json({ error: 'model must be alphanumeric with ._:/- separators (max 100 chars)' });
      }

      // Bound maxTokens and temperature to safe ranges
      const safeMaxTokens = maxTokens ? Math.max(1, Math.min(parseInt(maxTokens, 10) || 4096, 8192)) : undefined;
      const safeTemperature = temperature !== undefined ? Math.max(0, Math.min(parseFloat(temperature) || 0.7, 2.0)) : undefined;

      const startTime = Date.now();
      const result = await executePrompt(prompt, {
        model,
        maxTokens: safeMaxTokens,
        temperature: safeTemperature,
        systemPrompt
      });

      res.json({
        success: true,
        response: result.response,
        model: result.model,
        latencyMs: Date.now() - startTime,
        tokenUsage: {
          prompt: result.promptTokens,
          completion: result.completionTokens,
          total: (result.promptTokens || 0) + (result.completionTokens || 0)
        }
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: sanitizeErrorMessage(error)
      });
    }
  });

  // GET /api/workers/:id/output - Get worker output buffer
  // Query params: ?strip_ansi=true to remove ANSI escape codes, ?lines=N for last N lines
  // Per-caller throttling: if callerWorkerId is provided, caches output for 30s to prevent rapid polling
  const _outputCache = new Map(); // key: "caller:target" -> { output, timestamp }
  const OUTPUT_CACHE_TTL_MS = 30_000;
  const OUTPUT_CACHE_MAX_ENTRIES = 500;
  const OUTPUT_THROTTLE_HINT = '\n[Strategos] Output cached — polling too fast. Check every 2+ minutes. Use Ralph signals for monitoring.';

  router.get('/:id/output', (req, res) => {
    try {
      const worker = getWorker(req.params.id);

      if (!worker) {
        return res.status(404).json({ error: 'Resource not found' });
      }

      const callerWorkerId = req.query.callerWorkerId || null;

      // Per-caller throttling: if a worker fetches the same target within 30s, return cached result
      if (callerWorkerId) {
        const cacheKey = `${callerWorkerId}:${req.params.id}`;
        const cached = _outputCache.get(cacheKey);
        const now = Date.now();

        if (cached && (now - cached.timestamp) < OUTPUT_CACHE_TTL_MS) {
          // Return cached output with throttle hint appended
          return res.json({ output: cached.output + OUTPUT_THROTTLE_HINT, cached: true });
        }
      }

      let output = getWorkerOutput(req.params.id) || '';

      // Strip ANSI escape codes if requested
      if (req.query.strip_ansi === 'true') {
        output = output.replace(/\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b\[[\?]?[0-9;]*[hlm]/g, '');
      }

      // Return last N lines if requested
      const lines = parseInt(req.query.lines, 10);
      if (lines > 0) {
        const allLines = output.split('\n');
        output = allLines.slice(-lines).join('\n');
      }

      // Cache result for caller-based throttling
      if (callerWorkerId) {
        const cacheKey = `${callerWorkerId}:${req.params.id}`;

        // Evict oldest entry if cache is full (Map preserves insertion order → O(1))
        if (_outputCache.size >= OUTPUT_CACHE_MAX_ENTRIES) {
          _outputCache.delete(_outputCache.keys().next().value);
        }

        _outputCache.set(cacheKey, { output, timestamp: Date.now() });
      }

      res.json({ output });
    } catch (error) {
      res.status(500).json({ error: sanitizeErrorMessage(error) });
    }
  });

  // GET /api/workers/:id/history - Get paginated historical output
  router.get('/:id/history', (req, res) => {
    try {
      const workerId = req.params.id;
      const limit = Math.min(parseInt(req.query.limit, 10) || 100, 1000);
      const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
      const rawSessionId = req.query.sessionId ? parseInt(req.query.sessionId, 10) : null;
      const sessionId = (rawSessionId !== null && isValidSessionId(rawSessionId)) ? rawSessionId : null;

      const history = getWorkerHistory(workerId, { limit, offset, sessionId });
      res.json(history);
    } catch (error) {
      res.status(500).json({ error: sanitizeErrorMessage(error) });
    }
  });

  // GET /api/workers/:id/sessions - List past sessions for a worker
  router.get('/:id/sessions', (req, res) => {
    try {
      const workerId = req.params.id;
      const limit = Math.min(parseInt(req.query.limit, 10) || 20, 1000);
      const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

      const sessions = getWorkerSessions(workerId, { limit, offset });
      res.json(sessions);
    } catch (error) {
      res.status(500).json({ error: sanitizeErrorMessage(error) });
    }
  });

  // ============================================
  // DEPENDENCY AND WORKFLOW MANAGEMENT
  // ============================================

  // GET /api/workers/:id/dependencies - Get dependency status for a worker
  router.get('/:id/dependencies', (req, res) => {
    try {
      const deps = getWorkerDependencies(req.params.id);

      if (!deps) {
        // Worker exists but has no dependencies registered
        const worker = getWorker(req.params.id);
        if (!worker) {
          return res.status(404).json({ error: 'Resource not found' });
        }
        return res.json({
          workerId: req.params.id,
          status: 'none',
          dependencies: [],
          dependents: [],
          onComplete: null,
          workflowId: null
        });
      }

      res.json(deps);
    } catch (error) {
      res.status(500).json({ error: sanitizeErrorMessage(error) });
    }
  });

  /**
   * GET /api/workers/:id/children
   * Get all child workers spawned by this worker with their Ralph status
   * Useful for parent workers (especially GENERALs) to monitor progress without reading output
   */
  router.get('/:id/children', (req, res) => {
    try {
      const worker = getWorker(req.params.id);
      if (!worker) {
        return res.status(404).json({ error: 'Resource not found' });
      }

      const children = getChildWorkers(req.params.id);

      // Calculate summary stats
      const summary = {
        total: children.length,
        pending: children.filter(c => c.ralphStatus === 'pending').length,
        done: children.filter(c => c.ralphStatus === 'done').length,
        blocked: children.filter(c => c.ralphStatus === 'blocked').length,
        noRalph: children.filter(c => !c.ralphMode).length,
      };

      res.json({
        parentWorkerId: req.params.id,
        summary,
        children
      });
    } catch (error) {
      res.status(500).json({ error: sanitizeErrorMessage(error) });
    }
  });

  /**
   * GET /api/workers/:id/siblings
   * Get sibling workers (other workers with same parent)
   * Useful for workers to coordinate and avoid duplicate work
   */
  router.get('/:id/siblings', (req, res) => {
    try {
      const worker = getWorker(req.params.id);
      if (!worker) {
        return res.status(404).json({ error: 'Resource not found' });
      }

      const siblings = getSiblingWorkers(req.params.id);

      // Calculate summary stats
      const summary = {
        total: siblings.length,
        pending: siblings.filter(s => s.ralphStatus === 'pending').length,
        inProgress: siblings.filter(s => s.ralphStatus === 'in_progress').length,
        done: siblings.filter(s => s.ralphStatus === 'done').length,
        blocked: siblings.filter(s => s.ralphStatus === 'blocked').length,
      };

      res.json({
        workerId: req.params.id,
        parentWorkerId: worker.parentWorkerId || null,
        summary,
        siblings
      });
    } catch (error) {
      res.status(500).json({ error: sanitizeErrorMessage(error) });
    }
  });

  // POST /api/workers/:id/complete - Mark a worker as completed
  router.post('/:id/complete', async (req, res) => {
    try {
      const result = await completeWorker(req.params.id, io);
      res.json({
        success: true,
        worker: result.worker,
        triggeredWorkers: result.triggeredWorkers.map(w => ({
          id: w.id,
          label: w.label,
          status: w.status
        })),
        onCompleteAction: result.onCompleteAction
      });
    } catch (error) {
      if (error.message.includes('not found')) {
        return res.status(404).json({ error: 'Resource not found' });
      }
      res.status(500).json({ error: sanitizeErrorMessage(error) });
    }
  });

  // POST /api/workers/:id/queue/process - Process queued commands
  router.post('/:id/queue/process', async (req, res) => {
    try {
      const worker = getWorker(req.params.id);
      if (!worker) {
        return res.status(404).json({ error: 'Resource not found' });
      }
      await processQueue(req.params.id, io);
      res.json({ success: true });
    } catch (error) {
      if (error.message.includes('not found')) {
        return res.status(404).json({ error: 'Resource not found' });
      }
      res.status(500).json({ error: sanitizeErrorMessage(error) });
    }
  });

  // GET /api/workers/:id/summary - Get Ollama-generated summary of worker output
  router.get('/:id/summary', async (req, res) => {
    try {
      const worker = getWorker(req.params.id);

      if (!worker) {
        return res.status(404).json({ error: 'Resource not found' });
      }

      const output = getWorkerOutput(req.params.id);
      const forceRefresh = req.query.refresh === 'true';

      const summary = await generateSummary(req.params.id, output, { forceRefresh });
      res.json(summary);
    } catch (error) {
      res.status(500).json({ error: sanitizeErrorMessage(error) });
    }
  });

  // GET /api/workers/:id/quick-status - Get heuristic status without Ollama
  router.get('/:id/quick-status', (req, res) => {
    try {
      const worker = getWorker(req.params.id);

      if (!worker) {
        return res.status(404).json({ error: 'Resource not found' });
      }

      const output = getWorkerOutput(req.params.id);
      const status = getQuickStatus(output);
      res.json({ ...status, workerId: req.params.id });
    } catch (error) {
      res.status(500).json({ error: sanitizeErrorMessage(error) });
    }
  });

  // GET /api/workers/:id/context - Get cached context for worker
  router.get('/:id/context', (req, res) => {
    try {
      const worker = getWorker(req.params.id);

      if (!worker) {
        return res.status(404).json({ error: 'Resource not found' });
      }

      const context = getWorkerContext(req.params.id);
      res.json({ ...context, workerId: req.params.id });
    } catch (error) {
      res.status(500).json({ error: sanitizeErrorMessage(error) });
    }
  });

  // =============================================
  // BLACKBOARD ROUTES — per-hierarchy shared context
  // =============================================

  // GET /api/workers/:id/blackboard — read blackboard for worker's hierarchy
  router.get('/:id/blackboard', async (req, res) => {
    try {
      const workerId = req.params.id;
      if (!VALID_WORKER_ID.test(workerId)) {
        return res.status(400).json({ error: 'Invalid worker ID format' });
      }

      const worker = getWorkerInternal(workerId);
      if (!worker) {
        return res.status(404).json({ error: 'Resource not found' });
      }

      const { getHierarchyRootId, readBlackboard } = await import('../blackboardDb.js');
      const { workers } = await import('../workers/state.js');
      const rootId = getHierarchyRootId(workerId, workers);
      const bb = await readBlackboard(worker.workingDir, rootId);

      res.json({
        hierarchyRootId: rootId,
        entryCount: bb.entries.length,
        entries: bb.entries,
      });
    } catch (error) {
      res.status(500).json({ error: sanitizeErrorMessage(error) });
    }
  });

  // POST /api/workers/:id/blackboard — append entry to worker's hierarchy blackboard
  router.post('/:id/blackboard', async (req, res) => {
    try {
      const workerId = req.params.id;
      if (!VALID_WORKER_ID.test(workerId)) {
        return res.status(400).json({ error: 'Invalid worker ID format' });
      }

      const worker = getWorkerInternal(workerId);
      if (!worker) {
        return res.status(404).json({ error: 'Resource not found' });
      }

      const { type, key, value } = req.body;
      if (!type || typeof type !== 'string') {
        return res.status(400).json({ error: 'type is required' });
      }
      if (type.length > 50) {
        return res.status(400).json({ error: 'type must be 50 characters or fewer' });
      }
      if (!key || typeof key !== 'string') {
        return res.status(400).json({ error: 'key is required' });
      }
      if (key.length > 200) {
        return res.status(400).json({ error: 'key must be 200 characters or fewer' });
      }
      if (!value || typeof value !== 'string') {
        return res.status(400).json({ error: 'value is required' });
      }
      if (value.length > 10240) {
        return res.status(400).json({ error: 'value must be 10240 characters (10KB) or fewer' });
      }

      const { getHierarchyRootId, appendBlackboardEntry } = await import('../blackboardDb.js');
      const { workers } = await import('../workers/state.js');
      const rootId = getHierarchyRootId(workerId, workers);

      const result = await appendBlackboardEntry(
        worker.workingDir,
        rootId,
        workerId,
        worker.label || workerId,
        type,
        key,
        value
      );

      res.json(result);
    } catch (error) {
      if (error.message?.startsWith('Invalid blackboard entry type')) {
        return res.status(400).json({ error: error.message });
      }
      res.status(500).json({ error: sanitizeErrorMessage(error) });
    }
  });

  // GET /api/workers/:id/review — get review gate result for a worker
  router.get('/:id/review', (req, res) => {
    try {
      const workerId = req.params.id;
      if (!VALID_WORKER_ID.test(workerId)) {
        return res.status(400).json({ error: 'Invalid worker ID format' });
      }
      const result = getReviewResult(workerId);
      if (!result) return res.json({ reviewRun: false });
      return res.json({ reviewRun: true, ...result });
    } catch (error) {
      res.status(500).json({ error: sanitizeErrorMessage(error) });
    }
  });

  // POST /api/workers/:id/review/override — human operator overrides a gate decision
  router.post('/:id/review/override', (req, res) => {
    try {
      const workerId = req.params.id;
      if (!VALID_WORKER_ID.test(workerId)) {
        return res.status(400).json({ error: 'Invalid worker ID format' });
      }
      const { decision, reason } = req.body;
      if (!['pass', 'conditional', 'fail'].includes(decision)) {
        return res.status(400).json({ error: 'decision must be pass, conditional, or fail' });
      }
      if (reason !== undefined && (typeof reason !== 'string' || reason.length > 500)) {
        return res.status(400).json({ error: 'reason must be a string of 500 characters or fewer' });
      }
      // Upsert override — creates row if none exists, updates if one does
      addReviewResult({
        workerId,
        finalDecision: decision,
        stage2Verdict: `Human override: ${reason || 'no reason given'}`,
        deliveredWithAnnotation: 0,
      });
      return res.json({ success: true, workerId, decision });
    } catch (error) {
      res.status(500).json({ error: sanitizeErrorMessage(error) });
    }
  });

  // DELETE /api/workers/:id/blackboard — clear blackboard (internal, called on hierarchy root completion)
  router.delete('/:id/blackboard', async (req, res) => {
    try {
      const workerId = req.params.id;
      if (!VALID_WORKER_ID.test(workerId)) {
        return res.status(400).json({ error: 'Invalid worker ID format' });
      }

      const worker = getWorkerInternal(workerId);
      if (!worker) {
        return res.status(404).json({ error: 'Resource not found' });
      }

      const { getHierarchyRootId, clearBlackboard } = await import('../blackboardDb.js');
      const { workers } = await import('../workers/state.js');
      const rootId = getHierarchyRootId(workerId, workers);

      // Only allow clearing on hierarchy root
      if (rootId !== workerId) {
        return res.status(403).json({ error: 'Blackboard can only be cleared by the hierarchy root worker' });
      }

      await clearBlackboard(worker.workingDir, rootId);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: sanitizeErrorMessage(error) });
    }
  });

  // =============================================
  // AUTO-RESPAWN ROUTES
  // =============================================

  /**
   * POST /api/workers/:id/auto-respawn
   * Register or update auto-respawn for an existing worker.
   *
   * Body: taskDescription (string, required), maxRespawns, cooldownMs, effortLevel,
   *       autoAccept, forcedAutonomy, bulldozeMode
   */
  router.post('/:id/auto-respawn', async (req, res) => {
    try {
      if (!VALID_WORKER_ID.test(req.params.id)) {
        return res.status(400).json({ error: 'Invalid worker ID' });
      }
      const worker = getWorker(req.params.id);
      if (!worker) return res.status(404).json({ error: 'Worker not found' });

      const { taskDescription, maxRespawns, cooldownMs, effortLevel, autoAccept, forcedAutonomy, bulldozeMode } = req.body;

      if (!taskDescription || typeof taskDescription !== 'string') {
        return res.status(400).json({ error: 'taskDescription is required and must be a string' });
      }
      if (taskDescription.length > MAX_TASK_LENGTH) {
        return res.status(400).json({ error: `taskDescription must be under ${MAX_TASK_LENGTH} characters` });
      }

      const { registerAutoRespawn } = await import('../services/autoRespawnService.js');

      registerAutoRespawn(req.params.id, {
        taskDescription,
        projectPath: worker.workingDir,
        label: worker.label,
        maxRespawns: typeof maxRespawns === 'number' ? maxRespawns : 10,
        cooldownMs: typeof cooldownMs === 'number' ? cooldownMs : 120000,
        effortLevel: effortLevel || null,
        autoAccept: autoAccept !== false,
        forcedAutonomy: forcedAutonomy !== false,
        bulldozeMode: bulldozeMode === true,
      });

      // Mark the worker as autoRespawn=true so the death hooks fire
      worker.autoRespawn = true;

      res.json({ success: true, workerId: req.params.id, label: worker.label });
    } catch (error) {
      res.status(500).json({ error: sanitizeErrorMessage(error) });
    }
  });

  /**
   * DELETE /api/workers/:id/auto-respawn
   * Remove auto-respawn registration for a worker.
   */
  router.delete('/:id/auto-respawn', async (req, res) => {
    try {
      if (!VALID_WORKER_ID.test(req.params.id)) {
        return res.status(400).json({ error: 'Invalid worker ID' });
      }
      const { deregisterAutoRespawn } = await import('../services/autoRespawnService.js');
      deregisterAutoRespawn(req.params.id);

      const worker = getWorker(req.params.id);
      if (worker) worker.autoRespawn = false;

      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: sanitizeErrorMessage(error) });
    }
  });

  return router;
}
