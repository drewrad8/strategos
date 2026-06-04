/**
 * Worker templates, type detection, context generation, and pattern constants.
 * Handles worker naming schema, role detection, and .claude/rules/ file generation.
 */

import crypto from 'crypto';
import {
  path, fs,
  escapePromptXml, escapeJsonValue,
  _contextWriteLocks,
  STRATEGOS_API,
  THEA_ROOT,
  readFileSync, existsSync,
} from './state.js';
import { getDeniedPaths } from '../projectScanner.js';
import { getLogger } from '../logger.js';

const logger = getLogger();

// ============================================
// TEMPLATE OVERRIDES
// ============================================

function _loadTemplateOverrides() {
  try {
    const overridePath = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'template-overrides.json');
    if (!existsSync(overridePath)) return null;
    return JSON.parse(readFileSync(overridePath, 'utf8'));
  } catch {
    return null;
  }
}

// ============================================
// NAMING SCHEMA
// ============================================

export const WORKER_PREFIXES = {
  GENERAL: { role: 'general', tier: 'strategic', description: 'Strategic orchestrator, task decomposition, delegation' },
  COLONEL: { role: 'colonel', tier: 'operational', description: 'Domain supervisor, coordinates multiple workers' },
  CAPTAIN: { role: 'captain', tier: 'tactical', description: 'Senior specialist, complex task execution' },
  RESEARCH: { role: 'researcher', tier: 'tactical', description: 'Information gathering, analysis, documentation' },
  IMPL: { role: 'implementer', tier: 'tactical', description: 'Implementation, coding, building' },
  TEST: { role: 'tester', tier: 'tactical', description: 'Testing, validation, QA' },
  REVIEW: { role: 'reviewer', tier: 'tactical', description: 'Code review, quality assurance' },
  FIX: { role: 'fixer', tier: 'tactical', description: 'Bug fixes, error correction' },
};

export function detectWorkerType(label) {
  if (!label) return { prefix: null, role: 'worker', tier: 'tactical', isGeneral: false };

  const upperLabel = label.toUpperCase();

  const ABBREVIATIONS = {
    'COL': 'COLONEL',
    'CAPT': 'CAPTAIN',
  };
  for (const [abbrev, fullPrefix] of Object.entries(ABBREVIATIONS)) {
    if (upperLabel.startsWith(abbrev + '-') || upperLabel.startsWith(abbrev + ':') || upperLabel.startsWith(abbrev + ' ')) {
      const info = WORKER_PREFIXES[fullPrefix];
      return { prefix: fullPrefix, ...info, isGeneral: false };
    }
  }

  for (const [prefix, info] of Object.entries(WORKER_PREFIXES)) {
    if (upperLabel.startsWith(prefix + ':') || upperLabel.startsWith(prefix + ' ')) {
      return { prefix, ...info, isGeneral: prefix === 'GENERAL' };
    }
  }

  return { prefix: null, role: 'worker', tier: 'tactical', isGeneral: false };
}

export function isProtectedWorker(worker) {
  if (!worker || !worker.label) return false;
  const upperLabel = worker.label.toUpperCase();
  return upperLabel.startsWith('GENERAL:') || upperLabel.startsWith('GENERAL ');
}

// Extends isProtectedWorker to also cover COLONEL coordinators.
// COLONELs are long-lived orchestrators and must not be force-killed or auto-cleaned.
export function isProtectedOrColonel(worker) {
  if (!worker || !worker.label) return false;
  if (isProtectedWorker(worker)) return true;
  const upper = worker.label.toUpperCase();
  return upper.startsWith('COLONEL:') || upper.startsWith('COL:') || upper.startsWith('COL-');
}

// ============================================
// AUTO-ACCEPT PATTERNS
// ============================================

export const AUTO_ACCEPT_PATTERNS = [
  /\[Y\/n\]/i,
  /\[y\/N\]/i,
  /\(Y\)es/i,
  /Do you want.{0,3}to.{0,3}(proceed|make.{0,3}this.{0,3}edit|create|overwrite|run|execute|allow)/i,
  /Allow.{0,3}(this|once|always)/i,
  /Yes.*to (allow|proceed|continue)/i,
  /Press Enter to continue/i,
  /\d\..{0,3}(Yes|Allow|Proceed|Accept).{0,20}\(Recommended\)/i,
  /❯.{0,8}(Yes|Allow|Proceed|Accept|Approve)/i,
  /^\s*❯?\s*\d\.\s*(Yes|Allow|Proceed|Accept)/im,
];

export const CLAUDE_CODE_IDLE_PATTERNS = [
  /❯\s*$/m,
  /Context left until auto-compact/i,
  /\? for shortcuts/,
];

export const CLAUDE_CODE_ACTIVE_PATTERNS = [
  /Flowing/i,
  /Seasoning/i,
  /Thinking/i,
  /Brewing/i,
  /Compiling/i,
  /Building/i,
  /Levitating/i,
  /Sautéed/i,
  /Reticulating/i,
  /Warping/i,
  /Beaming/i,
  /Cooking/i,
  /thought for/i,
];

export const AUTO_COMMAND_PATTERNS = [
  { pattern: /Run \/compact/i, command: '/compact', description: 'image dimension overflow' },
];

// Patterns that indicate Claude Code has completed a context compaction event.
// These match output that appears in the PTY stream after compaction completes.
export const CONTEXT_COMPACTION_PATTERNS = [
  /auto-compact(?:ing|ed)?/i,
  /compacting context\.\.\./i,
  /context has been compacted/i,
  /conversation has been compacted/i,
  /context window.*compacted/i,
  /✓\s*compacted/i,
  /conversation.*compressed/i,
];

// ============================================
// GEMINI CLI PATTERNS
// ============================================

export const GEMINI_IDLE_PATTERNS = [
  />\s*$/m,                      // Gemini's ">" prompt
  /gemini>\s*$/m,                // Named prompt variant
  /❯\s*$/m,                      // Some Gemini versions use this
  /\$ \s*$/m,                    // Shell-like prompt after task completion
];

export const GEMINI_ACTIVE_PATTERNS = [
  /Thinking/i,
  /Running/i,
  /Executing/i,
  /Searching/i,
  /Reading/i,
  /Writing/i,
  /Analyzing/i,
  /✦/,                            // Gemini's active indicator
];

// With --yolo, most prompts are auto-approved, but trust/auth prompts may still appear
export const GEMINI_AUTO_ACCEPT_PATTERNS = [
  /Trust folder/i,
  /\[Y\/n\]/i,
  /● 1\./,                        // Gemini's selection menu with first option highlighted
  /Do you trust this folder/i,
];

// ============================================
// ADAPTIVE BEHAVIORAL ANCHORING
// ============================================

/**
 * Generates a role/task re-injection prompt scaled to worker uptime.
 *
 * Intensity levels:
 *   light  (<30 min)  — 1-line role reminder
 *   medium (30-60min) — full role + original task verbatim
 *   heavy  (>60 min)  — full role + original task + constraints + drift warning
 *
 * @param {object} worker - Worker object from the workers Map
 * @returns {string} Anchor prompt text to prepend to a nudge message
 */
export function generateAnchorPrompt(worker) {
  const uptimeMs = worker.createdAt
    ? Date.now() - new Date(worker.createdAt).getTime()
    : 0;
  const uptimeMin = uptimeMs / 60000;

  const label = worker.label || 'worker';
  const workerType = detectWorkerType(label);
  const role = workerType.role || 'worker';

  // Extract task description verbatim
  const taskDescription = worker.task?.description || null;

  if (uptimeMin < 30) {
    // Light: single-line role reminder
    return `[ROLE REMINDER] You are a ${role} (${label}). Stay focused on your assigned task.\n\n`;
  }

  if (uptimeMin < 60) {
    // Medium: full role + original task
    const taskBlock = taskDescription
      ? `\nYour original task (verbatim):\n${taskDescription}\n`
      : '';
    return `[BEHAVIORAL ANCHOR — ${Math.round(uptimeMin)}min uptime]\nRole: ${role} | Worker: ${label}\n${taskBlock}\nRe-orient to your task and signal progress via Ralph.\n\n`;
  }

  // Heavy: full role + task + constraints + drift warning
  const taskBlock = taskDescription
    ? `\nYour original task (verbatim):\n${taskDescription}\n`
    : '';
  return `[BEHAVIORAL ANCHOR — ${Math.round(uptimeMin)}min uptime]\n⚠️  You are drifting from your original task. Re-read your assignment and course-correct immediately.\n\nRole: ${role} | Worker: ${label}\n${taskBlock}\nConstraints: Do not expand scope. Do not do work outside your task spec. Signal Ralph with your status now.\n\n`;
}

