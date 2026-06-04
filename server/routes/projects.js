/**
 * Project Routes - Project listing, config, and external project management
 * Base path: /api/projects
 */

import express from 'express';
import path from 'path';
import {
  scanProjects,
  getProject,
  getProjectsWithConfig,
  getProjectTree,
  loadProjectConfig,
  saveProjectConfig,
  addExternalProject,
  removeExternalProject,
  listExternalProjects,
  getDeniedPaths,
  addDeniedPath,
  removeDeniedPath
} from '../projectScanner.js';
import { getWorkers, getWorkersByProject } from '../workerManager.js';
import { sanitizeErrorMessage } from '../errorUtils.js';

export function createProjectRoutes(theaRoot) {
  const router = express.Router();

  // GET /api/projects - List all projects (with optional tree view)
  router.get('/', (req, res) => {
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
        // Return full config with enriched projects (disabled projects excluded)
        const data = getProjectsWithConfig(theaRoot);
        data.projects = data.projects
          .filter(p => p.meta?.enabled !== false)
          .map(p => ({
            ...p,
            enabled: p.meta?.enabled !== false,
            workers: workers.filter(w => w.project === p.name)
          }));
        return res.json(data);
      }

      // Default: flat list (backwards compatible)
      const config = loadProjectConfig(theaRoot);
      const includeDisabled = req.query.includeDisabled === 'true';
      const projects = scanProjects(theaRoot).filter(p => {
        if (includeDisabled) return true;
        const meta = config.projectMeta?.[p.name];
        return meta?.enabled !== false;
      });
      const projectsWithWorkers = projects.map(p => {
        const meta = config.projectMeta?.[p.name] || {};
        return {
          ...p,
          enabled: meta.enabled !== false,
          workers: workers.filter(w => w.project === p.name)
        };
      });

      res.json(projectsWithWorkers);
    } catch (error) {
      res.status(500).json({ error: sanitizeErrorMessage(error) });
    }
  });

  // GET /api/projects/config - Get project organization config
  router.get('/config', (req, res) => {
    try {
      const config = loadProjectConfig(theaRoot);
      res.json(config);
    } catch (error) {
      res.status(500).json({ error: sanitizeErrorMessage(error) });
    }
  });

  // PUT /api/projects/config - Update project organization config
  router.put('/config', (req, res) => {
    try {
      const config = req.body;

      // Validate config structure to prevent arbitrary data injection
      if (!config || typeof config !== 'object' || Array.isArray(config)) {
        return res.status(400).json({ error: 'Config must be a JSON object' });
      }

      // Validate externalProjects if present — reject dangerous system paths
      if (config.externalProjects !== undefined) {
        if (!Array.isArray(config.externalProjects)) {
          return res.status(400).json({ error: 'externalProjects must be an array' });
        }
        // Match exact dangerous paths AND their children (e.g., /etc and /etc/passwd)
        const DANGEROUS_ROOTS = ['/etc', '/sys', '/proc', '/dev', '/boot', '/root', '/var', '/usr', '/bin', '/sbin', '/lib'];
        for (const p of config.externalProjects) {
          if (typeof p !== 'string' || !p) {
            return res.status(400).json({ error: 'Each externalProject must be a non-empty string' });
          }
          const normalized = path.resolve(p);
          const isDangerous = normalized === '/' || p.includes('..') || p.includes('\0') ||
            DANGEROUS_ROOTS.some(dr => normalized === dr || normalized.startsWith(dr + path.sep));
          if (isDangerous) {
            return res.status(400).json({ error: `Rejected dangerous external project path: ${p}` });
          }
        }
      }

      const success = saveProjectConfig(theaRoot, config);
      if (success) {
        res.json({ success: true, config });
      } else {
        res.status(500).json({ error: 'Failed to save config' });
      }
    } catch (error) {
      res.status(500).json({ error: sanitizeErrorMessage(error) });
    }
  });

  // GET /api/projects/external - List external project directories
  router.get('/external', (req, res) => {
    try {
      const external = listExternalProjects(theaRoot);
      res.json(external);
    } catch (error) {
      res.status(500).json({ error: sanitizeErrorMessage(error) });
    }
  });

  // POST /api/projects/external - Add an external project directory
  router.post('/external', (req, res) => {
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
      res.status(500).json({ error: sanitizeErrorMessage(error) });
    }
  });

  // DELETE /api/projects/external - Remove an external project directory
  router.delete('/external', (req, res) => {
    try {
      const { path: projectPath } = req.body;
      if (!projectPath || typeof projectPath !== 'string') {
        return res.status(400).json({ error: 'path is required and must be a string' });
      }
      if (projectPath.includes('\0')) {
        return res.status(400).json({ error: 'Invalid path' });
      }
      const result = removeExternalProject(theaRoot, projectPath);
      if (result.success) {
        res.json(result);
      } else {
        res.status(400).json({ error: result.error });
      }
    } catch (error) {
      res.status(500).json({ error: sanitizeErrorMessage(error) });
    }
  });

  // PATCH /api/projects/:name/enabled - Enable or disable a project
  // Note: orchestratorService uses scanProjects() directly and bypasses the enabled filter.
  // Voice commands can still target disabled projects. This is by design.
  router.patch('/:name/enabled', (req, res) => {
    try {
      const { name } = req.params;
      const { enabled } = req.body;

      if (typeof enabled !== 'boolean') {
        return res.status(400).json({ error: 'enabled must be a boolean' });
      }

      // Verify project exists via filesystem scan
      const allProjects = scanProjects(theaRoot);
      const exists = allProjects.some(p => p.name === name);
      if (!exists) {
        return res.status(404).json({ error: 'Project not found' });
      }

      const config = loadProjectConfig(theaRoot);
      if (!config.projectMeta) {
        config.projectMeta = {};
      }
      if (!config.projectMeta[name]) {
        config.projectMeta[name] = {};
      }
      config.projectMeta[name].enabled = enabled;

      const ok = saveProjectConfig(theaRoot, config);
      if (!ok) {
        return res.status(500).json({ error: 'Failed to save config' });
      }

      res.json({ success: true, project: name, enabled });
    } catch (error) {
      res.status(500).json({ error: sanitizeErrorMessage(error) });
    }
  });

  // GET /api/projects/denied - List all denied paths
  router.get('/denied', (req, res) => {
    try {
      res.json({ deniedPaths: getDeniedPaths(theaRoot) });
    } catch (error) {
      res.status(500).json({ error: sanitizeErrorMessage(error) });
    }
  });

  // POST /api/projects/denied - Add a path to the deny list
  router.post('/denied', (req, res) => {
    try {
      const { path: pathEntry } = req.body;
      if (!pathEntry) {
        return res.status(400).json({ error: 'path is required' });
      }
      const result = addDeniedPath(theaRoot, pathEntry);
      if (!result.success) {
        return res.status(400).json({ error: result.error });
      }
      res.json({ success: true, deniedPaths: getDeniedPaths(theaRoot) });
    } catch (error) {
      res.status(500).json({ error: sanitizeErrorMessage(error) });
    }
  });

  // DELETE /api/projects/denied - Remove a path from the deny list
  router.delete('/denied', (req, res) => {
    try {
      const { path: pathEntry } = req.body;
      if (!pathEntry || typeof pathEntry !== 'string') {
        return res.status(400).json({ error: 'path is required and must be a string' });
      }
      const result = removeDeniedPath(theaRoot, pathEntry);
      if (!result.success) {
        return res.status(400).json({ error: result.error });
      }
      res.json({ success: true, deniedPaths: getDeniedPaths(theaRoot) });
    } catch (error) {
      res.status(500).json({ error: sanitizeErrorMessage(error) });
    }
  });

  // GET /api/projects/:name - Get single project with workers
  router.get('/:name', (req, res) => {
    try {
      const project = getProject(theaRoot, req.params.name);

      if (!project) {
        return res.status(404).json({ error: 'Project not found' });
      }

      const workers = getWorkersByProject(req.params.name);
      res.json({ ...project, workers });
    } catch (error) {
      res.status(500).json({ error: sanitizeErrorMessage(error) });
    }
  });

  return router;
}
