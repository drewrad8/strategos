/**
 * Ralph signal handling: status updates, auto-promotion, parent aggregation.
 * Called when workers signal progress via the Ralph protocol.
 *
 * Query functions (getWorkers, getWorker, etc.) → queries.js
 * Delegation metrics (incrementDelegationMetric, etc.) → delegation.js
 */

import {
  workers, STRATEGOS_API, normalizeWorker,
  autoDismissTimers, AUTO_DISMISS_DELAY_MS, execAsync,
} from './state.js';

import { recordTokenUsage } from '../tokenUsageDb.js';

import { sendInputDirect, interruptWorker } from './output.js';
import { getLogger } from '../logger.js';
import { addLearning, addComplianceViolation } from '../learningsDb.js';
import { recordDriftEvent } from '../driftDb.js';
import { detectWorkerType } from './templates.js';
import { triggerAnalysis } from '../services/insightAnalyzer.js';
import { generateReflection } from '../services/reflexionService.js';
import { runReviewGate } from '../services/reviewGateService.js';
import { getHierarchyRootId, appendBlackboardEntry } from '../blackboardDb.js';
import { getWorkerHistory } from '../workerOutputDb.js';
import { invalidateWorkersCache } from './queries.js';

// Wrapped to avoid top-level failure affecting the module
export const _childProcess = { execAsync };
// Wrapped for test injection — allows replacing getWorkerHistory and interruptWorker in unit tests
export const _workerHistoryFns = { getWorkerHistory };
export const _outputFns = { interruptWorker };
export const _learningsDbFns = { addLearning };

// ============================================
// ROLE DRIFT DETECTION
// ============================================

// Named references for patterns that COLONEL workers are exempt from.
// COLONELs have "weapons-free" authority: "run scripts, install packages, and manage workers
// within THEA_ROOT/. Quick investigation yourself is fine; substantial implementation goes to workers."
// See: research/drift-doctrine-audit-2026-04-17.md Rec 3 option (a).
const _P_IMPLEMENT = /\bimplement(?:ing|ed)\b/i;
const _P_COMMIT    = /\bcommitt(?:ing|ed)\b/i;
const _P_REFACTOR  = /\brefactor(?:ing|ed)?\b/i;
const _P_RUN_TESTS = /\brunning\s+tests?\b/i;
const _P_EXEC_TEST = /\bexecut(?:ing|ed)\b.*\btest\b/i;
const _P_NPM_TEST  = /\bnpm\s+test\b/i;
const _P_INSTALL_PKG = /\binstall(?:ing|ed)?\s+packages?\b/i;
const _P_INSTALL_DEP = /\binstall(?:ing|ed)?\s+dependencies\b/i;
const _P_DEBUG_CODE  = /\bdebug(?:ging|ged)?\b.*\bcode\b/i;
const _P_FIX_BUG     = /\bfix(?:ing|ed)?\b.*\bbug\b/i;

// Keywords that indicate a command-tier worker (GENERAL/COLONEL) is doing hands-on work
const COMMANDER_VIOLATION_PATTERNS = [
  /\bedit(?:ing|ed)?\b.*\bfile\b/i,
  /\bwrit(?:ing|e|ten)\b.*\bcode\b/i,
  /\bwrit(?:ing|e|ten)\b.*\bfile\b/i,
  /\bmodif(?:ying|ied|y)\b.*\bfile\b/i,
  /\bmodif(?:ying|ied|y)\b.*\bcode\b/i,
  _P_IMPLEMENT,
  _P_RUN_TESTS,
  _P_EXEC_TEST,
  _P_NPM_TEST,
  _P_INSTALL_PKG,
  _P_INSTALL_DEP,
  _P_DEBUG_CODE,
  _P_FIX_BUG,
  _P_REFACTOR,
  _P_COMMIT,
  /\bpush(?:ing|ed)\b.*\bgit\b/i,
];

// Patterns COLONELs are exempt from — their weapons-free authority explicitly covers
// committing, implementing quick fixes, refactoring, running scripts/tests, and installing packages.
// Egregious patterns (edit/write/modify file, push git) still apply to catch truly out-of-scope work.
const COLONEL_EXEMPT_PATTERNS = new Set([
  _P_IMPLEMENT,
  _P_COMMIT,
  _P_REFACTOR,
  _P_RUN_TESTS,
  _P_EXEC_TEST,
  _P_NPM_TEST,
  _P_INSTALL_PKG,
  _P_INSTALL_DEP,
  _P_DEBUG_CODE,
  _P_FIX_BUG,
]);

// Indicators that a commander is describing child worker activity, not doing the work themselves.
// If any of these match, COMMANDER_VIOLATION_PATTERNS hits are suppressed as false positives.
// See: research/drift-doctrine-audit-2026-04-17.md (~40% of drift events were false positives)
const MONITORING_CONTEXT_PATTERNS = [
  /\bworker\s+[0-9a-f]{6,8}\b/i,          // "worker a1b2c3d4" — referencing a child by ID
  /\bchild\s+workers?\b/i,                  // "child worker(s)"
  /\bmonitoring\b/i,                         // "monitoring X workers"
  /reviewing\s+results\s+from/i,            // "reviewing results from IMPL worker"
  /\bchild\s+committed\b/i,                 // "child committed 4a3b..."
  /\b(?:IMPL|RESEARCH|COLONEL|FIX|TEST)\b/, // screaming-case worker-type labels (case-sensitive — deliberate, "fix" lowercase is not a monitoring indicator)
  /\([0-9a-f]{6,12}\)/i,                   // commit hash / worker ID in parens: (f8e2645), (deadbeef1234)
  /\bspawned\b.*\bworkers?\b/i,            // "spawned X workers" — GENERAL/COLONEL coordination language
  /\b\d+\s+workers?\b.*\b(?:complete|active|running|done|pending)\b/i, // "49 workers complete" / "3 workers still active" — aggregate fleet status
];

// First-person indicators that override monitoring-context suppression.
// If a message matches a monitoring pattern BUT also contains unambiguous first-person
// work language, the violation is real and must not be suppressed.
const FIRST_PERSON_VIOLATION_OVERRIDES = [
  /\bI\s+(?:edit|implement|commit|writ|modif|refactor|run|install|debug|fix)\w*\b/i,
  /\bmyself\b/,
  /\b(?:running|editing|committing|implementing|refactoring)\b[^.]*\bdirectly\b/i,
];

function isMonitoringContext(text) {
  if (!MONITORING_CONTEXT_PATTERNS.some(p => p.test(text))) return false;
  // Don't suppress if the message also contains an unambiguous first-person violation.
  if (FIRST_PERSON_VIOLATION_OVERRIDES.some(p => p.test(text))) return false;
  return true;
}

export { MONITORING_CONTEXT_PATTERNS, FIRST_PERSON_VIOLATION_OVERRIDES, isMonitoringContext };

