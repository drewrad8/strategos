/**
 * State Synchronization for Multi-Worker Coordination
 *
 * Provides versioned shared state with optimistic and pessimistic locking
 * mechanisms for coordinating multiple workers.
 *
 * Based on research: "Version all shared state. Schema-validated JSON
 * reduces coordination failures from 37% to <5%."
 */

// Custom Error Types

/**
 * Thrown when expectedVersion doesn't match current version
 */
export class VersionConflictError extends Error {
  constructor(key, expectedVersion, actualVersion) {
    super(`Version conflict on key "${key}": expected ${expectedVersion}, actual ${actualVersion}`);
    this.name = 'VersionConflictError';
    this.key = key;
    this.expectedVersion = expectedVersion;
    this.actualVersion = actualVersion;
  }
}

/**
 * Thrown when attempting to acquire a lock held by another worker
 */
export class LockHeldError extends Error {
  constructor(key, holderId, requesterId) {
    super(`Lock on key "${key}" is held by worker "${holderId}", requested by "${requesterId}"`);
    this.name = 'LockHeldError';
    this.key = key;
    this.holderId = holderId;
    this.requesterId = requesterId;
  }
}

/**
 * Thrown when accessing a key that doesn't exist
 */
export class KeyNotFoundError extends Error {
  constructor(key) {
    super(`Key "${key}" not found`);
    this.name = 'KeyNotFoundError';
    this.key = key;
  }
}

/**
 * StateSync - Versioned shared state for multi-worker coordination
 *
 * Features:
 * - Optimistic locking with version numbers
 * - Pessimistic locking with TTL
 * - Change notifications via callbacks
 * - Lock expiration for dead workers
 * - Version history tracking
 */
export class StateSync {
  constructor(options = {}) {
    this.options = {
      defaultLockTtl: 30000,        // 30 seconds default lock TTL
      maxHistoryLength: 100,         // Max history entries per key
      lockCleanupInterval: 5000,     // Check for expired locks every 5s
      ...options
    };

    // Core state storage: Map<key, value>
    this.state = new Map();

    // Version tracking: Map<key, version>
    this.versions = new Map();

    // Lock tracking: Map<key, { workerId, expiresAt, acquiredAt }>
    this.locks = new Map();

    // Subscriptions: Map<key, Set<callback>>
    this.subscriptions = new Map();

    // Version history: Map<key, Array<{ version, value, timestamp, workerId }>>
    this.history = new Map();

    // Lock expiration cleanup timer
    this._cleanupTimer = null;
    this._startLockCleanup();
  }

  /**
   * Get a value and its version
   * @param {string} key - The key to retrieve
   * @returns {{ value: any, version: number }} - The value and its version
   * @throws {KeyNotFoundError} If key doesn't exist
   */
  get(key) {
    if (!this.state.has(key)) {
      throw new KeyNotFoundError(key);
    }

    return {
      value: this.state.get(key),
      version: this.versions.get(key)
    };
  }

  /**
   * Check if a key exists without throwing
   * @param {string} key - The key to check
   * @returns {boolean}
   */
  has(key) {
    return this.state.has(key);
  }

  /**
   * Set a value with optimistic locking
   * @param {string} key - The key to set
   * @param {any} value - The value to store
   * @param {number|null} expectedVersion - Expected version for optimistic lock, null for new keys
   * @param {string} workerId - ID of the worker making the change (for history)
   * @returns {{ value: any, version: number }} - The new value and version
   * @throws {VersionConflictError} If expectedVersion doesn't match current version
   * @throws {LockHeldError} If key is locked by another worker
   */
  set(key, value, expectedVersion = null, workerId = 'unknown') {
    const currentVersion = this.versions.get(key) ?? 0;
    const isNewKey = !this.state.has(key);

    // Check for pessimistic lock held by another worker
    const lock = this.locks.get(key);
    if (lock && lock.workerId !== workerId && Date.now() < lock.expiresAt) {
      throw new LockHeldError(key, lock.workerId, workerId);
    }

    // Optimistic locking check
    if (expectedVersion !== null) {
      if (isNewKey && expectedVersion !== 0) {
        throw new VersionConflictError(key, expectedVersion, 0);
      }
      if (!isNewKey && expectedVersion !== currentVersion) {
        throw new VersionConflictError(key, expectedVersion, currentVersion);
      }
    }

    // Update state
    const newVersion = currentVersion + 1;
    this.state.set(key, value);
    this.versions.set(key, newVersion);

    // Record history
    this._recordHistory(key, value, newVersion, workerId);

    // Notify subscribers
    this._notifySubscribers(key, value, newVersion, workerId);

    return { value, version: newVersion };
  }

