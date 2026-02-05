import express from 'express';
import path from 'path';
import fs from 'fs';
import os from 'os';
import multer from 'multer';
import {
  getWorkers,
  getWorker,
  getWorkersByProject,
  spawnWorker,
  killWorker,
  updateWorkerLabel,
  updateWorkerSettings,
  getActivityLog,
  sendInput,
  getWorkerOutput,
  runHeadless,
  runBatchOperation,
  processQueue,
  completeWorker,
  getWorkerDependencies,
  getPendingWorkers,
  createWorkflow,
  startWorkflow,
  getWorkflow,
  getWorkflows,
  getDependencyStats,
  getResourceStats,
  getChildWorkers,
  getSiblingWorkers
} from './workerManager.js';
import {
  scanProjects,
  getProject,
  projectExists,
  getProjectsWithConfig,
  getProjectTree,
  loadProjectConfig,
  saveProjectConfig,
  safeResolvePath,
  addExternalProject,
  removeExternalProject,
  listExternalProjects
} from './projectScanner.js';
import {
  generateSummary,
  getWorkerContext,
  getQuickStatus,
  checkOllamaHealth,
  getSummariesEnabled,
  setSummariesEnabled,
  executePrompt
} from './summaryService.js';
import {
  processVoiceCommand,
  getConversationHistory,
  clearConversationHistory
} from './orchestratorService.js';
import {
  analyzeAndSuggestWorkflows,
  getWorkflowSuggestions,
  getPatternStats,
  acceptWorkflow,
  storeActivityEvent,
  syncActivityLog
} from './activityPatternService.js';
import {
  getWorkerSessions,
  getWorkerHistory,
  getSessionOutput,
  getSessionFullOutput,
  getSession,
  getStats as getOutputDbStats,
  cleanupOldData
} from './workerOutputDb.js';
import {
  getMetricsService,
  MetricTypes
} from './metricsService.js';

