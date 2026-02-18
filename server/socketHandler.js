import {
  getWorkers,
  getWorkerInternal,
  spawnWorker,
  killWorker,
  updateWorkerLabel,
  updateWorkerSettings,
  sendInput,
  sendRawInput,
  broadcastToProject,
  getActivityLog,
  getWorkerOutput,
  resizeWorkerTerminal,
  completeWorker,
  getPendingWorkers,
  getWorkerDependencies
} from './workerManager.js';

import { sanitizeErrorMessage } from './errorUtils.js';
import { projectExists, safeResolvePath } from './projectScanner.js';
import { getMetricsService, MetricTypes } from './metricsService.js';

import path from 'path';
import os from 'os';

let metricsBroadcastInterval = null;

// Shared validation constants (single source of truth)
import {
  VALID_WORKER_ID, VALID_SIMPLE_ID, CONTROL_CHAR_RE,
  MAX_TASK_LENGTH, MAX_LABEL_LENGTH, MAX_INPUT_LENGTH
} from './validation.js';

// Per-socket rate limiting configuration (events per second)
const RATE_LIMITS = {
  'worker:spawn':       { max: 5,  windowMs: 60000 }, // 5/min
  'worker:kill':        { max: 10, windowMs: 60000 }, // 10/min
  'worker:input':       { max: 30, windowMs: 1000 },  // 30/sec
  'worker:rawInput':    { max: 60, windowMs: 1000 },  // 60/sec (typing)
  'worker:resize':      { max: 5,  windowMs: 1000 },  // 5/sec
  'worker:attach':      { max: 5,  windowMs: 1000 },  // 5/sec
  'worker:complete':    { max: 5,  windowMs: 1000 },  // 5/sec
  'worker:updateLabel': { max: 10, windowMs: 1000 },  // 10/sec
  'worker:settings':    { max: 5,  windowMs: 1000 },  // 5/sec
  'worker:getDependencies': { max: 5, windowMs: 1000 }, // 5/sec
  'workers:getPending': { max: 5,  windowMs: 1000 },  // 5/sec
  'project:broadcast':  { max: 3,  windowMs: 1000 },  // 3/sec
  'metrics:subscribe':  { max: 3,  windowMs: 60000 }, // 3/min
  'metrics:unsubscribe': { max: 3, windowMs: 60000 }, // 3/min
};

/**
 * Create a per-socket rate limiter.
 * Returns a function that checks if an event should be throttled.
 */
function createSocketRateLimiter() {
  const buckets = new Map(); // event -> [timestamps]
  return {
    check(event) {
      const limit = RATE_LIMITS[event];
      if (!limit) return false; // No limit configured — allow
      const now = Date.now();
      let timestamps = buckets.get(event);
      if (!timestamps) {
        timestamps = [];
        buckets.set(event, timestamps);
      }
      // Remove expired timestamps
      while (timestamps.length > 0 && now - timestamps[0] > limit.windowMs) {
        timestamps.shift();
      }
      if (timestamps.length >= limit.max) return true; // Throttled
      timestamps.push(now);
      return false;
    },
    destroy() { buckets.clear(); }
  };
}