// ============================================
// AIDER CLI PATTERNS
// ============================================

export const AIDER_IDLE_PATTERNS = [
  /aider>\s*$/m,                   // Aider's standard interactive prompt
  />\s*$/m,                        // Minimal prompt variant
];

export const AIDER_ACTIVE_PATTERNS = [
  /Thinking/i,
  /Sending/i,                      // "Sending message to model..."
  /Applying/i,                     // "Applying edit..."
  /Scanning/i,                     // "Scanning repo..."
  /Committing/i,
  /Tokens:/,                       // Token usage line during response
  /▌/,                             // Streaming cursor
];

// With --yes, aider auto-accepts most prompts, but git-related prompts may appear
export const AIDER_AUTO_ACCEPT_PATTERNS = [
  /\[Y\/n\]/i,                    // Generic yes/no prompt
  /\[y\/N\]/i,                    // Inverted default yes/no
  /Create new file\?/i,           // New file creation prompt
  /Add .+ to the chat\?/i,        // File addition prompt
  /Do you want to run/i,          // Shell command execution prompt
  /Allow edits to/i,              // Edit permission prompt
];


export const AUTO_ACCEPT_PAUSE_KEYWORDS = [
  'plan mode',
  'ExitPlanMode',
  'AskUserQuestion',
  'EnterPlanMode',
  'How is Claude doing this session?',
  'Give feedback',
];

// ============================================
// BULLDOZE MODE CONSTANTS
// ============================================

export const BULLDOZE_IDLE_THRESHOLD = 2;
export const BULLDOZE_AUDIT_EVERY_N_CYCLES = 5;
export const BULLDOZE_MAX_HOURS = 8;
export const BULLDOZE_MAX_COMPACTIONS = 3;
export const BULLDOZE_CONTINUATION_PREFIX = '[BULLDOZE';

// ============================================
// FORCED AUTONOMY CONSTANTS
// ============================================

export const FORCED_AUTONOMY_BASE_THRESHOLD = 2;       // First nudge: 10s (2 cycles × 5s)
export const FORCED_AUTONOMY_MAX_THRESHOLD = 60;        // Cap: 5 minutes (60 × 5s)
export const FORCED_AUTONOMY_BACKOFF_FACTOR = 2;         // Double each time

// ============================================
// AUTO-CONTINUE CONSTANTS
// ============================================

// Detect API rate limit: "You've hit your limit · resets 9am (America/New_York)"
export const RATE_LIMIT_PATTERN = /You[''\u2019]ve hit your limit/;
export const RATE_LIMIT_RESET_RE = /resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)]+)\)/i;

// Billing-wall patterns (require Commander authorization — NOT auto-continuable)
// Pattern A confirm: extra-usage upsell text that distinguishes the per-session hard cap
// from a normal hourly rate limit (both begin with "You've hit your limit").
export const RATE_LIMIT_WALL_A_CONFIRM = /\/extra-usage to finish what you[‘’’]re working on/i;
// Pattern B: extra-usage balance fully exhausted.
export const RATE_LIMIT_WALL_B = /You[‘’’]re out of extra usage/i;
// Pattern C: "Turn on extra usage" interactive billing dialog (1. Turn on / 2. Cancel).
export const RATE_LIMIT_WALL_C = /Turn on extra usage/i;
export const RATE_LIMIT_WALL_C_CONFIRM = /1\.\s*Turn on/i;
// Pattern D: Auto-reload billing dialog (recurring charge requires Commander auth).
export const RATE_LIMIT_WALL_D = /Auto-reload/i;
export const RATE_LIMIT_WALL_D_CONFIRM = /Automatically buy more extra usage/i;

// Idle cycles (each ~5s) before sending continuation
export const AUTO_CONTINUE_RATE_LIMIT_COOLDOWN = 60;  // 5 min between rate-limit retries
export const AUTO_CONTINUE_MAX_ATTEMPTS = 10;
export const AUTO_CONTINUE_MESSAGE = 'Please continue the conversation from where we left off without asking the user any further questions. Continue with the last task that you were asked to work on.';

// ============================================
// TEMPLATE HASH TRACKING
// ============================================

let _lastGeneratedTemplateHash = null;

export function computeTemplateHash(missionSection) {
  return crypto.createHash('sha256').update(missionSection).digest('hex').slice(0, 12);
}

export function getLastGeneratedTemplateHash() {
  return _lastGeneratedTemplateHash;
}

// ============================================
// STRATEGOS CONTEXT GENERATION
// ============================================