// Keywords that indicate an impl/fix/test worker is doing command-tier work
const IMPLEMENTER_VIOLATION_PATTERNS = [
  /\bspawn(?:ing|ed)?\b.*\bworker\b/i,
  /\bspawn(?:ing|ed)?\b.*\bchild\b/i,
  /\bdelegat(?:ing|ed)?\b/i,
  /\bmonitor(?:ing|ed)?\b.*\bworkers?\b/i,
  /\bmanag(?:ing|ed)?\b.*\bworkers?\b/i,
  /\borchestrat(?:ing|ed)?\b/i,
  /\bcheck(?:ing|ed)?\b.*\/children\b/i,
  /\bwait(?:ing)?\b.*\bchildren\b/i,
];

/**
 * Check if a worker's currentStep suggests role drift, and record violations.
 * Non-blocking: errors are silently swallowed.
 *
 * @param {Object} worker - The worker object
 * @param {string} workerId - Worker ID
 * @param {string} currentStep - The reported currentStep text
 */
function checkRoleDrift(worker, workerId, currentStep) {
  if (!currentStep || typeof currentStep !== 'string') return;

  const step = currentStep.toLowerCase();
  const typeInfo = detectWorkerType(worker.label);
  const workerType = typeInfo.prefix ? typeInfo.prefix.toLowerCase() : null;
  if (!workerType) return;

  const isCommanderTier = workerType === 'general' || workerType === 'colonel';
  const isImplementerTier = workerType === 'impl' || workerType === 'fix' || workerType === 'test';

  if (isCommanderTier) {
    if (isMonitoringContext(currentStep)) return; // child-work references — not own work
    for (const pattern of COMMANDER_VIOLATION_PATTERNS) {
      // COLONELs are exempt from quick-fix/commit/test patterns — weapons-free authority.
      // Only egregious patterns (edit/write/modify file, push git) still fire for colonels.
      if (workerType === 'colonel' && COLONEL_EXEMPT_PATTERNS.has(pattern)) continue;
      if (pattern.test(currentStep)) {
        const severity = workerType === 'general' ? 'critical' : 'warning';
        recordDriftEvent({
          workerId,
          workerLabel: worker.label,
          workerType,
          eventType: 'boundary_violation',
          description: `${workerType.toUpperCase()} worker reported hands-on work: "${currentStep.slice(0, 100)}" (matched pattern: ${pattern.toString().slice(1, 40)})`,
          currentStep,
          severity,
        });
        getLogger().warn(`[DriftDetection] Role boundary violation: ${worker.label} (${workerId}) reported "${currentStep.slice(0, 80)}"`, { workerId, workerType, pattern: pattern.toString() });
        return; // One event per signal is sufficient
      }
    }
  } else if (isImplementerTier) {
    for (const pattern of IMPLEMENTER_VIOLATION_PATTERNS) {
      if (pattern.test(currentStep)) {
        recordDriftEvent({
          workerId,
          workerLabel: worker.label,
          workerType,
          eventType: 'boundary_violation',
          description: `${workerType.toUpperCase()} worker reported command-tier activity: "${currentStep.slice(0, 100)}" (matched pattern: ${pattern.toString().slice(1, 40)})`,
          currentStep,
          severity: 'warning',
        });
        getLogger().warn(`[DriftDetection] Role boundary violation: ${worker.label} (${workerId}) reported "${currentStep.slice(0, 80)}"`, { workerId, workerType, pattern: pattern.toString() });
        return;
      }
    }
  }
}

// ============================================
// COMPLIANCE CHECK
// ============================================

/**
 * Run a fast compliance check for a completed worker.
 * Uses git log to detect role violations (generals making direct commits,
 * researchers editing non-report files). Results stored in compliance_violations table.
 * Non-blocking: always returns without throwing.
 */
async function runComplianceCheck(worker, workerId, templateType, io) {
  if (!templateType || !workerId) return;
  const projectPath = worker.projectPath || worker.workingDir;
  if (!projectPath) return;

  try {
    const { execAsync } = _childProcess;
    const createdAt = worker.createdAt ? new Date(worker.createdAt).toISOString() : null;
    const sinceFlag = createdAt ? `--after="${createdAt}"` : '';

    // generals and colonels must NOT make direct commits (role violation)
    if (templateType === 'general' || templateType === 'colonel') {
      try {
        const { stdout: commitRaw } = await execAsync(
          `git -C "${projectPath}" log --oneline ${sinceFlag} 2>/dev/null`,
          { timeout: 5000 }
        );
        const commitLines = commitRaw.trim();
        const commits = commitLines ? commitLines.split('\n').filter(Boolean).length : 0;
        if (commits > 0) {
          addComplianceViolation({
            workerId,
            workerLabel: worker.label,
            templateType,
            violationType: 'direct_commit',
            description: `${templateType.toUpperCase()} worker made ${commits} direct git commit(s) — role violation. Commanders must delegate implementation.`,
            severity: templateType === 'general' ? 'critical' : 'warning',
          });
          getLogger().warn(`[ComplianceCheck] Role violation: ${worker.label} (${workerId}) made ${commits} direct commit(s)`, { workerId, templateType, commits });
        }
      } catch (err) { getLogger().error('[ralph.compliance] direct-commit-check threw:', { workerId, err: err?.message ?? err }); }
    }

    // research workers should only write to report/research/findings files
    if (templateType === 'research') {
      try {
        const { stdout: changedFilesRaw } = await execAsync(
          `git -C "${projectPath}" log --name-only --pretty=format: ${sinceFlag} 2>/dev/null`,
          { timeout: 5000 }
        );
        const changedFiles = changedFilesRaw.trim();
        if (changedFiles) {
          const files = changedFiles.split('\n').filter(Boolean);
          const nonReportFiles = files.filter(f => {
            const lower = f.toLowerCase();
            return !lower.includes('research/') && !lower.includes('reports/') &&
                   !lower.includes('report.') && !lower.includes('findings') &&
                   !lower.endsWith('.md') && !lower.endsWith('.txt');
          });
          if (nonReportFiles.length > 0) {
            addComplianceViolation({
              workerId,
              workerLabel: worker.label,
              templateType,
              violationType: 'non_report_file_edit',
              description: `RESEARCH worker modified non-report files (role violation): ${nonReportFiles.slice(0, 5).join(', ')}`,
              severity: 'warning',
            });
            getLogger().warn(`[ComplianceCheck] Research worker edited non-report files: ${nonReportFiles.slice(0, 3).join(', ')}`, { workerId });
            interruptWorker(
              workerId,
              'ROLE VIOLATION: You are a RESEARCH worker. You are not authorized to edit files outside of /tmp/ or report/findings .md files. Stop editing files. Write your findings to a report file in your project tmp/ or shared/reports/ directory instead.',
              io
            ).catch(() => { /* non-fatal */ });
          }
        }
      } catch (err) { getLogger().error('[ralph.compliance] research-file-check threw:', { workerId, err: err?.message ?? err }); }
    }
  } catch (err) {
    // Top-level catch: compliance check never throws
  }
}
export { runComplianceCheck as _runComplianceCheck };

