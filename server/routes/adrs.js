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

export function createADRRoutes() {
  const router = express.Router();

  // GET /api/adrs - List all ADRs
  router.get('/', (req, res) => {
    try {
      const { status, tags, limit } = req.query;

      const options = {
        recordsDir: SHARED_ADR_DIR,
        status: status || null,
        tags: tags ? tags.split(',') : null,
        limit: limit ? parseInt(limit, 10) : null
      };

      const adrs = listADRs(options);
      res.json(adrs);
    } catch (error) {
      console.error('Error listing ADRs:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // GET /api/adrs/stats - Get ADR statistics
  router.get('/stats', (req, res) => {
    try {
      const stats = getADRStats(SHARED_ADR_DIR);
      res.json(stats);
    } catch (error) {
      console.error('Error getting ADR stats:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // GET /api/adrs/search - Search ADRs
  router.get('/search', (req, res) => {
    try {
      const { q } = req.query;

      if (!q) {
        return res.status(400).json({ error: 'Query parameter "q" is required' });
      }

      const results = searchADRs(q, SHARED_ADR_DIR);
      res.json(results);
    } catch (error) {
      console.error('Error searching ADRs:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // GET /api/adrs/template - Get ADR template
  router.get('/template', (req, res) => {
    try {
      const template = getTemplate();
      res.json({ template });
    } catch (error) {
      console.error('Error getting template:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // GET /api/adrs/:id - Get single ADR
  router.get('/:id', (req, res) => {
    try {
      const adr = getADR(req.params.id, SHARED_ADR_DIR);

      if (!adr) {
        return res.status(404).json({ error: 'ADR not found' });
      }

      res.json(adr);
    } catch (error) {
      console.error('Error getting ADR:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // POST /api/adrs - Create new ADR
  router.post('/', (req, res) => {
    try {
      const { title, context, decision, consequences, status, deciders, tags } = req.body;

      if (!title) {
        return res.status(400).json({ error: 'Title is required' });
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
      res.status(201).json(created);
    } catch (error) {
      console.error('Error creating ADR:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // PUT /api/adrs/:id - Update ADR
  router.put('/:id', (req, res) => {
    try {
      const updated = updateADR(req.params.id, req.body, SHARED_ADR_DIR);

      if (!updated) {
        return res.status(404).json({ error: 'ADR not found' });
      }

      res.json(updated);
    } catch (error) {
      console.error('Error updating ADR:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // DELETE /api/adrs/:id - Delete ADR
  router.delete('/:id', (req, res) => {
    try {
      const deleted = deleteADR(req.params.id, SHARED_ADR_DIR);

      if (!deleted) {
        return res.status(404).json({ error: 'ADR not found' });
      }

      res.json({ success: true });
    } catch (error) {
      console.error('Error deleting ADR:', error);
      res.status(500).json({ error: error.message });
    }
  });

  return router;
}

export default createADRRoutes;
