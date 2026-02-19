import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { fileURLToPath } from 'url';

import { createRoutes } from './routes.js';
import { createIntegrationRoutes } from './routes/integration.js';
import { createADRRoutes } from './routes/adrs.js';
import { createRalphRoutes } from './routes/ralph.js';
import { createRalphService } from './services/ralphService.js';
import { setupSocketHandlers, stopMetricsBroadcast } from './socketHandler.js';
import { checkTmux, discoverExistingWorkers, restoreWorkerState, saveWorkerState, saveWorkerStateSync, getWorkers, getWorkerInternal, spawnWorker, killWorker, startPeriodicCleanup, stopPeriodicCleanup, stopAllHealthMonitors, stopAllPtyCaptures, getResourceStats, closeOutputDb, setWorkerDeathCallback } from './workerManager.js';
import { THEA_ROOT } from './workers/state.js';
import { authenticateRequest, authenticateSocket, logAuthStatus } from './middleware/auth.js';

// Logging and status
import { initLogger, getLogger, LifecycleEvent } from './logger.js';
import { getStatusWriter } from './statusWriter.js';
import { resetMetricsService } from './metricsService.js';
import { startSentinel, stopSentinel, runDiagnostics, getLastDiagnostics, getDiagnosticsHistory, getSentinelStatus } from './sentinel.js';



const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Global references for graceful shutdown
let globalRalphService = null;
let globalLogger = null;
let globalStatusWriter = null;
let globalHttpServer = null;
let globalIo = null;

// Configuration - Thea Kingdom port convention: 380XX
// Server: 38007, Client: 38008 (see /docs/PORT_REGISTRY.md)
const PORT = parseInt(process.env.PORT || '38007', 10);
if (isNaN(PORT) || PORT < 1 || PORT > 65535) {
  console.error(`[FATAL] Invalid PORT: ${process.env.PORT} — must be 1-65535`);
  process.exit(1);
}
const HOST = process.env.STRATEGOS_HOST || '127.0.0.1';
if (!/^[\w.:]+$/.test(HOST)) {
  console.error(`[FATAL] Invalid STRATEGOS_HOST: "${HOST}" — must be a valid hostname or IP`);
  process.exit(1);
}
// THEA_ROOT imported from ./workers/state.js (auto-derived from project location, or THEA_ROOT env var)
if (!path.isAbsolute(THEA_ROOT)) {
  console.error(`[FATAL] THEA_ROOT must be an absolute path, got: "${THEA_ROOT}"`);
  process.exit(1);
}
if (THEA_ROOT === '/' || THEA_ROOT === '/etc' || THEA_ROOT === '/sys' || THEA_ROOT === '/proc') {
  console.error(`[FATAL] THEA_ROOT points to a dangerous system directory: "${THEA_ROOT}"`);
  process.exit(1);
}
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || 'http://localhost:38008';
if (CLIENT_ORIGIN && !/^https?:\/\/.+/.test(CLIENT_ORIGIN)) {
  console.error(`[FATAL] CLIENT_ORIGIN must be a valid HTTP(S) URL, got: "${CLIENT_ORIGIN}"`);
  process.exit(1);
}

// CORS origins: localhost-only by default for security.
// Override with STRATEGOS_CORS_ORIGINS (comma-separated URLs) for LAN/remote access.
function buildCorsOrigins() {
  const origins = [CLIENT_ORIGIN, /^http:\/\/localhost:\d+$/];
  const extra = process.env.STRATEGOS_CORS_ORIGINS;
  if (extra) {
    for (const o of extra.split(',').map(s => s.trim()).filter(Boolean)) {
      if (/^https?:\/\/.+/.test(o)) {
        origins.push(o);
      } else {
        console.warn(`[WARN] Ignoring invalid STRATEGOS_CORS_ORIGINS entry: "${o}"`);
      }
    }
  }
  return origins;
}
const CORS_ORIGINS = buildCorsOrigins();
if (process.env.STRATEGOS_API_KEY && process.env.STRATEGOS_API_KEY.trim().length === 0) {
  console.error('[FATAL] STRATEGOS_API_KEY is set but empty/whitespace — remove it or set a real key');
  process.exit(1);
}
if (process.env.STRATEGOS_API_KEY && process.env.STRATEGOS_API_KEY.length < 16) {
  console.warn('[WARN] STRATEGOS_API_KEY is shorter than 16 characters — consider using a stronger key');
}

