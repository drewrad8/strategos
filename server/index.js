import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { fileURLToPath } from 'url';

// Configuration - load first
import { loadConfig, getConfig, getProjectsRoot, getDataDir } from './config.js';

// Provider system
import { initializeProviders, getProvidersInfo, checkAllProviders } from './providers/index.js';

import { createRoutes } from './routes.js';
import { createIntegrationRoutes } from './routes/integration.js';
import { createADRRoutes } from './routes/adrs.js';
import { createRalphRoutes } from './routes/ralph.js';
import { createRalphService } from './services/ralphService.js';
import { setupSocketHandlers } from './socketHandler.js';
import { checkTmux, discoverExistingWorkers, restoreWorkerState, saveWorkerState, getWorkers, spawnWorker, killWorker, startPeriodicCleanup, getResourceStats } from './workerManager.js';
import { authenticateRequest, authenticateSocket, logAuthStatus } from './middleware/auth.js';

// Logging and status
import { initLogger, getLogger, LifecycleEvent } from './logger.js';
import { getStatusWriter } from './statusWriter.js';

// Foundation Layer - Enhanced reliability and monitoring
import { HealthMonitor, HealthStatus } from './foundation/index.js';
import { CircuitBreaker, getBreaker } from './foundation/index.js';
import { ErrorRecovery, createErrorRecovery } from './foundation/index.js';

// Intelligence Layer - AI-enhanced verification and correction
import { VerificationPipeline, TaskTypes } from './intelligence/index.js';
import { SelfCorrectionLoop, StopReasons } from './intelligence/index.js';
import { ReflexionLoop, REFLECTION_MEMORY_TYPE } from './intelligence/index.js';
import { ConfidenceEstimator, ConfidenceLevel } from './intelligence/index.js';
import { EnhancedVerificationPipeline } from './intelligence/index.js';
import { TaskDecomposer, createDecomposer } from './intelligence/index.js';
import { MemoryManager, MemoryTypes, RelationshipTypes } from './intelligence/index.js';

// Coordination Layer - Multi-agent orchestration
import { MultiAgentReview, createMultiAgentReview } from './coordination/index.js';
import { DebateProtocol, ConsensusMethod, DebatePhase } from './coordination/index.js';
import { StateSync, getStateSync } from './coordination/index.js';
import { EscalationSystem, EscalationReasons, UrgencyLevels } from './coordination/index.js';

// Services - Higher-level integrations
import { createVerificationService, TaskTypes as VerificationTaskTypes } from './services/verificationService.js';
import { createSelfOptimizeService, CycleState, StopReasons as OptimizeStopReasons } from './services/selfOptimizeService.js';
import {
  createGeneralService,
  CommandLevel,
  AutonomyLevel,
  DomainType,
  MissionStatus,
  CommandersIntent,
  MissionOrder,
  OODALoop
} from './services/generalService.js';
import { createPredictiveScaling, ScalingState } from './services/predictiveScaling.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Global references for graceful shutdown
let globalMemoryManager = null;
let globalPredictiveScaling = null;
let globalRalphService = null;
let globalLogger = null;
let globalStatusWriter = null;

