/**
 * Status Writer for Strategos
 *
 * Writes service status to a shared JSON file that other Thea services
 * (like Great Hall) can read to display Strategos health.
 */

import fs from 'fs';
import path from 'path';
import { THEA_ROOT } from './workers/state.js';

const STATUS_FILE = path.join(THEA_ROOT, 'shared', 'status', 'strategos.json');
const UPDATE_INTERVAL = 30000; // 30 seconds

class StatusWriter {
  constructor() {
    this.status = 'starting';
    this.startedAt = new Date().toISOString();
    this.pid = process.pid;
    this.interval = null;
    this.workerCountFn = null;
    this.healthFn = null;

    this._ensureDirectory();
  }

  _ensureDirectory() {
    const dir = path.dirname(STATUS_FILE);
    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
      }
      this._statusFileWritable = true;
    } catch (err) {
      console.error(`[StatusWriter] Cannot create status directory ${dir}: ${err.message}`);
      this._statusFileWritable = false;
    }
  }

  _write() {
    if (this._statusFileWritable === false) return;
    const now = new Date();
    const uptimeSeconds = Math.floor((now - new Date(this.startedAt)) / 1000);

    let workers = 0;
    let health = 'unknown';
    try { workers = this.workerCountFn ? this.workerCountFn() : 0; } catch { /* provider error */ }
    try { health = this.healthFn ? this.healthFn() : 'unknown'; } catch { /* provider error */ }

    const data = {
      service: 'strategos',
      status: this.status,
      pid: this.pid,
      startedAt: this.startedAt,
      lastHeartbeat: now.toISOString(),
      uptime: uptimeSeconds,
      workers,
      health,
      version: process.version,
      memory: (() => {
        const mem = process.memoryUsage();
        return {
          heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
          rss: Math.round(mem.rss / 1024 / 1024)
        };
      })()
    };

    const tmpFile = STATUS_FILE + `.tmp.${process.pid}.${Date.now()}`;
    try {
      fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2) + '\n');
      fs.renameSync(tmpFile, STATUS_FILE);
    } catch (err) {
      // Don't crash the server, but log so failures are visible
      console.error(`[StatusWriter] Write failed: ${err.message}`);
      try { fs.unlinkSync(tmpFile); } catch (e) { console.warn(`[StatusWriter] Temp file cleanup failed: ${e.message}`); }
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
    this.interval.unref(); // Don't prevent process exit

    // Also write on systemd watchdog ping if available
    if (process.send) {
      // Running under systemd with Type=notify
      this.watchdogInterval = setInterval(() => {
        try {
          process.send('WATCHDOG=1');
        } catch {
          // Not under systemd, ignore
        }
      }, UPDATE_INTERVAL);
      this.watchdogInterval.unref(); // Don't prevent process exit
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
    if (this.watchdogInterval) {
      clearInterval(this.watchdogInterval);
      this.watchdogInterval = null;
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
      workers: (() => { try { return this.workerCountFn ? this.workerCountFn() : 0; } catch { return 0; } })()
    };

    const tmpFile = STATUS_FILE + `.tmp.${process.pid}.${Date.now()}`;
    try {
      fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2) + '\n');
      fs.renameSync(tmpFile, STATUS_FILE);
    } catch (err) {
      console.error(`[StatusWriter] Shutdown write failed: ${err.message}`);
      try { fs.unlinkSync(tmpFile); } catch (e) { console.warn(`[StatusWriter] Temp file cleanup failed: ${e.message}`); }
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
    if (this.watchdogInterval) {
      clearInterval(this.watchdogInterval);
      this.watchdogInterval = null;
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

    const tmpFile = STATUS_FILE + `.tmp.${process.pid}.${Date.now()}`;
    try {
      fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2) + '\n');
      fs.renameSync(tmpFile, STATUS_FILE);
    } catch (err) {
      console.error(`[StatusWriter] Crash write failed: ${err?.message}`);
      try { fs.unlinkSync(tmpFile); } catch (e) { console.warn(`[StatusWriter] Temp file cleanup failed: ${e.message}`); }
    }
  }

  /**
   * Get path to status file
   */
  static getStatusFilePath() {
    return STATUS_FILE;
  }

  /**
   * Read current status (for other services)
   */
  static readStatus() {
    try {
      if (fs.existsSync(STATUS_FILE)) {
        return JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
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
