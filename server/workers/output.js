/**
 * Output capture, auto-accept, input handling, bulldoze mode, and worker settings.
 * Manages PTY capture intervals, command queuing, and autonomous operation modes.
 */

import crypto from 'crypto';
import {
  workers, outputBuffers, commandQueues, ptyInstances, sessionFailCounts,
  pendingWorkers, autoCleanupTimers, lastResizeSize, respawnAttempts,
  _sendingInput, _processingQueues,
  SESSION_FAIL_THRESHOLD, PROCESS_QUEUE_MAX_DRAIN, PROCESS_QUEUE_DELAY_MS, MAX_QUEUE_SIZE,
  path, fs, execAsync,
  simpleHash, stripAnsiCodes, normalizeWorker, addActivity,
  spawnTmux, safeSendKeys, validateSessionName,
  getWorkerDeathCallback, STRATEGOS_API,
} from './state.js';

import {
  AUTO_ACCEPT_PATTERNS, CLAUDE_CODE_IDLE_PATTERNS, CLAUDE_CODE_ACTIVE_PATTERNS,
  AUTO_COMMAND_PATTERNS, AUTO_ACCEPT_PAUSE_KEYWORDS,
  GEMINI_IDLE_PATTERNS, GEMINI_ACTIVE_PATTERNS, GEMINI_AUTO_ACCEPT_PATTERNS,
  BULLDOZE_IDLE_THRESHOLD, BULLDOZE_AUDIT_EVERY_N_CYCLES, BULLDOZE_MAX_HOURS,
  BULLDOZE_MAX_COMPACTIONS, BULLDOZE_CONTINUATION_PREFIX,
  RATE_LIMIT_PATTERN, RATE_LIMIT_RESET_RE, COMPACTION_PATTERN,
  AUTO_CONTINUE_IDLE_THRESHOLD, AUTO_CONTINUE_RATE_LIMIT_COOLDOWN,
  AUTO_CONTINUE_MAX_ATTEMPTS, AUTO_CONTINUE_MESSAGE,
  detectWorkerType, isProtectedWorker,
  writeStrategosContext,
  writeGeminiContext,
} from './templates.js';

import {
  storeOutput as dbStoreOutput,
} from '../workerOutputDb.js';
import { clearWorkerContext } from '../summaryService.js';
import {
  markWorkerFailed,
  removeWorkerDependencies,
} from '../dependencyGraph.js';

// Global PTY capture interval
let globalCaptureInterval = null;

// ============================================
// GENERAL ROLE-VIOLATION DETECTION (SENTINEL)
// ============================================

