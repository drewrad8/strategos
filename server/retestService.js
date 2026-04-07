/**
 * retestService.js — Retest execution engine for auto-retest system.
 *
 * Manages retest runs: triggering, executing Playwright specs via child_process.spawn,
 * tracking results in-memory, and emitting Socket.io events for real-time UI updates.
 *
 * Phase 1: No DB persistence — in-memory Map with bounded size (max 50 runs).
 * Phase 2+ will add SQLite persistence.
 *
 * Spec: research/33-auto-retest-framework.md Sections 5.2, 5.3, 10
 */

import crypto from 'crypto';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { resolveTests, getChangedFiles } from './retestMapper.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

// All known test files in e2e/ (both Playwright .spec.js and standalone .test.js)
const ALL_SPECS = [
  'orchestrator.spec.js',
  'visual-verification.spec.js',
  'worker-lifecycle.spec.js',
  'ipad-responsive.spec.js',
  'sidebar-tabs.spec.js',
  'user-workflow.spec.js',
  'projects-tab.spec.js',
  'multi-terminal.spec.js',
  'quick-check.spec.js',
  'strategos-architect-integration.spec.js',
  'api-verification.test.js',
  'general-enforcement.test.js',
  'ralph-signal.test.js',
  'reflexion-features.test.js',
  'review-gate.test.js',
  'blackboard.test.js',
  'improvement-wave-features.test.js',
];

const MAX_RUNS = 50;

class RetestService {
  /**
   * @param {import('socket.io').Server} io - Socket.io server instance
   */
  constructor(io) {
    this.io = io;
    /** @type {Map<string, object>} runId → run object */
    this.runs = new Map();
    /** @type {import('child_process').ChildProcess|null} */
    this.activeProcess = null;
    /** @type {string|null} ID of the currently executing run */
    this.activeRunId = null;
  }

  /**
   * Trigger a new retest run.
   *
   * @param {object} params
   * @param {'auto'|'manual'|'full'} params.mode
   * @param {string[]} [params.files] - Changed files (for mode=manual)
   * @param {string[]} [params.specs] - Specific specs to run (for mode=manual)
   * @param {string}   [params.ref]   - Git ref for diff (for mode=auto, default HEAD~1)
   * @returns {Promise<object>} The created run object
   */
  async triggerRetest({ mode, files, specs, ref }) {
    if (this.activeRunId) {
      throw new Error('A retest run is already in progress (runId: ' + this.activeRunId + ')');
    }

    const runId = crypto.randomUUID();
    let changedFiles = [];
    let triggeredSpecs = [];

    if (mode === 'auto') {
      changedFiles = await getChangedFiles(ref || 'HEAD~1');
      triggeredSpecs = resolveTests(changedFiles);
    } else if (mode === 'manual') {
      changedFiles = files || [];
      if (specs && specs.length > 0) {
        triggeredSpecs = specs;
      } else if (changedFiles.length > 0) {
        triggeredSpecs = resolveTests(changedFiles);
      }
    } else if (mode === 'full') {
      triggeredSpecs = [...ALL_SPECS];
    }

    const run = {
      runId,
      status: 'queued',
      trigger: mode,
      changedFiles,
      triggeredAt: new Date().toISOString(),
      completedAt: null,
      specs: triggeredSpecs.map(name => ({
        name,
        status: 'pending',
        duration: null,
        errors: [],
      })),
      summary: null,
    };

    // Enforce max runs — evict oldest
    this._evictIfNeeded();
    this.runs.set(runId, run);

    // If no specs resolved, mark as completed immediately
    if (triggeredSpecs.length === 0) {
      run.status = 'completed';
      run.completedAt = new Date().toISOString();
      run.summary = { total: 0, passed: 0, failed: 0, skipped: 0, duration: 0 };
      this.io.emit('retest:completed', {
        runId,
        status: 'completed',
        summary: run.summary,
      });
      return { runId, status: run.status, triggeredSpecs, changedFiles };
    }

    this.io.emit('retest:started', {
      runId,
      trigger: mode,
      changedFiles,
      specs: run.specs.map(s => s.name),
    });

    // Execute asynchronously — don't await, return immediately
    this.executeRun(run).catch(err => {
      console.error(`[retestService] executeRun error for ${runId}:`, err.message);
    });

    return { runId, status: run.status, triggeredSpecs, changedFiles };
  }

