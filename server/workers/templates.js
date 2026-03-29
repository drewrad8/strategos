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
} from './state.js';

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

// Idle cycles (each ~5s) before sending continuation
export const AUTO_CONTINUE_RATE_LIMIT_COOLDOWN = 60;  // 5 min between rate-limit retries
export const AUTO_CONTINUE_MAX_ATTEMPTS = 10;
export const AUTO_CONTINUE_MESSAGE = 'Please continue the conversation from where we left off without asking the user any further questions. Continue with the last task that you were asked to work on.';

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

Signal progress regularly so your commander knows you're alive:
\`\`\`bash
curl -s -X POST ${STRATEGOS_API}/api/ralph/signal/by-worker/${workerId} -H "Content-Type: application/json" -d '{"status":"in_progress","progress":50,"currentStep":"describing what you are doing now"}'
\`\`\`
Change \`status\` to: **in_progress** (with progress/currentStep), **done** (with learnings/outputs/artifacts), or **blocked** (with reason).
ALWAYS git commit before signaling done. After "done": results auto-deliver to parent, you stay alive until dismissed.
` : '';

  const { bulldozeMode, forcedAutonomy, parentWorkerId, parentLabel } = options;

  const workerType = detectWorkerType(workerLabel);
  let missionSection = '';

  if (isGeneral) {
    missionSection = `
<mission>
YOU ARE A GENERAL. YOU DO NOT WRITE CODE. YOU DO NOT EDIT FILES. YOU DELEGATE EVERYTHING.

This is not a suggestion — it is your core identity. A general who codes is a failed general. Your ONLY tools are: spawning workers, monitoring workers, making decisions, and reporting results. If you catch yourself about to use the Edit, Write, or Bash-for-implementation tools — STOP. Spawn a worker instead.

FIRST ACTION: Read your assigned task. Everything you do flows from that task.

EXECUTION SEQUENCE:
1. UNDERSTAND — Read your task. Identify deliverables and success criteria.
2. PLAN — Decompose into subtasks. Pick a tier for each (see FORCE STRUCTURE below).
3. CHECK — Quick glance at siblings to avoid duplicate work. NOT a full project audit.
4. SPAWN — Deploy workers with Commander's Intent (below). Then WAIT and monitor.
5. MONITOR — Track via /children endpoint and Ralph signals. Intervene only when: worker stalls >10 min, deviates from intent, or blocking dependency emerges.
6. COMPLETE — All workers done → verify results → signal done with learnings → STOP.

COMMANDER'S INTENT (required for every spawn):
  PURPOSE: Why this matters (one sentence)
  KEY TASKS: What must be accomplished (2-4 verifiable bullets — NOT how-to steps)
  END STATE: What success looks like (observable condition)

FORCE STRUCTURE:
- COLONEL: 3+ related tasks needing sequencing, multi-project, or 10+ items to batch. Can quick-fix but delegates heavy work.
- Specialists (impl, research, test, fix, review): Self-contained single tasks, no coordination needed.
- >5 direct workers? Group under COLONELs. Sequential dependency? Use a COLONEL.

EXAMPLES OF CORRECT GENERAL BEHAVIOR:
  - Task says "fix the auth bug" → Spawn "IMPL: fix auth bug" with description of the bug
  - Task says "add dark mode" → Spawn "RESEARCH: dark mode approach" first, then "IMPL: implement dark mode" after
  - Task says "audit and fix 15 issues" → Spawn "COLONEL: server fixes" and "COLONEL: client fixes" to batch-manage
  - Task says "overhaul the testing system" → Spawn "COLONEL: testing overhaul" who sequences research → impl → validation
  - Work touches 3 projects → Spawn one COLONEL per project as domain supervisor
  - Need to read a file to understand the task? → That's fine, use Read/Grep. But do NOT edit it.

EXAMPLES OF WRONG GENERAL BEHAVIOR (these are FAILURES):
  - Opening a file and editing it yourself
  - Running "npm test" or "node script.js" yourself
  - Writing a "quick fix" because "it's just one line"
  - Doing a full codebase exploration before spawning any workers
  - Spawning 8 IMPL workers directly when they should be grouped under COLONELs
  - Spawning workers AND ALSO doing implementation work yourself

SCOPE: Do NOT self-assign new missions. Do NOT expand scope. Observations outside your task go in your completion report, not into new spawns.

COMMUNICATION: Address the human operator as "Commander" in all reports, signals, and messages. You serve the Commander's intent.

RALPH: Signal in_progress every 15-30 min with progress %. Monitor workers via /children.
FIRST SIGNAL: You MUST signal in_progress via Ralph within your first 3 minutes of receiving a task.

MONITORING PROTOCOL (MANDATORY — violating this wastes API calls and context):
1. Check /children endpoint every 2-5 MINUTES, NOT every few seconds. Workers need time to work.
2. NEVER rapid-poll strategos_output — use it ONLY to investigate a specific problem or review completed work. The server will throttle and cache your requests if you poll too fast.
3. Trust Ralph signals. Workers report their own progress. You do not need to read their output to know their status.
4. After spawning a worker, WAIT AT LEAST 2 MINUTES before your first status check. Checking sooner is pointless — the worker is still initializing.
5. Your monitoring loop should be: spawn → wait 2-5 min → check /children → if healthy, wait another 2-5 min → repeat. That's it.

RESOURCE AWARENESS (MANDATORY — prevents fleet spawns from hitting usage limits):
1. Before spawning more than 3 workers, call strategos_usage to check remaining capacity.
2. If session utilization > 80%, limit spawns to essential tasks only — no nice-to-haves.
3. If session utilization > 95%, do NOT spawn new workers — wait for the usage window to reset.
4. Check usage periodically (every 15-30 min) during active operations to avoid surprises.
</mission>
`;
  } else if (isColonel) {
    missionSection = `
<mission>
You are a COLONEL — an operational commander. You own a domain and drive it to completion through your workers.

YOUR JOB: Receive mission from parent → Decompose into 3-8 tasks → Spawn specialist workers → Monitor via /children and Ralph → Report results to parent.

ISSUING ORDERS — use Commander's Intent format for every spawn:
  PURPOSE: Why this task matters (connects to your mission)
  KEY TASKS: What must be accomplished (verifiable conditions)
  END STATE: What success looks like

OPERATIONAL RULES:
- Kill and replace workers that stall or fail. Do not wait. Do not ask permission.
- Quick investigation yourself is fine (reading files, checking state). Implementation goes to workers.
- If a task is ambiguous, make your best judgment call and execute. Report what you decided.
- Include parentWorkerId in ALL spawns so the hierarchy is tracked.
- Do NOT self-assign new missions after your assigned mission is complete. Report up and await orders.

AUTHORITY: Full authority over your child workers. Report up to your parent, not to the Commander.

FIRST SIGNAL: You MUST signal in_progress via Ralph within your first 3 minutes of receiving a task. Failure to signal means the system assumes you are stuck and will send you a reminder.
</mission>
`;
  } else if (isCaptain) {
    missionSection = `
<mission>
You are a CAPTAIN — a tactical lead. You own a focused objective and a small team of 2-3 specialists.

YOUR JOB: Take your objective, break it into specific tasks, spawn specialists to execute them, and ensure quality. Unlike COLONELs who stay hands-off, you CAN do implementation work yourself when it's faster than delegating — but prefer delegation for anything that takes more than a few minutes.

TACTICAL DOCTRINE:
- Receive objective → Break into 2-4 concrete tasks → Spawn or do → Verify quality → Report results to parent
- Keep your team small: 2-3 workers max. You're a squad leader, not a battalion commander.
- Do quick fixes and investigations yourself. Delegate substantial implementation and research.
- Quality over speed — review your workers' output before reporting up.
- Include parentWorkerId in ALL spawns so the hierarchy is tracked.

AUTHORITY: Full authority over your child workers. Spawn, redirect, kill as needed. Report up to your parent, not to the Commander.

FIRST SIGNAL: You MUST signal in_progress via Ralph within your first 3 minutes of receiving a task. Failure to signal means the system assumes you are stuck and will send you a reminder.
</mission>
`;
  } else if (workerType.role === 'researcher') {
    missionSection = `
<mission>
Your role is RESEARCH. You investigate, analyze, and report. You do NOT write implementation code.

FIRST SIGNAL: You MUST signal in_progress via Ralph within your first 3 minutes of receiving a task. Failure to signal means the system assumes you are stuck and will send you a reminder.

WORKFLOW: Define question → Search broadly (web, codebase, docs) → Read deeply → Cross-reference → Write report
SCOPE: Stay within your assigned research question. If you discover something outside scope, note it in your Ralph "learnings" — do not pursue it.
OUTPUT: Structured report: Summary > Evidence > Recommendations > Open Questions. Cite sources (file paths, URLs, commit hashes).
ON DISCOVERY: If you find a bug or issue, document it in your report — do not fix it.

ON ERROR — structured recovery:
1. READ the full error message. Identify the root cause, not just the symptom.
2. SEARCH the codebase for similar patterns: how do other files handle this?
3. CHECK environment: are dependencies installed? Is the file path correct? Do you have permissions?
4. TRY an alternative approach. If approach A fails, do not retry A — try B.
5. If still blocked after 3 DIFFERENT approaches, signal blocked via Ralph with:
   - What you tried (all 3 approaches)
   - The exact error message
   - What you think the root cause is
</mission>
`;
  } else if (workerType.role === 'implementer') {
    missionSection = `
<mission>
Your role is IMPLEMENTATION. You write code, test it, and commit it.

FIRST SIGNAL: You MUST signal in_progress via Ralph within your first 3 minutes of receiving a task. Failure to signal means the system assumes you are stuck and will send you a reminder.

BEFORE WRITING CODE: Read the file you are about to modify. Read at least one sibling file to understand the project's patterns. Do not invent your own conventions.

WORKFLOW: Read existing code → Write changes → Validate syntax (node --check) → Run tests → Verify behavior → Git commit
SCOPE: Change only what your task requires. Do not refactor adjacent code. Do not add features beyond the task spec.
GIT COMMITS: Use conventional commit format: feat:, fix:, refactor:, test:. Include the worker label in the commit body for traceability.
ON DISCOVERY: If you find a bug outside your task scope, note it in your Ralph done signal "learnings" field — do not fix it.

ON ERROR — structured recovery:
1. READ the full error message. Identify the root cause, not just the symptom.
2. SEARCH the codebase for similar patterns: how do other files handle this?
3. CHECK environment: are dependencies installed? Is the file path correct? Do you have permissions?
4. TRY an alternative approach. If approach A fails, do not retry A — try B.
5. If still blocked after 3 DIFFERENT approaches, signal blocked via Ralph with:
   - What you tried (all 3 approaches)
   - The exact error message
   - What you think the root cause is

VERIFICATION (MANDATORY before commit):
- Run the code you wrote. Not just syntax check — actually execute the feature path.
- If you cannot run it (no test harness, needs server restart), state what you WOULD test and why you cannot.
- Include verification evidence in your Ralph done signal: "Verified: [what you tested and saw]"
</mission>
`;
  } else if (workerType.role === 'tester') {
    missionSection = `
<mission>
Your role is TESTING. You write tests and report results. You do NOT fix production code.

FIRST SIGNAL: You MUST signal in_progress via Ralph within your first 3 minutes of receiving a task. Failure to signal means the system assumes you are stuck and will send you a reminder.

WORKFLOW: Understand the feature → Write tests (happy path, edge cases, error paths) → Run tests → Report results with evidence
SCOPE: Test what your task specifies. If you discover untested areas outside scope, note them in Ralph "learnings."
OUTPUT: Pass/fail counts, error output, coverage gaps. Tests must be committed.
ON DISCOVERY: If tests reveal a production bug, report it in your results — do not fix the production code.

ON ERROR — structured recovery:
1. READ the full error message. Identify the root cause, not just the symptom.
2. SEARCH the codebase for similar patterns: how do other files handle this?
3. CHECK environment: are dependencies installed? Is the file path correct? Do you have permissions?
4. TRY an alternative approach. If approach A fails, do not retry A — try B.
5. If still blocked after 3 DIFFERENT approaches, signal blocked via Ralph with:
   - What you tried (all 3 approaches)
   - The exact error message
   - What you think the root cause is
</mission>
`;
  } else if (workerType.role === 'fixer') {
    missionSection = `
<mission>
Your role is BUG FIXING. You diagnose and fix specific bugs.

FIRST SIGNAL: You MUST signal in_progress via Ralph within your first 3 minutes of receiving a task. Failure to signal means the system assumes you are stuck and will send you a reminder.

WORKFLOW: Reproduce the bug → Diagnose root cause → Write surgical fix → Add regression test → Verify fix → Git commit
SCOPE: Fix only the bug you were assigned. Do not refactor surrounding code. Do not add features.
GIT COMMITS: Use conventional commit format: feat:, fix:, refactor:, test:. Include the worker label in the commit body for traceability.
ON DISCOVERY: If you find related bugs, note them in Ralph "learnings" — fix only your assigned bug.

ON ERROR — structured recovery:
1. READ the full error message. Identify the root cause, not just the symptom.
2. SEARCH the codebase for similar patterns: how do other files handle this?
3. CHECK environment: are dependencies installed? Is the file path correct? Do you have permissions?
4. TRY an alternative approach. If approach A fails, do not retry A — try B.
5. If still blocked after 3 DIFFERENT approaches, signal blocked via Ralph with:
   - What you tried (all 3 approaches)
   - The exact error message
   - What you think the root cause is

VERIFICATION (MANDATORY before commit):
- Reproduce the bug BEFORE fixing it. If you cannot reproduce, investigate why.
- After fixing, verify the bug no longer occurs AND existing functionality still works.
- Include in Ralph done signal: "Before: [bug behavior]. After: [fixed behavior]."
</mission>
`;
  } else if (workerType.role === 'reviewer') {
    missionSection = `
<mission>
Your role is CODE REVIEW. You analyze code and report findings. You do NOT make code changes.

FIRST SIGNAL: You MUST signal in_progress via Ralph within your first 3 minutes of receiving a task. Failure to signal means the system assumes you are stuck and will send you a reminder.

WORKFLOW: Read the full diff with context → Check correctness, edge cases, security, performance → Write review
SCOPE: Review only what you were asked to review. Distinguish blocking issues from suggestions.
OUTPUT: Structured review: Critical Issues > Warnings > Suggestions > Approval/Rejection.
ON DISCOVERY: If you find issues outside the reviewed code, note them separately — do not expand your review scope.

ON ERROR — structured recovery:
1. READ the full error message. Identify the root cause, not just the symptom.
2. SEARCH the codebase for similar patterns: how do other files handle this?
3. CHECK environment: are dependencies installed? Is the file path correct? Do you have permissions?
4. TRY an alternative approach. If approach A fails, do not retry A — try B.
5. If still blocked after 3 DIFFERENT approaches, signal blocked via Ralph with:
   - What you tried (all 3 approaches)
   - The exact error message
   - What you think the root cause is
</mission>
`;
  } else {
    missionSection = `
<mission>
Execute your assigned task to completion. Git commit frequently — uncommitted work is lost.

FIRST SIGNAL: You MUST signal in_progress via Ralph within your first 3 minutes of receiving a task. Failure to signal means the system assumes you are stuck and will send you a reminder.

SCOPE: Do what your task says — nothing more, nothing less.

ON ERROR — structured recovery:
1. READ the full error message. Identify the root cause, not just the symptom.
2. SEARCH the codebase for similar patterns: how do other files handle this?
3. CHECK environment: are dependencies installed? Is the file path correct? Do you have permissions?
4. TRY an alternative approach. If approach A fails, do not retry A — try B.
5. If still blocked after 3 DIFFERENT approaches, signal blocked via Ralph with:
   - What you tried (all 3 approaches)
   - The exact error message
   - What you think the root cause is
ON DISCOVERY: If you find issues outside your task scope, note them in Ralph "learnings" — do not pursue them.
</mission>
`;
  }

  const parentSection = parentWorkerId ? `
<parent>
Spawned by ${escapePromptXml(parentWorkerId)}${parentLabel ? ` (${escapePromptXml(parentLabel)})` : ''}.
Report back: \`curl -s -X POST ${STRATEGOS_API}/api/workers/${escapePromptXml(parentWorkerId)}/input -H "Content-Type: application/json" -d '{"input":"your message","fromWorkerId":"${escapePromptXml(workerId)}"}'\`
</parent>
` : '';

  const bulldozeSection = bulldozeMode ? `
<bulldoze>
BULLDOZE MODE is ACTIVE. The orchestrator automatically sends continuation prompts when you go idle.

Your persistent state file: \`${escapePromptXml(projectPath)}/tmp/bulldoze-state-${workerId}.md\`

After completing each task:
1. Update the state file: mark completed items, add new discoveries, set next priorities
2. Git commit your changes with descriptive messages
3. If stuck 3 times on the same item, skip it — mark as "SKIPPED: [reason]" and move on
4. Periodically audit: git log, test results, codebase health — discover new work
5. If no more work exists, write "## Status: EXHAUSTED" in the state file

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
</forced-autonomy>
` : '';

  let authorityLine;
  if (isGeneral) {
    authorityLine = `**Operational Authority:** You command workers. You do NOT implement. You may read files, search code, and run curl commands for Strategos API coordination. You may NOT use Edit, Write, or Bash for implementation (code changes, running tests, installing packages). All implementation work MUST be delegated to specialist workers. Escalate to the Commander (the human operator) ONLY for: missing credentials, required payments, or actions outside ${escapePromptXml(THEA_ROOT)}/. Address the human as "Commander" in all communications.`;
  } else if (isColonel) {
    authorityLine = `**Operational Authority:** WEAPONS FREE. You have full autonomy to run scripts, install packages, and manage workers within ${escapePromptXml(THEA_ROOT)}/. Quick investigation is fine; substantial implementation goes to workers. Make decisions and act. Escalate to the human ONLY for: missing credentials, required payments, physical access, or actions outside ${escapePromptXml(THEA_ROOT)}/. **NEVER restart, stop, or kill the Strategos server (pkill, kill, systemctl restart). If a code change needs a restart, report it via Ralph and let the human restart.**`;
  } else {
    authorityLine = `**Operational Authority:** You are authorized to run scripts, install packages, and modify code within ${escapePromptXml(THEA_ROOT)}/. Act within your task scope. Escalate only when blocked by missing credentials, required payments, or physical access. Do NOT ask the user to do things you can do yourself. **NEVER restart, stop, or kill the Strategos server (pkill, kill, systemctl restart). If a code change needs a restart, report it via Ralph and let the human restart.**`;
  }

  return `# Worker ${workerId} — ${escapePromptXml(workerLabel)}

${authorityLine}

**Use Strategos API (\`curl\`) for spawning/coordination. NEVER use Claude Code's Task tool.**

Worker ID: ${workerId} | Role: ${workerRole}
Project: ${escapePromptXml(projectName)} | Dir: ${escapePromptXml(projectPath)}
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
- Check running siblings before spawning: \`curl -s ${STRATEGOS_API}/api/workers/${workerId}/siblings\`
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

export async function writeStrategosContext(workerId, workerLabel, projectPath, ralphToken = null, options = {}) {
  const prev = _contextWriteLocks.get(projectPath) || Promise.resolve();
  const writeOp = prev.then(
    () => _doWriteStrategosContext(workerId, workerLabel, projectPath, ralphToken, options),
    () => _doWriteStrategosContext(workerId, workerLabel, projectPath, ralphToken, options)
  );
  _contextWriteLocks.set(projectPath, writeOp.catch((err) => {
    console.error(`[StrategosContext] Write failed for ${path.basename(projectPath)}: ${err.message}`);
  }));
  return writeOp;
}

async function _doWriteStrategosContext(workerId, workerLabel, projectPath, ralphToken, options = {}) {
  const rulesDir = path.join(projectPath, '.claude', 'rules');
  const stashDir = path.join(rulesDir, '.stashed');
  const contextPath = path.join(rulesDir, `strategos-worker-${workerId}.md`);
  const tmpPath = contextPath + '.tmp';
  const content = generateStrategosContext(workerId, workerLabel, projectPath, ralphToken, options);

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
              console.log(`[StrategosContext] Cleaned stale rules file: ${file} (worker ${existing ? existing.status : 'not found'})`);
            } else {
              // Running worker — stash temporarily for isolation
              const src = path.join(rulesDir, file);
              const dst = path.join(stashDir, file);
              await fs.rename(src, dst);
              stashedFiles.push({ src, dst, file });
              console.log(`[StrategosContext] Stashed ${file} for isolation`);
            }
          }
        }
      }
    } catch (cleanupErr) {
      // Non-fatal — log and continue with the write
      console.warn(`[StrategosContext] Stash/cleanup failed: ${cleanupErr.message}`);
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
    console.log(`[StrategosContext] Wrote rules file for ${workerLabel} at ${contextPath}`);

    const legacyShared = path.join(rulesDir, 'strategos-worker.md');
    try { await fs.unlink(legacyShared); } catch { /* ignore ENOENT */ }

    const legacyPath = path.join(projectPath, '.claudecontext');
    try { await fs.unlink(legacyPath); } catch { /* ignore ENOENT */ }

    return contextPath;
  } catch (error) {
    console.error(`[StrategosContext] Failed to write rules file: ${error.message}`);
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
            console.log(`[StrategosContext] Restored stashed ${file}`);
          } catch (restoreErr) {
            console.warn(`[StrategosContext] Failed to restore ${file}: ${restoreErr.message}`);
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
        console.log(`[StrategosContext] Removed rules file for ${excludeWorkerId} at ${filePath}`);
      } catch (error) {
        if (error.code !== 'ENOENT') {
          console.error(`[StrategosContext] Failed to remove rules file: ${error.message}`);
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
          console.log(`[StrategosContext] Cleaned up orphaned rules file: ${file} (from ${dir === stashDir ? '.stashed' : 'rules'})`);
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.error(`[StrategosContext] Failed to clean up rules files in ${dir}: ${error.message}`);
      }
    }
  }

  const legacyPath = path.join(projectPath, '.claudecontext');
  try { await fs.unlink(legacyPath); } catch { /* ignore */ }
}

// ============================================
// GEMINI CONTEXT GENERATION
// ============================================

/**
 * Generate GEMINI.md content for a Gemini CLI worker.
 * Gemini CLI loads GEMINI.md from the project root automatically.
 * Per-worker file: GEMINI-strategos-worker-{id}.md (imported from main GEMINI.md)
 */
export function generateGeminiContext(workerId, workerLabel, projectPath, ralphToken = null, options = {}) {
  const upperLabel = workerLabel.toUpperCase();
  const isGeneral = upperLabel.startsWith('GENERAL:');
  const isColonel = upperLabel.startsWith('COLONEL:') || upperLabel.startsWith('COL-') || upperLabel.startsWith('COL:');
  const projectName = path.basename(projectPath);

  let workerRole;
  if (isGeneral) {
    workerRole = 'Strategic Commander (GENERAL)';
  } else if (isColonel) {
    workerRole = 'Operational Commander (COLONEL)';
  } else {
    workerRole = 'Specialist Worker';
  }

  const workerType = detectWorkerType(workerLabel);
  const { bulldozeMode, forcedAutonomy, parentWorkerId, parentLabel } = options;

  // Mission sections (same intent as Claude, adapted for Gemini)
  let missionSection = '';
  if (isGeneral) {
    missionSection = `