// Shared completion keyword regex — used for keyword-based auto-promotion.
// Centralized here so ralph.js, health.js, and persistence.js all use the same pattern.
const COMPLETION_RE = /\b(complete[d]?|done|finished|awaiting\s+(?:orders|further)|ready\s+for\s+next|all\b.*\bpassing)\b/i;

/**
 * Check if a worker is a persistent-tier worker (GENERAL/COLONEL) that should
 * NOT be auto-promoted based on completion keywords (they use these words routinely).
 */
function isPersistentTier(worker) {
  const upperLabel = (worker.label || '').toUpperCase();
  return upperLabel.startsWith('GENERAL:') || upperLabel.startsWith('GENERAL ') ||
    upperLabel.startsWith('COLONEL:') || upperLabel.startsWith('COL-') || upperLabel.startsWith('COL:');
}

/**
 * Guard predicate: returns true if result delivery to the parent should proceed.
 * Parent must exist in the workers map and must not have health=dead.
 * Extracted for unit testing — deliverResultsToParent calls this before setting
 * _resultsDelivered so that a skip never blocks a future retry.
 *
 * @param {Object} worker - child worker that signaled done
 * @param {Map} workersMap - live workers map
 * @returns {boolean}
 */
export function _deliverResultsGuard(worker, workersMap) {
  if (!worker.parentWorkerId) return false;
  const parentWorker = workersMap.get(worker.parentWorkerId);
  if (!parentWorker || parentWorker.health === 'dead') return false;
  return true;
}

/**
 * Build and deliver a structured result summary to a parent worker.
 * Centralizes the result formatting that was previously duplicated in
 * tryAutoPromoteWorker, updateWorkerRalphStatus, and _updateParentAggregation.
 *
 * @param {Object} worker - The completed worker object
 * @param {string} workerId - Worker ID
 * @param {string} statusNote - Status line (e.g. "Complete", "Complete (auto-promoted)")
 */
function deliverResultsToParent(worker, workerId, statusNote) {
  if (!worker.parentWorkerId) return;

  // Don't deliver results from dismissed/stopped workers (race: done signal after dismissal)
  if (worker.status === 'stopped' || worker.status === 'completed') {
    getLogger().warn(`Skipping result delivery from ${workerId} — worker status is "${worker.status}" (already dismissed/stopped)`, { workerId, parentWorkerId: worker.parentWorkerId });
    return;
  }

  // Don't deliver duplicate results (worker already in awaiting_review means results were already sent)
  if (worker.status === 'awaiting_review' && worker._resultsDelivered) {
    getLogger().warn(`Skipping duplicate result delivery from ${workerId} — results already delivered`, { workerId, parentWorkerId: worker.parentWorkerId });
    return;
  }

  // Guard: parent must be present and alive. Without this guard, sendInputDirect
  // silently no-ops but _resultsDelivered=true blocks any retry — silent data loss.
  const parentWorker = workers.get(worker.parentWorkerId);
  if (!parentWorker || parentWorker.health === 'dead') {
    getLogger().warn(
      `Skipping result delivery to parent ${worker.parentWorkerId} — parent is ${!parentWorker ? 'absent from workers map' : 'health=dead'} — _resultsDelivered NOT set (retry remains possible)`,
      { workerId, parentWorkerId: worker.parentWorkerId }
    );
    return;
  }

  // Don't deliver cross-project results UNLESS this is an explicit parent-child relationship.
  // e.g. a thea GENERAL that spawns a strategos child should still get results.
  if (worker.project && parentWorker.project && worker.project !== parentWorker.project) {
    if (worker.parentWorkerId !== parentWorker.id) {
      getLogger().warn(`Skipping cross-project result delivery: child ${workerId} (project: ${worker.project}) -> parent ${worker.parentWorkerId} (project: ${parentWorker.project})`, { workerId, parentWorkerId: worker.parentWorkerId });
      return;
    }
    getLogger().info(`Allowing cross-project delivery for explicit parent-child: ${workerId} (${worker.project}) -> ${parentWorker.id} (${parentWorker.project})`, { workerId, parentWorkerId: worker.parentWorkerId });
  }

  const terminalStatuses = new Set(['completed', 'stopped', 'error']);
  if (terminalStatuses.has(parentWorker.status)) {
    getLogger().warn(`Skipping result delivery to parent ${worker.parentWorkerId} — parent status is "${parentWorker.status}" (ralph: "${parentWorker.ralphStatus || 'n/a'}")`, { workerId, parentWorkerId: worker.parentWorkerId });
    return;
  }

  const dm = worker.delegationMetrics;
  const delegationLine = dm
    ? `Delegation: spawned ${dm.spawnsIssued} workers, ${dm.roleViolations} role violations, ${dm.filesEdited} files edited, ${dm.commandsRun} commands run`
    : null;

  const resultSummary = [
    `[RESULTS FROM ${worker.label} (${workerId})]`,
    worker.ralphLearnings ? `Learnings: ${worker.ralphLearnings}` : null,
    worker.ralphOutputs ? `Outputs: ${typeof worker.ralphOutputs === 'string' ? worker.ralphOutputs : JSON.stringify(worker.ralphOutputs)}` : null,
    worker.ralphArtifacts ? `Artifacts: ${Array.isArray(worker.ralphArtifacts) ? worker.ralphArtifacts.join(', ') : worker.ralphArtifacts}` : null,
    delegationLine,
    `Status: ${statusNote}. Worker is alive for follow-up questions.`,
    `To dismiss: curl -s -X POST ${STRATEGOS_API}/api/workers/${workerId}/dismiss`,
  ].filter(Boolean).join('\n');

  // Mark results as delivered to prevent duplicate deliveries
  worker._resultsDelivered = true;

  // Backup capture: persist learnings if not already persisted
  if (!worker._learningsPersisted) {
    _persistLearning(worker, workerId);
  }

  sendInputDirect(worker.parentWorkerId, resultSummary, 'ralph:result_delivery').catch(e => {
    getLogger().warn(`Could not deliver results to parent ${worker.parentWorkerId}`, { workerId, parentWorkerId: worker.parentWorkerId, error: e.message });
  });
}

/**
 * Persist a worker's learnings to the learnings database.
 * Called when a worker signals done or is auto-promoted.
 */