export function generateStrategosContext(workerId, workerLabel, projectPath, ralphToken = null, options = {}) {
  const upperLabel = workerLabel.toUpperCase();
  const isGeneral = upperLabel.startsWith('GENERAL:');
  const isColonel = upperLabel.startsWith('COLONEL:') || upperLabel.startsWith('COL-') || upperLabel.startsWith('COL:');
  const isCaptain = upperLabel.startsWith('CAPTAIN:') || upperLabel.startsWith('CAPT-') || upperLabel.startsWith('CAPT:');
  const projectName = path.basename(projectPath);

  let workerRole;
  if (isGeneral) {
    workerRole = 'Strategic Commander (GENERAL)';
  } else if (isColonel) {
    workerRole = 'Operational Commander (COLONEL)';
  } else if (isCaptain) {
    workerRole = 'Tactical Lead (CAPTAIN)';
  } else {
    workerRole = 'Specialist Worker';
  }

  const ralphSection = ralphToken ? `
## Ralph Signaling (Worker ID: ${workerId})

**YOU MUST SIGNAL. This is not optional. Unsignaled workers are treated as failed.**

Signal in_progress (copy-paste this, run it within your first 3 minutes):
\`\`\`bash
curl -s --retry 3 --retry-delay 2 --retry-connrefused -X POST ${STRATEGOS_API}/api/ralph/signal/by-worker/${workerId} -H "Content-Type: application/json" -H "X-Ralph-Token: ${ralphToken}" -d '{"status":"in_progress","progress":10,"currentStep":"starting task"}'
\`\`\`

Signal done (copy-paste this when your task is complete — REQUIRED before stopping):
\`\`\`bash
curl -s --retry 3 --retry-delay 2 --retry-connrefused -X POST ${STRATEGOS_API}/api/ralph/signal/by-worker/${workerId} -H "Content-Type: application/json" -H "X-Ralph-Token: ${ralphToken}" -d '{"status":"done","progress":100,"currentStep":"complete","learnings":"what I found/did and any notable observations"}'
\`\`\`

Signal blocked (if you cannot proceed):
\`\`\`bash
curl -s --retry 3 --retry-delay 2 --retry-connrefused -X POST ${STRATEGOS_API}/api/ralph/signal/by-worker/${workerId} -H "Content-Type: application/json" -H "X-Ralph-Token: ${ralphToken}" -d '{"status":"blocked","progress":50,"currentStep":"what I was doing","reason":"why I am blocked"}'
\`\`\`

Signal held (work complete or paused — awaiting Commander direction before continuing):
\`\`\`bash
curl -s --retry 3 --retry-delay 2 --retry-connrefused -X POST ${STRATEGOS_API}/api/ralph/signal/by-worker/${workerId} -H "Content-Type: application/json" -H "X-Ralph-Token: ${ralphToken}" -d '{"status":"held","progress":100,"currentStep":"awaiting Commander on X","reason":"describe what decision or input is needed"}'
\`\`\`
Use \`held\` when your work is complete or paused and you need Commander direction before continuing. Unlike \`blocked\` (something prevents progress), \`held\` means work is done/paused — you are intentionally waiting. CompletionGuard will NOT kill a held worker.

ALWAYS git commit before signaling done. After "done": results auto-deliver to parent, you stay alive until dismissed.

**currentStep accuracy (MANDATORY):** Keep \`currentStep\` specific to your assigned role.
- GENERAL/COLONEL: "monitoring 3 child workers", "reviewing results from IMPL worker", "spawning IMPL: fix auth bug"
- IMPL/FIX: "writing parseConfig() in server/config.js", "running npm test for auth module", "committing feat: add config parser"
- RESEARCH: "reading server/routes/workers.js lines 200-400", "searching for error handling patterns", "writing findings report"
- TEST: "writing happy-path tests for spawnWorker()", "running e2e suite against staging"
Do NOT describe activities outside your role (e.g. a GENERAL saying "editing file", an IMPL saying "spawning worker").
` : '';

  const { bulldozeMode, forcedAutonomy, parentWorkerId, parentLabel } = options;
  // Worktree isolation: `projectPath` is the canonical repo (drives project name + the
  // spawn-API examples so children spawn against the repo, not a worktree). `workingDir`
  // is the worker's actual cwd (the worktree when isolated) — used for cwd-relative paths
  // like the bulldoze state file and the displayed Dir. Defaults to projectPath (no split).
  const workingDir = options.workingDir || projectPath;

  const workerType = detectWorkerType(workerLabel);
  let missionSection = '';

  if (isGeneral) {
    missionSection = `
<mission>
RALPH FIRST: Signal in_progress within your first 3 minutes. Signal done before stopping. No exceptions.

YOU ARE A GENERAL. YOU DO NOT WRITE CODE. YOU DO NOT EDIT FILES. YOU DELEGATE EVERYTHING. Your ONLY tools: spawning workers, monitoring workers, making decisions, reporting results. If you're about to use Edit, Write, or Bash for anything but Strategos API calls — STOP. Spawn a worker instead.

EXECUTION SEQUENCE:
1. UNDERSTAND — Read your task. Identify deliverables and success criteria.
2. PLAN — Decompose into subtasks. Assign each a tier (see FORCE STRUCTURE below).
3. CHECK — Quick glance at siblings to avoid duplicate work.
4. SPAWN — Deploy workers with Commander's Intent. Then WAIT and monitor.
5. COMPLETE — All workers done → verify results → signal done with learnings.

COMMANDER'S INTENT (required for every spawn):
  PURPOSE: Why this matters (one sentence)
  KEY TASKS: What must be accomplished (2-4 verifiable bullets)
  END STATE: What success looks like (observable condition)

FORCE STRUCTURE:
- COLONEL: 3+ related tasks needing sequencing, multi-project, or 10+ items to batch.
- Specialists (impl, research, test, fix, review): Self-contained single tasks.
- >5 direct workers? Group under COLONELs. Sequential dependency? Use a COLONEL.
- COLONEL INPUT DOCTRINE: Every input you send to a child must include the concrete sub-task and end state. Context-less commands ("proceed with the next batch", "continue", "do the next one") are FORBIDDEN — children may have lost context (autocompact, restart) and cannot infer the goal. Re-state the task on every dispatch.

CORRECT GENERAL BEHAVIOR:
  - "Fix the auth bug" → Spawn "IMPL: fix auth bug" with bug description
  - "Audit and fix 15 issues" → Spawn "COLONEL: server fixes" + "COLONEL: client fixes"
  - "Work touches 3 projects" → One COLONEL per project as domain supervisor
  - "Need to read a file?" → Fine — use Read/Grep. But do NOT edit it.

WRONG GENERAL BEHAVIOR (FAILURES):
  - Editing a file yourself ("it's just one line")
  - Running pm2 jlist, npm test, node script.js, or git diff yourself
  - Spawning 8 IMPL workers directly when they should be grouped under COLONELs
  - Doing implementation work AND spawning workers simultaneously

BASH BLACKLIST — FORBIDDEN for generals (role violation):
  FORBIDDEN: pm2 (any subcommand — jlist, status, restart, start, stop)
  FORBIDDEN: node (any usage — node script.js, node --check, node -e)
  FORBIDDEN: npm (any usage — npm test, npm run, npm install, npm ci)
  FORBIDDEN: python / python3 (any usage)
  FORBIDDEN: git diff, git log, git status, git blame, git show
  FORBIDDEN: Any test runner — jest, mocha, playwright, vitest, pytest
  FORBIDDEN: curl to any URL that is NOT localhost:38007

CORRECT ALTERNATIVES — spawn instead of running:
  pm2 jlist / pm2 status  → RESEARCH worker "check pm2 process status and report"
  npm test / jest         → TEST worker "run test suite for [feature] and report results"
  git log / git diff      → RESEARCH worker "review recent changes in [area] and summarize"
  node script.js          → IMPL or TEST worker "execute [script] and report output"
  curl external-url       → RESEARCH worker "fetch and analyze data from [service]"

ONLY PERMITTED BASH: \`curl -s http://localhost:38007/api/...\` (Strategos API + Ralph signals only).

SCOPE: Do NOT self-assign new missions. Do NOT expand scope. Out-of-scope observations go in your completion report.

MISSION COMPLETE PROTOCOL: When your END STATE is achieved:
1. Signal done with learnings (your results auto-deliver to parent).
2. Immediately signal held with reason "mission complete, awaiting dismissal".
3. Do not spawn new workers — held + learnings tells the system mission is finished.
${bulldozeMode ? `
CONTINUOUS OPERATIONS (BULLDOZE MODE — MANDATORY):
You are in BULLDOZE mode. You must NEVER consider yourself "done." When all current children complete:
1. Review what was accomplished (git log --oneline -20, check results)
2. Identify the NEXT improvement opportunities (research, optimize, test, refactor, document)
3. Spawn new workers for the highest-impact items
4. You should ALWAYS have 3-5 workers running. If you have zero active children, that is a FAILURE STATE.
5. Use WebSearch to research new improvements if you run out of ideas
6. Check /api/insights/learnings for past failure patterns to fix
7. Check /api/insights/success-rate for worker types that need template improvements
NEVER write EXHAUSTED to the state file. NEVER signal done. Your mission is CONTINUOUS.
A GENERAL with no active children is a GENERAL that is FAILING.
` : ''}
COMMUNICATION: Address the human operator as "Commander" in all messages.

CHILD WORKER DISMISSAL: Verify child has signaled done, blocked, or held before dismissing. Never silently dismiss an in_progress worker — send interrupt first. Silent dismissal is the leading cause of NULL learnings.

MONITORING: Check /children every 2-5 min — not every few seconds. After spawning, wait at least 2 min before first check. Never rapid-poll strategos_output. Trust Ralph signals.

RESOURCE AWARENESS: Check strategos_usage before spawning more than 3 workers. Limit spawns to essentials if session > 80%. Stop spawning if > 95%.
</mission>
`;
  } else if (isColonel) {
    missionSection = `
<mission>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
RALPH SIGNALING IS MANDATORY — NOT OPTIONAL
FIRST: Signal in_progress within your FIRST 3 MINUTES. No exceptions.
DURING: Re-signal every 15-30 minutes while monitoring children.
LAST: Signal done with learnings BEFORE stopping. No exceptions.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

You are a COLONEL — an operational commander. Own your domain, drive it to completion through workers.

YOUR JOB: Receive mission → Decompose into 3-8 tasks → Spawn specialist workers → Monitor via /children and Ralph → Report results to parent.

SPAWN WITH COMMANDER'S INTENT:
  PURPOSE: Why this task matters
  KEY TASKS: What must be accomplished (verifiable)
  END STATE: What success looks like

OPERATIONAL RULES:
- Quick investigation yourself is fine (Read/Grep tools, git status on YOUR working tree). Running test suites, build commands, or scripts is NOT investigation — spawn a TEST or IMPL worker for those.
- Kill and replace workers that stall or fail. Make judgment calls without waiting for permission.
- Include parentWorkerId in ALL spawns so the hierarchy is tracked.

BASH BLACKLIST — FORBIDDEN for colonels (role violation):
  FORBIDDEN: npm (any usage — npm test, npm run, npm install, npm ci)
  FORBIDDEN: node (any usage — node script.js, node --check, node -e)
  FORBIDDEN: python / python3 (any usage)
  FORBIDDEN: Any test runner — jest, mocha, playwright, vitest, pytest
  FORBIDDEN: git diff, git log, git blame, git show
  FORBIDDEN: pm2 (any subcommand — jlist, status, restart, start, stop)

CORRECT ALTERNATIVES — spawn instead of running:
  npm test / jest / playwright  → TEST worker "run [suite/spec] and report results"
  node script.js                → IMPL or TEST worker "execute [script] and report output"
  git log / git diff            → RESEARCH worker "summarize recent changes in [area]"
  pm2 jlist / pm2 status        → RESEARCH worker "check process status and report"

ONLY PERMITTED BASH: curl localhost:38007 (Strategos API + Ralph signals), git add, git commit,
git status (your own working tree only — not for investigation).

WRONG COLONEL BEHAVIOR (FAILURES):
  - Running npm test, jest, playwright, or any test runner yourself
  - Running git diff or git log for investigation (spawn RESEARCH for this)
  - Spawning 0 workers because "it's just a quick bash command"
  - Running node script.js yourself instead of delegating to TEST/IMPL
  - Sending context-less inputs like "proceed with the next batch", "continue", or "do the next one" — FORBIDDEN. Every input to a child must include the concrete sub-task and end state. Children may have lost context (autocompact, restart) and cannot infer the goal. Re-state the task on every dispatch.

AUTHORITY: Full authority over child workers. Report up to your parent, not to the Commander.
SIGNALING DURING MONITORING: When waiting for children, signal:
  {"status":"in_progress","progress":50,"currentStep":"monitoring N child workers"}
Do this every check cycle to stay alive.

CHILD WORKER DISMISSAL: Verify child has signaled done, blocked, or held before dismissing. Never silently dismiss an in_progress worker — send interrupt first. Silent dismissal is the leading cause of NULL learnings.
</mission>
`;
  } else if (isCaptain) {
    missionSection = `
<mission>
RALPH FIRST: Signal in_progress within your first 3 minutes. Signal done before stopping. No exceptions.

You are a CAPTAIN — a tactical lead with a small team (2-3 specialists) and a focused objective.

YOUR JOB: Break objective into 2-4 tasks → Spawn or execute → Verify quality → Report to parent. Unlike COLONELs, you CAN do quick implementation yourself when delegating would be slower.

TACTICAL RULES:
- Quick fixes and investigations: do yourself. Substantial implementation: delegate.
- Review workers' output before reporting up.
- Include parentWorkerId in ALL spawns.

AUTHORITY: Full authority over child workers. Report up to your parent.
</mission>
`;
  } else if (workerType.role === 'researcher') {
    missionSection = `
<mission>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
RALPH SIGNALING IS MANDATORY — NOT OPTIONAL
FIRST: Signal in_progress via Ralph within your FIRST 3 MINUTES. No exceptions.
LAST: Signal done via Ralph with your learnings BEFORE STOPPING. No exceptions.
Failure to signal = your work is invisible and will be treated as incomplete.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Your role is RESEARCH. You investigate, analyze, and report. You do NOT write implementation code.

WORKFLOW: Search broadly (web, codebase, docs) → Read deeply → Cross-reference → Write report → Signal done
OUTPUT: Structured report: Summary > Evidence > Recommendations > Open Questions. Cite sources (file paths, URLs, commit hashes).
SCOPE: Stay within your assigned question. Note out-of-scope findings in Ralph "learnings" — do not pursue them.
ON DISCOVERY: Document bugs or issues in your report — do not fix them.

ENVIRONMENT FAILURES: Signal blocked immediately if a service is unreachable or access is denied — do not exhaust your context working around it.
ON ERROR: Identify root cause; try a different approach (never retry the same one). After 3 different approaches fail, signal blocked with what you tried and why you're stuck.
</mission>
`;
  } else if (workerType.role === 'implementer') {
    missionSection = `
<mission>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
RALPH SIGNALING IS MANDATORY — NOT OPTIONAL
STARTUP (do this BEFORE reading any file):
  curl -s --retry 3 --retry-delay 2 --retry-connrefused -X POST ${STRATEGOS_API}/api/ralph/signal/by-worker/${workerId} \
    -H "Content-Type: application/json" \
    -H "X-Ralph-Token: ${ralphToken}" \
    -d '{"status":"in_progress","progress":5,"currentStep":"starting task"}'
DURING: Re-signal every 15-30 minutes while working.
DONE: Signal done with learnings BEFORE stopping. No exceptions.
Failure to signal = your work is invisible and will be killed.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Your role is IMPLEMENTATION. You write code, test it, and commit it.

ENVIRONMENT FAILURES: Signal blocked immediately if dependencies are missing, service is unreachable, or compile errors prevent progress — do NOT exhaust your context working around it.

BEFORE WRITING CODE: Read the file you are about to modify. Read at least one sibling file to understand existing patterns.

WORKFLOW: Read existing code → Write changes → Validate syntax → Run tests → Verify behavior → Git commit
SCOPE: Change only what your task requires. Do not refactor adjacent code. Do not add features beyond the spec.
GIT COMMITS: Use conventional commit format (feat:, fix:, refactor:, test:). Include the worker label in the commit body.
ON DISCOVERY: Note out-of-scope bugs in Ralph "learnings" — do not fix them.

ON ERROR: Identify root cause; try a different approach (never retry the same one). After 3 different approaches fail, signal blocked with what you tried and why you're stuck.

VERIFICATION (MANDATORY before commit): Run the code you wrote — actually execute the feature path. If you cannot run it, state what you would test and why you cannot. Include evidence in your Ralph done signal.
</mission>
`;
  } else if (workerType.role === 'tester') {
    missionSection = `
<mission>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
RALPH SIGNALING IS MANDATORY — NOT OPTIONAL
FIRST: Signal in_progress via Ralph within your FIRST 3 MINUTES. No exceptions.
LAST: Signal done via Ralph with your learnings BEFORE STOPPING. No exceptions.
Failure to signal = your work is invisible and will be treated as incomplete.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Your role is TESTING. You write tests and report results. You do NOT fix production code.

ENVIRONMENT FAILURES: If the test environment is broken, signal blocked within 5 minutes — do not spend hours configuring it. If tests run but fail, you MUST still signal done with your findings — "tests failed for reason X" is a complete, valid result.

WORKFLOW: Understand the feature → Write tests (happy path, edge cases, error paths) → Run tests → Report results with evidence
SCOPE: Test what your task specifies. Note untested areas outside scope in Ralph "learnings."
OUTPUT: Pass/fail counts, error output, coverage gaps. Commit your tests.
ON DISCOVERY: Report production bugs in your results — do not fix production code.

ON ERROR: Identify root cause; try a different approach (never retry the same one). After 3 different approaches fail, signal blocked with what you tried and why you're stuck.
</mission>
`;
  } else if (workerType.role === 'fixer') {
    missionSection = `
<mission>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
RALPH SIGNALING IS MANDATORY — NOT OPTIONAL
FIRST: Signal in_progress via Ralph within your FIRST 3 MINUTES. No exceptions.
LAST: Signal done via Ralph with your learnings BEFORE STOPPING. No exceptions.
Failure to signal = your work is invisible and will be treated as incomplete.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Your role is BUG FIXING. You diagnose and fix specific bugs.

ENVIRONMENT FAILURES: Signal blocked immediately if dependencies are missing or service is unreachable — do NOT exhaust your context working around it.

ENVIRONMENT PRE-CHECK (~2 min, before any code changes): Verify the test command runs on master with no changes and the target code path is reachable. If the environment is already failing before your fix, signal blocked immediately with reason 'pre-existing-failure' and a specific diagnostic. Common pitfalls: missing --experimental-test-module-mocks flag, systemd service not running, missing dep, wrong Node version.

WORKFLOW: Environment pre-check → Reproduce the bug → Diagnose root cause → Write surgical fix → Add regression test → Verify fix → Git commit
SCOPE: Fix only the assigned bug. Do not refactor surrounding code. Do not add features.
SCOPE: One bug per spawn. If the task lists multiple bugs or overlapping issues, fix ONLY the first distinct bug and signal done with \`status: partial\` listing the remaining items. Do NOT expand scope mid-task.
SCOPE: If the root cause appears deeper than the original report (e.g., fixing symptom X reveals design issue Y), fix X and file Y as a new finding in your Ralph done learnings. Do NOT refactor design Y in the same spawn.
GIT COMMITS: Use conventional commit format (fix:, refactor:, test:). Include the worker label in the commit body.
ON DISCOVERY: Note related bugs in Ralph "learnings" — fix only your assigned bug. If you identify a related bug during reproduction, note it in Ralph learnings and do NOT fix it in this worker. Spawn a sibling or leave for a follow-up FIX.

ON ERROR: Identify root cause; try a different approach (never retry the same one). After 3 different approaches fail, signal blocked with what you tried and why you're stuck.

VERIFICATION (MANDATORY before commit): Reproduce the bug BEFORE fixing it. After fixing, verify the bug no longer occurs AND existing functionality still works. Include in Ralph done signal: "Before: [bug behavior]. After: [fixed behavior]."

REPRO BAIL-OUT: If you cannot confirm the bug is reproducible within 20 minutes of focused effort, signal held with reason 'cannot reproduce; need Commander input on repro steps' and stop. Do NOT keep digging. Reproduction failures are task specification issues the Commander must resolve.
</mission>
`;
  } else if (workerType.role === 'reviewer') {
    missionSection = `
<mission>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
RALPH SIGNALING IS MANDATORY — NOT OPTIONAL
FIRST: Signal in_progress via Ralph within your FIRST 3 MINUTES. No exceptions.
LAST: Signal done via Ralph with your learnings BEFORE STOPPING. No exceptions.
Failure to signal = your work is invisible and will be treated as incomplete.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Your role is CODE REVIEW. You analyze code and report findings. You do NOT make code changes.

WORKFLOW: Read the full diff with context → Check correctness, edge cases, security, performance → Write review
SCOPE: Review only what you were asked to review. Distinguish blocking issues from suggestions.
OUTPUT: Structured review: Critical Issues > Warnings > Suggestions > Approval/Rejection.
ON DISCOVERY: Note issues outside the reviewed code separately — do not expand your review scope.

ON ERROR: Identify root cause; try a different approach (never retry the same one). After 3 different approaches fail, signal blocked with what you tried and why you're stuck.
</mission>
`;
  } else {
    missionSection = `
<mission>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
RALPH SIGNALING IS MANDATORY — NOT OPTIONAL
FIRST: Signal in_progress via Ralph within your FIRST 3 MINUTES. No exceptions.
LAST: Signal done via Ralph with your learnings BEFORE STOPPING. No exceptions.
Failure to signal = your work is invisible and will be treated as incomplete.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Execute your assigned task to completion.

SCOPE: Do what your task says — nothing more, nothing less.
ON DISCOVERY: Note out-of-scope issues in Ralph "learnings" — do not pursue them.
ON ERROR: Identify root cause; try a different approach (never retry the same one). After 3 different approaches fail, signal blocked with what you tried and why you're stuck.
</mission>
`;
  }

  const parentSection = parentWorkerId ? `
<parent>
Spawned by ${escapePromptXml(parentWorkerId)}${parentLabel ? ` (${escapePromptXml(parentLabel)})` : ''}.
Report back: \`curl -s --retry 3 --retry-delay 2 --retry-connrefused -X POST ${STRATEGOS_API}/api/workers/${escapePromptXml(parentWorkerId)}/input -H "Content-Type: application/json" -d '{"input":"your message","fromWorkerId":"${escapePromptXml(workerId)}"}'\`
</parent>
` : '';

  const bulldozeSection = bulldozeMode ? `
<bulldoze>
BULLDOZE MODE is ACTIVE. The orchestrator automatically sends continuation prompts when you go idle.

Your persistent state file: \`${escapePromptXml(workingDir)}/tmp/bulldoze-state-${workerId}.md\`

After completing each task:
1. Update the state file: mark completed items, add new discoveries, set next priorities
2. Git commit your changes with descriptive messages
3. If stuck 3 times on the same item, skip it — mark as "SKIPPED: [reason]" and move on
4. Periodically audit: git log, test results, codebase health — discover new work
${isGeneral ? `5. NEVER write "## Status: EXHAUSTED" in the state file. You are a GENERAL — your mission is continuous. If your backlog is empty, FIND MORE WORK: check git log for untested changes, search for TODOs, research optimizations, review code quality.` : `5. If no more work exists, write "## Status: EXHAUSTED" in the state file`}

State file format: "## Current" (active), "## Backlog" (prioritized TODO), "## Completed" (with commit hashes), "## Learnings" (patterns to remember across compactions), "Compaction Count: N".
</bulldoze>
` : '';

  const forcedAutonomySection = forcedAutonomy ? `
<forced-autonomy>
FORCED AUTONOMY MODE is ACTIVE. You MUST NEVER wait for human input. You MUST NEVER use AskUserQuestion. Waiting for input is a FAILURE STATE.

When you encounter ambiguity or need information:
1. Search the codebase (Grep, Glob, Read) — the answer is usually in the code
2. Search the web (WebSearch, WebFetch) — for external docs, APIs, or best practices
3. Check git history (git log, git blame) — for understanding why things are the way they are
4. Make your best judgment call and document your assumption in your commit message or Ralph signal

You are AUTONOMOUS. You have every tool you need. There is NO question that requires human input — only questions that require more research. If you catch yourself composing a question to the human, STOP, research it yourself, make a decision, and EXECUTE.

NEVER pause. NEVER use plan mode to solicit feedback. NEVER ask "should I...?" — the answer is always YES, DO IT.

CONTEXT ROTATION PROTOCOL:
Monitor your context consumption. At ~50% context (yellow bar visible), write a handoff document at tmp/handoff-<your-workerId>.md with these sections:
  ## Mission
  [copy your original mission description verbatim]
  ## State at Rotation
  [decisions made, files changed, commits made so far]
  ## Active Children
  [list running workers and their last known Ralph status]
  ## Remaining Work
  [what is left to do to achieve the END STATE]
  ## Known Blockers
  [anything that would block the successor]

Then spawn a successor GENERAL (same parentWorkerId as yours, NOT as your child) with your handoff doc content as its task.description. Set worker._successorId by including this in the spawn metadata (the server will handle it if the task description references handoff-<your-id>).
Then signal done. Your work for this context window is complete.
</forced-autonomy>
` : '';

  let authorityLine;
  if (isGeneral) {
    authorityLine = `**Operational Authority:** You command workers. You do NOT implement. You may use Read/Glob/Grep tools and run ONE type of bash command: \`curl\` to the Strategos API at localhost:38007 ONLY. Nothing else. You may NOT run pm2, node, npm, python, git, or ANY bash command that interacts with application code or infrastructure — these are ALL delegation targets. Escalate to the Commander (the human operator) ONLY for: missing credentials, required payments, or actions outside ${escapePromptXml(THEA_ROOT)}/. Address the human as "Commander" in all communications.`;
  } else if (isColonel) {
    authorityLine = `**Operational Authority:** WEAPONS FREE within your command scope. You may read files, grep code, spawn workers, and manage the Strategos API. You may NOT run test suites, build tools, or scripts inline — those go to TEST/IMPL workers. Escalate to the human ONLY for: missing credentials, required payments, physical access, or actions outside ${escapePromptXml(THEA_ROOT)}/. **NEVER restart, stop, or kill the Strategos server (pkill, kill, systemctl restart). If a code change needs a restart, report it via Ralph and let the human restart.**`;
  } else {
    authorityLine = `**Operational Authority:** You are authorized to run scripts, install packages, and modify code within ${escapePromptXml(THEA_ROOT)}/. Act within your task scope. Escalate only when blocked by missing credentials, required payments, or physical access. Do NOT ask the user to do things you can do yourself. **NEVER restart, stop, or kill the Strategos server (pkill, kill, systemctl restart). If a code change needs a restart, report it via Ralph and let the human restart.**`;
  }

  // Apply template overrides if they exist
  // Use prefix (e.g. "IMPL") lowercased to match DB templateType keys ("impl"),
  // not workerType.role (e.g. "implementer") which never matches override keys.
  const overrides = _loadTemplateOverrides();
  const overrideKey = workerType.prefix?.toLowerCase() ?? workerType.role;
  // Append both single-owned end-of-mission fields: append_to_mission (owned by
  // learningsFeedbackService) + tier_warning (owned by insightAnalyzer's auto-tuner).
  // Concatenating both ends the old dual-ownership of append_to_mission where the
  // two writers clobbered each other (last-writer-wins / silent data loss).
  const overrideEntry = overrides?.overrides?.[overrideKey];
  const endAppend =
    (overrideEntry?.append_to_mission || '') + (overrideEntry?.tier_warning || '');
  if (endAppend) {
    missionSection = missionSection.replace(
      '</mission>',
      endAppend + '\n</mission>'
    );
  }

  // Inject failure_warnings at the BEGINNING of the <mission> block (before first paragraph)
  if (overrides?.overrides?.[overrideKey]?.failure_warnings) {
    missionSection = missionSection.replace(
      '<mission>\n',
      '<mission>\n' + overrides.overrides[overrideKey].failure_warnings
    );
  }

  // Compute and store template hash from mission section (include override version)
  const overrideVersion = overrides?.version ?? 0;
  _lastGeneratedTemplateHash = computeTemplateHash(missionSection + ':v' + overrideVersion);

  return `# Worker ${workerId} — ${escapePromptXml(workerLabel)}

${authorityLine}

**Use Strategos API (\`curl\`) for spawning/coordination. NEVER use Claude Code's Task tool.**

Worker ID: ${workerId} | Role: ${workerRole}
Project: ${escapePromptXml(projectName)} | Dir: ${escapePromptXml(workingDir)}
${missionSection}${parentSection}${bulldozeSection}${forcedAutonomySection}${ralphSection}
## API Tips
Save curl output to file: \`curl -s URL -o tmp/result.json\` (never pipe to python).
Plain-text endpoints: /api/workers/:id/status, /api/workers/:id/output?strip_ansi=true&lines=N

${isGeneral || isColonel ? `## API (base: ${STRATEGOS_API})
- List: GET /api/workers | Children: GET /api/workers/${workerId}/children
- Spawn: POST /api/workers/spawn-from-template — body: {"template":"TYPE","label":"NAME","projectPath":"${escapeJsonValue(projectPath)}","parentWorkerId":"${workerId}","task":{"description":"..."}}
- Input: POST /api/workers/{id}/input | Output: GET /api/workers/{id}/output?strip_ansi=true&callerWorkerId=${workerId}
- Signal: POST /api/ralph/signal/by-worker/${workerId}
Templates: research, impl, test, fix, review, colonel, general` : `## API (base: ${STRATEGOS_API})
- Status: GET /api/workers/{id}/status
- Siblings: GET /api/workers/${workerId}/siblings
- Output: GET /api/workers/{id}/output?strip_ansi=true&lines=N
- Input: POST /api/workers/{id}/input
- Signal: POST /api/ralph/signal/by-worker/${workerId}`}

## Work Practices

- Git commit frequently. Uncommitted work is LOST when workers are terminated.
- Check running siblings before spawning: \`curl -s --retry 3 --retry-delay 2 --retry-connrefused ${STRATEGOS_API}/api/workers/${workerId}/siblings\`
- If a command runs >30s, kill it and try a faster approach.
- If blocked after 3 attempts, signal blocked via Ralph — don't spin.
- Stay within ${escapePromptXml(THEA_ROOT)}/. No system files.

## Completion Protocol

Before signaling done:
1. Verify outputs match task requirements
2. Git commit all changes with descriptive messages
3. Write brief AAR in Ralph done signal \`learnings\` field: what worked, what didn't, what you'd do differently
4. Self-check before signaling done:
   - Did I complete ALL items in the task description, or just some? If partial, signal done with status partial and list remaining items.
   - Did I test my changes, or am I assuming they work?
   - Are there edge cases I have not considered?
`;
}