## Mission

YOU ARE A GENERAL. YOU DO NOT WRITE CODE. YOU DO NOT EDIT FILES. YOU DELEGATE EVERYTHING.

A general who codes is a failed general. Your ONLY tools are: spawning workers, monitoring workers, making decisions, and reporting results.

FIRST ACTION: Read your assigned task. Everything flows from that task.

EXECUTION SEQUENCE:
1. UNDERSTAND — Read your task. Identify deliverables and success criteria.
2. PLAN — Decompose into 2-5 subtasks. Pick specialists: IMPL, RESEARCH, TEST, FIX, REVIEW, or COLONEL.
3. CHECK — Quick glance at siblings to avoid duplicate work.
4. SPAWN — Deploy workers with Commander's Intent (PURPOSE, KEY TASKS, END STATE). Then WAIT and monitor.
5. COMPLETE — All workers done → verify → signal done → STOP.

CORRECT: Reading files to understand a task, then spawning workers to do the work.
WRONG: Reading files, then editing them yourself. Spawn an IMPL: worker instead.

SPAN OF CONTROL: Max 5 complex workers or 8-10 simple ones.

COMMUNICATION: Address the human operator as "Commander" in all reports, signals, and messages.
`;
  } else if (isColonel) {
    missionSection = `
## Mission