// Helper function to format uptime in human-readable format
function formatUptime(seconds) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${mins}m`;
}

export function createRoutes(theaRoot, io) {
  const router = express.Router();

  // Configure multer for screenshot uploads
  const uploadsDir = path.join(theaRoot, 'strategos', 'uploads', 'screenshots');
  fs.mkdirSync(uploadsDir, { recursive: true });

  const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => {
      const timestamp = Date.now();
      const workerId = req.body.workerId || 'unknown';
      const ext = path.extname(file.originalname) || '.png';
      cb(null, `${timestamp}-${workerId}${ext}`);
    }
  });

  const upload = multer({
    storage,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max
    fileFilter: (req, file, cb) => {
      const allowedTypes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
      if (allowedTypes.includes(file.mimetype)) {
        cb(null, true);
      } else {
        cb(new Error('Only image files are allowed'));
      }
    }
  });

  // POST /api/uploads/screenshot - Upload screenshot for worker debugging
  router.post('/uploads/screenshot', upload.single('screenshot'), (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
      }

      const filePath = req.file.path;
      const workerId = req.body.workerId;

      res.json({
        success: true,
        path: filePath,
        filename: req.file.filename,
        workerId,
        message: `Screenshot saved. Claude can view it at: ${filePath}`
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // GET /api/workers - List all workers
  router.get('/workers', (req, res) => {
    try {
      const workers = getWorkers();
      res.json(workers);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // GET /api/workers/pending - List all pending workers (waiting on dependencies)
  // NOTE: This route MUST be before /api/workers/:id to avoid matching "pending" as an ID
  router.get('/workers/pending', (req, res) => {
    try {
      const pending = getPendingWorkers();
      res.json(pending);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * GET /api/workers/tree
   * Get hierarchical view of all workers showing parent-child relationships
   */
  router.get('/workers/tree', (req, res) => {
    try {
      const allWorkers = getWorkers();

      // Build a map for quick lookup
      const workerMap = new Map(allWorkers.map(w => [w.id, w]));

      // Find root workers (no parent)
      const roots = allWorkers.filter(w => !w.parentWorkerId);

      // Recursive function to build tree
      function buildTree(worker) {
        const children = (worker.childWorkerIds || [])
          .map(id => workerMap.get(id))
          .filter(Boolean)
          .map(buildTree);

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
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * GET /api/workers/templates
   * List available spawn templates
   */
  router.get('/workers/templates', (req, res) => {
    const templates = Object.entries(SPAWN_TEMPLATES).map(([name, config]) => ({
      name,
      prefix: config.prefix,
      autoAccept: config.autoAccept,
      ralphMode: config.ralphMode,
      taskType: config.taskDefaults.type
    }));
    res.json({ templates });
  });

  // GET /api/workers/:id - Get single worker
  router.get('/workers/:id', (req, res) => {
    try {
      const worker = getWorker(req.params.id);

      if (!worker) {
        return res.status(404).json({ error: 'Worker not found' });
      }

      res.json(worker);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // POST /api/workers - Spawn new worker (with optional dependencies)
  router.post('/workers', async (req, res) => {
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
        ralphMode       // Enable Ralph autonomous completion signaling (default false)
      } = req.body;

      if (!projectPath) {
        return res.status(400).json({ error: 'projectPath is required' });
      }

      // SECURITY: Safely resolve project path with traversal prevention
      const resolvedPath = safeResolvePath(projectPath, theaRoot);
      if (!resolvedPath) {
        return res.status(400).json({ error: 'Invalid project path - path traversal not allowed' });
      }

      if (!projectExists(resolvedPath)) {
        return res.status(400).json({ error: `Project path does not exist: ${resolvedPath}` });
      }

      // Spawn with optional dependency and context options
      const options = {};
      if (dependsOn) options.dependsOn = dependsOn;
      if (onComplete) options.onComplete = onComplete;
      if (workflowId) options.workflowId = workflowId;
      if (taskId) options.taskId = taskId;
      // Context passing options
      if (task) options.task = task;
      if (parentWorkerId) options.parentWorkerId = parentWorkerId;
      if (parentLabel) options.parentLabel = parentLabel;
      if (initialInput) options.initialInput = initialInput;
      if (autoAccept !== undefined) options.autoAccept = autoAccept;
      if (ralphMode !== undefined) options.ralphMode = ralphMode;

      const worker = await spawnWorker(resolvedPath, label, io, options);

      // If Ralph mode enabled, register with ralphService and send instructions
      if (ralphMode && worker.ralphToken) {
        const ralphService = req.app.locals.ralphService;
        if (ralphService) {
          ralphService.registerStandaloneWorker(worker.ralphToken, worker.id);
        }
      }

      res.status(201).json(worker);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // =============================================
  // SPAWN TEMPLATES - Simplified worker spawning
  // =============================================

  const SPAWN_TEMPLATES = {
    research: {
      prefix: 'RESEARCH',
      autoAccept: true,
      ralphMode: true,
      taskDefaults: { type: 'research' }
    },
    impl: {
      prefix: 'IMPL',
      autoAccept: true,
      ralphMode: true,
      taskDefaults: { type: 'implementation' }
    },
    test: {
      prefix: 'TEST',
      autoAccept: true,
      ralphMode: true,
      taskDefaults: { type: 'testing' }
    },
    review: {
      prefix: 'REVIEW',
      autoAccept: true,
      ralphMode: true,
      taskDefaults: { type: 'review' }
    },
    fix: {
      prefix: 'FIX',
      autoAccept: true,
      ralphMode: true,
      taskDefaults: { type: 'bugfix' }
    },
    general: {
      prefix: 'GENERAL',
      autoAccept: true,
      ralphMode: true,
      taskDefaults: { type: 'strategic' }
    },
    colonel: {
      prefix: 'COLONEL',
      autoAccept: true,
      ralphMode: true,
      taskDefaults: { type: 'coordination' }
    }
  };

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
  router.post('/workers/spawn-from-template', async (req, res) => {
    try {
      const { template, label, projectPath, task, parentWorkerId } = req.body;

      if (!template) {
        return res.status(400).json({ error: 'template is required' });
      }

      const tmpl = SPAWN_TEMPLATES[template.toLowerCase()];
      if (!tmpl) {
        return res.status(400).json({
          error: `Unknown template: ${template}`,
          availableTemplates: Object.keys(SPAWN_TEMPLATES)
        });
      }

      if (!label) {
        return res.status(400).json({ error: 'label is required' });
      }

      if (!task) {
        return res.status(400).json({ error: 'task is required' });
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

      // Construct full label with prefix
      const fullLabel = `${tmpl.prefix}: ${label}`;

      // Construct task object
      const taskObj = typeof task === 'string'
        ? { description: task, ...tmpl.taskDefaults }
        : { ...tmpl.taskDefaults, ...task };

      // Spawn with template settings
      const options = {
        autoAccept: tmpl.autoAccept,
        ralphMode: tmpl.ralphMode,
        task: taskObj,
        parentWorkerId,
        parentLabel: parent?.label
      };

      const worker = await spawnWorker(resolvedPath, fullLabel, io, options);

      // Register with Ralph if enabled
      if (tmpl.ralphMode && worker.ralphToken) {
        const ralphService = req.app.locals.ralphService;
        if (ralphService) {
          ralphService.registerStandaloneWorker(worker.ralphToken, worker.id);
        }
      }

      res.status(201).json(worker);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * POST /api/workers/batch-spawn
   * Spawn multiple workers in parallel
   *
   * STATUS: DISABLED - Risk of cascade spawning. Code preserved for future use.
   * To re-enable: Remove the early return below.
   *
   * Body:
   *   - workers: array of spawn configs (each can have template, label, task, etc.)
   *   - projectPath: string (optional) - Default project path for all workers
   *   - parentWorkerId: string (optional) - Parent worker ID for all workers
   */
  router.post('/workers/batch-spawn', async (req, res) => {
    // DISABLED: Risk of cascade spawning - use spawn-from-template sequentially instead
    return res.status(403).json({
      error: 'Batch spawn is disabled',
      reason: 'Risk of cascade spawning. Use /api/workers/spawn-from-template sequentially.',
      hint: 'To re-enable, edit server/routes.js and remove the early return in batch-spawn handler'
    });

    try {
      const { workers: workerConfigs, projectPath: defaultPath, parentWorkerId } = req.body;

      if (!workerConfigs || !Array.isArray(workerConfigs) || workerConfigs.length === 0) {
        return res.status(400).json({ error: 'workers array is required and must not be empty' });
      }

      if (workerConfigs.length > 10) {
        return res.status(400).json({ error: 'Maximum 10 workers per batch' });
      }

      const parent = parentWorkerId ? getWorker(parentWorkerId) : null;
      const basePath = safeResolvePath(defaultPath || parent?.workingDir || theaRoot, theaRoot);

      const results = await Promise.allSettled(
        workerConfigs.map(async (config) => {
          const { template, label, task, projectPath } = config;

          // Use template if provided, otherwise default settings
          let prefix = config.prefix || 'WORKER';
          let autoAccept = config.autoAccept ?? true;
          let ralphMode = config.ralphMode ?? true;
          let taskDefaults = {};

          if (template && SPAWN_TEMPLATES[template.toLowerCase()]) {
            const tmpl = SPAWN_TEMPLATES[template.toLowerCase()];
            prefix = tmpl.prefix;
            autoAccept = tmpl.autoAccept;
            ralphMode = tmpl.ralphMode;
            taskDefaults = tmpl.taskDefaults;
          }

          const fullLabel = label.includes(':') ? label : `${prefix}: ${label}`;
          const resolvedPath = safeResolvePath(projectPath || basePath, theaRoot);

          if (!resolvedPath) {
            throw new Error(`Invalid project path for worker: ${label}`);
          }

          const taskObj = typeof task === 'string'
            ? { description: task, ...taskDefaults }
            : { ...taskDefaults, ...task };

          const worker = await spawnWorker(resolvedPath, fullLabel, io, {
            autoAccept,
            ralphMode,
            task: taskObj,
            parentWorkerId,
            parentLabel: parent?.label
          });

          // Register with Ralph if enabled
          if (ralphMode && worker.ralphToken) {
            const ralphService = req.app.locals.ralphService;
            if (ralphService) {
              ralphService.registerStandaloneWorker(worker.ralphToken, worker.id);
            }
          }

          return worker;
        })
      );

      const spawned = results
        .filter(r => r.status === 'fulfilled')
        .map(r => r.value);

      const failed = results
        .filter(r => r.status === 'rejected')
        .map((r, i) => ({ index: i, error: r.reason.message }));

      res.status(201).json({
        spawned,
        failed,
        summary: {
          total: workerConfigs.length,
          succeeded: spawned.length,
          failed: failed.length
        }
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // DELETE /api/workers/:id - Kill worker
  router.delete('/workers/:id', async (req, res) => {
    try {
      await killWorker(req.params.id, io);
      res.json({ success: true });
    } catch (error) {
      if (error.message.includes('not found')) {
        return res.status(404).json({ error: error.message });
      }
      res.status(500).json({ error: error.message });
    }
  });

  // PATCH /api/workers/:id - Update worker label
  router.patch('/workers/:id', (req, res) => {
    try {
      const { label } = req.body;

      if (!label) {
        return res.status(400).json({ error: 'label is required' });
      }

      const worker = updateWorkerLabel(req.params.id, label, io);
      res.json(worker);
    } catch (error) {
      if (error.message.includes('not found')) {
        return res.status(404).json({ error: error.message });
      }
      res.status(500).json({ error: error.message });
    }
  });

  // POST /api/workers/:id/settings - Update worker settings (autoAccept, ralphMode, etc.)
  router.post('/workers/:id/settings', async (req, res) => {
    try {
      const { autoAccept, autoAcceptPaused, ralphMode } = req.body;
      const settings = {};
      if (autoAccept !== undefined) settings.autoAccept = autoAccept;
      if (autoAcceptPaused !== undefined) settings.autoAcceptPaused = autoAcceptPaused;
      if (ralphMode !== undefined) settings.ralphMode = ralphMode;

      if (Object.keys(settings).length === 0) {
        return res.status(400).json({ error: 'No valid settings provided' });
      }

      // Get worker before update to check previous Ralph state
      const workerBefore = getWorker(req.params.id);
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
          ralphToken: worker.ralphToken
        }
      });
    } catch (error) {
      if (error.message.includes('not found')) {
        return res.status(404).json({ error: error.message });
      }
      res.status(500).json({ error: error.message });
    }
  });

  // POST /api/workers/:id/input - Send input to worker
  router.post('/workers/:id/input', async (req, res) => {
    try {
      const { input } = req.body;

      if (!input) {
        return res.status(400).json({ error: 'input is required' });
      }

      await sendInput(req.params.id, input);
      res.json({ success: true });
    } catch (error) {
      if (error.message.includes('not found')) {
        return res.status(404).json({ error: error.message });
      }
      res.status(500).json({ error: error.message });
    }
  });

  // POST /api/workers/execute - Execute a prompt via LLM (for testing/evaluation)
  // This endpoint provides synchronous LLM execution for promptfoo testing
  router.post('/workers/execute', async (req, res) => {
    try {
      const {
        prompt,
        model,
        maxTokens,
        temperature,
        systemPrompt
      } = req.body;

      if (!prompt) {
        return res.status(400).json({ error: 'prompt is required' });
      }

      const startTime = Date.now();
      const result = await executePrompt(prompt, {
        model,
        maxTokens,
        temperature,
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
        error: error.message
      });
    }
  });

  // GET /api/workers/:id/output - Get worker output buffer
  router.get('/workers/:id/output', (req, res) => {
    try {
      const worker = getWorker(req.params.id);

      if (!worker) {
        return res.status(404).json({ error: 'Worker not found' });
      }

      const output = getWorkerOutput(req.params.id);
      res.json({ output });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // GET /api/workers/:id/history - Get paginated historical output
  router.get('/workers/:id/history', (req, res) => {
    try {
      const workerId = req.params.id;
      const limit = parseInt(req.query.limit) || 100;
      const offset = parseInt(req.query.offset) || 0;
      const sessionId = req.query.sessionId ? parseInt(req.query.sessionId) : null;

      const history = getWorkerHistory(workerId, { limit, offset, sessionId });
      res.json(history);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // GET /api/workers/:id/sessions - List past sessions for a worker
  router.get('/workers/:id/sessions', (req, res) => {
    try {
      const workerId = req.params.id;
      const limit = parseInt(req.query.limit) || 20;
      const offset = parseInt(req.query.offset) || 0;

      const sessions = getWorkerSessions(workerId, { limit, offset });
      res.json(sessions);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // GET /api/sessions/:id - Get a specific session
  router.get('/sessions/:id', (req, res) => {
    try {
      const sessionId = parseInt(req.params.id);
      const session = getSession(sessionId);

      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      res.json(session);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // GET /api/sessions/:id/output - Get output for a specific session
  router.get('/sessions/:id/output', (req, res) => {
    try {
      const sessionId = parseInt(req.params.id);
      const limit = parseInt(req.query.limit) || 100;
      const offset = parseInt(req.query.offset) || 0;

      const session = getSession(sessionId);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      const output = getSessionOutput(sessionId, { limit, offset });
      res.json(output);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // GET /api/sessions/:id/full-output - Get full concatenated output for a session
  router.get('/sessions/:id/full-output', (req, res) => {
    try {
      const sessionId = parseInt(req.params.id);

      const session = getSession(sessionId);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      const output = getSessionFullOutput(sessionId);
      res.json({ sessionId, output });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // GET /api/output-db/stats - Get output database statistics
  router.get('/output-db/stats', (req, res) => {
    try {
      const stats = getOutputDbStats();
      res.json(stats);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // POST /api/output-db/cleanup - Trigger manual cleanup
  router.post('/output-db/cleanup', (req, res) => {
    try {
      const daysToKeep = parseInt(req.body.daysToKeep) || 7;
      const result = cleanupOldData(daysToKeep);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // ============================================
  // DEPENDENCY AND WORKFLOW MANAGEMENT
  // ============================================

  // GET /api/workers/:id/dependencies - Get dependency status for a worker
  router.get('/workers/:id/dependencies', (req, res) => {
    try {
      const deps = getWorkerDependencies(req.params.id);

      if (!deps) {
        // Worker exists but has no dependencies registered
        const worker = getWorker(req.params.id);
        if (!worker) {
          return res.status(404).json({ error: 'Worker not found' });
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
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * GET /api/workers/:id/children
   * Get all child workers spawned by this worker with their Ralph status
   * Useful for parent workers (especially GENERALs) to monitor progress without reading output
   */
  router.get('/workers/:id/children', (req, res) => {
    try {
      const worker = getWorker(req.params.id);
      if (!worker) {
        return res.status(404).json({ error: 'Worker not found' });
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
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * GET /api/workers/:id/siblings
   * Get sibling workers (other workers with same parent)
   * Useful for workers to coordinate and avoid duplicate work
   */
  router.get('/workers/:id/siblings', (req, res) => {
    try {
      const worker = getWorker(req.params.id);
      if (!worker) {
        return res.status(404).json({ error: 'Worker not found' });
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
      res.status(500).json({ error: error.message });
    }
  });

  // POST /api/workers/:id/complete - Mark a worker as completed
  router.post('/workers/:id/complete', async (req, res) => {
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
        return res.status(404).json({ error: error.message });
      }
      res.status(500).json({ error: error.message });
    }
  });

  // ============================================
  // VERIFICATION ROUTES (CRITIC Framework)
  // ============================================

  // POST /api/workers/:id/task-context - Register task context for verification
  router.post('/workers/:id/task-context', (req, res) => {
    const { verificationService } = req.app.locals.services || {};
    if (!verificationService) {
      return res.status(503).json({ error: 'Verification service not available' });
    }

    const { taskType, testCommand, lintCommand, requiredFields, schema, verificationContext } = req.body;

    if (!taskType) {
      return res.status(400).json({ error: 'taskType is required' });
    }

    const validTypes = ['code', 'factual', 'reasoning', 'format'];
    if (!validTypes.includes(taskType)) {
      return res.status(400).json({
        error: `Invalid taskType. Must be one of: ${validTypes.join(', ')}`
      });
    }

    try {
      const context = verificationService.registerTaskContext(req.params.id, {
        taskType,
        testCommand,
        lintCommand,
        requiredFields,
        schema,
        verificationContext
      });

      res.json({
        success: true,
        workerId: req.params.id,
        context
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // GET /api/workers/:id/task-context - Get task context for a worker
  router.get('/workers/:id/task-context', (req, res) => {
    const { verificationService } = req.app.locals.services || {};
    if (!verificationService) {
      return res.status(503).json({ error: 'Verification service not available' });
    }

    const context = verificationService.getTaskContext(req.params.id);
    if (!context) {
      return res.status(404).json({ error: 'No task context registered for this worker' });
    }

    res.json({
      workerId: req.params.id,
      context
    });
  });

  // POST /api/workers/:id/verify - Verify worker output (CRITIC)
  router.post('/workers/:id/verify', async (req, res) => {
    const { verificationService } = req.app.locals.services || {};
    if (!verificationService) {
      return res.status(503).json({ error: 'Verification service not available' });
    }

    const { output } = req.body; // Optional: specific output to verify

    try {
      const result = await verificationService.verifyWorkerOutput(req.params.id, output);

      res.json({
        workerId: req.params.id,
        valid: result.valid,
        confidence: result.confidence,
        taskType: result.taskType,
        critiques: result.critiques,
        verificationTime: result.verificationTime
      });
    } catch (error) {
      if (error.message.includes('not found')) {
        return res.status(404).json({ error: error.message });
      }
      res.status(500).json({ error: error.message });
    }
  });

  // POST /api/workers/:id/correct - Run correction loop (CRITIC self-correction)
  router.post('/workers/:id/correct', async (req, res) => {
    const { verificationService } = req.app.locals.services || {};
    if (!verificationService) {
      return res.status(503).json({ error: 'Verification service not available' });
    }

    const { output } = req.body; // Optional: specific output to correct

    try {
      const result = await verificationService.runCorrectionLoop(req.params.id, output);

      res.json({
        workerId: req.params.id,
        success: result.success,
        iterations: result.iterations,
        stopReason: result.stopReason,
        confidence: result.confidence,
        remainingIssues: result.remainingIssues,
        history: result.history
      });
    } catch (error) {
      if (error.message.includes('not found')) {
        return res.status(404).json({ error: error.message });
      }
      res.status(500).json({ error: error.message });
    }
  });

  // POST /api/workers/:id/verify-and-complete - Verify then mark complete
  router.post('/workers/:id/verify-and-complete', async (req, res) => {
    const { verificationService } = req.app.locals.services || {};
    if (!verificationService) {
      return res.status(503).json({ error: 'Verification service not available' });
    }

    const { runCorrection = false, output } = req.body;

    try {
      // First verify (and optionally correct)
      const verificationResult = await verificationService.verifyCompletion(req.params.id, {
        runCorrection,
        output
      });

      // If verified, complete the worker
      if (verificationResult.verified) {
        const completionResult = await completeWorker(req.params.id, io);

        res.json({
          workerId: req.params.id,
          verified: true,
          correctionRun: verificationResult.correctionRun,
          verification: verificationResult.result,
          completion: {
            success: true,
            worker: completionResult.worker,
            triggeredWorkers: completionResult.triggeredWorkers.map(w => ({
              id: w.id,
              label: w.label
            }))
          }
        });
      } else {
        // Not verified - return verification result without completing
        res.json({
          workerId: req.params.id,
          verified: false,
          correctionRun: verificationResult.correctionRun,
          verification: verificationResult.result,
          completion: null,
          message: 'Worker output did not pass verification. Worker not marked as complete.'
        });
      }
    } catch (error) {
      if (error.message.includes('not found')) {
        return res.status(404).json({ error: error.message });
      }
      res.status(500).json({ error: error.message });
    }
  });

  // GET /api/verification/metrics - Get verification service metrics
  router.get('/verification/metrics', (req, res) => {
    const { verificationService } = req.app.locals.services || {};
    if (!verificationService) {
      return res.status(503).json({ error: 'Verification service not available' });
    }

    res.json(verificationService.getMetrics());
  });

  // ============================================
  // Self-Optimization API (Automated Test-Fix Cycles)
  // ============================================

  // POST /api/optimize/start - Start an optimization cycle for a project
  router.post('/optimize/start', async (req, res) => {
    const { selfOptimizeService } = req.app.locals.services || {};
    if (!selfOptimizeService) {
      return res.status(503).json({ error: 'Self-optimize service not available' });
    }

    try {
      const { projectPath, testCommand, testPattern, maxIterations, autoSpawnFix } = req.body;

      if (!projectPath) {
        return res.status(400).json({ error: 'projectPath is required' });
      }

      // Resolve project path
      const resolvedPath = safeResolvePath(projectPath, theaRoot);
      if (!resolvedPath) {
        return res.status(400).json({ error: 'Invalid project path: path traversal not allowed' });
      }
      if (!projectExists(resolvedPath)) {
        return res.status(400).json({ error: `Project path does not exist: ${resolvedPath}` });
      }

      // Start optimization cycle (async - returns immediately with cycle ID)
      const result = await selfOptimizeService.startCycle(resolvedPath, {
        testCommand,
        testPattern,
        maxIterations,
        autoSpawnFix
      });

      res.json(result);
    } catch (error) {
      console.error('Optimize start error:', error.message);
      res.status(500).json({ error: error.message });
    }
  });

  // GET /api/optimize/cycles - Get all active optimization cycles
  router.get('/optimize/cycles', (req, res) => {
    const { selfOptimizeService } = req.app.locals.services || {};
    if (!selfOptimizeService) {
      return res.status(503).json({ error: 'Self-optimize service not available' });
    }

    res.json(selfOptimizeService.getActiveCycles());
  });

  // GET /api/optimize/cycles/:cycleId - Get status of a specific cycle
  router.get('/optimize/cycles/:cycleId', (req, res) => {
    const { selfOptimizeService } = req.app.locals.services || {};
    if (!selfOptimizeService) {
      return res.status(503).json({ error: 'Self-optimize service not available' });
    }

    const result = selfOptimizeService.getCycleResult(req.params.cycleId);
    if (!result) {
      return res.status(404).json({ error: 'Cycle not found' });
    }

    res.json(result);
  });

  // POST /api/optimize/cycles/:cycleId/cancel - Cancel an active cycle
  router.post('/optimize/cycles/:cycleId/cancel', (req, res) => {
    const { selfOptimizeService } = req.app.locals.services || {};
    if (!selfOptimizeService) {
      return res.status(503).json({ error: 'Self-optimize service not available' });
    }

    const success = selfOptimizeService.cancelCycle(req.params.cycleId);
    if (!success) {
      return res.status(404).json({ error: 'Cycle not found or already completed' });
    }

    res.json({ success: true, message: 'Cycle cancelled' });
  });

  // GET /api/optimize/metrics - Get self-optimize service metrics
  router.get('/optimize/metrics', (req, res) => {
    const { selfOptimizeService } = req.app.locals.services || {};
    if (!selfOptimizeService) {
      return res.status(503).json({ error: 'Self-optimize service not available' });
    }

    res.json(selfOptimizeService.getMetrics());
  });

  // POST /api/workflows - Create a new workflow
  router.post('/workflows', async (req, res) => {
    try {
      const { name, description, tasks } = req.body;

      if (!name) {
        return res.status(400).json({ error: 'name is required' });
      }

      if (!tasks || !Array.isArray(tasks) || tasks.length === 0) {
        return res.status(400).json({ error: 'tasks array is required' });
      }

      // Validate task structure
      for (const task of tasks) {
        if (!task.projectPath) {
          return res.status(400).json({ error: 'Each task requires a projectPath' });
        }

        // SECURITY: Validate all project paths
        const resolvedPath = safeResolvePath(task.projectPath, theaRoot);
        if (!resolvedPath) {
          return res.status(400).json({
            error: `Invalid project path for task "${task.id || task.label}": path traversal not allowed`
          });
        }
        if (!projectExists(resolvedPath)) {
          return res.status(400).json({
            error: `Project path does not exist for task "${task.id || task.label}": ${resolvedPath}`
          });
        }
        // Store resolved path
        task.resolvedPath = resolvedPath;
      }

      // Create the workflow
      const result = createWorkflow({ name, description, tasks });

      if (!result.success) {
        return res.status(400).json({ error: result.error, cyclePath: result.cyclePath });
      }

      res.status(201).json(result.workflow);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // GET /api/workflows - List all workflows
  router.get('/workflows', (req, res) => {
    try {
      const workflows = getWorkflows();
      res.json(workflows);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // GET /api/workflows/:id - Get a specific workflow
  router.get('/workflows/:id', (req, res) => {
    try {
      const workflow = getWorkflow(req.params.id);

      if (!workflow) {
        return res.status(404).json({ error: 'Workflow not found' });
      }

      res.json(workflow);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // POST /api/workflows/:id/start - Start a workflow (spawn initial tasks)
  router.post('/workflows/:id/start', async (req, res) => {
    try {
      const workflow = getWorkflow(req.params.id);

      if (!workflow) {
        return res.status(404).json({ error: 'Workflow not found' });
      }

      const startResult = startWorkflow(req.params.id);
      if (!startResult.success) {
        return res.status(400).json({ error: startResult.error });
      }

      // Spawn workers for ready tasks
      const spawnedWorkers = [];
      for (const task of startResult.readyTasks) {
        try {
          const worker = await spawnWorker(
            task.resolvedPath || task.projectPath,
            task.label || task.id,
            io,
            {
              dependsOn: task.dependsOn || [],
              onComplete: task.onComplete || null,
              workflowId: req.params.id,
              taskId: task.id
            }
          );
          spawnedWorkers.push(worker);
        } catch (error) {
          console.error(`Failed to spawn task ${task.id}:`, error.message);
        }
      }

      res.json({
        success: true,
        workflow: startResult.workflow,
        spawnedWorkers: spawnedWorkers.map(w => ({
          id: w.id,
          label: w.label,
          status: w.status,
          taskId: w.taskId
        }))
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // GET /api/dependencies/stats - Get dependency graph statistics
  router.get('/dependencies/stats', (req, res) => {
    try {
      const stats = getDependencyStats();
      res.json(stats);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // GET /api/projects - List all projects (with optional tree view)
  router.get('/projects', (req, res) => {
    try {
      const { view } = req.query; // 'flat', 'tree', or 'full'
      const workers = getWorkers();

      if (view === 'tree') {
        // Return folder-based tree structure
        const tree = getProjectTree(theaRoot);
        // Attach workers to each project in the tree
        for (const folder of tree) {
          for (const project of folder.projects) {
            project.workers = workers.filter(w => w.project === project.name);
          }
        }
        return res.json(tree);
      }

      if (view === 'full') {
        // Return full config with enriched projects
        const data = getProjectsWithConfig(theaRoot);
        data.projects = data.projects.map(p => ({
          ...p,
          workers: workers.filter(w => w.project === p.name)
        }));
        return res.json(data);
      }

      // Default: flat list (backwards compatible)
      const projects = scanProjects(theaRoot);
      const projectsWithWorkers = projects.map(p => ({
        ...p,
        workers: workers.filter(w => w.project === p.name)
      }));

      res.json(projectsWithWorkers);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // GET /api/projects/config - Get project organization config
  router.get('/projects/config', (req, res) => {
    try {
      const config = loadProjectConfig(theaRoot);
      res.json(config);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // PUT /api/projects/config - Update project organization config
  router.put('/projects/config', (req, res) => {
    try {
      const config = req.body;
      const success = saveProjectConfig(theaRoot, config);
      if (success) {
        res.json({ success: true, config });
      } else {
        res.status(500).json({ error: 'Failed to save config' });
      }
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // GET /api/projects/external - List external project directories
  router.get('/projects/external', (req, res) => {
    try {
      const external = listExternalProjects(theaRoot);
      res.json(external);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // POST /api/projects/external - Add an external project directory
  router.post('/projects/external', (req, res) => {
    try {
      const { path: projectPath } = req.body;
      if (!projectPath) {
        return res.status(400).json({ error: 'path is required' });
      }
      const result = addExternalProject(theaRoot, projectPath);
      if (result.success) {
        res.json(result);
      } else {
        res.status(400).json({ error: result.error });
      }
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // DELETE /api/projects/external - Remove an external project directory
  router.delete('/projects/external', (req, res) => {
    try {
      const { path: projectPath } = req.body;
      if (!projectPath) {
        return res.status(400).json({ error: 'path is required' });
      }
      const result = removeExternalProject(theaRoot, projectPath);
      if (result.success) {
        res.json(result);
      } else {
        res.status(400).json({ error: result.error });
      }
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // GET /api/projects/:name - Get single project with workers
  router.get('/projects/:name', (req, res) => {
    try {
      const project = getProject(theaRoot, req.params.name);

      if (!project) {
        return res.status(404).json({ error: 'Project not found' });
      }

      const workers = getWorkersByProject(req.params.name);
      res.json({ ...project, workers });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // GET /api/activity - Get activity log
  router.get('/activity', (req, res) => {
    try {
      const activity = getActivityLog();
      res.json(activity);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // POST /api/workers/:id/queue/process - Process queued commands
  router.post('/workers/:id/queue/process', async (req, res) => {
    try {
      await processQueue(req.params.id, io);
      res.json({ success: true });
    } catch (error) {
      if (error.message.includes('not found')) {
        return res.status(404).json({ error: error.message });
      }
      res.status(500).json({ error: error.message });
    }
  });

  // POST /api/headless - Run Claude in headless mode
  router.post('/headless', async (req, res) => {
    try {
      const { projectPath, prompt, outputFormat, systemPrompt, timeout } = req.body;

      if (!projectPath || !prompt) {
        return res.status(400).json({ error: 'projectPath and prompt are required' });
      }

      // SECURITY: Safely resolve project path with traversal prevention
      const resolvedPath = safeResolvePath(projectPath, theaRoot);
      if (!resolvedPath) {
        return res.status(400).json({ error: 'Invalid project path - path traversal not allowed' });
      }

      if (!projectExists(resolvedPath)) {
        return res.status(400).json({ error: `Project path does not exist: ${resolvedPath}` });
      }

      const result = await runHeadless(resolvedPath, prompt, {
        outputFormat,
        systemPrompt,
        timeout
      });

      res.json({ success: true, result });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // POST /api/batch - Run batch operation across multiple projects
  router.post('/batch', async (req, res) => {
    try {
      const { projects, prompt, outputFormat, systemPrompt, timeout } = req.body;

      if (!projects || !Array.isArray(projects) || projects.length === 0) {
        return res.status(400).json({ error: 'projects array is required' });
      }

      if (!prompt) {
        return res.status(400).json({ error: 'prompt is required' });
      }

      // SECURITY: Safely resolve project paths with traversal prevention
      const validPaths = [];
      const blockedPaths = [];

      for (const projectPath of projects) {
        const resolvedPath = safeResolvePath(projectPath, theaRoot);
        if (!resolvedPath) {
          blockedPaths.push(projectPath);
          continue;
        }
        if (projectExists(resolvedPath)) {
          validPaths.push(resolvedPath);
        }
      }

      if (blockedPaths.length > 0) {
        console.warn(`[SECURITY] Batch operation blocked ${blockedPaths.length} path traversal attempts`);
      }

      if (validPaths.length === 0) {
        return res.status(400).json({ error: 'No valid project paths found' });
      }

      const results = await runBatchOperation(validPaths, prompt, {
        outputFormat,
        systemPrompt,
        timeout
      });

      res.json({
        success: true,
        totalProjects: projects.length,
        processedProjects: validPaths.length,
        blockedPaths: blockedPaths.length,
        results
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // GET /api/workers/:id/summary - Get Ollama-generated summary of worker output
  router.get('/workers/:id/summary', async (req, res) => {
    try {
      const worker = getWorker(req.params.id);

      if (!worker) {
        return res.status(404).json({ error: 'Worker not found' });
      }

      const output = getWorkerOutput(req.params.id);
      const forceRefresh = req.query.refresh === 'true';

      const summary = await generateSummary(req.params.id, output, { forceRefresh });
      res.json(summary);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // GET /api/workers/:id/quick-status - Get heuristic status without Ollama
  router.get('/workers/:id/quick-status', (req, res) => {
    try {
      const worker = getWorker(req.params.id);

      if (!worker) {
        return res.status(404).json({ error: 'Worker not found' });
      }

      const output = getWorkerOutput(req.params.id);
      const status = getQuickStatus(output);
      res.json({ ...status, workerId: req.params.id });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // GET /api/workers/:id/context - Get cached context for worker
  router.get('/workers/:id/context', (req, res) => {
    try {
      const worker = getWorker(req.params.id);

      if (!worker) {
        return res.status(404).json({ error: 'Worker not found' });
      }

      const context = getWorkerContext(req.params.id);
      res.json({ ...context, workerId: req.params.id });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // GET /api/ollama/health - Check if Ollama is available
  router.get('/ollama/health', async (req, res) => {
    try {
      const health = await checkOllamaHealth();
      res.json(health);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // GET /api/settings/summaries - Get summaries enabled state
  router.get('/settings/summaries', (req, res) => {
    try {
      res.json({ enabled: getSummariesEnabled() });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // POST /api/settings/summaries - Set summaries enabled state
  router.post('/settings/summaries', (req, res) => {
    try {
      const { enabled } = req.body;
      if (typeof enabled !== 'boolean') {
        return res.status(400).json({ error: 'enabled (boolean) is required' });
      }
      const newState = setSummariesEnabled(enabled);
      res.json({ enabled: newState });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // POST /api/voice/command - Process voice command through orchestrator
  router.post('/voice/command', async (req, res) => {
    try {
      const { message } = req.body;

      if (!message) {
        return res.status(400).json({ error: 'message is required' });
      }

      const result = await processVoiceCommand(message, theaRoot, io);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // GET /api/voice/history - Get conversation history
  router.get('/voice/history', (req, res) => {
    try {
      const history = getConversationHistory();
      res.json({ history });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // DELETE /api/voice/history - Clear conversation history
  router.delete('/voice/history', (req, res) => {
    try {
      clearConversationHistory();
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // ============================================
  // ACTIVITY PATTERN ANALYSIS
  // ============================================

  // POST /api/activity/analyze - Analyze activity patterns and suggest workflows
  router.post('/activity/analyze', async (req, res) => {
    try {
      const { windowSize, minOccurrences, minConfidence } = req.body;

      const result = analyzeAndSuggestWorkflows({
        windowSize: windowSize || 3,
        minOccurrences: minOccurrences || 2,
        minConfidence: minConfidence || 0.3
      });

      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // GET /api/activity/patterns - Get pattern statistics
  router.get('/activity/patterns', (req, res) => {
    try {
      const stats = getPatternStats();
      res.json(stats);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // GET /api/activity/workflows - Get workflow suggestions
  router.get('/activity/workflows', (req, res) => {
    try {
      const limit = parseInt(req.query.limit) || 10;
      const suggestions = getWorkflowSuggestions(limit);
      res.json(suggestions);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // POST /api/activity/workflows/:id/accept - Mark a workflow as accepted
  router.post('/activity/workflows/:id/accept', (req, res) => {
    try {
      acceptWorkflow(parseInt(req.params.id));
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // POST /api/activity/sync - Manually sync activity log to database
  router.post('/activity/sync', (req, res) => {
    try {
      const synced = syncActivityLog();
      res.json({ synced });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // ============================================
  // METRICS API
  // ============================================

  // GET /api/metrics/system - Get system-wide metrics
  router.get('/metrics/system', (req, res) => {
    try {
      const metricsService = getMetricsService();
      const workers = getWorkers();
      const periodMinutes = parseInt(req.query.period) || 60;
      const startTime = new Date(Date.now() - periodMinutes * 60000).toISOString();

      // Get summaries for key metrics
      const spawnTimeSummary = metricsService.getSummary(MetricTypes.WORKER_SPAWN_TIME, startTime);
      const errorSummary = metricsService.getSummary(MetricTypes.ERROR_COUNT, startTime);
      const apiResponseSummary = metricsService.getSummary(MetricTypes.API_RESPONSE_TIME, startTime);

      // Count active workers
      const activeWorkers = workers.filter(w => w.status === 'running').length;

      // Total spawns from metrics
      const totalSpawns = spawnTimeSummary.count || 0;

      // Average spawn time
      const avgSpawnTime = spawnTimeSummary.avg || 0;

      // Calculate error rate (errors / total operations)
      const totalOperations = (spawnTimeSummary.count || 0) + (apiResponseSummary.count || 0);
      const errorCount = errorSummary.sum || 0;
      const errorRate = totalOperations > 0 ? (errorCount / totalOperations) * 100 : 0;

      // Determine health status based on metrics
      let healthStatus = 'healthy';
      if (errorRate > 10) {
        healthStatus = 'critical';
      } else if (errorRate > 5) {
        healthStatus = 'degraded';
      } else if (avgSpawnTime > 5000) {
        healthStatus = 'warning';
      }

      // Get memory usage
      const memUsage = process.memoryUsage();
      const totalMem = os.totalmem();
      const memoryUsage = Math.round((memUsage.heapUsed / totalMem) * 100 * 100) / 100;

      // Get uptime
      const uptime = Math.round(process.uptime());

      res.json({
        activeWorkers,
        totalSpawns,
        avgSpawnTime: Math.round(avgSpawnTime),
        errorRate: parseFloat(errorRate.toFixed(2)),
        errorCount: Math.round(errorCount),
        healthStatus,
        memoryUsage,
        uptime,
        metrics: {
          spawnTime: {
            avg: spawnTimeSummary.avg,
            min: spawnTimeSummary.min,
            max: spawnTimeSummary.max,
            p50: spawnTimeSummary.p50,
            p95: spawnTimeSummary.p95,
            p99: spawnTimeSummary.p99
          },
          apiResponse: {
            avg: apiResponseSummary.avg,
            min: apiResponseSummary.min,
            max: apiResponseSummary.max,
            count: apiResponseSummary.count
          }
        },
        period: `${periodMinutes} minutes`,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // GET /api/metrics/worker/:id - Get metrics for a specific worker
  router.get('/metrics/worker/:id', (req, res) => {
    try {
      const worker = getWorker(req.params.id);

      if (!worker) {
        return res.status(404).json({ error: 'Worker not found' });
      }

      const metricsService = getMetricsService();
      const workerId = req.params.id;

      // Get worker-specific metrics from the last 24 hours
      const startTime = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const endTime = new Date().toISOString();

      // Query metrics with worker label
      const spawnMetrics = metricsService.getMetrics(
        MetricTypes.WORKER_SPAWN_TIME,
        startTime,
        endTime,
        100
      ).filter(m => {
        const labels = m.labels ? JSON.parse(m.labels) : {};
        return labels.workerId === workerId;
      });

      const healthMetrics = metricsService.getMetrics(
        MetricTypes.HEALTH_CHECK_LATENCY,
        startTime,
        endTime,
        100
      ).filter(m => {
        const labels = m.labels ? JSON.parse(m.labels) : {};
        return labels.workerId === workerId;
      });

      // Calculate health score (0-100) based on various factors
      let healthScore = 100;
      const factors = [];

      // Factor 1: Status-based score
      if (worker.status === 'error' || worker.status === 'failed') {
        healthScore -= 50;
        factors.push({ name: 'status', impact: -50, reason: `Worker status: ${worker.status}` });
      } else if (worker.status === 'pending') {
        healthScore -= 10;
        factors.push({ name: 'status', impact: -10, reason: 'Worker is pending' });
      }

      // Factor 2: Recent health check latency
      if (healthMetrics.length > 0) {
        const avgLatency = healthMetrics.reduce((sum, m) => sum + m.value, 0) / healthMetrics.length;
        if (avgLatency > 1000) {
          const penalty = Math.min(30, Math.floor(avgLatency / 100));
          healthScore -= penalty;
          factors.push({ name: 'latency', impact: -penalty, reason: `High average latency: ${Math.round(avgLatency)}ms` });
        }
      }

      // Factor 3: Spawn time
      if (spawnMetrics.length > 0) {
        const spawnTime = spawnMetrics[0].value;
        if (spawnTime > 10000) {
          healthScore -= 10;
          factors.push({ name: 'spawnTime', impact: -10, reason: `Slow spawn time: ${Math.round(spawnTime)}ms` });
        }
      }

      // Ensure score is within bounds
      healthScore = Math.max(0, Math.min(100, healthScore));

      // Calculate uptime
      const createdAt = new Date(worker.createdAt);
      const uptime = Date.now() - createdAt.getTime();
      const uptimeSeconds = Math.floor(uptime / 1000);

      res.json({
        workerId,
        healthScore,
        healthFactors: factors,
        status: worker.status,
        lifecycle: {
          createdAt: worker.createdAt,
          uptime: uptimeSeconds,
          uptimeFormatted: formatUptime(uptimeSeconds),
          spawnTime: spawnMetrics.length > 0 ? Math.round(spawnMetrics[0].value) : null
        },
        performance: {
          avgLatency: healthMetrics.length > 0
            ? Math.round(healthMetrics.reduce((sum, m) => sum + m.value, 0) / healthMetrics.length)
            : null,
          healthCheckCount: healthMetrics.length,
          lastHealthCheck: healthMetrics.length > 0 ? healthMetrics[0].timestamp : null
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // GET /api/metrics/realtime - Get last 50 data points per metric type
  router.get('/metrics/realtime', (req, res) => {
    try {
      const metricsService = getMetricsService();
      const limit = Math.min(parseInt(req.query.limit) || 50, 100);

      // Get realtime metrics for each type from in-memory cache
      const realtimeData = {};

      for (const [key, type] of Object.entries(MetricTypes)) {
        const metrics = metricsService.getRealtime(type);
        // Return last N entries
        realtimeData[type] = metrics.slice(-limit).map(m => ({
          value: m.value,
          timestamp: m.timestamp,
          labels: m.labels
        }));
      }

      res.json({
        metrics: realtimeData,
        limit,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // ============================================
  // MISSION API (CC-DC-DE Command Structure)
  // ============================================

  // POST /api/missions - Create a new mission (Centralized Command)
  router.post('/missions', async (req, res) => {
    try {
      const { generalService } = req.app.locals.services || {};
      if (!generalService) {
        return res.status(503).json({ error: 'GeneralService not initialized' });
      }

      const { task, projectPath, intent, autonomyLevel } = req.body;
      if (!task) {
        return res.status(400).json({ error: 'task is required' });
      }
      if (!projectPath) {
        return res.status(400).json({ error: 'projectPath is required' });
      }

      const mission = generalService.createMission({
        task,
        projectPath,
        intent,
        autonomyLevel
      });

      res.json(mission);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // GET /api/missions - List all missions
  router.get('/missions', (req, res) => {
    try {
      const { generalService } = req.app.locals.services || {};
      if (!generalService) {
        return res.status(503).json({ error: 'GeneralService not initialized' });
      }

      const missions = [];
      for (const [id, data] of generalService.missions) {
        missions.push({
          missionId: id,
          status: data.status,
          mission: data.order.mission,
          projectPath: data.projectPath,
          createdAt: data.createdAt,
          completedAt: data.completedAt
        });
      }

      res.json(missions);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // GET /api/missions/:id - Get mission details
  router.get('/missions/:id', (req, res) => {
    try {
      const { generalService } = req.app.locals.services || {};
      if (!generalService) {
        return res.status(503).json({ error: 'GeneralService not initialized' });
      }

      const mission = generalService.getMission(req.params.id);
      if (!mission) {
        return res.status(404).json({ error: 'Mission not found' });
      }

      res.json(mission);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // POST /api/missions/:id/execute - Execute a mission (routes to supervisors)
  router.post('/missions/:id/execute', async (req, res) => {
    try {
      const { generalService } = req.app.locals.services || {};
      if (!generalService) {
        return res.status(503).json({ error: 'GeneralService not initialized' });
      }

      const result = await generalService.executeMission(req.params.id);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // GET /api/command/supervisors - Get supervisor status (Distributed Control)
  router.get('/command/supervisors', (req, res) => {
    try {
      const { generalService } = req.app.locals.services || {};
      if (!generalService) {
        return res.status(503).json({ error: 'GeneralService not initialized' });
      }

      res.json(generalService.getSupervisorStatus());
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // GET /api/command/status - Get full CC-DC-DE system status
  router.get('/command/status', (req, res) => {
    try {
      const { generalService } = req.app.locals.services || {};
      if (!generalService) {
        return res.status(503).json({ error: 'GeneralService not initialized' });
      }

      res.json(generalService.getSystemStatus());
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // POST /api/command/ooda - Run orchestrator OODA cycle
  router.post('/command/ooda', async (req, res) => {
    try {
      const { generalService } = req.app.locals.services || {};
      if (!generalService) {
        return res.status(503).json({ error: 'GeneralService not initialized' });
      }

      const cycle = await generalService.runOODACycle();
      res.json(cycle);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // GET /api/command/metrics - Get command hierarchy metrics
  router.get('/command/metrics', (req, res) => {
    try {
      const { generalService } = req.app.locals.services || {};
      if (!generalService) {
        return res.status(503).json({ error: 'GeneralService not initialized' });
      }

      res.json(generalService.getMetrics());
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // ===================================================
  // Predictive Scaling API
  // ===================================================

  // GET /api/scaling/status - Get scaling status
  router.get('/scaling/status', (req, res) => {
    try {
      const { predictiveScaling } = req.app.locals.services || {};
      if (!predictiveScaling) {
        return res.status(503).json({ error: 'Predictive scaling not available' });
      }
      res.json(predictiveScaling.getStatus());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/scaling/start - Start predictive scaling
  router.post('/scaling/start', (req, res) => {
    try {
      const { predictiveScaling } = req.app.locals.services || {};
      if (!predictiveScaling) {
        return res.status(503).json({ error: 'Predictive scaling not available' });
      }
      predictiveScaling.start();
      res.json({ status: 'started', ...predictiveScaling.getStatus() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/scaling/stop - Stop predictive scaling
  router.post('/scaling/stop', (req, res) => {
    try {
      const { predictiveScaling } = req.app.locals.services || {};
      if (!predictiveScaling) {
        return res.status(503).json({ error: 'Predictive scaling not available' });
      }
      predictiveScaling.stop();
      res.json({ status: 'stopped', ...predictiveScaling.getStatus() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/scaling/check - Force a scaling check
  router.post('/scaling/check', async (req, res) => {
    try {
      const { predictiveScaling } = req.app.locals.services || {};
      if (!predictiveScaling) {
        return res.status(503).json({ error: 'Predictive scaling not available' });
      }
      await predictiveScaling.forceCheck();
      res.json(predictiveScaling.getStatus());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // PUT /api/scaling/config - Update scaling config
  router.put('/scaling/config', (req, res) => {
    try {
      const { predictiveScaling } = req.app.locals.services || {};
      if (!predictiveScaling) {
        return res.status(503).json({ error: 'Predictive scaling not available' });
      }
      const allowedConfig = ['minWorkers', 'maxWorkers', 'targetUtilization',
                             'scaleUpThreshold', 'scaleDownThreshold', 'checkInterval'];
      const newConfig = {};
      for (const key of allowedConfig) {
        if (req.body[key] !== undefined) {
          newConfig[key] = req.body[key];
        }
      }
      predictiveScaling.updateConfig(newConfig);
      res.json({ updated: Object.keys(newConfig), ...predictiveScaling.getStatus() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/scaling/history - Get scaling history
  router.get('/scaling/history', (req, res) => {
    try {
      const { predictiveScaling } = req.app.locals.services || {};
      if (!predictiveScaling) {
        return res.status(503).json({ error: 'Predictive scaling not available' });
      }
      res.json(predictiveScaling.getHistory());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/health - Health check
  router.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      theaRoot,
      timestamp: new Date().toISOString()
    });
  });

  // GET /api/resources - Get resource usage stats
  router.get('/resources', (req, res) => {
    const stats = getResourceStats();
    res.json({
      ...stats,
      timestamp: new Date().toISOString()
    });
  });

  // ============================================
  // LOG VIEWER ENDPOINTS
  // ============================================

  // GET /api/logs - Query server logs
  router.get('/logs', (req, res) => {
    try {
      const logger = req.app.locals.logger;
      if (!logger) {
        return res.status(503).json({ error: 'Logger not initialized' });
      }

      const { level, from, to, limit = 100 } = req.query;
      const logs = logger.queryLogs({
        level: level?.toUpperCase(),
        from,
        to,
        limit: parseInt(limit, 10)
      });

      res.json({
        count: logs.length,
        logs
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/logs/lifecycle - View startup/shutdown/crash history
  router.get('/logs/lifecycle', (req, res) => {
    try {
      const logger = req.app.locals.logger;
      if (!logger) {
        return res.status(503).json({ error: 'Logger not initialized' });
      }

      const { limit = 50 } = req.query;
      const events = logger.queryLifecycle(parseInt(limit, 10));

      res.json({
        count: events.length,
        events
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/logs/stats - Get logging statistics
  router.get('/logs/stats', (req, res) => {
    try {
      const logger = req.app.locals.logger;
      if (!logger) {
        return res.status(503).json({ error: 'Logger not initialized' });
      }

      const stats = logger.getStats();
      res.json(stats);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/status - Get service status from status file
  router.get('/status', (req, res) => {
    try {
      const statusPath = '/home/druzy/thea/shared/status/strategos.json';
      if (fs.existsSync(statusPath)) {
        const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
        res.json(status);
      } else {
        res.json({
          service: 'strategos',
          status: 'unknown',
          message: 'Status file not found'
        });
      }
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ============================================
  // SCIENTIFIC ENHANCEMENT APIs
  // Research-backed features from Phase 1 & 2
  // ============================================

  // ============================================
  // MULTI-AGENT DEBATE (ICML 2024)
  // Research: Du et al. "Improving Factuality through Multiagent Debate"
  // Expected: 30% error reduction, improved factual accuracy
  // ============================================

  // POST /api/debate/start - Start a multi-agent debate
  router.post('/debate/start', async (req, res) => {
    try {
      const { debateProtocol } = req.app.locals.coordination || {};
      if (!debateProtocol) {
        return res.status(503).json({ error: 'DebateProtocol not initialized' });
      }

      const { problem, projectPath, numAgents, numRounds, consensusMethod, context } = req.body;

      if (!problem) {
        return res.status(400).json({ error: 'problem is required' });
      }
      if (!projectPath) {
        return res.status(400).json({ error: 'projectPath is required' });
      }

      // SECURITY: Validate project path
      const resolvedPath = safeResolvePath(projectPath, theaRoot);
      if (!resolvedPath) {
        return res.status(400).json({ error: 'Invalid project path - path traversal not allowed' });
      }

      // Configure debate if params provided
      if (numAgents) debateProtocol.numAgents = numAgents;
      if (numRounds) debateProtocol.numRounds = numRounds;
      if (consensusMethod) debateProtocol.consensusMethod = consensusMethod;

      // Run debate
      const result = await debateProtocol.runDebate(problem, {
        projectPath: resolvedPath,
        ...context
      });

      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // GET /api/debate/metrics - Get debate protocol metrics
  router.get('/debate/metrics', (req, res) => {
    try {
      const { debateProtocol } = req.app.locals.coordination || {};
      if (!debateProtocol) {
        return res.status(503).json({ error: 'DebateProtocol not initialized' });
      }
      res.json(debateProtocol.getMetrics());
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // GET /api/debate/active - Get active debates
  router.get('/debate/active', (req, res) => {
    try {
      const { debateProtocol } = req.app.locals.coordination || {};
      if (!debateProtocol) {
        return res.status(503).json({ error: 'DebateProtocol not initialized' });
      }

      const activeDebates = [];
      for (const [id, debate] of debateProtocol.activeDebates) {
        activeDebates.push({
          id,
          problem: debate.problem?.substring(0, 100),
          phase: debate.phase,
          round: debate.round,
          agentCount: debate.agents?.length || 0
        });
      }
      res.json(activeDebates);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // ============================================
  // CONFIDENCE ESTIMATION (ICLR 2024)
  // Research: "Can LLMs Express Their Uncertainty?"
  // Calibrated uncertainty through consistency sampling
  // ============================================

  // POST /api/confidence/estimate - Estimate confidence for an output
  router.post('/confidence/estimate', async (req, res) => {
    try {
      const { confidenceEstimator } = req.app.locals.intelligence || {};
      if (!confidenceEstimator) {
        return res.status(503).json({ error: 'ConfidenceEstimator not initialized' });
      }

      const { output, samples, taskType } = req.body;

      if (!output) {
        return res.status(400).json({ error: 'output is required' });
      }

      // If samples provided, use them; otherwise generate would require LLM calls
      if (samples && Array.isArray(samples)) {
        const result = confidenceEstimator.estimateFromSamples(output, samples, {
          taskType: taskType || 'general'
        });
        res.json(result);
      } else {
        // Single-sample estimation (less accurate)
        const result = confidenceEstimator.estimateSingle(output, {
          taskType: taskType || 'general'
        });
        res.json(result);
      }
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // GET /api/confidence/thresholds - Get configured thresholds
  router.get('/confidence/thresholds', (req, res) => {
    try {
      const { confidenceEstimator, ConfidenceLevel } = req.app.locals.intelligence || {};
      if (!confidenceEstimator) {
        return res.status(503).json({ error: 'ConfidenceEstimator not initialized' });
      }
      res.json({
        highThreshold: confidenceEstimator.highThreshold,
        lowThreshold: confidenceEstimator.lowThreshold,
        numSamples: confidenceEstimator.numSamples,
        levels: ConfidenceLevel
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // GET /api/confidence/metrics - Get estimator metrics
  router.get('/confidence/metrics', (req, res) => {
    try {
      const { confidenceEstimator } = req.app.locals.intelligence || {};
      if (!confidenceEstimator) {
        return res.status(503).json({ error: 'ConfidenceEstimator not initialized' });
      }
      res.json(confidenceEstimator.getMetrics());
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // ============================================
  // ENHANCED VERIFICATION (TACL 2024)
  // External tool feedback for verification
  // Code execution, symbolic math, schema validation
  // ============================================

  // POST /api/verify/enhanced - Run enhanced verification with external tools
  router.post('/verify/enhanced', async (req, res) => {
    try {
      const { enhancedVerificationPipeline } = req.app.locals.intelligence || {};
      if (!enhancedVerificationPipeline) {
        return res.status(503).json({ error: 'EnhancedVerificationPipeline not initialized' });
      }

      const { output, taskType, context, tools } = req.body;

      if (!output) {
        return res.status(400).json({ error: 'output is required' });
      }

      const result = await enhancedVerificationPipeline.verify(output, {
        taskType: taskType || 'code',
        context: context || {},
        enabledTools: tools  // Optional: specify which tools to use
      });

      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // GET /api/verify/enhanced/tools - List available verification tools
  router.get('/verify/enhanced/tools', (req, res) => {
    try {
      const { enhancedVerificationPipeline } = req.app.locals.intelligence || {};
      if (!enhancedVerificationPipeline) {
        return res.status(503).json({ error: 'EnhancedVerificationPipeline not initialized' });
      }
      res.json({
        tools: enhancedVerificationPipeline.getAvailableTools(),
        config: enhancedVerificationPipeline.getConfig()
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // ============================================
  // REFLEXION LOOP (NeurIPS 2023)
  // Verbal reinforcement learning with reflection memory
  // ============================================

  // GET /api/reflexion/metrics - Get reflexion loop metrics
  router.get('/reflexion/metrics', (req, res) => {
    try {
      const { reflexionLoop } = req.app.locals.intelligence || {};
      if (!reflexionLoop) {
        return res.status(503).json({ error: 'ReflexionLoop not initialized' });
      }
      res.json(reflexionLoop.getMetrics());
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // GET /api/reflexion/reflections - Query stored reflections
  router.get('/reflexion/reflections', async (req, res) => {
    try {
      const { memoryManager, REFLECTION_MEMORY_TYPE } = req.app.locals.intelligence || {};
      if (!memoryManager) {
        return res.status(503).json({ error: 'MemoryManager not initialized' });
      }

      const { taskType, limit = 20 } = req.query;

      const query = {
        type: REFLECTION_MEMORY_TYPE || 'reflection',
        limit: parseInt(limit, 10)
      };

      if (taskType) {
        query.metadata = { taskType };
      }

      const reflections = await memoryManager.query(query);
      res.json({
        count: reflections.length,
        reflections: reflections.map(r => ({
          id: r.id,
          content: r.content?.substring(0, 200) + (r.content?.length > 200 ? '...' : ''),
          taskType: r.metadata?.taskType,
          importance: r.importance,
          createdAt: r.createdAt
        }))
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  return router;
}