// Claude Code v2.1.50 renders tools as:
//   Write(filename)  — file creation
//   Update(filename) — file edit (the Edit tool)
//   Edit(filename)   — also possible in some versions
// Match both the internal names (Edit:/Write:) and the rendered names (Update(/Write()
const GENERAL_VIOLATION_PATTERNS = [
  { pattern: /● (?:Edit|Update)\(/,  description: 'use the Edit tool (file modification)' },
  { pattern: /● Write\(/,            description: 'use the Write tool (file creation)' },
  { pattern: /● NotebookEdit\(/,     description: 'use the NotebookEdit tool (notebook modification)' },
  { pattern: /\bEdit:\s/,            description: 'use the Edit tool (legacy format)' },
  { pattern: /\bWrite:\s/,           description: 'use the Write tool (legacy format)' },
  { pattern: /\bNotebookEdit:\s/,    description: 'use the NotebookEdit tool (legacy format)' },
  { pattern: /\bAdded \d+ lines, removed \d+ lines/, description: 'edit files (diff output detected)' },
  { pattern: /\bWrote \d+ lines to\b/,               description: 'write files (write output detected)' },
];

// Bash: followed by implementation commands — but NOT legitimate commander actions
const GENERAL_IMPL_BASH_RE = /\bBash:\s.*?\b(npm|node|python|python3|pip|pip3|sed|awk|gcc|g\+\+|cargo|make|cmake|rustc|javac|go build|go run|tsc|webpack|vite|esbuild|npx playwright|npx jest|pytest)\b/;

// Bash: followed by legitimate commander actions (git, curl, ls, cat, jq, etc.)
const GENERAL_ALLOWED_BASH_RE = /\bBash:\s.*?\b(git|curl|ls|cat|head|tail|jq|wc|echo|printf|pwd|whoami|date|uptime|df|du|ps|grep|find|which|env|export)\b/;

async function checkGeneralRoleViolation(workerId, output, io) {
  const worker = workers.get(workerId);
  if (!worker) return;

  // Only check GENERAL-labeled workers
  if (!isProtectedWorker(worker)) return;

  const cleaned = stripAnsiCodes(output);
  const tail = cleaned.slice(-2000);

  // Deduplicate: don't re-trigger on the same output
  const tailHash = simpleHash(tail);
  if (tailHash === worker._lastViolationHash) return;

  let violation = null;

  // Check file-modification tool patterns
  for (const { pattern, description } of GENERAL_VIOLATION_PATTERNS) {
    if (pattern.test(tail)) {
      violation = description;
      break;
    }
  }

  // Check implementation bash commands (only flag if NOT also matching allowed patterns)
  if (!violation && GENERAL_IMPL_BASH_RE.test(tail)) {
    // Extract the matched bash line to check if it also contains allowed commands
    const bashLines = tail.split('\n').filter(line => /\bBash:\s/.test(line));
    for (const line of bashLines) {
      if (GENERAL_IMPL_BASH_RE.test(line) && !GENERAL_ALLOWED_BASH_RE.test(line)) {
        violation = 'run implementation commands via Bash';
        break;
      }
    }
  }

  if (!violation) return;

  // Update dedup hash
  worker._lastViolationHash = tailHash;

  // Increment both counters (roleViolations for normalizeWorker, delegationMetrics for structured tracking)
  worker.roleViolations = (worker.roleViolations || 0) + 1;
  if (!worker.delegationMetrics) {
    worker.delegationMetrics = { spawnsIssued: 0, roleViolations: 0, filesEdited: 0, commandsRun: 0 };
  }
  worker.delegationMetrics.roleViolations = worker.roleViolations;

  const correctionMessage = `ROLE VIOLATION: You are a GENERAL. You just attempted to ${violation}. Generals do NOT write code, edit files, or run implementation commands. Spawn a worker instead: curl -s -X POST http://localhost:38007/api/workers/spawn-from-template -H "Content-Type: application/json" -d '{"template":"impl","label":"IMPL: <task>","projectPath":"<path>","parentWorkerId":"${workerId}","task":{"description":"<what needs doing>"}}'`;

  console.log(`[Sentinel] ROLE VIOLATION detected for GENERAL ${workerId} (${worker.label}): ${violation} (count: ${worker.roleViolations})`);

  // Emit socket event
  if (io) {
    io.emit('worker:role:violation', {
      workerId,
      label: worker.label,
      violation,
      count: worker.roleViolations,
      timestamp: new Date().toISOString(),
    });
    io.emit('worker:updated', normalizeWorker(worker));
  }

  // Interrupt the worker with correction
  try {
    await interruptWorker(workerId, correctionMessage, io);
    console.log(`[Sentinel] Interrupted GENERAL ${workerId} with correction message`);
  } catch (err) {
    console.error(`[Sentinel] Failed to interrupt GENERAL ${workerId}: ${err.message}`);
  }
}

// ============================================
// AUTO-CONTINUE: Rate Limit + Post-Compaction Recovery
// ============================================

/**
 * Parse rate limit reset time from Claude Code output.
 * Input: "9am", "3pm", "12:30pm" + timezone like "America/New_York"
 * Returns: Unix timestamp of the reset time, or null if parsing fails.
 */
function parseRateLimitResetTime(hours, minutes, ampm, timezone) {
  try {
    let h = parseInt(hours);
    const m = parseInt(minutes || '0');
    const period = ampm.toLowerCase();

    if (period === 'pm' && h !== 12) h += 12;
    if (period === 'am' && h === 12) h = 0;

    // Get current time in the target timezone
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric', minute: 'numeric', hour12: false,
    });
    const parts = formatter.formatToParts(now);
    const currentHour = parseInt(parts.find(p => p.type === 'hour').value);
    const currentMinute = parseInt(parts.find(p => p.type === 'minute').value);

    let diffMinutes = (h * 60 + m) - (currentHour * 60 + currentMinute);
    if (diffMinutes <= 0) {
      if (diffMinutes > -120) {
        // Reset time was within the last 2 hours — already passed, continue immediately
        return Date.now();
      }
      diffMinutes += 24 * 60; // More than 2 hours ago → must be tomorrow
    }

    // Add 2-minute buffer so we don't fire the instant the limit resets
    return Date.now() + (diffMinutes + 2) * 60 * 1000;
  } catch {
    return null;
  }
}

/**
 * Detect rate limits and compaction in worker output (called when output changes).
 * Sets flags on the worker object for the idle-phase handler to act on.
 */
function detectSessionLimits(workerId, stdout, io) {
  const worker = workers.get(workerId);
  if (!worker || worker.autoContinue === false) return;
  if (worker.backend === 'gemini') return; // Gemini patterns TBD

  // trimEnd() strips trailing whitespace from empty tmux pane rows
  // that can push rate limit text beyond the 1500-char tail window
  const cleaned = stripAnsiCodes(stdout).trimEnd();
  const tail = cleaned.slice(-1500);

  // --- Rate limit detection ---
  const isRateLimited = RATE_LIMIT_PATTERN.test(tail);

  if (isRateLimited && !worker._rateLimitDetected) {
    // Newly detected rate limit
    worker._rateLimitDetected = true;
    worker._sessionLimitDetected = true;
    worker._rateLimitDetectedAt = Date.now();
    worker._autoContinueIdleCount = 0;
    worker._autoContinueAttempts = 0;
    worker._autoContinueExhausted = false;
    worker.rateLimited = true;

    // Try to parse reset time
    const resetMatch = tail.match(RATE_LIMIT_RESET_RE);
    if (resetMatch) {
      worker.rateLimitResetAt = parseRateLimitResetTime(
        resetMatch[1], resetMatch[2], resetMatch[3], resetMatch[4]);
      console.log(`[AutoContinue] Rate limit detected for ${worker.label} (${workerId}), resets ~${new Date(worker.rateLimitResetAt).toLocaleTimeString()}`);
    } else {
      worker.rateLimitResetAt = null;
      console.log(`[AutoContinue] Rate limit detected for ${worker.label} (${workerId}), reset time unknown`);
    }

    if (io) {
      io.emit('worker:rate_limited', { workerId, label: worker.label, resetAt: worker.rateLimitResetAt });
      io.emit('worker:updated', normalizeWorker(worker));
    }
  } else if (!isRateLimited && worker._rateLimitDetected) {
    // Rate limit cleared — worker output no longer shows rate limit in tail
    worker._rateLimitDetected = false;
    worker._sessionLimitDetected = false;
    worker.rateLimited = false;
    worker.rateLimitResetAt = null;
    worker._autoContinueIdleCount = 0;
    console.log(`[AutoContinue] Rate limit cleared for ${worker.label} (${workerId})`);
    if (io) io.emit('worker:updated', normalizeWorker(worker));
  }

  // --- Compaction detection (only when no rate limit) ---
  if (!worker._rateLimitDetected) {
    const isCompacted = COMPACTION_PATTERN.test(tail);

    if (isCompacted && !worker._compactionDetected) {
      worker._compactionDetected = true;
      worker._sessionLimitDetected = true;
      worker._autoContinueIdleCount = 0;
      worker._autoContinueAttempts = 0;
      worker._autoContinueExhausted = false;
      console.log(`[AutoContinue] Compaction detected for ${worker.label} (${workerId})`);
    } else if (!isCompacted && worker._compactionDetected) {
      // Compaction scrolled off — worker resumed
      worker._compactionDetected = false;
      if (!worker._rateLimitDetected) {
        worker._sessionLimitDetected = false;
      }
      worker._autoContinueIdleCount = 0;
    }
  }
}

/**
 * Send a continuation message to an idle worker after rate limit or compaction.
 * Called from the idle-detection loop when conditions are met.
 */
async function handleAutoContinue(workerId, io) {
  const worker = workers.get(workerId);
  if (!worker) return;

  // Guard: don't exceed max attempts
  if ((worker._autoContinueAttempts || 0) >= AUTO_CONTINUE_MAX_ATTEMPTS) {
    if (!worker._autoContinueExhausted) {
      worker._autoContinueExhausted = true;
      console.warn(`[AutoContinue] Max attempts (${AUTO_CONTINUE_MAX_ATTEMPTS}) reached for ${worker.label} (${workerId})`);
      if (io) {
        io.emit('worker:autocontinue:exhausted', { workerId, label: worker.label, attempts: AUTO_CONTINUE_MAX_ATTEMPTS });
      }
    }
    return;
  }

  // Guard: don't send if already sending input
  if (_sendingInput.has(workerId)) return;

  // Guard: don't send if queue has pending items
  const queue = commandQueues.get(workerId) || [];
  if (queue.length > 0) return;

  worker._autoContinueAttempts = (worker._autoContinueAttempts || 0) + 1;

  const trigger = worker._rateLimitDetected ? 'rate_limit' : 'compaction';

  try {
    await sendInput(workerId, AUTO_CONTINUE_MESSAGE, io);

    // Clear _sessionLimitDetected to stop the idle handler from re-firing.
    // Do NOT clear _rateLimitDetected or _compactionDetected — those must stay true
    // so detectSessionLimits() skips re-detection of the same stale tail text.
    // They clear naturally when the text scrolls off (lines 229-238, 251-257).
    worker._sessionLimitDetected = false;
    worker.rateLimited = false;
    worker.rateLimitResetAt = null;

    worker.autoContinueCount = (worker.autoContinueCount || 0) + 1;
    worker.lastActivity = new Date();
    console.log(`[AutoContinue] Sent continuation to ${worker.label} (${workerId}), attempt ${worker._autoContinueAttempts}/${AUTO_CONTINUE_MAX_ATTEMPTS}`);
    if (io) {
      io.emit('worker:autocontinue', {
        workerId, label: worker.label,
        attempt: worker._autoContinueAttempts,
        trigger,
      });
      io.emit('worker:updated', normalizeWorker(worker));
    }
  } catch (err) {
    console.error(`[AutoContinue] Failed for ${worker.label} (${workerId}): ${err.message}`);
  }
}

// ============================================
// PTY-BASED REAL-TIME OUTPUT CAPTURE
// ============================================

export function startPtyCapture(workerId, sessionName, io) {
  ptyInstances.delete(workerId);

  const worker = workers.get(workerId);
  if (!worker) return;

  ptyInstances.set(workerId, {
    sessionName,
    lastCaptureHash: '',
    initialChecksDone: false,
    startTime: Date.now(),
  });

  setTimeout(() => {
    const instance = ptyInstances.get(workerId);
    if (instance) instance.initialChecksDone = true;
  }, 5000);

  if (!globalCaptureInterval) {
    startGlobalPtyCapture(io);
  }
}

function startGlobalPtyCapture(io) {
  if (globalCaptureInterval) return;
  console.log('[PtyCapture] Starting global capture interval (every 5s)');

  globalCaptureInterval = setInterval(async () => {
    const entries = [...ptyInstances.entries()];
    for (const [workerId, instance] of entries) {
      if (!workers.has(workerId)) {
        ptyInstances.delete(workerId);
        continue;
      }
      try {
        await captureWorkerOutput(workerId, instance, io);
      } catch (err) {
        console.error(`[PtyCapture] Unhandled error for ${workerId}: ${err.message}`);
      }
    }
  }, 5000);

  if (globalCaptureInterval.unref) {
    globalCaptureInterval.unref();
  }
}

async function captureWorkerOutput(workerId, instance, io) {
  try {
    let { stdout } = await spawnTmux([
      'capture-pane', '-t', instance.sessionName, '-p', '-e', '-S', '-500'
    ]);

    if (sessionFailCounts.has(workerId)) {
      sessionFailCounts.delete(workerId);
    }

    const mid = Math.floor(stdout.length / 2);
    const hash = `${stdout.length}:${stdout.slice(-200)}:${stdout.slice(mid, mid + 50)}`;
    const outputChanged = hash !== instance.lastCaptureHash;

    const worker = workers.get(workerId);

    if (worker) {
      handleAutoAcceptCheck(workerId, stdout, io).catch(err =>
        console.error(`[PtyCapture] autoAcceptCheck failed for ${workerId}: ${err.message}`));
      checkGeneralRoleViolation(workerId, stdout, io).catch(err =>
        console.error(`[PtyCapture] generalRoleViolation check failed for ${workerId}: ${err.message}`));
    }

    const MAX_OUTPUT_BUFFER = 2 * 1024 * 1024;
    if (stdout.length > MAX_OUTPUT_BUFFER) {
      if (!worker?._outputTruncationLogged) {
        console.warn(`[PtyCapture] Worker ${workerId} output exceeds 2MB, truncating oldest data`);
        if (worker) worker._outputTruncationLogged = true;
      }
      stdout = stdout.slice(-MAX_OUTPUT_BUFFER);
    }
    outputBuffers.set(workerId, stdout);

    if (!outputChanged) {
      // Bulldoze continuation (existing)
      if (worker && worker.bulldozeMode && !worker.bulldozePaused && worker.status === 'running') {
        worker.bulldozeIdleCount = (worker.bulldozeIdleCount || 0) + 1;

        if (worker.bulldozeIdleCount >= BULLDOZE_IDLE_THRESHOLD) {
          const cleaned = stripAnsiCodes(stdout);
          const bulldozeTailSize = worker.backend === 'gemini' ? 8000 : 1500;
          const tail = cleaned.slice(-bulldozeTailSize);

          const idlePatterns = worker.backend === 'gemini' ? GEMINI_IDLE_PATTERNS : CLAUDE_CODE_IDLE_PATTERNS;
          const activePatterns = worker.backend === 'gemini' ? GEMINI_ACTIVE_PATTERNS : CLAUDE_CODE_ACTIVE_PATTERNS;
          const isAtIdlePrompt = idlePatterns.some(p => p.test(tail));
          const narrowTailSize = worker.backend === 'gemini' ? 5000 : 200;
          const narrowTail = cleaned.slice(-narrowTailSize);
          const isActivelyWorking = activePatterns.some(p => p.test(narrowTail));

          if (worker.bulldozeIdleCount === BULLDOZE_IDLE_THRESHOLD) {
            console.log(`[Bulldoze] ${workerId} idle check: atPrompt=${isAtIdlePrompt} activeWork=${isActivelyWorking} idleCount=${worker.bulldozeIdleCount}`);
            if (!isAtIdlePrompt) {
              const lastChars = tail.slice(-100).replace(/\n/g, '\\n');
              console.log(`[Bulldoze] ${workerId} tail (last 100): ${lastChars}`);
            }
          }

          if (isAtIdlePrompt && !isActivelyWorking) {
            handleBulldozeContinuation(workerId, io).catch(err =>
              console.error(`[Bulldoze] Continuation failed for ${workerId}: ${err.message}`));
            worker.bulldozeIdleCount = 0;
          }
        }
      }

      // Auto-continue for rate-limited / post-compaction workers (skip if bulldoze handles it)
      if (worker && worker.autoContinue !== false && !worker.bulldozeMode &&
          worker.status === 'running' && worker._sessionLimitDetected &&
          worker.ralphStatus !== 'done') {
        worker._autoContinueIdleCount = (worker._autoContinueIdleCount || 0) + 1;

        const threshold = worker._rateLimitDetected
          ? AUTO_CONTINUE_RATE_LIMIT_COOLDOWN
          : AUTO_CONTINUE_IDLE_THRESHOLD;

        if (worker._autoContinueIdleCount >= threshold) {
          // If we know the reset time and haven't reached it yet, skip
          if (worker.rateLimitResetAt && Date.now() < worker.rateLimitResetAt) {
            // Still before reset — don't burn attempts
          } else {
            const cleaned = stripAnsiCodes(stdout).trimEnd();
            const tail = cleaned.slice(-1500);
            const isIdle = CLAUDE_CODE_IDLE_PATTERNS.some(p => p.test(tail));
            const isActive = CLAUDE_CODE_ACTIVE_PATTERNS.some(p => p.test(cleaned.slice(-200)));

            if (isIdle && !isActive) {
              handleAutoContinue(workerId, io).catch(err =>
                console.error(`[AutoContinue] Continuation failed for ${workerId}: ${err.message}`));
              worker._autoContinueIdleCount = 0;
            }
          }
        }
      }

      return;
    }

    // --- Output changed path ---

    if (worker && worker.bulldozeMode) {
      worker.bulldozeIdleCount = 0;
    }

    // Auto-continue: detect rate limits and compaction in fresh output
    if (worker) {
      detectSessionLimits(workerId, stdout, io);
      worker._autoContinueIdleCount = 0;
    }

    instance.lastCaptureHash = hash;

    if (worker) {
      worker.lastOutput = new Date();
      worker.lastActivity = new Date();
    }

    if (io) {
      io.to(`worker:${workerId}`).emit('worker:output', { workerId, output: stdout });
    }

    if (worker) {
      if (!worker._dbWriteCount) worker._dbWriteCount = 0;
      worker._dbWriteCount++;
      if (worker._dbWriteCount % 10 === 0) {
        dbStoreOutput(workerId, stdout, 'stdout');
      }
    }
  } catch (err) {
    if (!instance.initialChecksDone) return;

    const failCount = (sessionFailCounts.get(workerId) || 0) + 1;
    sessionFailCounts.set(workerId, failCount);

    if (failCount < SESSION_FAIL_THRESHOLD) {
      console.warn(`[PtyCapture] capture-pane failed for ${workerId} (${failCount}/${SESSION_FAIL_THRESHOLD}) - retrying`);
      return;
    }

    console.error(`[PtyCapture] Session ${instance.sessionName} confirmed dead after ${failCount} consecutive capture failures for worker ${workerId}`);
    sessionFailCounts.delete(workerId);

    const w = workers.get(workerId);

    if (w && isProtectedWorker(w)) {
      console.error(`[PtyCapture] CRITICAL: GENERAL worker ${workerId} (${w.label}) tmux session is DEAD. NOT auto-deleting — requires human intervention.`);
      w.health = 'dead';
      w.status = 'error';
      ptyInstances.delete(workerId);
      // Import stopHealthMonitor lazily
      const { stopHealthMonitor } = await import('./health.js');
      stopHealthMonitor(workerId);
      clearWorkerContext(workerId);
      try { markWorkerFailed(workerId); } catch (e) { /* may not be registered */ }
      if (io) {
        io.emit('worker:updated', normalizeWorker(w));
        io.emit('worker:general:dead', { workerId, label: w.label, message: 'GENERAL tmux session died - requires human intervention' });
      }
      return;
    }

    if (w?.health === 'crashed') {
      ptyInstances.delete(workerId);
      return;
    }

    if (w?.beingCleanedUp) {
      ptyInstances.delete(workerId);
      return;
    }

    if (w) w.beingCleanedUp = true;

    // Import persistence lazily
    const { writeWorkerCheckpoint } = await import('./persistence.js');
    writeWorkerCheckpoint(workerId, 'session_died');

    ptyInstances.delete(workerId);

    const activity = addActivity('worker_stopped', workerId, w?.label || 'Unknown', w?.project || 'Unknown',
      `Worker session ended`);

    try {
      const failedDependents = markWorkerFailed(workerId);
      for (const depId of failedDependents) {
        if (pendingWorkers.has(depId)) {
          pendingWorkers.delete(depId);
        }
      }
    } catch (e) { /* Worker may not have been in dependency graph */ }

    const deathCb = getWorkerDeathCallback();
    if (deathCb && w?.ralphToken) {
      try { deathCb(w); } catch (e) { /* ignore */ }
    }

    const { endSession: dbEndSession } = await import('../workerOutputDb.js');
    dbEndSession(workerId, 'stopped');

    if (w?.parentWorkerId) {
      const parent = workers.get(w.parentWorkerId);
      if (parent?.childWorkerIds) {
        parent.childWorkerIds = parent.childWorkerIds.filter(id => id !== workerId);
      }
    }

    workers.delete(workerId);
    outputBuffers.delete(workerId);
    commandQueues.delete(workerId);
    sessionFailCounts.delete(workerId);
    lastResizeSize.delete(workerId);
    ptyInstances.delete(workerId);
    respawnAttempts.delete(workerId);
    const acTimer = autoCleanupTimers.get(workerId);
    if (acTimer) { clearTimeout(acTimer); autoCleanupTimers.delete(workerId); }
    clearWorkerContext(workerId);
    if (w?.workingDir) {
      if (w.backend === 'gemini') {
        const { removeGeminiContext } = await import('./templates.js');
        removeGeminiContext(w.workingDir, workerId).catch(err =>
          console.error(`[PtyCapture] Failed to remove gemini context for ${workerId}: ${err.message}`));
      } else {
        const { removeStrategosContext } = await import('./templates.js');
        removeStrategosContext(w.workingDir, workerId).catch(err =>
          console.error(`[PtyCapture] Failed to remove context for ${workerId}: ${err.message}`));
      }
    }
    removeWorkerDependencies(workerId);
    const { stopHealthMonitor } = await import('./health.js');
    stopHealthMonitor(workerId);

    // Clean up bulldoze state file if it exists
    if (w?.workingDir) {
      const bulldozeStatePath = path.join(w.workingDir, 'tmp', `bulldoze-state-${workerId}.md`);
      fs.unlink(bulldozeStatePath).catch(() => { /* ENOENT is fine */ });
    }

    if (io) {
      io.emit('worker:deleted', { workerId });
      io.emit('activity:new', activity);
    }

    const { saveWorkerStateImmediate } = await import('./persistence.js');
    saveWorkerStateImmediate().catch(err => console.error(`[PtyCapture] State save failed: ${err.message}`));
  }
}

export function stopPtyCapture(workerId) {
  ptyInstances.delete(workerId);
}

export function stopAllPtyCaptures() {
  const count = ptyInstances.size;
  ptyInstances.clear();
  if (globalCaptureInterval) {
    clearInterval(globalCaptureInterval);
    globalCaptureInterval = null;
  }
  if (count > 0) {
    console.log(`[Shutdown] Stopped PTY capture for ${count} worker(s)`);
  }
}

// ============================================
// AUTO-ACCEPT LOGIC
// ============================================

async function handleAutoAcceptCheck(workerId, output, io) {
  const worker = workers.get(workerId);
  if (!worker) return;

  const cleaned = stripAnsiCodes(output);
  // Gemini CLI renders large TUI boxes with padding — prompt text can be 3000+ chars from end
  const tailSize = worker.backend === 'gemini' ? 5000 : 500;
  const tail = cleaned.slice(-tailSize);

  let promptDetected = false;
  let matchedPattern = null;

  // Select accept patterns based on worker backend
  const acceptPatterns = worker.backend === 'gemini'
    ? GEMINI_AUTO_ACCEPT_PATTERNS
    : AUTO_ACCEPT_PATTERNS;

  const tailLower = tail.toLowerCase();
  const hasPromptChars = tail.includes('[') || tail.includes('(') || tail.includes('❯') ||
    tail.includes('●') || tail.includes('>') ||
    tailLower.includes('want') || tailLower.includes('allow') ||
    tailLower.includes('press') || tailLower.includes('yes') ||
    tailLower.includes('trust');
  if (hasPromptChars) {
    for (const pattern of acceptPatterns) {
      if (pattern.test(tail)) {
        promptDetected = true;
        matchedPattern = pattern;
        break;
      }
    }
  }

  if (promptDetected !== !!worker.waitingAtPrompt) {
    worker.waitingAtPrompt = promptDetected;
    if (io) io.emit('worker:updated', normalizeWorker(worker));
  }

  if (worker.autoAccept && !worker.autoAcceptPaused) {
    const wideTailSize = worker.backend === 'gemini' ? 8000 : 1500;
    const wideTail = cleaned.slice(-wideTailSize);
    const idlePats = worker.backend === 'gemini' ? GEMINI_IDLE_PATTERNS : CLAUDE_CODE_IDLE_PATTERNS;
    const activePats = worker.backend === 'gemini' ? GEMINI_ACTIVE_PATTERNS : CLAUDE_CODE_ACTIVE_PATTERNS;
    const isIdle = idlePats.some(p => p.test(wideTail)) &&
                   !activePats.some(p => p.test(wideTail));
    if (isIdle) {
      for (const { pattern, command, description } of AUTO_COMMAND_PATTERNS) {
        if (pattern.test(wideTail)) {
          const cmdHash = simpleHash(wideTail + command);
          if (cmdHash !== worker._lastAutoCommandHash) {
            worker._lastAutoCommandHash = cmdHash;
            console.log(`[AutoCommand] Sending "${command}" to ${worker.label} (${description})`);
            try {
              await safeSendKeys(worker.tmuxSession, [command, 'Escape']);
              await new Promise(r => setTimeout(r, 300));
              await safeSendKeys(worker.tmuxSession, ['Enter']);
            } catch (err) {
              console.error(`[AutoCommand] Failed for ${worker.label}: ${err.message}`);
            }
            return;
          }
        }
      }
    }
  }

  if (!worker.autoAccept) return;

  const promptLineSize = worker.backend === 'gemini' ? 5000 : 150;
  const promptLine = cleaned.slice(-promptLineSize).toLowerCase();

  let pauseKeywordFound = false;
  for (const keyword of AUTO_ACCEPT_PAUSE_KEYWORDS) {
    if (promptLine.includes(keyword.toLowerCase())) {
      pauseKeywordFound = true;
      break;
    }
  }

  if (pauseKeywordFound && !worker.autoAcceptPaused) {
    console.log(`[AutoAccept] Pausing for ${worker.label} - detected pause keyword`);
    worker.autoAcceptPaused = true;
    if (io) {
      io.emit('worker:updated', normalizeWorker(worker));
    }
    return;
  } else if (!pauseKeywordFound && worker.autoAcceptPaused) {
    console.log(`[AutoAccept] Auto-resuming for ${worker.label} - no pause keywords in output`);
    worker.autoAcceptPaused = false;
    worker.lastAutoAcceptHash = null;
    if (io) {
      io.emit('worker:updated', normalizeWorker(worker));
    }
  }

  if (worker.autoAcceptPaused) return;
  if (!promptDetected) return;

  const hash = simpleHash(tail);
  if (hash === worker.lastAutoAcceptHash) {
    return;
  }

  worker.lastAutoAcceptHash = hash;

  if (_sendingInput.has(workerId)) {
    worker.lastAutoAcceptHash = null;
    return;
  }

  console.log(`[AutoAccept] Accepting prompt for ${worker.label} (matched: ${matchedPattern})`);

  try {
    await safeSendKeys(worker.tmuxSession, ['Enter']);
    console.log(`[AutoAccept] Sent Enter to ${worker.label}`);

    setTimeout(() => {
      const w = workers.get(workerId);
      if (w && w.autoAccept) {
        w.lastAutoAcceptHash = null;
      }
    }, 6000);
  } catch (error) {
    console.error(`[AutoAccept] Failed to send keys for ${worker.label}:`, error.message);
  }
}

// ============================================
// BULLDOZE MODE: Continuation Engine
// ============================================

function shouldContinueBulldoze(workerId) {
  const worker = workers.get(workerId);
  if (!worker || !worker.bulldozeMode || worker.bulldozePaused) return false;
  if (worker.status !== 'running') return false;
  if (worker.health === 'crashed' || worker.health === 'dead') return false;

  if (worker.bulldozeStartedAt) {
    const hoursElapsed = (Date.now() - new Date(worker.bulldozeStartedAt).getTime()) / 3600000;
    if (hoursElapsed >= BULLDOZE_MAX_HOURS) {
      console.log(`[Bulldoze] Worker ${workerId} hit time limit (${BULLDOZE_MAX_HOURS}h), pausing`);
      worker.bulldozePaused = true;
      worker.bulldozePauseReason = 'time_limit';
      return false;
    }
  }

  if ((worker.bulldozeConsecutiveErrors || 0) >= 3) {
    console.log(`[Bulldoze] Worker ${workerId} hit 3 consecutive errors, pausing`);
    worker.bulldozePaused = true;
    worker.bulldozePauseReason = 'error_limit';
    return false;
  }

  const queue = commandQueues.get(workerId) || [];
  if (queue.length > 0) return false;

  if (_sendingInput.has(workerId)) return false;

  const childIds = worker.childWorkerIds || [];
  if (childIds.length > 0) {
    const activeChildren = childIds.filter(cid => {
      const child = workers.get(cid);
      if (!child) return false;
      // Dead/crashed children should not block bulldoze even if ralphStatus is still in_progress
      if (child.health === 'dead' || child.health === 'crashed') return false;
      return child.status === 'running' && child.ralphStatus === 'in_progress';
    });
    if (activeChildren.length > 0) {
      return false;
    }
  }

  return true;
}

function generateBulldozeContinuation(worker) {
  const stateFilePath = `${worker.workingDir}/tmp/bulldoze-state-${worker.id}.md`;
  const cycleNum = (worker.bulldozeCyclesCompleted || 0) + 1;
  const isAuditCycle = cycleNum % BULLDOZE_AUDIT_EVERY_N_CYCLES === 0;
  const workerType = detectWorkerType(worker.label);

  if (isAuditCycle) {
    if (workerType.isGeneral) {
      return `${BULLDOZE_CONTINUATION_PREFIX} cycle ${cycleNum} - AUDIT]\nCommander, conduct a strategic review. State file: ${stateFilePath}\n\nASSESS: git log --oneline -20, check children status, run test suites, review error logs. What improved since last cycle? What degraded? What's the highest-impact work remaining?\n\nACT: Update the state file with fresh findings. Spawn workers for the top discovery. If your domain is genuinely healthy with no meaningful work remaining, write "## Status: EXHAUSTED" in the state file.`;
    }
    return `${BULLDOZE_CONTINUATION_PREFIX} cycle ${cycleNum} - AUDIT]\nConduct a fresh audit of your domain. State file: ${stateFilePath}\n\nASSESS: git log --oneline -20, run test suites, review error logs, compare to best practices. Add NEW findings to your backlog.\n\nACT: Pick the highest-impact finding and implement it. Commit. Update state file.`;
  }

  if (workerType.isGeneral) {
    return `${BULLDOZE_CONTINUATION_PREFIX} cycle ${cycleNum}]\nCommander, next mission cycle. State file: ${stateFilePath}\n\nSITREP: Read state file. Check git log --oneline -10. Check children status.\n\nEXECUTE: Identify the highest-priority incomplete item. Spawn a worker for it — do NOT implement it yourself. Monitor and drive to completion. Update the state file.\n\nIf all remaining items need human action, write "## Status: NEEDS_HUMAN" in the state file. If genuinely nothing left, write "## Status: EXHAUSTED".`;
  }

  return `${BULLDOZE_CONTINUATION_PREFIX} cycle ${cycleNum}]\nNext mission cycle. State file: ${stateFilePath}\n\nSITREP: Read state file. Check git log --oneline -10 to avoid redoing committed work.\n\nEXECUTE: Pick the highest-priority incomplete item. Implement it thoroughly. Test. Commit with descriptive message. Update state file — mark complete, add any new discoveries. Signal Ralph.\n\nIf all remaining items are low-impact or need human action, write "## Status: EXHAUSTED" in the state file.`;
}

export async function createBulldozeStateFile(worker, settings = {}) {
  const stateDir = path.join(worker.workingDir, 'tmp');
  const stateFilePath = path.join(stateDir, `bulldoze-state-${worker.id}.md`);

  try {
    await fs.access(stateFilePath);
    return;
  } catch {
    // File doesn't exist — create it
  }

  await fs.mkdir(stateDir, { recursive: true });

  const mission = settings.bulldozeMission || 'Autonomous improvement of this project';
  const backlog = settings.bulldozeBacklog || '';
  const standingOrders = settings.bulldozeStandingOrders || '';

  const backlogItems = backlog
    ? backlog.split('\n').filter(line => line.trim()).map(line => `- [ ] ${line.trim()}`).join('\n')
    : '- [ ] Audit codebase for improvements\n- [ ] Run tests and fix failures\n- [ ] Review error handling';

  const standingOrdersSection = standingOrders
    ? standingOrders.split('\n').filter(line => line.trim()).map(line => `- ${line.trim()}`).join('\n')
    : '- Git commit after every meaningful change\n- Run tests before and after changes\n- Never break existing functionality';

  const template = `# Bulldoze State — ${worker.label}

## Status: ACTIVE

**Mission:** ${mission}
**Worker ID:** ${worker.id}
**Started:** ${new Date().toISOString()}
**Compaction Count:** 0

## Standing Orders
${standingOrdersSection}

## Current Wave (Wave 1)
${backlogItems}

## Backlog
<!-- Add discovered tasks here -->

## Completed
<!-- Move completed items here with commit hashes -->

## Learnings
<!-- Patterns and insights that survive compaction -->
`;

  await fs.writeFile(stateFilePath, template, 'utf-8');
  console.log(`[Bulldoze] Created state file for ${worker.id} at ${stateFilePath}`);
}

async function checkBulldozeStateFile(worker) {
  const stateFilePath = path.join(worker.workingDir, 'tmp', `bulldoze-state-${worker.id}.md`);
  try {
    const content = await fs.readFile(stateFilePath, 'utf-8');
    if (content.includes('## Status: EXHAUSTED')) return 'exhausted';
    if (content.includes('## Status: BLOCKED')) return 'blocked';
    if (content.includes('## Status: NEEDS_HUMAN')) return 'needs_human';
    const compactionMatch = content.match(/Compaction Count:\s*(\d+)/);
    if (compactionMatch && parseInt(compactionMatch[1]) >= BULLDOZE_MAX_COMPACTIONS) {
      return 'compaction_limit';
    }
    return 'ok';
  } catch {
    return 'ok';
  }
}

export async function resetBulldozeStateFileStatus(worker) {
  const stateFilePath = path.join(worker.workingDir, 'tmp', `bulldoze-state-${worker.id}.md`);
  try {
    const content = await fs.readFile(stateFilePath, 'utf-8');
    if (content.includes('## Status: EXHAUSTED') || content.includes('## Status: BLOCKED') || content.includes('## Status: NEEDS_HUMAN')) {
      const updated = content
        .replace('## Status: EXHAUSTED', '## Status: ACTIVE')
        .replace('## Status: BLOCKED', '## Status: ACTIVE')
        .replace('## Status: NEEDS_HUMAN', '## Status: ACTIVE');
      await fs.writeFile(stateFilePath, updated, 'utf-8');
      console.log(`[Bulldoze] Reset state file status to ACTIVE for ${worker.id}`);
    }
  } catch {
    // File doesn't exist — nothing to reset
  }
}

async function collectBulldozeMetrics(worker) {
  try {
    const sinceDate = worker.bulldozeStartedAt
      ? new Date(worker.bulldozeStartedAt).toISOString()
      : new Date(Date.now() - 3600000).toISOString();
    const { stdout } = await execAsync(
      `git -C "${worker.workingDir}" log --since="${sinceDate}" --format="%s" 2>/dev/null`
    );
    const commits = stdout.trim().split('\n').filter(Boolean);
    const metrics = {
      totalCommits: commits.length,
      fixes: commits.filter(c => c.startsWith('fix:')).length,
      feats: commits.filter(c => c.startsWith('feat:')).length,
      wips: commits.filter(c => c.startsWith('wip:')).length,
      research: commits.filter(c => /^(research|audit|analysis):/.test(c)).length,
      lastCommit: commits[0] || null,
      collectedAt: new Date().toISOString(),
    };
    metrics.other = metrics.totalCommits - metrics.fixes - metrics.feats - metrics.wips - metrics.research;
    metrics.fixRatio = metrics.totalCommits > 0
      ? Math.round((metrics.fixes + metrics.feats) / metrics.totalCommits * 100)
      : 0;
    return metrics;
  } catch {
    return null;
  }
}

async function handleBulldozeContinuation(workerId, io) {
  if (!shouldContinueBulldoze(workerId)) return;

  const worker = workers.get(workerId);
  if (!worker) return;

  const stateStatus = await checkBulldozeStateFile(worker);
  if (stateStatus !== 'ok') {
    console.log(`[Bulldoze] Worker ${workerId} state file says "${stateStatus}", pausing`);
    worker.bulldozePaused = true;
    worker.bulldozePauseReason = stateStatus;
    if (io) {
      io.emit('worker:updated', normalizeWorker(worker));
      io.emit('worker:bulldoze:paused', {
        workerId,
        reason: stateStatus,
        cyclesCompleted: worker.bulldozeCyclesCompleted || 0
      });
    }
    return;
  }

  const metrics = await collectBulldozeMetrics(worker);
  if (metrics) {
    worker.bulldozeMetrics = metrics;
    const prevCommits = worker._bulldozePrevCommitCount || 0;
    const newCommits = metrics.totalCommits - prevCommits;
    worker._bulldozePrevCommitCount = metrics.totalCommits;

    if (newCommits === 0) {
      worker._bulldozeNoCommitCycles = (worker._bulldozeNoCommitCycles || 0) + 1;
      if (worker._bulldozeNoCommitCycles >= 5) {
        console.warn(`[Bulldoze] Worker ${workerId} stalled — ${worker._bulldozeNoCommitCycles} cycles without commits, auto-pausing`);
        worker.bulldozePaused = true;
        worker.bulldozePauseReason = 'no_commits';
        if (io) {
          io.emit('worker:updated', normalizeWorker(worker));
          io.emit('worker:bulldoze:paused', {
            workerId,
            reason: 'no_commits',
            cyclesCompleted: worker.bulldozeCyclesCompleted || 0
          });
        }
        return;
      } else if (worker._bulldozeNoCommitCycles >= 3) {
        console.warn(`[Bulldoze] Worker ${workerId} has gone ${worker._bulldozeNoCommitCycles} cycles without commits — possible stall`);
      }
    } else {
      worker._bulldozeNoCommitCycles = 0;
    }

    console.log(`[Bulldoze] Metrics for ${workerId}: ${metrics.totalCommits} total commits (fix:${metrics.fixes} feat:${metrics.feats} wip:${metrics.wips}) +${newCommits} new this cycle`);
  }

  const prompt = generateBulldozeContinuation(worker);

  try {
    await sendInput(workerId, prompt, io);
    worker.bulldozeCyclesCompleted = (worker.bulldozeCyclesCompleted || 0) + 1;
    worker.bulldozeLastCycleAt = new Date();
    worker.lastActivity = new Date();
    worker.bulldozeIdleCount = 0;
    worker.bulldozeConsecutiveErrors = 0;

    const isAudit = worker.bulldozeCyclesCompleted % BULLDOZE_AUDIT_EVERY_N_CYCLES === 0;
    console.log(`[Bulldoze] Sent cycle ${worker.bulldozeCyclesCompleted} to ${worker.label} (${workerId})${isAudit ? ' [AUDIT]' : ''}`);

    if (io) {
      io.emit('worker:updated', normalizeWorker(worker));
      io.emit('worker:bulldoze:cycle', {
        workerId,
        cycle: worker.bulldozeCyclesCompleted,
        isAudit,
        metrics: metrics || undefined,
      });
    }

    const { saveWorkerState } = await import('./persistence.js');
    saveWorkerState().catch(err => console.error(`[Bulldoze] State save failed: ${err.message}`));
  } catch (err) {
    worker.bulldozeConsecutiveErrors = (worker.bulldozeConsecutiveErrors || 0) + 1;
    console.error(`[Bulldoze] Failed to send continuation to ${workerId} (errors: ${worker.bulldozeConsecutiveErrors}): ${err.message}`);
  }
}

// ============================================
// WORKER SETTINGS
// ============================================

export function updateWorkerSettings(workerId, settings, io = null) {
  const worker = workers.get(workerId);

  if (!worker) {
    throw new Error(`Worker ${workerId} not found`);
  }

  if (settings.autoAccept !== undefined) {
    if (typeof settings.autoAccept !== 'boolean') {
      throw new Error('autoAccept must be a boolean');
    }
    worker.autoAccept = settings.autoAccept;
    if (settings.autoAccept) {
      worker.autoAcceptPaused = false;
      worker.lastAutoAcceptHash = null;
    }
    console.log(`[AutoAccept] ${worker.label} autoAccept set to ${settings.autoAccept}`);
  }

  if (settings.autoAcceptPaused !== undefined) {
    if (typeof settings.autoAcceptPaused !== 'boolean') {
      throw new Error('autoAcceptPaused must be a boolean');
    }
    worker.autoAcceptPaused = settings.autoAcceptPaused;
    if (!settings.autoAcceptPaused) {
      worker.lastAutoAcceptHash = null;
    }
    console.log(`[AutoAccept] ${worker.label} autoAcceptPaused set to ${settings.autoAcceptPaused}`);
  }

  if (settings.autoContinue !== undefined) {
    if (typeof settings.autoContinue !== 'boolean') {
      throw new Error('autoContinue must be a boolean');
    }
    worker.autoContinue = settings.autoContinue;
    if (settings.autoContinue) {
      // Reset counters so it can start fresh
      worker._autoContinueAttempts = 0;
      worker._autoContinueExhausted = false;
      worker._autoContinueIdleCount = 0;
    }
    console.log(`[AutoContinue] ${worker.label} autoContinue set to ${settings.autoContinue}`);
  }

  if (settings.ralphMode !== undefined) {
    if (typeof settings.ralphMode !== 'boolean') {
      throw new Error('ralphMode must be a boolean');
    }
    worker.ralphMode = settings.ralphMode;
    if (settings.ralphMode) {
      worker.ralphToken = crypto.randomBytes(16).toString('hex');
      console.log(`[Ralph] ${worker.label} Ralph mode ENABLED (token: ${worker.ralphToken.slice(0, 8)}...)`);
    } else {
      worker.ralphToken = null;
      console.log(`[Ralph] ${worker.label} Ralph mode DISABLED`);
    }
  }

  if (settings.bulldozeMode !== undefined) {
    if (typeof settings.bulldozeMode !== 'boolean') {
      throw new Error('bulldozeMode must be a boolean');
    }
    worker.bulldozeMode = settings.bulldozeMode;
    if (settings.bulldozeMode) {
      // If worker is in awaiting_review, revert to running so bulldoze can operate
      if (worker.status === 'awaiting_review') {
        worker.status = 'running';
        worker.awaitingReviewAt = null;
        console.log(`[Bulldoze] ${worker.label} reverted from awaiting_review → running (bulldoze enabled)`);
      }
      worker.bulldozeStartedAt = new Date();
      worker.bulldozePaused = false;
      worker.bulldozePauseReason = null;
      worker.bulldozeIdleCount = 0;
      // Serialize: create state file first, then rewrite context rules, then reset status
      createBulldozeStateFile(worker, settings)
        .then(() => resetBulldozeStateFileStatus(worker))
        .then(() => writeStrategosContext(worker.id, worker.label, worker.workingDir, worker.ralphToken, {
          bulldozeMode: true,
          parentWorkerId: worker.parentWorkerId,
          parentLabel: worker.parentLabel,
        }))
        .catch(err => console.error(`[Bulldoze] Failed to set up bulldoze for ${workerId}: ${err.message}`));
      console.log(`[Bulldoze] ${worker.label} bulldoze mode ENABLED`);
    } else {
      console.log(`[Bulldoze] ${worker.label} bulldoze mode DISABLED (${worker.bulldozeCyclesCompleted || 0} cycles completed)`);
      // Rewrite rules file without <bulldoze> section
      const rewriteContext = worker.backend === 'gemini'
        ? writeGeminiContext(worker.id, worker.label, worker.workingDir, worker.ralphToken, {
            parentWorkerId: worker.parentWorkerId,
            parentLabel: worker.parentLabel,
            bulldozeMode: false,
          })
        : writeStrategosContext(worker.id, worker.label, worker.workingDir, worker.ralphToken, {
            parentWorkerId: worker.parentWorkerId,
            parentLabel: worker.parentLabel,
            bulldozeMode: false,
          });
      rewriteContext.catch(err => console.error(`[Bulldoze] Failed to rewrite rules for ${workerId}: ${err.message}`));
    }
  }

  if (settings.bulldozePaused !== undefined) {
    if (typeof settings.bulldozePaused !== 'boolean') {
      throw new Error('bulldozePaused must be a boolean');
    }
    worker.bulldozePaused = settings.bulldozePaused;
    if (!settings.bulldozePaused) {
      worker.bulldozeIdleCount = 0;
      worker.bulldozePauseReason = null;
      resetBulldozeStateFileStatus(worker).catch(err =>
        console.error(`[Bulldoze] Failed to reset state file for ${workerId}: ${err.message}`)
      );
    }
    console.log(`[Bulldoze] ${worker.label} bulldozePaused set to ${settings.bulldozePaused}`);
  }

  if (io) {
    io.emit('worker:updated', normalizeWorker(worker));
  }

  return worker;
}

// ============================================
// COMMAND QUEUING / INPUT
// ============================================

export async function sendInput(workerId, input, io = null, { fromWorkerId } = {}) {
  const worker = workers.get(workerId);

  if (!worker) {
    throw new Error(`Worker ${workerId} not found`);
  }

  const isWorkerInput = fromWorkerId && workers.has(fromWorkerId);
  if (worker.bulldozeMode && !worker.bulldozePaused && !isWorkerInput &&
      typeof input === 'string' && !input.startsWith(BULLDOZE_CONTINUATION_PREFIX)) {
    worker.bulldozePaused = true;
    worker.bulldozePauseReason = 'human_input';
    worker.bulldozeIdleCount = 0;
    console.log(`[Bulldoze] ${worker.label} auto-paused: human input detected`);
    if (io) {
      io.emit('worker:updated', normalizeWorker(worker));
      io.emit('worker:bulldoze:paused', {
        workerId,
        reason: 'human_input',
        cyclesCompleted: worker.bulldozeCyclesCompleted || 0
      });
    }
    const { saveWorkerState } = await import('./persistence.js');
    saveWorkerState().catch(err => console.error(`[Bulldoze] State save failed: ${err.message}`));
  }

  const queue = commandQueues.get(workerId) || [];

  if (_sendingInput.has(workerId) || queue.length > 0) {
    if (queue.length >= MAX_QUEUE_SIZE) {
      throw new Error(`Command queue full for worker ${workerId} (max ${MAX_QUEUE_SIZE})`);
    }
    queue.push(input);
    commandQueues.set(workerId, queue);
    worker.queuedCommands = queue.length;

    if (io) {
      io.emit('worker:updated', normalizeWorker(worker));
    }
    return true;
  }

  _sendingInput.add(workerId);
  try {
    await sendInputDirect(workerId, input);
  } finally {
    _sendingInput.delete(workerId);
  }

  return true;
}

export async function sendInputDirect(workerId, input) {
  const worker = workers.get(workerId);
  if (!worker) return;

  const sanitized = input.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, '');

  try {
    await safeSendKeys(worker.tmuxSession, ['-l', sanitized]);
    await new Promise(resolve => setTimeout(resolve, 200));
    await safeSendKeys(worker.tmuxSession, ['Enter']);
    worker.lastActivity = new Date();
  } catch (error) {
    throw new Error(`Failed to send input: ${error.message}`);
  }
}