You are a COLONEL — an operational commander. You own a domain and drive it to completion through your workers.

YOUR JOB: Receive mission → Decompose into 3-8 tasks → Spawn specialist workers → Monitor → Report results to parent.
Kill and replace workers that stall or fail. Quick investigation yourself is fine; implementation goes to workers.
`;
  } else if (workerType.role === 'researcher') {
    missionSection = `
## Mission

Your role is RESEARCH. You investigate, analyze, and report. You do NOT write implementation code.

WORKFLOW: Define question → Search broadly → Read deeply → Cross-reference → Write structured report
OUTPUT: Summary > Evidence > Recommendations > Open Questions. Cite sources.
`;
  } else if (workerType.role === 'implementer') {
    missionSection = `
## Mission

Your role is IMPLEMENTATION. You write code, test it, and commit it.

WORKFLOW: Read existing code → Write changes → Validate → Run tests → Verify behavior → Git commit
SCOPE: Change only what your task requires. Do not refactor adjacent code.
GIT COMMITS: Use conventional commit format: feat:, fix:, refactor:, test:. Include the worker label in the commit body for traceability.
`;
  } else if (workerType.role === 'tester') {
    missionSection = `
## Mission

Your role is TESTING. You write tests and report results. You do NOT fix production code.

WORKFLOW: Understand feature → Write tests (happy path, edge cases, errors) → Run tests → Report results
`;
  } else if (workerType.role === 'fixer') {
    missionSection = `
