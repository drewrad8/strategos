/**
 * Research Routes - Research library index and search
 * Base path: /api/research
 */

import express from 'express';
import { readFileSync, readdirSync, existsSync } from 'fs';
import path from 'path';
import { sanitizeErrorMessage } from '../errorUtils.js';

/**
 * Resolve a report ID to its file path relative to research/.
 */
function resolveReportPath(researchDir, id) {
  // Numbered reports: 28-*.md, 29-*.md, etc.
  const numId = parseInt(id, 10);
  if (!isNaN(numId)) {
    try {
      const files = readdirSync(researchDir);
      const found = files.find(f => f.startsWith(`${numId}-`) && f.endsWith('.md'));
      if (found) return `research/${found}`;
    } catch {
      // Fall through
    }
  }

  // Consolidated/unnumbered reports
  const prefixMap = {
    'C1': 'consolidated-ai-efficiency-report.md',
    'C2': 'research-context-optimization.md',
    'C3': 'research-cost-speed.md',
    'C4': 'research-multi-agent-patterns.md',
    'C5': 'research-prompt-engineering.md',
    'C6': 'research-self-improvement.md',
  };
  if (prefixMap[id]) return `research/${prefixMap[id]}`;

  return `research/`;
}

/**
 * Parse INDEX.md table into structured JSON.
 * Each row: | # | Title | Date | Summary | Tags |
 */
function parseIndex(indexPath) {
  if (!existsSync(indexPath)) return [];

  const content = readFileSync(indexPath, 'utf8');
  const lines = content.split('\n');
  const researchDir = path.dirname(indexPath);
  const entries = [];

  for (const line of lines) {
    // Match table rows (skip header and separator)
    const match = line.match(/^\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|$/);
    if (!match) continue;

    const [, id, title, date, summary, tags] = match.map(s => s.trim());

    // Skip header row and separator
    if (id === '#' || id.startsWith('---')) continue;

    entries.push({
      id,
      title,
      date,
      summary,
      tags: tags.split(',').map(t => t.trim()).filter(Boolean),
      path: resolveReportPath(researchDir, id),
    });
  }

  return entries;
}

export function createResearchRoutes(theaRoot) {
  const router = express.Router();
  const projectRoot = path.join(theaRoot, 'strategos');
  const indexPath = path.join(projectRoot, 'research', 'INDEX.md');

  // GET /api/research - Full index as JSON
  router.get('/', (req, res) => {
    try {
      const entries = parseIndex(indexPath);
      res.json(entries);
    } catch (error) {
      res.status(500).json({ error: sanitizeErrorMessage(error) });
    }
  });

  // GET /api/research/search?q=keyword - Search reports by keyword
  router.get('/search', (req, res) => {
    try {
      const query = (req.query.q || '').toLowerCase().trim();
      if (!query) {
        return res.status(400).json({ error: 'q parameter is required' });
      }

      const entries = parseIndex(indexPath);
      const terms = query.split(/\s+/);

      const matches = entries.filter(entry => {
        const searchable = [
          entry.id,
          entry.title,
          entry.summary,
          ...entry.tags,
        ].join(' ').toLowerCase();

        return terms.every(term => searchable.includes(term));
      });

      res.json(matches);
    } catch (error) {
      res.status(500).json({ error: sanitizeErrorMessage(error) });
    }
  });

  return router;
}
