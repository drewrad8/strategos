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
import { projectExists } from '../projectScanner.js';
import { getQuickStatus, getWorkerContext } from '../summaryService.js';

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

      if (!prompt) {
        return res.status(400).json({ error: 'prompt is required' });
      }

      // Resolve project path
      let resolvedPath = projectPath;
      if (!path.isAbsolute(projectPath)) {
        resolvedPath = path.join(theaRoot, projectPath);
      }

      if (!projectExists(resolvedPath)) {
        return res.status(400).json({ error: `Project path does not exist: ${resolvedPath}` });
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
          projectPath: resolvedPath,
          result
        });
      }

      // Interactive mode: spawn or use existing worker
      let worker;

      if (workerId) {
        // Use existing worker
        worker = getWorker(workerId);
        if (!worker) {
          return res.status(404).json({ error: `Worker ${workerId} not found` });
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
        projectPath: resolvedPath,
        promptSent: true
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
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
      const worker = getWorker(req.params.id);

      if (!worker) {
        return res.status(404).json({ error: 'Worker not found' });
      }

      const includeOutput = req.query.includeOutput === 'true';
      const includeContext = req.query.includeContext !== 'false';

      // Get quick status from output
      const output = getWorkerOutput(req.params.id);
      const quickStatus = getQuickStatus(output);

      const response = {
        worker: {
          id: worker.id,
          label: worker.label,
          project: worker.project,
          workingDir: worker.workingDir,
          status: worker.status,
          health: worker.health,
          mode: worker.mode,
          queuedCommands: worker.queuedCommands,
          createdAt: worker.createdAt,
          lastActivity: worker.lastActivity,
          lastOutput: worker.lastOutput
        },
        analysis: {
          isIdle: quickStatus.isIdle,
          hasError: quickStatus.hasError,
          isThinking: quickStatus.isThinking,
          awaitingInput: quickStatus.awaitingInput,
          indicators: quickStatus.indicators
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
      res.status(500).json({ error: error.message });
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

      if (!prompt) {
        return res.status(400).json({ error: 'prompt is required' });
      }

      // Resolve project paths
      const resolvedPaths = projects.map(p => {
        if (path.isAbsolute(p)) return p;
        return path.join(theaRoot, p);
      });

      // Filter to only existing projects
      const validPaths = resolvedPaths.filter(p => projectExists(p));
      const invalidPaths = resolvedPaths.filter(p => !projectExists(p));

      if (validPaths.length === 0) {
        return res.status(400).json({
          error: 'No valid project paths found',
          invalidPaths
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
        invalidPaths: invalidPaths.length > 0 ? invalidPaths : undefined,
        results
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  return router;
}

/**
 * Run batch operations with concurrency limit
 */
async function runBatchWithConcurrency(projectPaths, prompt, options, concurrency) {
  const results = [];
  const queue = [...projectPaths];
  const inFlight = new Set();

  return new Promise((resolve) => {
    const processNext = async () => {
      if (queue.length === 0 && inFlight.size === 0) {
        resolve(results);
        return;
      }

      while (queue.length > 0 && inFlight.size < concurrency) {
        const projectPath = queue.shift();
        const index = projectPaths.indexOf(projectPath);
        inFlight.add(index);

        (async () => {
          try {
            const { runHeadless } = await import('../workerManager.js');
            const result = await runHeadless(projectPath, prompt, options);
            results[index] = {
              project: path.basename(projectPath),
              path: projectPath,
              success: true,
              result,
              error: null
            };
          } catch (error) {
            results[index] = {
              project: path.basename(projectPath),
              path: projectPath,
              success: false,
              result: null,
              error: error.message
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
