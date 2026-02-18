/**
 * Strategos Logger
 *
 * Structured logging with SQLite persistence and rotating file logs.
 * Provides crash forensics via lifecycle event tracking.
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ============================================
// LOG LEVELS
// ============================================

export const LogLevel = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
  FATAL: 4
};

const LEVEL_NAMES = ['DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'];

// ============================================
// LIFECYCLE EVENT TYPES
// ============================================

export const LifecycleEvent = {
  STARTUP: 'startup',
  SHUTDOWN: 'shutdown',
  CRASH: 'crash',
  RESTART: 'restart',
  WATCHDOG_TIMEOUT: 'watchdog_timeout'
};

// ============================================
// FILE ROTATION
// ============================================

const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_LOG_FILES = 5;

class FileRotator {
  constructor(logPath) {
    this.logPath = logPath;
    this.stream = null;
    this.currentSize = 0;
    this._draining = false;   // Backpressure flag
    this._droppedWrites = 0;  // Track dropped writes during backpressure
    this._openStream();
  }

  _openStream() {
    // Check existing file size
    try {
      const stats = fs.statSync(this.logPath);
      this.currentSize = stats.size;
    } catch {
      this.currentSize = 0;
    }

    this.stream = fs.createWriteStream(this.logPath, { flags: 'a' });
    this.stream.on('error', (err) => {
      console.error(`[Logger] Stream write error on ${this.logPath}: ${err.message}`);
      // Destroy failed stream to release file descriptor
      try { this.stream.destroy(); } catch { /* best effort */ }
    });
    this.stream.on('drain', () => {
      if (this._draining) {
        this._draining = false;
        if (this._droppedWrites > 0) {
          // Log how many writes were dropped during backpressure
          const dropped = this._droppedWrites;
          this._droppedWrites = 0;
          // Write directly to stream to avoid recursion through _log
          this.stream.write(`[Logger] Resumed after backpressure — dropped ${dropped} log writes\n`);
        }
      }
    });
  }

  _rotate() {
    // End previous stream; we don't await the callback because rotation
    // is called synchronously during write() and the old stream will flush
    // its remaining buffer asynchronously.  Opening a new stream to a new
    // file is safe even while the old one drains.
    try { this.stream.end(); } catch { /* already closed */ }

    // Rotate existing files (.4→.5, .3→.4, .2→.3, .1→.2)
    for (let i = MAX_LOG_FILES - 1; i >= 1; i--) {
      const oldPath = `${this.logPath}.${i}`;
      const newPath = `${this.logPath}.${i + 1}`;
      try {
        if (fs.existsSync(oldPath)) {
          fs.renameSync(oldPath, newPath);
        }
      } catch (err) {
        // Ignore rotation errors
      }
    }

    // Rename current to .1
    try {
      if (fs.existsSync(this.logPath)) {
        fs.renameSync(this.logPath, `${this.logPath}.1`);
      }
    } catch (err) {
      // Ignore
    }

    // Delete oldest if over limit
    try {
      const oldest = `${this.logPath}.${MAX_LOG_FILES + 1}`;
      if (fs.existsSync(oldest)) {
        fs.unlinkSync(oldest);
      }
    } catch {
      // Ignore
    }

    this.currentSize = 0;
    this._openStream();
  }

  write(line) {
    // Drop writes during backpressure to prevent OOM from unbounded buffering
    if (this._draining) {
      this._droppedWrites++;
      return;
    }
    const bytes = Buffer.byteLength(line, 'utf8');
    if (this.currentSize + bytes > MAX_LOG_SIZE) {
      this._rotate();
    }
    const canContinue = this.stream.write(line);
    this.currentSize += bytes;
    if (!canContinue) {
      this._draining = true;
    }
  }

  close(callback) {
    if (this.stream) {
      this.stream.end(callback);
    } else if (callback) {
      callback();
    }
  }
}

