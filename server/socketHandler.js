import {
  getWorkers,
  getWorker,
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
import { projectExists, safeResolvePath } from './projectScanner.js';
import { getMetricsService, MetricTypes } from './metricsService.js';
import { listPrds, listRuns, getActiveRunsList } from './ralphDb.js';
import path from 'path';

// Track sockets subscribed to metrics updates
const metricsSubscribers = new Set();
let metricsBroadcastInterval = null;

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

    // Socket-level error handling
    socket.on('error', (error) => {
      console.error(`[Socket] Error for ${socket.id}:`, error.message || error);
    });

    // Send current state on connect
    socket.emit('workers:list', getWorkers());
    socket.emit('workers:pending', getPendingWorkers());
    socket.emit('activity:list', getActivityLog());

    // Send current output for all workers so cards show previews
    const workers = getWorkers();
    for (const worker of workers) {
      const output = getWorkerOutput(worker.id);
      if (output) {
        socket.emit('worker:output', { workerId: worker.id, output });
      }
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
      ralphMode
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
            message: `Project path does not exist: ${resolvedPath}`
          });
          return;
        }

        // Build options object
        const options = {};
        if (dependsOn) options.dependsOn = dependsOn;
        if (onComplete) options.onComplete = onComplete;
        if (workflowId) options.workflowId = workflowId;
        if (taskId) options.taskId = taskId;
        // Context passing options
        if (task) options.task = task;
        if (parentWorkerId) options.parentWorkerId = parentWorkerId;
        if (parentLabel) options.parentLabel = parentLabel;
        if (initialInput) options.initialInput = initialInput;
        // Worker settings (undefined means use defaults based on worker type)
        if (autoAccept !== undefined) options.autoAccept = autoAccept;
        if (ralphMode !== undefined) options.ralphMode = ralphMode;

        const worker = await spawnWorker(resolvedPath, label, io, options);
        // Confirm successful spawn to requesting client
        socket.emit('worker:spawn:success', {
          workerId: worker?.id,
          label: worker?.label || label
        });
      } catch (error) {
        socket.emit('error', { message: error.message });
      }
    });

    // Handle worker kill
    socket.on('worker:kill', async ({ workerId }) => {
      console.log(`[Socket] Received worker:kill for ${workerId}`);
      try {
        await killWorker(workerId, io);
        console.log(`[Socket] Worker ${workerId} killed successfully`);
      } catch (error) {
        console.error(`[Socket] Failed to kill worker ${workerId}:`, error.message);
        socket.emit('error', { message: error.message, workerId });
      }
    });

    // Handle worker input (line-based, adds Enter)
    socket.on('worker:input', async ({ workerId, input }) => {
      try {
        await sendInput(workerId, input);
      } catch (error) {
        socket.emit('error', { message: error.message, workerId });
      }
    });

    // Handle raw worker input (for arrow keys, escape sequences, etc.)
    socket.on('worker:rawInput', async ({ workerId, keys }) => {
      try {
        await sendRawInput(workerId, keys);
      } catch (error) {
        socket.emit('error', { message: error.message, workerId });
      }
    });

    // Handle worker label update
    socket.on('worker:updateLabel', ({ workerId, label }) => {
      try {
        updateWorkerLabel(workerId, label, io);
      } catch (error) {
        socket.emit('error', { message: error.message, workerId });
      }
    });

    // Handle worker settings update (autoAccept, ralphMode, etc.)
    socket.on('worker:settings', async ({ workerId, settings }) => {
      try {
        // Get worker before update to check previous Ralph state
        const workerBefore = getWorker(workerId);
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
        socket.emit('error', { message: error.message, workerId });
      }
    });

    // Handle project broadcast
    socket.on('project:broadcast', async ({ projectName, input }) => {
      try {
        await broadcastToProject(projectName, input);
      } catch (error) {
        socket.emit('error', { message: error.message });
      }
    });

    // Handle attach to worker (request full output)
    socket.on('worker:attach', ({ workerId }) => {
      const output = getWorkerOutput(workerId);
      socket.emit('worker:output', { workerId, output });
    });

    // Handle terminal resize
    socket.on('worker:resize', async ({ workerId, cols, rows }) => {
      try {
        await resizeWorkerTerminal(workerId, cols, rows, io);
      } catch (error) {
        console.error('Resize error:', error.message);
      }
    });

    // Handle worker complete (mark as completed, trigger dependents)
    socket.on('worker:complete', async ({ workerId }) => {
      try {
        const result = await completeWorker(workerId, io);
        socket.emit('worker:complete:result', {
          success: true,
          workerId,
          triggeredWorkers: result.triggeredWorkers.map(w => w.id)
        });
      } catch (error) {
        socket.emit('error', { message: error.message, workerId });
      }
    });

    // Handle get dependencies for a worker
    socket.on('worker:getDependencies', ({ workerId }) => {
      try {
        const deps = getWorkerDependencies(workerId);
        socket.emit('worker:dependencies', { workerId, dependencies: deps });
      } catch (error) {
        socket.emit('error', { message: error.message, workerId });
      }
    });

    // Handle get pending workers
    socket.on('workers:getPending', () => {
      try {
        const pending = getPendingWorkers();
        socket.emit('workers:pending', pending);
      } catch (error) {
        socket.emit('error', { message: error.message });
      }
    });

    // =====================
    // Ralph Event Handlers
    // =====================

    // Send initial Ralph state on connect
    try {
      socket.emit('ralph:prds:list', listPrds());
      socket.emit('ralph:runs:list', listRuns());
    } catch (err) {
      console.error('[Socket] Error sending initial Ralph state:', err.message);
    }

    // Handle Ralph run start
    socket.on('ralph:startRun', async ({ prdId, maxIterations }) => {
      try {
        const ralphService = socket.server?.app?.locals?.ralphService;
        if (!ralphService) {
          socket.emit('error', { message: 'Ralph service not available' });
          return;
        }
        const run = await ralphService.startRun(prdId, maxIterations);
        socket.emit('ralph:run:started:ack', { runId: run.id });
      } catch (error) {
        socket.emit('error', { message: error.message });
      }
    });

    // Handle Ralph run pause
    socket.on('ralph:pauseRun', ({ runId }) => {
      try {
        const ralphService = socket.server?.app?.locals?.ralphService;
        if (!ralphService) {
          socket.emit('error', { message: 'Ralph service not available' });
          return;
        }
        ralphService.pauseRun(runId);
      } catch (error) {
        socket.emit('error', { message: error.message });
      }
    });

    // Handle Ralph run resume
    socket.on('ralph:resumeRun', async ({ runId }) => {
      try {
        const ralphService = socket.server?.app?.locals?.ralphService;
        if (!ralphService) {
          socket.emit('error', { message: 'Ralph service not available' });
          return;
        }
        await ralphService.resumeRun(runId);
      } catch (error) {
        socket.emit('error', { message: error.message });
      }
    });

    // Handle Ralph run cancel
    socket.on('ralph:cancelRun', async ({ runId }) => {
      try {
        const ralphService = socket.server?.app?.locals?.ralphService;
        if (!ralphService) {
          socket.emit('error', { message: 'Ralph service not available' });
          return;
        }
        await ralphService.cancelRun(runId);
      } catch (error) {
        socket.emit('error', { message: error.message });
      }
    });

    // Handle Ralph PRDs refresh request
    socket.on('ralph:prds:refresh', () => {
      try {
        socket.emit('ralph:prds:list', listPrds());
      } catch (error) {
        socket.emit('error', { message: error.message });
      }
    });

    // Handle Ralph runs refresh request
    socket.on('ralph:runs:refresh', () => {
      try {
        socket.emit('ralph:runs:list', listRuns());
      } catch (error) {
        socket.emit('error', { message: error.message });
      }
    });

    // Handle metrics subscription
    socket.on('metrics:subscribe', () => {
      console.log(`[Socket] Client ${socket.id} subscribed to metrics`);
      metricsSubscribers.add(socket.id);

      // Send immediate metrics update to the subscribing client
      try {
        const metricsData = getSystemMetricsData();
        socket.emit('metrics:update', metricsData);
      } catch (error) {
        console.error('[Socket] Error sending initial metrics:', error.message);
      }

      // Start broadcast interval if not running and we have subscribers
      if (!metricsBroadcastInterval && metricsSubscribers.size > 0) {
        startMetricsBroadcast(io);
      }
    });

    // Handle metrics unsubscription
    socket.on('metrics:unsubscribe', () => {
      console.log(`[Socket] Client ${socket.id} unsubscribed from metrics`);
      metricsSubscribers.delete(socket.id);

      // Stop broadcast interval if no more subscribers
      if (metricsSubscribers.size === 0 && metricsBroadcastInterval) {
        clearInterval(metricsBroadcastInterval);
        metricsBroadcastInterval = null;
        console.log('[Socket] Metrics broadcast stopped - no subscribers');
      }
    });

    // Handle disconnect with reason logging
    socket.on('disconnect', (reason) => {
      console.log(`Client disconnected: ${socket.id}, reason: ${reason}`);
      // Clean up metrics subscription on disconnect
      metricsSubscribers.delete(socket.id);

      // Stop broadcast if no more subscribers
      if (metricsSubscribers.size === 0 && metricsBroadcastInterval) {
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
    });

    // Handle reconnection attempts
    socket.on('reconnect_attempt', (attemptNumber) => {
      console.log(`[Socket] Client ${socket.id} reconnection attempt ${attemptNumber}`);
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
  const errorSummary = metricsService.getSummary(MetricTypes.ERROR_COUNT, startTime);
  const apiResponseSummary = metricsService.getSummary(MetricTypes.API_RESPONSE_TIME, startTime);

  // Count active workers
  const activeWorkers = workers.filter(w => w.status === 'running').length;

  // Total spawns
  const totalSpawns = spawnTimeSummary.count || 0;

  // Average spawn time
  const avgSpawnTime = spawnTimeSummary.avg || 0;

  // Calculate error rate
  const totalOperations = (spawnTimeSummary.count || 0) + (apiResponseSummary.count || 0);
  const errorCount = errorSummary.sum || 0;
  const errorRate = totalOperations > 0 ? (errorCount / totalOperations) * 100 : 0;

  // Determine health status
  let healthStatus = 'healthy';
  if (errorRate > 10) {
    healthStatus = 'critical';
  } else if (errorRate > 5) {
    healthStatus = 'degraded';
  } else if (avgSpawnTime > 5000) {
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

  return {
    system: {
      activeWorkers,
      totalSpawns,
      avgSpawnTime: Math.round(avgSpawnTime),
      errorRate: parseFloat(errorRate.toFixed(2)),
      errorCount: Math.round(errorCount),
      healthStatus
    },
    realtime: realtimeData,
    timestamp: new Date().toISOString()
  };
}

// Start periodic metrics broadcast to subscribed clients
function startMetricsBroadcast(io) {
  console.log('[Socket] Starting metrics broadcast (every 5 seconds)');

  metricsBroadcastInterval = setInterval(() => {
    if (metricsSubscribers.size === 0) {
      return;
    }

    try {
      const metricsData = getSystemMetricsData();

      // Emit to all subscribed sockets
      for (const socketId of metricsSubscribers) {
        const socket = io.sockets.sockets.get(socketId);
        if (socket) {
          socket.emit('metrics:update', metricsData);
        } else {
          // Socket no longer connected, remove from subscribers
          metricsSubscribers.delete(socketId);
        }
      }
    } catch (error) {
      console.error('[Socket] Error broadcasting metrics:', error.message);
    }
  }, 5000); // Every 5 seconds

  // Allow Node.js to exit even if interval is running
  if (metricsBroadcastInterval.unref) {
    metricsBroadcastInterval.unref();
  }
}
