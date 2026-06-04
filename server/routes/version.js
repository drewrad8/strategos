/**
 * Version Route — GET /api/version
 *
 * Returns commit hash, server start time, Node version, and process uptime.
 * Solves the stale-server diagnostic: "is the running process newer than commit X?"
 * See memory #121 (restart-required deployment gap).
 */

import { execSync } from 'node:child_process';
import express from 'express';

function tryGit(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return null;
  }
}

// Cached once at module load (startup). Only uptime/serverStartedAt are per-request.
const _commitHash = tryGit('git rev-parse --short HEAD') ?? 'unknown';
const _commitTime = tryGit('git log -1 --format=%cI HEAD');
const _serverStartedAt = new Date().toISOString();

export function createVersionRouter({ commitHash = _commitHash, commitTime = _commitTime, serverStartedAt = _serverStartedAt } = {}) {
  const router = express.Router();

  router.get('/', (_req, res) => {
    res.json({
      commitHash,
      commitTime,
      serverStartedAt,
      nodeVersion: process.version,
      uptimeSeconds: Math.floor(process.uptime()),
      env: process.env.NODE_ENV === 'production' ? 'prod' : 'dev',
    });
  });

  return router;
}