function _persistLearning(worker, workerId) {
  // Idempotency guard: prevents double-entry if called from both the done-signal
  // handler and deliverResultsToParent's backup capture in the same lifecycle.
  if (worker._learningsPersisted) return;

  try {
    const typeInfo = detectWorkerType(worker.label);
    const taskDesc = worker.taskDescription || worker.task?.description || worker.task || null;
    const uptime = worker.createdAt
      ? Math.max(0, Date.now() - new Date(worker.createdAt).getTime())
      : null;

    addLearning({
      workerId,
      label: worker.label,
      templateType: typeInfo.prefix ? typeInfo.prefix.toLowerCase() : null,
      templateHash: null,
      learnings: worker.ralphLearnings || null,
      outputs: worker.ralphOutputs || null,
      artifacts: worker.ralphArtifacts || null,
      taskDescription: typeof taskDesc === 'string' ? taskDesc : (taskDesc ? JSON.stringify(taskDesc) : null),
      parentWorkerId: worker.parentWorkerId || null,
      effortLevel: worker.effortLevel || null,
      success: 1,
      uptime,
      taskQualityScore: worker.taskQualityScore != null ? worker.taskQualityScore : null,
    });
    worker._learningsPersisted = true;

    // Trigger event-driven insight analysis when new learnings arrive
    triggerAnalysis();
  } catch (err) {
    getLogger().warn(`Failed to persist learning for ${workerId}: ${err.message}`, { workerId });
  }
}

/**
 * Pure helper: derive synthetic learnings for a dismissed in_progress worker (Cat D).
 * Returns the synthetic string, or null if conditions are not met.
 * Exported for unit testing.
 */
export function _deriveCatDLearnings(worker, reason) {
  if (!worker || reason !== 'dismissed' || worker.ralphStatus !== 'in_progress') return null;
  return `[Dismissed in_progress] ${worker.ralphCurrentStep || 'no step recorded'}`;
}

/**
 * Record a failure learning when a worker dies without signaling done.
 * Guards against double-recording: skips if worker already persisted a success learning.
 * @param {Object} worker - The worker object
 * @param {string} workerId - Worker ID
 * @param {string} reason - Death reason (e.g. 'killed', 'crashed', 'session_died')
 */