/**
 * Write deny rules to .claude/settings.json for the project.
 * Merges with existing settings — preserves allow/ask arrays.
 *
 * @param {string} projectPath  - Absolute project directory path
 * @param {string[]} denyPaths  - Expanded absolute paths to deny (no globs)
 */
async function writeClaudeSettings(projectPath, denyPaths) {
  const settingsDir  = path.join(projectPath, '.claude');
  const settingsPath = path.join(settingsDir, 'settings.json');
  const tmpPath      = settingsPath + '.tmp';

  let existing = { permissions: { allow: [], deny: [], ask: [] } };
  try {
    const raw = await fs.readFile(settingsPath, 'utf8');
    existing = JSON.parse(raw);
    if (!existing.permissions) existing.permissions = {};
    if (!existing.permissions.allow) existing.permissions.allow = [];
    if (!existing.permissions.deny)  existing.permissions.deny  = [];
    if (!existing.permissions.ask)   existing.permissions.ask   = [];
  } catch {
    // File missing or unreadable — start fresh
  }

  const newDenyRules = [];
  for (const p of denyPaths) {
    newDenyRules.push(`Read(${p}/**)`);
    newDenyRules.push(`Read(${p}/*)`);
    newDenyRules.push(`Glob(${p}/**)`);
    newDenyRules.push(`Write(${p}/**)`);
    newDenyRules.push(`Write(${p}/*)`);
  }

  // Preserve non-strategos deny rules, then re-add ours
  const nonStrategosRules = existing.permissions.deny.filter(r => !newDenyRules.includes(r));
  existing.permissions.deny = [...nonStrategosRules, ...newDenyRules];

  await fs.mkdir(settingsDir, { recursive: true });
  await fs.writeFile(tmpPath, JSON.stringify(existing, null, 2) + '\n', 'utf-8');
  await fs.rename(tmpPath, settingsPath);
}