// ============================================
// LOGGER CLASS
// ============================================

class Logger {
  constructor(options = {}) {
    this.minLevel = options.minLevel ?? LogLevel.INFO;
    this.dbPath = options.dbPath || path.join(__dirname, 'logs.db');
    this.logDir = options.logDir || path.join(__dirname, '..', 'logs');

    this.db = null;
    this.mainLog = null;
    this.errorLog = null;
    this.startTime = Date.now();
    this.logCount = 0;

    // Circuit breaker to prevent infinite logging loops
    this.consoleDisabled = false;
    this._isLogging = false;  // Reentrancy guard
    this._errorCount = 0;     // Track consecutive errors
    this._lastErrorReset = Date.now();
    this._maxErrorsPerSecond = 100;  // Rate limit

    this._initDatabase();
    this._initFiles();
  }

  _initDatabase() {
    // Ensure directory exists
    const dbDir = path.dirname(this.dbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('journal_size_limit = 50000000'); // 50MB WAL limit
    this.db.pragma('busy_timeout = 5000'); // 5s wait for locks (matches other DBs)

    // Create server_logs table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS server_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        level TEXT NOT NULL,
        source TEXT,
        message TEXT NOT NULL,
        context TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON server_logs(timestamp);
      CREATE INDEX IF NOT EXISTS idx_logs_level ON server_logs(level);

      -- Lifecycle events for crash forensics
      CREATE TABLE IF NOT EXISTS lifecycle_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        event_type TEXT NOT NULL,
        reason TEXT,
        previous_uptime_seconds INTEGER,
        node_version TEXT,
        memory_usage TEXT,
        extra TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_lifecycle_timestamp ON lifecycle_events(timestamp);
      CREATE INDEX IF NOT EXISTS idx_lifecycle_type ON lifecycle_events(event_type);
    `);

    // Prepare statements
    this._insertLog = this.db.prepare(`
      INSERT INTO server_logs (timestamp, level, source, message, context)
      VALUES (?, ?, ?, ?, ?)
    `);

    this._insertLifecycle = this.db.prepare(`
      INSERT INTO lifecycle_events (timestamp, event_type, reason, previous_uptime_seconds, node_version, memory_usage, extra)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    this._queryLogs = this.db.prepare(`
      SELECT * FROM server_logs
      WHERE (? IS NULL OR level = ?)
        AND (? IS NULL OR timestamp >= ?)
        AND (? IS NULL OR timestamp <= ?)
      ORDER BY timestamp DESC
      LIMIT ?
    `);

    this._queryLifecycle = this.db.prepare(`
      SELECT * FROM lifecycle_events
      ORDER BY timestamp DESC
      LIMIT ?
    `);

    // Prepared statements for getStats (avoid re-creating per call)
    this._statsByLevel = this.db.prepare(`
      SELECT level, COUNT(*) as count FROM server_logs GROUP BY level
    `);
    this._statsRecentErrors = this.db.prepare(`
      SELECT COUNT(*) as count FROM server_logs
      WHERE level IN ('ERROR', 'FATAL')
        AND timestamp > datetime('now', '-1 hour')
    `);
    this._deleteOldLogs = this.db.prepare('DELETE FROM server_logs WHERE timestamp < ?');

    // Cleanup old logs at startup (keep 7 days)
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    this._deleteOldLogs.run(cutoff);

    // Periodic cleanup every hour during runtime
    this._cleanupInterval = setInterval(() => {
      try {
        const c = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        const result = this._deleteOldLogs.run(c);
        if (result.changes > 0) {
          console.log(`[Logger] Cleaned up ${result.changes} logs older than 7 days`);
        }
        // Periodic WAL checkpoint to prevent unbounded WAL growth
        // Try PASSIVE first (non-blocking), escalate to RESTART if WAL is still large
        try {
          const walResult = this.db.pragma('wal_checkpoint(PASSIVE)');
          // walResult[0] = { busy, checkpointed, log }
          const walInfo = walResult[0];
          if (walInfo && walInfo.log > 1000 && walInfo.checkpointed < walInfo.log) {
            // PASSIVE didn't fully checkpoint — escalate to RESTART (briefly blocks writers)
            this.db.pragma('wal_checkpoint(RESTART)');
          }
        } catch { /* best effort */ }
      } catch (err) {
        console.error(`[Logger] Cleanup failed: ${err.message}`);
      }
    }, 60 * 60 * 1000);

    if (this._cleanupInterval.unref) {
      this._cleanupInterval.unref();
    }
  }

  _initFiles() {
    // Ensure log directory exists
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }

    this.mainLog = new FileRotator(path.join(this.logDir, 'strategos.log'));
    this.errorLog = new FileRotator(path.join(this.logDir, 'error.log'));
  }

