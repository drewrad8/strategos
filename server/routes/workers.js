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
  VALID_WORKER_ID, VALID_SIMPLE_ID, CONTROL_CHAR_RE,
  MAX_TASK_LENGTH, MAX_LABEL_LENGTH, MAX_INPUT_LENGTH, isValidSessionId
} from '../validation.js';

const VALID_SESSION_ID = (n) => isValidSessionId(n) && n < 2147483647;

// =============================================
// SPAWN TEMPLATES - Simplified worker spawning
// =============================================

const SPAWN_TEMPLATES = {
  research: {
    prefix: 'RESEARCH',
    autoAccept: true,
    ralphMode: true
  },
  impl: {
    prefix: 'IMPL',
    autoAccept: true,
    ralphMode: true
  },
  test: {
    prefix: 'TEST',
    autoAccept: true,
    ralphMode: true
  },
  review: {
    prefix: 'REVIEW',
    autoAccept: true,
    ralphMode: true
  },
  fix: {
    prefix: 'FIX',
    autoAccept: true,
    ralphMode: true
  },
  general: {
    prefix: 'GENERAL',
    autoAccept: true, // GENERALs need auto-accept to run curl commands; pause-keywords provide safety
    ralphMode: true
  },
  colonel: {
    prefix: 'COLONEL',
    autoAccept: true,
    ralphMode: true
  },
  captain: {
    prefix: 'CAPTAIN',
    autoAccept: true,
    ralphMode: true
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
  }
};

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
        backend: config.backend || 'claude'
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
        backend,        // 'claude' (default) or 'gemini'
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
          return (task.length <= MAX_TASK_LENGTH && !CONTROL_CHAR_RE.test(task)) ? task : undefined;
        }
        if (typeof task === 'object' && !Array.isArray(task)) {
          // Validate object task sub-fields (parity with spawn-from-template)
          const obj = {};
          if (task.description !== undefined) {
            if (typeof task.description !== 'string' || task.description.length > MAX_TASK_LENGTH || CONTROL_CHAR_RE.test(task.description)) return undefined;
            obj.description = task.description;
          }
          for (const field of ['type', 'context', 'purpose', 'endState', 'riskTolerance', 'detailLevel']) {
            if (task[field] !== undefined) {
              if (typeof task[field] !== 'string' || task[field].length > MAX_TASK_LENGTH || CONTROL_CHAR_RE.test(task[field])) return undefined;
              obj[field] = task[field];
            }
          }
          if (task.keyTasks !== undefined) {
            if (!Array.isArray(task.keyTasks) || task.keyTasks.length > 20) return undefined;
            if (!task.keyTasks.every(kt => typeof kt === 'string' && kt.length <= 500 && !CONTROL_CHAR_RE.test(kt))) return undefined;
            obj.keyTasks = task.keyTasks;
          }
          if (task.constraints !== undefined) {
            if (typeof task.constraints === 'string') {
              if (task.constraints.length > 500 || CONTROL_CHAR_RE.test(task.constraints)) return undefined;
              obj.constraints = [task.constraints];
            } else if (Array.isArray(task.constraints)) {
              if (task.constraints.length > 20) return undefined;
              if (!task.constraints.every(c => typeof c === 'string' && c.length <= 500 && !CONTROL_CHAR_RE.test(c))) return undefined;
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
      // Backend selection: 'claude' (default) or 'gemini'
      if (backend === 'gemini') options.backend = 'gemini';
      // Duplicate detection is ON by default — callers must opt-in to duplicates
      options.allowDuplicate = allowDuplicate === true;

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
      const { template: templateField, role, label, projectPath, task, parentWorkerId, allowDuplicate } = req.body;

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

      // Validate task — same rules as main spawn route (string: size + control chars; object: validate description)
      if (typeof task === 'string') {
        if (task.length > MAX_TASK_LENGTH) {
          return res.status(400).json({ error: `task must be under ${MAX_TASK_LENGTH} characters` });
        }
        if (CONTROL_CHAR_RE.test(task)) {
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
          if (CONTROL_CHAR_RE.test(task.description)) {
            return res.status(400).json({ error: 'task.description must not contain control characters' });
          }
        }
        // Validate other string fields if present (constraints validated separately as array)
        for (const field of ['type', 'context', 'purpose', 'endState', 'riskTolerance', 'detailLevel']) {
          if (task[field] !== undefined) {
            if (typeof task[field] !== 'string' || task[field].length > MAX_TASK_LENGTH) {
              return res.status(400).json({ error: `task.${field} must be a string under ${MAX_TASK_LENGTH} characters` });
            }
            if (CONTROL_CHAR_RE.test(task[field])) {
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
            if (typeof kt !== 'string' || kt.length > 500 || CONTROL_CHAR_RE.test(kt)) {
              return res.status(400).json({ error: 'task.keyTasks items must be strings under 500 chars without control characters' });
            }
          }
        }
        // Validate constraints (array of strings, or string converted to single-item array)
        if (task.constraints !== undefined) {
          if (typeof task.constraints === 'string') {
            // Convert string to single-item array for consistency with initializeWorker()
            if (task.constraints.length > 500 || CONTROL_CHAR_RE.test(task.constraints)) {
              return res.status(400).json({ error: 'task.constraints must not contain control characters and be under 500 chars' });
            }
            task.constraints = [task.constraints];
          } else if (Array.isArray(task.constraints)) {
            if (task.constraints.length > 20) {
              return res.status(400).json({ error: 'task.constraints must be an array with at most 20 items' });
            }
            for (const c of task.constraints) {
              if (typeof c !== 'string' || c.length > 500 || CONTROL_CHAR_RE.test(c)) {
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
      const options = {
        autoAccept: tmpl.autoAccept,
        ralphMode: tmpl.ralphMode,
        backend: tmpl.backend || 'claude',
        task: taskObj,
        parentWorkerId,
        parentLabel: parent?.label,
        allowDuplicate: allowDuplicate === true
      };

      const worker = await spawnWorker(resolvedPath, fullLabel, io, options);

      // Register with Ralph if enabled
      if (tmpl.ralphMode && worker.ralphToken) {
        const ralphService = req.app.locals.ralphService;
        if (ralphService) {
          ralphService.registerStandaloneWorker(worker.ralphToken, worker.id);
        }
      }

      // Atomically enable bulldoze if requested (avoids two-step spawn + settings dance)
      if (req.body.bulldozeMode) {
        const bulldozeSettings = { bulldozeMode: true };
        if (req.body.bulldozeMission) bulldozeSettings.bulldozeMission = String(req.body.bulldozeMission).slice(0, MAX_TASK_LENGTH);
        if (req.body.bulldozeBacklog) bulldozeSettings.bulldozeBacklog = String(req.body.bulldozeBacklog).slice(0, MAX_TASK_LENGTH);
        if (req.body.bulldozeStandingOrders) bulldozeSettings.bulldozeStandingOrders = String(req.body.bulldozeStandingOrders).slice(0, MAX_TASK_LENGTH);
        updateWorkerSettings(worker.id, bulldozeSettings, io);
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
        bulldozeMission, bulldozeBacklog, bulldozeStandingOrders } = req.body;
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
      if (bulldozePaused !== undefined) {
        if (typeof bulldozePaused !== 'boolean') return res.status(400).json({ error: 'bulldozePaused must be a boolean' });
        settings.bulldozePaused = bulldozePaused;
      }
      // Bulldoze text fields are multiline — allow \n \r \t but reject other control chars
      const MULTILINE_CONTROL_CHAR_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
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
            await sendInput(req.params.id, instructions);
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

      await sendInput(req.params.id, input, null, { fromWorkerId });
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
      if (prompt.length > 50000) {
        return res.status(400).json({ error: 'prompt must be under 50000 characters' });
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
  router.get('/:id/output', (req, res) => {
    try {
      const worker = getWorker(req.params.id);

      if (!worker) {
        return res.status(404).json({ error: 'Resource not found' });
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
      const sessionId = (rawSessionId !== null && VALID_SESSION_ID(rawSessionId)) ? rawSessionId : null;

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

  return router;
}
