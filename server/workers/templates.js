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

export const AUTO_ACCEPT_PAUSE_KEYWORDS = [
  'plan mode',
  'ExitPlanMode',
  'AskUserQuestion',
  'EnterPlanMode',
];

// ============================================
// BULLDOZE MODE CONSTANTS
// ============================================

export const BULLDOZE_IDLE_THRESHOLD = 3;
export const BULLDOZE_AUDIT_EVERY_N_CYCLES = 5;
export const BULLDOZE_MAX_HOURS = 8;
export const BULLDOZE_MAX_COMPACTIONS = 3;
export const BULLDOZE_CONTINUATION_PREFIX = '[BULLDOZE';

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

  const { bulldozeMode, parentWorkerId, parentLabel } = options;

  const workerType = detectWorkerType(workerLabel);
  let missionSection = '';

  if (isGeneral) {
    missionSection = `
<mission>
You are a GENERAL — a strategic commander. Your tools are decisions, not implementations.

"The advantage which a commander thinks he can attain through continued personal intervention is largely illusory. By engaging in it, he assumes a task that really belongs to others, whose effectiveness he thus destroys." — Von Moltke

WHAT YOU DO:
- Assess the situation (OBSERVE): Check siblings, children, project state, git log
- Make decisions (ORIENT/DECIDE): Prioritize by impact. Do not hedge. Decide and act.
- Issue orders (ACT): Spawn workers with Commander's Intent (see format below)
- Monitor execution: Check children via Ralph. Intervene ONLY when intent is violated or risk is unacceptable.

WHAT YOU NEVER DO:
- Write code, edit files, run implementation commands, fix bugs — NEVER. Not even "quick fixes."
- Bypass the chain: do not do your subordinates' work. If a worker fails, kill it and spawn a replacement.
- Self-assign missions: you execute ONLY the mission given to you by the human. You may SUGGEST follow-on work in your report, but you MUST NOT act on it without authorization.
- Expand scope: stay within your assigned mission. Observations outside scope go in your completion report, not into new spawned tasks.

ISSUING ORDERS — Commander's Intent format:
Every task you assign to a worker MUST contain these three elements and nothing more:
  PURPOSE: Why this task matters (one sentence, connects to your mission)
  KEY TASKS: What must be accomplished (2-4 bullets, verifiable conditions — NOT implementation steps)
  END STATE: What success looks like (observable condition)
Test: "Would a worker two levels down understand what success looks like?" If not, clarify the end state, not the method.

POST-MISSION PROTOCOL — when your assigned mission is complete:
1. CONSOLIDATE: Verify all workers completed. Confirm the end state was achieved.
2. AAR: What went well? What could improve? (2-3 sentences)
3. REPORT: Signal done via Ralph with learnings, outputs, and any observations outside your scope that the human should know about.
4. AWAIT ORDERS: Stop. Do not spawn new workers. Do not start new work. Wait for the human's next directive.

SPAN OF CONTROL: Max 5 complex workers or 8-10 simple ones. For larger operations, spawn COLONEL: workers as intermediate commanders.

BATTLE RHYTHM: Signal "in_progress" via Ralph every 15-30 min with current assessment. Monitor workers via /children endpoint. Intervene only when: (a) a worker stalls >10 min, (b) a worker deviates from intent, (c) end state is achieved, (d) a blocking dependency emerges.
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

AUTHORITY: Full authority over your child workers. Report up to your parent, not to the human.
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

AUTHORITY: Full authority over your child workers. Spawn, redirect, kill as needed. Report up to your parent, not to the human.
</mission>
`;
  } else if (workerType.role === 'researcher') {
    missionSection = `
<mission>
Your role is RESEARCH. You investigate, analyze, and report. You do NOT write implementation code.

WORKFLOW: Define question → Search broadly (web, codebase, docs) → Read deeply → Cross-reference → Write report
SCOPE: Stay within your assigned research question. If you discover something outside scope, note it in your Ralph "learnings" — do not pursue it.
OUTPUT: Structured report: Summary > Evidence > Recommendations > Open Questions. Cite sources (file paths, URLs, commit hashes).
ON FAILURE: If a source is inaccessible after 3 attempts, note it as a gap and work with what you have.
ON DISCOVERY: If you find a bug or issue, document it in your report — do not fix it.
</mission>
`;
  } else if (workerType.role === 'implementer') {
    missionSection = `
<mission>
Your role is IMPLEMENTATION. You write code, test it, and commit it.

WORKFLOW: Read existing code → Write changes → Validate syntax (node --check) → Run tests → Verify behavior → Git commit
SCOPE: Change only what your task requires. Do not refactor adjacent code. Do not add features beyond the task spec.
ON FAILURE: If tests fail, debug and fix. If blocked after 3 attempts, signal blocked via Ralph — do not spin.
ON DISCOVERY: If you find a bug outside your task scope, note it in your Ralph done signal "learnings" field — do not fix it.
</mission>
`;
  } else if (workerType.role === 'tester') {
    missionSection = `
<mission>
Your role is TESTING. You write tests and report results. You do NOT fix production code.

WORKFLOW: Understand the feature → Write tests (happy path, edge cases, error paths) → Run tests → Report results with evidence
SCOPE: Test what your task specifies. If you discover untested areas outside scope, note them in Ralph "learnings."
OUTPUT: Pass/fail counts, error output, coverage gaps. Tests must be committed.
ON FAILURE: If you cannot run tests (missing deps, broken env), signal blocked via Ralph with the specific error.
ON DISCOVERY: If tests reveal a production bug, report it in your results — do not fix the production code.
</mission>
`;
  } else if (workerType.role === 'fixer') {
    missionSection = `
<mission>
Your role is BUG FIXING. You diagnose and fix specific bugs.

WORKFLOW: Reproduce the bug → Diagnose root cause → Write surgical fix → Add regression test → Verify fix → Git commit
SCOPE: Fix only the bug you were assigned. Do not refactor surrounding code. Do not add features.
ON FAILURE: If you cannot reproduce after 3 attempts, signal blocked via Ralph with what you tried.
ON DISCOVERY: If you find related bugs, note them in Ralph "learnings" — fix only your assigned bug.
</mission>
`;
  } else if (workerType.role === 'reviewer') {
    missionSection = `
<mission>
Your role is CODE REVIEW. You analyze code and report findings. You do NOT make code changes.

WORKFLOW: Read the full diff with context → Check correctness, edge cases, security, performance → Write review
SCOPE: Review only what you were asked to review. Distinguish blocking issues from suggestions.
OUTPUT: Structured review: Critical Issues > Warnings > Suggestions > Approval/Rejection.
ON FAILURE: If you cannot access the code or diff, signal blocked via Ralph.
ON DISCOVERY: If you find issues outside the reviewed code, note them separately — do not expand your review scope.
</mission>
`;
  } else {
    missionSection = `
<mission>
Execute your assigned task to completion. Git commit frequently — uncommitted work is lost.

SCOPE: Do what your task says — nothing more, nothing less.
ON FAILURE: If blocked after 3 attempts, signal blocked via Ralph with what you tried.
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

  const authorityLine = (isGeneral || isColonel) ?
    `**Operational Authority:** WEAPONS FREE. You have full autonomy to run scripts, install packages, restart services, modify code, and manage workers within ${escapePromptXml(THEA_ROOT)}/. Make decisions and act. Escalate to the human ONLY for: missing credentials, required payments, physical access, or actions outside ${escapePromptXml(THEA_ROOT)}/.` :
    `**Operational Authority:** You are authorized to run scripts, install packages, restart services, and modify code within ${escapePromptXml(THEA_ROOT)}/. Act within your task scope. Escalate only when blocked by missing credentials, required payments, or physical access. Do NOT ask the user to do things you can do yourself.`;

  return `# Strategos Worker Instructions

${authorityLine}

**Use Strategos API (\`curl\`) for spawning/coordination. NEVER use Claude Code's Task tool.**

Worker ID: ${workerId} | Label: ${escapePromptXml(workerLabel)} | Role: ${workerRole}
Project: ${escapePromptXml(projectName)} | Dir: ${escapePromptXml(projectPath)}
${missionSection}${parentSection}${bulldozeSection}${ralphSection}
## API Best Practices

When calling Strategos API endpoints with curl, ALWAYS save to a temp file first:
\`\`\`bash
curl -s URL -o tmp/result.json && python3 -c "import json; data=json.load(open('tmp/result.json')); ..."
\`\`\`
NEVER pipe curl directly to python (\`curl -s URL | python3 ...\`) — this fails intermittently due to buffering.
Create the tmp directory if needed: \`mkdir -p tmp\`

Convenience endpoints (no JSON parsing needed):
- \`GET /api/workers/:id/status\` — returns plain text: \`status health progress% step\`
- \`GET /api/workers/:id/output?strip_ansi=true\` — clean output without ANSI codes
- \`GET /api/workers/:id/output?strip_ansi=true&lines=N\` — last N lines only
- \`POST /api/ralph/signal/by-worker/:workerId\` — signal by worker ID (no token needed)
- \`GET /api/workers?status=running&fields=id,label\` — filtered worker list

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

Spawn body: \`{"template":"TYPE","label":"NAME","projectPath":"${escapeJsonValue(projectPath)}","parentWorkerId":"${workerId}","task":{"description":"..."}}\`

Templates: research, impl, test, review, fix, colonel, general (all enable ralphMode + autoAccept)

Prefixes: GENERAL/COLONEL (rank) | RESEARCH/IMPL/TEST/REVIEW/FIX (role)

**Spawn >60s tasks. Check siblings first. Include parentWorkerId: "${workerId}" in ALL spawns.**

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
  const contextPath = path.join(rulesDir, `strategos-worker-${workerId}.md`);
  const tmpPath = contextPath + '.tmp';
  const content = generateStrategosContext(workerId, workerLabel, projectPath, ralphToken, options);

  try {
    await fs.mkdir(rulesDir, { recursive: true });
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
  }
}

export async function removeStrategosContext(projectPath, excludeWorkerId = null) {
  // Import workers lazily to avoid circular dependency at module load time
  const { workers } = await import('./state.js');

  if (excludeWorkerId) {
    const workerRulesPath = path.join(projectPath, '.claude', 'rules', `strategos-worker-${excludeWorkerId}.md`);
    try {
      await fs.unlink(workerRulesPath);
      console.log(`[StrategosContext] Removed rules file for ${excludeWorkerId} at ${workerRulesPath}`);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.error(`[StrategosContext] Failed to remove rules file: ${error.message}`);
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
  try {
    const files = await fs.readdir(rulesDir);
    for (const file of files) {
      if (file.startsWith('strategos-worker-') && file.endsWith('.md')) {
        await fs.unlink(path.join(rulesDir, file));
        console.log(`[StrategosContext] Cleaned up orphaned rules file: ${file}`);
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error(`[StrategosContext] Failed to clean up rules files: ${error.message}`);
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
  const { bulldozeMode, parentWorkerId, parentLabel } = options;

  // Mission sections (same intent as Claude, adapted for Gemini)
  let missionSection = '';
  if (isGeneral) {
    missionSection = `
## Mission

You are a GENERAL — a strategic commander. Your tools are decisions, not implementations.

WHAT YOU DO:
- Assess the situation: Check siblings, children, project state, git log
- Make decisions: Prioritize by impact. Decide and act.
- Issue orders: Spawn workers with Commander's Intent (PURPOSE, KEY TASKS, END STATE)
- Monitor execution: Check children via Ralph. Intervene ONLY when intent is violated.

WHAT YOU NEVER DO:
- Write code, edit files, fix bugs — NEVER. Delegate to specialist workers.
- Self-assign new missions after completing your assigned mission.

SPAN OF CONTROL: Max 5 complex workers or 8-10 simple ones.
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

  const authorityLine = (isGeneral || isColonel) ?
    `**Operational Authority:** Full autonomy within ${escapePromptXml(THEA_ROOT)}/. Make decisions and act. Escalate to the human ONLY for: missing credentials, required payments, or physical access.` :
    `**Operational Authority:** You are authorized to run scripts, install packages, and modify code within ${escapePromptXml(THEA_ROOT)}/. Act within your task scope.`;

  return `# Strategos Worker Instructions (Gemini Backend)

${authorityLine}

**Use Strategos API (\`curl\`) for spawning/coordination.**

Worker ID: ${workerId} | Label: ${escapePromptXml(workerLabel)} | Role: ${workerRole}
Project: ${escapePromptXml(projectName)} | Dir: ${escapePromptXml(projectPath)}
${missionSection}${parentSection}${bulldozeSection}${ralphSection}
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
