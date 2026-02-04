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
  }

  _rotate() {
    this.stream.end();

    // Rotate existing files
    for (let i = MAX_LOG_FILES - 1; i >= 1; i--) {
      const oldPath = i === 1 ? this.logPath : `${this.logPath}.${i}`;
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
    const bytes = Buffer.byteLength(line, 'utf8');
    if (this.currentSize + bytes > MAX_LOG_SIZE) {
      this._rotate();
    }
    this.stream.write(line);
    this.currentSize += bytes;
  }

  close() {
    if (this.stream) {
      this.stream.end();
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

    // Cleanup old logs (keep 7 days)
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    this.db.prepare('DELETE FROM server_logs WHERE timestamp < ?').run(cutoff);
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
    line += ` ${message}`;
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
    const counts = this.db.prepare(`
      SELECT level, COUNT(*) as count FROM server_logs
      GROUP BY level
    `).all();

    const recentErrors = this.db.prepare(`
      SELECT COUNT(*) as count FROM server_logs
      WHERE level IN ('ERROR', 'FATAL')
        AND timestamp > datetime('now', '-1 hour')
    `).get();

    return {
      totalLogs: this.logCount,
      uptimeSeconds: Math.floor((Date.now() - this.startTime) / 1000),
      byLevel: Object.fromEntries(counts.map(r => [r.level, r.count])),
      recentErrors: recentErrors?.count || 0
    };
  }

  close() {
    this.mainLog?.close();
    this.errorLog?.close();
    this.db?.close();
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

// Convenience exports
export const debug = (msg, ctx) => getLogger().debug(msg, ctx);
export const info = (msg, ctx) => getLogger().info(msg, ctx);
export const warn = (msg, ctx) => getLogger().warn(msg, ctx);
export const error = (msg, ctx) => getLogger().error(msg, ctx);
export const fatal = (msg, ctx) => getLogger().fatal(msg, ctx);
export const logLifecycle = (type, reason, extra) => getLogger().logLifecycle(type, reason, extra);

export default { initLogger, getLogger, LogLevel, LifecycleEvent };
