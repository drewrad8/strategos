/**
 * Auto-respawn service for GENERAL workers.
 *
 * When a GENERAL with autoRespawn=true dies (crash, session exhaustion, or kill),
 * this service spawns a fresh replacement with the same task and a handoff note
 * built from the dead worker's last Ralph signal.
 *
 * Usage:
 *   registerAutoRespawn(workerId, config)   — call after spawning a general
 *   handleGeneralDeath(workerId, reason, io) — call when a general dies
 *   getAutoRespawnStatus()                  — returns all registrations + counts
 */

import { getLogger } from '../logger.js';

const logger = getLogger();

// workerId → registration object
const registrations = new Map();

// Tracks respawn chains: originalWorkerId → { count, lastSpawnAt, config }
// Keeps registration alive when the worker ID changes on each respawn.
const chains = new Map();

const DEFAULT_MAX_RESPAWNS = 10;
const DEFAULT_COOLDOWN_MS = 120_000; // 2 minutes

/**
 * Register a worker for auto-respawn.
 * Should be called immediately after spawnWorker returns.
 *
 * @param {string} workerId
 * @param {object} config
 *   - taskDescription {string}     Original task text (description field)
 *   - projectPath {string}
 *   - label {string}               Full label, e.g. "GENERAL: finance-ops"
 *   - maxRespawns {number}         Default 10
 *   - cooldownMs {number}          Min ms between respawns. Default 120000
 *   - effortLevel {string|null}
 *   - autoAccept {boolean}
 *   - forcedAutonomy {boolean}
 *   - bulldozeMode {boolean}
 *   - chainId {string|null}        Set when re-registering a replacement worker
 *   - respawnCount {number}        Set when re-registering a replacement worker
 */
export function registerAutoRespawn(workerId, config) {
  const {
    taskDescription,
    projectPath,
    label,
    maxRespawns = DEFAULT_MAX_RESPAWNS,
    cooldownMs = DEFAULT_COOLDOWN_MS,
    effortLevel = null,
    autoAccept = true,
    forcedAutonomy = true,
    bulldozeMode = false,
    chainId = null,
    respawnCount = 0,
  } = config;

  if (!taskDescription || !projectPath || !label) {
    logger.warn(`[AutoRespawn] registerAutoRespawn called with missing fields for worker ${workerId}`);
    return;
  }

  const registration = {
    workerId,
    taskDescription,
    projectPath,
    label,
    maxRespawns,
    cooldownMs,
    effortLevel,
    autoAccept,
    forcedAutonomy,
    bulldozeMode,
    chainId: chainId || workerId,      // first worker is its own chain root
    respawnCount,
    registeredAt: Date.now(),
  };

  registrations.set(workerId, registration);

  // Maintain chain index (chainId → latest registration)
  const cid = registration.chainId;
  if (!chains.has(cid)) {
    chains.set(cid, { count: respawnCount, lastSpawnAt: 0 });
  } else {
    chains.get(cid).count = respawnCount;
  }

  logger.info(`[AutoRespawn] Registered worker ${workerId} (${label}) — chain ${cid}, respawns so far: ${respawnCount}/${maxRespawns}`);
}

/**
 * Deregister a worker. Called automatically when max is hit or when explicitly removed.
 */
export function deregisterAutoRespawn(workerId) {
  const reg = registrations.get(workerId);
  if (reg) {
    logger.info(`[AutoRespawn] Deregistering worker ${workerId} (${reg.label})`);
    registrations.delete(workerId);
  }
}

/**
 * Handle a general worker dying. Spawns a replacement if within limits.
 *
 * @param {string} workerId
 * @param {string} reason   "crashed" | "session_exhausted" | "killed"
 * @param {object|null} io  Socket.io instance (optional, for emitting events)
 * @param {object} workerSnapshot  Snapshot of the dead worker (for handoff context)
 */
