/**
 * RalphService - Standalone Worker Signal Management
 *
 * Manages completion tokens for workers to signal progress/completion.
 * Workers call POST /api/ralph/signal/:token to update their status.
 *
 * The PRD autonomous execution engine was removed 2026-02-12 after evaluation
 * showed the GENERAL worker parallel delegation pattern is strictly superior.
 * See: tmp/ralph-prd-engine-evaluation.md
 */

import crypto from 'crypto';
import { updateWorkerRalphStatus } from '../workerManager.js';
import { getLogger } from '../logger.js';

const generateCompletionToken = () => crypto.randomBytes(16).toString('hex');
const TOKEN_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

// Map of completion tokens to their context
// token -> { workerId, standalone: true, createdAt }
const pendingCompletions = new Map();

export class RalphService {
  constructor(io) {
    this.io = io;

    // Periodic cleanup of orphaned completion tokens (every 30 minutes)
    this._tokenCleanupInterval = setInterval(() => {
      try {
        const now = Date.now();
        let cleaned = 0;
        for (const [token, ctx] of pendingCompletions) {
          if (ctx.createdAt && now - ctx.createdAt > TOKEN_TTL_MS) {
            pendingCompletions.delete(token);
            cleaned++;
          }
        }
        if (cleaned > 0) {
          getLogger().info(`[ralph.service] Cleaned up ${cleaned} expired completion tokens`);
        }
      } catch (err) {
        getLogger().error('[ralph.service] Token cleanup failed:', { err: err.message });
      }
    }, 30 * 60 * 1000);
    if (this._tokenCleanupInterval.unref) {
      this._tokenCleanupInterval.unref();
    }
  }

  /**
   * Register a standalone worker for Ralph completion signaling
   * @param {string} token - Completion token
   * @param {string} workerId - Worker ID
   */
  registerStandaloneWorker(token, workerId) {
    pendingCompletions.set(token, {
      workerId,
      standalone: true,
      createdAt: Date.now()
    });
    getLogger().info(`[ralph.service] Registered standalone worker ${workerId} with token ${token.slice(0, 8)}...`, { workerId });
  }

  /**
   * Unregister a standalone worker's token on death.
   * @param {string} token - Completion token
   */
  unregisterStandaloneWorker(token) {
    const ctx = pendingCompletions.get(token);
    if (ctx?.standalone) {
      pendingCompletions.delete(token);
      getLogger().info(`[ralph.service] Unregistered standalone token ${token.slice(0, 8)}...`);
    }
  }

  /**
   * Handle completion signal from API callback
   * @param {string} token - Completion token
   * @param {Object} signalData - Signal data (status, progress, currentStep, reason, learnings, outputs, artifacts)
   * @returns {boolean} True if token was valid
   */
  async handleCompletionSignal(token, signalData) {
    const context = pendingCompletions.get(token);
    if (!context) {
      getLogger().warn(`[ralph.service] Unknown completion token: ${token.slice(0, 8)}...`);
      return false;
    }

    // Check token TTL
    if (context.createdAt && Date.now() - context.createdAt > TOKEN_TTL_MS) {
      pendingCompletions.delete(token);
      getLogger().warn(`[ralph.service] Expired completion token: ${token.slice(0, 8)}...`);
      return false;
    }

    const { workerId } = context;
    const { status } = signalData;
    getLogger().info(`[ralph.service] Signal received for worker ${workerId}: ${status}`, { workerId, status });

    // Delete token for terminal states only
    if (status === 'done' || status === 'blocked') {
      pendingCompletions.delete(token);
    }

    // Update worker's Ralph status for parent workers to query
    const result = updateWorkerRalphStatus(workerId, signalData, this.io);

    // Persistent worker tried to signal done — restore token so they can re-signal in_progress
    if (result && result.rejected) {
      pendingCompletions.set(token, context);
      return { rejected: true, message: result.message };
    }

    return true;
  }

  /**
   * Cleanup - called on shutdown
   */
  async cleanup() {
    getLogger().info('[ralph.service] Cleaning up...');
    if (this._tokenCleanupInterval) {
      clearInterval(this._tokenCleanupInterval);
      this._tokenCleanupInterval = null;
    }
  }
}

/**
 * Create and return a RalphService instance
 * @param {Object} io - Socket.io instance
 * @returns {RalphService} Service instance
 */
export function createRalphService(io) {
  return new RalphService(io);
}

export default RalphService;