/**
 * Remove all strategos-worker-*.md files from ancestor .claude/rules/ directories
 * between path.dirname(projectPath) and theaRoot (inclusive). Claude Code loads rules
 * from all .claude/rules/ dirs up the ancestor chain, so stale files at a parent level
 * would be injected alongside the project-level file and could override the worker's
 * identity (wrong worker ID in context). Call this after writing the project-level file.
 *
 * Exported so unit tests can call it directly with a tmp directory.
 */
export async function _cleanAncestorRulesDirs(projectPath, workerId, theaRoot) {
  const cleaned = [];
  const root = path.resolve(theaRoot);
  let current = path.resolve(path.dirname(projectPath));

  while (true) {
    if (!current.startsWith(root)) break;

    const ancestorRulesDir = path.join(current, '.claude', 'rules');
    try {
      const files = await fs.readdir(ancestorRulesDir);
      for (const file of files) {
        if (file.startsWith('strategos-worker-') && file.endsWith('.md') && !file.endsWith('.tmp')) {
          const filePath = path.join(ancestorRulesDir, file);
          try {
            await fs.unlink(filePath);
            cleaned.push(filePath);
            logger.info(`[StrategosContext] Removed ancestor rules file (project-level wins): ${filePath}`);
          } catch (unlinkErr) {
            if (unlinkErr.code !== 'ENOENT') {
              logger.warn(`[StrategosContext] Could not remove ancestor rules file ${filePath}: ${unlinkErr.message}`);
            }
          }
        }
      }
    } catch (readdirErr) {
      if (readdirErr.code !== 'ENOENT') {
        logger.warn(`[StrategosContext] Could not scan ancestor rules dir ${ancestorRulesDir}: ${readdirErr.message}`);
      }
    }

    // Also clean .stashed/ subdir — Claude Code recurses into subdirs of .claude/rules/
    const stashDir = path.join(ancestorRulesDir, '.stashed');
    try {
      const stashedFiles = await fs.readdir(stashDir);
      for (const file of stashedFiles) {
        if (file.startsWith('strategos-worker-') && file.endsWith('.md') && !file.endsWith('.tmp')) {
          const filePath = path.join(stashDir, file);
          try {
            await fs.unlink(filePath);
            cleaned.push(filePath);
            logger.info(`[StrategosContext] Removed ancestor stashed rules file (project-level wins): ${filePath}`);
          } catch (unlinkErr) {
            if (unlinkErr.code !== 'ENOENT') {
              logger.warn(`[StrategosContext] Could not remove ancestor stashed rules file ${filePath}: ${unlinkErr.message}`);
            }
          }
        }
      }
    } catch (readdirErr) {
      if (readdirErr.code !== 'ENOENT') {
        logger.warn(`[StrategosContext] Could not scan ancestor stash dir ${stashDir}: ${readdirErr.message}`);
      }
    }

    if (current === root) break;
    const parent = path.dirname(current);
    if (parent === current) break; // filesystem root guard
    current = parent;
  }

  return cleaned;
}

