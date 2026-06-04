/**
 * Memory API Routes
 *
 * GET    /api/memory/:project       — list all memory entries for a project
 * POST   /api/memory                — write a memory entry (workers can explicitly write)
 * DELETE /api/memory/:id            — delete a memory entry by ID
 *
 * Workers and the UI can query/write project memory via these routes.
 * Auto-capture from done signals happens server-side via memoryService.js.
 */

import express from 'express';
import { getAllMemoryEntries, writeMemoryEntry, deleteMemoryEntry, getMemoryEntryById, searchMemoryFts } from '../memoryDb.js';
import { VALID_SIMPLE_ID } from '../validation.js';
import { sanitizeErrorMessage } from '../errorUtils.js';

const VALID_CATEGORIES = new Set(['decision', 'pattern', 'approach', 'warning']);

export function createMemoryRoutes() {
  const router = express.Router();

  /**
   * GET /api/memory/search?q=...&namespace=...&limit=N
   * Full-text search across memory entries for a namespace.
   * Must be registered BEFORE /:project to avoid being swallowed by the catch-all.
   */
  router.get('/search', (req, res) => {
    try {
      const { q, namespace, limit } = req.query;
      if (!q || typeof q !== 'string' || q.trim().length === 0) {
        return res.status(400).json({ error: 'q (search query) is required' });
      }
      if (!namespace || !VALID_SIMPLE_ID.test(String(namespace))) {
        return res.status(400).json({ error: 'namespace is required and must be alphanumeric/underscore/dash' });
      }
      const limitN = Math.min(parseInt(limit, 10) || 10, 50);
      const results = searchMemoryFts(q.trim(), namespace.trim(), limitN);
      res.json({ ok: true, count: results.length, results });
    } catch (err) {
      res.status(500).json({ error: sanitizeErrorMessage(err.message) });
    }
  });

  /**
   * GET /api/memory/:project
   * List all memory entries for a project namespace.
   * Optional ?role=general|colonel&limit=N query params.
   */
  router.get('/:project', (req, res) => {
    try {
      const { project } = req.params;
      if (!project || !VALID_SIMPLE_ID.test(project)) {
        return res.status(400).json({ error: 'Invalid project name' });
      }

      const entries = getAllMemoryEntries(project);

      // Optional client-side filtering
      const { role, limit } = req.query;
      let filtered = entries;
      if (role) {
        filtered = filtered.filter(e => !e.worker_role || e.worker_role === role);
      }
      if (limit) {
        const n = parseInt(limit, 10);
        if (!isNaN(n) && n > 0) {
          filtered = filtered.slice(0, n);
        }
      }

      res.json({ ok: true, project, entries: filtered, total: filtered.length });
    } catch (err) {
      res.status(500).json({ error: sanitizeErrorMessage(err.message) });
    }
  });

  /**
   * POST /api/memory
   * Write a memory entry. Workers can call this to explicitly record decisions.
   *
   * Body: { namespace, category, content, source?, worker_role?, relevance_score? }
   */
  router.post('/', (req, res) => {
    try {
      const { namespace, category, content, source, worker_role, relevance_score } = req.body || {};

      if (!namespace || typeof namespace !== 'string' || namespace.trim().length === 0) {
        return res.status(400).json({ error: 'namespace is required' });
      }
      if (!VALID_SIMPLE_ID.test(namespace.trim())) {
        return res.status(400).json({ error: 'namespace must be alphanumeric/underscore/dash' });
      }
      if (!content || typeof content !== 'string' || content.trim().length === 0) {
        return res.status(400).json({ error: 'content is required' });
      }
      if (content.length > 2000) {
        return res.status(400).json({ error: 'content must be under 2000 characters' });
      }
      if (category && !VALID_CATEGORIES.has(category)) {
        return res.status(400).json({ error: 'category must be one of: decision, pattern, approach, warning' });
      }
      if (relevance_score !== undefined && (typeof relevance_score !== 'number' || relevance_score < 0 || relevance_score > 1)) {
        return res.status(400).json({ error: 'relevance_score must be a number between 0 and 1' });
      }

      const id = writeMemoryEntry({
        namespace: namespace.trim(),
        category: category || 'pattern',
        content: content.trim(),
        source: source || null,
        worker_role: worker_role || null,
        relevance_score: relevance_score ?? 1.0,
      });

      if (id === null) {
        return res.status(500).json({ ok: false, error: 'memory write failed' });
      }
      res.status(201).json({ ok: true, id });
    } catch (err) {
      res.status(500).json({ error: sanitizeErrorMessage(err.message) });
    }
  });

  /**
   * DELETE /api/memory/:id
   * Delete a memory entry by ID.
   */
  router.delete('/:id', (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id) || id <= 0) {
        return res.status(400).json({ error: 'Invalid memory entry ID' });
      }

      const deleted = deleteMemoryEntry(id);
      if (!deleted) {
        return res.status(404).json({ error: 'Memory entry not found' });
      }

      res.json({ ok: true, deleted: id });
    } catch (err) {
      res.status(500).json({ error: sanitizeErrorMessage(err.message) });
    }
  });

  return router;
}