export async function sendRawInput(workerId, keys) {
  const worker = workers.get(workerId);

  if (!worker) {
    throw new Error(`Worker ${workerId} not found`);
  }

  try {
    await safeSendKeys(worker.tmuxSession, ['-l', keys]);
    worker.lastActivity = new Date();
  } catch (error) {
    throw new Error(`Failed to send raw input: ${error.message}`);
  }
}

export async function interruptWorker(workerId, followUp = null, io = null) {
  const worker = workers.get(workerId);

  if (!worker) {
    throw new Error(`Worker ${workerId} not found`);
  }

  if (worker.status !== 'running') {
    throw new Error(`Worker ${workerId} is not running (status: ${worker.status})`);
  }

  try {
    await safeSendKeys(worker.tmuxSession, ['C-c']);
    worker.lastActivity = new Date();
    console.log(`[InterruptWorker] Sent C-c to worker ${workerId} (${worker.label})`);

    if (followUp && typeof followUp === 'string') {
      await new Promise(resolve => setTimeout(resolve, 500));
      await sendInput(workerId, followUp, io);
      console.log(`[InterruptWorker] Sent follow-up input to worker ${workerId}`);
    }

    return true;
  } catch (error) {
    throw new Error(`Failed to interrupt worker: ${error.message}`);
  }
}

