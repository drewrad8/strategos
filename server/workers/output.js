/**
 * Output capture, auto-accept, input handling, bulldoze mode, and worker settings.
 * Manages PTY capture intervals, command queuing, and autonomous operation modes.
 */

import crypto from 'crypto';
import {
  workers, outputBuffers, commandQueues, ptyInstances, sessionFailCounts,
  pendingWorkers, autoCleanupTimers, lastResizeSize, respawnAttempts,
  _sendingInput, _processingQueues, _tmuxSendLock, withTmuxLock,
  SESSION_FAIL_THRESHOLD, PROCESS_QUEUE_MAX_DRAIN, PROCESS_QUEUE_DELAY_MS, MAX_QUEUE_SIZE,
  path, fs, execAsync,
  simpleHash, stripAnsiCodes, normalizeWorker, addActivity,
  spawnTmux, TMUX_CAPTURE_TIMEOUT_MS, safeSendKeys, validateSessionName,
  getWorkerDeathCallback, STRATEGOS_API,
} from './state.js';

import {
  AUTO_ACCEPT_PATTERNS, CLAUDE_CODE_IDLE_PATTERNS, CLAUDE_CODE_ACTIVE_PATTERNS,
  AUTO_COMMAND_PATTERNS, AUTO_ACCEPT_PAUSE_KEYWORDS,
  GEMINI_IDLE_PATTERNS, GEMINI_ACTIVE_PATTERNS, GEMINI_AUTO_ACCEPT_PATTERNS,
  AIDER_IDLE_PATTERNS, AIDER_ACTIVE_PATTERNS, AIDER_AUTO_ACCEPT_PATTERNS,
  BULLDOZE_IDLE_THRESHOLD, BULLDOZE_AUDIT_EVERY_N_CYCLES, BULLDOZE_MAX_HOURS,
  FORCED_AUTONOMY_BASE_THRESHOLD, FORCED_AUTONOMY_MAX_THRESHOLD, FORCED_AUTONOMY_BACKOFF_FACTOR,
  BULLDOZE_MAX_COMPACTIONS, BULLDOZE_CONTINUATION_PREFIX,
  RATE_LIMIT_PATTERN, RATE_LIMIT_RESET_RE,
  RATE_LIMIT_WALL_A_CONFIRM, RATE_LIMIT_WALL_B,
  RATE_LIMIT_WALL_C, RATE_LIMIT_WALL_C_CONFIRM,
  RATE_LIMIT_WALL_D, RATE_LIMIT_WALL_D_CONFIRM,
  AUTO_CONTINUE_RATE_LIMIT_COOLDOWN,
  AUTO_CONTINUE_MAX_ATTEMPTS, AUTO_CONTINUE_MESSAGE,
  CONTEXT_COMPACTION_PATTERNS,
  detectWorkerType, isProtectedOrColonel, isProtectedWorker,
  writeStrategosContext,
} from './templates.js';

import {
  storeOutput as dbStoreOutput,
} from '../workerOutputDb.js';
import { clearWorkerContext } from '../summaryService.js';
import {
  markWorkerFailed,
  removeWorkerDependencies,
} from '../dependencyGraph.js';
import { invalidateWorkersCache } from './queries.js';
import { getLogger } from '../logger.js';

const logger = getLogger();

// Dependency-injection hook for testability (same pattern as ralph.js)
export const _outputDbFns = { storeOutput: dbStoreOutput };

// DI hook for rate-limit wall Ralph signaling — replaceable in tests to avoid
// dynamic-import timing issues (mock.module interception of cached ESM modules is unreliable).
export const _rateLimitWallFns = {
  signalRalphBlocked: (workerId, data, io) => {
    import('./ralph.js').then(({ updateWorkerRalphStatus }) => {
      updateWorkerRalphStatus(workerId, data, io);
    }).catch(err => logger.error(`[rate-limit] Ralph signal failed for ${workerId}: ${err.message}`));
  },
};

// Global PTY capture interval
let globalCaptureInterval = null;

// ============================================
// ORPHANED-SESSION SCANNER  (P1-VAN)
// ============================================

// Throttle: scan once every 12 × 5s = ~60s within the global capture loop
let _orphanScanCycle = 0;
const ORPHAN_SCAN_EVERY_N = 12;

/**
 * Scan live tmux sessions for thea-worker-* names that have no corresponding
 * entry in the workers Map and no existing checkpoint. For each orphan, capture
 * the last 100 output lines and write an emergency checkpoint so the Commander
 * has a forensic trail even if the worker crashed before registration.
 *
 * Called from the global PTY capture interval (every ~60s) and may be called
 * directly on server startup.
 */
export async function scanOrphanedSessions(io) {
  // Lazily import session/path constants to avoid breaking module-mock tests
  // that stub state.js without these exports.
  const { SESSION_PREFIX, CHECKPOINT_DIR, existsSync } = await import('./state.js');

  let sessionList;
  try {
    sessionList = await spawnTmux(['list-sessions', '-F', '#{session_name}']);
  } catch {
    return; // no tmux server running or no sessions at all
  }

  const sessionNames = sessionList.split('\n').map(s => s.trim()).filter(Boolean);

  for (const sessionName of sessionNames) {
    if (!sessionName.startsWith(SESSION_PREFIX)) continue;
    const workerId = sessionName.slice(SESSION_PREFIX.length);
    if (!workerId) continue;

    // Already registered in the workers Map — not orphaned
    if (workers.has(workerId)) continue;

    // Already tracked by the PTY capture loop — not orphaned
    if (ptyInstances.has(workerId)) continue;

    // Checkpoint already written — do not overwrite existing forensic data
    if (existsSync(path.join(CHECKPOINT_DIR, `${workerId}.json`))) continue;

    // Orphaned session found — try to capture last 100 lines of output
    let lastOutput = '';
    try {
      lastOutput = await spawnTmux(
        ['capture-pane', '-t', sessionName, '-p', '-S', '-100'],
        TMUX_CAPTURE_TIMEOUT_MS,
      );
    } catch { /* session may already be dead — proceed with empty output */ }

    logger.warn(`[OrphanScan] Orphaned tmux session ${sessionName} — writing emergency checkpoint`);

    const { writeOrphanedGeneralCheckpoint } = await import('./persistence.js');
    writeOrphanedGeneralCheckpoint(workerId, sessionName, lastOutput);

    if (io) {
      io.emit('worker:general:dead', {
        workerId,
        label: 'ORPHANED',
        message: 'Orphaned GENERAL tmux session detected — emergency checkpoint written',
        orphaned: true,
      });
    }
  }
}

// ============================================
// BACKEND-AWARE PATTERN HELPERS
// ============================================

function getIdlePatterns(backend) {
  if (backend === 'gemini') return GEMINI_IDLE_PATTERNS;
  if (backend === 'aider') return AIDER_IDLE_PATTERNS;
  return CLAUDE_CODE_IDLE_PATTERNS;
}

function getActivePatterns(backend) {
  if (backend === 'gemini') return GEMINI_ACTIVE_PATTERNS;
  if (backend === 'aider') return AIDER_ACTIVE_PATTERNS;
  return CLAUDE_CODE_ACTIVE_PATTERNS;
}

/**
 * Strip completed-thinking indicator lines from text before active pattern matching.
 * Claude Code shows "✻ Sautéed for 43s" (with ✻ prefix) after finishing a thinking step.
 * These past-tense markers persist in the terminal and falsely trigger active patterns
 * like /Sautéed/i, making idle workers appear actively working.
 * Only lines starting with ✻ are stripped — active spinner lines (⠋ Thinking...) are kept.
 */
function stripCompletedThinking(text) {
  return text.replace(/^✻\s+.+$/gm, '');
}

function getAcceptPatterns(backend) {
  if (backend === 'gemini') return GEMINI_AUTO_ACCEPT_PATTERNS;
  if (backend === 'aider') return AIDER_AUTO_ACCEPT_PATTERNS;
  return AUTO_ACCEPT_PATTERNS;
}

function getBackendTailSize(backend, type) {
  // 'wide' for bulldoze/auto-accept wide tail, 'narrow' for active check, 'prompt' for prompt detection
  if (backend === 'gemini') return type === 'narrow' ? 5000 : type === 'prompt' ? 5000 : 8000;
  if (backend === 'aider') return type === 'narrow' ? 300 : type === 'prompt' ? 300 : 2000;
  return type === 'narrow' ? 200 : type === 'prompt' ? 150 : 1500;
}

// ============================================
// DONE-RESPONSE & SESSION-END DETECTION
// ============================================