export function setupSocketHandlers(io, theaRoot) {
  // Handle server-level socket errors
  io.engine.on('connection_error', (err) => {
    console.error('[Socket.io] Connection error:', {
      code: err.code,
      message: err.message,
      context: err.context
    });
  });

  io.on('connection', (socket) => {
    console.log(`Client connected: ${socket.id}`);

    // Per-socket rate limiter
    const rateLimiter = createSocketRateLimiter();

    // Per-socket middleware: rate-limit all incoming events before they reach handlers
    socket.use(([event, ...args], next) => {
      if (rateLimiter.check(event)) {
        console.warn(`[RateLimit] Socket ${socket.id} throttled on ${event}`);
        return next(new Error('Rate limit exceeded'));
      }
      next();
    });

    // Socket-level error handling
    socket.on('error', (error) => {
      console.error(`[Socket] Error for ${socket.id}:`, error.message || error);
    });

    // Send current state on connect (wrapped to prevent crash on rapid disconnect)
    try {
      socket.emit('workers:list', getWorkers());
      socket.emit('workers:pending', getPendingWorkers());
      socket.emit('activity:list', getActivityLog());

      // Send recent output for all workers so cards show previews
      // Cap at 4KB per worker to avoid flooding the socket on connect
      const workers = getWorkers();
      for (const worker of workers) {
        const output = getWorkerOutput(worker.id);
        if (output) {
          const preview = output.length > 4096 ? output.slice(-4096) : output;
          socket.emit('worker:output', { workerId: worker.id, output: preview });
        }
      }
    } catch (err) {
      console.warn(`[Socket] Failed to send initial state to ${socket.id}:`, err.message);
    }

    // Handle worker spawn (with optional dependencies and context)
    socket.on('worker:spawn', async ({
      projectPath,
      label,
      dependsOn,
      onComplete,
      workflowId,
      taskId,
      // Context passing for worker-to-worker spawning
      task,
      parentWorkerId,
      parentLabel,
      initialInput,
      // Worker settings
      autoAccept,
      ralphMode,
      backend
    }) => {
      try {
        // SECURITY: Safely resolve project path with traversal prevention
        const resolvedPath = safeResolvePath(projectPath, theaRoot);
        if (!resolvedPath) {
          socket.emit('error', {
            message: 'Invalid project path - path traversal not allowed'
          });
          return;
        }

        if (!projectExists(resolvedPath)) {
          socket.emit('error', {
            message: 'Project path does not exist'
          });
          return;
        }

        // Validate spawn inputs
        if (label !== undefined) {
          if (typeof label !== 'string' || label.length > MAX_LABEL_LENGTH) {
            socket.emit('error', { message: 'Invalid or too-long label' });
            return;
          }
          if (CONTROL_CHAR_RE.test(label)) {
            socket.emit('error', { message: 'label must not contain control characters' });
            return;
          }
        }
        if (initialInput !== undefined && (typeof initialInput !== 'string' || initialInput.length > MAX_INPUT_LENGTH)) {
          socket.emit('error', { message: 'Initial input too large or invalid' });
          return;
        }
        if (dependsOn !== undefined) {
          if (!Array.isArray(dependsOn) || dependsOn.length > 50) {
            socket.emit('error', { message: 'dependsOn must be an array with at most 50 entries' });
            return;
          }
          if (!dependsOn.every(id => typeof id === 'string' && /^[a-zA-Z0-9-]{1,36}$/.test(id))) {
            socket.emit('error', { message: 'dependsOn entries must be valid worker IDs' });
            return;
          }
        }

        // Validate pass-through spawn fields (defense-in-depth: strip invalid, don't reject)
        const validTask = (task !== undefined && task !== null) ?
          (typeof task === 'string' && task.length <= MAX_TASK_LENGTH && !CONTROL_CHAR_RE.test(task) ? task : undefined) : undefined;
        const validWorkflowId = (workflowId !== undefined && workflowId !== null) ?
          (typeof workflowId === 'string' && workflowId.length <= 100 && VALID_SIMPLE_ID.test(workflowId) ? workflowId : undefined) : undefined;
        const validTaskId = (taskId !== undefined && taskId !== null) ?
          (typeof taskId === 'string' && taskId.length <= 100 && VALID_SIMPLE_ID.test(taskId) ? taskId : undefined) : undefined;
        const validParentWorkerId = (parentWorkerId !== undefined && parentWorkerId !== null) ?
          (typeof parentWorkerId === 'string' && VALID_WORKER_ID.test(parentWorkerId) ? parentWorkerId : undefined) : undefined;
        const validParentLabel = (parentLabel !== undefined && parentLabel !== null) ?
          (typeof parentLabel === 'string' && parentLabel.length <= MAX_LABEL_LENGTH && !CONTROL_CHAR_RE.test(parentLabel) ? parentLabel : undefined) : undefined;
        // Validate onComplete: type must be one of the known action types,
        // and total JSON size capped to prevent memory abuse via deeply nested config
        const VALID_ONCOMPLETE_TYPES = ['spawn', 'webhook', 'emit'];
        const MAX_ONCOMPLETE_SIZE = 10000; // 10KB
        const validOnComplete = (() => {
          if (onComplete === undefined || onComplete === null) return undefined;
          if (typeof onComplete !== 'object' || Array.isArray(onComplete)) return undefined;
          if (typeof onComplete.type !== 'string' || !VALID_ONCOMPLETE_TYPES.includes(onComplete.type)) return undefined;
          try {
            if (JSON.stringify(onComplete).length > MAX_ONCOMPLETE_SIZE) return undefined;
          } catch { return undefined; }
          return { type: onComplete.type, config: onComplete.config || {} };
        })();

        // Build options object
        const options = {};
        if (dependsOn) options.dependsOn = dependsOn;
        if (validOnComplete) options.onComplete = validOnComplete;
        if (validWorkflowId) options.workflowId = validWorkflowId;
        if (validTaskId) options.taskId = validTaskId;
        // Context passing options
        if (validTask) options.task = validTask;
        if (validParentWorkerId) options.parentWorkerId = validParentWorkerId;
        if (validParentLabel) options.parentLabel = validParentLabel;
        if (initialInput) options.initialInput = initialInput;
        // Default autoAccept and ralphMode to TRUE for all spawns (match routes.js)
        options.autoAccept = autoAccept !== false; // true unless explicitly false
        options.ralphMode = ralphMode !== false;   // true unless explicitly false
        // Backend selection: 'claude' (default) or 'gemini'
        if (backend === 'gemini') options.backend = 'gemini';

        const worker = await spawnWorker(resolvedPath, label, io, options);

        // If Ralph mode enabled, register with ralphService (match routes.js behavior)
        if (worker.ralphMode && worker.ralphToken) {
          const ralphService = socket.server?.app?.locals?.ralphService;
          if (ralphService) {
            ralphService.registerStandaloneWorker(worker.ralphToken, worker.id);
          }
        }

      } catch (error) {
        socket.emit('error', { message: sanitizeErrorMessage(error) });
      }
    });

    // Handle worker kill
    // GENERAL PROTECTION: UI kill requests pass through force flag from confirmation dialog
    socket.on('worker:kill', async ({ workerId, force }) => {
      if (typeof workerId !== 'string' || !workerId) {
        return socket.emit('error', { message: 'Invalid workerId' });
      }
      // S-3: Validate force is boolean (prevent type confusion)
      if (force !== undefined && typeof force !== 'boolean') {
        return socket.emit('error', { message: 'force must be a boolean' });
      }
      console.log(`[Socket] Received worker:kill for ${workerId} (force: ${!!force})`);
      try {
        await killWorker(workerId, io, { force: !!force });
        console.log(`[Socket] Worker ${workerId} killed successfully`);
      } catch (error) {
        console.error(`[Socket] Failed to kill worker ${workerId}:`, error.message);
        socket.emit('error', { message: sanitizeErrorMessage(error), workerId });
      }
    });

    // Handle worker input (line-based, adds Enter)
    socket.on('worker:input', async ({ workerId, input }) => {
      try {
        if (typeof workerId !== 'string' || !workerId) {
          return socket.emit('error', { message: 'Invalid workerId' });
        }
        if (typeof input !== 'string' || input.length > MAX_INPUT_LENGTH) {
          return socket.emit('error', { message: 'Input too large or invalid', workerId });
        }
        await sendInput(workerId, input);
      } catch (error) {
        socket.emit('error', { message: sanitizeErrorMessage(error), workerId });
      }
    });

    // Handle raw worker input (for arrow keys, escape sequences, etc.)
    socket.on('worker:rawInput', async ({ workerId, keys }) => {
      try {
        if (typeof workerId !== 'string' || !workerId) {
          return socket.emit('error', { message: 'Invalid workerId' });
        }
        if (typeof keys !== 'string' || keys.length > MAX_INPUT_LENGTH) {
          return socket.emit('error', { message: 'Keys too large or invalid', workerId });
        }
        await sendRawInput(workerId, keys);
      } catch (error) {
        socket.emit('error', { message: sanitizeErrorMessage(error), workerId });
      }
    });

    // Handle worker label update
    socket.on('worker:updateLabel', ({ workerId, label }) => {
      try {
        if (typeof workerId !== 'string' || !workerId) {
          return socket.emit('error', { message: 'Invalid workerId' });
        }
        if (typeof label !== 'string' || label.length > MAX_LABEL_LENGTH) {
          return socket.emit('error', { message: 'Label too long or invalid', workerId });
        }
        if (CONTROL_CHAR_RE.test(label)) {
          return socket.emit('error', { message: 'label must not contain control characters', workerId });
        }
        updateWorkerLabel(workerId, label, io);
      } catch (error) {
        socket.emit('error', { message: sanitizeErrorMessage(error), workerId });
      }
    });

    // Handle worker settings update (autoAccept, ralphMode, etc.)
    socket.on('worker:settings', async ({ workerId, settings }) => {
      if (typeof workerId !== 'string' || !workerId) {
        return socket.emit('error', { message: 'Invalid workerId' });
      }
      if (!settings || typeof settings !== 'object') {
        return socket.emit('error', { message: 'Invalid settings', workerId });
      }
      try {
        // Get worker before update to check previous Ralph state (internal — needs ralphToken)
        const workerBefore = getWorkerInternal(workerId);
        const wasRalphEnabled = workerBefore?.ralphMode;
        const previousToken = workerBefore?.ralphToken;

        // Update worker settings
        const worker = updateWorkerSettings(workerId, settings, io);

        // Handle Ralph mode changes
        if (settings.ralphMode !== undefined) {
          const ralphService = socket.server?.app?.locals?.ralphService;

          if (settings.ralphMode && !wasRalphEnabled) {
            // Ralph mode just enabled - register and send instructions
            if (ralphService && worker.ralphToken) {
              ralphService.registerStandaloneWorker(worker.ralphToken, workerId);

              // Send Ralph instructions to the worker
              const instructions = `

=== RALPH MODE ENABLED ===
When you complete your current task, signal completion by running:

curl -X POST http://localhost:38007/api/ralph/signal/${worker.ralphToken} -H "Content-Type: application/json" -d '{"status":"done"}'

If blocked, signal:
curl -X POST http://localhost:38007/api/ralph/signal/${worker.ralphToken} -H "Content-Type: application/json" -d '{"status":"blocked","reason":"brief description"}'
===========================

`;
              await sendInput(workerId, instructions);
            }
          } else if (!settings.ralphMode && wasRalphEnabled) {
            // Ralph mode just disabled - unregister
            if (ralphService && previousToken) {
              ralphService.unregisterStandaloneWorker(previousToken);
            }
          }
        }
      } catch (error) {
        socket.emit('error', { message: sanitizeErrorMessage(error), workerId });
      }
    });

    // Handle project broadcast
    socket.on('project:broadcast', async ({ projectName, input }) => {
      try {
        if (typeof input !== 'string' || input.length > MAX_INPUT_LENGTH) {
          return socket.emit('error', { message: 'Broadcast input too large or invalid' });
        }
        if (typeof projectName !== 'string' || projectName.length > MAX_LABEL_LENGTH) {
          return socket.emit('error', { message: 'Invalid project name' });
        }
        if (CONTROL_CHAR_RE.test(projectName)) {
          return socket.emit('error', { message: 'projectName must not contain control characters' });
        }
        await broadcastToProject(projectName, input);
      } catch (error) {
        socket.emit('error', { message: sanitizeErrorMessage(error) });
      }
    });

    // Handle attach to worker (request full output + subscribe to updates)
    socket.on('worker:attach', ({ workerId }) => {
      if (typeof workerId !== 'string' || !workerId) {
        return socket.emit('error', { message: 'Invalid workerId' });
      }
      try {
        const output = getWorkerOutput(workerId);
        socket.emit('worker:output', { workerId, output });
        // Auto-subscribe to output updates for this worker
        socket.join(`worker:${workerId}`);
      } catch (error) {
        socket.emit('error', { message: sanitizeErrorMessage(error), workerId });
      }
    });

    // Handle output subscription (join room for worker output updates)
    socket.on('worker:output:subscribe', ({ workerId }) => {
      if (typeof workerId !== 'string' || !workerId) return;
      socket.join(`worker:${workerId}`);
    });

    // Handle output unsubscription (leave room)
    socket.on('worker:output:unsubscribe', ({ workerId }) => {
      if (typeof workerId !== 'string' || !workerId) return;
      socket.leave(`worker:${workerId}`);
    });

    // Handle terminal resize
    socket.on('worker:resize', async ({ workerId, cols, rows }) => {
      if (typeof workerId !== 'string' || !workerId) {
        return socket.emit('error', { message: 'Invalid workerId' });
      }
      if (typeof cols !== 'number' || typeof rows !== 'number' || cols < 1 || rows < 1 || cols > 1000 || rows > 500) {
        return socket.emit('error', { message: 'Invalid resize dimensions', workerId });
      }
      try {
        await resizeWorkerTerminal(workerId, cols, rows, io);
      } catch (error) {
        console.error('Resize error:', error.message);
        socket.emit('error', { message: 'Resize failed', workerId });
      }
    });

    // Handle worker complete (mark as completed, trigger dependents)
    socket.on('worker:complete', async ({ workerId }) => {
      if (typeof workerId !== 'string' || !workerId) {
        return socket.emit('error', { message: 'Invalid workerId' });
      }
      try {
        await completeWorker(workerId, io);
      } catch (error) {
        socket.emit('error', { message: sanitizeErrorMessage(error), workerId });
      }
    });

    // Handle get dependencies for a worker
    socket.on('worker:getDependencies', ({ workerId }) => {
      if (typeof workerId !== 'string' || !workerId) {
        return socket.emit('error', { message: 'Invalid workerId' });
      }
      try {
        const deps = getWorkerDependencies(workerId);
        socket.emit('worker:dependencies', { workerId, dependencies: deps });
      } catch (error) {
        socket.emit('error', { message: sanitizeErrorMessage(error), workerId });
      }
    });

    // Handle get pending workers
    socket.on('workers:getPending', () => {
      try {
        const pending = getPendingWorkers();
        socket.emit('workers:pending', pending);
      } catch (error) {
        socket.emit('error', { message: sanitizeErrorMessage(error) });
      }
    });

    // Handle metrics subscription (using Socket.io rooms)
    socket.on('metrics:subscribe', () => {
      console.log(`[Socket] Client ${socket.id} subscribed to metrics`);
      socket.join('metrics');

      // Send immediate metrics update to the subscribing client
      try {
        const metricsData = getSystemMetricsData();
        socket.emit('metrics:update', metricsData);
      } catch (error) {
        console.error('[Socket] Error sending initial metrics:', error.message);
      }

      // Start broadcast interval if not running
      try {
        if (!metricsBroadcastInterval) {
          startMetricsBroadcast(io);
        }
      } catch (error) {
        console.error('[Socket] Error starting metrics broadcast:', error.message);
      }
    });

    // Handle metrics unsubscription (using Socket.io rooms)
    socket.on('metrics:unsubscribe', () => {
      try {
        console.log(`[Socket] Client ${socket.id} unsubscribed from metrics`);
        socket.leave('metrics');

        // Stop broadcast interval if no more subscribers
        const room = io.sockets.adapter.rooms.get('metrics');
        if ((!room || room.size === 0) && metricsBroadcastInterval) {
          clearInterval(metricsBroadcastInterval);
          metricsBroadcastInterval = null;
          console.log('[Socket] Metrics broadcast stopped - no subscribers');
        }
      } catch (error) {
        console.error('[Socket] Error in metrics:unsubscribe:', error.message);
      }
    });

    // Handle disconnect with reason logging
    socket.on('disconnect', (reason) => {
      try {
        console.log(`Client disconnected: ${socket.id}, reason: ${reason}`);
        // Clean up rate limiter to prevent memory leak
        rateLimiter.destroy();

        // Socket.io automatically removes socket from rooms on disconnect.
        // Stop broadcast if metrics room is now empty.
        const room = io.sockets.adapter.rooms.get('metrics');
        if ((!room || room.size === 0) && metricsBroadcastInterval) {
          clearInterval(metricsBroadcastInterval);
          metricsBroadcastInterval = null;
          console.log('[Socket] Metrics broadcast stopped - no subscribers');
        }

        // Log specific disconnect reasons for debugging
        if (reason === 'ping timeout') {
          console.warn(`[Socket] Client ${socket.id} disconnected due to ping timeout - possible network issue`);
        } else if (reason === 'transport close') {
          console.warn(`[Socket] Client ${socket.id} transport closed unexpectedly`);
        } else if (reason === 'transport error') {
          console.error(`[Socket] Client ${socket.id} transport error`);
        }
      } catch (error) {
        console.error('[Socket] Error in disconnect handler:', error.message);
      }
    });

  });
}

