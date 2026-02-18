import express from 'express';
import path from 'path';
import {
  getWorker,
  getWorkerOutput,
  spawnWorker,
  sendInput,
  runHeadless,
  runBatchOperation
} from '../workerManager.js';
import { projectExists, safeResolvePath } from '../projectScanner.js';
import { getQuickStatus, getWorkerContext } from '../summaryService.js';
import { sanitizeErrorMessage } from '../errorUtils.js';
import { CONTROL_CHAR_RE, VALID_WORKER_ID } from '../validation.js';

/**
 * Integration routes for thea-architect to control workers
 * Base path: /api/integration
 */
export function createIntegrationRoutes(theaRoot, io) {
  const router = express.Router();

  /**
   * POST /api/integration/workflow-execute
   * Execute a workflow step: spawn a worker and/or send it a task
   *
   * Body:
   *   - projectPath: string (required) - Path to project (absolute or relative to theaRoot)
   *   - prompt: string (required) - Task/prompt to send to the worker
   *   - label?: string - Optional worker label
   *   - mode?: 'interactive' | 'headless' - Default 'interactive'
   *   - workerId?: string - Use existing worker instead of spawning new one
   *   - systemPrompt?: string - System prompt for headless mode
   *   - timeout?: number - Timeout in ms for headless mode (default 300000)
   *   - outputFormat?: string - Output format for headless mode (default 'json')
   */
  router.post('/workflow-execute', async (req, res) => {
    try {
      const {
        projectPath,
        prompt,
        label,
        mode = 'interactive',
        workerId,
        systemPrompt,
        timeout = 300000,
        outputFormat = 'json'
      } = req.body;

      if (!projectPath) {
        return res.status(400).json({ error: 'projectPath is required' });
      }

      // Validate mode
      const VALID_MODES = ['interactive', 'headless'];
      if (!VALID_MODES.includes(mode)) {
        return res.status(400).json({ error: `mode must be one of: ${VALID_MODES.join(', ')}` });
      }

      if (!prompt || typeof prompt !== 'string') {
        return res.status(400).json({ error: 'prompt is required and must be a string' });
      }
      if (prompt.length > 50000) {
        return res.status(400).json({ error: 'prompt exceeds maximum length (50KB)' });
      }

      // Validate optional fields
      if (label !== undefined) {
        if (typeof label !== 'string' || label.length > 200) {
          return res.status(400).json({ error: 'label must be a string under 200 characters' });
        }
        if (CONTROL_CHAR_RE.test(label)) {
          return res.status(400).json({ error: 'label must not contain control characters' });
        }
      }
      if (systemPrompt !== undefined && (typeof systemPrompt !== 'string' || systemPrompt.length > 32768)) {
        return res.status(400).json({ error: 'systemPrompt must be a string under 32KB' });
      }
      if (workerId !== undefined && (typeof workerId !== 'string' || !VALID_WORKER_ID.test(workerId))) {
        return res.status(400).json({ error: 'Invalid workerId format' });
      }
      const VALID_OUTPUT_FORMATS = ['json', 'text', 'stream-json'];
      if (outputFormat && !VALID_OUTPUT_FORMATS.includes(outputFormat)) {
        return res.status(400).json({ error: `outputFormat must be one of: ${VALID_OUTPUT_FORMATS.join(', ')}` });
      }
      if (timeout !== undefined && (typeof timeout !== 'number' || timeout < 1000 || timeout > 600000)) {
        return res.status(400).json({ error: 'timeout must be between 1000 and 600000 ms' });
      }

      // Resolve project path safely (prevents path traversal outside theaRoot)
      const resolvedPath = safeResolvePath(projectPath, theaRoot);
      if (!resolvedPath) {
        return res.status(400).json({ error: 'Project path is outside allowed directories' });
      }

      if (!projectExists(resolvedPath)) {
        return res.status(400).json({ error: 'Project path does not exist' });
      }

      // Headless mode: run claude --print and return result
      if (mode === 'headless') {
        const result = await runHeadless(resolvedPath, prompt, {
          outputFormat,
          systemPrompt,
          timeout
        });

        return res.json({
          success: true,
          mode: 'headless',
          project: path.basename(resolvedPath),
          result
        });
      }

      // Interactive mode: spawn or use existing worker
      let worker;

      if (workerId) {
        // Use existing worker
        worker = getWorker(workerId);
        if (!worker) {
          return res.status(404).json({ error: 'Resource not found' });
        }
      } else {
        // Spawn new worker
        worker = await spawnWorker(resolvedPath, label, io);
      }

      // Send the prompt to the worker
      await sendInput(worker.id, prompt);

      res.json({
        success: true,
        mode: 'interactive',
        worker: {
          id: worker.id,
          label: worker.label,
          project: worker.project,
          status: worker.status,
          health: worker.health
        },
        project: path.basename(resolvedPath),
        promptSent: true
      });
    } catch (error) {
      res.status(500).json({ error: sanitizeErrorMessage(error) });
    }
  });

  /**
   * GET /api/integration/worker/:id/status
   * Get detailed status of a worker for orchestration decisions
   *
   * Query params:
   *   - includeOutput?: boolean - Include raw output buffer (default false)
   *   - includeContext?: boolean - Include cached context (default true)
   */
  router.get('/worker/:id/status', (req, res) => {
    try {
      // Validate worker ID format (consistent with workflow-execute)
      if (!/^[a-zA-Z0-9-]{1,36}$/.test(req.params.id)) {
        return res.status(400).json({ error: 'Invalid workerId format' });
      }
      const worker = getWorker(req.params.id);

      if (!worker) {
        return res.status(404).json({ error: 'Worker not found' });
      }

      const includeOutput = req.query.includeOutput === 'true';
      const includeContext = req.query.includeContext === undefined || req.query.includeContext === 'true';

      // Get quick status from output
      const output = getWorkerOutput(req.params.id);
      const quickStatus = getQuickStatus(output);

      const response = {
        worker: {
          id: worker.id,
          label: worker.label,
          project: worker.project,
          workingDir: worker.project,
          status: worker.status,
          health: worker.health,
          mode: worker.mode,
          queuedCommands: worker.queuedCommands,
          createdAt: worker.createdAt,
          lastActivity: worker.lastActivity,
          lastOutput: worker.lastOutput
        },
        analysis: {
          // getQuickStatus returns { status, lastLine, lineCount }
          outputStatus: quickStatus.status,
          isIdle: quickStatus.status === 'waiting_input' || quickStatus.status === 'unknown',
          hasError: quickStatus.status === 'error',
          isThinking: quickStatus.status === 'thinking',
          awaitingInput: quickStatus.status === 'waiting_input',
          lastLine: quickStatus.lastLine,
          lineCount: quickStatus.lineCount
        }
      };

      if (includeContext) {
        response.context = getWorkerContext(req.params.id);
      }

      if (includeOutput) {
        response.output = output;
      }

      res.json(response);
    } catch (error) {
      res.status(500).json({ error: sanitizeErrorMessage(error) });
    }
  });

  /**
   * POST /api/integration/batch
   * Run batch operation across multiple projects in parallel
   *
   * Body:
   *   - projects: string[] (required) - Array of project paths
   *   - prompt: string (required) - Task/prompt to run on each project
   *   - systemPrompt?: string - Optional system prompt
   *   - timeout?: number - Timeout per project in ms (default 300000)
   *   - outputFormat?: string - Output format (default 'json')
   *   - concurrency?: number - Max concurrent operations (default: all at once)
   */
  router.post('/batch', async (req, res) => {
    try {
      const {
        projects,
        prompt,
        systemPrompt,
        timeout = 300000,
        outputFormat = 'json',
        concurrency
      } = req.body;

      if (!projects || !Array.isArray(projects) || projects.length === 0) {
        return res.status(400).json({ error: 'projects array is required' });
      }

      const MAX_BATCH_PROJECTS = 50;
      if (projects.length > MAX_BATCH_PROJECTS) {
        return res.status(400).json({ error: `projects array exceeds maximum of ${MAX_BATCH_PROJECTS}` });
      }

      if (!prompt || typeof prompt !== 'string') {
        return res.status(400).json({ error: 'prompt is required and must be a string' });
      }
      if (prompt.length > 50000) {
        return res.status(400).json({ error: 'prompt exceeds maximum length (50KB)' });
      }

      if (systemPrompt !== undefined && (typeof systemPrompt !== 'string' || systemPrompt.length > 32768)) {
        return res.status(400).json({ error: 'systemPrompt must be a string under 32KB' });
      }

      const VALID_OUTPUT_FORMATS = ['json', 'text', 'stream-json'];
      if (outputFormat && !VALID_OUTPUT_FORMATS.includes(outputFormat)) {
        return res.status(400).json({ error: `outputFormat must be one of: ${VALID_OUTPUT_FORMATS.join(', ')}` });
      }

      if (timeout !== undefined && (typeof timeout !== 'number' || timeout < 1000 || timeout > 600000)) {
        return res.status(400).json({ error: 'timeout must be between 1000 and 600000 ms' });
      }

      const MAX_CONCURRENCY = 20;
      if (concurrency !== undefined && (typeof concurrency !== 'number' || concurrency < 1 || concurrency > MAX_CONCURRENCY || !Number.isInteger(concurrency))) {
        return res.status(400).json({ error: `concurrency must be a positive integer up to ${MAX_CONCURRENCY}` });
      }

      // Resolve project paths safely (prevents path traversal)
      // Track security-rejected paths separately from non-existent paths
      let securityRejectedCount = 0;
      const resolvedPaths = [];
      for (const p of projects) {
        if (typeof p !== 'string' || p.length === 0) {
          securityRejectedCount++;
          continue;
        }
        const resolved = safeResolvePath(p, theaRoot);
        if (!resolved) {
          securityRejectedCount++;
        } else {
          resolvedPaths.push(resolved);
        }
      }

      // Filter to only existing projects
      const validPaths = resolvedPaths.filter(p => projectExists(p));
      const invalidPaths = resolvedPaths.filter(p => !projectExists(p));

      if (validPaths.length === 0) {
        return res.status(400).json({
          error: 'No valid project paths found',
          invalidCount: invalidPaths.length,
          rejectedCount: securityRejectedCount
        });
      }

      let results;

      if (concurrency && concurrency < validPaths.length) {
        // Run with concurrency limit
        results = await runBatchWithConcurrency(validPaths, prompt, {
          outputFormat,
          systemPrompt,
          timeout
        }, concurrency);
      } else {
        // Run all at once (existing behavior)
        results = await runBatchOperation(validPaths, prompt, {
          outputFormat,
          systemPrompt,
          timeout
        });
      }

      const successCount = results.filter(r => r.success).length;
      const failureCount = results.filter(r => !r.success).length;

      res.json({
        success: true,
        summary: {
          totalProjects: projects.length,
          validProjects: validPaths.length,
          invalidProjects: invalidPaths.length,
          successCount,
          failureCount
        },
        invalidCount: invalidPaths.length > 0 ? invalidPaths.length : undefined,
        rejectedCount: securityRejectedCount > 0 ? securityRejectedCount : undefined,
        results
      });
    } catch (error) {
      res.status(500).json({ error: sanitizeErrorMessage(error) });
    }
  });

  return router;
}