  /**
   * Execute all specs in a run sequentially (max 1 Playwright process at a time).
   *
   * @param {object} run - The run object from this.runs
   */
  async executeRun(run) {
    run.status = 'running';
    const startTime = Date.now();

    for (const spec of run.specs) {
      // Check if the run was cancelled
      if (run.status === 'cancelled') break;

      spec.status = 'running';
      this.io.emit('retest:spec:started', { runId: run.runId, specName: spec.name });

      try {
        const result = await this._runSingleSpec(spec.name, run.runId);
        spec.status = result.passed ? 'passed' : 'failed';
        spec.duration = result.duration;
        spec.errors = result.errors || [];
      } catch (err) {
        spec.status = 'failed';
        spec.errors = [err.message];
        spec.duration = null;
      }

      // If cancelled mid-spec, mark the spec as skipped instead of passed/failed
      if (run.status === 'cancelled') {
        spec.status = 'skipped';
      }

      this.io.emit('retest:spec:completed', {
        runId: run.runId,
        specName: spec.name,
        status: spec.status,
        duration: spec.duration,
        errors: spec.errors,
      });
    }

    this.activeProcess = null;
    this.activeRunId = null;

    // Skip summary if cancelled
    if (run.status === 'cancelled') return;

    // Compute summary
    const passed = run.specs.filter(s => s.status === 'passed').length;
    const failed = run.specs.filter(s => s.status === 'failed').length;
    const skipped = run.specs.filter(s => s.status === 'pending' || s.status === 'skipped').length;
    const totalDuration = Date.now() - startTime;

    run.summary = {
      total: run.specs.length,
      passed,
      failed,
      skipped,
      duration: totalDuration,
    };

    run.status = failed > 0 ? 'failed' : 'completed';
    run.completedAt = new Date().toISOString();

    this.io.emit('retest:completed', {
      runId: run.runId,
      status: run.status,
      summary: run.summary,
    });
  }

  /**
   * Run a single test spec as a child process.
   * Detects runner type by extension:
   *   - .spec.js → Playwright (npx playwright test ... --reporter=json)
   *   - .test.js → Standalone Node script (node e2e/file.test.js)
   *
   * @param {string} specName - e.g. "visual-verification.spec.js" or "api-verification.test.js"
   * @param {string} runId - The run ID (for tracking active process)
   * @returns {Promise<{passed: boolean, duration: number, errors: string[]}>}
   */
  _runSingleSpec(specName, runId) {
    return new Promise((resolve, reject) => {
      const specPath = `e2e/${specName}`;
      const isStandalone = specName.endsWith('.test.js');

      let command, args;
      if (isStandalone) {
        command = 'node';
        args = [specPath];
      } else {
        command = 'npx';
        args = ['playwright', 'test', specPath, '--reporter=json'];
      }

      const child = spawn(command, args, {
        cwd: PROJECT_ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
        timeout: 120000, // 2 minute timeout per spec
      });

      this.activeProcess = child;
      this.activeRunId = runId;

      const stdoutChunks = [];
      const stderrChunks = [];

      child.stdout.on('data', (chunk) => {
        stdoutChunks.push(chunk);
      });

      child.stderr.on('data', (chunk) => {
        stderrChunks.push(chunk);
      });

      child.on('error', (err) => {
        this.activeProcess = null;
        this.activeRunId = null;
        if (err.code === 'ENOENT') {
          reject(new Error(`${command} not found — ensure Node.js/npm is in PATH`));
        } else {
          reject(new Error(`Process error: ${err.message}`));
        }
      });

      child.on('close', (code, signal) => {
        this.activeProcess = null;
        this.activeRunId = null;

        if (signal === 'SIGTERM' || signal === 'SIGKILL') {
          resolve({ passed: false, duration: 0, errors: ['Run was cancelled'] });
          return;
        }

        const stdout = Buffer.concat(stdoutChunks).toString('utf8');
        const stderr = Buffer.concat(stderrChunks).toString('utf8');

        // Standalone .test.js files: use exit code (no JSON reporter)
        if (isStandalone) {
          if (code === 0) {
            resolve({ passed: true, duration: 0, errors: [] });
          } else {
            const errors = [];
            if (stderr.trim()) {
              const lines = stderr.trim().split('\n');
              errors.push(lines.slice(-5).join('\n'));
            }
            if (stdout.trim()) {
              const lines = stdout.trim().split('\n');
              errors.push(lines.slice(-5).join('\n'));
            }
            if (errors.length === 0) {
              errors.push(`node exited with code ${code}`);
            }
            resolve({ passed: false, duration: 0, errors });
          }
          return;
        }

        // Playwright .spec.js files: try to parse JSON output
        try {
          const report = JSON.parse(stdout);
          const result = this._parsePlaywrightReport(report);
          resolve(result);
        } catch {
          // JSON parsing failed — fall back to exit code
          if (code === 0) {
            resolve({ passed: true, duration: 0, errors: [] });
          } else {
            const errors = [];
            if (stderr.trim()) {
              const lines = stderr.trim().split('\n');
              const tail = lines.slice(-5).join('\n');
              errors.push(tail);
            }
            if (errors.length === 0) {
              errors.push(`Playwright exited with code ${code}`);
            }
            resolve({ passed: false, duration: 0, errors });
          }
        }
      });
    });
  }