// Helper function to get system metrics data
function getSystemMetricsData() {
  const metricsService = getMetricsService();
  const workers = getWorkers();
  const startTime = new Date(Date.now() - 60 * 60000).toISOString(); // Last 60 minutes

  // Get summaries for key metrics
  const spawnTimeSummary = metricsService.getSummary(MetricTypes.WORKER_SPAWN_TIME, startTime);

  // Count active workers
  const activeWorkers = workers.filter(w => w.status === 'running').length;

  // Total spawns
  const totalSpawns = spawnTimeSummary.count || 0;

  // Average spawn time
  const avgSpawnTime = spawnTimeSummary.avg || 0;

  // Determine health status
  let healthStatus = 'healthy';
  if (avgSpawnTime > 5000) {
    healthStatus = 'warning';
  }

  // Get realtime data (last 50 entries per type)
  const realtimeData = {};
  for (const [key, type] of Object.entries(MetricTypes)) {
    const metrics = metricsService.getRealtime(type);
    realtimeData[type] = metrics.slice(-50).map(m => ({
      value: m.value,
      timestamp: m.timestamp,
      labels: m.labels
    }));
  }

  // Memory and uptime (parity with HTTP /api/metrics/system)
  const memUsage = process.memoryUsage();
  const totalMem = os.totalmem();
  const memoryUsage = Math.round((memUsage.heapUsed / totalMem) * 100 * 100) / 100;

  return {
    system: {
      activeWorkers,
      totalSpawns,
      avgSpawnTime: Math.round(avgSpawnTime),
      errorRate: 0,
      errorCount: 0,
      healthStatus,
      memoryUsage,
      uptime: Math.round(process.uptime())
    },
    realtime: realtimeData,
    timestamp: new Date().toISOString()
  };
}

// Start periodic metrics broadcast using Socket.io rooms
function startMetricsBroadcast(io) {
  console.log('[Socket] Starting metrics broadcast (every 5 seconds)');

  metricsBroadcastInterval = setInterval(() => {
    const room = io.sockets.adapter.rooms.get('metrics');
    if (!room || room.size === 0) return;

    try {
      const metricsData = getSystemMetricsData();
      io.to('metrics').emit('metrics:update', metricsData);
    } catch (error) {
      console.error('[Socket] Error broadcasting metrics:', error.message);
    }
  }, 5000);

  if (metricsBroadcastInterval.unref) {
    metricsBroadcastInterval.unref();
  }
}

/**
 * Stop the metrics broadcast interval (for graceful shutdown)
 */
export function stopMetricsBroadcast() {
  if (metricsBroadcastInterval) {
    clearInterval(metricsBroadcastInterval);
    metricsBroadcastInterval = null;
    console.log('[Socket] Metrics broadcast stopped');
  }
}