async function main() {
  // Load configuration first
  const config = loadConfig();

  // Initialize providers
  initializeProviders();

  // Configuration from config file with environment overrides
  const PORT = config.port;
  const PROJECTS_ROOT = getProjectsRoot();
  const DATA_DIR = getDataDir();
  const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || `http://localhost:${PORT + 1}`;

  // Ensure data directory exists
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  // Ensure projects directory exists
  if (!fs.existsSync(PROJECTS_ROOT)) {
    fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
    console.log(`Created projects directory: ${PROJECTS_ROOT}`);
  }

  // Initialize logger
  globalLogger = initLogger({
    minLevel: process.env.LOG_LEVEL === 'debug' ? 0 : 1, // DEBUG=0, INFO=1
    logDir: path.join(DATA_DIR, 'logs')
  });
  const log = globalLogger;

  // Initialize status writer
  globalStatusWriter = getStatusWriter();

  // Log startup lifecycle event
  log.logLifecycle(LifecycleEvent.STARTUP, 'Strategos server starting', {
    nodeVersion: process.version,
    port: PORT,
    projectsRoot: PROJECTS_ROOT,
    dataDir: DATA_DIR
  });

  // Check tmux availability
  const hasTmux = await checkTmux();
  if (!hasTmux) {
    log.fatal('tmux is not installed', {
      hint: 'Ubuntu/Debian: sudo apt install tmux | macOS: brew install tmux'
    });
    process.exit(1);
  }

  log.info('Strategos Orchestrator Server starting');
  log.info('Configuration', { projectsRoot: PROJECTS_ROOT, dataDir: DATA_DIR, port: PORT, clientOrigin: CLIENT_ORIGIN });
  logAuthStatus();

  // Log provider status
  const providersInfo = getProvidersInfo();
  log.info('Providers configured', {
    defaultWorker: providersInfo.workers.default,
    workerProviders: providersInfo.workers.available.map(p => p.id),
    defaultApi: providersInfo.api.default,
    apiProviders: providersInfo.api.available.map(p => p.id)
  });

  // Create Express app
  const app = express();
  const httpServer = createServer(app);

  // Setup Socket.io with stability-focused configuration
  const io = new Server(httpServer, {
    cors: {
      origin: [CLIENT_ORIGIN, /^http:\/\/192\.168\.\d+\.\d+:\d+$/, /^http:\/\/localhost:\d+$/],
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

  // Middleware
  app.use(cors({
    origin: [CLIENT_ORIGIN, /^http:\/\/192\.168\.\d+\.\d+:\d+$/, /^http:\/\/localhost:\d+$/]
  }));
  app.use(express.json());
  app.use(authenticateRequest); // API key authentication (when STRATEGOS_API_KEY is set)

  // Initialize Ralph Service (Autonomous AI Agent Loop)
  const ralphService = createRalphService(io);
  app.locals.ralphService = ralphService;
  globalRalphService = ralphService; // Store for graceful shutdown

  // API routes
  app.use('/api', createRoutes(PROJECTS_ROOT, io));
  app.use('/api/integration', createIntegrationRoutes(PROJECTS_ROOT, io));
  app.use('/api/adrs', createADRRoutes());
  app.use('/api/ralph', createRalphRoutes(ralphService));

  // Serve static client files in production
  const clientDist = path.join(__dirname, '..', 'client', 'dist');
  app.use(express.static(clientDist));

  // Fallback to index.html for SPA routing
  app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) {
      res.sendFile(path.join(clientDist, 'index.html'));
    }
  });

  // Socket.io authentication middleware
  io.use(authenticateSocket);

  // Setup Socket.io handlers
  setupSocketHandlers(io, PROJECTS_ROOT);

  // Restore saved worker state first
  log.info('Restoring saved worker state...');
  await restoreWorkerState(io);

  // Re-register Ralph tokens for restored workers
  const restoredWorkers = getWorkers();
  let ralphCount = 0;
  for (const worker of restoredWorkers) {
    if (worker.ralphMode && worker.ralphToken) {
      ralphService.registerStandaloneWorker(worker.ralphToken, worker.id);
      ralphCount++;
    }
  }
  if (ralphCount > 0) {
    log.info('Re-registered Ralph workers', { count: ralphCount });
  }

  // Discover any additional existing tmux sessions
  log.info('Discovering existing workers...');
  const existingWorkers = await discoverExistingWorkers(io);
  log.info('Worker discovery complete', { found: existingWorkers.length });

  // Start periodic cleanup sweep to prevent resource leaks
  startPeriodicCleanup(io);
  const stats = getResourceStats();
  log.info('Resource limits', {
    running: stats.running,
    max: stats.maxConcurrent,
    available: stats.availableSlots
  });

  // Initialize Foundation Layer components
  log.info('Initializing foundation layer...');
  const errorRecovery = createErrorRecovery();
  const healthMonitor = new HealthMonitor({
    checkInterval: 30000,
    heartbeatTimeout: 60000,
    unhealthyThreshold: 3,
    healthyThreshold: 2
  });

  // Create circuit breakers for critical external services
  const ollamaBreaker = getBreaker('ollama', { failureThreshold: 3, timeout: 15000 });
  const anthropicBreaker = getBreaker('anthropic', { failureThreshold: 5, timeout: 30000 });

  // Initialize Intelligence Layer components
  log.info('Initializing intelligence layer...');

  // Initialize Memory Manager first (needed by ReflexionLoop)
  const memoryDbPath = path.join(DATA_DIR, 'memory.db');
  const memoryManager = new MemoryManager(memoryDbPath, {
    decayRate: 0.995,           // 0.5% decay per hour
    importanceThreshold: 0.1,   // Prune memories below 10% importance
    consolidationInterval: 3600000, // Consolidate every hour
    similarityThreshold: 0.85   // Merge memories >85% similar
  });
  memoryManager.startAutoConsolidation();
  globalMemoryManager = memoryManager; // Store for graceful shutdown

  // Core verification pipeline
  const verificationPipeline = new VerificationPipeline();
  const taskDecomposer = createDecomposer();

  // Scientific Enhancement: ReflexionLoop (NeurIPS 2023)
  // Extends SelfCorrectionLoop with reflection memory for cross-session learning
  // Research: 91% pass rate on HumanEval vs 80% baseline
  const reflexionLoop = new ReflexionLoop(verificationPipeline, memoryManager, {
    maxReflectionsToRetrieve: 3,
    reflectionMinImportance: 0.3,
    storeReflections: true
  });

  // Scientific Enhancement: ConfidenceEstimator (ICLR 2024)
  // Calibrated uncertainty quantification through consistency sampling
  const confidenceEstimator = new ConfidenceEstimator({
    numSamples: 3,
    highThreshold: 0.8,
    lowThreshold: 0.4
  });

  // Scientific Enhancement: EnhancedVerificationPipeline (TACL 2024)
  // Uses external tools for verification - code execution, symbolic math, schema validation
  const enhancedVerificationPipeline = new EnhancedVerificationPipeline({
    enableCodeExecution: true,
    enableSymbolicMath: true,
    enableSchemaValidation: true,
    enableConsistencyCheck: true
  });

  // Keep base SelfCorrectionLoop available for backwards compatibility
  const selfCorrectionLoop = new SelfCorrectionLoop(verificationPipeline);

  // Initialize Coordination Layer components
  log.info('Initializing coordination layer...');
  const stateSync = getStateSync();
  const escalationSystem = new EscalationSystem();

  // Scientific Enhancement: DebateProtocol (ICML 2024)
  // Multi-agent debate for improved factual accuracy - 30% error reduction
  const debateProtocol = new DebateProtocol({
    numAgents: 3,
    numRounds: 3,
    consensusMethod: ConsensusMethod.MAJORITY_VOTE,
    consensusThreshold: 0.7,
    io  // Socket.io for real-time debate updates
  });

  // Note: MultiAgentReview initialized without workerManager - will be set later when available
  // const multiAgentReview = createMultiAgentReview(workerManager);

  // Initialize Services Layer (higher-level integrations)
  log.info('Initializing services...');
  const verificationService = createVerificationService({
    verificationPipeline,
    selfCorrectionLoop: reflexionLoop,  // Use ReflexionLoop (extends SelfCorrectionLoop with memory)
    io
  });

  const selfOptimizeService = createSelfOptimizeService({
    io,
    maxIterations: 5,
    testTimeout: 120000
  });

  // Initialize General Service (CC-DC-DE military command structure)
  const generalService = createGeneralService({
    io,
    verificationService,
    selfOptimizeService
  });
  // Note: workerManager will be set after routes are loaded

  // Initialize Predictive Scaling service
  const predictiveScaling = createPredictiveScaling({
    io,
    // Get worker stats from the workers Map
    getWorkerStats: async () => {
      const allWorkers = getWorkers();
      const running = allWorkers.filter(w => w.status === 'running').length;
      const idle = allWorkers.filter(w => w.status === 'running' && w.health === 'healthy').length;
      const busy = allWorkers.filter(w => w.status === 'running' && w.health === 'active').length;
      return { running, idle, busy, queued: 0 }; // queued can be tracked if we add a task queue
    },
    // Spawn a generic worker
    spawnWorker: async (options) => {
      log.info('[PredictiveScaling] Auto-spawning worker', { reason: options.reason });
      // This is a placeholder - actual spawning requires project context
      // Workers should be spawned through the API with proper project paths
      return null;
    },
    // Terminate an idle worker
    terminateWorker: async (options) => {
      const allWorkers = getWorkers();
      const idleWorker = allWorkers.find(w =>
        w.status === 'running' &&
        w.health === 'healthy' &&
        !w.label.startsWith('GENERAL') // Don't kill generals
      );
      if (idleWorker) {
        log.info('[PredictiveScaling] Terminating idle worker', { workerId: idleWorker.id });
        await killWorker(idleWorker.id, io);
        return idleWorker.id;
      }
      return null;
    },
    // Configuration
    minWorkers: 0,
    maxWorkers: 15,
    targetUtilization: 0.70,
    checkInterval: 60000 // Check every minute
  });
  globalPredictiveScaling = predictiveScaling;
  // Note: predictiveScaling.start() can be called via API when needed

  // Make all layer services available globally for routes/handlers
  app.locals.foundation = {
    errorRecovery,
    healthMonitor,
    circuitBreakers: { ollama: ollamaBreaker, anthropic: anthropicBreaker },
    HealthStatus
  };

  app.locals.intelligence = {
    verificationPipeline,
    enhancedVerificationPipeline,  // Scientific: TACL 2024 external tool verification
    taskDecomposer,
    selfCorrectionLoop,
    reflexionLoop,                  // Scientific: NeurIPS 2023 reflection memory
    confidenceEstimator,            // Scientific: ICLR 2024 calibrated uncertainty
    memoryManager,
    TaskTypes,
    StopReasons,
    MemoryTypes,
    RelationshipTypes,
    ConfidenceLevel,
    REFLECTION_MEMORY_TYPE
  };

  app.locals.coordination = {
    stateSync,
    escalationSystem,
    debateProtocol,                 // Scientific: ICML 2024 multi-agent debate
    createMultiAgentReview, // Factory function for when workerManager is available
    EscalationReasons,
    UrgencyLevels,
    ConsensusMethod,
    DebatePhase
  };

  app.locals.services = {
    verificationService,
    selfOptimizeService,
    generalService,
    predictiveScaling,
    TaskTypes: VerificationTaskTypes,
    CycleState,
    OptimizeStopReasons,
    ScalingState,
    // CC-DC-DE Command Structure exports
    CommandLevel,
    AutonomyLevel,
    DomainType,
    MissionStatus,
    CommandersIntent,
    MissionOrder,
    OODALoop
  };

  log.info('All layers initialized', {
    foundation: ['ErrorRecovery', 'HealthMonitor', 'CircuitBreakers'],
    intelligence: ['VerificationPipeline', 'EnhancedVerificationPipeline', 'TaskDecomposer', 'ReflexionLoop', 'ConfidenceEstimator', 'MemoryManager'],
    coordination: ['StateSync', 'EscalationSystem', 'DebateProtocol', 'MultiAgentReview'],
    services: ['VerificationService', 'SelfOptimizeService', 'GeneralService', 'PredictiveScaling']
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

  // Start server
  httpServer.listen(PORT, '0.0.0.0', () => {
    log.info('Server running', {
      url: `http://0.0.0.0:${PORT}`,
      api: `http://localhost:${PORT}/api`
    });

    // Start status writer after server is listening
    globalStatusWriter.start();
    log.info('Status writer started', {
      statusFile: globalStatusWriter.statusFile
    });
  });
}

// Graceful shutdown - save worker state before exit
async function gracefulShutdown(signal) {
  const log = getLogger();
  log.info(`${signal} received, initiating graceful shutdown...`);

  // Log lifecycle event
  log.logLifecycle(LifecycleEvent.SHUTDOWN, signal);

  // Update status file
  if (globalStatusWriter) {
    globalStatusWriter.shutdown(signal);
  }

  try {
    await saveWorkerState();
    log.info('Worker state saved successfully');
  } catch (err) {
    log.error('Error saving worker state', { error: err.message });
  }

  // Stop memory manager consolidation
  if (globalMemoryManager) {
    globalMemoryManager.stopAutoConsolidation();
    globalMemoryManager.close();
    log.info('Memory manager closed');
  }

  // Stop predictive scaling
  if (globalPredictiveScaling) {
    globalPredictiveScaling.stop();
    log.info('Predictive scaling stopped');
  }

  // Cleanup Ralph service (pause active runs)
  if (globalRalphService) {
    await globalRalphService.cleanup();
    log.info('Ralph service cleaned up');
  }

  // Close logger last
  log.info('Shutdown complete');
  if (globalLogger) {
    globalLogger.close();
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
  if (err.code === 'EPIPE' || err.message?.includes('EPIPE')) {
    console.error = () => {};  // Disable console to prevent more errors
    console.log = () => {};
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
    process.exit(1);
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

    // Update status to show we caught an error but recovered
    if (globalStatusWriter) {
      globalStatusWriter.crash(err);
      // Reset to running since we didn't actually crash
      globalStatusWriter.status = 'running';
    }
  } finally {
    _handlingException = false;
  }

  // Don't exit - try to keep running
});

process.on('unhandledRejection', (reason, promise) => {
  // Prevent cascading
  if (_handlingException) return;
  _handlingException = true;

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

  // Close logger before exit
  if (globalLogger) {
    globalLogger.close();
  }

  process.exit(1);
});
