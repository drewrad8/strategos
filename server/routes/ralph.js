import express from 'express';

/**
 * Ralph routes for PRD management and autonomous run control
 * Base path: /api/ralph
 */
export function createRalphRoutes(ralphService) {
  const router = express.Router();

  // =====================
  // PRD Endpoints
  // =====================

  /**
   * POST /api/ralph/prds
   * Create a new PRD
   *
   * Body:
   *   - name: string (required) - PRD name
   *   - description: string - PRD description
   *   - projectPath: string (required) - Path to project
   *   - stories: array (required) - Array of user story objects
   *     - title: string (required)
   *     - description: string
   *     - acceptanceCriteria: string[]
   *     - priority: number (lower = higher priority)
   */
  router.post('/prds', (req, res) => {
    try {
      const { name, description, projectPath, stories } = req.body;

      if (!name) {
        return res.status(400).json({ error: 'name is required' });
      }
      if (!projectPath) {
        return res.status(400).json({ error: 'projectPath is required' });
      }
      if (!stories || !Array.isArray(stories) || stories.length === 0) {
        return res.status(400).json({ error: 'stories array is required and must not be empty' });
      }

      // Validate stories structure
      for (let i = 0; i < stories.length; i++) {
        if (!stories[i].title) {
          return res.status(400).json({ error: `Story ${i} is missing a title` });
        }
      }

      const prd = ralphService.createPrd(name, description || '', projectPath, stories);
      res.status(201).json(prd);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * GET /api/ralph/prds
   * List all PRDs
   */
  router.get('/prds', (req, res) => {
    try {
      const prds = ralphService.listPrds();
      res.json(prds);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * GET /api/ralph/prds/:id
   * Get a PRD by ID
   */
  router.get('/prds/:id', (req, res) => {
    try {
      const prd = ralphService.getPrd(parseInt(req.params.id));
      if (!prd) {
        return res.status(404).json({ error: 'PRD not found' });
      }
      res.json(prd);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * PUT /api/ralph/prds/:id
   * Update a PRD
   *
   * Body: Any of:
   *   - name: string
   *   - description: string
   *   - projectPath: string
   *   - stories: array
   */
  router.put('/prds/:id', (req, res) => {
    try {
      const prd = ralphService.updatePrd(parseInt(req.params.id), req.body);
      if (!prd) {
        return res.status(404).json({ error: 'PRD not found' });
      }
      res.json(prd);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * DELETE /api/ralph/prds/:id
   * Delete a PRD
   */
  router.delete('/prds/:id', (req, res) => {
    try {
      const success = ralphService.deletePrd(parseInt(req.params.id));
      if (!success) {
        return res.status(404).json({ error: 'PRD not found' });
      }
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // =====================
  // Run Endpoints
  // =====================

  /**
   * POST /api/ralph/runs
   * Start a new Ralph run
   *
   * Body:
   *   - prdId: number (required) - PRD ID to run
   *   - maxIterations: number - Maximum iterations (default 10)
   */
  router.post('/runs', async (req, res) => {
    try {
      const { prdId, maxIterations = 10 } = req.body;

      if (!prdId) {
        return res.status(400).json({ error: 'prdId is required' });
      }

      const run = await ralphService.startRun(prdId, maxIterations);
      res.status(201).json(run);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * GET /api/ralph/runs
   * List all runs
   *
   * Query params:
   *   - active: boolean - Only show active runs
   */
  router.get('/runs', (req, res) => {
    try {
      const runs = ralphService.listRuns();
      res.json(runs);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * GET /api/ralph/runs/:id
   * Get run status
   */
  router.get('/runs/:id', (req, res) => {
    try {
      const run = ralphService.getRunStatus(parseInt(req.params.id));
      if (!run) {
        return res.status(404).json({ error: 'Run not found' });
      }
      res.json(run);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * POST /api/ralph/runs/:id/pause
   * Pause a running run
   */
  router.post('/runs/:id/pause', (req, res) => {
    try {
      ralphService.pauseRun(parseInt(req.params.id));
      res.json({ success: true });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  /**
   * POST /api/ralph/runs/:id/resume
   * Resume a paused run
   */
  router.post('/runs/:id/resume', async (req, res) => {
    try {
      await ralphService.resumeRun(parseInt(req.params.id));
      res.json({ success: true });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  /**
   * DELETE /api/ralph/runs/:id
   * Cancel/stop a run
   */
  router.delete('/runs/:id', async (req, res) => {
    try {
      await ralphService.cancelRun(parseInt(req.params.id));
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * GET /api/ralph/runs/:id/progress
   * Get progress/learnings for a run
   */
  router.get('/runs/:id/progress', (req, res) => {
    try {
      const progress = ralphService.getRunProgress(parseInt(req.params.id));
      res.json(progress);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // =====================
  // Worker Completion Signaling
  // =====================

  /**
   * POST /api/ralph/signal/:token
   * Signal status from a worker (progress, completion, or blocked)
   * Workers call this endpoint to signal their status
   *
   * Body:
   *   - status: 'in_progress' | 'done' | 'blocked' (required)
   *   - progress: number 0-100 (optional, for in_progress)
   *   - currentStep: string (optional, describes current activity)
   *   - reason: string (optional, for blocked status)
   *   - learnings: string (optional, summary/notes)
   *   - outputs: object (optional, structured outputs { key: value })
   *   - artifacts: array (optional, file paths created)
   */
  router.post('/signal/:token', async (req, res) => {
    try {
      const { token } = req.params;
      const { status = 'done', progress, currentStep, reason, learnings, outputs, artifacts } = req.body;

      if (!['in_progress', 'done', 'blocked'].includes(status)) {
        return res.status(400).json({ error: 'status must be "in_progress", "done", or "blocked"' });
      }

      // Validate progress range if provided
      if (progress !== undefined && (progress < 0 || progress > 100)) {
        return res.status(400).json({ error: 'progress must be between 0 and 100' });
      }

      const signalData = { status, progress, currentStep, reason, learnings, outputs, artifacts };
      const result = await ralphService.handleCompletionSignal(token, signalData);

      if (!result) {
        return res.status(404).json({ error: 'Unknown completion token' });
      }

      res.json({ success: true, message: `Status updated to ${status}`, progress });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  return router;
}

export default createRalphRoutes;
