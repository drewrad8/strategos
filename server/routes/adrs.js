/**
 * ADR Routes - API endpoints for Architecture Decision Records
 */

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  listADRs,
  getADR,
  createADR,
  updateADR,
  deleteADR,
  getTemplate,
  searchADRs,
  getADRStats
} from '../../../shared/adrs/adrService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHARED_ADR_DIR = path.join(__dirname, '..', '..', '..', 'shared', 'adrs', 'records');
import { sanitizeErrorMessage } from '../errorUtils.js';
import { CONTROL_CHAR_RE } from '../validation.js';

export function createADRRoutes() {
  const router = express.Router();

  // GET /api/adrs - List all ADRs
  router.get('/', (req, res) => {
    try {
      const { status, tags, limit } = req.query;

      // Validate query params
      const parsedLimit = limit ? parseInt(limit, 10) : null;
      if (parsedLimit !== null && (isNaN(parsedLimit) || parsedLimit < 1 || parsedLimit > 1000)) {
        return res.status(400).json({ error: 'limit must be between 1 and 1000' });
      }
      const tagList = tags ? tags.split(',').slice(0, 50) : null; // Cap at 50 tags
      const VALID_STATUSES = ['proposed', 'accepted', 'deprecated', 'superseded'];
      if (status && !VALID_STATUSES.includes(status)) {
        return res.status(400).json({ error: `status must be one of: ${VALID_STATUSES.join(', ')}` });
      }

      const options = {
        recordsDir: SHARED_ADR_DIR,
        status: status || null,
        tags: tagList,
        limit: parsedLimit
      };

      const adrs = listADRs(options);
      res.json(adrs);
    } catch (error) {
      console.error('Error listing ADRs:', error);
      res.status(500).json({ error: sanitizeErrorMessage(error) });
    }
  });

  // GET /api/adrs/stats - Get ADR statistics
  router.get('/stats', (req, res) => {
    try {
      const stats = getADRStats(SHARED_ADR_DIR);
      res.json(stats);
    } catch (error) {
      console.error('Error getting ADR stats:', error);
      res.status(500).json({ error: sanitizeErrorMessage(error) });
    }
  });

  // GET /api/adrs/search - Search ADRs
  router.get('/search', (req, res) => {
    try {
      const { q } = req.query;

      if (!q) {
        return res.status(400).json({ error: 'Query parameter "q" is required' });
      }
      if (q.length > 500) {
        return res.status(400).json({ error: 'Search query must be under 500 characters' });
      }

      // Escape regex metacharacters to prevent ReDoS if searchADRs uses regex
      const safeQuery = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const results = searchADRs(safeQuery, SHARED_ADR_DIR);
      res.json(results);
    } catch (error) {
      console.error('Error searching ADRs:', error);
      res.status(500).json({ error: sanitizeErrorMessage(error) });
    }
  });

  // GET /api/adrs/template - Get ADR template
  router.get('/template', (req, res) => {
    try {
      const template = getTemplate();
      res.json({ template });
    } catch (error) {
      console.error('Error getting template:', error);
      res.status(500).json({ error: sanitizeErrorMessage(error) });
    }
  });

  // GET /api/adrs/:id - Get single ADR
  router.get('/:id', (req, res) => {
    try {
      // ADR IDs are 4-digit numbers (e.g., "0001")
      if (!/^\d{1,4}$/.test(req.params.id)) {
        return res.status(400).json({ error: 'Invalid ADR ID format' });
      }
      const adr = getADR(req.params.id, SHARED_ADR_DIR);

      if (!adr) {
        return res.status(404).json({ error: 'Resource not found' });
      }

      res.json(adr);
    } catch (error) {
      console.error('Error getting ADR:', error);
      res.status(500).json({ error: sanitizeErrorMessage(error) });
    }
  });

  // POST /api/adrs - Create new ADR
  router.post('/', (req, res) => {
    try {
      const { title, context, decision, consequences, status, deciders, tags } = req.body;

      if (!title || typeof title !== 'string') {
        return res.status(400).json({ error: 'Title is required' });
      }
      if (title.length > 256) {
        return res.status(400).json({ error: 'Title must be under 256 characters' });
      }
      // Reject control characters in title (null bytes, etc. can corrupt files/tools)
      if (CONTROL_CHAR_RE.test(title)) {
        return res.status(400).json({ error: 'Title must not contain control characters' });
      }

      // Validate string field sizes
      const MAX_FIELD = 10000; // 10KB per field
      if (context && (typeof context !== 'string' || context.length > MAX_FIELD)) {
        return res.status(400).json({ error: `context must be a string (max ${MAX_FIELD} chars)` });
      }
      if (decision && (typeof decision !== 'string' || decision.length > MAX_FIELD)) {
        return res.status(400).json({ error: `decision must be a string (max ${MAX_FIELD} chars)` });
      }
      if (consequences && (typeof consequences !== 'string' || consequences.length > MAX_FIELD)) {
        return res.status(400).json({ error: `consequences must be a string (max ${MAX_FIELD} chars)` });
      }

      // Validate status whitelist
      const VALID_STATUSES = ['proposed', 'accepted', 'deprecated', 'superseded'];
      if (status && !VALID_STATUSES.includes(status)) {
        return res.status(400).json({ error: `status must be one of: ${VALID_STATUSES.join(', ')}` });
      }

      // Validate array fields — must be arrays of strings
      if (deciders !== undefined && (!Array.isArray(deciders) || !deciders.every(d => typeof d === 'string' && d.length <= 256))) {
        return res.status(400).json({ error: 'deciders must be an array of strings (max 256 chars each)' });
      }
      if (tags !== undefined && (!Array.isArray(tags) || !tags.every(t => typeof t === 'string' && t.length <= 100))) {
        return res.status(400).json({ error: 'tags must be an array of strings (max 100 chars each)' });
      }
      if (deciders && deciders.length > 20) {
        return res.status(400).json({ error: 'deciders array must have at most 20 entries' });
      }
      if (tags && tags.length > 50) {
        return res.status(400).json({ error: 'tags array must have at most 50 entries' });
      }

      const adrData = {
        title,
        context: context || '',
        decision: decision || '',
        consequences: consequences || '',
        status: status || 'proposed',
        deciders: deciders || [],
        tags: tags || []
      };

      const created = createADR(adrData, SHARED_ADR_DIR);
      // Strip server filesystem path from response (information disclosure)
      const { path: _path, ...safeCreated } = created;
      res.status(201).json(safeCreated);
    } catch (error) {
      console.error('Error creating ADR:', error);
      res.status(500).json({ error: sanitizeErrorMessage(error) });
    }
  });

  // PUT /api/adrs/:id - Update ADR
  router.put('/:id', (req, res) => {
    try {
      if (!/^\d{1,4}$/.test(req.params.id)) {
        return res.status(400).json({ error: 'Invalid ADR ID format' });
      }

      // Validate update fields (same rules as POST, but all optional)
      const { title, context, decision, consequences, status, deciders, tags } = req.body;
      if (title !== undefined && (typeof title !== 'string' || !title || title.length > 256)) {
        return res.status(400).json({ error: 'Title must be a non-empty string under 256 characters' });
      }
      if (title !== undefined && CONTROL_CHAR_RE.test(title)) {
        return res.status(400).json({ error: 'Title must not contain control characters' });
      }
      const MAX_FIELD = 10000;
      for (const [name, val] of [['context', context], ['decision', decision], ['consequences', consequences]]) {
        if (val !== undefined && (typeof val !== 'string' || val.length > MAX_FIELD)) {
          return res.status(400).json({ error: `${name} must be a string (max ${MAX_FIELD} chars)` });
        }
      }
      const VALID_STATUSES = ['proposed', 'accepted', 'deprecated', 'superseded'];
      if (status !== undefined && !VALID_STATUSES.includes(status)) {
        return res.status(400).json({ error: `status must be one of: ${VALID_STATUSES.join(', ')}` });
      }
      if (deciders !== undefined && (!Array.isArray(deciders) || deciders.length > 20 || !deciders.every(d => typeof d === 'string' && d.length <= 256))) {
        return res.status(400).json({ error: 'deciders must be an array of up to 20 strings (max 256 chars each)' });
      }
      if (tags !== undefined && (!Array.isArray(tags) || tags.length > 50 || !tags.every(t => typeof t === 'string' && t.length <= 100))) {
        return res.status(400).json({ error: 'tags must be an array of up to 50 strings (max 100 chars each)' });
      }

      // Construct clean updates object from validated fields only (don't pass raw req.body)
      const updates = {};
      if (title !== undefined) updates.title = title;
      if (context !== undefined) updates.context = context;
      if (decision !== undefined) updates.decision = decision;
      if (consequences !== undefined) updates.consequences = consequences;
      if (status !== undefined) updates.status = status;
      if (deciders !== undefined) updates.deciders = deciders;
      if (tags !== undefined) updates.tags = tags;

      const updated = updateADR(req.params.id, updates, SHARED_ADR_DIR);

      if (!updated) {
        return res.status(404).json({ error: 'Resource not found' });
      }

      // Strip server filesystem path from response (information disclosure)
      const { path: _path, ...safeUpdated } = updated;
      res.json(safeUpdated);
    } catch (error) {
      console.error('Error updating ADR:', error);
      res.status(500).json({ error: sanitizeErrorMessage(error) });
    }
  });

  // DELETE /api/adrs/:id - Delete ADR
  router.delete('/:id', (req, res) => {
    try {
      if (!/^\d{1,4}$/.test(req.params.id)) {
        return res.status(400).json({ error: 'Invalid ADR ID format' });
      }
      const deleted = deleteADR(req.params.id, SHARED_ADR_DIR);

      if (!deleted) {
        return res.status(404).json({ error: 'Resource not found' });
      }

      res.json({ success: true });
    } catch (error) {
      console.error('Error deleting ADR:', error);
      res.status(500).json({ error: sanitizeErrorMessage(error) });
    }
  });

  return router;
}

export default createADRRoutes;