/**
 * Run batch operations with concurrency limit
 */
async function runBatchWithConcurrency(projectPaths, prompt, options, concurrency) {
  const MAX_BATCH_SIZE = 50;
  if (projectPaths.length > MAX_BATCH_SIZE) {
    throw new Error(`Batch size ${projectPaths.length} exceeds maximum of ${MAX_BATCH_SIZE}`);
  }

  const results = [];
  // Track items by index to avoid indexOf bug with duplicate paths
  const queue = projectPaths.map((p, i) => ({ path: p, index: i }));
  const inFlight = new Set();

  return new Promise((resolve) => {
    const processNext = async () => {
      if (queue.length === 0 && inFlight.size === 0) {
        resolve(results);
        return;
      }

      while (queue.length > 0 && inFlight.size < concurrency) {
        const { path: projectPath, index } = queue.shift();
        inFlight.add(index);

        (async () => {
          try {
            const result = await runHeadless(projectPath, prompt, options);
            results[index] = {
              project: path.basename(projectPath),
              success: true,
              result,
              error: null
            };
          } catch (error) {
            results[index] = {
              project: path.basename(projectPath),
              success: false,
              result: null,
              error: sanitizeErrorMessage(error)
            };
          } finally {
            inFlight.delete(index);
            processNext();
          }
        })();
      }
    };

    processNext();
  });
}