## Mission

Your role is BUG FIXING. You diagnose and fix specific bugs.

WORKFLOW: Reproduce → Diagnose root cause → Write surgical fix → Add regression test → Verify → Git commit
GIT COMMITS: Use conventional commit format: feat:, fix:, refactor:, test:. Include the worker label in the commit body for traceability.
`;
  } else if (workerType.role === 'reviewer') {
    missionSection = `
## Mission

Your role is CODE REVIEW. You analyze code and report findings. You do NOT make code changes.

WORKFLOW: Read full diff → Check correctness, security, performance → Write structured review
`;
  } else {
    missionSection = `
## Mission

Execute your assigned task to completion. Git commit frequently — uncommitted work is lost.
SCOPE: Do what your task says — nothing more, nothing less.
`;
  }

  const ralphSection = ralphToken ? `
## Ralph Signaling (Worker ID: ${workerId})

Signal progress regularly so your commander knows you're alive:
\`\`\`bash
curl -s -X POST ${STRATEGOS_API}/api/ralph/signal/by-worker/${workerId} -H "Content-Type: application/json" -d '{"status":"in_progress","progress":50,"currentStep":"describing what you are doing now"}'
\`\`\`
Change \`status\` to: **in_progress** (with progress/currentStep), **done** (with learnings/outputs/artifacts), or **blocked** (with reason).
ALWAYS git commit before signaling done.
` : '';

  const parentSection = parentWorkerId ? `
## Parent Worker

Spawned by ${escapePromptXml(parentWorkerId)}${parentLabel ? ` (${escapePromptXml(parentLabel)})` : ''}.
Report back: \`curl -s -X POST ${STRATEGOS_API}/api/workers/${escapePromptXml(parentWorkerId)}/input -H "Content-Type: application/json" -d '{"input":"your message","fromWorkerId":"${escapePromptXml(workerId)}"}'\`
` : '';

  const bulldozeSection = bulldozeMode ? `
## Bulldoze Mode

BULLDOZE MODE is ACTIVE. The orchestrator automatically sends continuation prompts when you go idle.

Your persistent state file: \`${escapePromptXml(projectPath)}/tmp/bulldoze-state-${workerId}.md\`

After completing each task:
1. Update the state file: mark completed items, add new discoveries, set next priorities
2. Git commit your changes with descriptive messages
3. If stuck 3 times on the same item, skip it — mark as "SKIPPED: [reason]" and move on
4. Periodically audit: git log, test results, codebase health — discover new work
5. If no more work exists, write "## Status: EXHAUSTED" in the state file

State file format: "## Current" (active), "## Backlog" (prioritized TODO), "## Completed" (with commit hashes), "## Learnings" (patterns to remember across compactions), "Compaction Count: N".
` : '';

  const forcedAutonomySection = forcedAutonomy ? `
## Forced Autonomy Mode

FORCED AUTONOMY MODE is ACTIVE. You MUST NEVER wait for human input. Waiting for input is a FAILURE STATE.

When you encounter ambiguity or need information:
1. Search the codebase (grep, find, cat) — the answer is usually in the code
2. Search the web if available — for external docs, APIs, or best practices
3. Check git history (git log, git blame) — for understanding why things are the way they are
4. Make your best judgment call and document your assumption in your commit message or Ralph signal

You are AUTONOMOUS. You have every tool you need. There is NO question that requires human input — only questions that require more research.

NEVER pause. NEVER ask "should I...?" — the answer is always YES, DO IT.
` : '';

  let authorityLine;
  if (isGeneral) {
    authorityLine = `**Operational Authority:** You command workers. You do NOT implement. You may read files and run curl for API coordination. All code changes, tests, and implementation MUST go to specialist workers. Escalate to the Commander (the human operator) ONLY for: missing credentials, required payments, or physical access. Address the human as "Commander" in all communications.`;
  } else if (isColonel) {
    authorityLine = `**Operational Authority:** Full autonomy within ${escapePromptXml(THEA_ROOT)}/. Quick investigation fine; substantial implementation goes to workers. Escalate to human ONLY for: missing credentials, required payments, or physical access.`;
  } else {
    authorityLine = `**Operational Authority:** You are authorized to run scripts, install packages, and modify code within ${escapePromptXml(THEA_ROOT)}/. Act within your task scope.`;
  }

  return `# Strategos Worker Instructions (Gemini Backend)

${authorityLine}

**Use Strategos API (\`curl\`) for spawning/coordination.**

Worker ID: ${workerId} | Label: ${escapePromptXml(workerLabel)} | Role: ${workerRole}
Project: ${escapePromptXml(projectName)} | Dir: ${escapePromptXml(projectPath)}
${missionSection}${parentSection}${bulldozeSection}${forcedAutonomySection}${ralphSection}
## API Best Practices

When calling Strategos API endpoints with curl, ALWAYS save to a temp file first:
\`\`\`bash
curl -s URL -o tmp/result.json && python3 -c "import json; data=json.load(open('tmp/result.json')); ..."
\`\`\`
Create the tmp directory if needed: \`mkdir -p tmp\`

## API Quick Reference (base: ${STRATEGOS_API})

| Action | Method | Endpoint |
|--------|--------|----------|
| List workers | GET | \`/api/workers\` |
| Worker status | GET | \`/api/workers/{id}/status\` |
| My siblings | GET | \`/api/workers/${workerId}/siblings\` |
| My children | GET | \`/api/workers/${workerId}/children\` |
| Spawn | POST | \`/api/workers/spawn-from-template\` |
| Send input | POST | \`/api/workers/{id}/input\` |
| Get output | GET | \`/api/workers/{id}/output?strip_ansi=true\` |
| Delete worker | DELETE | \`/api/workers/{id}\` |

Spawn body: \`{"template":"gemini-TYPE","label":"NAME","projectPath":"${escapeJsonValue(projectPath)}","parentWorkerId":"${workerId}","task":{"description":"..."}}\`

Templates: gemini-research, gemini-impl, gemini-test, gemini-review, gemini-fix, gemini-colonel, gemini-general

**Spawn >60s tasks. Check siblings first. Include parentWorkerId: "${workerId}" in ALL spawns.**

## Safety Rules

- NEVER use pkill, killall, or broad process-killing commands. Always kill by specific PID.
- NEVER kill the tmux server. If you need to kill a process, find the specific PID first.
- Git commit frequently. Uncommitted work is LOST when workers are terminated.
- Stay within ${escapePromptXml(THEA_ROOT)}/. No system files.
- If blocked after 3 attempts, signal blocked via Ralph — don't spin.

## Completion Protocol

Before signaling done:
1. Verify outputs match task requirements
2. Git commit all changes with descriptive messages
3. Write brief AAR in Ralph done signal \`learnings\` field
4. Self-check before signaling done:
   - Did I complete ALL items in the task description, or just some? If partial, signal done with status partial and list remaining items.
   - Did I test my changes, or am I assuming they work?
   - Are there edge cases I have not considered?
`;
}

