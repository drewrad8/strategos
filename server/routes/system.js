/**
 * System Routes - Health, metrics, logs, status, sessions, checkpoints, uploads, voice, etc.
 * Mounted at /api (root level, no shared prefix)
 */

import express from 'express';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import os from 'os';
import multer from 'multer';
import {
  getWorkers,
  getWorker,
  getActivityLog,
  getWorkerOutput,
  runHeadless,
  runBatchOperation,
  getDependencyStats,
  getResourceStats,
  getRespawnSuggestions,
  removeRespawnSuggestion,
  getCircuitBreakerStatus,
  resetCircuitBreaker
} from '../workerManager.js';
import {
  projectExists,
  safeResolvePath
} from '../projectScanner.js';
import {
  checkOllamaHealth
} from '../summaryService.js';
import {
  processVoiceCommand,
  getConversationHistory,
  clearConversationHistory
} from '../orchestratorService.js';
import {
  getSession,
  getSessionOutput,
  getSessionFullOutput,
  getStats as getOutputDbStats,
  cleanupOldData
} from '../workerOutputDb.js';
import {
  getMetricsService,
  MetricTypes
} from '../metricsService.js';
import { sanitizeErrorMessage } from '../errorUtils.js';
import {
  CONTROL_CHAR_RE, isValidSessionId,
  MAX_PROMPT_LENGTH, MAX_SYSTEM_PROMPT_LENGTH,
  MIN_TIMEOUT_MS, MAX_TIMEOUT_MS
} from '../validation.js';

