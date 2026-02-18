/**
 * Route Orchestrator
 *
 * Thin entry point that mounts domain-specific route modules.
 * Each module is a self-contained Express Router with its own imports.
 *
 * Route modules:
 *   routes/workers.js   - Worker CRUD, spawn, kill, input, output, dependencies, hierarchy
 *   routes/projects.js  - Project listing, config, external project management
 *   routes/system.js    - Health, metrics, logs, status, sessions, checkpoints, uploads, voice
 *   routes/settings.js  - Application-level settings (summaries)
 *   routes/adrs.js      - Architecture Decision Records (mounted in index.js)
 *   routes/ralph.js     - Ralph completion signaling (mounted in index.js)
 *   routes/integration.js - Integration endpoints (mounted in index.js)
 */

import express from 'express';
import { createWorkerRoutes } from './routes/workers.js';
import { createProjectRoutes } from './routes/projects.js';
import { createSystemRoutes } from './routes/system.js';
import { createSettingsRoutes } from './routes/settings.js';

export function createRoutes(theaRoot, io) {
  const router = express.Router();

  // Domain-specific sub-routers
  router.use('/workers', createWorkerRoutes(theaRoot, io));
  router.use('/projects', createProjectRoutes(theaRoot));
  router.use('/settings', createSettingsRoutes());

  // System routes have no shared prefix — mounted at root
  router.use('/', createSystemRoutes(theaRoot, io));

  return router;
}