  _getCallerInfo() {
    const stack = new Error().stack;
    const lines = stack.split('\n');
    // Skip Error, _getCallerInfo, _log, and the public method
    for (let i = 4; i < lines.length; i++) {
      const line = lines[i];
      if (!line.includes('logger.js')) {
        const match = line.match(/at (?:(.+?) \()?(.+?):(\d+):\d+\)?/);
        if (match) {
          const fn = match[1] || 'anonymous';
          const file = path.basename(match[2]);
          const lineNum = match[3];
          return `${file}:${lineNum}${fn !== 'anonymous' ? ` (${fn})` : ''}`;
        }
      }
    }
    return null;
  }

  _formatMessage(level, message, context) {
    const timestamp = new Date().toISOString();
    const levelName = LEVEL_NAMES[level];
    const source = this._getCallerInfo();

    let line = `[${timestamp}] [${levelName}]`;
    if (source) {
      line += ` [${source}]`;
    }
    // Sanitize newlines/carriage returns to prevent log injection
    const safeMessage = typeof message === 'string'
      ? message.replace(/\n/g, '\\n').replace(/\r/g, '\\r')
      : String(message);
    line += ` ${safeMessage}`;
    if (context && Object.keys(context).length > 0) {
      line += ` ${JSON.stringify(context)}`;
    }
    return { timestamp, levelName, source, line: line + '\n' };
  }

  _log(level, message, context = {}) {
    if (level < this.minLevel) return;

    // Reentrancy guard - prevent infinite loops when logging triggers errors
    if (this._isLogging) return;

    // Rate limiting - reset counter every second
    const now = Date.now();
    if (now - this._lastErrorReset > 1000) {
      this._errorCount = 0;
      this._lastErrorReset = now;
    }

    // If we're getting too many logs per second, drop them
    if (this._errorCount >= this._maxErrorsPerSecond) {
      return;
    }
    this._errorCount++;

    this._isLogging = true;
    try {
      const { timestamp, levelName, source, line } = this._formatMessage(level, message, context);

      // Write to console only if not disabled
      if (!this.consoleDisabled) {
        try {
          if (level >= LogLevel.ERROR) {
            process.stderr.write(line);
          } else {
            process.stdout.write(line);
          }
        } catch (err) {
          // EPIPE or other stream error - permanently disable console output
          this.consoleDisabled = true;
        }
      }

      // Write to files
      try {
        this.mainLog?.write(line);
        if (level >= LogLevel.ERROR) {
          this.errorLog?.write(line);
        }
      } catch (err) {
        // File write failed, continue to database
      }

      // Write to database
      try {
        this._insertLog?.run(
          timestamp,
          levelName,
          source,
          message,
          Object.keys(context).length > 0 ? JSON.stringify(context) : null
        );
        this.logCount++;
      } catch (err) {
        // Database write failed - nothing more we can do
      }
    } finally {
      this._isLogging = false;
    }
  }