// Helper function to format uptime in human-readable format
function formatUptime(seconds) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${mins}m`;
}

export function createSystemRoutes(theaRoot, io) {
  const router = express.Router();

  // ============================================
  // SCREENSHOT UPLOADS
  // ============================================

  // Configure multer for screenshot uploads
  const uploadsDir = path.join(theaRoot, 'strategos', 'uploads', 'screenshots');
  fs.mkdirSync(uploadsDir, { recursive: true, mode: 0o755 });

  const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => {
      const timestamp = Date.now();
      // Sanitize workerId to prevent path traversal (strip anything except alphanumeric, dash, underscore)
      const rawWorkerId = req.body.workerId || 'unknown';
      const workerId = rawWorkerId.replace(/[^a-zA-Z0-9_-]/g, '');
      // Derive extension from MIME type (not originalname) to prevent ext mismatch
      const mimeToExt = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' };
      const ext = mimeToExt[file.mimetype] || '.png';
      // Random suffix prevents collision on same-millisecond uploads with same workerId
      const suffix = crypto.randomBytes(4).toString('hex');
      cb(null, `${timestamp}-${workerId}-${suffix}${ext}`);
    }
  });

  const upload = multer({
    storage,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max
    fileFilter: (req, file, cb) => {
      const allowedTypes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
      if (allowedTypes.includes(file.mimetype)) {
        cb(null, true);
      } else {
        cb(new Error('Only image files are allowed'));
      }
    }
  });

  // POST /api/uploads/screenshot - Upload screenshot for worker debugging
  router.post('/uploads/screenshot', upload.single('screenshot'), (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
      }

      const workerId = req.body.workerId;

      // SECURITY: Don't leak full server filesystem path to client
      res.json({
        success: true,
        filename: req.file.filename,
        workerId,
        message: 'Screenshot saved successfully'
      });
    } catch (error) {
      res.status(500).json({ error: sanitizeErrorMessage(error) });
    }
  });

  // ============================================
  // SESSIONS
  // ============================================

  // GET /api/sessions/:id - Get a specific session
  router.get('/sessions/:id', (req, res) => {
    try {
      const sessionId = parseInt(req.params.id, 10);
      if (!isValidSessionId(sessionId)) {
        return res.status(400).json({ error: 'Invalid session ID' });
      }
      const session = getSession(sessionId);

      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      res.json(session);
    } catch (error) {
      res.status(500).json({ error: sanitizeErrorMessage(error) });
    }
  });

  // GET /api/sessions/:id/output - Get output for a specific session
  router.get('/sessions/:id/output', (req, res) => {
    try {
      const sessionId = parseInt(req.params.id, 10);
      if (!isValidSessionId(sessionId)) {
        return res.status(400).json({ error: 'Invalid session ID' });
      }
      const limit = Math.min(parseInt(req.query.limit, 10) || 100, 1000);
      const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

      const session = getSession(sessionId);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      const output = getSessionOutput(sessionId, { limit, offset });
      res.json(output);
    } catch (error) {
      res.status(500).json({ error: sanitizeErrorMessage(error) });
    }
  });

  // GET /api/sessions/:id/full-output - Get full concatenated output for a session
  router.get('/sessions/:id/full-output', (req, res) => {
    try {
      const sessionId = parseInt(req.params.id, 10);
      if (!isValidSessionId(sessionId)) {
        return res.status(400).json({ error: 'Invalid session ID' });
      }

      const session = getSession(sessionId);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      const output = getSessionFullOutput(sessionId);
      res.json({ sessionId, output });
    } catch (error) {
      res.status(500).json({ error: sanitizeErrorMessage(error) });
    }
  });

  // ============================================
  // OUTPUT DATABASE
  // ============================================

  // GET /api/output-db/stats - Get output database statistics
  router.get('/output-db/stats', (req, res) => {
    try {
      const stats = getOutputDbStats();
      res.json(stats);
    } catch (error) {
      res.status(500).json({ error: sanitizeErrorMessage(error) });
    }
  });

  // POST /api/output-db/cleanup - Trigger manual cleanup
  router.post('/output-db/cleanup', (req, res) => {
    try {
      const daysToKeep = Math.max(1, Math.min(parseInt(req.body.daysToKeep, 10) || 7, 365));
      const result = cleanupOldData(daysToKeep);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: sanitizeErrorMessage(error) });
    }
  });

  // ============================================
  // ACTIVITY
  // ============================================

  // GET /api/activity - Get activity log
  router.get('/activity', (req, res) => {
    try {
      const activity = getActivityLog();
      res.json(activity);
    } catch (error) {
      res.status(500).json({ error: sanitizeErrorMessage(error) });
    }
  });

  // ============================================
  // DEPENDENCY STATS
  // ============================================

  // GET /api/dependencies/stats - Get dependency graph statistics
  router.get('/dependencies/stats', (req, res) => {
    try {
      const stats = getDependencyStats();
      res.json(stats);
    } catch (error) {
      res.status(500).json({ error: sanitizeErrorMessage(error) });
    }
  });

  // ============================================
  // HEADLESS & BATCH EXECUTION
  // ============================================

  // POST /api/headless - Run Claude in headless mode
  router.post('/headless', async (req, res) => {
    try {
      const { projectPath, prompt, outputFormat, systemPrompt, timeout } = req.body;

      if (!projectPath || !prompt) {
        return res.status(400).json({ error: 'projectPath and prompt are required' });
      }
      if (typeof prompt !== 'string' || prompt.length > MAX_PROMPT_LENGTH) {
        return res.status(400).json({ error: `prompt must be a string under ${MAX_PROMPT_LENGTH} characters` });
      }
      if (systemPrompt !== undefined && (typeof systemPrompt !== 'string' || systemPrompt.length > MAX_SYSTEM_PROMPT_LENGTH)) {
        return res.status(400).json({ error: `systemPrompt must be a string under ${MAX_SYSTEM_PROMPT_LENGTH} characters` });
      }

      // SECURITY: Safely resolve project path with traversal prevention
      const resolvedPath = safeResolvePath(projectPath, theaRoot);
      if (!resolvedPath) {
        return res.status(400).json({ error: 'Invalid project path - path traversal not allowed' });
      }

      if (!projectExists(resolvedPath)) {
        return res.status(400).json({ error: 'Project path does not exist' });
      }

      // Validate outputFormat against whitelist
      const VALID_OUTPUT_FORMATS = ['json', 'text', 'stream-json'];
      if (outputFormat && !VALID_OUTPUT_FORMATS.includes(outputFormat)) {
        return res.status(400).json({ error: `outputFormat must be one of: ${VALID_OUTPUT_FORMATS.join(', ')}` });
      }
      if (timeout !== undefined && (typeof timeout !== 'number' || timeout < MIN_TIMEOUT_MS || timeout > MAX_TIMEOUT_MS)) {
        return res.status(400).json({ error: `timeout must be between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS} ms` });
      }

      const result = await runHeadless(resolvedPath, prompt, {
        outputFormat,
        systemPrompt,
        timeout
      });

      res.json({ success: true, result });
    } catch (error) {
      res.status(500).json({ error: sanitizeErrorMessage(error) });
    }
  });

  // POST /api/batch - Run batch operation across multiple projects
  router.post('/batch', async (req, res) => {
    try {
      const { projects, prompt, outputFormat, systemPrompt, timeout } = req.body;

      if (!projects || !Array.isArray(projects) || projects.length === 0) {
        return res.status(400).json({ error: 'projects array is required' });
      }
      if (projects.length > 50) {
        return res.status(400).json({ error: 'projects array must have at most 50 entries' });
      }

      if (!prompt || typeof prompt !== 'string') {
        return res.status(400).json({ error: 'prompt is required and must be a string' });
      }
      if (prompt.length > MAX_PROMPT_LENGTH) {
        return res.status(400).json({ error: `prompt must be under ${MAX_PROMPT_LENGTH} characters` });
      }
      if (systemPrompt !== undefined && (typeof systemPrompt !== 'string' || systemPrompt.length > MAX_SYSTEM_PROMPT_LENGTH)) {
        return res.status(400).json({ error: `systemPrompt must be a string under ${MAX_SYSTEM_PROMPT_LENGTH} characters` });
      }
      const VALID_BATCH_FORMATS = ['json', 'text', 'stream-json'];
      if (outputFormat && !VALID_BATCH_FORMATS.includes(outputFormat)) {
        return res.status(400).json({ error: `outputFormat must be one of: ${VALID_BATCH_FORMATS.join(', ')}` });
      }
      if (timeout !== undefined && (typeof timeout !== 'number' || timeout < MIN_TIMEOUT_MS || timeout > MAX_TIMEOUT_MS)) {
        return res.status(400).json({ error: `timeout must be between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS} ms` });
      }

      // SECURITY: Safely resolve project paths with traversal prevention
      const validPaths = [];
      const blockedPaths = [];

      for (const projectPath of projects) {
        const resolvedPath = safeResolvePath(projectPath, theaRoot);
        if (!resolvedPath) {
          blockedPaths.push(projectPath);
          continue;
        }
        if (projectExists(resolvedPath)) {
          validPaths.push(resolvedPath);
        }
      }

      if (blockedPaths.length > 0) {
        console.warn(`[SECURITY] Batch operation blocked ${blockedPaths.length} path traversal attempts`);
      }

      if (validPaths.length === 0) {
        return res.status(400).json({ error: 'No valid project paths found' });
      }

      const results = await runBatchOperation(validPaths, prompt, {
        outputFormat,
        systemPrompt,
        timeout
      });

      res.json({
        success: true,
        totalProjects: projects.length,
        processedProjects: validPaths.length,
        blockedPaths: blockedPaths.length,
        results
      });
    } catch (error) {
      res.status(500).json({ error: sanitizeErrorMessage(error) });
    }
  });

  // ============================================
  // OLLAMA
  // ============================================

  // GET /api/ollama/health - Check if Ollama is available
  router.get('/ollama/health', async (req, res) => {
    try {
      const health = await checkOllamaHealth();
      res.json(health);
    } catch (error) {
      res.status(500).json({ error: sanitizeErrorMessage(error) });
    }
  });

  // ============================================
  // VOICE COMMANDS
  // ============================================

  // POST /api/voice/command - Process voice command through orchestrator
  router.post('/voice/command', async (req, res) => {
    try {
      const { message } = req.body;

      if (!message || typeof message !== 'string') {
        return res.status(400).json({ error: 'message is required' });
      }
      if (message.length > 2000) {
        return res.status(400).json({ error: 'message must be under 2000 characters' });
      }
      if (CONTROL_CHAR_RE.test(message)) {
        return res.status(400).json({ error: 'message must not contain control characters' });
      }

      const result = await processVoiceCommand(message, theaRoot, io);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: sanitizeErrorMessage(error) });
    }
  });

  // GET /api/voice/history - Get conversation history
  router.get('/voice/history', (req, res) => {
    try {
      const history = getConversationHistory();
      res.json({ history });
    } catch (error) {
      res.status(500).json({ error: sanitizeErrorMessage(error) });
    }
  });

  // DELETE /api/voice/history - Clear conversation history
  router.delete('/voice/history', (req, res) => {
    try {
      clearConversationHistory();
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: sanitizeErrorMessage(error) });
    }
  });

  // ============================================
  // METRICS API
  // ============================================

  // GET /api/metrics/system - Get system-wide metrics
  router.get('/metrics/system', (req, res) => {
    try {
      const metricsService = getMetricsService();
      const workers = getWorkers();
      const parsedPeriod = parseInt(req.query.period, 10);
      const periodMinutes = Math.max(1, Math.min(Number.isNaN(parsedPeriod) ? 60 : parsedPeriod, 10080));
      const startTime = new Date(Date.now() - periodMinutes * 60000).toISOString();

      // Get summaries for key metrics
      const spawnTimeSummary = metricsService.getSummary(MetricTypes.WORKER_SPAWN_TIME, startTime);

      // Count active workers
      const activeWorkers = workers.filter(w => w.status === 'running').length;

      // Total spawns from metrics
      const totalSpawns = spawnTimeSummary.count || 0;

      // Average spawn time
      const avgSpawnTime = spawnTimeSummary.avg || 0;

      // Determine health status based on metrics
      let healthStatus = 'healthy';
      if (avgSpawnTime > 5000) {
        healthStatus = 'warning';
      }

      // Get memory usage
      const memUsage = process.memoryUsage();
      const totalMem = os.totalmem();
      const memoryUsage = Math.round((memUsage.heapUsed / totalMem) * 100 * 100) / 100;

      // Get uptime
      const uptime = Math.round(process.uptime());

      res.json({
        activeWorkers,
        totalSpawns,
        avgSpawnTime: Math.round(avgSpawnTime),
        errorRate: 0,
        errorCount: 0,
        healthStatus,
        memoryUsage,
        uptime,
        metrics: {
          spawnTime: {
            avg: spawnTimeSummary.avg,
            min: spawnTimeSummary.min,
            max: spawnTimeSummary.max,
            p50: spawnTimeSummary.p50,
            p95: spawnTimeSummary.p95,
            p99: spawnTimeSummary.p99
          },
        },
        period: `${periodMinutes} minutes`,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      res.status(500).json({ error: sanitizeErrorMessage(error) });
    }
  });

  // GET /api/metrics/worker/:id - Get metrics for a specific worker
  router.get('/metrics/worker/:id', (req, res) => {
    try {
      const worker = getWorker(req.params.id);

      if (!worker) {
        return res.status(404).json({ error: 'Resource not found' });
      }

      const metricsService = getMetricsService();
      const workerId = req.params.id;

      // Get worker-specific metrics from the last 24 hours
      const startTime = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const endTime = new Date().toISOString();

      // Query metrics with worker label
      const spawnMetrics = metricsService.getMetrics(
        MetricTypes.WORKER_SPAWN_TIME,
        startTime,
        endTime,
        100
      ).filter(m => {
        let labels = {};
        try { labels = m.labels ? JSON.parse(m.labels) : {}; } catch (e) { /* malformed labels */ }
        return labels.workerId === workerId;
      });

      // Calculate health score (0-100) based on various factors
      let healthScore = 100;
      const factors = [];

      // Factor 1: Status-based score
      if (worker.status === 'error' || worker.status === 'failed') {
        healthScore -= 50;
        factors.push({ name: 'status', impact: -50, reason: `Worker status: ${worker.status}` });
      } else if (worker.status === 'pending') {
        healthScore -= 10;
        factors.push({ name: 'status', impact: -10, reason: 'Worker is pending' });
      }

      // Factor 2: Spawn time
      if (spawnMetrics.length > 0) {
        const spawnTime = spawnMetrics[0].value;
        if (spawnTime > 10000) {
          healthScore -= 10;
          factors.push({ name: 'spawnTime', impact: -10, reason: `Slow spawn time: ${Math.round(spawnTime)}ms` });
        }
      }

      // Ensure score is within bounds
      healthScore = Math.max(0, Math.min(100, healthScore));

      // Calculate uptime
      const createdAt = new Date(worker.createdAt);
      const uptimeMs = Date.now() - createdAt.getTime();
      const uptimeSeconds = Math.floor(uptimeMs / 1000);

      res.json({
        workerId,
        healthScore,
        healthFactors: factors,
        status: worker.status,
        lifecycle: {
          createdAt: worker.createdAt,
          uptime: uptimeSeconds,
          uptimeFormatted: formatUptime(uptimeSeconds),
          spawnTime: spawnMetrics.length > 0 ? Math.round(spawnMetrics[0].value) : null
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      res.status(500).json({ error: sanitizeErrorMessage(error) });
    }
  });

  // GET /api/metrics/realtime - Get last 50 data points per metric type
  router.get('/metrics/realtime', (req, res) => {
    try {
      const metricsService = getMetricsService();
      const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);

      // Get realtime metrics for each type from in-memory cache
      const realtimeData = {};

      for (const [key, type] of Object.entries(MetricTypes)) {
        const metrics = metricsService.getRealtime(type);
        // Return last N entries
        realtimeData[type] = metrics.slice(-limit).map(m => ({
          value: m.value,
          timestamp: m.timestamp,
          labels: m.labels
        }));
      }

      res.json({
        metrics: realtimeData,
        limit,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      res.status(500).json({ error: sanitizeErrorMessage(error) });
    }
  });

  // ============================================
  // HEALTH & RESOURCES
  // ============================================

  // GET /api/health - Health check with optional diagnostics
  // ?detailed=true returns memory, workers, and database status
  router.get('/health', (req, res) => {
    try {
      const result = {
        status: 'ok',
        timestamp: new Date().toISOString()
      };

      if (req.query.detailed === 'true') {
        const mem = process.memoryUsage();
        const stats = getResourceStats();
        result.memory = {
          heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
          rssMb: Math.round(mem.rss / 1024 / 1024)
        };
        result.workers = {
          running: stats.running,
          total: stats.total,
          errors: stats.error
        };
        result.uptime = Math.floor(process.uptime());

        // Quick database connectivity check
        try {
          const logger = req.app.locals.logger;
          if (logger) logger.queryLogs({ limit: 1 });
          result.database = 'ok';
        } catch {
          result.database = 'error';
          result.status = 'degraded';
        }
      }

      res.json(result);
    } catch (error) {
      res.status(500).json({ error: 'Health check failed' });
    }
  });

  // GET /api/health/circuit-breaker - Circuit breaker status
  router.get('/health/circuit-breaker', (req, res) => {
    try {
      res.json(getCircuitBreakerStatus());
    } catch (error) {
      res.status(500).json({ error: sanitizeErrorMessage(error) });
    }
  });

  // POST /api/health/circuit-breaker/reset - Reset circuit breaker
  router.post('/health/circuit-breaker/reset', (req, res) => {
    try {
      resetCircuitBreaker();
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: sanitizeErrorMessage(error) });
    }
  });

  // GET /api/resources - Get resource usage stats
  router.get('/resources', (req, res) => {
    try {
      const stats = getResourceStats();
      res.json({
        ...stats,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      res.status(500).json({ error: sanitizeErrorMessage(error) });
    }
  });

  // ============================================
  // LOG VIEWER ENDPOINTS
  // ============================================

  // GET /api/logs - Query server logs
  router.get('/logs', (req, res) => {
    try {
      const logger = req.app.locals.logger;
      if (!logger) {
        return res.status(503).json({ error: 'Logger not initialized' });
      }

      const { level, from, to, limit = 100 } = req.query;
      const VALID_LOG_LEVELS = ['DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'];
      const normalizedLevel = level?.toUpperCase();
      if (level !== undefined && !VALID_LOG_LEVELS.includes(normalizedLevel)) {
        return res.status(400).json({ error: `Invalid log level: "${level}". Valid levels: ${VALID_LOG_LEVELS.join(', ')}` });
      }
      const logs = logger.queryLogs({
        level: normalizedLevel,
        from,
        to,
        limit: Math.min(parseInt(limit, 10) || 100, 1000)
      });

      res.json({
        count: logs.length,
        logs
      });
    } catch (err) {
      res.status(500).json({ error: sanitizeErrorMessage(err) });
    }
  });

  // GET /api/logs/lifecycle - View startup/shutdown/crash history
  router.get('/logs/lifecycle', (req, res) => {
    try {
      const logger = req.app.locals.logger;
      if (!logger) {
        return res.status(503).json({ error: 'Logger not initialized' });
      }

      const { limit = 50 } = req.query;
      const events = logger.queryLifecycle(Math.min(parseInt(limit, 10) || 50, 500));

      res.json({
        count: events.length,
        events
      });
    } catch (err) {
      res.status(500).json({ error: sanitizeErrorMessage(err) });
    }
  });

  // GET /api/logs/stats - Get logging statistics
  router.get('/logs/stats', (req, res) => {
    try {
      const logger = req.app.locals.logger;
      if (!logger) {
        return res.status(503).json({ error: 'Logger not initialized' });
      }

      const stats = logger.getStats();
      res.json(stats);
    } catch (err) {
      res.status(500).json({ error: sanitizeErrorMessage(err) });
    }
  });

  // GET /api/status - Get service status from status file
  router.get('/status', (req, res) => {
    try {
      const statusPath = path.join(theaRoot, 'shared', 'status', 'strategos.json');
      if (fs.existsSync(statusPath)) {
        const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
        res.json(status);
      } else {
        res.json({
          service: 'strategos',
          status: 'unknown',
          message: 'Status file not found'
        });
      }
    } catch (err) {
      res.status(500).json({ error: sanitizeErrorMessage(err) });
    }
  });

  // ============================================
  // RALPH INTELLIGENCE (Respawn Suggestions + Efficiency)
  // ============================================

  router.get('/respawn-suggestions', (req, res) => {
    try {
      res.json(getRespawnSuggestions());
    } catch (error) {
      res.status(500).json({ error: sanitizeErrorMessage(error) });
    }
  });

  router.delete('/respawn-suggestions/:workerId', (req, res) => {
    try {
      const removed = removeRespawnSuggestion(req.params.workerId);
      if (!removed) {
        return res.status(404).json({ error: 'Suggestion not found' });
      }
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: sanitizeErrorMessage(error) });
    }
  });

  // ============================================
  // WORKER CHECKPOINTS (Level 2: Work survives death)
  // ============================================

  // Strip absolute filesystem paths from checkpoint data before sending to client
  function sanitizeCheckpoint(data) {
    const sanitized = {
      ...data,
      task: data.task || {},
      childWorkerIds: data.childWorkerIds || [],
      ralphProgress: data.ralphProgress ?? 0,
      ralphCurrentStep: data.ralphCurrentStep || '',
      ralphLearnings: data.ralphLearnings || '',
      ralphOutputs: Array.isArray(data.ralphOutputs) ? data.ralphOutputs
        : (typeof data.ralphOutputs === 'string' && data.ralphOutputs ? [data.ralphOutputs] : []),
      ralphArtifacts: Array.isArray(data.ralphArtifacts) ? data.ralphArtifacts
        : (typeof data.ralphArtifacts === 'string' && data.ralphArtifacts ? [data.ralphArtifacts] : []),
      parentLabel: data.parentLabel || '',
      crashReason: data.crashReason || '',
    };
    // Replace absolute workingDir with basename to prevent path leakage
    if (sanitized.workingDir) {
      sanitized.workingDir = path.basename(sanitized.workingDir);
    }
    return sanitized;
  }

  router.get('/checkpoints', (req, res) => {
    try {
      const checkpointDir = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '.tmp', 'checkpoints');
      if (!fs.existsSync(checkpointDir)) {
        return res.json([]);
      }
      const files = fs.readdirSync(checkpointDir)
        .filter(f => f.endsWith('.json'))
        .slice(0, 200) // Cap to prevent reading thousands of files
        .map(f => {
          try {
            const data = JSON.parse(fs.readFileSync(path.join(checkpointDir, f), 'utf8'));
            return sanitizeCheckpoint(data);
          } catch { return null; }
        })
        .filter(Boolean)
        .sort((a, b) => new Date(b.diedAt) - new Date(a.diedAt));
      res.json(files);
    } catch (err) {
      res.status(500).json({ error: sanitizeErrorMessage(err) });
    }
  });

  router.get('/checkpoints/:workerId', (req, res) => {
    try {
      const checkpointDir = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '.tmp', 'checkpoints');
      const sanitizedId = req.params.workerId.replace(/[^a-zA-Z0-9_-]/g, '');
      const filePath = path.join(checkpointDir, `${sanitizedId}.json`);
      if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'Checkpoint not found' });
      }
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      res.json(sanitizeCheckpoint(data));
    } catch (err) {
      res.status(500).json({ error: sanitizeErrorMessage(err) });
    }
  });

  // ─── Claude Usage / Rate Limits ──────────────────────────────────────────────
  // Reads ~/.claude/.credentials.json server-side to check rate limits via Anthropic API.
  // Only rate limit utilization data is returned to client — no tokens or credentials are exposed.
  let _usageCache = null;
  let _usageCacheTime = 0;
  const USAGE_CACHE_TTL = 60_000; // 60s

  router.get('/usage', async (req, res) => {

    const now = Date.now();
    if (_usageCache && (now - _usageCacheTime) < USAGE_CACHE_TTL) {
      return res.json(_usageCache);
    }

    try {
      const credsPath = path.join(os.homedir(), '.claude', '.credentials.json');
      if (!fs.existsSync(credsPath)) {
        return res.status(404).json({ error: 'No Claude credentials found' });
      }

      const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
      const token = creds.claudeAiOauth?.accessToken;
      if (!token) {
        return res.status(401).json({ error: 'No access token in credentials' });
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);

      const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'oauth-2025-04-20',
          'authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 1,
          messages: [{ role: 'user', content: 'hi' }]
        }),
        signal: controller.signal
      });
      clearTimeout(timeout);

      const h = (name) => apiRes.headers.get(name);

      const usage = {
        status: h('anthropic-ratelimit-unified-status') || 'unknown',
        session: {
          status: h('anthropic-ratelimit-unified-5h-status'),
          utilization: parseFloat(h('anthropic-ratelimit-unified-5h-utilization') || '0'),
          reset: parseInt(h('anthropic-ratelimit-unified-5h-reset') || '0', 10)
        },
        weekly: {
          status: h('anthropic-ratelimit-unified-7d-status'),
          utilization: parseFloat(h('anthropic-ratelimit-unified-7d-utilization') || '0'),
          reset: parseInt(h('anthropic-ratelimit-unified-7d-reset') || '0', 10)
        },
        representativeClaim: h('anthropic-ratelimit-unified-representative-claim'),
        fallbackPercentage: parseFloat(h('anthropic-ratelimit-unified-fallback-percentage') || '0'),
        overageStatus: h('anthropic-ratelimit-unified-overage-status'),
        subscription: creds.claudeAiOauth?.subscriptionType || 'unknown',
        tier: creds.claudeAiOauth?.rateLimitTier || 'unknown',
        fetchedAt: new Date().toISOString()
      };

      _usageCache = usage;
      _usageCacheTime = now;
      res.json(usage);
    } catch (err) {
      if (err.name === 'AbortError') {
        return res.status(504).json({ error: 'Anthropic API timeout' });
      }
      res.status(500).json({ error: sanitizeErrorMessage(err) });
    }
  });

  return router;
}