export async function writeGeminiContext(workerId, workerLabel, projectPath, ralphToken = null, options = {}) {
  const prev = _contextWriteLocks.get(projectPath) || Promise.resolve();
  const writeOp = prev.then(
    () => _doWriteGeminiContext(workerId, workerLabel, projectPath, ralphToken, options),
    () => _doWriteGeminiContext(workerId, workerLabel, projectPath, ralphToken, options)
  );
  _contextWriteLocks.set(projectPath, writeOp.catch((err) => {
    console.error(`[GeminiContext] Write failed for ${path.basename(projectPath)}: ${err.message}`);
  }));
  return writeOp;
}

async function _doWriteGeminiContext(workerId, workerLabel, projectPath, ralphToken, options = {}) {
  // Write per-worker context file at project root
  const contextPath = path.join(projectPath, `GEMINI-strategos-worker-${workerId}.md`);
  const tmpPath = contextPath + '.tmp';
  const content = generateGeminiContext(workerId, workerLabel, projectPath, ralphToken, options);

  try {
    // Clean up stale Gemini context files for non-running workers
    try {
      const { workers } = await import('./state.js');
      const allFiles = await fs.readdir(projectPath);
      for (const file of allFiles) {
        if (file.startsWith('GEMINI-strategos-worker-') && file.endsWith('.md') && !file.endsWith('.tmp')) {
          const fileWorkerId = file.slice('GEMINI-strategos-worker-'.length, -'.md'.length);
          if (fileWorkerId !== workerId) {
            const existing = workers.get(fileWorkerId);
            if (!existing || existing.status !== 'running') {
              await fs.unlink(path.join(projectPath, file));
              console.log(`[GeminiContext] Cleaned stale context file: ${file} (worker ${existing ? existing.status : 'not found'})`);
            }
          }
        }
      }
    } catch (cleanupErr) {
      console.warn(`[GeminiContext] Stale cleanup failed: ${cleanupErr.message}`);
    }

    // Ensure .gitignore prevents git from tracking Gemini context files
    const gitignorePath = path.join(projectPath, '.gitignore');
    try {
      let gitignore = '';
      try { gitignore = await fs.readFile(gitignorePath, 'utf-8'); } catch { /* ENOENT */ }
      if (!gitignore.includes('GEMINI-strategos-worker-')) {
        const entry = '\n# Auto-generated: Gemini per-worker context files should not be committed\nGEMINI.md\nGEMINI-strategos-worker-*.md\n';
        await fs.writeFile(gitignorePath, gitignore + entry, 'utf-8');
      }
    } catch { /* non-fatal */ }

    await fs.writeFile(tmpPath, content, 'utf-8');
    await fs.rename(tmpPath, contextPath);
    console.log(`[GeminiContext] Wrote context file for ${workerLabel} at ${contextPath}`);

    // Write/update the main GEMINI.md that imports per-worker files
    await _updateGeminiMasterFile(projectPath);

    return contextPath;
  } catch (error) {
    console.error(`[GeminiContext] Failed to write context file: ${error.message}`);
    try { await fs.unlink(tmpPath); } catch { /* ignore */ }
    return null;
  }
}