  /**
   * Acquire an exclusive lock on a key
   * @param {string} key - The key to lock
   * @param {string} workerId - ID of the worker acquiring the lock
   * @param {number} ttl - Time-to-live in milliseconds
   * @returns {{ key: string, workerId: string, expiresAt: number, acquiredAt: number }}
   * @throws {LockHeldError} If lock is already held by another worker
   */
  lock(key, workerId, ttl = this.options.defaultLockTtl) {
    const existingLock = this.locks.get(key);
    const now = Date.now();

    // Check if lock exists and hasn't expired
    if (existingLock && existingLock.workerId !== workerId && now < existingLock.expiresAt) {
      throw new LockHeldError(key, existingLock.workerId, workerId);
    }

    // Acquire or renew lock
    const lockInfo = {
      key,
      workerId,
      expiresAt: now + ttl,
      acquiredAt: existingLock?.workerId === workerId ? existingLock.acquiredAt : now
    };

    this.locks.set(key, lockInfo);

    return lockInfo;
  }

  /**
   * Release a lock on a key
   * @param {string} key - The key to unlock
   * @param {string} workerId - ID of the worker releasing the lock
   * @returns {boolean} - True if lock was released, false if not held
   * @throws {LockHeldError} If lock is held by a different worker
   */
  unlock(key, workerId) {
    const existingLock = this.locks.get(key);

    if (!existingLock) {
      return false;
    }

    // Check if lock is held by a different worker and not expired
    if (existingLock.workerId !== workerId && Date.now() < existingLock.expiresAt) {
      throw new LockHeldError(key, existingLock.workerId, workerId);
    }

    this.locks.delete(key);
    return true;
  }

  /**
   * Check if a key is locked
   * @param {string} key - The key to check
   * @returns {{ locked: boolean, workerId?: string, expiresAt?: number }}
   */
  isLocked(key) {
    const lock = this.locks.get(key);

    if (!lock || Date.now() >= lock.expiresAt) {
      return { locked: false };
    }

    return {
      locked: true,
      workerId: lock.workerId,
      expiresAt: lock.expiresAt
    };
  }

  /**
   * Subscribe to changes on a key
   * @param {string} key - The key to watch
   * @param {Function} callback - Callback(value, version, workerId)
   * @returns {Function} - Unsubscribe function
   */
  subscribe(key, callback) {
    if (!this.subscriptions.has(key)) {
      this.subscriptions.set(key, new Set());
    }

    this.subscriptions.get(key).add(callback);

    // Return unsubscribe function
    return () => {
      const subs = this.subscriptions.get(key);
      if (subs) {
        subs.delete(callback);
        if (subs.size === 0) {
          this.subscriptions.delete(key);
        }
      }
    };
  }

  /**
   * Get version history for a key
   * @param {string} key - The key to get history for
   * @param {number} limit - Maximum number of history entries to return
   * @returns {Array<{ version: number, value: any, timestamp: string, workerId: string }>}
   * @throws {KeyNotFoundError} If key has no history
   */
  getHistory(key, limit = 10) {
    const history = this.history.get(key);

    if (!history || history.length === 0) {
      throw new KeyNotFoundError(key);
    }

    // Return most recent entries first (newest to oldest)
    return history.slice(-limit).reverse();
  }