export async function handleGeneralDeath(workerId, reason, io = null, workerSnapshot = null) {
  const reg = registrations.get(workerId);
  if (!reg) return; // Not registered for auto-respawn

  const chainState = chains.get(reg.chainId) || { count: 0, lastSpawnAt: 0 };
  const now = Date.now();

  // Check respawn limit
  if (chainState.count >= reg.maxRespawns) {
    logger.warn(`[AutoRespawn] Chain ${reg.chainId} (${reg.label}) hit max respawns (${reg.maxRespawns}) — not respawning`);
    deregisterAutoRespawn(workerId);
    if (io) {
      io.emit('worker:auto-respawn:exhausted', { workerId, label: reg.label, chainId: reg.chainId, count: chainState.count });
    }
    return;
  }

  // Check cooldown
  if (chainState.lastSpawnAt && (now - chainState.lastSpawnAt) < reg.cooldownMs) {
    const remainingMs = reg.cooldownMs - (now - chainState.lastSpawnAt);
    logger.warn(`[AutoRespawn] Worker ${workerId} (${reg.label}) in cooldown — ${Math.ceil(remainingMs / 1000)}s remaining, scheduling retry`);
    // Schedule a retry after cooldown expires
    setTimeout(() => {
      handleGeneralDeath(workerId, reason, io, workerSnapshot);
    }, remainingMs + 1000); // +1s buffer
    return;
  }

  // Build handoff note from last Ralph signal
  const handoffLines = [];
  const snap = workerSnapshot || {};
  if (snap.ralphProgress !== undefined && snap.ralphProgress !== null) {
    handoffLines.push(`Progress at death: ${snap.ralphProgress}%`);
  }
  if (snap.ralphCurrentStep) {
    handoffLines.push(`Last step: ${snap.ralphCurrentStep}`);
  }
  if (snap.ralphLearnings) {
    handoffLines.push(`Learnings from previous run:\n${snap.ralphLearnings}`);
  }

  const handoffNote = handoffLines.length > 0
    ? `--- HANDOFF NOTE (auto-respawn #${chainState.count + 1}, reason: ${reason}) ---\n${handoffLines.join('\n')}\n--- END HANDOFF NOTE ---\n\n`
    : `--- HANDOFF NOTE (auto-respawn #${chainState.count + 1}, reason: ${reason}) ---\nNo prior progress information available.\n--- END HANDOFF NOTE ---\n\n`;

  const fullTask = `${handoffNote}${reg.taskDescription}`;

  logger.info(`[AutoRespawn] Spawning replacement for ${workerId} (${reg.label}), reason: ${reason}, attempt ${chainState.count + 1}/${reg.maxRespawns}`);

  // Deregister old worker before spawning replacement
  registrations.delete(workerId);

  // Update chain state before spawn attempt
  chainState.count += 1;
  chainState.lastSpawnAt = now;
  chains.set(reg.chainId, chainState);

  try {
    // Lazy import to avoid circular dependencies
    const { spawnWorker } = await import('../workers/lifecycle.js');

    const newWorker = await spawnWorker(reg.projectPath, reg.label, io, {
      task: { description: fullTask },
      parentWorkerId: null,  // No parent — spawned as independent top-level general
      autoAccept: reg.autoAccept,
      ralphMode: true,
      allowDuplicate: true,  // Allow duplicate label since we're replacing a dead worker
      effortLevel: reg.effortLevel,
      autoRespawn: true,
      autoRespawnConfig: {
        taskDescription: reg.taskDescription,  // Store original task (without handoff prefix)
        projectPath: reg.projectPath,
        label: reg.label,
        maxRespawns: reg.maxRespawns,
        cooldownMs: reg.cooldownMs,
        effortLevel: reg.effortLevel,
        autoAccept: reg.autoAccept,
        forcedAutonomy: reg.forcedAutonomy,
        bulldozeMode: reg.bulldozeMode,
        chainId: reg.chainId,
        respawnCount: chainState.count,
      },
    });

    logger.info(`[AutoRespawn] Replacement spawned: ${newWorker.id} (${reg.label}), chain ${reg.chainId}, count ${chainState.count}`);

    if (io) {
      io.emit('worker:auto-respawned', {
        deadWorkerId: workerId,
        newWorkerId: newWorker.id,
        label: reg.label,
        chainId: reg.chainId,
        respawnCount: chainState.count,
        reason,
      });
    }
  } catch (err) {
    logger.error(`[AutoRespawn] Failed to spawn replacement for ${workerId} (${reg.label}): ${err.message}`);
    // Re-register the dead worker so a future death event can retry the respawn chain
    registerAutoRespawn(workerId, reg);
    if (io) {
      io.emit('worker:auto-respawn:failed', { workerId, label: reg.label, chainId: reg.chainId, error: err.message });
    }
  }
}

/**
 * Returns current auto-respawn registrations and chain states.
 */
export function getAutoRespawnStatus() {
  const regs = [];
  for (const [workerId, reg] of registrations.entries()) {
    const chainState = chains.get(reg.chainId) || { count: 0, lastSpawnAt: 0 };
    regs.push({
      workerId,
      label: reg.label,
      projectPath: reg.projectPath,
      chainId: reg.chainId,
      respawnCount: chainState.count,
      maxRespawns: reg.maxRespawns,
      cooldownMs: reg.cooldownMs,
      lastSpawnAt: chainState.lastSpawnAt || null,
      registeredAt: reg.registeredAt,
    });
  }

  return {
    registrations: regs,
    totalChains: chains.size,
    totalRegistrations: registrations.size,
  };
}