  /**
   * Parse a Playwright JSON reporter output into our result shape.
   *
   * @param {object} report - Parsed JSON from Playwright --reporter=json
   * @returns {{passed: boolean, duration: number, errors: string[]}}
   */
  _parsePlaywrightReport(report) {
    const errors = [];
    let totalDuration = 0;
    let allPassed = true;

    if (report.suites) {
      for (const suite of report.suites) {
        this._collectSuiteResults(suite, errors);
      }
    }

    // Top-level stats if available
    if (report.stats) {
      totalDuration = report.stats.duration || 0;
      if (report.stats.unexpected > 0 || report.stats.flaky > 0) {
        allPassed = false;
      }
    } else {
      // Infer from errors
      allPassed = errors.length === 0;
    }

    return { passed: allPassed, duration: totalDuration, errors };
  }

  /**
   * Recursively collect errors from Playwright suite structure.
   */
  _collectSuiteResults(suite, errors) {
    if (suite.specs) {
      for (const spec of suite.specs) {
        for (const test of spec.tests || []) {
          for (const result of test.results || []) {
            if (result.status === 'failed' || result.status === 'timedOut') {
              const msg = result.error?.message || result.error?.snippet || `Test failed: ${spec.title}`;
              errors.push(msg.slice(0, 500)); // cap error message length
            }
          }
        }
      }
    }
    // Recurse into child suites
    if (suite.suites) {
      for (const child of suite.suites) {
        this._collectSuiteResults(child, errors);
      }
    }
  }

  /**
   * Cancel a running retest run.
   * @param {string} runId
   * @returns {{success: boolean, message: string}}
   */
  cancelRun(runId) {
    const run = this.runs.get(runId);
    if (!run) {
      return { success: false, message: 'Run not found' };
    }
    if (run.status !== 'running' && run.status !== 'queued') {
      return { success: false, message: `Run is already ${run.status}` };
    }

    run.status = 'cancelled';
    run.completedAt = new Date().toISOString();

    // Mark pending specs as skipped
    for (const spec of run.specs) {
      if (spec.status === 'pending' || spec.status === 'running') {
        spec.status = 'skipped';
      }
    }

    // Kill active process if it belongs to this run
    if (this.activeProcess && this.activeRunId === runId) {
      this.activeProcess.kill('SIGTERM');
      this.activeProcess = null;
      this.activeRunId = null;
    }

    this.io.emit('retest:cancelled', { runId });
    return { success: true, message: 'Run cancelled' };
  }

  /**
   * Get the most recent run.
   * @returns {object|null}
   */
  getLastRun() {
    let latest = null;
    for (const run of this.runs.values()) {
      if (!latest || run.triggeredAt > latest.triggeredAt) {
        latest = run;
      }
    }
    return latest;
  }

  /**
   * Get a specific run by ID.
   * @param {string} runId
   * @returns {object|null}
   */
  getRun(runId) {
    return this.runs.get(runId) || null;
  }

  /**
   * Get recent runs, optionally limited.
   * @param {number} [limit=20]
   * @returns {object[]} Runs sorted by triggeredAt descending
   */
  getRuns(limit = 20) {
    const all = Array.from(this.runs.values());
    all.sort((a, b) => b.triggeredAt.localeCompare(a.triggeredAt));
    return all.slice(0, limit);
  }

  /**
   * Evict oldest runs if we've hit the max.
   */
  _evictIfNeeded() {
    if (this.runs.size < MAX_RUNS) return;

    // Find and delete the oldest run(s) until under limit
    const sorted = Array.from(this.runs.entries())
      .filter(([, run]) => run.status !== 'running' && run.status !== 'queued')
      .sort((a, b) => a[1].triggeredAt.localeCompare(b[1].triggeredAt));

    const toRemove = sorted.slice(0, this.runs.size - MAX_RUNS + 1);
    for (const [id] of toRemove) {
      this.runs.delete(id);
    }
  }
}

/**
 * Factory function — creates a RetestService instance.
 *
 * @param {import('socket.io').Server} io - Socket.io server instance
 * @returns {RetestService}
 */
export function createRetestService(io) {
  return new RetestService(io);
}
