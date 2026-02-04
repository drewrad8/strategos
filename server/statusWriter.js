/**
 * Status Writer for Strategos
 *
 * Writes service status to a JSON file for health monitoring.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

// Status file location - configurable via environment or config
function getStatusFilePath() {
  // Check environment variable first
  if (process.env.STRATEGOS_this.statusFile) {
    return process.env.STRATEGOS_this.statusFile;
  }

  // Use data directory if available
  const dataDir = process.env.STRATEGOS_DATA_DIR || path.join(os.homedir(), '.strategos', 'data');
  return path.join(dataDir, 'status.json');
}

const UPDATE_INTERVAL = 30000; // 30 seconds

class StatusWriter {
  constructor() {
    this.statusFile = getStatusFilePath();
    this.status = 'starting';
    this.startedAt = new Date().toISOString();
    this.pid = process.pid;
    this.interval = null;
    this.workerCountFn = null;
    this.healthFn = null;

    this._ensureDirectory();
  }

  _ensureDirectory() {
    const dir = path.dirname(this.statusFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  _write() {
    const now = new Date();
    const uptimeSeconds = Math.floor((now - new Date(this.startedAt)) / 1000);

    const data = {
      service: 'strategos',
      status: this.status,
      pid: this.pid,
      startedAt: this.startedAt,
      lastHeartbeat: now.toISOString(),
      uptime: uptimeSeconds,
      workers: this.workerCountFn ? this.workerCountFn() : 0,
      health: this.healthFn ? this.healthFn() : 'unknown',
      version: process.version,
      memory: {
        heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        rss: Math.round(process.memoryUsage().rss / 1024 / 1024)
      }
    };

    try {
      fs.writeFileSync(this.statusFile, JSON.stringify(data, null, 2) + '\n');
    } catch (err) {
      // Silently fail - don't crash the server over status file issues
    }
  }

  /**
   * Set callback to get current worker count
   */
  setWorkerCountProvider(fn) {
    this.workerCountFn = fn;
  }

  /**
   * Set callback to get current health status
   */
  setHealthProvider(fn) {
    this.healthFn = fn;
  }

  /**
   * Start periodic status updates
   */
  start() {
    this.status = 'running';
    this._write();
    this.interval = setInterval(() => this._write(), UPDATE_INTERVAL);

    // Also write on systemd watchdog ping if available
    if (process.send) {
      // Running under systemd with Type=notify
      setInterval(() => {
        try {
          process.send('WATCHDOG=1');
        } catch {
          // Not under systemd, ignore
        }
      }, UPDATE_INTERVAL);
    }
  }

  /**
   * Write shutdown status
   */
  shutdown(reason = 'graceful') {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }

    this.status = 'stopped';
    const now = new Date();
    const uptimeSeconds = Math.floor((now - new Date(this.startedAt)) / 1000);

    const data = {
      service: 'strategos',
      status: 'stopped',
      pid: this.pid,
      startedAt: this.startedAt,
      stoppedAt: now.toISOString(),
      uptime: uptimeSeconds,
      shutdownReason: reason,
      workers: this.workerCountFn ? this.workerCountFn() : 0
    };

    try {
      fs.writeFileSync(this.statusFile, JSON.stringify(data, null, 2) + '\n');
    } catch (err) {
      // Can't write, just exit
    }
  }

  /**
   * Write crash status (called from uncaught exception handler)
   */
  crash(error) {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }

    this.status = 'crashed';
    const now = new Date();
    const uptimeSeconds = Math.floor((now - new Date(this.startedAt)) / 1000);

    const data = {
      service: 'strategos',
      status: 'crashed',
      pid: this.pid,
      startedAt: this.startedAt,
      crashedAt: now.toISOString(),
      uptime: uptimeSeconds,
      error: {
        message: error?.message || String(error),
        stack: error?.stack?.split('\n').slice(0, 5).join('\n')
      }
    };

    try {
      fs.writeFileSync(this.statusFile, JSON.stringify(data, null, 2) + '\n');
    } catch {
      // Can't write, just exit
    }
  }

  /**
   * Get path to status file
   */
  static getStatusFilePath() {
    return getStatusFilePath();
  }

  /**
   * Read current status (for other services)
   */
  static readStatus() {
    const statusPath = getStatusFilePath();
    try {
      if (fs.existsSync(statusPath)) {
        return JSON.parse(fs.readFileSync(statusPath, 'utf8'));
      }
    } catch {
      return null;
    }
    return null;
  }
}

// Singleton
let instance = null;

export function getStatusWriter() {
  if (!instance) {
    instance = new StatusWriter();
  }
  return instance;
}

export default StatusWriter;