export function persistFailureLearning(worker, workerId, reason) {
  if (!worker) return;
  // Don't overwrite a success: worker already signaled done or is awaiting review after done
  if (worker._learningsPersisted || worker.ralphStatus === 'done' || worker.ralphStatus === 'awaiting_review') return;
  // Don't count dismissed/completed workers as failures — they finished their task
  if (worker.status === 'dismissed' || worker.status === 'completed') return;

  try {
    const typeInfo = detectWorkerType(worker.label);
    const taskDesc = worker.taskDescription || worker.task?.description || worker.task || null;
    const uptime = worker.createdAt
      ? Math.max(0, Date.now() - new Date(worker.createdAt).getTime())
      : null;

    // Ephemeral test fixtures (no task description, or killed in <120s before Claude
    // could even start typing) are recorded as neutral (null) rather than failure (0)
    // so they don't inflate failure counts in success-rate metrics.
    const isEphemeral = !taskDesc || (uptime !== null && uptime < 120000);

    // Fallback: if worker died without signaling learnings, capture last 50 output lines
    // so forensics have something to work with. Skip for dismissed workers (they completed normally).
    // ANSI escape codes are stripped so startup banner noise doesn't crowd out real content.
    const ANSI_RE = /\x1b\[[0-9;]*[mGKHF]/g;
    let learnings = worker.ralphLearnings || null;
    if (!learnings && reason !== 'dismissed') {
      try {
        const history = _workerHistoryFns.getWorkerHistory(workerId, { limit: 50 });
        if (history.outputs && history.outputs.length > 0) {
          const lastLines = history.outputs.map(r => (r.output_chunk || '').replace(ANSI_RE, '')).join('').trim();
          if (lastLines) {
            learnings = `[auto-captured on ${reason}]\n${lastLines}`;
          }
        }
      } catch (err) { getLogger().error('[ralph.learnings] getWorkerHistory threw:', { workerId, err: err?.message ?? err }); }
    }
    // Cat D: dismissed in_progress workers — synthetic entry so dismissal is never silent.
    // Fires before Cat B so the [Dismissed in_progress] prefix is used instead of the generic fallback.
    if (!learnings) {
      const catD = _deriveCatDLearnings(worker, reason);
      if (catD) learnings = catD;
    }
    // Cat B fallback: use ralphCurrentStep when both ralphLearnings and DB history are empty.
    // in_progress workers report currentStep on every signal but only set learnings on done —
    // so this captures at least the last known step for forensics.
    if (!learnings && worker.ralphCurrentStep) {
      learnings = `[auto-captured on ${reason}: last known step] ${worker.ralphCurrentStep}`;
    }

    _learningsDbFns.addLearning({
      workerId,
      label: worker.label,
      templateType: typeInfo.prefix ? typeInfo.prefix.toLowerCase() : null,
      templateHash: null,
      learnings,
      outputs: worker.ralphOutputs || null,
      artifacts: worker.ralphArtifacts || null,
      taskDescription: typeof taskDesc === 'string' ? taskDesc : (taskDesc ? JSON.stringify(taskDesc) : null),
      parentWorkerId: worker.parentWorkerId || null,
      effortLevel: worker.effortLevel || null,
      success: isEphemeral ? null : 0,
      uptime,
      taskQualityScore: worker.taskQualityScore != null ? worker.taskQualityScore : null,
      terminalReason: reason || null,
    });
    worker._learningsPersisted = true;

    getLogger().info(`[LearningsDB] Recorded failure for ${workerId} (${worker.label}), reason: ${reason}`);

    // Fire-and-forget reflexion generation — async, non-blocking
    const templateType = typeInfo.prefix ? typeInfo.prefix.toLowerCase() : null;
    if (templateType) {
      const taskDescStr = typeof taskDesc === 'string' ? taskDesc : (taskDesc ? JSON.stringify(taskDesc) : null);
      setImmediate(() => generateReflection(workerId, templateType, taskDescStr).catch(() => {}));
    }
  } catch (err) {
    getLogger().warn(`Failed to persist failure learning for ${workerId}: ${err.message}`, { workerId });
  }
}

/**
 * Emit the standard awaiting_review socket events for a completed worker.
 *
 * @param {Object} worker - The worker object
 * @param {string} workerId - Worker ID
 * @param {Object} io - Socket.io instance (nullable)
 */
function emitDoneEvents(worker, workerId, io) {
  if (!io) return;
  io.to(`worker:${workerId}`).emit('worker:updated', normalizeWorker(worker));
  io.emit('worker:awaiting_review', {
    workerId,
    label: worker.label,
    learnings: worker.ralphLearnings,
    outputs: worker.ralphOutputs,
    artifacts: worker.ralphArtifacts,
    parentWorkerId: worker.parentWorkerId,
    delegationMetrics: worker.delegationMetrics || null,
  });
}

/**
 * Transition a worker to awaiting_review (done state).
 * Sets status fields, emits events, delivers results to parent.
 *
 * @param {Object} worker - The worker object
 * @param {string} workerId - Worker ID
 * @param {Object} io - Socket.io instance (nullable)
 * @param {string} statusNote - Status note for parent delivery
 */
function transitionToDone(worker, workerId, io, statusNote) {
  // Guard: don't transition dismissed/stopped workers (race with dismissal)
  if (worker.status === 'stopped' || worker.status === 'completed') {
    getLogger().warn(`Skipping transitionToDone for ${workerId} — already ${worker.status}`, { workerId, status: worker.status });
    return;
  }

  // Guard: already in awaiting_review = duplicate done signal, skip
  if (worker.status === 'awaiting_review') {
    getLogger().info(`Skipping transitionToDone for ${workerId} — already awaiting_review (duplicate done signal)`, { workerId });
    return;
  }

  worker.ralphProgress = 100;
  worker.ralphStatus = 'done';
  worker.ralphSignaledAt = new Date();
  worker.status = 'awaiting_review';
  worker.awaitingReviewAt = new Date();
  invalidateWorkersCache();

  // Clear blackboard for GENERAL hierarchy roots when they signal done
  const upperLabel = (worker.label || '').toUpperCase();
  if ((upperLabel.startsWith('GENERAL:') || upperLabel.startsWith('GENERAL ')) && worker.projectPath) {
    import('../blackboardDb.js').then(({ getHierarchyRootId, clearBlackboard }) => {
      const rootId = getHierarchyRootId(workerId, workers);
      if (rootId === workerId) {
        clearBlackboard(worker.projectPath, rootId).catch(err => {
          getLogger().warn(`Failed to clear blackboard for ${workerId}: ${err.message}`, { workerId });
        });
      }
    }).catch(() => {});
  }

  emitDoneEvents(worker, workerId, io);
  deliverResultsToParent(worker, workerId, statusNote);
  startAutoDismissTimer(workerId, io);
}

/**
 * Start an auto-dismiss countdown for a worker that has signaled done.
 * After AUTO_DISMISS_DELAY_MS (30 minutes), if no new input was received,
 * the worker is automatically dismissed.
 *
 * @param {string} workerId - Worker ID
 * @param {Object} io - Socket.io instance (nullable)
 */
export function startAutoDismissTimer(workerId, io) {
  const worker = workers.get(workerId);
  if (!worker) return;

  // Don't auto-dismiss if the option is disabled
  if (worker.autoDismissAfterDone === false) {
    getLogger().info(`Auto-dismiss disabled for ${workerId} (${worker.label})`, { workerId });
    return;
  }

  // Don't auto-dismiss protected workers (GENERALs)
  if (isPersistentTier(worker)) {
    getLogger().info(`Skipping auto-dismiss for persistent-tier worker ${workerId} (${worker.label})`, { workerId });
    return;
  }

  // Cancel any existing timer
  cancelAutoDismissTimer(workerId);

  const timer = setTimeout(async () => {
    autoDismissTimers.delete(workerId);
    const w = workers.get(workerId);
    if (!w) return;

    // Only dismiss if still in awaiting_review (no new input reverted it to running)
    if (w.status !== 'awaiting_review') {
      getLogger().info(`Auto-dismiss cancelled for ${workerId} — status changed to ${w.status}`, { workerId });
      return;
    }

    getLogger().info(`Auto-dismissing worker ${workerId} (${w.label}) after done timeout`, { workerId, label: w.label });

    try {
      const { killWorker } = await import('./lifecycle.js');
      await killWorker(workerId, io);
      if (io) {
        io.emit('worker:auto-dismissed', {
          workerId,
          label: w.label,
          reason: 'Auto-dismissed after done signal (5 minute timeout)',
        });
      }
    } catch (err) {
      getLogger().warn(`Auto-dismiss failed for ${workerId}: ${err.message}`, { workerId, error: err.message });
    }
  }, AUTO_DISMISS_DELAY_MS);

  if (timer.unref) timer.unref();
  autoDismissTimers.set(workerId, timer);
  getLogger().info(`Started auto-dismiss timer for ${workerId} (${worker.label}) — ${AUTO_DISMISS_DELAY_MS / 60000}m countdown`, { workerId });
}

/**
 * Cancel an auto-dismiss timer (e.g., when the worker receives new input).
 * @param {string} workerId - Worker ID
 */
export function cancelAutoDismissTimer(workerId) {
  const timer = autoDismissTimers.get(workerId);
  if (timer) {
    clearTimeout(timer);
    autoDismissTimers.delete(workerId);
    getLogger().info(`Cancelled auto-dismiss timer for ${workerId}`, { workerId });
  }
}

/**
 * Revert a worker from awaiting_review back to running.
 * Used when a "done" worker resumes activity (bulldoze, forced autonomy, child spawn, manual input).
 * Resets status fields, cancels auto-dismiss timer, and emits socket event.
 *
 * @param {string} workerId - Worker ID
 * @param {Object} io - Socket.io instance (nullable)
 * @param {string} reason - Why the worker is reverting (for logging)
 * @returns {boolean} True if the worker was reverted
 */
export function revertFromDone(workerId, io, reason) {
  const worker = workers.get(workerId);
  if (!worker || worker.status !== 'awaiting_review') return false;

  worker.status = 'running';
  worker.ralphStatus = 'in_progress';
  worker.awaitingReviewAt = null;
  worker._resultsDelivered = false;
  invalidateWorkersCache();

  // Reset CompletionGuard state so the guard treats this as a freshly active worker.
  // Without this, a worker idle in awaiting_review for 2+ hours would have a stale
  // lastRalphSignalAt, causing CompletionGuard to immediately kill it on the next
  // health tick after revert (the race condition in issue: revertFromDone vs CompletionGuard).
  worker.lastRalphSignalAt = new Date().toISOString();
  worker._completionKilled = false;
  worker._completionNudged = false;

  cancelAutoDismissTimer(workerId);

  getLogger().info(`Worker ${workerId} (${worker.label}) reverted from awaiting_review → running (${reason})`, { workerId, label: worker.label, reason });

  if (io) {
    io.to(`worker:${workerId}`).emit('worker:updated', normalizeWorker(worker));
  }

  // Flush any interrupts that were queued while the worker was in awaiting_review
  const pending = worker._pendingInterrupts;
  if (pending && pending.length > 0) {
    worker._pendingInterrupts = [];
    getLogger().info(`[revertFromDone] Flushing ${pending.length} queued interrupt(s) for worker ${workerId}`);
    for (const { followUp, io: interruptIo } of pending) {
      _outputFns.interruptWorker(workerId, followUp, interruptIo || io).catch((err) => { getLogger().error('[ralph.revert] interruptWorker threw during pending flush:', { workerId, err: err?.message ?? err }); });
    }
  }

  return true;
}

/**
 * Revert a held worker back to in_progress when Commander sends input.
 * Mirrors revertFromDone but targets ralphStatus === 'held' (worker.status remains 'running').
 */
export function revertFromHeld(workerId, io, reason) {
  const worker = workers.get(workerId);
  if (!worker || worker.ralphStatus !== 'held') return false;

  worker.ralphStatus = 'in_progress';
  worker.ralphHeldReason = null;
  invalidateWorkersCache();
  worker.lastRalphSignalAt = new Date().toISOString();

  getLogger().info(`Worker ${workerId} (${worker.label}) reverted from held → in_progress (${reason})`, { workerId, label: worker.label, reason });

  if (io) {
    io.to(`worker:${workerId}`).emit('worker:updated', normalizeWorker(worker));
  }

  return true;
}


/**
 * Shared auto-promotion: checks if a worker should be promoted to "done" based on
 * completion keywords in their currentStep, and if so, performs the full done-path
 * transition: status change, parent delivery, parent aggregation, socket events.
 *
 * Called from: ralph.js (on signal), health.js (periodic sweep), persistence.js (on restore).
 *
 * @param {Object} worker - The worker object (from workers Map)
 * @param {Object} io - Socket.io instance (nullable)
 * @param {string} source - Caller identifier for logging (e.g. 'signal', 'health', 'restore')
 * @returns {boolean} True if the worker was auto-promoted
 */
export function tryAutoPromoteWorker(worker, io, source = 'unknown') {
  if (!worker) return false;
  if (worker.ralphStatus !== 'in_progress') return false;
  if (worker.ralphProgress == null || worker.ralphProgress < 90) return false;
  if (!worker.ralphCurrentStep) return false;
  if (isPersistentTier(worker)) return false;
  if (!COMPLETION_RE.test(worker.ralphCurrentStep)) return false;

  const workerId = worker.id;
  getLogger().info(`Auto-promoted worker ${workerId} (${worker.label}) to done [${source}]`, { workerId, label: worker.label, source, currentStep: worker.ralphCurrentStep?.slice(0, 100) });

  transitionToDone(worker, workerId, io, 'Complete (auto-promoted)');

  // Update parent progress aggregation
  if (worker.parentWorkerId) {
    _updateParentAggregation(worker.parentWorkerId, io);
  }

  return true;
}

/**
 * Update a worker's Ralph status (called when worker signals).
 * @param {string} workerId - Worker ID
 * @param {Object} signalData - Signal data (status, progress, currentStep, learnings, outputs, artifacts, reason)
 * @param {Object} io - Socket.io instance for events
 * @returns {boolean} True if update succeeded
 */
export function updateWorkerRalphStatus(workerId, signalData, io = null) {
  const worker = workers.get(workerId);
  if (!worker) {
    getLogger().warn(`Worker ${workerId} not found for Ralph signal`, { workerId });
    return false;
  }

  // Handle both old format (status, learnings) and new format (signalData object)
  const data = typeof signalData === 'string'
    ? { status: signalData }
    : signalData;

  const { status, progress, currentStep, learnings, outputs, artifacts, reason } = data;

  // Minimal guard — route layer validates fully via validateSignalBody
  if (!status) {
    getLogger().warn(`Worker ${workerId} sent empty Ralph status`, { workerId });
    return false;
  }

  // Guard: persistent workers (autoRespawn=true) cannot signal done.
  // The server mechanically enforces what prompts cannot — autoRespawn generals must keep working.
  if (status === 'done' && worker.autoRespawn === true) {
    if (worker._successorId) {
      // Handoff rotation: allow done when successor has been spawned
      getLogger().info(`[Ralph] Handoff rotation: allowing done for ${workerId} (successor: ${worker._successorId})`, { workerId, label: worker.label });
      worker.autoRespawn = false;
      worker._handoffRotating = true;
      // fall through to normal done processing
    } else {
      getLogger().warn(`[Ralph] Persistent worker ${workerId} (${worker.label}) attempted to signal done — rejected`, { workerId, label: worker.label });
      return { rejected: true, message: 'You are a persistent worker. You cannot signal done. Signal in_progress instead and continue working.' };
    }
  }

  worker.ralphStatus = status;
  worker.lastActivity = new Date();

  // If worker is in awaiting_review and signals in_progress, revert to running.
  // This allows bulldoze to resume on workers that were previously done but got a new mission.
  if (status === 'in_progress' && worker.status === 'awaiting_review') {
    revertFromDone(workerId, io, 'in_progress_signal');
  }

  // Track that this worker has manually signaled (used to prevent child aggregation
  // from overwriting manually-reported progress — see _updateParentAggregation)
  worker._ralphManuallySignaled = true;

  // Efficiency tracking — count signals, track first signal time
  worker.ralphSignalCount = (worker.ralphSignalCount || 0) + 1;
  worker.lastRalphSignalAt = new Date();
  if (!worker.firstRalphAt) {
    worker.firstRalphAt = new Date();
  }

  // Only set signaled timestamp on terminal states
  if (status === 'done' || status === 'blocked' || status === 'held') {
    worker.ralphSignaledAt = new Date();
  }

  // Auto-suppress forced autonomy nudges on done/blocked/held signals
  if ((status === 'done' || status === 'blocked' || status === 'held') && worker.forcedAutonomy) {
    if (!isPersistentTier(worker)) {
      // Non-persistent workers: suppress on any terminal signal
      getLogger().info('[ForcedAutonomy] Auto-suppressing nudges — worker signaled terminal status', { label: worker.label, status, workerId });
      worker._forcedAutonomySuppressed = true;
    } else if (status === 'held' && worker.ralphLearnings) {
      // Persistent tier (GENERAL/COLONEL): suppress only when held after completing mission (learnings non-empty)
      getLogger().info('[ForcedAutonomy] GENERAL suppressed post-mission — held after completing mission', { label: worker.label, workerId });
      worker._forcedAutonomySuppressed = true;
      worker._missionComplete = true;
    }
  }
  // Re-enable if worker goes back to in_progress
  if (status === 'in_progress' && worker._forcedAutonomySuppressed) {
    getLogger().info('[ForcedAutonomy] Re-enabling nudges — worker resumed work', { label: worker.label, workerId });
    worker._forcedAutonomySuppressed = false;
    worker._forcedAutonomyNudgeCount = 0;  // Reset backoff
  }

  // Track blocked reason (P3 fix: was never stored before)
  if (status === 'blocked') {
    worker.ralphBlockedReason = (typeof reason === 'string' ? reason.slice(0, 2000) : null);
  } else {
    // Clear blocked reason when status changes away from blocked
    worker.ralphBlockedReason = null;
  }

  // Track held reason — why the worker is awaiting Commander direction
  if (status === 'held') {
    worker.ralphHeldReason = (typeof reason === 'string' ? reason.slice(0, 2000) : null);
  } else {
    worker.ralphHeldReason = null;
  }

  // Update optional fields if provided (with size caps to prevent memory bloat)
  if (progress !== undefined) worker.ralphProgress = progress;
  if (currentStep !== undefined) {
    const newStep = typeof currentStep === 'string' ? currentStep.slice(0, 500) : String(currentStep).slice(0, 500);
    worker.ralphCurrentStep = newStep;
    // Maintain rolling history of last 5 steps for post-compaction re-orientation
    if (!worker._ralphStepHistory) worker._ralphStepHistory = [];
    worker._ralphStepHistory.push({ step: newStep, at: new Date().toISOString() });
    if (worker._ralphStepHistory.length > 5) worker._ralphStepHistory.shift();
    // Role drift detection — non-blocking, errors silently swallowed inside checkRoleDrift
    try { checkRoleDrift(worker, workerId, worker.ralphCurrentStep); } catch (err) { getLogger().error('[ralph.compliance] checkRoleDrift threw:', { workerId, err: err?.message ?? err }); }
  }
  if (learnings !== undefined) {
    worker.ralphLearnings = typeof learnings === 'string' ? learnings.slice(0, 10000) : String(learnings).slice(0, 10000);
  }
  if (outputs !== undefined) {
    const outputStr = typeof outputs === 'string' ? outputs : JSON.stringify(outputs);
    if (outputStr.length > 100000) {
      getLogger().warn(`Outputs field for ${workerId} truncated`, { workerId, length: outputStr.length });
    }
    if (typeof outputs === 'string') {
      worker.ralphOutputs = outputs.slice(0, 100000);
    } else if (outputs && typeof outputs === 'object') {
      // Sanitize: strip prototype-polluting keys before storing
      const DANGEROUS_KEYS = ['__proto__', 'constructor', 'prototype'];
      const sanitized = Array.isArray(outputs) ? outputs : Object.fromEntries(
        Object.entries(outputs).filter(([k]) => !DANGEROUS_KEYS.includes(k))
      );
      // P3 fix: enforce 100KB size cap on object outputs (was only capped for strings)
      const sanitizedStr = JSON.stringify(sanitized);
      if (sanitizedStr.length > 100000) {
        getLogger().warn(`Object outputs for ${workerId} exceed 100KB — rejecting`, { workerId, length: sanitizedStr.length });
        worker.ralphOutputs = { _truncated: true, _reason: `Object outputs exceeded 100KB limit (${sanitizedStr.length} chars)` };
      } else {
        worker.ralphOutputs = sanitized;
      }
    } else {
      worker.ralphOutputs = outputs;
    }
  }
  if (artifacts !== undefined) {
    if (!Array.isArray(artifacts)) {
      getLogger().warn(`Worker ${workerId} sent non-array artifacts — ignoring`, { workerId });
    } else if (artifacts.length > 100) {
      getLogger().warn(`Artifacts array for ${workerId} truncated`, { workerId, length: artifacts.length });
      worker.ralphArtifacts = artifacts.slice(0, 100);
    } else {
      worker.ralphArtifacts = artifacts;
    }
  }
  invalidateWorkersCache();

  getLogger().info(`Worker ${workerId} signaled: ${status}${progress !== undefined ? ` (${progress}%)` : ''}`, { workerId, status, progress });

  // === Auto-promotion: detect workers effectively done but not signaling it ===
  let autoPromoted = false;

  // 1. Keyword-based auto-promotion (uses shared tryAutoPromoteWorker)
  if (status === 'in_progress') {
    autoPromoted = tryAutoPromoteWorker(worker, io, 'signal');
  }

  // 2. Parent self-check: worker with all children done + progress >= 80
  // Skip persistent tiers (GENERAL/COLONEL) — they manage their own lifecycle
  if (!autoPromoted && status === 'in_progress' && worker.ralphProgress >= 80 && !isPersistentTier(worker)) {
    const childIds = worker.childWorkerIds || [];
    if (childIds.length > 0) {
      const children = childIds.map(cid => workers.get(cid)).filter(Boolean);
      const allChildrenDone = children.length > 0 && children.every(c =>
        c.ralphStatus === 'done' || c.status === 'awaiting_review' || c.status === 'completed'
      );
      if (allChildrenDone) {
        autoPromoted = true;
        getLogger().info(`Auto-promoted worker ${workerId} (${worker.label}) to done (all ${children.length} children complete)`, { workerId, label: worker.label, childCount: children.length });
        transitionToDone(worker, workerId, io, `Complete (all ${children.length} children done)`);
      }
    }
  }

  // Emit update event (skip if done handler will emit below via emitDoneEvents)
  // Note: auto-promotion is fully handled by transitionToDone() above — no need to check it here.
  const willEnterDoneHandler = status === 'done' && worker.status !== 'awaiting_review';
  if (!autoPromoted && !willEnterDoneHandler && io) {
    io.to(`worker:${workerId}`).emit('worker:updated', normalizeWorker(worker));
  }

  // On "done": transition to awaiting_review.
  // Auto-promotion is already handled by transitionToDone() — only fire for explicit done signals.
  if (status === 'done' && worker.status !== 'awaiting_review') {
    worker.status = 'awaiting_review';
    worker.awaitingReviewAt = new Date();
    invalidateWorkersCache();
    getLogger().info(`Worker ${workerId} (${worker.label}) → awaiting_review`, { workerId, label: worker.label });

    emitDoneEvents(worker, workerId, io);

    // Persist learnings immediately (before review gate, so it's not lost if gate is slow)
    _persistLearning(worker, workerId);

    // Record token usage if provided in done signal
    const { inputTokens, outputTokens, totalCost, modelId } = data;
    if (inputTokens !== undefined || outputTokens !== undefined || totalCost !== undefined) {
      const typeInfo = detectWorkerType(worker.label);
      const templateType = typeInfo.prefix ? typeInfo.prefix.toLowerCase() : null;
      const backend = worker.backend || 'claude';

      recordTokenUsage({
        workerId,
        workerLabel: worker.label,
        templateType,
        modelId: modelId || worker.model || 'unknown',
        backend,
        requestTimestamp: new Date().toISOString(),
        inputTokens,
        outputTokens,
        inputCost: totalCost || 0,  // Split totalCost into inputCost
        outputCost: totalCost || 0,  // Note: in real scenarios these would be separate
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        responseType: 'normal',
      });
    }

    // Start auto-dismiss countdown
    startAutoDismissTimer(workerId, io);

    // Run review gate async — annotates delivery but never blocks it.
    const typeInfo = detectWorkerType(worker.label);
    const templateType = typeInfo.prefix ? typeInfo.prefix.toLowerCase() : null;

    // Run compliance check (async, non-blocking) — records role violations before gate
    runComplianceCheck(worker, workerId, templateType, io).catch(err => {
      getLogger().error('[ralph.compliance] runComplianceCheck threw:', { workerId, err: err?.message ?? err });
    });

    // Fire-and-forget memory capture for command-tier workers (general/colonel)
    if (templateType === 'general' || templateType === 'colonel') {
      setImmediate(() => {
        import('../services/memoryService.js').then(({ captureFromDoneSignal }) => {
          captureFromDoneSignal(worker, workerId).catch(err => {
            getLogger().error(`[Memory] captureFromDoneSignal failed for ${workerId}: ${err.message}`, { workerId, err: err?.message ?? err });
          });
        }).catch(err => {
          getLogger().error(`[Memory] Failed to import memoryService for ${workerId}: ${err.message}`, { workerId, err: err?.message ?? err });
        });
      });
    }

    runReviewGate(worker, workerId, templateType).then(({ decision, annotation }) => {
      if (annotation) {
        worker.ralphLearnings = worker.ralphLearnings
          ? `${annotation}\n${worker.ralphLearnings}`
          : annotation;
      }

      // Write blackboard warning so sibling workers see the flag immediately
      const projectDir = worker.workingDir || worker.projectPath;
      if ((decision === 'fail' || decision === 'conditional') && projectDir) {
        const rootId = getHierarchyRootId(workerId, workers);
        const workerLabel = worker.label || workerId;
        const summary = annotation
          ? `${workerLabel}: ${annotation}`
          : `${workerLabel} flagged as ${decision} by review gate`;
        appendBlackboardEntry(
          projectDir,
          rootId,
          workerId,
          workerLabel,
          'warning',
          'review_gate',
          summary.slice(0, 200)
        ).catch(err => {
          getLogger().warn(`[ReviewGate] Failed to write blackboard warning for ${workerId}: ${err.message}`, { workerId });
        });
      }

      const statusNote = decision === 'fail'
        ? 'Complete (review flagged issues)'
        : decision === 'conditional'
          ? 'Complete (with review annotation)'
          : 'Complete';
      deliverResultsToParent(worker, workerId, statusNote);
    }).catch(() => {
      // Review gate error: deliver normally without annotation
      deliverResultsToParent(worker, workerId, 'Complete');
    });
  }

  // Also notify parent worker if exists (for non-done signals)
  if (worker.parentWorkerId && status !== 'done' && !autoPromoted) {
    const parent = workers.get(worker.parentWorkerId);
    if (parent && io) {
      io.emit('worker:child:signaled', {
        parentWorkerId: worker.parentWorkerId,
        childWorkerId: workerId,
        childLabel: worker.label,
        status,
        progress: worker.ralphProgress,
        currentStep: worker.ralphCurrentStep,
        learnings: worker.ralphLearnings,
        outputs: worker.ralphOutputs
      });
    }
  }

  // Auto-update parent Ralph progress from aggregate of children's progress
  if (worker.parentWorkerId) {
    _updateParentAggregation(worker.parentWorkerId, io);
  }

  // Lazy import to avoid circular dependency (persistence → output → persistence)
  // Both the import and saveWorkerState are awaited so errors from either are caught.
  (async () => {
    try {
      const { saveWorkerState } = await import('./persistence.js');
      await saveWorkerState();
    } catch (err) {
      getLogger().error(`State save failed after Ralph signal`, { error: err.message });
    }
  })();
  return true;
}

/**
 * Internal helper: update parent's aggregate progress from children's progress.
 */
function _updateParentAggregation(parentWorkerId, io) {
  const parent = workers.get(parentWorkerId);
  if (!parent || !parent.childWorkerIds || parent.childWorkerIds.length === 0) return;

  const children = parent.childWorkerIds
    .map(cid => workers.get(cid))
    .filter(Boolean);
  if (children.length === 0) return;

  // Use childWorkerHistory for total count (includes dismissed children)
  const historyCount = (parent.childWorkerHistory || []).length;
  const dismissedCount = historyCount - children.filter(c => (parent.childWorkerHistory || []).includes(c.id)).length;

  let totalProgress = 0;
  let doneCount = dismissedCount; // Dismissed children count as done
  const steps = [];
  for (const child of children) {
    const cp = child.ralphProgress || 0;
    const cs = child.ralphStatus;
    if (cs === 'done' || child.status === 'awaiting_review' || child.status === 'completed') {
      totalProgress += 100;
      doneCount++;
    } else {
      totalProgress += cp;
      if (child.ralphCurrentStep) {
        steps.push(`${child.label.slice(0, 30)}: ${child.ralphCurrentStep.slice(0, 60)}`);
      }
    }
  }
  // Total includes dismissed (scored at 100%) + live children
  const totalChildren = Math.max(children.length + dismissedCount, 1);
  totalProgress += dismissedCount * 100; // Each dismissed child = 100% progress
  const avgProgress = Math.round(totalProgress / totalChildren);
  const stepSummary = doneCount === totalChildren
    ? `All ${doneCount} children complete`
    : `${doneCount}/${totalChildren} done` + (steps.length > 0 ? ` | ${steps[0]}` : '');

  // Only auto-update if parent hasn't manually signaled, OR if aggregate is higher.
  if (parent._ralphManuallySignaled) {
    // Parent has manually signaled — only update if aggregate is higher
    if (avgProgress > (parent.ralphProgress || 0)) {
      parent.ralphProgress = avgProgress;
      parent.ralphCurrentStep = stepSummary.slice(0, 500);
      if (io) {
        io.to(`worker:${parent.id}`).emit('worker:updated', normalizeWorker(parent));
      }
    }
  } else {
    // No manual signal — child-driven updates take full control
    parent.ralphProgress = avgProgress;
    parent.ralphCurrentStep = stepSummary.slice(0, 500);
    if (io) {
      io.to(`worker:${parent.id}`).emit('worker:updated', normalizeWorker(parent));
    }
  }

  // Auto-promote parent to done when ALL children are done and parent is at >= 80%
  // Skip persistent tiers (GENERAL/COLONEL) — they manage their own lifecycle
  if (doneCount === totalChildren && parent.ralphStatus !== 'done' &&
      parent.status !== 'awaiting_review' && !isPersistentTier(parent) &&
      (parent.ralphProgress >= 80 || avgProgress >= 100)) {
    getLogger().info(`Auto-promoted parent ${parentWorkerId} (${parent.label}) to done (all ${totalChildren} children complete, ${dismissedCount} dismissed)`, { parentWorkerId, label: parent.label, childCount: totalChildren });
    transitionToDone(parent, parentWorkerId, io, `Complete (auto-promoted — all children done)`);
  }
}