  /**
   * Delete a key and its history
   * @param {string} key - The key to delete
   * @param {string} workerId - ID of the worker performing the delete
   * @returns {boolean} - True if key was deleted
   * @throws {LockHeldError} If key is locked by another worker
   */
  delete(key, workerId = 'unknown') {
    // Check for lock held by another worker
    const lock = this.locks.get(key);
    if (lock && lock.workerId !== workerId && Date.now() < lock.expiresAt) {
      throw new LockHeldError(key, lock.workerId, workerId);
    }

    const existed = this.state.has(key);

    this.state.delete(key);
    this.versions.delete(key);
    this.history.delete(key);
    this.locks.delete(key);
    this.subscriptions.delete(key);

    return existed;
  }

  /**
   * Get all keys
   * @returns {string[]}
   */
  keys() {
    return Array.from(this.state.keys());
  }

  /**
   * Get all key-value pairs with versions
   * @returns {Array<{ key: string, value: any, version: number }>}
   */
  entries() {
    return this.keys().map(key => ({
      key,
      value: this.state.get(key),
      version: this.versions.get(key)
    }));
  }

  /**
   * Get statistics about the state store
   * @returns {{ keyCount: number, lockCount: number, subscriptionCount: number }}
   */
  stats() {
    const now = Date.now();
    let activeLocks = 0;

    for (const lock of this.locks.values()) {
      if (now < lock.expiresAt) {
        activeLocks++;
      }
    }

    let totalSubscriptions = 0;
    for (const subs of this.subscriptions.values()) {
      totalSubscriptions += subs.size;
    }

    return {
      keyCount: this.state.size,
      lockCount: activeLocks,
      subscriptionCount: totalSubscriptions
    };
  }

  /**
   * Clean up expired locks
   * @returns {number} - Number of locks cleaned up
   */
  cleanupExpiredLocks() {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, lock] of this.locks.entries()) {
      if (now >= lock.expiresAt) {
        this.locks.delete(key);
        cleaned++;
      }
    }

    return cleaned;
  }

  /**
   * Clear all state (useful for testing)
   */
  clear() {
    this.state.clear();
    this.versions.clear();
    this.locks.clear();
    this.subscriptions.clear();
    this.history.clear();
  }

  /**
   * Stop background cleanup timer
   */
  destroy() {
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
      this._cleanupTimer = null;
    }
  }

  // Private methods

  _recordHistory(key, value, version, workerId) {
    if (!this.history.has(key)) {
      this.history.set(key, []);
    }

    const historyList = this.history.get(key);
    historyList.push({
      version,
      value: this._cloneValue(value),
      timestamp: new Date().toISOString(),
      workerId
    });

    // Trim history if exceeds max length
    while (historyList.length > this.options.maxHistoryLength) {
      historyList.shift();
    }
  }

  _notifySubscribers(key, value, version, workerId) {
    const subscribers = this.subscriptions.get(key);

    if (subscribers) {
      for (const callback of subscribers) {
        try {
          callback(value, version, workerId);
        } catch (err) {
          console.error(`StateSync subscription callback error for key "${key}":`, err);
        }
      }
    }
  }

  _cloneValue(value) {
    // Deep clone to prevent mutation of history
    if (value === null || typeof value !== 'object') {
      return value;
    }
    return JSON.parse(JSON.stringify(value));
  }

  _startLockCleanup() {
    if (this.options.lockCleanupInterval > 0) {
      this._cleanupTimer = setInterval(() => {
        this.cleanupExpiredLocks();
      }, this.options.lockCleanupInterval);

      // Allow Node.js to exit even if timer is running
      if (this._cleanupTimer.unref) {
        this._cleanupTimer.unref();
      }
    }
  }
}

// Export a singleton instance for shared use
let defaultInstance = null;

export function getStateSync(options) {
  if (!defaultInstance) {
    defaultInstance = new StateSync(options);
  }
  return defaultInstance;
}

export function resetStateSync() {
  if (defaultInstance) {
    defaultInstance.destroy();
    defaultInstance = null;
  }
}

export default StateSync;