async function main() {
  // Initialize logger first
  globalLogger = initLogger({
    minLevel: process.env.LOG_LEVEL === 'debug' ? 0 : 1 // DEBUG=0, INFO=1
  });
  const log = globalLogger;

  // Initialize status writer
  globalStatusWriter = getStatusWriter();

  // Log startup lifecycle event
  log.logLifecycle(LifecycleEvent.STARTUP, 'server starting', {
    nodeVersion: process.version,
    port: PORT,
    theaRoot: THEA_ROOT
  });

  // Check tmux availability
  const hasTmux = await checkTmux();
  if (!hasTmux) {
    log.fatal('tmux is not installed', {
      hint: 'Ubuntu/Debian: sudo apt install tmux | macOS: brew install tmux'
    });
    process.exit(1);
  }

  log.info('Thea Orchestrator Server starting');
  log.info('Configuration', { THEA_ROOT, PORT, HOST, CLIENT_ORIGIN });
  logAuthStatus();

  // Create Express app
  const app = express();
  const httpServer = createServer(app);

  // Setup Socket.io with stability-focused configuration
  const io = new Server(httpServer, {
    cors: {
      origin: CORS_ORIGINS,
      methods: ['GET', 'POST']
    },
    // Heartbeat configuration to detect dead connections
    pingInterval: 25000,    // Send ping every 25 seconds
    pingTimeout: 60000,     // Wait 60 seconds for pong before disconnect
    // Buffer and connection limits
    maxHttpBufferSize: 1e6, // 1MB max message size
    connectTimeout: 45000,  // 45 second connection timeout
    // Upgrade configuration
    upgradeTimeout: 30000,  // 30 seconds to complete upgrade
    allowUpgrades: true,
    // Prevent connection storms
    perMessageDeflate: false // Disable compression (reduces CPU, improves stability)
  });

  // Middleware — helmet FIRST so security headers apply to ALL responses (including CORS preflight)
  app.use(helmet({
    contentSecurityPolicy: false, // SPA needs inline scripts/styles from Vite build
    crossOriginEmbedderPolicy: false, // Allow WebSocket cross-origin
  }));

  app.use(cors({
    origin: CORS_ORIGINS
  }));

  // Rate limiting — generous limits for dashboard polling, strict for spawn endpoints
  const generalLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 300, // 300 requests per minute (5/sec) — dashboard polls frequently
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later' },
  });
  const spawnLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30, // 30 spawns per minute — prevents accidental spawn storms
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many spawn requests, please try again later' },
  });
  app.use('/api', generalLimiter);
  // Rate limit only spawn/creation endpoints — NOT worker queries, input, or settings.
  // app.use('/api/workers', ...) would apply 30/min to ALL worker routes including
  // GET /api/workers (dashboard polling) and POST /api/workers/:id/input.
  app.post('/api/workers', spawnLimiter);
  app.post('/api/workers/spawn-from-template', spawnLimiter);

  app.post('/api/workers/execute', spawnLimiter);

  app.use(express.json({ limit: '2mb' })); // Prevent oversized payloads (workers can send 1MB input)
  app.use(authenticateRequest); // API key authentication (when STRATEGOS_API_KEY is set)

  // Initialize Ralph Service (Autonomous AI Agent Loop)
  // Store for graceful shutdown
  globalHttpServer = httpServer;
  globalIo = io;

  const ralphService = createRalphService(io);
  app.locals.ralphService = ralphService;
  globalRalphService = ralphService;

  // Wire up worker death callback for Ralph unregistration
  setWorkerDeathCallback((worker) => {
    if (worker.ralphToken) {
      ralphService.unregisterStandaloneWorker(worker.ralphToken);
    }
  });

  // API routes
  app.use('/api', createRoutes(THEA_ROOT, io));
  app.use('/api/integration', createIntegrationRoutes(THEA_ROOT, io));
  app.use('/api/adrs', createADRRoutes());
  app.use('/api/ralph', createRalphRoutes(ralphService));

  // Sentinel — toggleable deep diagnostics mode
  app.get('/api/sentinel/status', (req, res) => {
    res.json(getSentinelStatus());
  });
  app.post('/api/sentinel/start', async (req, res) => {
    startSentinel();
    const result = await runDiagnostics();
    io.emit('sentinel:status', getSentinelStatus());
    res.json({ success: true, diagnostics: result });
  });
  app.post('/api/sentinel/stop', (req, res) => {
    stopSentinel();
    io.emit('sentinel:status', getSentinelStatus());
    res.json({ success: true });
  });
  app.get('/api/diagnostics', async (req, res) => {
    try {
      const result = req.query.run === 'true' ? await runDiagnostics() : (getLastDiagnostics() || await runDiagnostics());
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: 'Diagnostics failed', message: err.message });
    }
  });
  app.get('/api/diagnostics/history', (req, res) => {
    res.json(getDiagnosticsHistory());
  });

  // Serve static client files in production
  const clientDist = path.join(__dirname, '..', 'client', 'dist');
  app.use(express.static(clientDist));

  // Fallback to index.html for SPA routing (non-API paths only)
  // I-1: Reject paths with dots (file extensions) that weren't served by express.static —
  // these are missing assets, not SPA routes. Also reject paths with encoded traversals.
  app.get('*', (req, res) => {
    if (req.path.startsWith('/api')) {
      // Undefined API endpoint — respond with 404 (was hanging without response)
      return res.status(404).json({ error: 'Not found' });
    }
    // Paths with file extensions (e.g., /foo.js, /bar.css) that weren't caught by
    // express.static are genuinely missing files — return 404, not index.html
    if (/\.[a-zA-Z0-9]{1,10}$/.test(req.path)) {
      return res.status(404).json({ error: 'Not found' });
    }
    res.sendFile(path.join(clientDist, 'index.html'));
  });

  // Centralized error handler — catches unhandled route/middleware errors (including multer)
  // Must be AFTER all routes and have 4 parameters for Express to recognize it as error middleware.
  app.use((err, req, res, _next) => {
    // Multer-specific errors (file too large, wrong type, etc.)
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'File too large' });
    }
    if (err.message === 'Only image files are allowed') {
      return res.status(400).json({ error: err.message });
    }
    log.error('Unhandled Express error', { method: req.method, path: req.path, error: err.message });
    res.status(err.status || 500).json({ error: 'Internal server error' });
  });

  // Restore saved worker state BEFORE setting up socket handlers
  // This prevents clients from connecting and seeing empty state during restore
  log.info('Restoring saved worker state...');
  await restoreWorkerState(io);

  // Re-register Ralph tokens for restored workers
  // NOTE: getWorkers() strips ralphToken (security fix dfbc4a3), so we must
  // use getWorkerInternal() to access the raw token for server-side registration.
  const restoredWorkers = getWorkers();
  let ralphCount = 0;
  for (const worker of restoredWorkers) {
    if (worker.ralphMode) {
      const internal = getWorkerInternal(worker.id);
      if (internal?.ralphToken) {
        ralphService.registerStandaloneWorker(internal.ralphToken, worker.id);
        ralphCount++;
      }
    }
  }
  if (ralphCount > 0) {
    log.info('Re-registered Ralph workers', { count: ralphCount });
  }

  // Discover any additional existing tmux sessions
  log.info('Discovering existing workers...');
  const existingWorkers = await discoverExistingWorkers(io);
  log.info('Worker discovery complete', { found: existingWorkers.length });

  // Socket.io authentication middleware
  io.use(authenticateSocket);

  // Setup Socket.io handlers AFTER state is restored — clients get complete state on connect
  setupSocketHandlers(io, THEA_ROOT);

  // Start periodic cleanup sweep to prevent resource leaks
  startPeriodicCleanup(io);

  // Sentinel is available but NOT auto-started. Enable via:
  //   POST /api/sentinel/start
  //   UI toggle in dashboard
  //   Or tell Claude: "enable sentinel"
  const stats = getResourceStats();
  log.info('Resource limits', {
    running: stats.running,
    max: stats.maxConcurrent,
    available: stats.availableSlots
  });

  // Setup status writer with worker count provider
  globalStatusWriter.setWorkerCountProvider(() => getWorkers().length);
  globalStatusWriter.setHealthProvider(() => {
    const workers = getWorkers();
    const unhealthy = workers.filter(w => w.health === 'unhealthy' || w.health === 'dead').length;
    if (unhealthy > workers.length / 2) return 'unhealthy';
    if (unhealthy > 0) return 'degraded';
    return 'healthy';
  });

  // Make logger available to routes
  app.locals.logger = globalLogger;

  // Start server with EADDRINUSE retry logic.
  // When restarting (e.g., systemd Restart=always), the old process may still be
  // releasing the port. Instead of immediately exiting and burning through systemd's
  // StartLimitBurst, retry a few times with backoff.
  const MAX_LISTEN_RETRIES = 5;
  const LISTEN_RETRY_DELAY_MS = 3000; // 3s between retries = 15s total window
  let listenRetries = 0;

  httpServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      listenRetries++;
      if (listenRetries > MAX_LISTEN_RETRIES) {
        log.fatal(`Port ${PORT} still in use after ${MAX_LISTEN_RETRIES} retries — giving up`, { port: PORT });
        process.exit(1);
      }
      log.warn(`Port ${PORT} in use, retrying in ${LISTEN_RETRY_DELAY_MS / 1000}s (attempt ${listenRetries}/${MAX_LISTEN_RETRIES})...`, { port: PORT });
      setTimeout(() => {
        httpServer.listen(PORT, HOST);
      }, LISTEN_RETRY_DELAY_MS);
      return;
    }
    log.error('HTTP server error', { error: err.message, code: err.code });
  });

  httpServer.listen(PORT, HOST, () => {
    if (listenRetries > 0) {
      log.info(`Server running (after ${listenRetries} EADDRINUSE retries)`, {
        url: `http://${HOST}:${PORT}`,
        api: `http://${HOST}:${PORT}/api`
      });
    } else {
      log.info('Server running', {
        url: `http://${HOST}:${PORT}`,
        api: `http://${HOST}:${PORT}/api`
      });
    }

    // Start status writer after server is listening
    globalStatusWriter.start();
    log.info('Status writer started', {
      statusFile: path.join(THEA_ROOT, 'shared', 'status', 'strategos.json')
    });
  });
}