export async function processQueue(workerId, io = null) {
  if (_processingQueues.has(workerId)) {
    console.warn(`[ProcessQueue] Already processing queue for ${workerId}, skipping`);
    return;
  }
  if (_sendingInput.has(workerId)) {
    return;
  }

  const queue = commandQueues.get(workerId) || [];
  if (queue.length === 0) return;

  _processingQueues.add(workerId);

  let processed = 0;
  try {
    while (processed < PROCESS_QUEUE_MAX_DRAIN) {
      const currentQueue = commandQueues.get(workerId) || [];
      if (currentQueue.length === 0) break;

      const worker = workers.get(workerId);
      if (!worker || worker.status !== 'running') break;

      _sendingInput.add(workerId);
      const nextCommand = currentQueue.shift();
      commandQueues.set(workerId, currentQueue);

      worker.queuedCommands = currentQueue.length;
      if (io) {
        io.emit('worker:updated', normalizeWorker(worker));
      }

      try {
        await sendInputDirect(workerId, nextCommand);
        processed++;
      } catch (error) {
        if (workers.has(workerId)) {
          currentQueue.unshift(nextCommand);
          commandQueues.set(workerId, currentQueue);
          if (worker) worker.queuedCommands = currentQueue.length;
        }
        if (io) {
          io.emit('worker:queue:error', {
            workerId,
            error: error.message,
            command: nextCommand?.input?.substring(0, 100) || nextCommand?.substring?.(0, 100) || '(unknown)'
          });
        }
        break;
      } finally {
        _sendingInput.delete(workerId);
      }

      if (currentQueue.length > 0) {
        await new Promise(resolve => setTimeout(resolve, PROCESS_QUEUE_DELAY_MS));
      }
    }

    if (processed >= PROCESS_QUEUE_MAX_DRAIN) {
      const remaining = (commandQueues.get(workerId) || []).length;
      console.warn(`[ProcessQueue] Hit drain limit (${PROCESS_QUEUE_MAX_DRAIN}) for ${workerId}, ${remaining} commands still queued`);
    }
  } finally {
    _sendingInput.delete(workerId);
    _processingQueues.delete(workerId);
  }
}