  // Public logging methods
  debug(message, context) { this._log(LogLevel.DEBUG, message, context); }
  info(message, context) { this._log(LogLevel.INFO, message, context); }
  warn(message, context) { this._log(LogLevel.WARN, message, context); }
  error(message, context) { this._log(LogLevel.ERROR, message, context); }
  fatal(message, context) { this._log(LogLevel.FATAL, message, context); }

  // Lifecycle event logging
  logLifecycle(eventType, reason = null, extra = {}) {
    // Use same reentrancy guard as _log
    if (this._isLogging) return;

    const timestamp = new Date().toISOString();
    const uptimeSeconds = Math.floor((Date.now() - this.startTime) / 1000);

    let memoryStr = '{}';
    try {
      const memUsage = process.memoryUsage();
      memoryStr = JSON.stringify({
        heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024) + 'MB',
        heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024) + 'MB',
        rss: Math.round(memUsage.rss / 1024 / 1024) + 'MB'
      });
    } catch {
      // Ignore memory read errors
    }

    try {
      this._insertLifecycle?.run(
        timestamp,
        eventType,
        reason,
        uptimeSeconds,
        process.version,
        memoryStr,
        Object.keys(extra).length > 0 ? JSON.stringify(extra) : null
      );
    } catch (err) {
      // Don't call this.error() here - it could cause recursion
      // Just silently fail
    }

    // Also log as regular log entry (this has its own guards)
    this.info(`Lifecycle: ${eventType}`, { reason, uptimeSeconds, ...extra });
  }

  // Query methods for API
  queryLogs(options = {}) {
    const { level, from, to, limit = 100 } = options;
    return this._queryLogs.all(
      level || null, level || null,
      from || null, from || null,
      to || null, to || null,
      Math.min(limit, 1000)
    );
  }

  queryLifecycle(limit = 50) {
    return this._queryLifecycle.all(Math.min(limit, 200));
  }

  getStats() {
    const counts = this._statsByLevel.all();
    const recentErrors = this._statsRecentErrors.get();

    return {
      totalLogs: this.logCount,
      uptimeSeconds: Math.floor((Date.now() - this.startTime) / 1000),
      byLevel: Object.fromEntries(counts.map(r => [r.level, r.count])),
      recentErrors: recentErrors?.count || 0
    };
  }

  close(callback) {
    if (this._cleanupInterval) {
      clearInterval(this._cleanupInterval);
      this._cleanupInterval = null;
    }

    // Flush file streams before closing database
    let remaining = 0;
    const onStreamDone = () => {
      if (--remaining > 0) return;
      // All streams flushed — now safe to close database
      if (this.db) {
        try {
          this.db.pragma('wal_checkpoint(TRUNCATE)');
        } catch {
          // Best effort WAL checkpoint
        }
        this.db.close();
        this.db = null;
      }
      if (callback) callback();
    };

    if (this.mainLog) remaining++;
    if (this.errorLog) remaining++;

    if (remaining === 0) {
      // No file rotators to flush
      onStreamDone();
      remaining = 1; // prevent double call
      return;
    }

    // Close rotators with flush callbacks
    if (this.mainLog) this.mainLog.close(onStreamDone);
    if (this.errorLog) this.errorLog.close(onStreamDone);

    // Safety timeout: if streams don't flush in 5 seconds, force close anyway
    setTimeout(() => {
      if (this.db) {
        try { this.db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* best effort */ }
        try { this.db.close(); } catch { /* best effort */ }
        this.db = null;
      }
    }, 5000).unref();
  }
}

// ============================================
// SINGLETON INSTANCE
// ============================================

let loggerInstance = null;

export function initLogger(options = {}) {
  if (loggerInstance) {
    return loggerInstance;
  }
  loggerInstance = new Logger(options);
  return loggerInstance;
}

export function getLogger() {
  if (!loggerInstance) {
    loggerInstance = new Logger();
  }
  return loggerInstance;
}

export default { initLogger, getLogger, LogLevel, LifecycleEvent };