// Graceful shutdown - save worker state before exit
let _shuttingDown = false;
async function gracefulShutdown(signal) {
  if (_shuttingDown) {
    console.log(`[Shutdown] Already shutting down, ignoring duplicate ${signal}`);
    return;
  }
  _shuttingDown = true;

  // Force-exit if graceful shutdown hangs (e.g., stuck HTTP connections, deadlocked async)
  // If the process manager (systemd, etc.) force-kills before this fires,
  // state saves and DB closes are interrupted. Ensure KillMode timeout exceeds this value.
  const SHUTDOWN_TIMEOUT_MS = 15000;
  const shutdownTimer = setTimeout(() => {
    console.error(`[Shutdown] Graceful shutdown timed out after ${SHUTDOWN_TIMEOUT_MS}ms, forcing exit`);
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  shutdownTimer.unref(); // Don't keep the process alive for this timer alone

  const log = getLogger();
  log.info(`${signal} received, initiating graceful shutdown...`);

  // Log lifecycle event
  log.logLifecycle(LifecycleEvent.SHUTDOWN, signal);

  // Update status file
  if (globalStatusWriter) {
    globalStatusWriter.shutdown(signal);
  }

  // Stop accepting new connections and force-close existing ones.
  // httpServer.close() stops new connections but waits for active ones to drain.
  // Long-running routes (/api/headless can run 10min) would block shutdown,
  // so we close idle connections immediately and force remaining after 2s.
  if (globalIo) {
    globalIo.disconnectSockets(true);
    globalIo.close();
    log.info('Socket.io connections closed');
  }
  if (globalHttpServer) {
    globalHttpServer.closeIdleConnections();
    // Wait for connections to drain naturally, force-close remaining after 2s
    await new Promise((resolve) => {
      let settled = false;
      globalHttpServer.close(() => {
        if (!settled) { settled = true; log.info('HTTP server drained'); resolve(); }
      });
      setTimeout(() => {
        if (!settled) { settled = true; globalHttpServer.closeAllConnections(); log.info('HTTP server force-closed'); resolve(); }
      }, 2000);
    });
  }

  // Stop all timers before saving state (prevent races)
  stopSentinel();
  stopPeriodicCleanup();
  stopAllHealthMonitors();
  stopAllPtyCaptures();
  stopMetricsBroadcast();

  // Cleanup Ralph service BEFORE saving state — Ralph cleanup may modify
  // worker state (unregister tokens, update statuses) that should be persisted
  if (globalRalphService) {
    try {
      await globalRalphService.cleanup();
      log.info('Ralph service cleaned up');
    } catch (err) {
      log.error('Error cleaning up Ralph service', { error: err.message });
    }
  }

  try {
    await saveWorkerState();
    log.info('Worker state saved successfully');
  } catch (err) {
    log.error('Error saving worker state', { error: err.message });
  }

  // Close output database (checkpoint WAL and close connection)
  try {
    closeOutputDb();
  } catch (err) {
    log.error('Error closing output database', { error: err.message });
  }

  // Close metrics database (stops aggregation timer)
  try {
    resetMetricsService();
  } catch (err) {
    log.error('Error closing metrics service', { error: err.message });
  }

  // Close logger last — must await so final entries flush to disk
  log.info('Shutdown complete');
  if (globalLogger) {
    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        resolve(); // Don't block shutdown if logger hangs
      }, 3000);
      globalLogger.close(() => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Track exception handling to prevent cascades
let _handlingException = false;
let _exceptionCount = 0;
let _exceptionResetTime = Date.now();
const MAX_EXCEPTIONS_BEFORE_EXIT = 10;

// Crash protection - log and continue instead of crashing
process.on('uncaughtException', (err) => {
  // EPIPE means stdout/stderr is broken - exit cleanly instead of looping
  // EADDRINUSE means another instance is already running - exit immediately
  // Fatal errors that require immediate exit — system cannot recover
  const FATAL_CODES = ['EPIPE', 'EADDRINUSE', 'ENOMEM', 'EMFILE', 'ENFILE'];
  const FATAL_MESSAGES = ['EPIPE', 'EADDRINUSE', 'database disk image is malformed', 'SQLITE_CORRUPT'];
  if (FATAL_CODES.includes(err.code) ||
      FATAL_MESSAGES.some(m => err.message?.includes(m) || err.code === m)) {
    console.error(`[CRASH PROTECTION] Fatal: ${err.code || err.message} — exiting`);
    process.exit(1);
    return;
  }

  // Prevent cascading exception handling
  if (_handlingException) return;
  _handlingException = true;

  // Rate limit exceptions - if too many in a short period, exit
  const now = Date.now();
  if (now - _exceptionResetTime > 10000) {
    _exceptionCount = 0;
    _exceptionResetTime = now;
  }
  _exceptionCount++;
  if (_exceptionCount > MAX_EXCEPTIONS_BEFORE_EXIT) {
    gracefulShutdown('EXCEPTION_FLOOD');
    return;
  }

  try {
    const log = getLogger();
    log.error('[CRASH PROTECTION] Uncaught exception', {
      error: err.message,
      stack: err.stack
    });

    // Log as lifecycle event but don't exit
    log.logLifecycle(LifecycleEvent.CRASH, 'uncaughtException', {
      error: err.message,
      recovered: true
    });

    // Save worker state synchronously so crash recovery can restore workers
    saveWorkerStateSync();

    // Update status to show we caught an error but recovered.
    // crash() stops the periodic interval, so call start() to restart it
    // (start() sets status='running' and resumes periodic writes)
    if (globalStatusWriter) {
      globalStatusWriter.crash(err);
      globalStatusWriter.start();
    }
  } finally {
    _handlingException = false;
  }

  // Don't exit - try to keep running
});

// Separate rejection counter (shares flood threshold with uncaughtException)
let _rejectionCount = 0;
let _rejectionResetTime = Date.now();

process.on('unhandledRejection', (reason, promise) => {
  // Prevent cascading
  if (_handlingException) return;
  _handlingException = true;

  // Rate limit rejections - if too many in a short period, exit
  const now = Date.now();
  if (now - _rejectionResetTime > 10000) {
    _rejectionCount = 0;
    _rejectionResetTime = now;
  }
  _rejectionCount++;
  if (_rejectionCount > MAX_EXCEPTIONS_BEFORE_EXIT) {
    gracefulShutdown('REJECTION_FLOOD');
    return;
  }

  try {
    const log = getLogger();
    log.error('[CRASH PROTECTION] Unhandled rejection', {
      reason: String(reason),
      promise: String(promise)
    });

    // Log as lifecycle event but don't exit
    log.logLifecycle(LifecycleEvent.CRASH, 'unhandledRejection', {
      reason: String(reason),
      recovered: true
    });

    // Save worker state (same as uncaughtException handler)
    saveWorkerStateSync();
  } finally {
    _handlingException = false;
  }

  // Don't exit - try to keep running
});

main().catch((err) => {
  const log = getLogger();
  log.fatal('[FATAL] Server failed to start', { error: err.message, stack: err.stack });

  // Log lifecycle event
  log.logLifecycle(LifecycleEvent.CRASH, 'startup failure', {
    error: err.message,
    recovered: false
  });

  // Update status file
  if (globalStatusWriter) {
    globalStatusWriter.crash(err);
  }

  // Close databases that may have been opened during partial startup
  try { closeOutputDb(); } catch { /* best effort */ }
  try { resetMetricsService(); } catch { /* best effort */ }
  // Close logger before exit
  if (globalLogger) {
    globalLogger.close();
  }

  process.exit(1);
});