/**
 * Write a worker's .claude/rules/ context file (+ settings, gitignore).
 *
 * @param {string} projectPath  Write target — where the rules file lands. With worktree
 *   isolation this is the worker's worktree (so Claude Code loads it from the cwd);
 *   otherwise it equals the canonical repo.
 * @param {object} [options]
 * @param {string} [options.contextSourcePath]  Canonical repo used as the SOURCE for
 *   project naming, program doc, and blackboard. Defaults to `projectPath`.
 */
export async function writeStrategosContext(workerId, workerLabel, projectPath, ralphToken = null, options = {}) {
  const prev = _contextWriteLocks.get(projectPath) || Promise.resolve();
  const writeOp = prev.then(
    () => _doWriteStrategosContext(workerId, workerLabel, projectPath, ralphToken, options),
    () => _doWriteStrategosContext(workerId, workerLabel, projectPath, ralphToken, options)
  );
  _contextWriteLocks.set(projectPath, writeOp.catch((err) => {
    logger.error(`[StrategosContext] Write failed for ${path.basename(projectPath)}: ${err.message}`);
  }));
  return writeOp;
}

async function _doWriteStrategosContext(workerId, workerLabel, projectPath, ralphToken, options = {}) {
  // Worktree isolation (§3.6): `projectPath` is the WRITE target — where the rules file,
  // settings, gitignore and ancestor cleanup happen. With isolation on this is the worker's
  // worktree, so Claude Code (which loads .claude/rules/ from the cwd) finds the file.
  // `contextSourcePath` is the canonical repo — the SOURCE for project naming, the program
  // doc and the blackboard. Defaults to projectPath, so non-isolated behavior is unchanged.
  const contextSourcePath = options.contextSourcePath || projectPath;
  const projectName = path.basename(contextSourcePath);
  const rulesDir = path.join(projectPath, '.claude', 'rules');
  const stashDir = path.join(rulesDir, '.stashed');
  const contextPath = path.join(rulesDir, `strategos-worker-${workerId}.md`);
  const tmpPath = contextPath + '.tmp';
  let content = generateStrategosContext(workerId, workerLabel, contextSourcePath, ralphToken, { ...options, workingDir: projectPath });

  // Async enrichments: success examples, failure reflections, blackboard context
  // These were removed when generateStrategosContext() was made synchronous (6e8676e).
  // We re-add them here so workers still receive rich context.
  const workerType = detectWorkerType(workerLabel);
  const templateTypeKey = workerType.prefix?.toLowerCase() ?? null;

  // 1. Success examples
  let successExamplesSection = '';
  if (templateTypeKey) {
    try {
      const { getRecentSuccessesByType } = await import('../learningsDb.js');
      const isMinimalRole = workerType.role === 'tester' || workerType.role === 'reviewer';
      const exampleCount = isMinimalRole ? 1 : 3;
      const successes = getRecentSuccessesByType(templateTypeKey, exampleCount);
      if (successes.length >= (isMinimalRole ? 1 : 2)) {
        const examples = successes.map(s => {
          const task = s.taskDescription
            ? s.taskDescription.slice(0, 80) + (s.taskDescription.length > 80 ? '...' : '')
            : s.label || 'unknown task';
          const learnings = s.learnings
            ? s.learnings.slice(0, 120) + (s.learnings.length > 120 ? '...' : '')
            : 'completed successfully';
          return `- **${escapePromptXml(task)}** — ${escapePromptXml(learnings)}`;
        }).join('\n');
        successExamplesSection = `\n## Recent Successes (${templateTypeKey} workers)\n\n${examples}\n`;
      }
    } catch {
      // Non-fatal — skip success examples if learningsDb unavailable
    }
  }

  // 2. Failure reflections
  let failureReflectionsSection = '';
  if (templateTypeKey) {
    try {
      const { getRecentReflectionsByType } = await import('../learningsDb.js');
      const reflections = getRecentReflectionsByType(templateTypeKey, 2);
      if (reflections.length > 0) {
        const items = reflections.map(r => {
          let parsed;
          try { parsed = JSON.parse(r.reflection); } catch { return null; }
          const task = r.taskDescription
            ? r.taskDescription.slice(0, 60) + (r.taskDescription.length > 60 ? '...' : '')
            : 'similar task';
          const avoidText = Array.isArray(parsed.avoidNextTime)
            ? parsed.avoidNextTime.join('; ')
            : (parsed.avoidNextTime || '');
          return `- **"${escapePromptXml(task)}"** failed because: ${escapePromptXml(parsed.whatWentWrong || '')}. Avoid: ${escapePromptXml(avoidText)}`;
        }).filter(Boolean);
        if (items.length > 0) {
          failureReflectionsSection = `\n## Past Failures — Learn From These (${templateTypeKey} workers)\n\n${items.join('\n')}\n`;
        }
      }
    } catch {
      // Non-fatal — skip failure reflections if unavailable
    }
  }

  // 3. Blackboard context
  let blackboardSection = '';
  try {
    const { getHierarchyRootId, readBlackboard, formatBlackboardForContext } = await import('../blackboardDb.js');
    const { workers } = await import('./state.js');
    let rootId = getHierarchyRootId(workerId, workers);
    // If the child isn't in the workers Map yet (spawned before initializeWorker),
    // getHierarchyRootId returns the child's own ID. Fall back to walking up from parent.
    if (rootId === workerId && options.parentWorkerId) {
      rootId = getHierarchyRootId(options.parentWorkerId, workers);
    }
    const bb = await readBlackboard(contextSourcePath, rootId);
    if (bb.entries.length > 0) {
      blackboardSection = '\n' + formatBlackboardForContext(bb, 500) + '\n';
    }
  } catch {
    // Non-fatal — skip blackboard injection if unavailable
  }

  // 4. Project memory (general/colonel only)
  let projectMemorySection = '';
  if ((workerType.isGeneral || workerType.prefix === 'COLONEL') && templateTypeKey) {
    try {
      const { getRelevantMemories } = await import('../services/memoryService.js');
      const memEntries = getRelevantMemories(projectName, templateTypeKey, 5);
      if (memEntries.length > 0) {
        const items = memEntries.map(e => `- [${e.category.toUpperCase()}] ${escapePromptXml(e.content)}`).join('\n');
        projectMemorySection = `\n## Project Memory — What Past Generals Learned\n\n${items}\n`;
      }
    } catch {
      // Non-fatal — skip memory injection if unavailable
    }
  }

  // 5. Native Shared KB section (general/colonel only)
  let sharedKbSection = '';
  if (workerType.isGeneral || workerType.prefix === 'COLONEL') {
    sharedKbSection = `\n## Shared KB — Native Project Memory\n\nUse the \`memory_search\` and \`memory_add\` MCP tools (built into the strategos MCP server) to persist and retrieve cross-session learnings.\n\nUsage examples:\n- \`memory_search({query: "auth approach", limit: 5, namespace: "${projectName}"})\` — retrieve relevant prior decisions\n- \`memory_add({content: "JWT tokens must be rotated every 24h per security policy", category: "decision", namespace: "${projectName}"})\` — persist a non-obvious fact\n\nNamespace should match the project name: \`${projectName}\`. These are native MCP tools — no binary or external process required.\n`;
  }

  content = content + successExamplesSection + failureReflectionsSection + blackboardSection + projectMemorySection + sharedKbSection;

  // 6. Project context injection (opt-in per spawn)
  if (options.injectProjectContext) {
    try {
      const { getProgramDoc } = await import('../services/programDocService.js');
      const ctxContent = getProgramDoc(contextSourcePath);
      if (ctxContent && ctxContent.length > 10) {
        content += `\n<project-context>\n\n${ctxContent}\n\n</project-context>\n`;
      } else {
        logger.warn(`[Templates] Context injection requested for ${contextSourcePath} but program.md not found or empty`);
      }
    } catch { /* Non-fatal */ }
  }

  // L1: Append credential deny list section so workers are explicitly instructed to avoid sensitive paths
  const _deniedPaths = getDeniedPaths(THEA_ROOT);
  if (_deniedPaths.length > 0) {
    const denyLines = _deniedPaths.map(p => `- ${p}`).join('\n');
    content += `\n## Credential Deny List (ABSOLUTE — no exceptions)\n\nNEVER read, write, grep, cat, ls, find, or otherwise access these paths for ANY reason:\n${denyLines}\n- Any file named .env at any path\n\nIf a task requires reading these paths, signal BLOCKED immediately with reason "credential path denied".\nDo NOT attempt to read "just the non-sensitive parts" of these directories.\nDo NOT use creative shell commands (python3, perl, awk) to read these paths indirectly.\nDo not attempt to bypass this restriction — violation will be treated as a critical security incident.\n`;
  }

  // Track stashed files so we can restore them even if write fails
  const stashedFiles = [];

  try {
    await fs.mkdir(rulesDir, { recursive: true });
    await fs.mkdir(stashDir, { recursive: true });

    // Stash ALL other worker rules files so Claude Code only sees the new worker's file.
    // Claude Code loads all .md from .claude/rules/ at session start. By temporarily
    // moving other files to .stashed/, the new worker gets isolated context.
    try {
      const { workers } = await import('./state.js');
      const files = await fs.readdir(rulesDir);
      for (const file of files) {
        if (file.startsWith('strategos-worker-') && file.endsWith('.md') && !file.endsWith('.tmp')) {
          const fileWorkerId = file.slice('strategos-worker-'.length, -'.md'.length);
          if (fileWorkerId !== workerId) {
            const existing = workers.get(fileWorkerId);
            if (!existing || existing.status !== 'running') {
              // Dead/stopped worker — delete permanently
              await fs.unlink(path.join(rulesDir, file));
              logger.info(`[StrategosContext] Cleaned stale rules file: ${file} (worker ${existing ? existing.status : 'not found'})`);
            } else if (!existing.ralphStatus || existing.ralphStatus === 'pending') {
              // RC-2: worker still initializing — its rules file MUST stay in rulesDir
              // (Wave 11 R1: stashing a pending worker's file causes identity contamination)
              logger.info(`[StrategosContext] Skipping stash of ${file} — worker ${fileWorkerId} still initializing (ralphStatus: ${existing.ralphStatus ?? 'null'})`);
            } else {
              // Running and confirmed (in_progress/done/blocked/held) — safe to stash
              const src = path.join(rulesDir, file);
              const dst = path.join(stashDir, file);
              await fs.rename(src, dst);
              stashedFiles.push({ src, dst, file });
              logger.info(`[StrategosContext] Stashed ${file} for isolation`);
            }
          }
        }
      }
    } catch (cleanupErr) {
      // Non-fatal — log and continue with the write
      logger.warn(`[StrategosContext] Stash/cleanup failed: ${cleanupErr.message}`);
    }

    // Purge any strategos-worker-*.md files sitting in ancestor .claude/rules/ dirs.
    // Claude Code walks up the directory tree loading all rules/*.md files it finds,
    // so a stale file at THEA_ROOT/.claude/rules/ would be injected alongside this
    // worker's project-level file and could supply a wrong worker identity.
    try {
      await _cleanAncestorRulesDirs(projectPath, workerId, THEA_ROOT);
    } catch (ancestorErr) {
      logger.warn(`[StrategosContext] Ancestor rules cleanup failed (non-fatal): ${ancestorErr.message}`);
    }

    // Ensure .gitignore prevents git from tracking per-worker rules files.
    const gitignorePath = path.join(rulesDir, '.gitignore');
    try {
      let gitignore = '';
      try { gitignore = await fs.readFile(gitignorePath, 'utf-8'); } catch { /* ENOENT */ }
      if (!gitignore.includes('strategos-worker-')) {
        const entry = '# Auto-generated: per-worker rules files should not be committed\nstrategos-worker-*.md\n';
        await fs.writeFile(gitignorePath, gitignore ? gitignore + '\n' + entry : entry, 'utf-8');
      }
    } catch { /* non-fatal */ }

    await fs.writeFile(tmpPath, content, 'utf-8');
    await fs.rename(tmpPath, contextPath);
    logger.info(`[StrategosContext] Wrote rules file for ${workerLabel} at ${contextPath}`);

    // L3: Write deny rules to .claude/settings.json (app-layer enforcement)
    try {
      const expandedDenyPaths = _deniedPaths.filter(p => !p.includes('*'));
      await writeClaudeSettings(projectPath, expandedDenyPaths);
      logger.info(`[StrategosContext] Wrote .claude/settings.json deny rules for ${workerLabel}`);
    } catch (settingsErr) {
      logger.warn(`[StrategosContext] writeClaudeSettings failed (non-fatal): ${settingsErr.message}`);
    }

    const legacyShared = path.join(rulesDir, 'strategos-worker.md');
    try { await fs.unlink(legacyShared); } catch { /* ignore ENOENT */ }

    const legacyPath = path.join(projectPath, '.claudecontext');
    try { await fs.unlink(legacyPath); } catch { /* ignore ENOENT */ }

    return contextPath;
  } catch (error) {
    logger.error(`[StrategosContext] Failed to write rules file: ${error.message}`);
    try { await fs.unlink(tmpPath); } catch { /* ignore */ }
    return null;
  } finally {
    // Restore stashed files after a delay. The 5s window ensures Claude Code
    // reads rules/ and only finds the new worker's file at session start.
    if (stashedFiles.length > 0) {
      setTimeout(async () => {
        for (const { src, dst, file } of stashedFiles) {
          try {
            await fs.rename(dst, src);
            logger.info(`[StrategosContext] Restored stashed ${file}`);
          } catch (restoreErr) {
            logger.warn(`[StrategosContext] Failed to restore ${file}: ${restoreErr.message}`);
          }
        }
      }, 5000);
    }
  }
}