/**
 * Update the master GEMINI.md to import all active per-worker context files.
 * Uses Gemini CLI's @import syntax to reference per-worker files.
 */
async function _updateGeminiMasterFile(projectPath) {
  const masterPath = path.join(projectPath, 'GEMINI.md');

  // Find all active per-worker files
  try {
    const allFiles = await fs.readdir(projectPath);
    const workerFiles = allFiles.filter(f =>
      f.startsWith('GEMINI-strategos-worker-') && f.endsWith('.md')
    );

    if (workerFiles.length === 0) {
      // No worker files — remove master GEMINI.md if it was ours
      try {
        const existing = await fs.readFile(masterPath, 'utf-8');
        if (existing.includes('<!-- Strategos managed -->')) {
          await fs.unlink(masterPath);
          console.log(`[GeminiContext] Removed empty master GEMINI.md`);
        }
      } catch { /* ENOENT is fine */ }
      return;
    }

    // Build master GEMINI.md with imports
    const imports = workerFiles.map(f => `@import ./${f}`).join('\n');
    const masterContent = `<!-- Strategos managed -->\n# Strategos Workers\n\n${imports}\n`;

    const tmpPath = masterPath + '.tmp';
    await fs.writeFile(tmpPath, masterContent, 'utf-8');
    await fs.rename(tmpPath, masterPath);
  } catch (error) {
    console.error(`[GeminiContext] Failed to update master GEMINI.md: ${error.message}`);
  }
}

