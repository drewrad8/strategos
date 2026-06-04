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
import { isContextLessInput } from './workers/inputGuard.js';

import { sanitizeErrorMessage } from './errorUtils.js';
import { projectExists, safeResolvePath } from './projectScanner.js';
import { getMetricsService, MetricTypes } from './metricsService.js';

import path from 'path';
import os from 'os';
import { getLogger } from './logger.js';

let metricsBroadcastInterval = null;

// Shared validation constants (single source of truth)
import {
  VALID_WORKER_ID, CONTROL_CHAR_RE, MULTILINE_CONTROL_CHAR_RE,
  MAX_TASK_LENGTH, MAX_LABEL_LENGTH, MAX_INPUT_LENGTH,
  validateDependsOn, validateSpawnInput, buildSpawnOptions,
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

/**
 * ORPHANED SERVER EVENTS (emitted but no client handler as of R50 audit, 2026-04-05)
 * These events are emitted for observability and available for future client toast handlers.
 * See research/50-socket-realtime-audit.md §1.2 and recommendation R1 for details.
 *
 * Health events (server/workers/health.js):
 *   worker:general:stalled          — GENERAL or COLONEL worker has stalled (handled: OrchestratorContext toast)
 *   worker:auto-killed:stall        — Worker auto-killed for stalling
 *   worker:auto-killed:completion   — Worker auto-killed after completion timeout
 *   worker:completion-nudge         — Worker nudged toward completion
 *   worker:signal-overdue           — Ralph signal overdue warning
 *   worker:colonel:max-lifetime     — Colonel exceeded max lifetime
 *   worker:age:warning              — Worker age warning
 *   system:resource:critical        — System resource threshold exceeded
 *
 * Ralph events (server/workers/ralph.js):
 *   worker:auto-dismissed           — Worker auto-dismissed after Ralph done signal
 *
 * Output events (server/workers/output.js):
 *   worker:general:dead             — GENERAL tmux session died or crashed (handled: OrchestratorContext toast)
 *   worker:colonel:dead             — COLONEL tmux session died or crashed (handled: OrchestratorContext toast)
 *   worker:role:violation           — GENERAL worker detected coding (role guard)
 *   worker:rate_limited             — Worker output rate-limited
 *   worker:autocontinue             — Auto-continue triggered
 *   worker:autocontinue:exhausted   — Auto-continue limit reached
 *   worker:session-recovery-exhausted — Session recovery failed after all retries
 *   worker:session-recovered        — Session recovered after failure
 *
 * Lifecycle events (server/workers/lifecycle.js):
 *   worker:dependencies_satisfied   — All dependencies met, worker unblocked
 *
 * System events (server/index.js):
 *   sentinel:status                 — Watchdog sentinel status update
 *
 * Retest events (server/services/retestService.js):
 *   retest:started, retest:completed, retest:spec:started,
 *   retest:spec:completed, retest:cancelled
 */

export function setupSocketHandlers(io, theaRoot) {
  // Handle server-level socket errors
  io.engine.on('connection_error', (err) => {
    getLogger().error('[socket.handler] Connection error', { event: 'connection_error', code: err.code, err: err.message, context: err.context });
  });

  io.on('connection', (socket) => {
    getLogger().info('[socket.handler] Client connected', { socketId: socket.id });

    // Per-socket rate limiter
    const rateLimiter = createSocketRateLimiter();

    // Per-socket worker association: tracks which worker rooms this socket has
    // explicitly joined. Mutation events (kill, input, settings, etc.) require
    // the socket to have joined the target worker's room first.
    const joinedWorkers = new Set();

    // Per-socket rawInput line buffers: workerId -> accumulated chars awaiting newline.
    // Used to detect complete lines before applying the context-less input guard.
    const rawInputLineBuffers = new Map();

    // Per-socket middleware: rate-limit all incoming events before they reach handlers
    socket.use(([event, ...args], next) => {
      if (rateLimiter.check(event)) {
        getLogger().warn('[socket.handler] Socket rate limited', { socketId: socket.id, event });
        return next(new Error('Rate limit exceeded'));
      }
      next();
    });

    // Socket-level error handling
    socket.on('error', (error) => {
      getLogger().error('[socket.handler] Socket error', { socketId: socket.id, err: error.message || String(error) });
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
        // Auto-join worker room and register ownership so the socket can
        // immediately mutate any existing worker (single-user UI behavior)
        socket.join(`worker:${worker.id}`);
        joinedWorkers.add(worker.id);

        const output = getWorkerOutput(worker.id);
        if (output) {
          const preview = output.length > 4096 ? output.slice(-4096) : output;
          socket.emit('worker:output', { workerId: worker.id, output: preview });
        }
      }
    } catch (err) {
      getLogger().warn('[socket.handler] Failed to send initial state', { socketId: socket.id, err: err.message });
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
      backend,
      model,
      effortLevel
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
        // Shared dependsOn validation — unified on VALID_WORKER_ID (was a loose
        // /^[a-zA-Z0-9-]{1,36}$/ here, which had DIVERGED from the REST path).
        const depCheck = validateDependsOn(dependsOn);
        if (!depCheck.ok) {
          socket.emit('error', { message: depCheck.error });
          return;
        }

        // Shared spawn sub-field validation (onComplete + id pass-through fields)
        const shared = validateSpawnInput({ onComplete, workflowId, taskId, parentWorkerId, parentLabel });
        const validParentWorkerId = shared.parentWorkerId;
        // Socket-specific: task is string-only here (REST also accepts an object
        // task — intentionally NOT unified to preserve socket behavior).
        const validTask = (task !== undefined && task !== null) ?
          (typeof task === 'string' && task.length <= MAX_TASK_LENGTH && !MULTILINE_CONTROL_CHAR_RE.test(task) ? task : undefined) : undefined;
        // Validate model name (defense-in-depth: strip invalid, match routes.js pattern)
        const validModel = (model !== undefined && typeof model === 'string' && model.length <= 100 && /^[a-zA-Z0-9._:/-]+$/.test(model)) ? model : undefined;
        const validEfforts = ['low', 'medium', 'high', 'max'];
        const validEffortLevel = (effortLevel !== undefined && validEfforts.includes(effortLevel))
          ? effortLevel : undefined;

        // Build options object — common assembly shared via buildSpawnOptions;
        // backend/model/effortLevel layered on below (socket-specific).
        const options = buildSpawnOptions({
          dependsOn,
          onComplete: shared.onComplete,
          workflowId: shared.workflowId,
          taskId: shared.taskId,
          task: validTask,
          parentWorkerId: validParentWorkerId,
          parentLabel: shared.parentLabel,
          initialInput,
          autoAccept,
          ralphMode,
        });
        // Backend selection: explicit > parent inheritance > 'claude' default
        if (backend === 'gemini' || backend === 'aider') {
          options.backend = backend;
          if (backend === 'aider' && validModel) options.model = validModel;
        } else if (!backend && validParentWorkerId) {
          const parentWorker = getWorkerInternal(validParentWorkerId);
          if (parentWorker?.backend && parentWorker.backend !== 'claude') {
            options.backend = parentWorker.backend;
            if (parentWorker.backend === 'aider' && parentWorker.model) options.model = parentWorker.model;
          }
        }
        if (validEffortLevel !== undefined) options.effortLevel = validEffortLevel;

        const worker = await spawnWorker(resolvedPath, label, io, options);

        // Auto-join the spawning socket to the new worker's room so it can
        // immediately interact with the worker it just created.
        socket.join(`worker:${worker.id}`);
        joinedWorkers.add(worker.id);

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
      if (!joinedWorkers.has(workerId)) {
        return socket.emit('error', { message: 'Not subscribed to this worker', workerId });
      }
      getLogger().info('[socket.handler] Received worker:kill', { socketId: socket.id, workerId, force: !!force });
      try {
        await killWorker(workerId, io, { force: !!force, reason: 'killed_by_human' });
        getLogger().info('[socket.handler] Worker killed successfully', { workerId });
      } catch (error) {
        getLogger().error('[socket.handler] Failed to kill worker', { workerId, err: error.message });
        socket.emit('error', { message: sanitizeErrorMessage(error), workerId });
      }
    });

    // Handle worker input (line-based, adds Enter)
    socket.on('worker:input', async ({ workerId, input, fromWorkerId }) => {
      try {
        if (typeof workerId !== 'string' || !workerId) {
          return socket.emit('error', { message: 'Invalid workerId' });
        }
        if (typeof input !== 'string' || input.length > MAX_INPUT_LENGTH) {
          return socket.emit('error', { message: 'Input too large or invalid', workerId });
        }
        if (!joinedWorkers.has(workerId)) {
          return socket.emit('error', { message: 'Not subscribed to this worker', workerId });
        }

        // Cross-project guard: block workers from sending input to workers in different projects
        if (fromWorkerId && typeof fromWorkerId === 'string') {
          const sender = getWorkerInternal(fromWorkerId);
          const receiver = getWorkerInternal(workerId);
          if (sender && receiver && sender.project && receiver.project && sender.project !== receiver.project) {
            getLogger().warn('[socket.handler] Cross-project input blocked', { event: 'cross_project_blocked', socketId: socket.id, fromWorkerId, workerId, senderProject: sender.project, receiverProject: receiver.project });
            return socket.emit('error', {
              message: `Cross-project input blocked: sender project (${sender.project}) does not match receiver project (${receiver.project})`,
              workerId
            });
          }
        }

        await sendInput(workerId, input, null, { fromWorkerId, source: fromWorkerId ? `socket:worker:${fromWorkerId}` : 'web_ui' });
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
        if (!joinedWorkers.has(workerId)) {
          return socket.emit('error', { message: 'Not subscribed to this worker', workerId });
        }

        // Context-less guard: accumulate into a per-worker line buffer.
        // Individual keystrokes pass through immediately; the guard fires only
        // when a complete line is assembled (newline received). Lines >80 chars
        // or containing technical markers are fast-allowed and never blocked.
        const prev = rawInputLineBuffers.get(workerId) || '';
        const buf = prev + keys;

        // Overflow guard: buffers longer than 1000 chars will fast-allow anyway (>80 char rule).
        // Clear buffer and forward normally to avoid unbounded memory growth.
        if (buf.length > 1000) {
          rawInputLineBuffers.delete(workerId);
          await sendRawInput(workerId, keys);
          return;
        }

        const nlIdx = buf.search(/[\n\r]/);

        if (nlIdx === -1) {
          // No complete line yet — store accumulated chars and forward this keystroke.
          rawInputLineBuffers.set(workerId, buf);
          await sendRawInput(workerId, keys);
          return;
        }

        // Complete line assembled — test the text before the newline.
        const line = buf.slice(0, nlIdx);
        rawInputLineBuffers.set(workerId, buf.slice(nlIdx + 1));

        if (isContextLessInput(line)) {
          getLogger().warn('[socket.handler] Context-less rawInput rejected', { socketId: socket.id, workerId });
          socket.emit('worker:input:rejected', {
            workerId,
            reason: 'context-less input forbidden — include concrete task and end state'
          });
          return;
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
        if (!joinedWorkers.has(workerId)) {
          return socket.emit('error', { message: 'Not subscribed to this worker', workerId });
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
      if (!joinedWorkers.has(workerId)) {
        return socket.emit('error', { message: 'Not subscribed to this worker', workerId });
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

curl -s --retry 3 --retry-delay 2 --retry-connrefused -X POST http://localhost:38007/api/ralph/signal/by-worker/${worker.id} -H "Content-Type: application/json" -H "X-Ralph-Token: ${worker.ralphToken}" -d '{"status":"done"}'

If blocked, signal:
curl -s --retry 3 --retry-delay 2 --retry-connrefused -X POST http://localhost:38007/api/ralph/signal/by-worker/${worker.id} -H "Content-Type: application/json" -H "X-Ralph-Token: ${worker.ralphToken}" -d '{"status":"blocked","reason":"brief description"}'
===========================

`;
              await sendInput(workerId, instructions, null, { source: 'ralph_enable' });
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
        // Subscribe to output updates and register ownership
        socket.join(`worker:${workerId}`);
        joinedWorkers.add(workerId);
      } catch (error) {
        socket.emit('error', { message: sanitizeErrorMessage(error), workerId });
      }
    });

    // Handle output subscription (join room for worker output updates)
    socket.on('worker:output:subscribe', ({ workerId }) => {
      if (typeof workerId !== 'string' || !VALID_WORKER_ID.test(workerId)) return;
      socket.join(`worker:${workerId}`);
      joinedWorkers.add(workerId);
    });

    // Handle output unsubscription (leave room)
    socket.on('worker:output:unsubscribe', ({ workerId }) => {
      if (typeof workerId !== 'string' || !VALID_WORKER_ID.test(workerId)) return;
      socket.leave(`worker:${workerId}`);
      joinedWorkers.delete(workerId);
    });

    // Handle terminal resize
    socket.on('worker:resize', async ({ workerId, cols, rows }) => {
      if (typeof workerId !== 'string' || !workerId) {
        return socket.emit('error', { message: 'Invalid workerId' });
      }
      if (typeof cols !== 'number' || typeof rows !== 'number' || cols < 1 || rows < 1 || cols > 1000 || rows > 500) {
        return socket.emit('error', { message: 'Invalid resize dimensions', workerId });
      }
      if (!joinedWorkers.has(workerId)) {
        return socket.emit('error', { message: 'Not subscribed to this worker', workerId });
      }
      try {
        await resizeWorkerTerminal(workerId, cols, rows, io);
      } catch (error) {
        getLogger().error('[socket.handler] Resize error', { workerId, err: error.message });
        socket.emit('error', { message: 'Resize failed', workerId });
      }
    });

    // Handle worker complete (mark as completed, trigger dependents)
    socket.on('worker:complete', async ({ workerId }) => {
      if (typeof workerId !== 'string' || !workerId) {
        return socket.emit('error', { message: 'Invalid workerId' });
      }
      if (!joinedWorkers.has(workerId)) {
        return socket.emit('error', { message: 'Not subscribed to this worker', workerId });
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
      getLogger().info('[socket.handler] Client subscribed to metrics', { socketId: socket.id });
      socket.join('metrics');

      // Send immediate metrics update to the subscribing client
      try {
        const metricsData = getSystemMetricsData();
        socket.emit('metrics:update', metricsData);
      } catch (error) {
        getLogger().error('[socket.handler] Error sending initial metrics', { socketId: socket.id, err: error.message });
      }

      // Start broadcast interval if not running
      try {
        if (!metricsBroadcastInterval) {
          startMetricsBroadcast(io);
        }
      } catch (error) {
        getLogger().error('[socket.handler] Error starting metrics broadcast', { err: error.message });
      }
    });

    // Handle metrics unsubscription (using Socket.io rooms)
    socket.on('metrics:unsubscribe', () => {
      try {
        getLogger().info('[socket.handler] Client unsubscribed from metrics', { socketId: socket.id });
        socket.leave('metrics');

        // Stop broadcast interval if no more subscribers
        const room = io.sockets.adapter.rooms.get('metrics');
        if ((!room || room.size === 0) && metricsBroadcastInterval) {
          clearInterval(metricsBroadcastInterval);
          metricsBroadcastInterval = null;
          getLogger().info('[socket.handler] Metrics broadcast stopped - no subscribers');
        }
      } catch (error) {
        getLogger().error('[socket.handler] Error in metrics:unsubscribe', { socketId: socket.id, err: error.message });
      }
    });

    // Handle disconnect with reason logging
    socket.on('disconnect', (reason) => {
      try {
        getLogger().info('[socket.handler] Client disconnected', { socketId: socket.id, reason });
        // Clean up rate limiter, ownership set, and rawInput buffers to prevent memory leak
        rateLimiter.destroy();
        joinedWorkers.clear();
        rawInputLineBuffers.clear();

        // Socket.io automatically removes socket from rooms on disconnect.
        // Stop broadcast if metrics room is now empty.
        const room = io.sockets.adapter.rooms.get('metrics');
        if ((!room || room.size === 0) && metricsBroadcastInterval) {
          clearInterval(metricsBroadcastInterval);
          metricsBroadcastInterval = null;
          getLogger().info('[socket.handler] Metrics broadcast stopped - no subscribers');
        }

        // Log specific disconnect reasons for debugging
        if (reason === 'ping timeout') {
          getLogger().warn('[socket.handler] Client disconnected: ping timeout', { socketId: socket.id, reason });
        } else if (reason === 'transport close') {
          getLogger().warn('[socket.handler] Client transport closed unexpectedly', { socketId: socket.id, reason });
        } else if (reason === 'transport error') {
          getLogger().error('[socket.handler] Client transport error', { socketId: socket.id, reason });
        }
      } catch (error) {
        getLogger().error('[socket.handler] Error in disconnect handler', { socketId: socket.id, err: error.message });
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
  getLogger().info('[socket.handler] Starting metrics broadcast');

  metricsBroadcastInterval = setInterval(() => {
    const room = io.sockets.adapter.rooms.get('metrics');
    if (!room || room.size === 0) return;

    try {
      const metricsData = getSystemMetricsData();
      io.to('metrics').emit('metrics:update', metricsData);
    } catch (error) {
      getLogger().error('[socket.handler] Error broadcasting metrics', { err: error.message });
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
    getLogger().info('[socket.handler] Metrics broadcast stopped');
  }
}