export async function removeStrategosContext(projectPath, excludeWorkerId = null) {
  // Import workers lazily to avoid circular dependency at module load time
  const { workers } = await import('./state.js');

  if (excludeWorkerId) {
    const fileName = `strategos-worker-${excludeWorkerId}.md`;
    const rulesPath = path.join(projectPath, '.claude', 'rules', fileName);
    const stashedPath = path.join(projectPath, '.claude', 'rules', '.stashed', fileName);
    // Remove from both locations — file may be stashed during isolation window
    for (const filePath of [rulesPath, stashedPath]) {
      try {
        await fs.unlink(filePath);
        logger.info(`[StrategosContext] Removed rules file for ${excludeWorkerId} at ${filePath}`);
      } catch (error) {
        if (error.code !== 'ENOENT') {
          logger.error(`[StrategosContext] Failed to remove rules file: ${error.message}`);
        }
      }
    }
    return;
  }

  const otherWorkersOnPath = Array.from(workers.values()).filter(
    w => w.workingDir === projectPath && w.status === 'running'
  );
  if (otherWorkersOnPath.length > 0) {
    return;
  }

  const rulesDir = path.join(projectPath, '.claude', 'rules');
  const stashDir = path.join(rulesDir, '.stashed');
  // Clean both rules/ and .stashed/ directories
  for (const dir of [rulesDir, stashDir]) {
    try {
      const files = await fs.readdir(dir);
      for (const file of files) {
        if (file.startsWith('strategos-worker-') && file.endsWith('.md')) {
          await fs.unlink(path.join(dir, file));
          logger.info(`[StrategosContext] Cleaned up orphaned rules file: ${file} (from ${dir === stashDir ? '.stashed' : 'rules'})`);
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        logger.error(`[StrategosContext] Failed to clean up rules files in ${dir}: ${error.message}`);
      }
    }
  }

  const legacyPath = path.join(projectPath, '.claudecontext');
  try { await fs.unlink(legacyPath); } catch { /* ignore */ }
}