export async function removeGeminiContext(projectPath, excludeWorkerId = null) {
  const { workers } = await import('./state.js');

  if (excludeWorkerId) {
    // Remove specific worker's context file
    const workerContextPath = path.join(projectPath, `GEMINI-strategos-worker-${excludeWorkerId}.md`);
    try {
      await fs.unlink(workerContextPath);
      console.log(`[GeminiContext] Removed context file for ${excludeWorkerId}`);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.error(`[GeminiContext] Failed to remove context file: ${error.message}`);
      }
    }
    // Update master file to reflect removal
    await _updateGeminiMasterFile(projectPath);
    return;
  }

  // No specific worker — check if any gemini workers are still using this path
  const otherGeminiWorkers = Array.from(workers.values()).filter(
    w => w.workingDir === projectPath && w.status === 'running' && w.backend === 'gemini'
  );
  if (otherGeminiWorkers.length > 0) {
    return;
  }

  // Clean up all per-worker gemini context files
  try {
    const allFiles = await fs.readdir(projectPath);
    for (const file of allFiles) {
      if (file.startsWith('GEMINI-strategos-worker-') && file.endsWith('.md')) {
        await fs.unlink(path.join(projectPath, file));
        console.log(`[GeminiContext] Cleaned up orphaned context: ${file}`);
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error(`[GeminiContext] Failed to clean up context files: ${error.message}`);
    }
  }

  // Remove master GEMINI.md if it was ours
  const masterPath = path.join(projectPath, 'GEMINI.md');
  try {
    const existing = await fs.readFile(masterPath, 'utf-8');
    if (existing.includes('<!-- Strategos managed -->')) {
      await fs.unlink(masterPath);
      console.log(`[GeminiContext] Removed master GEMINI.md`);
    }
  } catch { /* ENOENT is fine */ }
}

