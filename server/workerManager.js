/**
 * workerManager.js — Thin facade that re-exports from focused modules.
 *
 * This file preserves the public API surface so that all existing callers
 * (routes, socketHandler, index, orchestratorService, sentinel, ralphService, etc.)
 * continue to import from './workerManager.js' without changes.
 *
 * Actual implementation lives in:
 *   server/workers/state.js       — shared state, constants, utilities
 *   server/workers/templates.js   — worker type detection, context generation
 *   server/workers/output.js      — PTY capture, auto-accept, bulldoze, input handling
 *   server/workers/health.js      — health monitoring, crash recovery, periodic cleanup
 *   server/workers/lifecycle.js   — spawn, kill, complete, dismiss, discover
 *   server/workers/persistence.js — save/restore, checkpoints
 *   server/workers/ralph.js       — Ralph status updates, auto-promotion, getters
 */

// From state.js — shared state utilities
export {
  normalizeWorker,
  getActivityLog,
  checkTmux,
  setWorkerDeathCallback,
  getCircuitBreakerStatus,
  resetCircuitBreaker,
} from './workers/state.js';

// From output.js — PTY capture, input handling, worker settings
export {
  sendInput,
  sendRawInput,
  interruptWorker,
  processQueue,
  updateWorkerSettings,
  stopAllPtyCaptures,
} from './workers/output.js';

// From health.js — health monitoring, periodic cleanup
export {
  stopAllHealthMonitors,
  startPeriodicCleanup,
  stopPeriodicCleanup,
} from './workers/health.js';

// From lifecycle.js — spawn, kill, complete, dismiss, discover, headless/batch
export {
  spawnWorker,
  killWorker,
  dismissWorker,
  completeWorker,
  updateWorkerLabel,
  resizeWorkerTerminal,
  broadcastToProject,
  discoverExistingWorkers,
  runHeadless,
  runBatchOperation,
} from './workers/lifecycle.js';

// From persistence.js — save/restore, checkpoints
export {
  saveWorkerState,
  saveWorkerStateSync,
  restoreWorkerState,
} from './workers/persistence.js';

// From ralph.js — Ralph status updates, getters, resource stats
export {
  updateWorkerRalphStatus,
  getWorkers,
  getWorker,
  getWorkerInternal,
  getWorkersByProject,
  getWorkerOutput,
  getChildWorkers,
  getSiblingWorkers,
  getPendingWorkers,
  getResourceStats,
  getRespawnSuggestions,
  removeRespawnSuggestion,
  getWorkerEfficiency,
} from './workers/ralph.js';

// From dependencyGraph.js
export { getDependencyStats, getWorkerDependencies } from './dependencyGraph.js';

// From workerOutputDb.js
export { closeDatabase as closeOutputDb } from './workerOutputDb.js';