// Patterns that indicate a worker is signaling completion (tested against trimmed last lines)
const DONE_RESPONSE_PATTERNS = [
  /^done\.?$/i,
  /^all tasks? (?:are )?complete[d.]?$/i,
  /^signal(?:ed|ing)? done via ralph/i,
  /^nothing (?:left|more|else) to do/i,
  /^(?:i have |i've )?completed (?:the |my |all )?task/i,
  /^work (?:is )?(?:complete|finished|done)/i,
  /^task (?:is )?(?:complete|finished|done)/i,
  /^\d{1}$/,  // Single digit response (1, 2, 3) after nudge
];

// Session-end detection: Claude's feedback survey = session is over.
// The survey renders as a distinct UI block with Bad/Fine/Good/Dismiss rating buttons.
// This is the REQUIRED anchor pattern — it's unique to the survey and cannot appear in
// normal code output. The supporting patterns confirm context but must not be used alone
// because "Give feedback" and "How is Claude doing" appear in worker templates/instructions.
const SESSION_END_ANCHOR = /Bad.*Fine.*Good.*Dismiss/;
const SESSION_END_SUPPORTING = [
  /how is claude doing this session/i,
  /Give feedback|Report bug/i,
];

/**
 * Check if the worker's last output indicates it considers itself done.
 * Examines the last few non-empty lines of output.
 */
function isWorkerSignalingCompletion(lastOutput) {
  if (!lastOutput || typeof lastOutput !== 'string') return false;
  const cleaned = stripAnsiCodes(lastOutput).trimEnd();
  // Check last 500 chars — done responses are short
  const tail = cleaned.slice(-500);
  const lines = tail.split('\n').map(l => l.trim()).filter(Boolean);
  // Check last 5 non-empty lines
  const lastLines = lines.slice(-5);
  for (const line of lastLines) {
    if (DONE_RESPONSE_PATTERNS.some(p => p.test(line))) return true;
  }
  return false;
}

/**
 * Check if the worker's session has ended (Claude feedback survey).
 * When detected, all continuation nudges should be suppressed.
 *
 * Requires the anchor pattern (Bad/Fine/Good/Dismiss rating row) to be present.
 * This prevents false positives from "Give feedback" or "How is Claude doing"
 * appearing in worker instructions or output text.
 */
function isSessionEnded(lastOutput) {
  if (!lastOutput || typeof lastOutput !== 'string') return false;
  const cleaned = stripAnsiCodes(lastOutput).trimEnd();
  const tail = cleaned.slice(-1000);
  // Anchor pattern is required — it's unique to the survey UI
  if (!SESSION_END_ANCHOR.test(tail)) return false;
  // At least one supporting pattern should also be present for confidence
  return SESSION_END_SUPPORTING.some(p => p.test(tail));
}

// Session recovery rate-limit: max 3 recoveries per 30 minutes per worker
// GENERALs are long-running and will hit context limits multiple times — they get a higher limit.
const SESSION_RECOVERY_MAX = 3;
const SESSION_RECOVERY_MAX_GENERAL = 10;
const SESSION_RECOVERY_WINDOW_MS = 30 * 60 * 1000;

/**
 * Attempt to auto-recover a session-ended worker (bulldoze or forcedAutonomy).
 * Dismisses the Claude feedback survey, resets state, and sends a recovery prompt.
 * Returns true if recovery was initiated, false if rate-limited or ineligible.
 */
async function trySessionRecovery(workerId, io) {
  const worker = workers.get(workerId);
  if (!worker) return false;
  if (!worker.bulldozeMode && !worker.forcedAutonomy) return false;
  if (worker._sessionRecoverySuppressed) return false;

  // If the worker has signaled Ralph within the last 30 minutes, the session is healthy —
  // the worker is alive and idle (e.g., a GENERAL waiting for Commander input), not dead.
  // Sending a recovery prompt to a healthy worker is wasteful and confusing.
  const RALPH_RECENCY_WINDOW_MS = 30 * 60 * 1000;
  if (worker.lastRalphSignalAt) {
    const msSinceSignal = Date.now() - new Date(worker.lastRalphSignalAt).getTime();
    if (msSinceSignal < RALPH_RECENCY_WINDOW_MS) {
      logger.info(`[SessionRecovery] Worker ${workerId} (${worker.label}) signaled Ralph ${Math.round(msSinceSignal / 60000)}min ago — session is healthy, skipping recovery`);
      worker._sessionEnded = false;  // Clear the false flag
      return false;
    }
  }

  // Rate-limit check
  if (!worker._sessionRecoveryTimestamps) worker._sessionRecoveryTimestamps = [];
  const now = Date.now();
  worker._sessionRecoveryTimestamps = worker._sessionRecoveryTimestamps.filter(
    ts => now - ts < SESSION_RECOVERY_WINDOW_MS
  );

  const recoveryMax = isProtectedOrColonel(worker) ? SESSION_RECOVERY_MAX_GENERAL : SESSION_RECOVERY_MAX;
  if (worker._sessionRecoveryTimestamps.length >= recoveryMax) {
    worker._sessionRecoverySuppressed = true;
    logger.warn(`[SessionRecovery] Worker ${workerId} (${worker.label}) hit recovery rate limit (${recoveryMax}/${SESSION_RECOVERY_WINDOW_MS / 60000}min) — suppressing further recoveries`);
    if (io) {
      io.emit('worker:session-recovery-exhausted', { workerId, label: worker.label });
    }

    // Trigger auto-respawn if the worker was registered for it
    if (worker.autoRespawn) {
      const workerSnapshot = {
        ralphProgress: worker.ralphProgress,
        ralphCurrentStep: worker.ralphCurrentStep,
        ralphLearnings: worker.ralphLearnings,
        ralphBlockedReason: worker.ralphBlockedReason,
      };
      import('../services/autoRespawnService.js').then(({ handleGeneralDeath }) => {
        handleGeneralDeath(workerId, 'session_exhausted', io, workerSnapshot).catch(e =>
          logger.error(`[AutoRespawn] handleGeneralDeath (session_exhausted) failed for ${workerId}: ${e.message}`)
        );
      }).catch(e => logger.error(`[AutoRespawn] Import failed in session recovery: ${e.message}`));
    }

    return false;
  }

  worker._sessionRecoveryTimestamps.push(now);
  worker._sessionRecoveryCount = (worker._sessionRecoveryCount || 0) + 1;
  const attempt = worker._sessionRecoveryCount;

  logger.info(`[SessionRecovery] Worker ${workerId} (${worker.label}) session ended, auto-recovering (attempt ${attempt})`);

  try {
    // Dismiss the Claude feedback survey by sending "0"
    await sendInputDirect(workerId, '0', 'session_recovery');
    await new Promise(resolve => setTimeout(resolve, 500));

    // Reset session-ended state
    worker._sessionEnded = false;

    // Reset bulldoze state if applicable
    if (worker.bulldozeMode) {
      worker.bulldozePaused = false;
      worker.bulldozePauseReason = null;
      worker.bulldozeIdleCount = 0;
    }

    // Reset forced autonomy state if applicable
    if (worker.forcedAutonomy) {
      worker._forcedAutonomySuppressed = false;
      worker._forcedAutonomyIdleCount = 0;
      worker._forcedAutonomyNudgeCount = 0;
    }

    // Send recovery prompt
    const recoveryPrompt = `Your previous session ended due to context exhaustion. You are in autonomous mode. Check your bulldoze state file if you have one (tmp/bulldoze-state-${workerId}.md), assess what was in progress, and continue working. Signal Ralph with your current status.`;
    await sendInput(workerId, recoveryPrompt, io, { source: 'session_recovery' });

    // Emit socket event for UI awareness
    if (io) {
      io.emit('worker:session-recovered', { workerId, label: worker.label, recoveryCount: attempt });
      io.to(`worker:${workerId}`).emit('worker:updated', normalizeWorker(worker));
    }

    return true;
  } catch (err) {
    logger.error(`[SessionRecovery] Failed to recover worker ${workerId}: ${err.message}`);
    return false;
  }
}


// ============================================
// GENERAL ROLE-VIOLATION DETECTION (SENTINEL)
// ============================================

// Claude Code renders tool invocations at the LEFT MARGIN as:
//   ● Write(filename)       — file creation
//   ● Update(filename)      — file edit (the Edit tool)
//   ● Edit(filename)        — also possible in some versions
//   ● NotebookEdit(filename) — notebook modification
// Legacy format (colon):
//   Edit: filename
//   Write: filename
//
// ALL patterns are ^-anchored and tested against trimmed lines (leading whitespace removed).
// This prevents false positives from prose text that MENTIONS tool patterns mid-sentence
// and from child output displayed inside tool result blocks.
const GENERAL_VIOLATION_PATTERNS = [
  { pattern: /^● (?:Edit|Update)\(/,  description: 'use the Edit tool (file modification)' },
  { pattern: /^● Write\(/,            description: 'use the Write tool (file creation)' },
  { pattern: /^● NotebookEdit\(/,     description: 'use the NotebookEdit tool (notebook modification)' },
  { pattern: /^Edit:\s/,              description: 'use the Edit tool (legacy format)' },
  { pattern: /^Write:\s/,             description: 'use the Write tool (legacy format)' },
  { pattern: /^NotebookEdit:\s/,      description: 'use the NotebookEdit tool (legacy format)' },
  { pattern: /^Added \d+ lines, removed \d+ lines/, description: 'edit files (diff output detected)' },
  { pattern: /^Wrote \d+ lines to\b/,               description: 'write files (write output detected)' },
];

// Bash tool invocations — anchored to line start (● Bash( or legacy Bash: format)
// Implementation commands that GENERAL should delegate, not run directly
const GENERAL_IMPL_BASH_RE = /^(?:● )?Bash[:(]\s?.*?\b(npm|node|python|python3|pip|pip3|sed|awk|gcc|g\+\+|cargo|make|cmake|rustc|javac|go build|go run|tsc|webpack|vite|esbuild|npx playwright|npx jest|pytest)\b/;

// Bash: followed by legitimate commander actions (git, curl, ls, cat, jq, etc.)
const GENERAL_ALLOWED_BASH_RE = /^(?:● )?Bash[:(]\s?.*?\b(git|curl|ls|cat|head|tail|jq|wc|echo|printf|pwd|whoami|date|uptime|df|du|ps|grep|find|which|env|export)\b/;

async function checkGeneralRoleViolation(workerId, output, io, cleanedOutput = null) {
  const worker = workers.get(workerId);
  if (!worker) return;

  // Only check GENERAL/COLONEL-labeled workers
  if (!isProtectedOrColonel(worker)) return;

  const cleaned = cleanedOutput ?? stripAnsiCodes(output);
  const tail = cleaned.slice(-2000);

  // Deduplicate: don't re-trigger on the same output
  const tailHash = simpleHash(tail);
  if (tailHash === worker._lastViolationHash) return;

  let violation = null;

  // Split into lines for per-line analysis.
  // Only match patterns on lines that look like the GENERAL's own tool invocations,
  // NOT child worker output displayed via strategos_output/curl.
  //
  // The GENERAL's own tool calls appear at the left margin:
  //   ● Edit(filename)     — 0-3 chars of leading whitespace before ●
  //   Bash: command         — 0-3 chars of leading whitespace
  //
  // Child output displayed in tool results appears:
  //   - Indented 4+ spaces (inside tool result blocks)
  //   - After ⎿ prefix (tool result continuation lines)
  //   - Inside JSON strings (curl output)
  const lines = tail.split('\n');

  // A line is "own output" if it starts at the left margin (0-3 chars indent)
  // and is NOT inside a tool result block (no ⎿ prefix).
  const isOwnOutputLine = (line) => {
    const trimmed = line.trimStart();
    const indent = line.length - trimmed.length;
    // Skip lines inside tool result blocks (⎿ prefix) or deeply indented
    if (indent > 3) return false;
    if (trimmed.startsWith('⎿')) return false;
    return true;
  };

  // Check file-modification tool patterns — only on own-output lines.
  // Patterns are ^-anchored, so test against trimmed line (whitespace already validated by isOwnOutputLine).
  for (const { pattern, description } of GENERAL_VIOLATION_PATTERNS) {
    for (const line of lines) {
      if (!isOwnOutputLine(line)) continue;
      const trimmed = line.trimStart();
      if (pattern.test(trimmed)) {
        violation = description;
        break;
      }
    }
    if (violation) break;
  }

  // Check implementation bash commands (only flag if NOT also matching allowed patterns)
  if (!violation) {
    for (const line of lines) {
      if (!isOwnOutputLine(line)) continue;
      const trimmed = line.trimStart();
      // Line must start with a Bash tool invocation (● Bash( or legacy Bash:)
      if (/^(?:● )?Bash[:(]/.test(trimmed)) {
        if (GENERAL_IMPL_BASH_RE.test(trimmed) && !GENERAL_ALLOWED_BASH_RE.test(trimmed)) {
          violation = 'run implementation commands via Bash';
          break;
        }
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

  const isColonelWorker = isProtectedOrColonel(worker) && !isProtectedWorker(worker);
  const roleName = isColonelWorker ? 'COLONEL' : 'GENERAL';
  const roleConstraint = isColonelWorker
    ? 'Colonels do NOT run test suites, build commands, or scripts inline. Spawn a TEST or IMPL worker instead'
    : 'Generals do NOT write code, edit files, or run implementation commands. Spawn a worker instead';
  const correctionMessage = `ROLE VIOLATION: You are a ${roleName}. You just attempted to ${violation}. ${roleConstraint}: curl -s -X POST ${STRATEGOS_API}/api/workers/spawn-from-template -H "Content-Type: application/json" -d '{"template":"impl","label":"IMPL: <task>","projectPath":"<path>","parentWorkerId":"${workerId}","task":{"description":"<what needs doing>"}}'`;

  logger.info(`[Sentinel] ROLE VIOLATION detected for ${roleName} ${workerId} (${worker.label}): ${violation} (count: ${worker.roleViolations})`);

  // Emit socket event
  if (io) {
    io.emit('worker:role:violation', {
      workerId,
      label: worker.label,
      violation,
      count: worker.roleViolations,
      timestamp: new Date().toISOString(),
    });
    io.to(`worker:${workerId}`).emit('worker:updated', normalizeWorker(worker));
  }

  // Interrupt the worker with correction
  try {
    await interruptWorker(workerId, correctionMessage, io);
    logger.info(`[Sentinel] Interrupted ${roleName} ${workerId} with correction message`);
  } catch (err) {
    logger.error(`[Sentinel] Failed to interrupt ${roleName} ${workerId}: ${err.message}`);
  }
}

// ============================================
// AUTO-CONTINUE: Rate Limit + Post-Compaction Recovery
// ============================================

/**
 * Classify billing-wall patterns in worker stdout tail.
 * Returns 'A', 'B', 'C', 'D', or null.
 *
 * A: per-session hard cap (You've hit your limit + extra-usage upsell).
 *    Distinct from a normal hourly rate limit — auto-continue is futile.
 * B: extra-usage balance exhausted.
 * C: Turn on extra usage interactive billing dialog.
 * D: Auto-reload billing dialog (recurring charge).
 *
 * Why C and D are neutral: these dialogs appear because something already
 * triggered /extra-usage or auto-reload configuration. Auto-accepting either
 * dialog would authorize a charge — Commander must approve. See Worker
 * Protection Protocol. Reference: 2026-04-30 incident, memory #112.
 */
export function classifyRateLimitWall(tail) {
  if (RATE_LIMIT_WALL_B.test(tail)) return 'B';
  if (RATE_LIMIT_PATTERN.test(tail) && RATE_LIMIT_WALL_A_CONFIRM.test(tail)) return 'A';
  if (RATE_LIMIT_WALL_C.test(tail) && RATE_LIMIT_WALL_C_CONFIRM.test(tail)) return 'C';
  if (RATE_LIMIT_WALL_D.test(tail) && RATE_LIMIT_WALL_D_CONFIRM.test(tail)) return 'D';
  return null;
}

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
function detectSessionLimits(workerId, stdout, io, cleanedOutput = null) {
  const worker = workers.get(workerId);
  if (!worker || worker.autoContinue === false) return;
  if (worker.backend === 'gemini' || worker.backend === 'aider') return; // Non-Claude rate limit patterns TBD

  // trimEnd() strips trailing whitespace from empty tmux pane rows
  // that can push rate limit text beyond the 1500-char tail window
  const cleaned = (cleanedOutput ?? stripAnsiCodes(stdout)).trimEnd();
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
      logger.info(`[AutoContinue] Rate limit detected for ${worker.label} (${workerId}), resets ~${new Date(worker.rateLimitResetAt).toLocaleTimeString()}`);
    } else {
      worker.rateLimitResetAt = null;
      logger.info(`[AutoContinue] Rate limit detected for ${worker.label} (${workerId}), reset time unknown`);
    }

    if (io) {
      io.emit('worker:rate_limited', { workerId, label: worker.label, resetAt: worker.rateLimitResetAt });
      io.to(`worker:${workerId}`).emit('worker:updated', normalizeWorker(worker));
    }
  } else if (!isRateLimited && worker._rateLimitDetected) {
    // Rate limit text scrolled off terminal tail — clear the detection guard only.
    // Do NOT clear _sessionLimitDetected, rateLimited, or rateLimitResetAt;
    // those clear only when auto-continue actually succeeds (in handleAutoContinue).
    worker._rateLimitDetected = false;
    logger.info(`[AutoContinue] Rate limit text scrolled off for ${worker.label} (${workerId}), keeping rate limit state until auto-continue`);
  }

  // --- Billing-wall detection (Patterns A–D: session/balance caps + billing dialogs) ---
  // Each pattern fires at most once per worker session (tracked in _rateLimitWallSeen Set).
  // Patterns A/B: signal Ralph blocked + pause autoAccept, clear session-limit flags so
  //   auto-continue never fires against a billing wall it cannot resolve.
  // Patterns C/D: Commander authorization required for billing; emit a notice only.
  const wallPattern = classifyRateLimitWall(tail);
  if (wallPattern) {
    if (!worker._rateLimitWallSeen) worker._rateLimitWallSeen = new Set();
    if (!worker._rateLimitWallSeen.has(wallPattern)) {
      worker._rateLimitWallSeen.add(wallPattern);
      logger.info(`[rate-limit] worker=${workerId} pattern=${wallPattern}`);
      if (wallPattern === 'A' || wallPattern === 'B') {
        worker._rateLimitWallDetected = true;
        // Suppress the normal rate-limit auto-continue path for this worker.
        worker._sessionLimitDetected = false;
        worker.rateLimited = false;
        worker.rateLimitResetAt = null;
        if (!worker.autoAcceptPaused) {
          worker.autoAcceptPaused = true;
          if (io) io.to(`worker:${workerId}`).emit('worker:updated', normalizeWorker(worker));
        }
        const reason = wallPattern === 'A' ? 'rate-limit:session' : 'rate-limit:balance';
        if (worker.ralphStatus !== 'blocked') {
          _rateLimitWallFns.signalRalphBlocked(workerId, {
            status: 'blocked',
            progress: worker.ralphProgress ?? 50,
            currentStep: 'rate-limit wall — awaiting Commander',
            reason,
          }, io);
        }
        if (io) io.emit('worker:rate_limit_wall', { workerId, label: worker.label, pattern: wallPattern, reason });
      } else {
        // Patterns C/D: billing dialog — Commander must authorize. Do NOT auto-respond.
        addActivity('rate_limit_wall', workerId, worker.label, worker.project || 'unknown',
          `Billing dialog detected (Pattern ${wallPattern}) — Commander authorization required to proceed`);
        if (io) io.emit('worker:rate_limit_wall', { workerId, label: worker.label, pattern: wallPattern });
      }
    }
  }

  // --- Compaction detection ---
  // Detect when Claude Code has compacted the conversation context.
  // Sets _compactionDetected flag for health.js to inject a re-orientation message.
  const cooldownMs = 5 * 60 * 1000; // 5 minutes
  const cooldownActive = worker._compactionDetectedAt && (Date.now() - worker._compactionDetectedAt < cooldownMs);
  if (!worker._compactionDetected && !cooldownActive) {
    const compactionTail = cleaned.slice(-3000);
    const isCompacted = CONTEXT_COMPACTION_PATTERNS.some(p => p.test(compactionTail));
    if (isCompacted) {
      worker._compactionDetected = true;
      worker._compactionDetectedAt = Date.now();
      worker.contextTokens = 0;
      logger.info(`[Compaction] Context compaction detected for ${worker.label} (${workerId})`);
      if (io) {
        io.emit('worker:compacted', { workerId, label: worker.label });
      }
    }
  }

  // --- Context token detection ---
  // Claude Code shows "/clear to save N.Nk tokens" in idle status bar
  const tokenMatch = tail.match(/\/clear to save ([\d.]+)k?\s*tokens/i);
  if (tokenMatch) {
    worker.contextTokens = parseFloat(tokenMatch[1]);
    worker.contextTokensUpdatedAt = Date.now();
  }

}

/**
 * Send a continuation message to an idle worker after rate limit.
 * Called from the idle-detection loop when conditions are met.
 */
async function handleAutoContinue(workerId, io) {
  const worker = workers.get(workerId);
  if (!worker) return;

  // Guard: don't exceed max attempts
  if ((worker._autoContinueAttempts || 0) >= AUTO_CONTINUE_MAX_ATTEMPTS) {
    if (!worker._autoContinueExhausted) {
      worker._autoContinueExhausted = true;
      logger.warn(`[AutoContinue] Max attempts (${AUTO_CONTINUE_MAX_ATTEMPTS}) reached for ${worker.label} (${workerId})`);
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

  const trigger = 'rate_limit';

  try {
    await sendInput(workerId, AUTO_CONTINUE_MESSAGE, io, { source: 'auto_continue' });

    // Clear all rate limit state after successful auto-continue.
    // _rateLimitDetected is now also cleared here (not on text scroll-off)
    // so detectSessionLimits() can detect a fresh rate limit if it recurs.
    worker._sessionLimitDetected = false;
    worker._rateLimitDetected = false;
    worker.rateLimited = false;
    worker.rateLimitResetAt = null;

    worker.autoContinueCount = (worker.autoContinueCount || 0) + 1;
    worker.lastActivity = new Date();
    logger.info(`[AutoContinue] Sent continuation to ${worker.label} (${workerId}), attempt ${worker._autoContinueAttempts}/${AUTO_CONTINUE_MAX_ATTEMPTS}`);
    if (io) {
      io.emit('worker:autocontinue', {
        workerId, label: worker.label,
        attempt: worker._autoContinueAttempts,
        trigger,
      });
      io.to(`worker:${workerId}`).emit('worker:updated', normalizeWorker(worker));
    }
  } catch (err) {
    logger.error(`[AutoContinue] Failed for ${worker.label} (${workerId}): ${err.message}`);
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
  logger.info('[PtyCapture] Starting global capture interval (every 5s)');

  const CAPTURE_CONCURRENCY = 5;

  globalCaptureInterval = setInterval(async () => {
    const entries = [...ptyInstances.entries()].filter(([workerId]) => {
      if (!workers.has(workerId)) {
        ptyInstances.delete(workerId);
        return false;
      }
      return true;
    });

    // Run captures in parallel with bounded concurrency (max 5).
    // A hung tmux session (5s timeout) blocks only its own slot, not the fleet.
    let idx = 0;
    async function runNext() {
      while (idx < entries.length) {
        const [workerId, instance] = entries[idx++];
        try {
          await captureWorkerOutput(workerId, instance, io);
        } catch (err) {
          logger.error(`[PtyCapture] Unhandled error for ${workerId}: ${err.message}`);
        }
      }
    }

    const slots = Array.from({ length: Math.min(CAPTURE_CONCURRENCY, entries.length) }, runNext);
    await Promise.all(slots);

    // Periodic orphan scan — runs every ~60s (every ORPHAN_SCAN_EVERY_N ticks)
    _orphanScanCycle++;
    if (_orphanScanCycle >= ORPHAN_SCAN_EVERY_N) {
      _orphanScanCycle = 0;
      scanOrphanedSessions(io).catch(err =>
        logger.error(`[OrphanScan] Scan failed: ${err.message}`));
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
    ], TMUX_CAPTURE_TIMEOUT_MS);

    if (sessionFailCounts.has(workerId)) {
      sessionFailCounts.delete(workerId);
    }

    const mid = Math.floor(stdout.length / 2);
    const hash = `${stdout.length}:${stdout.slice(-200)}:${stdout.slice(mid, mid + 50)}`;
    const outputChanged = hash !== instance.lastCaptureHash;

    const worker = workers.get(workerId);

    const MAX_OUTPUT_BUFFER = 2 * 1024 * 1024;
    if (stdout.length > MAX_OUTPUT_BUFFER) {
      if (!worker?._outputTruncationLogged) {
        logger.warn(`[PtyCapture] Worker ${workerId} output exceeds 2MB, truncating oldest data`);
        if (worker) worker._outputTruncationLogged = true;
      }
      stdout = stdout.slice(-MAX_OUTPUT_BUFFER);
    } else if (worker?._outputTruncationLogged) {
      worker._outputTruncationLogged = false;  // Buffer shrunk below limit, allow future warnings
    }
    outputBuffers.set(workerId, stdout);
    let _cleanedStdout = null;
    const getCleanedStdout = () => {
      if (_cleanedStdout === null) _cleanedStdout = stripAnsiCodes(stdout);
      return _cleanedStdout;
    };

    if (!outputChanged) {
      // Bulldoze continuation (existing)
      if (worker && worker.bulldozeMode && !worker.bulldozePaused && (worker.status === 'running' || worker.status === 'awaiting_review')) {
        worker.bulldozeIdleCount = (worker.bulldozeIdleCount || 0) + 1;

        if (worker.bulldozeIdleCount >= BULLDOZE_IDLE_THRESHOLD) {
          const cleaned = getCleanedStdout();
          const bulldozeTailSize = getBackendTailSize(worker.backend, 'wide');
          const tail = cleaned.slice(-bulldozeTailSize);

          const idlePatterns = getIdlePatterns(worker.backend);
          const activePatterns = getActivePatterns(worker.backend);
          const isAtIdlePrompt = idlePatterns.some(p => p.test(tail));
          const narrowTailSize = getBackendTailSize(worker.backend, 'narrow');
          const narrowTail = stripCompletedThinking(cleaned.slice(-narrowTailSize));
          const isActivelyWorking = activePatterns.some(p => p.test(narrowTail));

          if (worker.bulldozeIdleCount === BULLDOZE_IDLE_THRESHOLD) {
            logger.debug(`[Bulldoze] ${workerId} idle check: atPrompt=${isAtIdlePrompt} activeWork=${isActivelyWorking} idleCount=${worker.bulldozeIdleCount}`);
            if (!isAtIdlePrompt) {
              const lastChars = tail.slice(-100).replace(/\n/g, '\\n');
              logger.info(`[Bulldoze] ${workerId} tail (last 100): ${lastChars}`);
            }
          }

          if (isAtIdlePrompt && !isActivelyWorking) {
            handleBulldozeContinuation(workerId, io).catch(err =>
              logger.error(`[Bulldoze] Continuation failed for ${workerId}: ${err.message}`));
            worker.bulldozeIdleCount = 0;
          }
        }
      }

      // Forced autonomy: detect idle workers and push them to research/act instead of waiting
      if (_shouldContinueForcedAutonomy(workerId)) {
        worker._forcedAutonomyIdleCount = (worker._forcedAutonomyIdleCount || 0) + 1;
        worker._forcedAutonomyNudgeCount = worker._forcedAutonomyNudgeCount || 0;

        // Exponential backoff: 15s, 30s, 60s, 120s, ... capped at 30min
        const currentThreshold = Math.min(
          FORCED_AUTONOMY_BASE_THRESHOLD * Math.pow(FORCED_AUTONOMY_BACKOFF_FACTOR, worker._forcedAutonomyNudgeCount),
          FORCED_AUTONOMY_MAX_THRESHOLD
        );

        if (worker._forcedAutonomyIdleCount >= currentThreshold) {
          const cleaned = getCleanedStdout();
          const tailSize = getBackendTailSize(worker.backend, 'wide');
          const tail = cleaned.slice(-tailSize);
          const idlePatterns = getIdlePatterns(worker.backend);
          const activePatterns = getActivePatterns(worker.backend);
          const isAtIdlePrompt = idlePatterns.some(p => p.test(tail));
          const narrowTail = stripCompletedThinking(cleaned.slice(-getBackendTailSize(worker.backend, 'narrow')));
          const isActivelyWorking = activePatterns.some(p => p.test(narrowTail));

          if (isAtIdlePrompt && !isActivelyWorking) {
            const msg = generateAutonomyNudge(worker);
            logger.info(`[ForcedAutonomy] Nudge #${worker._forcedAutonomyNudgeCount} for ${worker.label} (${workerId}), next in ${Math.min(currentThreshold * 2, FORCED_AUTONOMY_MAX_THRESHOLD) * 5}s`);
            // Revert from done if nudging an awaiting_review worker back to activity.
            // Skip if MISSION_COMPLETE — done/held GENERALs should not be reverted.
            if (worker.status === 'awaiting_review' && classifyGeneralIdleState(worker) !== 'MISSION_COMPLETE') {
              import('./ralph.js').then(({ revertFromDone }) => revertFromDone(workerId, io, 'forced_autonomy_nudge')).catch(() => {});
            }
            withTmuxLock(workerId, async () => {
              await safeSendKeys(worker.tmuxSession, ['-l', msg]);
              await safeSendKeys(worker.tmuxSession, ['Enter']);
            }).catch(err => logger.error(`[ForcedAutonomy] Idle push failed for ${worker.label}: ${err.message}`));
            worker._forcedAutonomyIdleCount = 0;
            worker._forcedAutonomyNudgeCount++;
            worker._forcedAutonomyLastNudge = Date.now();
          }
        }
      }

      // Auto-continue for rate-limited workers (skip if bulldoze handles it or billing wall detected)
      if (worker && worker.autoContinue !== false && !worker.bulldozeMode &&
          worker.status === 'running' && worker._sessionLimitDetected &&
          worker.ralphStatus !== 'done' && !worker._rateLimitWallDetected) {

        if (worker.rateLimitResetAt && Date.now() >= worker.rateLimitResetAt) {
          // Time-driven: reset time reached — fire immediately, no idle pattern check needed.
          // The parsed reset time IS the trigger.
          handleAutoContinue(workerId, io).catch(err =>
            logger.error(`[AutoContinue] Continuation failed for ${workerId}: ${err.message}`));
          worker._autoContinueIdleCount = 0;
        } else if (!worker.rateLimitResetAt) {
          // No reset time known — fall back to idle-pattern detection
          worker._autoContinueIdleCount = (worker._autoContinueIdleCount || 0) + 1;

          const threshold = AUTO_CONTINUE_RATE_LIMIT_COOLDOWN;

          if (worker._autoContinueIdleCount >= threshold) {
            const cleaned = getCleanedStdout();
            const tail = cleaned.slice(-1500);
            const isIdle = CLAUDE_CODE_IDLE_PATTERNS.some(p => p.test(tail));
            const isActive = CLAUDE_CODE_ACTIVE_PATTERNS.some(p => p.test(stripCompletedThinking(cleaned.slice(-200))));

            if (isIdle && !isActive) {
              handleAutoContinue(workerId, io).catch(err =>
                logger.error(`[AutoContinue] Continuation failed for ${workerId}: ${err.message}`));
              worker._autoContinueIdleCount = 0;
            }
          }
        }
        // else: rateLimitResetAt is set but not reached yet — just wait
      }

      return;
    }

    // --- Output changed path ---

    if (worker) {
      handleAutoAcceptCheck(workerId, stdout, io, getCleanedStdout()).catch(err =>
        logger.error(`[PtyCapture] autoAcceptCheck failed for ${workerId}: ${err.message}`));
      checkGeneralRoleViolation(workerId, stdout, io, getCleanedStdout()).catch(err =>
        logger.error(`[PtyCapture] generalRoleViolation check failed for ${workerId}: ${err.message}`));
    }

    if (worker && worker.bulldozeMode) {
      worker.bulldozeIdleCount = 0;
    }
    if (worker && worker.forcedAutonomy) {
      worker._forcedAutonomyIdleCount = 0;  // Any output change means not idle
      // _forcedAutonomyNudgeCount resets only on Ralph signal receipt (ralph.js),
      // not on output length — resetting here nullifies the exponential backoff.
    }

    // Track consecutive done responses for loop detection
    if (worker && (worker.forcedAutonomy || worker.bulldozeMode)) {
      // Check for session end first
      if (isSessionEnded(stdout)) {
        if (!worker._sessionEnded) {
          logger.warn(`[DoneLoop] Session ended detected for ${worker.label} (${workerId})`);
          worker._sessionEnded = true;
          // Attempt auto-recovery if not already suppressed
          if (!worker._sessionRecoverySuppressed) {
            trySessionRecovery(workerId, io).catch(err =>
              logger.error(`[SessionRecovery] Recovery attempt failed for ${workerId}: ${err.message}`));
          }
        }
      }
      // Was a nudge recently sent? If so, check if this output is a done response
      else if (worker._forcedAutonomyLastNudge || worker._bulldozeLastNudge) {
        const nudgeAge = Date.now() - Math.max(worker._forcedAutonomyLastNudge || 0, worker._bulldozeLastNudge || 0);
        // Only count as a done-response-to-nudge if within 2 minutes of the last nudge
        if (nudgeAge < 120000 && isWorkerSignalingCompletion(stdout)) {
          worker._consecutiveDoneResponses = (worker._consecutiveDoneResponses || 0) + 1;
          logger.warn(`[DoneLoop] ${worker.label} (${workerId}) responded with done after nudge (count: ${worker._consecutiveDoneResponses})`);
        } else if (!isWorkerSignalingCompletion(stdout)) {
          // Substantive output — reset counter
          worker._consecutiveDoneResponses = 0;
        }
      }
    }

    // Auto-continue: detect rate limits in fresh output
    if (worker) {
      detectSessionLimits(workerId, stdout, io, getCleanedStdout());
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

    if (worker && worker.status === 'running') {
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
      logger.warn(`[PtyCapture] capture-pane failed for ${workerId} (${failCount}/${SESSION_FAIL_THRESHOLD}) - retrying`);
      return;
    }

    logger.error(`[PtyCapture] Session ${instance.sessionName} confirmed dead after ${failCount} consecutive capture failures for worker ${workerId}`);
    sessionFailCounts.delete(workerId);

    const w = workers.get(workerId);

    if (w && isProtectedOrColonel(w)) {
      logger.error(`[PtyCapture] CRITICAL: GENERAL/COLONEL worker ${workerId} (${w.label}) tmux session is DEAD. NOT auto-deleting — requires human intervention.`);
      w.health = 'dead';
      w.status = 'error';
      ptyInstances.delete(workerId);
      // Import stopHealthMonitor lazily
      const { stopHealthMonitor } = await import('./health.js');
      stopHealthMonitor(workerId);
      clearWorkerContext(workerId);
      try { markWorkerFailed(workerId); } catch (e) { /* may not be registered */ }
      if (io) {
        io.to(`worker:${workerId}`).emit('worker:updated', normalizeWorker(w));
        if (isProtectedWorker(w)) {
          io.emit('worker:general:dead', { workerId, label: w.label, message: 'GENERAL tmux session died - requires human intervention' });
        } else {
          io.emit('worker:colonel:dead', { workerId, label: w.label, message: 'COLONEL tmux session died - requires human intervention' });
        }
      }
      const { writeWorkerCheckpoint } = await import('./persistence.js');
      writeWorkerCheckpoint(workerId, 'session_died');
      if (w.workingDir) {
        const { removeStrategosContext } = await import('./templates.js');
        removeStrategosContext(w.workingDir, workerId).catch(err =>
          logger.error(`[PtyCapture] Failed to remove context for ${workerId}: ${err.message}`));
      }
      try {
        const { persistFailureLearning } = await import('./ralph.js');
        persistFailureLearning(w, workerId, 'session_died');
      } catch { /* best effort */ }
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

    // Record failure in learnings DB if worker never signaled done
    try {
      const { persistFailureLearning } = await import('./ralph.js');
      persistFailureLearning(w, workerId, 'session_died');
    } catch { /* best effort */ }

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
    invalidateWorkersCache();
    outputBuffers.delete(workerId);
    commandQueues.delete(workerId);
    _tmuxSendLock.delete(workerId);
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
          logger.error(`[PtyCapture] Failed to remove gemini context for ${workerId}: ${err.message}`));
      } else if (w.backend === 'aider') {
        const { removeAiderContext } = await import('./templates.js');
        removeAiderContext(w.workingDir, workerId).catch(err =>
          logger.error(`[PtyCapture] Failed to remove aider context for ${workerId}: ${err.message}`));
      } else {
        const { removeStrategosContext } = await import('./templates.js');
        removeStrategosContext(w.workingDir, workerId).catch(err =>
          logger.error(`[PtyCapture] Failed to remove context for ${workerId}: ${err.message}`));
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
    saveWorkerStateImmediate().catch(err => logger.error(`[PtyCapture] State save failed: ${err.message}`));
  }
}

export function stopPtyCapture(workerId) {
  ptyInstances.delete(workerId);
}

/**
 * Force the current in-memory terminal snapshot into the output DB.
 * Bypasses the 1-in-10 write throttle. Called before killWorker so
 * persistFailureLearning sees the last-known terminal state.
 */
export function flushCurrentOutputToDb(workerId) {
  const content = outputBuffers.get(workerId);
  if (content) {
    try { _outputDbFns.storeOutput(workerId, content, 'stdout'); } catch { /* best effort */ }
  }
}

export function stopAllPtyCaptures() {
  const count = ptyInstances.size;
  ptyInstances.clear();
  if (globalCaptureInterval) {
    clearInterval(globalCaptureInterval);
    globalCaptureInterval = null;
  }
  if (count > 0) {
    logger.info(`[Shutdown] Stopped PTY capture for ${count} worker(s)`);
  }
}

// ============================================
// AUTO-ACCEPT LOGIC
// ============================================

async function handleAutoAcceptCheck(workerId, output, io, cleanedOutput = null) {
  const worker = workers.get(workerId);
  if (!worker) return;

  const cleaned = cleanedOutput ?? stripAnsiCodes(output);
  // Gemini CLI renders large TUI boxes with padding — prompt text can be 3000+ chars from end
  const tailSize = worker.backend === 'gemini' ? 5000 : worker.backend === 'aider' ? 1000 : 500;
  const tail = cleaned.slice(-tailSize);

  // PROMPT ZONE: Extract only the last ~5 non-empty lines of output.
  // Permission prompts (e.g. "[Y/n]", "❯ 1. Yes, allow this") always appear at the
  // very end of the terminal. Matching against the full 500-char tail risks false positives
  // when LLM response text contains prompt-like words (e.g. "Do you want me to..." or
  // regex patterns like "❯.{0,8}(Yes..." written as discussion text).
  // Gemini uses wider prompt zones due to TUI box rendering.
  const promptZoneLines = worker.backend === 'gemini' ? 20 : worker.backend === 'aider' ? 8 : 5;
  const promptZone = cleaned.split('\n').filter(l => l.trim()).slice(-promptZoneLines).join('\n');

  let promptDetected = false;
  let matchedPattern = null;

  // Select accept patterns based on worker backend
  const acceptPatterns = getAcceptPatterns(worker.backend);

  // Use prompt zone (not full tail) for pattern matching to prevent self-match on LLM text
  const zoneLower = promptZone.toLowerCase();
  const hasPromptChars = promptZone.includes('[') || promptZone.includes('(') || promptZone.includes('\u276f') ||
    promptZone.includes('\u25cf') || promptZone.includes('>') ||
    zoneLower.includes('want') || zoneLower.includes('allow') ||
    zoneLower.includes('press') || zoneLower.includes('yes') ||
    zoneLower.includes('trust');
  if (hasPromptChars) {
    for (const pattern of acceptPatterns) {
      if (pattern.test(promptZone)) {
        promptDetected = true;
        matchedPattern = pattern;
        break;
      }
    }
  }

  if (promptDetected !== !!worker.waitingAtPrompt) {
    worker.waitingAtPrompt = promptDetected;
    if (io) io.to(`worker:${workerId}`).emit('worker:updated', normalizeWorker(worker));
  }

  if (worker.autoAccept && !worker.autoAcceptPaused) {
    const wideTailSize = getBackendTailSize(worker.backend, 'wide');
    const wideTail = cleaned.slice(-wideTailSize);
    const idlePats = getIdlePatterns(worker.backend);
    const activePats = getActivePatterns(worker.backend);
    const isIdle = idlePats.some(p => p.test(wideTail)) &&
                   !activePats.some(p => p.test(stripCompletedThinking(wideTail)));
    if (isIdle) {
      for (const { pattern, command, description } of AUTO_COMMAND_PATTERNS) {
        if (pattern.test(wideTail)) {
          const cmdHash = simpleHash(wideTail + command);
          if (cmdHash !== worker._lastAutoCommandHash) {
            worker._lastAutoCommandHash = cmdHash;
            logger.info(`[AutoCommand] Sending "${command}" to ${worker.label} (${description})`);
            try {
              await safeSendKeys(worker.tmuxSession, ['-l', command]);
              await safeSendKeys(worker.tmuxSession, ['Escape']);
              await new Promise(r => setTimeout(r, 300));
              await safeSendKeys(worker.tmuxSession, ['Enter']);
            } catch (err) {
              logger.error(`[AutoCommand] Failed for ${worker.label}: ${err.message}`);
            }
            return;
          }
        }
      }
    }
  }

  if (!worker.autoAccept) return;

  const promptLineSize = getBackendTailSize(worker.backend, 'prompt');
  const promptLine = cleaned.slice(-promptLineSize).toLowerCase();

  let pauseKeywordFound = false;
  for (const keyword of AUTO_ACCEPT_PAUSE_KEYWORDS) {
    if (promptLine.includes(keyword.toLowerCase())) {
      pauseKeywordFound = true;
      break;
    }
  }

  if (pauseKeywordFound && worker.forcedAutonomy) {
    logger.info(`[ForcedAutonomy] Intercepting question for ${worker.label}`);
    const msg = 'Do NOT ask the user. You have forcedAutonomy enabled. Answer this question yourself using available tools: WebSearch, WebFetch, Grep, Read, Glob. If you cannot find the answer, make your best judgment call and document the assumption. Proceed without human input.';
    try {
      await withTmuxLock(workerId, async () => {
        await safeSendKeys(worker.tmuxSession, ['-l', msg]);
        await safeSendKeys(worker.tmuxSession, ['Enter']);
      });
    } catch (err) {
      logger.error(`[ForcedAutonomy] Failed for ${worker.label}: ${err.message}`);
    }
    return;
  }

  if (pauseKeywordFound && !worker.autoAcceptPaused) {
    logger.info(`[AutoAccept] Pausing for ${worker.label} - detected pause keyword`);
    worker.autoAcceptPaused = true;
    if (io) {
      io.to(`worker:${workerId}`).emit('worker:updated', normalizeWorker(worker));
    }
    return;
  } else if (!pauseKeywordFound && worker.autoAcceptPaused) {
    logger.info(`[AutoAccept] Auto-resuming for ${worker.label} - no pause keywords in output`);
    worker.autoAcceptPaused = false;
    worker.lastAutoAcceptHash = null;
    if (io) {
      io.to(`worker:${workerId}`).emit('worker:updated', normalizeWorker(worker));
    }
  }

  if (worker.autoAcceptPaused) return;
  if (!promptDetected) return;

  const hash = simpleHash(promptZone);
  if (hash === worker.lastAutoAcceptHash) {
    return;
  }

  worker.lastAutoAcceptHash = hash;

  if (_sendingInput.has(workerId)) {
    worker.lastAutoAcceptHash = null;
    return;
  }

  logger.info(`[AutoAccept] Accepting prompt for ${worker.label} (matched: ${matchedPattern})`);

  try {
    await withTmuxLock(workerId, async () => {
      await safeSendKeys(worker.tmuxSession, ['Enter']);
    });
    logger.debug(`[AutoAccept] Sent Enter to ${worker.label}`);

    setTimeout(() => {
      const w = workers.get(workerId);
      if (w && w.autoAccept) {
        w.lastAutoAcceptHash = null;
      }
    }, 3000);
  } catch (error) {
    logger.error(`[AutoAccept] Failed to send keys for ${worker.label}:`, error.message);
  }
}

// ============================================
// BULLDOZE MODE: Continuation Engine
// ============================================

/**
 * Parse the END STATE section from a task description.
 * Returns the section content string if found, null otherwise.
 * Stops at the next blank line or uppercase section header (e.g. GUARDRAILS:).
 */
function parseEndStateSection(description) {
  if (!description) return null;
  const idx = description.indexOf('END STATE:');
  if (idx === -1) return null;
  const after = description.slice(idx + 'END STATE:'.length);
  const lines = after.split('\n');
  const contentLines = [];
  for (const line of lines) {
    if (contentLines.length === 0 && !line.trim()) continue;
    if (contentLines.length > 0 && !line.trim()) break;
    if (/^[A-Z][A-Z ]{2,}:/.test(line.trim())) break;
    contentLines.push(line);
  }
  return contentLines.join('\n').trim() || null;
}

/**
 * Classify the idle state of a persistent-tier worker (GENERAL/COLONEL) to
 * determine what kind of nudge (if any) is appropriate.
 */
function classifyGeneralIdleState(worker) {
  const hasLearnings = !!(worker.ralphLearnings && worker.ralphLearnings.trim());
  const directChildren = [...workers.values()].filter(
    w => w.parentWorkerId === worker.id && w.health !== 'dead' && w.health !== 'crashed'
  );
  const activeChildren = directChildren.filter(
    w => ['running', 'awaiting_review', 'pending'].includes(w.status)
  ).length;
  const uptimeMs = Date.now() - new Date(worker.createdAt).getTime();
  const hasStarted = (worker._forcedAutonomyNudgeCount || 0) > 0 ||
                     (worker.ralphStatus && worker.ralphStatus !== 'pending');

  if (worker._missionComplete) return 'MISSION_COMPLETE';
  if (worker.ralphStatus === 'done' || worker.ralphStatus === 'held') return 'MISSION_COMPLETE';
  if (hasLearnings && activeChildren === 0) return 'MISSION_COMPLETE';
  if (parseEndStateSection(worker.task?.description) !== null &&
      directChildren.length > 0 &&
      directChildren.every(c => c.ralphStatus === 'done' || c.ralphStatus === 'held')) {
    return 'MISSION_COMPLETE';
  }
  if (activeChildren > 0) return 'AWAITING_CHILDREN';
  if (!hasStarted && uptimeMs < 5 * 60 * 1000) return 'UNSTARTED';
  return 'GENUINELY_STUCK';
}

/**
 * Guard function: should forced autonomy nudge this worker?
 * Mirrors shouldContinueBulldoze() but for the lighter forced autonomy mode.
 */
export function _shouldContinueForcedAutonomy(workerId) {
  const worker = workers.get(workerId);
  if (!worker || !worker.forcedAutonomy) return false;
  // Allow running and awaiting_review (done workers with explicit forcedAutonomy get nudged)
  if (worker.status !== 'running' && worker.status !== 'awaiting_review') return false;
  if (worker.health === 'crashed' || worker.health === 'dead') return false;
  // Don't nudge blocked/suppressed workers
  // Note: done/awaiting_review workers ARE nudged if forcedAutonomy was explicitly enabled
  // (Commander override). Auto-suppress flag handles the "finished naturally" case.
  if (worker.ralphStatus === 'blocked' || worker.ralphStatus === 'held') return false;
  if (worker._forcedAutonomySuppressed) return false;

  // Don't nudge session-ended workers (unless recovery is in progress)
  if (worker._sessionEnded) return false;

  // Don't nudge if session recovery exhausted rate limit
  if (worker._sessionRecoverySuppressed) return false;

  // Don't nudge if worker keeps saying "done" — consecutive done-response loop detection
  if ((worker._consecutiveDoneResponses || 0) >= 2) {
    if (!worker._forcedAutonomySuppressed) {
      logger.warn(`[ForcedAutonomy] Auto-suppressing for ${worker.label} (${workerId}) — ${worker._consecutiveDoneResponses} consecutive done responses`);
      worker._forcedAutonomySuppressed = true;
    }
    return false;
  }

  // Don't nudge if last output signals completion
  // Exception: GENERALs naturally output completion-like text ("all workers complete",
  // "results delivered") after each wave — they should still be nudged to find more work.
  const stdout = outputBuffers.get(workerId);
  const workerTypeInfo = detectWorkerType(worker.label);
  if (stdout && !workerTypeInfo.isGeneral && isWorkerSignalingCompletion(stdout)) return false;

  // Check for session end (Claude feedback survey)
  if (stdout && isSessionEnded(stdout)) {
    logger.warn(`[ForcedAutonomy] Session ended for ${worker.label} (${workerId}) — suppressing all nudges`);
    worker._sessionEnded = true;
    return false;
  }

  // Don't nudge within 3 min of Commander sending input (prevents spam during active chat)
  if (Date.now() - (worker._lastHumanInputAt || 0) < 180000) return false;

  // Don't nudge if command queue has items
  const queue = commandQueues.get(workerId) || [];
  if (queue.length > 0) return false;

  // Don't nudge if actively sending input
  if (_sendingInput.has(workerId)) return false;

  // For persistent-tier workers (GENERALs/COLONELs), classify idle state and suppress if mission-complete
  if (isProtectedOrColonel(worker)) {
    const state = classifyGeneralIdleState(worker);
    if (state === 'MISSION_COMPLETE') {
      if (worker._missionCompleteNotified) {
        // Already sent the one-time reminder — suppress permanently
        if (!worker._forcedAutonomySuppressed) {
          logger.info(`[ForcedAutonomy] GENERAL mission-complete suppressed after notification`, { label: worker.label, workerId });
          worker._forcedAutonomySuppressed = true;
        }
        return false;
      }
      // First time we see MISSION_COMPLETE: allow nudge to fire the targeted reminder
      worker._pendingMissionCompleteReminder = true;
      return true;
    }
    // AWAITING_CHILDREN: reset idle count, do not nudge
    if (state === 'AWAITING_CHILDREN') {
      worker._forcedAutonomyIdleCount = 0;
      return false;
    }
    // UNSTARTED / GENUINELY_STUCK: fall through to standard nudge
  }

  // Don't nudge if active children are running
  const childIds = worker.childWorkerIds || [];
  if (childIds.length > 0) {
    const activeChildren = childIds.filter(cid => {
      const child = workers.get(cid);
      if (!child) return false;
      if (child.health === 'dead' || child.health === 'crashed') return false;
      return child.status === 'running' && (child.ralphStatus === 'in_progress' || child.ralphStatus === 'pending');
    });
    if (activeChildren.length > 0) return false;
  }

  return true;
}

/**
 * Generate context-aware nudge messages that vary by nudge count.
 * Earlier nudges are gentle; later ones are direct and shorter to save context.
 */
function generateAutonomyNudge(worker) {
  if (worker._pendingMissionCompleteReminder) {
    worker._missionCompleteNotified = true;
    worker._pendingMissionCompleteReminder = false;
    return 'Your mission appears complete (learnings filed, no active children). If correct, signal held with reason "mission complete, awaiting dismissal" — the system will then stop nudging you.';
  }

  const nudgeCount = worker._forcedAutonomyNudgeCount || 0;
  const workerType = detectWorkerType(worker.label);

  // GENERALs get special nudges — they must spawn workers, never idle
  if (workerType.isGeneral) {
    // Check actual child count to avoid misleading "no active workers" when children are pending/done
    const childIds = worker.childWorkerIds || [];
    const childStates = childIds.map(cid => workers.get(cid)).filter(Boolean);
    const pendingChildren = childStates.filter(c => c.status === 'running' && c.ralphStatus === 'pending');
    if (pendingChildren.length > 0) {
      return `You have ${pendingChildren.length} worker(s) still initializing (pending first Ralph signal). Wait for them to report in before spawning more. Check /children to monitor their status.`;
    }

    if (nudgeCount === 0) {
      return 'You have no active workers. Spawn new ones NOW. Research improvements, run tests, optimize code, fix bugs. A GENERAL must always have workers running. Check git log for recent changes that need testing, check /api/insights/learnings for failure patterns, search the codebase for TODOs and bugs.';
    }
    if (nudgeCount === 1) {
      return 'You appear idle with no active children. If your task is complete or awaiting Commander direction, signal held. If you genuinely have outstanding work, identify and spawn it now. Do NOT invent low-value filler work to stay busy.';
    }
    if (nudgeCount === 2) {
      return 'CRITICAL: A GENERAL with no children is failing its mission. Spawn workers IMMEDIATELY. If you have run out of ideas, use WebSearch to research improvements for this project. Check the codebase for any bugs, missing tests, performance issues, or code quality problems. You must NEVER be idle.';
    }
    return 'Spawn workers NOW. You must always have active children. Research new improvements if needed.';
  }

  // Non-GENERAL workers: standard nudges
  // First nudge: gentle
  if (nudgeCount === 0) {
    return 'You appear to be idle. Continue working on your current task. If you need information, use WebSearch, Grep, or Read to find it yourself. Do not wait for human input.';
  }

  // Second nudge: include task context
  if (nudgeCount === 1) {
    const taskSnippet = worker.task?.description
      ? ` Your task: "${worker.task.description.slice(0, 100)}..."`
      : '';
    return `You are still idle.${taskSnippet} If you are stuck, try a different approach. If you have completed your task, signal done via Ralph. Do not wait for human input.`;
  }

  // Third nudge: direct about signaling
  if (nudgeCount === 2) {
    return 'You have been idle for an extended period. If your work is complete, you MUST signal done via Ralph immediately. If you are blocked, signal blocked with a reason. If you have more work, resume now.';
  }

  // Beyond third: minimal to save context
  return 'Resume work or signal done/blocked via Ralph.';
}

function shouldContinueBulldoze(workerId) {
  const worker = workers.get(workerId);
  if (!worker || !worker.bulldozeMode || worker.bulldozePaused) return false;
  if (worker.status !== 'running' && worker.status !== 'awaiting_review') return false;
  if (worker.health === 'crashed' || worker.health === 'dead') return false;
  // Don't bulldoze session-ended workers
  if (worker._sessionEnded) return false;

  // Don't bulldoze if session recovery exhausted rate limit
  if (worker._sessionRecoverySuppressed) return false;

  // Consecutive done-response loop detection
  if ((worker._consecutiveDoneResponses || 0) >= 2) {
    logger.warn(`[Bulldoze] Auto-pausing for ${worker.label} (${workerId}) — ${worker._consecutiveDoneResponses} consecutive done responses`);
    worker.bulldozePaused = true;
    worker.bulldozePauseReason = 'done_loop';
    return false;
  }

  // Don't bulldoze if last output signals completion
  const stdout = outputBuffers.get(workerId);
  if (stdout && isWorkerSignalingCompletion(stdout)) return false;

  // Check for session end (Claude feedback survey)
  if (stdout && isSessionEnded(stdout)) {
    logger.warn(`[Bulldoze] Session ended for ${worker.label} (${workerId}) — suppressing bulldoze`);
    worker._sessionEnded = true;
    worker.bulldozePaused = true;
    worker.bulldozePauseReason = 'session_ended';
    return false;
  }

  if (worker.bulldozeStartedAt && !isProtectedOrColonel(worker)) {
    const hoursElapsed = (Date.now() - new Date(worker.bulldozeStartedAt).getTime()) / 3600000;
    if (hoursElapsed >= BULLDOZE_MAX_HOURS) {
      logger.info(`[Bulldoze] Worker ${workerId} hit time limit (${BULLDOZE_MAX_HOURS}h), pausing`);
      worker.bulldozePaused = true;
      worker.bulldozePauseReason = 'time_limit';
      return false;
    }
  }

  // Held-state backoff: after 2+ bulldoze cycles while held, require a 4-hour minimum
  // interval before firing another continuation. The worker is intentionally waiting for
  // Commander direction — repeated nudges are noise, not value.
  if (worker.ralphStatus === 'held') {
    if ((worker._heldBulldozeCycles || 0) >= 2) {
      const HELD_BACKOFF_MS = 4 * 60 * 60 * 1000;
      const lastCycleAt = worker.bulldozeLastCycleAt
        ? new Date(worker.bulldozeLastCycleAt).getTime()
        : 0;
      if (Date.now() - lastCycleAt < HELD_BACKOFF_MS) return false;
    }
  } else {
    // Worker transitioned out of held — reset the held-cycle counter
    worker._heldBulldozeCycles = 0;
  }

  if ((worker.bulldozeConsecutiveErrors || 0) >= 3) {
    logger.info(`[Bulldoze] Worker ${workerId} hit 3 consecutive errors, pausing`);
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
      return child.status === 'running' && (child.ralphStatus === 'in_progress' || child.ralphStatus === 'pending');
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
  const autonomyReminder = worker.forcedAutonomy ? '\n\nREMINDER: You are in FORCED AUTONOMY mode. Do NOT ask the human anything. Research answers yourself using WebSearch, WebFetch, Grep, Read. Make decisions and execute.' : '';

  if (isAuditCycle) {
    if (workerType.isGeneral) {
      return `${BULLDOZE_CONTINUATION_PREFIX} cycle ${cycleNum} - AUDIT]\nCommander, conduct a strategic review. State file: ${stateFilePath}\n\nASSESS: git log --oneline -20, check children status via /children endpoint, review error logs. What improved since last cycle? What degraded? What's the highest-impact work remaining?\n\nACT: Update the state file with fresh findings. Spawn workers for the top discoveries. If you have zero active children, IMMEDIATELY spawn workers for new improvement tracks.\n\nIf your audit reveals genuine completion or no high-priority work remains, signal held with a clear stopping point. Do NOT invent low-value filler work to stay busy. The mission resumes when there is real work to do.${autonomyReminder}`;
    }
    return `${BULLDOZE_CONTINUATION_PREFIX} cycle ${cycleNum} - AUDIT]\nConduct a fresh audit of your domain. State file: ${stateFilePath}\n\nASSESS: git log --oneline -20, run test suites, review error logs, compare to best practices. Add NEW findings to your backlog.\n\nACT: Pick the highest-impact finding and implement it. Commit. Update state file.${autonomyReminder}`;
  }

  if (workerType.isGeneral) {
    return `${BULLDOZE_CONTINUATION_PREFIX} cycle ${cycleNum}]\nCommander, next mission cycle. State file: ${stateFilePath}\n\nSITREP: Read state file. Check git log --oneline -10. Check children status via /children endpoint.\n\nEXECUTE: Identify the highest-priority incomplete item. Spawn a worker for it — do NOT implement it yourself. Monitor and drive to completion. Update the state file.\n\nIf you have zero active children, IMMEDIATELY spawn workers for new improvement tracks. Check git log for recent changes that need testing, check the codebase for bugs, research optimizations. A GENERAL with no children is FAILING.\n\nIf all current items need human action, write "## Status: NEEDS_HUMAN" for those items and signal held — do NOT invent filler work for the rest. A GENERAL waiting on Commander direction is operating correctly.${autonomyReminder}`;
  }

  return `${BULLDOZE_CONTINUATION_PREFIX} cycle ${cycleNum}]\nNext mission cycle. State file: ${stateFilePath}\n\nSITREP: Read state file. Check git log --oneline -10 to avoid redoing committed work.\n\nEXECUTE: Pick the highest-priority incomplete item. Implement it thoroughly. Test. Commit with descriptive message. Update state file — mark complete, add any new discoveries. Signal Ralph.\n\nIf all remaining items are low-impact or need human action, write "## Status: EXHAUSTED" in the state file.${autonomyReminder}`;
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

  const workerType = detectWorkerType(worker.label);
  const mission = settings.bulldozeMission || 'Autonomous improvement of this project';
  const backlog = settings.bulldozeBacklog || '';
  const standingOrders = settings.bulldozeStandingOrders || '';

  const backlogItems = backlog
    ? backlog.split('\n').filter(line => line.trim()).map(line => `- [ ] ${line.trim()}`).join('\n')
    : '- [ ] Audit codebase for improvements\n- [ ] Run tests and fix failures\n- [ ] Review error handling';

  const defaultStandingOrders = workerType.isGeneral
    ? '- NEVER write "## Status: EXHAUSTED" — use held-state when backlog is exhausted\n- When backlog is empty, signal held with reason — do not invent filler work\n- Check /api/insights/learnings for past failure patterns to fix\n- Check /api/insights/success-rate for underperforming worker types\n- Git commit after every meaningful change\n- COLONELs may signal done when their cycle completes — that is correct behavior, not a failure'
    : '- Git commit after every meaningful change\n- Run tests before and after changes\n- Never break existing functionality';

  const standingOrdersSection = standingOrders
    ? standingOrders.split('\n').filter(line => line.trim()).map(line => `- ${line.trim()}`).join('\n')
    : defaultStandingOrders;

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
  logger.info(`[Bulldoze] Created state file for ${worker.id} at ${stateFilePath}`);
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
      logger.info(`[Bulldoze] Reset state file status to ACTIVE for ${worker.id}`);
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
  const isExhaustedProtected = stateStatus === 'exhausted' && worker.forcedAutonomy;
  if (stateStatus !== 'ok' && !isExhaustedProtected) {
    logger.info(`[Bulldoze] Worker ${workerId} state file says "${stateStatus}", pausing`);
    worker.bulldozePaused = true;
    worker.bulldozePauseReason = stateStatus;
    if (io) {
      io.to(`worker:${workerId}`).emit('worker:updated', normalizeWorker(worker));
      io.emit('worker:bulldoze:paused', {
        workerId,
        reason: stateStatus,
        cyclesCompleted: worker.bulldozeCyclesCompleted || 0
      });
    }
    return;
  }
  if (isExhaustedProtected) {
    logger.info(`[Bulldoze] Worker ${workerId} EXHAUSTED ignored (forcedAutonomy), resetting state file`);
    await resetBulldozeStateFileStatus(worker);
  }

  const metrics = await collectBulldozeMetrics(worker);
  if (metrics) {
    worker.bulldozeMetrics = metrics;
    const prevCommits = worker._bulldozePrevCommitCount || 0;
    const newCommits = metrics.totalCommits - prevCommits;
    worker._bulldozePrevCommitCount = metrics.totalCommits;

    if (newCommits === 0) {
      worker._bulldozeNoCommitCycles = (worker._bulldozeNoCommitCycles || 0) + 1;
      // GENERALs/COLONELs delegate — they don't commit code, their children do. Skip no_commits pause.
      if (!isProtectedOrColonel(worker) && worker._bulldozeNoCommitCycles >= 5) {
        logger.warn(`[Bulldoze] Worker ${workerId} stalled — ${worker._bulldozeNoCommitCycles} cycles without commits, auto-pausing`);
        worker.bulldozePaused = true;
        worker.bulldozePauseReason = 'no_commits';
        if (io) {
          io.to(`worker:${workerId}`).emit('worker:updated', normalizeWorker(worker));
          io.emit('worker:bulldoze:paused', {
            workerId,
            reason: 'no_commits',
            cyclesCompleted: worker.bulldozeCyclesCompleted || 0
          });
        }
        return;
      } else if (!isProtectedOrColonel(worker) && worker._bulldozeNoCommitCycles >= 3) {
        logger.warn(`[Bulldoze] Worker ${workerId} has gone ${worker._bulldozeNoCommitCycles} cycles without commits — possible stall`);
      }
    } else {
      worker._bulldozeNoCommitCycles = 0;
    }

    logger.info(`[Bulldoze] Metrics for ${workerId}: ${metrics.totalCommits} total commits (fix:${metrics.fixes} feat:${metrics.feats} wip:${metrics.wips}) +${newCommits} new this cycle`);
  }

  const prompt = generateBulldozeContinuation(worker);

  try {
    await sendInput(workerId, prompt, io, { source: 'bulldoze' });
    worker.bulldozeCyclesCompleted = (worker.bulldozeCyclesCompleted || 0) + 1;
    worker.bulldozeLastCycleAt = new Date();
    worker._bulldozeLastNudge = Date.now();
    worker.lastActivity = new Date();
    worker.bulldozeIdleCount = 0;
    worker.bulldozeConsecutiveErrors = 0;
    if (worker.ralphStatus === 'held') {
      worker._heldBulldozeCycles = (worker._heldBulldozeCycles || 0) + 1;
    }

    const isAudit = worker.bulldozeCyclesCompleted % BULLDOZE_AUDIT_EVERY_N_CYCLES === 0;
    logger.info(`[Bulldoze] Sent cycle ${worker.bulldozeCyclesCompleted} to ${worker.label} (${workerId})${isAudit ? ' [AUDIT]' : ''}`);

    if (io) {
      io.to(`worker:${workerId}`).emit('worker:updated', normalizeWorker(worker));
      io.emit('worker:bulldoze:cycle', {
        workerId,
        cycle: worker.bulldozeCyclesCompleted,
        isAudit,
        metrics: metrics || undefined,
      });
    }

    const { saveWorkerState } = await import('./persistence.js');
    saveWorkerState().catch(err => logger.error(`[Bulldoze] State save failed: ${err.message}`));
  } catch (err) {
    worker.bulldozeConsecutiveErrors = (worker.bulldozeConsecutiveErrors || 0) + 1;
    logger.error(`[Bulldoze] Failed to send continuation to ${workerId} (errors: ${worker.bulldozeConsecutiveErrors}): ${err.message}`);
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
    logger.info(`[AutoAccept] ${worker.label} autoAccept set to ${settings.autoAccept}`);
  }

  if (settings.autoAcceptPaused !== undefined) {
    if (typeof settings.autoAcceptPaused !== 'boolean') {
      throw new Error('autoAcceptPaused must be a boolean');
    }
    worker.autoAcceptPaused = settings.autoAcceptPaused;
    if (!settings.autoAcceptPaused) {
      worker.lastAutoAcceptHash = null;
    }
    logger.info(`[AutoAccept] ${worker.label} autoAcceptPaused set to ${settings.autoAcceptPaused}`);
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
    logger.info(`[AutoContinue] ${worker.label} autoContinue set to ${settings.autoContinue}`);
  }

  if (settings.ralphMode !== undefined) {
    if (typeof settings.ralphMode !== 'boolean') {
      throw new Error('ralphMode must be a boolean');
    }
    worker.ralphMode = settings.ralphMode;
    if (settings.ralphMode) {
      worker.ralphToken = crypto.randomBytes(16).toString('hex');
      logger.info(`[Ralph] ${worker.label} Ralph mode ENABLED (token: ${worker.ralphToken.slice(0, 8)}...)`);
    } else {
      worker.ralphToken = null;
      logger.info(`[Ralph] ${worker.label} Ralph mode DISABLED`);
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
        import('./ralph.js').then(({ revertFromDone }) => revertFromDone(workerId, io, 'bulldoze_enabled')).catch(() => {});
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
          forcedAutonomy: worker.forcedAutonomy,
          parentWorkerId: worker.parentWorkerId,
          parentLabel: worker.parentLabel,
        }))
        .catch(err => logger.error(`[Bulldoze] Failed to set up bulldoze for ${workerId}: ${err.message}`));
      logger.info(`[Bulldoze] ${worker.label} bulldoze mode ENABLED`);
    } else {
      logger.info(`[Bulldoze] ${worker.label} bulldoze mode DISABLED (${worker.bulldozeCyclesCompleted || 0} cycles completed)`);
      // Rewrite rules file without <bulldoze> section
      const rewriteContext = writeStrategosContext(worker.id, worker.label, worker.workingDir, worker.ralphToken, {
        parentWorkerId: worker.parentWorkerId,
        parentLabel: worker.parentLabel,
        bulldozeMode: false,
        forcedAutonomy: worker.forcedAutonomy,
      });
      rewriteContext.catch(err => logger.error(`[Bulldoze] Failed to rewrite rules for ${workerId}: ${err.message}`));
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
        logger.error(`[Bulldoze] Failed to reset state file for ${workerId}: ${err.message}`)
      );
    }
    logger.info(`[Bulldoze] ${worker.label} bulldozePaused set to ${settings.bulldozePaused}`);
  }

  if (settings.forcedAutonomy !== undefined) {
    if (typeof settings.forcedAutonomy !== 'boolean') {
      throw new Error('forcedAutonomy must be a boolean');
    }
    worker.forcedAutonomy = settings.forcedAutonomy;
    if (settings.forcedAutonomy) {
      // Commander explicitly enabling autonomy overrides any auto-suppression
      worker._forcedAutonomySuppressed = false;
      worker._forcedAutonomyNudgeCount = 0;
      if (worker.autoAcceptPaused) {
        worker.autoAcceptPaused = false;
      }
    }
    writeStrategosContext(worker.id, worker.label, worker.workingDir, worker.ralphToken, {
      bulldozeMode: worker.bulldozeMode,
      forcedAutonomy: worker.forcedAutonomy,
      parentWorkerId: worker.parentWorkerId,
      parentLabel: worker.parentLabel,
    }).catch(err => logger.error(`[ForcedAutonomy] Failed to rewrite rules: ${err.message}`));
    logger.info(`[ForcedAutonomy] ${worker.label} forcedAutonomy set to ${settings.forcedAutonomy}`);
  }

  if (io) {
    io.to(`worker:${workerId}`).emit('worker:updated', normalizeWorker(worker));
  }

  // Persist settings to disk so they survive server restarts.
  // Without this, toggles (e.g. forcedAutonomy OFF) only take effect in memory
  // and revert to old values on restart.
  import('./persistence.js').then(({ saveWorkerState }) => {
    saveWorkerState().catch(err => logger.error(`[Settings] State save failed: ${err.message}`));
  });

  return worker;
}

// ============================================
// COMMAND QUEUING / INPUT
// ============================================

export async function sendInput(workerId, input, io = null, { fromWorkerId, source } = {}) {
  const worker = workers.get(workerId);

  if (!worker) {
    throw new Error(`Worker ${workerId} not found`);
  }

  // If worker is in awaiting_review and input is from a non-system source, revert to running
  const systemSources = new Set(['health', 'stall_check', 'auto_continue', 'session_recovery', 'ralph:result_delivery']);
  const effectiveSource = source || (fromWorkerId ? `worker:${fromWorkerId}` : 'unknown');
  if (worker.status === 'awaiting_review' && !systemSources.has(effectiveSource)) {
    import('./ralph.js').then(({ revertFromDone }) => revertFromDone(workerId, io, `sendInput:${effectiveSource}`)).catch(() => {});
  // Commander-only: only Commander UI or REST API input should un-hold a held worker; worker-to-worker input leaves held state intact.
  } else if (worker.ralphStatus === 'held' && (effectiveSource === 'web_ui' || effectiveSource === 'rest_api')) {
    import('./ralph.js').then(({ revertFromHeld }) => revertFromHeld(workerId, io, `sendInput:${effectiveSource}`)).catch(() => {});
  } else {
    // Cancel auto-dismiss timer for any input (lazy import to avoid circular dep)
    import('./ralph.js').then(({ cancelAutoDismissTimer }) => cancelAutoDismissTimer(workerId)).catch(() => {});
  }

  // Track last human input time to suppress nudges during active chat
  if (effectiveSource === 'web_ui' || effectiveSource === 'rest_api') {
    worker._lastHumanInputAt = Date.now();
  }

  // --- Input Audit Log ---
  const truncated = typeof input === 'string' ? input.slice(0, 200) : '(non-string)';
  const src = source || (fromWorkerId ? `worker:${fromWorkerId}` : 'unknown');
  logger.info(`[InputAudit] to=${workerId} (${worker.label}) from=${src} len=${typeof input === 'string' ? input.length : 0} text="${truncated.replace(/[\n\r]/g, ' ')}"`);
  logger.info(`[input] accepted for worker ${workerId} from ${fromWorkerId || 'human'} source=${effectiveSource}`);

  const queue = commandQueues.get(workerId) || [];

  if (_sendingInput.has(workerId) || queue.length > 0) {
    if (queue.length >= MAX_QUEUE_SIZE) {
      throw new Error(`Command queue full for worker ${workerId} (max ${MAX_QUEUE_SIZE})`);
    }
    queue.push(input);
    commandQueues.set(workerId, queue);
    worker.queuedCommands = queue.length;

    if (io) {
      io.to(`worker:${workerId}`).emit('worker:updated', normalizeWorker(worker));
    }
    return true;
  }

  _sendingInput.add(workerId);
  try {
    await sendInputDirect(workerId, input);
  } finally {
    _sendingInput.delete(workerId);
  }

  // Auto-drain any queued items after send completes
  const remainingQueue = commandQueues.get(workerId) || [];
  if (remainingQueue.length > 0) {
    processQueue(workerId, io).catch(err =>
      logger.error(`[Queue] Auto-drain failed for ${workerId}: ${err.message}`)
    );
  }

  return true;
}

export async function sendInputDirect(workerId, input, source = null) {
  const worker = workers.get(workerId);
  if (!worker) return;

  // Log when called directly (not via sendInput, which has its own audit log)
  if (source) {
    const truncated = typeof input === 'string' ? input.slice(0, 200) : '(non-string)';
    logger.info(`[InputAudit] to=${workerId} (${worker.label}) from=${source} len=${typeof input === 'string' ? input.length : 0} text="${truncated.replace(/[\n\r]/g, ' ')}"`);
  }

  const sanitized = input.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, '');

  return withTmuxLock(workerId, async () => {
    try {
      await safeSendKeys(worker.tmuxSession, ['-l', sanitized]);
      await new Promise(resolve => setTimeout(resolve, 200));
      await safeSendKeys(worker.tmuxSession, ['Enter']);
      worker.lastActivity = new Date();
    } catch (error) {
      throw new Error(`Failed to send input: ${error.message}`);
    }
  });
}

export async function sendRawInput(workerId, keys) {
  const worker = workers.get(workerId);

  if (!worker) {
    throw new Error(`Worker ${workerId} not found`);
  }

  logger.info(`[InputAudit] to=${workerId} (${worker.label}) from=socket:raw len=${typeof keys === 'string' ? keys.length : 0} raw=true`);

  return withTmuxLock(workerId, async () => {
    try {
      await safeSendKeys(worker.tmuxSession, ['-l', keys]);
      worker.lastActivity = new Date();
    } catch (error) {
      throw new Error(`Failed to send raw input: ${error.message}`);
    }
  });
}

export async function interruptWorker(workerId, followUp = null, io = null) {
  const worker = workers.get(workerId);

  if (!worker) {
    throw new Error(`Worker ${workerId} not found`);
  }

  if (worker.status === 'awaiting_review') {
    if (!worker._pendingInterrupts) worker._pendingInterrupts = [];
    worker._pendingInterrupts.push({ followUp, io });
    logger.info(`[InterruptWorker] Worker ${workerId} in awaiting_review — queued interrupt (queue size: ${worker._pendingInterrupts.length})`);
    return false;
  }

  if (worker.status !== 'running') {
    throw new Error(`Worker ${workerId} is not running (status: ${worker.status})`);
  }

  try {
    await withTmuxLock(workerId, async () => {
      await safeSendKeys(worker.tmuxSession, ['C-c']);
    });
    worker.lastActivity = new Date();
    logger.info(`[InterruptWorker] Sent C-c to worker ${workerId} (${worker.label})`);

    if (followUp && typeof followUp === 'string') {
      await new Promise(resolve => setTimeout(resolve, 500));
      await sendInput(workerId, followUp, io, { source: 'interrupt_followup' });
      logger.info(`[InterruptWorker] Sent follow-up input to worker ${workerId}`);
    }

    return true;
  } catch (error) {
    throw new Error(`Failed to interrupt worker: ${error.message}`);
  }
}

export async function processQueue(workerId, io = null) {
  if (_processingQueues.has(workerId)) {
    logger.warn(`[ProcessQueue] Already processing queue for ${workerId}, skipping`);
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
        io.to(`worker:${workerId}`).emit('worker:updated', normalizeWorker(worker));
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
      logger.warn(`[ProcessQueue] Hit drain limit (${PROCESS_QUEUE_MAX_DRAIN}) for ${workerId}, ${remaining} commands still queued`);
    }
  } finally {
    _sendingInput.delete(workerId);
    _processingQueues.delete(workerId);
  }
}

// Test handle — lets test files call detectSessionLimits directly without making it
// part of the module's public API.
export const _detectSessionLimitsForTest = detectSessionLimits;

// Test handle for bulldoze copy assertions.
export const _generateBulldozeContinuationForTest = generateBulldozeContinuation;

// Test handle for held-anchor cadence backoff assertions.
export const _shouldContinueBulldozeForTest = shouldContinueBulldoze;

// Test handles for FA classifier + nudge copy assertions.
export const _classifyGeneralIdleStateForTest = classifyGeneralIdleState;
export const _generateAutonomyNudgeForTest = generateAutonomyNudge;
export const _parseEndStateSectionForTest = parseEndStateSection;