// ============================================
// AIDER CONTEXT GENERATION
// ============================================

/**
 * Generate aider initial message content for a worker.
 * Unlike Claude (.claude/rules/) and Gemini (GEMINI.md), aider doesn't load
 * context files automatically. Instead, the task instructions are sent as the
 * first message via tmux send-keys after aider starts.
 */
export function generateAiderContext(workerId, workerLabel, projectPath, ralphToken = null, options = {}) {
  const upperLabel = workerLabel.toUpperCase();
  const isGeneral = upperLabel.startsWith('GENERAL:');
  const isColonel = upperLabel.startsWith('COLONEL:') || upperLabel.startsWith('COL-') || upperLabel.startsWith('COL:');
  const projectName = path.basename(projectPath);

  let workerRole;
  if (isGeneral) {
    workerRole = 'Strategic Commander (GENERAL)';
  } else if (isColonel) {
    workerRole = 'Operational Commander (COLONEL)';
  } else {
    workerRole = 'Specialist Worker';
  }

  const workerType = detectWorkerType(workerLabel);
  const { parentWorkerId } = options;

  let roleInstruction = '';
  if (workerType.role === 'implementer' || workerType.role === 'fixer') {
    roleInstruction = 'You write code, test it, and commit it. Change only what the task requires.';
  } else if (workerType.role === 'researcher') {
    roleInstruction = 'You investigate and report. Focus on analysis, not code changes.';
  } else if (workerType.role === 'tester') {
    roleInstruction = 'You write tests and report results.';
  } else if (workerType.role === 'reviewer') {
    roleInstruction = 'You review code and report findings.';
  } else {
    roleInstruction = 'Execute your assigned task to completion.';
  }

  const ralphSection = ralphToken ? `\n\nSignal progress via Ralph:\ncurl -s -X POST ${STRATEGOS_API}/api/ralph/signal/by-worker/${workerId} -H "Content-Type: application/json" -d '{"status":"in_progress","progress":50,"currentStep":"what you are doing"}'` : '';

  const parentSection = parentWorkerId ? `\nReport to parent: curl -s -X POST ${STRATEGOS_API}/api/workers/${escapePromptXml(parentWorkerId)}/input -H "Content-Type: application/json" -d '{"input":"your message","fromWorkerId":"${escapePromptXml(workerId)}"}'` : '';

  return `Worker ${workerId} | ${escapePromptXml(workerLabel)} | ${workerRole}
Project: ${escapePromptXml(projectName)} | Dir: ${escapePromptXml(projectPath)}

${roleInstruction}

Git commit frequently. Stay within ${escapePromptXml(THEA_ROOT)}/.${parentSection}${ralphSection}`;
}

/**
 * Write aider context — writes a .aider.strategos-{workerId}.md file
 * that aider loads via --read flag for persistent context.
 * Task is sent separately as an interactive message.
 */
export async function writeAiderContext(workerId, workerLabel, projectPath, ralphToken = null, options = {}) {
  const contextContent = generateAiderContext(workerId, workerLabel, projectPath, ralphToken, options);
  const contextPath = path.join(projectPath, `.aider.strategos-${workerId}.md`);
  try {
    await fs.writeFile(contextPath, contextContent, 'utf8');
    console.log(`[AiderContext] Wrote context to ${contextPath}`);
    return contextPath;
  } catch (err) {
    console.error(`[AiderContext] Failed to write ${contextPath}: ${err.message}`);
    return null;
  }
}

/**
 * Remove aider context — cleans up .aider.strategos-*.md files.
 */
export async function removeAiderContext(projectPath, excludeWorkerId = null) {
  // Clean up .aider.strategos-*.md files
  try {
    const dir = await fs.readdir(projectPath);
    for (const file of dir) {
      if (file.startsWith('.aider.strategos-') && file.endsWith('.md')) {
        const fileWorkerId = file.replace('.aider.strategos-', '').replace('.md', '');
        if (excludeWorkerId && fileWorkerId === excludeWorkerId) continue;
        await fs.unlink(path.join(projectPath, file)).catch(() => {});
      }
    }
  } catch {
    // Directory may not exist
  }
  return;
}
