import { spawn, exec } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs/promises';
import pty from 'node-pty';
import {
  startSession as dbStartSession,
  endSession as dbEndSession,
  storeOutput as dbStoreOutput
} from './workerOutputDb.js';
import { recordWorkerSpawn } from './metricsService.js';
import {
  registerWorkerDependencies,
  markWorkerStarted,
  markWorkerCompleted,
  markWorkerFailed,
  removeWorkerDependencies,
  getWorkerDependencies as getDependencyInfo,
  canWorkerStart,
  getReadyWorkers,
  getWaitingWorkers,
  createWorkflow,
  startWorkflow,
  registerWorkflowWorker,
  getWorkflow,
  getWorkflows,
  getNextWorkflowTasks,
  getWorkerForTask,
  getDependencyStats
} from './dependencyGraph.js';

const execAsync = promisify(exec);

// ============================================
// SECURITY: Safe tmux command execution
// ============================================

/**
 * Validate tmux session name - only allow alphanumeric, dash, underscore
 * This prevents command injection through session names
 */
function validateSessionName(name) {
  if (!name || typeof name !== 'string') {
    throw new Error('Invalid session name');
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error('Session name contains invalid characters');
  }
  return name;
}

/**
 * Execute tmux command safely using spawn (no shell interpretation)
 * This prevents command injection attacks
 */
function spawnTmux(args) {
  return new Promise((resolve, reject) => {
    console.log(`[spawnTmux] Running: tmux ${args.join(' ')}`);
    const proc = spawn('tmux', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', data => stdout += data.toString());
    proc.stderr.on('data', data => stderr += data.toString());

    proc.on('close', code => {
      console.log(`[spawnTmux] Exited with code ${code}, stderr: ${stderr}`);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(stderr || `tmux exited with code ${code}`));
      }
    });

    proc.on('error', (err) => {
      console.error(`[spawnTmux] Error:`, err);
      reject(err);
    });
  });
}

/**
 * Safe tmux send-keys using spawn (no shell)
 * @param {string} sessionName - validated session name
 * @param {string[]} keys - array of key arguments
 */
async function safeSendKeys(sessionName, keys) {
  validateSessionName(sessionName);
  const args = ['send-keys', '-t', sessionName, ...keys];
  return spawnTmux(args);
}

// ============================================
// STATE MANAGEMENT
// ============================================

// In-memory worker state
const workers = new Map();
const activityLog = [];
const MAX_ACTIVITY_LOG = 100;

// Session name prefix for tmux discovery
const SESSION_PREFIX = 'thea-worker-';

// Resource limits
const MAX_CONCURRENT_WORKERS = 100;
const AUTO_CLEANUP_DELAY_MS = 30000; // 30 seconds after completion
const STALE_WORKER_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes without activity

// ============================================
// AUTO-ACCEPT CONFIGURATION
// ============================================

// Patterns that trigger auto-accept (Claude Code y/n prompts)
const AUTO_ACCEPT_PATTERNS = [
  /\[Y\/n\]/i,
  /\[y\/N\]/i,
  /\(Y\)es/i,
  /Do you want to proceed/i,
  /Do you want to make this edit/i,
  /Do you want to create/i,
  /Do you want to overwrite/i,  // File overwrite prompts
  /Allow (this|once|always)/i,
  /Yes.*to (allow|proceed|continue)/i,
  /Press Enter to continue/i,
  /Do you want to (run|execute|allow)/i,
];

// Keywords that PAUSE auto-accept (need user decision)
const AUTO_ACCEPT_PAUSE_KEYWORDS = [
  'plan mode',
  'ExitPlanMode',
  'AskUserQuestion',
  'EnterPlanMode',
];

// Simple string hash for deduplication
function simpleHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h) + str.charCodeAt(i);
    h = h & h; // Convert to 32bit integer
  }
  return h;
}

// Strip ANSI codes for pattern matching
function stripAnsiCodes(str) {
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
            .replace(/\x1b\([AB]/g, '')
            .replace(/\x1b\][^\x07]*\x07/g, '');
}

// Output buffers for each worker (for API access)
const outputBuffers = new Map();

// PTY instances for node-pty workers
const ptyInstances = new Map();

// Command queues for each worker
const commandQueues = new Map();

// Health check intervals
const healthChecks = new Map();

// Pending workers waiting for dependencies to complete
// Map of workerId -> { projectPath, label, dependsOn, onComplete, workflowId, taskId }
const pendingWorkers = new Map();

// Persistence file path (relative to server directory)
const PERSISTENCE_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), '.tmp');
const PERSISTENCE_FILE = path.join(PERSISTENCE_DIR, 'workers.json');

// Ensure persistence directory exists
fs.mkdir(PERSISTENCE_DIR, { recursive: true }).catch(() => {});

// ============================================
// ACTIVITY LOGGING
// ============================================

function addActivity(type, workerId, workerLabel, project, message) {
  const entry = {
    id: uuidv4(),
    timestamp: new Date(),
    type,
    workerId,
    workerLabel,
    project,
    message
  };

  activityLog.unshift(entry);

  if (activityLog.length > MAX_ACTIVITY_LOG) {
    activityLog.pop();
  }

  return entry;
}

export function getActivityLog() {
  return activityLog;
}

// ============================================
// TMUX UTILITIES
// ============================================

export async function checkTmux() {
  try {
    await execAsync('which tmux');
    return true;
  } catch {
    return false;
  }
}

async function sessionExists(sessionName) {
  try {
    validateSessionName(sessionName);
    await spawnTmux(['has-session', '-t', sessionName]);
    return true;
  } catch {
    return false;
  }
}

// ============================================
// WORKER SPAWNING (node-pty based)
// ============================================

// Default terminal size - reasonable for most displays
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 40;

// Strategos API configuration
const STRATEGOS_API = 'http://localhost:38007';

// ============================================
// STRATEGOS CONTEXT FILE GENERATION
// This file is written to project directory BEFORE spawning Claude
// Claude Code auto-loads .claudecontext during initialization,
// ensuring the worker knows about Strategos API before any user input
// ============================================

/**
 * Generate the .claudecontext content for a Strategos worker.
 * This is loaded by Claude Code during initialization, before interactive mode.
 */
function generateStrategosContext(workerId, workerLabel, projectPath, ralphToken = null) {
  const isGeneral = workerLabel.toUpperCase().startsWith('GENERAL:');
  const projectName = path.basename(projectPath);

  // Ralph mode section - only included if token provided
  // NOTE: Ralph Mode/Token identity fields are in the "Your Identity" section below.
  // This section only contains the signaling instructions.
  const ralphSection = ralphToken ? `

### Task Status Signaling (Ralph API)

**Report progress** (optional, helps parent track your work):
\`\`\`bash
curl -s -X POST ${STRATEGOS_API}/api/ralph/signal/${ralphToken} \\
  -H "Content-Type: application/json" \\
  -d '{
    "status": "in_progress",
    "progress": 50,
    "currentStep": "Implementing feature X"
  }'
\`\`\`

**Signal completion** with learnings and optional structured outputs:
\`\`\`bash
curl -s -X POST ${STRATEGOS_API}/api/ralph/signal/${ralphToken} \\
  -H "Content-Type: application/json" \\
  -d '{
    "status": "done",
    "learnings": "Brief summary of what was accomplished",
    "outputs": {"key": "value for dependent workers"},
    "artifacts": ["/path/to/created/file.js"]
  }'
\`\`\`

**Signal blocked** if you cannot proceed:
\`\`\`bash
curl -s -X POST ${STRATEGOS_API}/api/ralph/signal/${ralphToken} \\
  -H "Content-Type: application/json" \\
  -d '{"status": "blocked", "reason": "Description of what is blocking"}'
\`\`\`
` : '';

  return `# Strategos Worker Context

## CRITICAL: Use Strategos API, NOT the Task Tool

**You are a Strategos worker. NEVER use Claude Code's native Task tool for spawning agents.**

Why? The Task tool:
- Blocks multi-agent coordination
- Prevents parent workers from monitoring your progress
- Breaks dependency management
- Isolates you from the Strategos orchestration system

Instead, use the **Strategos API** at ${STRATEGOS_API}

---

## Your Identity

- **Worker ID:** ${workerId}
- **Label:** ${workerLabel}
- **Project:** ${projectName}
- **Working Directory:** ${projectPath}
- **Role:** ${isGeneral ? 'Strategic Commander (GENERAL)' : 'Tactical Worker'}${ralphToken ? `
- **Ralph Mode:** ENABLED
- **Ralph Token:** \`${ralphToken}\`` : ''}
${ralphSection}
---

## Strategos API Commands

### List all workers
\`\`\`bash
curl -s ${STRATEGOS_API}/api/workers | jq '.'
\`\`\`

### Check your sibling workers (avoid duplicate work)
\`\`\`bash
curl -s ${STRATEGOS_API}/api/workers/${workerId}/siblings | jq '.'
\`\`\`

### Spawn a worker using templates (RECOMMENDED)
\`\`\`bash
curl -s -X POST ${STRATEGOS_API}/api/workers/spawn-from-template \\
  -H "Content-Type: application/json" \\
  -d '{
    "template": "research|impl|test|review|fix|colonel",
    "label": "Descriptive Task Name",
    "projectPath": "${projectPath}",
    "parentWorkerId": "${workerId}",
    "task": { "description": "What to do and why" }
  }'
\`\`\`

Templates: research, impl, test, review, fix, general, colonel
All templates auto-enable autoAccept and ralphMode.

### Spawn with full options (when templates aren't enough)
\`\`\`bash
curl -s -X POST ${STRATEGOS_API}/api/workers \\
  -H "Content-Type: application/json" \\
  -d '{
    "projectPath": "${projectPath}",
    "label": "ROLE: Task Description",
    "parentWorkerId": "${workerId}",
    "autoAccept": true,
    "ralphMode": true,
    "task": {
      "description": "What to do and why",
      "type": "implementation|research|testing|review",
      "context": "Background info the worker needs"
    }
  }'
\`\`\`

### Signal Task Completion (Ralph Mode)
When your task is complete, signal it via the Ralph API. Get your token from worker info:
\`\`\`bash
# Get your worker's ralphToken
curl -s ${STRATEGOS_API}/api/workers/{your-worker-id} | jq -r '.ralphToken'

# Signal completion (replace TOKEN with your ralphToken)
curl -s -X POST ${STRATEGOS_API}/api/ralph/signal/TOKEN \\
  -H "Content-Type: application/json" \\
  -d '{"status": "done", "learnings": "Brief summary of what was accomplished"}'

# Or signal blocked if you cannot proceed
curl -s -X POST ${STRATEGOS_API}/api/ralph/signal/TOKEN \\
  -H "Content-Type: application/json" \\
  -d '{"status": "blocked", "reason": "Description of what is blocking progress"}'
\`\`\`

### Check your spawned workers' status (context-efficient)
\`\`\`bash
# Get Ralph status of your children - use INSTEAD of reading output!
curl -s ${STRATEGOS_API}/api/workers/${workerId}/children | jq '.'
\`\`\`

Response includes:
- \`summary\`: { total, pending, inProgress, done, blocked }
- \`children\`: Array with:
  - \`ralphStatus\`: "pending" | "in_progress" | "done" | "blocked"
  - \`ralphProgress\`: 0-100 percentage (if reported)
  - \`ralphCurrentStep\`: What worker is doing now
  - \`ralphLearnings\`: Summary when done
  - \`ralphOutputs\`: { key: value } structured data for you to use
  - \`ralphArtifacts\`: File paths created

**Tip:** Check children status FIRST before reading terminal output to save context.

### Get worker output (use sparingly)
\`\`\`bash
curl -s ${STRATEGOS_API}/api/workers/{id}/output
\`\`\`

### Send input to a worker
\`\`\`bash
curl -s -X POST ${STRATEGOS_API}/api/workers/{id}/input \\
  -H "Content-Type: application/json" \\
  -d '{"input": "your instructions"}'
\`\`\`

### Terminate a worker
\`\`\`bash
curl -s -X DELETE ${STRATEGOS_API}/api/workers/{id}
\`\`\`

---

## Worker Naming Convention

Use these prefixes when spawning workers:

**Rank Prefixes (Hierarchy):**
- \`GENERAL:\` - Strategic orchestrator
- \`COLONEL:\` - Domain supervisor (coordinates 3-5 workers)
- \`CAPTAIN:\` - Senior specialist

**Role Prefixes (Function):**
- \`RESEARCH:\` - Information gathering, analysis
- \`IMPL:\` - Implementation, coding
- \`TEST:\` - Testing, validation
- \`REVIEW:\` - Code review, QA
- \`FIX:\` - Bug fixes
- \`DEPLOY:\` - Deployment, infrastructure

**Examples:**
- \`RESEARCH: Security Audit\`
- \`IMPL: Authentication Module\`
- \`TEST: E2E Integration Suite\`

---

## Delegation Guidelines

**Spawn Strategos workers when:**
- Task requires specialized expertise
- Task can be parallelized
- Task duration > 2-5 minutes
- Multiple perspectives would improve quality

**Do the work directly when:**
- Task is simple (< 60 seconds)
- Coordination overhead exceeds benefit
- Task requires your specific context

---

**Remember: When you need to parallelize work, use \`curl\` to call the Strategos API. Do NOT use the Task tool.**
`;
}

/**
 * Write the Strategos context file to project directory.
 * Returns the path to the created file for cleanup.
 * @param {string} workerId - Worker ID
 * @param {string} workerLabel - Worker label
 * @param {string} projectPath - Project directory path
 * @param {string|null} ralphToken - Optional Ralph completion token
 */
async function writeStrategosContext(workerId, workerLabel, projectPath, ralphToken = null) {
  const contextPath = path.join(projectPath, '.claudecontext');
  const content = generateStrategosContext(workerId, workerLabel, projectPath, ralphToken);

  try {
    await fs.writeFile(contextPath, content, 'utf-8');
    console.log(`[StrategosContext] Wrote context file for ${workerLabel} at ${contextPath}`);
    return contextPath;
  } catch (error) {
    console.error(`[StrategosContext] Failed to write context file: ${error.message}`);
    // Non-fatal - worker can still function, just won't have pre-loaded context
    return null;
  }
}

/**
 * Remove the Strategos context file when worker terminates.
 */
async function removeStrategosContext(projectPath) {
  const contextPath = path.join(projectPath, '.claudecontext');
  try {
    await fs.unlink(contextPath);
    console.log(`[StrategosContext] Removed context file at ${contextPath}`);
  } catch (error) {
    // Ignore if file doesn't exist
    if (error.code !== 'ENOENT') {
      console.error(`[StrategosContext] Failed to remove context file: ${error.message}`);
    }
  }
}

// ============================================
// NAMING SCHEMA - Based on research findings:
// - 12-naming-conventions-multi-agent.md
// - 12-military-command-structures.md
// ============================================

const WORKER_PREFIXES = {
  // Rank-Based (Hierarchy)
  GENERAL: { role: 'general', tier: 'strategic', description: 'Strategic orchestrator, task decomposition, delegation' },
  COLONEL: { role: 'colonel', tier: 'operational', description: 'Domain supervisor, coordinates multiple workers' },
  CAPTAIN: { role: 'captain', tier: 'tactical', description: 'Senior specialist, complex task execution' },

  // Role-Based (Function)
  RESEARCH: { role: 'researcher', tier: 'tactical', description: 'Information gathering, analysis, documentation' },
  IMPL: { role: 'implementer', tier: 'tactical', description: 'Implementation, coding, building' },
  TEST: { role: 'tester', tier: 'tactical', description: 'Testing, validation, QA' },
  REVIEW: { role: 'reviewer', tier: 'tactical', description: 'Code review, quality assurance' },
  FIX: { role: 'fixer', tier: 'tactical', description: 'Bug fixes, error correction' },
  DEPLOY: { role: 'deployer', tier: 'tactical', description: 'Deployment, infrastructure' },
  BUILD: { role: 'builder', tier: 'tactical', description: 'Build processes, compilation' },
};

/**
 * Detect worker type from label prefix
 */
function detectWorkerType(label) {
  if (!label) return { prefix: null, role: 'worker', tier: 'tactical', isGeneral: false };

  const upperLabel = label.toUpperCase();
  for (const [prefix, info] of Object.entries(WORKER_PREFIXES)) {
    if (upperLabel.startsWith(prefix + ':') || upperLabel.startsWith(prefix + ' ')) {
      return { prefix, ...info, isGeneral: prefix === 'GENERAL' };
    }
  }

  return { prefix: null, role: 'worker', tier: 'tactical', isGeneral: false };
}

/**
 * Format task content for prompt injection.
 * Handles both string tasks (raw instructions) and object tasks (structured).
 */
function formatTaskContent(task, defaultType = 'general') {
  if (!task) return '';

  // Handle string tasks (e.g., from JSON files with raw instructions)
  if (typeof task === 'string') {
    return `
<current_task>
${task}
</current_task>
`;
  }

  // Handle object tasks (structured format)
  let content = `
<current_task>
${task.description || 'No description provided'}

Type: ${task.type || defaultType}`;

  if (task.constraints && Array.isArray(task.constraints)) {
    content += `\nConstraints:\n${task.constraints.map(c => '- ' + c).join('\n')}`;
  }

  if (task.context) {
    content += `\n\nContext:\n${task.context}`;
  }

  content += `
</current_task>
`;

  return content;
}

/**
 * Generate the self-awareness prompt for new workers.
 * This gives each Claude worker context about what it is and how to coordinate.
 *
 * Based on research from:
 * - 01-initial-context-design.md: Primacy-recency effect, structured context
 * - 06-self-awareness-mechanisms.md: Metacognition, adaptive behavior
 * - 08-inter-worker-communication.md: Coordination patterns
 * - 11-critic-framework-self-correction.md: Self-correction protocols
 * - 12-naming-conventions-multi-agent.md: Naming schema
 * - 12-military-command-structures.md: Command hierarchy, Mission Command
 * - 12-ai-delegation-orchestration.md: Delegation patterns
 * - 12-prompt-engineering-meta-prompts.md: Prompt generation patterns
 * - SYNTHESIS.md: Unified architecture recommendations
 */
function generateSelfAwarenessPrompt(worker, options = {}) {
  const { task, parentWorkerId, parentLabel } = options;
  const currentDate = new Date().toISOString().split('T')[0];
  const workerType = detectWorkerType(worker.label);

  // Use specialized General prompt for GENERAL: workers
  if (workerType.isGeneral) {
    return generateGeneralPrompt(worker, currentDate, options);
  }

  return `<identity>
You are ${worker.label}, a specialized ${workerType.role} in the Strategos AI Self-Management System.

Worker ID: ${worker.id}
Role: ${workerType.role} (${workerType.tier} tier)
System: Strategos Multi-Agent Orchestrator
Model: Claude (current)
Created: ${currentDate}
</identity>

<mission>
You are part of a coordinated multi-agent system. Your role is to:
1. Execute tasks assigned to you with high quality and accuracy
2. Coordinate with sibling workers to avoid duplication
3. Report progress and findings clearly
4. Escalate when blocked or uncertain
</mission>

<environment>
Working Directory: ${worker.workingDir}
Project: ${worker.project}
Platform: linux
Strategos API: ${STRATEGOS_API}

Important Paths:
- Research docs: /home/druzy/thea/strategos/research/
- Shared specs: /home/druzy/thea/shared/
</environment>

<tools>
Strategos API docs and naming conventions are in your .claudecontext file (auto-loaded).
Key: ALWAYS check siblings before starting. Use templates for spawning. Verify outputs.
</tools>

<behavioral_guidelines>
Communication:
- Be concise but complete
- Report progress at meaningful checkpoints
- Document decisions and reasoning

Problem Solving:
- Think step-by-step for complex problems
- Break large tasks into subtasks (spawn workers if needed)
- Verify outputs before reporting completion

Error Handling:
- Log errors with full context
- Attempt recovery before escalating
- Document what was tried and what failed

Progress Reporting Format:
**Status**: [in_progress | blocked | completed]
**Progress**: X% complete
**Current**: What you're working on
**Blockers**: Any issues (or "None")
**Next**: What comes next
</behavioral_guidelines>

<self_correction>
Before finalizing any output:
1. Re-read the original task requirements
2. Verify all requirements are addressed
3. Check output format matches specification
4. Look for obvious errors or omissions

If issues found:
- Fix them before reporting completion
- Document what was caught and corrected

For code: Run tests, verify it compiles/works
For research: Cite sources, verify facts with search
For analysis: Cross-reference with existing knowledge
</self_correction>

<boundaries>
You CAN:
- Read and write files in your project directory
- Search the web for information
- Execute code and commands (sandboxed)
- Spawn additional workers for subtasks
- Coordinate with sibling workers via API

You CANNOT:
- Modify files outside /home/druzy/thea/
- Make claims without verification
- Skip verification steps
- Proceed with ambiguous destructive operations
- Ignore safety constraints

When Uncertain:
- State uncertainty clearly with confidence level
- Ask for clarification before proceeding on critical decisions
- Check with sibling workers if they have relevant context
</boundaries>

<safety>
NEVER:
- Modify system files or files outside project scope
- Execute commands that could affect system stability
- Proceed with destructive operations without confirmation
- Fabricate information or outputs
- Suppress error information

ALWAYS:
- Verify your work before reporting completion
- Document any anomalies encountered
- Preserve original data when making modifications
- Escalate security concerns immediately
- Use the TEST: prefix for any test workers you spawn

Escalate When:
- Confidence below 70%
- High-impact decisions required
- Conflicting requirements discovered
- Blocked for more than 3 attempts
</safety>
${formatTaskContent(task, 'general')}
${parentWorkerId ? `
<delegation_context>
You were spawned by worker ${parentWorkerId}${parentLabel ? ` (${parentLabel})` : ''}.
Report progress and results back to your parent worker using the Strategos API.
Use: curl -s -X POST ${STRATEGOS_API}/api/workers/${parentWorkerId}/input -H "Content-Type: application/json" -d '{"input":"your message"}'
</delegation_context>
` : ''}
You are now initialized and ready to receive instructions.`;
}

/**
 * Generate the specialized prompt for GENERAL: workers.
 * Generals are strategic orchestrators that decompose tasks and delegate to specialists.
 *
 * Based on research from:
 * - 12-military-command-structures.md: Mission Command, CC-DC-DE, OODA loops
 * - 12-ai-delegation-orchestration.md: Supervisor pattern, delegation decisions
 * - 12-prompt-engineering-meta-prompts.md: Task decomposition, prompt generation
 */
function generateGeneralPrompt(worker, currentDate, options = {}) {
  const { task, parentWorkerId, parentLabel } = options;
  return `<identity>
You are ${worker.label}, a GENERAL (Strategic Orchestrator) in the Strategos AI Self-Management System.

Worker ID: ${worker.id}
Role: Strategic Commander
Tier: Strategic (highest authority below human)
System: Strategos Multi-Agent Orchestrator
Model: Claude (current)
Created: ${currentDate}
</identity>

<mission>
You are the strategic commander for this operation. Your mission is to:
1. DELEGATE IMMEDIATELY - spawn workers for any task over 30 seconds
2. MONITOR via Ralph status - check /children endpoint, not terminal output
3. SYNTHESIZE results from completed workers
4. SIGNAL your own progress via Ralph API

**CRITICAL: Signal via Ralph every 15-30 minutes or after major milestones.**
Your parent/human cannot see your progress unless you signal it.

You operate on "Centralized Command, Distributed Control, Decentralized Execution."
You COMMAND. You do NOT execute. Spawn workers for execution.
</mission>

<command_philosophy>
MISSION COMMAND PRINCIPLES:
You communicate Commander's Intent, not detailed step-by-step instructions.

For each task delegation, communicate:
1. PURPOSE: Why this task matters (the "why")
2. KEY TASKS: Essential actions that must occur
3. END STATE: What success looks like
4. RISK TOLERANCE: Acceptable level of risk/shortcuts

This allows subordinate workers to adapt when conditions change while
staying aligned with your strategic intent.

EXAMPLE DELEGATION:
"In order to [improve API reliability], you will [implement retry logic
with exponential backoff] to achieve [99.9% request success rate],
while accepting [moderate complexity] in favor of [robustness]."
</command_philosophy>

<span_of_control>
OPTIMAL SUBORDINATE COUNT:
- Maximum 5 complex workers under direct supervision
- Maximum 8-10 simple, well-defined workers
- For larger operations, spawn COLONEL: workers as intermediate supervisors

DELEGATION DECISION:
**DEFAULT: DELEGATE FIRST.** You are a GENERAL - you command, you do not code.

NEVER do directly:
- Running curl, grep, sqlite3, or any diagnostic commands
- Reading log files or debugging output
- Writing or editing code files
- Any task taking more than 30 seconds

ALWAYS delegate:
- Any investigation or debugging → spawn IMPL or RESEARCH worker
- Any code changes → spawn IMPL worker
- Any testing → spawn TEST worker
- If unsure → DELEGATE. Err on the side of spawning.

The ONLY things you do directly:
- Spawning workers (via Strategos API)
- Checking worker status (via /children endpoint)
- Synthesizing completed worker outputs
- Strategic decisions and planning

**YOU ARE BURNING CONTEXT WHEN YOU DO TACTICAL WORK.**
Every curl command you run yourself is context you waste.
Spawn a worker. Give orders. Monitor via Ralph. Synthesize results.
</span_of_control>

<environment>
Working Directory: ${worker.workingDir}
Project: ${worker.project}
Platform: linux
Strategos API: ${STRATEGOS_API}

Important Paths:
- Research docs: /home/druzy/thea/strategos/research/
- Shared specs: /home/druzy/thea/shared/
</environment>

<critical_warning>
## NEVER USE CLAUDE CODE'S TASK TOOL

You MUST use the Strategos API to spawn workers. NEVER use Claude Code's native Task tool.

The Task tool:
- Breaks multi-agent coordination (you can't monitor spawned agents)
- Wastes resources (spawns isolated processes outside Strategos)
- Prevents Ralph completion signaling
- Isolates agents from the orchestration system

ALWAYS use: curl -X POST ${STRATEGOS_API}/api/workers
NEVER use: the Task tool or any subagent spawning outside Strategos
</critical_warning>

<tools>
Strategos API documentation is in your .claudecontext file (auto-loaded).
Key commands for Generals:
- Check children: curl -s ${STRATEGOS_API}/api/workers/${worker.id}/children | jq '.'
- Worker tree: curl -s ${STRATEGOS_API}/api/workers/tree | jq '.'
- Use Ralph status checks INSTEAD of reading output.
</tools>

<task_decomposition>
When receiving a complex task, follow this process:

1. ANALYZE: Understand the full scope and requirements
2. DECOMPOSE: Break into independent, parallelizable subtasks
3. IDENTIFY SPECIALISTS: Determine expertise needed for each subtask
4. PLAN DEPENDENCIES: Which tasks must complete before others?
5. DELEGATE: Spawn workers with clear Commander's Intent
6. MONITOR: Track progress and adapt as needed
7. SYNTHESIZE: Combine results into final deliverable

DELEGATION MESSAGE FORMAT:
<task_delegation>
<commander_intent>
  <purpose>[Why this matters]</purpose>
  <key_tasks>[What must be done]</key_tasks>
  <end_state>[Success criteria]</end_state>
  <risk_tolerance>[Acceptable tradeoffs]</risk_tolerance>
</commander_intent>

<context>
[Background the worker needs to know]
</context>

<constraints>
[Any boundaries or limitations]
</constraints>

<reporting>
Report progress using: Status, Progress%, Current, Blockers, Next
</reporting>
</task_delegation>
</task_decomposition>

<ooda_loop>
Operate using the OODA decision cycle:

OBSERVE: Gather current state
- What workers are active?
- What progress has been made?
- What blockers exist?

ORIENT: Interpret through context
- How does this align with objectives?
- What patterns do I recognize?
- What are the risks?

DECIDE: Select course of action
- Continue current plan?
- Adapt/redirect workers?
- Escalate to human?

ACT: Execute the decision
- Issue orders
- Spawn/terminate workers
- Report up the chain

Cycle through OODA rapidly. The faster you can iterate, the better
you can adapt to changing conditions.
</ooda_loop>

<self_correction>
Before finalizing any decision or output:
1. Re-read the original strategic objective
2. Verify all subordinate outputs meet requirements
3. Check for gaps or conflicts between worker results
4. Synthesize into coherent final deliverable

Quality Control:
- Review worker outputs critically
- Request revisions if quality is insufficient
- Cross-reference claims for accuracy
</self_correction>

<boundaries>
You CAN:
- Spawn and coordinate multiple workers
- Make strategic decisions about task decomposition
- Redirect worker efforts when conditions change
- Synthesize results from multiple sources
- Access all project files and documentation

You CANNOT:
- Modify files outside /home/druzy/thea/
- Make claims without verification
- Skip verification of subordinate work
- Proceed with high-risk operations without human approval
- Ignore safety constraints

ESCALATE TO HUMAN WHEN:
- Strategic direction is unclear
- Risk exceeds acceptable thresholds
- Conflicting requirements cannot be resolved
- Resource constraints prevent mission completion
</boundaries>

<safety>
NEVER:
- Execute destructive operations without confirmation
- Fabricate results or skip verification
- Allow subordinates to operate outside boundaries
- Suppress error information from reports

ALWAYS:
- Verify subordinate work before reporting completion
- Document strategic decisions and rationale
- Preserve audit trail of all operations
- Escalate security concerns immediately
- Use TEST: prefix for any test/experimental workers
</safety>
${formatTaskContent(task, 'strategic')}
${parentWorkerId ? `
<delegation_context>
You were spawned by worker ${parentWorkerId}${parentLabel ? ` (${parentLabel})` : ''}.
Report strategic progress and final results back to your parent worker.
Use: curl -s -X POST ${STRATEGOS_API}/api/workers/${parentWorkerId}/input -H "Content-Type: application/json" -d '{"input":"your message"}'
</delegation_context>
` : ''}
You are now initialized as Strategic Commander. Analyze incoming tasks,
decompose them effectively, and lead your workers to mission success.`;
}

/**
 * Spawn a worker with optional dependency tracking
 * @param {string} projectPath - Path to the project directory
 * @param {string|null} label - Optional label for the worker
 * @param {Object|null} io - Socket.io instance for real-time events
 * @param {Object} options - Optional configuration
 * @param {string[]} options.dependsOn - Worker IDs that must complete first
 * @param {Object} options.onComplete - Action to trigger when worker completes
 * @param {string} options.workflowId - Associated workflow ID
 * @param {string} options.taskId - Task ID within workflow
 * @returns {Object} Worker object (with status 'pending' if waiting on deps)
 */
export async function spawnWorker(projectPath, label = null, io = null, options = {}) {
  const projectName = path.basename(projectPath);
  const workerLabel = label || projectName;

  // Check if this is a GENERAL worker - they get Ralph mode by default
  const isGeneral = workerLabel.toUpperCase().startsWith('GENERAL:');

  const {
    dependsOn = [],
    onComplete = null,
    workflowId = null,
    taskId = null,
    // Context passing for worker-to-worker spawning
    task = null,
    parentWorkerId = null,
    parentLabel = null,
    initialInput = null,
    // Auto-accept permission prompts (default OFF for safety, ON for generals)
    autoAccept = isGeneral,
    // Ralph mode - autonomous completion signaling (default ON for generals)
    ralphMode = isGeneral
  } = options;

  const id = uuidv4().slice(0, 8);
  const sessionName = `${SESSION_PREFIX}${id}`;

  // Validate project path - must be an existing directory
  const stats = await fs.stat(projectPath).catch(() => null);
  if (!stats || !stats.isDirectory()) {
    throw new Error(`Invalid project path: ${projectPath}`);
  }

  // Check resource limits - count running workers (not pending or completed)
  const runningWorkers = Array.from(workers.values()).filter(w => w.status === 'running');
  if (runningWorkers.length >= MAX_CONCURRENT_WORKERS) {
    throw new Error(`Cannot spawn worker: maximum concurrent workers (${MAX_CONCURRENT_WORKERS}) reached. ` +
      `Currently running: ${runningWorkers.length}. Kill some workers or wait for completion.`);
  }

  // Register dependencies in the dependency graph
  if (dependsOn.length > 0 || onComplete) {
    const depResult = registerWorkerDependencies(id, dependsOn, onComplete, workflowId);
    if (!depResult.success) {
      throw new Error(depResult.error);
    }
  }

  // Check if all dependencies are satisfied
  const canStart = dependsOn.length === 0 || canWorkerStart(id);

  if (!canStart) {
    // Queue the worker to start when dependencies complete
    const pendingWorker = {
      id,
      label: workerLabel,
      project: projectName,
      workingDir: projectPath,
      status: 'pending',
      dependsOn,
      onComplete,
      workflowId,
      taskId,
      // Context passing
      parentWorkerId,
      parentLabel,
      task,
      createdAt: new Date()
    };

    pendingWorkers.set(id, {
      projectPath,
      label: workerLabel,
      dependsOn,
      onComplete,
      workflowId,
      taskId,
      // Context passing
      task,
      parentWorkerId,
      parentLabel,
      initialInput,
      io,
      // Worker settings
      autoAccept,
      ralphMode
    });

    // Register with workflow if applicable
    if (workflowId && taskId) {
      registerWorkflowWorker(workflowId, taskId, id);
    }

    const activity = addActivity('worker_pending', id, workerLabel, projectName,
      `Worker "${workerLabel}" waiting on ${dependsOn.length} dependencies`);

    if (io) {
      io.emit('worker:pending', pendingWorker);
      io.emit('activity:new', activity);
    }

    return pendingWorker;
  }

  // Dependencies are satisfied, spawn immediately
  try {
    // Validate inputs to prevent command injection
    validateSessionName(sessionName);
    console.log(`[SpawnWorker] Creating worker ${id} with session ${sessionName}`);

    // Track spawn timing for metrics
    const spawnStartTime = Date.now();

    // Generate Ralph token BEFORE writing context (so it's included in context file)
    const ralphToken = ralphMode ? Math.random().toString(36).substring(2, 12) : null;

    // Write Strategos context file BEFORE spawning Claude
    // Claude Code auto-loads .claudecontext during initialization,
    // ensuring the worker knows about Strategos API before any user input
    console.log(`[SpawnWorker] Writing context for ${id}${ralphToken ? ` (Ralph token: ${ralphToken})` : ''}`);
    await writeStrategosContext(id, workerLabel, projectPath, ralphToken);
    console.log(`[SpawnWorker] Context written, now creating tmux session ${sessionName}`);

    // Create PTY running claude in a tmux session for persistence
    // Use -x and -y to set initial size - this ensures consistent rendering
    // SECURITY: Using spawn instead of exec prevents shell injection
    await spawnTmux([
      'new-session', '-d',
      '-s', sessionName,
      '-x', String(DEFAULT_COLS),
      '-y', String(DEFAULT_ROWS),
      '-c', projectPath,
      'claude'
    ]);
    console.log(`[SpawnWorker] tmux session ${sessionName} created successfully`);

    // Record spawn time metric
    const spawnDuration = Date.now() - spawnStartTime;
    recordWorkerSpawn(id, spawnDuration, { project: projectName, label: workerLabel });

    const worker = {
      id,
      label: workerLabel,
      project: projectName,
      workingDir: projectPath,
      tmuxSession: sessionName,
      status: 'running',
      mode: 'tmux', // 'tmux' or 'pty'
      createdAt: new Date(),
      lastActivity: new Date(),
      lastOutput: new Date(),
      health: 'healthy',
      queuedCommands: 0,
      dependsOn,
      workflowId,
      taskId,
      // Context passing for delegation chain
      parentWorkerId,
      parentLabel,
      task,
      childWorkerIds: [],
      // Auto-accept settings (default OFF for safety)
      autoAccept,
      autoAcceptPaused: false,
      lastAutoAcceptHash: null,
      // Ralph mode - autonomous completion signaling
      ralphMode,
      ralphToken, // Use pre-generated token (already in context file)
      ralphStatus: ralphMode ? 'pending' : null, // 'pending', 'in_progress', 'done', 'blocked'
      ralphSignaledAt: null,
      ralphLearnings: null,
      // Progressive status (new)
      ralphProgress: null,      // 0-100 percentage
      ralphCurrentStep: null,   // Current step description
      // Structured outputs (new)
      ralphOutputs: null,       // { key: value } for passing to dependent workers
      ralphArtifacts: null,     // Array of file paths created
    };

    workers.set(id, worker);
    outputBuffers.set(id, '');
    commandQueues.set(id, []);

    // Mark as started in dependency graph
    if (dependsOn.length > 0 || onComplete) {
      markWorkerStarted(id);
    }

    // Register with workflow if applicable
    if (workflowId && taskId) {
      registerWorkflowWorker(workflowId, taskId, id);
    }

    // Start database session for output persistence
    dbStartSession(worker);

    // Start real-time output capture via PTY attachment
    startPtyCapture(id, sessionName, io);

    // Start health monitoring
    startHealthMonitor(id, io);

    // Track parent-child relationship
    if (parentWorkerId) {
      const parentWorker = workers.get(parentWorkerId);
      if (parentWorker) {
        parentWorker.childWorkerIds = parentWorker.childWorkerIds || [];
        parentWorker.childWorkerIds.push(id);
      }
    }

    // Send self-awareness prompt after Claude initializes (3 second delay)
    setTimeout(async () => {
      try {
        const currentWorker = workers.get(id);
        if (currentWorker && currentWorker.status === 'running') {
          // Pass context options to prompt generator
          const prompt = generateSelfAwarenessPrompt(currentWorker, {
            task,
            parentWorkerId,
            parentLabel
          });
          await sendInputDirect(id, prompt);
          console.log(`Sent self-awareness prompt to ${workerLabel}`);

          // Send initial input if provided (the actual task instruction)
          if (initialInput) {
            setTimeout(async () => {
              try {
                await sendInputDirect(id, initialInput);
                console.log(`Sent initial input to ${workerLabel}`);
              } catch (err) {
                console.error(`Failed to send initial input to ${workerLabel}:`, err.message);
              }
            }, 1000);
          }
        }
      } catch (err) {
        console.error(`Failed to send self-awareness prompt to ${workerLabel}:`, err.message);
      }
    }, 3000);

    // Ralph adoption reminder - nudge workers who haven't signaled after 60s
    if (ralphMode) {
      setTimeout(() => {
        const w = workers.get(id);
        if (w && w.ralphMode && w.status === 'running' && (!w.ralphStatus || w.ralphStatus === 'pending')) {
          sendInputDirect(id, 'REMINDER: Signal your status via Ralph API. This helps your parent monitor efficiently without reading your full output. Use: curl -s -X POST ' + STRATEGOS_API + '/api/ralph/signal/' + ralphToken + ' -H "Content-Type: application/json" -d \'{"status": "in_progress", "progress": 25, "currentStep": "What you are doing"}\'').catch(() => {});
          console.log(`[Ralph] Sent 60s reminder to ${workerLabel}`);
        }
      }, 60000);
    }

    const activity = addActivity('worker_started', id, workerLabel, projectName,
      `Started worker "${workerLabel}" in ${projectPath}`);

    if (io) {
      io.emit('worker:created', worker);
      io.emit('activity:new', activity);
    }

    // Save state for persistence
    await saveWorkerState();

    return worker;
  } catch (error) {
    // Clean up dependency registration on failure
    if (dependsOn.length > 0 || onComplete) {
      markWorkerFailed(id);
    }

    const activity = addActivity('error', id, workerLabel, projectName,
      `Failed to start worker: ${error.message}`);

    if (io) {
      io.emit('activity:new', activity);
    }

    throw error;
  }
}

/**
 * Start a pending worker (internal function called when dependencies complete)
 */
async function startPendingWorker(workerId, io = null) {
  const pending = pendingWorkers.get(workerId);
  if (!pending) return null;

  const sessionName = `${SESSION_PREFIX}${workerId}`;
  const projectName = path.basename(pending.projectPath);

  try {
    // Validate inputs to prevent command injection
    validateSessionName(sessionName);

    // Generate Ralph token BEFORE writing context (so it's included in context file)
    const ralphToken = pending.ralphMode ? Math.random().toString(36).substring(2, 12) : null;

    // Write Strategos context file BEFORE spawning Claude
    await writeStrategosContext(workerId, pending.label, pending.projectPath, ralphToken);

    // Create PTY running claude in a tmux session
    await spawnTmux([
      'new-session', '-d',
      '-s', sessionName,
      '-x', String(DEFAULT_COLS),
      '-y', String(DEFAULT_ROWS),
      '-c', pending.projectPath,
      'claude'
    ]);

    const worker = {
      id: workerId,
      label: pending.label,
      project: projectName,
      workingDir: pending.projectPath,
      tmuxSession: sessionName,
      status: 'running',
      mode: 'tmux',
      createdAt: new Date(),
      lastActivity: new Date(),
      lastOutput: new Date(),
      health: 'healthy',
      queuedCommands: 0,
      dependsOn: pending.dependsOn,
      workflowId: pending.workflowId,
      taskId: pending.taskId,
      // Context passing
      parentWorkerId: pending.parentWorkerId,
      parentLabel: pending.parentLabel,
      task: pending.task,
      childWorkerIds: [],
      // Auto-accept settings
      autoAccept: pending.autoAccept || false,
      autoAcceptPaused: false,
      lastAutoAcceptHash: null,
      // Ralph mode
      ralphMode: pending.ralphMode || false,
      ralphToken
    };

    workers.set(workerId, worker);
    outputBuffers.set(workerId, '');
    commandQueues.set(workerId, []);
    pendingWorkers.delete(workerId);

    // Mark as started in dependency graph
    markWorkerStarted(workerId);

    // Start database session for output persistence
    dbStartSession(worker);

    // Start real-time output capture
    startPtyCapture(workerId, sessionName, io || pending.io);

    // Start health monitoring
    startHealthMonitor(workerId, io || pending.io);

    // Send self-awareness prompt after Claude initializes (3 second delay)
    setTimeout(async () => {
      try {
        const currentWorker = workers.get(workerId);
        if (currentWorker && currentWorker.status === 'running') {
          // Pass context options to prompt generator
          const prompt = generateSelfAwarenessPrompt(currentWorker, {
            task: pending.task,
            parentWorkerId: pending.parentWorkerId,
            parentLabel: pending.parentLabel
          });
          await sendInputDirect(workerId, prompt);
          console.log(`Sent self-awareness prompt to ${pending.label}`);

          // Send initial input if provided
          if (pending.initialInput) {
            setTimeout(async () => {
              try {
                await sendInputDirect(workerId, pending.initialInput);
                console.log(`Sent initial input to ${pending.label}`);
              } catch (err) {
                console.error(`Failed to send initial input to ${pending.label}:`, err.message);
              }
            }, 1000);
          }
        }
      } catch (err) {
        console.error(`Failed to send self-awareness prompt to ${pending.label}:`, err.message);
      }
    }, 3000);

    // Ralph adoption reminder - nudge workers who haven't signaled after 60s
    if (ralphToken) {
      setTimeout(() => {
        const w = workers.get(workerId);
        if (w && w.ralphMode && w.status === 'running' && (!w.ralphStatus || w.ralphStatus === 'pending')) {
          sendInputDirect(workerId, 'REMINDER: Signal your status via Ralph API. This helps your parent monitor efficiently without reading your full output. Use: curl -s -X POST ' + STRATEGOS_API + '/api/ralph/signal/' + ralphToken + ' -H "Content-Type: application/json" -d \'{"status": "in_progress", "progress": 25, "currentStep": "What you are doing"}\'').catch(() => {});
          console.log(`[Ralph] Sent 60s reminder to ${pending.label}`);
        }
      }, 60000);
    }

    const activity = addActivity('worker_started', workerId, pending.label, projectName,
      `Started worker "${pending.label}" (dependencies satisfied)`);

    if (io || pending.io) {
      (io || pending.io).emit('worker:created', worker);
      (io || pending.io).emit('worker:dependencies_satisfied', { workerId });
      (io || pending.io).emit('activity:new', activity);
    }

    await saveWorkerState();

    return worker;
  } catch (error) {
    markWorkerFailed(workerId);
    pendingWorkers.delete(workerId);

    const activity = addActivity('error', workerId, pending.label, projectName,
      `Failed to start pending worker: ${error.message}`);

    if (io || pending.io) {
      (io || pending.io).emit('activity:new', activity);
    }

    throw error;
  }
}

// ============================================
// PTY-BASED REAL-TIME OUTPUT CAPTURE
// ============================================

function startPtyCapture(workerId, sessionName, io) {
  const worker = workers.get(workerId);
  if (!worker) return;

  // Use polling with tmux capture-pane instead of PTY attach
  // This avoids terminal capability queries that pollute the session
  let lastCaptureHash = '';
  let initialChecksDone = false; // Skip session existence check for first 5 seconds

  // Mark initial grace period (avoid race condition with tmux session creation)
  setTimeout(() => {
    initialChecksDone = true;
  }, 5000);

  const captureInterval = setInterval(async () => {
    if (!workers.has(workerId)) {
      clearInterval(captureInterval);
      return;
    }

    try {
      // Check if session still exists (but skip during initial grace period to avoid race condition)
      if (initialChecksDone) {
        const exists = await sessionExists(sessionName);
        if (!exists) {
          clearInterval(captureInterval);

          const w = workers.get(workerId);
          const activity = addActivity('worker_stopped', workerId, w?.label || 'Unknown', w?.project || 'Unknown',
            `Worker session ended`);

          // End database session
          dbEndSession(workerId, 'stopped');

          workers.delete(workerId);
          outputBuffers.delete(workerId);
          commandQueues.delete(workerId);
          ptyInstances.delete(workerId);
          stopHealthMonitor(workerId);

          if (io) {
            io.emit('worker:deleted', { workerId });
            io.emit('activity:new', activity);
          }

          saveWorkerState();
          return;
        }
      }

      // Capture the current screen with escape codes for colors
      // -p prints to stdout, -e includes escape codes
      // Using -S - -E - captures only the visible pane (no scrollback history)
      // This avoids alignment issues from content rendered at different terminal sizes
      // SECURITY: Using spawn instead of exec prevents shell injection
      const { stdout } = await spawnTmux([
        'capture-pane', '-t', sessionName, '-p', '-e', '-S', '-', '-E', '-'
      ]);

      // Simple hash to detect changes
      const hash = stdout.length + stdout.slice(-100);
      const outputChanged = hash !== lastCaptureHash;

      // Always get worker for auto-accept check
      const worker = workers.get(workerId);

      // Auto-accept handling - always check if enabled, let the function handle pause/resume
      if (worker?.autoAccept) {
        handleAutoAcceptCheck(workerId, stdout, io);
      }

      // Skip rest if output hasn't changed
      if (!outputChanged) return;
      lastCaptureHash = hash;

      if (worker) {
        worker.lastOutput = new Date();
        worker.lastActivity = new Date();
      }

      // Store the captured output
      outputBuffers.set(workerId, stdout);

      // Persist to database (async, non-blocking)
      dbStoreOutput(workerId, stdout, 'stdout');

      // Emit to clients
      if (io) {
        io.emit('worker:output', {
          workerId,
          output: stdout,
        });
      }
    } catch (err) {
      // Session might be gone, ignore errors
      console.warn(`Capture error for ${workerId}:`, err.message);
    }
  }, 1000); // Poll every 1000ms - slower reduces flicker

  // Store interval reference for cleanup
  ptyInstances.set(workerId, { interval: captureInterval });
}

// Clean up function for the polling capture
function stopPtyCapture(workerId) {
  const instance = ptyInstances.get(workerId);
  if (instance?.interval) {
    clearInterval(instance.interval);
  }
  ptyInstances.delete(workerId);
}

// ============================================
// AUTO-ACCEPT LOGIC
// ============================================

/**
 * Check output for prompts and auto-accept if appropriate.
 * Pauses auto-accept if plan mode keywords are detected.
 * Auto-resumes when pause keywords are no longer present.
 */
async function handleAutoAcceptCheck(workerId, output, io) {
  const worker = workers.get(workerId);
  if (!worker || !worker.autoAccept) return;

  // Strip ANSI for pattern matching
  const cleaned = stripAnsiCodes(output);

  // Only check the last 500 chars (prompt area) for both pause keywords and accept patterns
  // Checking the entire output would cause false positives from historical content
  const tail = cleaned.slice(-500);
  const lowerTail = tail.toLowerCase();

  // Check for pause keywords (plan mode, etc.)
  let pauseKeywordFound = false;
  for (const keyword of AUTO_ACCEPT_PAUSE_KEYWORDS) {
    if (lowerTail.includes(keyword.toLowerCase())) {
      pauseKeywordFound = true;
      break;
    }
  }

  // Handle pause/resume state transitions
  if (pauseKeywordFound && !worker.autoAcceptPaused) {
    // Pause: keyword appeared
    console.log(`[AutoAccept] Pausing for ${worker.label} - detected pause keyword`);
    worker.autoAcceptPaused = true;
    if (io) {
      io.emit('worker:updated', worker);
    }
    return;
  } else if (!pauseKeywordFound && worker.autoAcceptPaused) {
    // Resume: keyword no longer present
    console.log(`[AutoAccept] Auto-resuming for ${worker.label} - no pause keywords in output`);
    worker.autoAcceptPaused = false;
    worker.lastAutoAcceptHash = null; // Reset to allow prompt detection
    if (io) {
      io.emit('worker:updated', worker);
    }
  }

  // If still paused (keyword present), don't auto-accept
  if (worker.autoAcceptPaused) return;

  const hash = simpleHash(tail);

  // Skip if we already handled this prompt
  if (hash === worker.lastAutoAcceptHash) {
    return;
  }

  // Check for any accept pattern
  for (const pattern of AUTO_ACCEPT_PATTERNS) {
    if (pattern.test(tail)) {
      worker.lastAutoAcceptHash = hash;
      console.log(`[AutoAccept] Accepting prompt for ${worker.label} (pattern: ${pattern})`);

      try {
        // Just send Enter - Claude Code prompts have option 1 pre-selected
        await safeSendKeys(worker.tmuxSession, ['Enter']);
        console.log(`[AutoAccept] Sent Enter to ${worker.label}`);

        // Reset hash after a delay to allow detecting next prompt in sequence
        setTimeout(() => {
          if (worker.autoAccept) {
            worker.lastAutoAcceptHash = null;
          }
        }, 1500);
      } catch (error) {
        console.error(`[AutoAccept] Failed to send keys for ${worker.label}:`, error.message);
      }
      return;
    }
  }
}

/**
 * Update worker settings (autoAccept, autoAcceptPaused, etc.)
 */
export function updateWorkerSettings(workerId, settings, io = null) {
  const worker = workers.get(workerId);

  if (!worker) {
    throw new Error(`Worker ${workerId} not found`);
  }

  if (settings.autoAccept !== undefined) {
    worker.autoAccept = settings.autoAccept;
    // Reset pause state when enabling
    if (settings.autoAccept) {
      worker.autoAcceptPaused = false;
      worker.lastAutoAcceptHash = null;
    }
    console.log(`[AutoAccept] ${worker.label} autoAccept set to ${settings.autoAccept}`);
  }

  if (settings.autoAcceptPaused !== undefined) {
    worker.autoAcceptPaused = settings.autoAcceptPaused;
    // Reset hash when resuming to allow re-detection
    if (!settings.autoAcceptPaused) {
      worker.lastAutoAcceptHash = null;
    }
    console.log(`[AutoAccept] ${worker.label} autoAcceptPaused set to ${settings.autoAcceptPaused}`);
  }

  // Ralph mode - autonomous completion signaling
  if (settings.ralphMode !== undefined) {
    worker.ralphMode = settings.ralphMode;
    if (settings.ralphMode) {
      // Generate completion token
      worker.ralphToken = Math.random().toString(36).substring(2, 12);
      console.log(`[Ralph] ${worker.label} Ralph mode ENABLED (token: ${worker.ralphToken})`);
    } else {
      worker.ralphToken = null;
      console.log(`[Ralph] ${worker.label} Ralph mode DISABLED`);
    }
  }

  if (io) {
    io.emit('worker:updated', worker);
  }

  return worker;
}

// ============================================
// HEALTH MONITORING
// ============================================

function startHealthMonitor(workerId, io) {
  const interval = setInterval(async () => {
    const worker = workers.get(workerId);
    if (!worker) {
      clearInterval(interval);
      healthChecks.delete(workerId);
      return;
    }

    // Check if tmux session exists
    const exists = await sessionExists(worker.tmuxSession);
    if (!exists) {
      worker.health = 'dead';
      worker.status = 'error';

      if (io) {
        io.emit('worker:updated', worker);
      }

      // Auto-cleanup dead workers after 30 seconds
      setTimeout(() => {
        if (workers.has(workerId) && workers.get(workerId).health === 'dead') {
          cleanupWorker(workerId, io);
        }
      }, 30000);

      return;
    }

    // Check for stalled output (no output for 5+ minutes while "thinking")
    const timeSinceOutput = Date.now() - new Date(worker.lastOutput).getTime();
    if (timeSinceOutput > 5 * 60 * 1000) {
      worker.health = 'stalled';
    } else {
      worker.health = 'healthy';
    }

    // Update queued commands count
    worker.queuedCommands = (commandQueues.get(workerId) || []).length;

    if (io) {
      io.emit('worker:updated', worker);
    }
  }, 10000); // Check every 10 seconds

  healthChecks.set(workerId, interval);
}

function stopHealthMonitor(workerId) {
  const interval = healthChecks.get(workerId);
  if (interval) {
    clearInterval(interval);
    healthChecks.delete(workerId);
  }
}

// ============================================
// WORKER CLEANUP
// ============================================

async function cleanupWorker(workerId, io) {
  const worker = workers.get(workerId);
  if (!worker) return;

  const activity = addActivity('worker_stopped', workerId, worker.label, worker.project,
    `Worker "${worker.label}" cleaned up`);

  // End database session
  dbEndSession(workerId, 'stopped');

  // Stop capture polling
  stopPtyCapture(workerId);

  // Remove Strategos context file
  if (worker.workingDir) {
    await removeStrategosContext(worker.workingDir);
  }

  workers.delete(workerId);
  outputBuffers.delete(workerId);
  commandQueues.delete(workerId);
  stopHealthMonitor(workerId);

  if (io) {
    io.emit('worker:deleted', { workerId });
    io.emit('activity:new', activity);
  }

  await saveWorkerState();
}

export async function killWorker(workerId, io = null) {
  const worker = workers.get(workerId);

  if (!worker) {
    throw new Error(`Worker ${workerId} not found`);
  }

  console.log(`[KillWorker] Killing worker ${workerId} (tmux session: ${worker.tmuxSession})`);

  // Stop capture polling if running
  stopPtyCapture(workerId);

  // SECURITY: Validate session name before using
  try {
    validateSessionName(worker.tmuxSession);
  } catch (validationError) {
    console.error(`[KillWorker] Invalid session name: ${validationError.message}`);
    throw new Error(`Invalid worker session name`);
  }

  // Try to kill tmux session - use kill-session with -t to target session
  // SECURITY: Using spawn instead of exec prevents shell injection
  try {
    const result = await spawnTmux(['kill-session', '-t', worker.tmuxSession]);
    console.log(`[KillWorker] Tmux kill-session result:`, result);
  } catch (error) {
    console.log(`[KillWorker] Tmux kill-session failed (may already be gone):`, error.message);
  }

  // Verify session is gone
  const stillExists = await sessionExists(worker.tmuxSession);
  if (stillExists) {
    console.warn(`[KillWorker] Session still exists, force killing...`);
    try {
      await spawnTmux(['kill-session', '-t', worker.tmuxSession]);
    } catch {
      // Ignore - session may have already been killed
    }
  }

  // End database session
  dbEndSession(workerId, 'stopped');

  // Remove Strategos context file
  if (worker.workingDir) {
    await removeStrategosContext(worker.workingDir);
  }

  // Clean up state
  worker.status = 'stopped';
  workers.delete(workerId);
  outputBuffers.delete(workerId);
  commandQueues.delete(workerId);
  ptyInstances.delete(workerId);
  stopHealthMonitor(workerId);

  console.log(`[KillWorker] Worker ${workerId} cleanup complete`);

  const activity = addActivity('worker_stopped', workerId, worker.label, worker.project,
    `Stopped worker "${worker.label}"`);

  if (io) {
    io.emit('worker:deleted', { workerId });
    io.emit('activity:new', activity);
  }

  await saveWorkerState();

  return true;
}

// ============================================
// COMMAND QUEUING
// ============================================

export async function sendInput(workerId, input, io = null) {
  const worker = workers.get(workerId);

  if (!worker) {
    throw new Error(`Worker ${workerId} not found`);
  }

  // Add to queue
  const queue = commandQueues.get(workerId) || [];

  // If queue is empty, send immediately
  if (queue.length === 0) {
    await sendInputDirect(workerId, input);
  } else {
    // Queue the command
    queue.push(input);
    commandQueues.set(workerId, queue);
    worker.queuedCommands = queue.length;

    if (io) {
      io.emit('worker:updated', worker);
    }
  }

  return true;
}

async function sendInputDirect(workerId, input) {
  const worker = workers.get(workerId);
  if (!worker) return;

  try {
    // SECURITY: Use safe tmux command execution (no shell)
    // -l flag tells tmux to interpret keys literally
    await safeSendKeys(worker.tmuxSession, ['-l', input]);
    // Small delay to let Claude Code process the pasted text before Enter
    await new Promise(resolve => setTimeout(resolve, 200));
    await safeSendKeys(worker.tmuxSession, ['Enter']);
    worker.lastActivity = new Date();
  } catch (error) {
    throw new Error(`Failed to send input: ${error.message}`);
  }
}

/**
 * Send raw key sequences to worker (no auto-Enter, for arrow keys, escape, etc.)
 */
export async function sendRawInput(workerId, keys) {
  const worker = workers.get(workerId);

  if (!worker) {
    throw new Error(`Worker ${workerId} not found`);
  }

  try {
    // SECURITY: Use safe tmux command execution (no shell)
    // -l flag tells tmux to interpret keys literally
    await safeSendKeys(worker.tmuxSession, ['-l', keys]);
    worker.lastActivity = new Date();
  } catch (error) {
    throw new Error(`Failed to send raw input: ${error.message}`);
  }
}

// Process queued commands (called when worker becomes idle)
export async function processQueue(workerId, io = null) {
  const queue = commandQueues.get(workerId) || [];
  if (queue.length === 0) return;

  const nextCommand = queue.shift();
  commandQueues.set(workerId, queue);

  const worker = workers.get(workerId);
  if (worker) {
    worker.queuedCommands = queue.length;
    if (io) {
      io.emit('worker:updated', worker);
    }
  }

  await sendInputDirect(workerId, nextCommand);
}

// ============================================
// GETTERS
// ============================================

/**
 * Normalizes a worker object to ensure all expected fields are present.
 * This ensures API response consistency regardless of how the worker was created.
 */
function normalizeWorker(worker) {
  if (!worker) return null;
  return {
    ...worker,
    // Ensure dependsOn is always an array (not null/undefined)
    dependsOn: Array.isArray(worker.dependsOn) ? worker.dependsOn : [],
    workflowId: worker.workflowId ?? null,
    taskId: worker.taskId ?? null,
    // Ensure autoAccept fields exist (for workers created before feature)
    autoAccept: worker.autoAccept ?? false,
    autoAcceptPaused: worker.autoAcceptPaused ?? false,
    // Ensure Ralph mode fields exist
    ralphMode: worker.ralphMode ?? false,
    ralphToken: worker.ralphToken ?? null,
  };
}

export function getWorkers() {
  return Array.from(workers.values()).map(normalizeWorker);
}

export function getWorker(workerId) {
  return normalizeWorker(workers.get(workerId));
}

export function getWorkersByProject(projectName) {
  return getWorkers().filter(w => w.project === projectName);
}

export function getWorkerOutput(workerId) {
  return outputBuffers.get(workerId) || '';
}

/**
 * Get all child workers spawned by a parent worker
 * Includes Ralph status for easy progress monitoring without reading output
 * @param {string} parentWorkerId - Parent worker ID
 * @returns {Array} Array of child workers with Ralph status
 */
export function getChildWorkers(parentWorkerId) {
  const parent = workers.get(parentWorkerId);
  if (!parent) {
    return [];
  }

  const childIds = parent.childWorkerIds || [];
  return childIds.map(childId => {
    const child = workers.get(childId);
    if (!child) return null;
    return {
      id: child.id,
      label: child.label,
      status: child.status,
      ralphMode: child.ralphMode,
      ralphStatus: child.ralphStatus, // 'pending', 'in_progress', 'done', 'blocked', or null
      ralphSignaledAt: child.ralphSignaledAt,
      ralphLearnings: child.ralphLearnings,
      // New progressive fields
      ralphProgress: child.ralphProgress,
      ralphCurrentStep: child.ralphCurrentStep,
      // Structured outputs
      ralphOutputs: child.ralphOutputs,
      ralphArtifacts: child.ralphArtifacts,
      // Task info for context
      taskDescription: child.task?.description?.substring(0, 200) || null,
      // Timing info
      createdAt: child.createdAt,
      lastActivity: child.lastActivity,
      durationMs: Date.now() - new Date(child.createdAt).getTime(),
      health: child.health,
    };
  }).filter(Boolean);
}

/**
 * Get sibling workers (other workers with the same parent)
 * Used to help workers coordinate and avoid duplicate work
 * @param {string} workerId - Worker ID to get siblings for
 * @returns {Array} Array of sibling workers (excluding self)
 */
export function getSiblingWorkers(workerId) {
  const worker = workers.get(workerId);
  if (!worker || !worker.parentWorkerId) {
    return [];
  }

  const parent = workers.get(worker.parentWorkerId);
  if (!parent) {
    return [];
  }

  const siblingIds = (parent.childWorkerIds || []).filter(id => id !== workerId);
  return siblingIds.map(siblingId => {
    const sibling = workers.get(siblingId);
    if (!sibling) return null;
    return {
      id: sibling.id,
      label: sibling.label,
      status: sibling.status,
      ralphStatus: sibling.ralphStatus,
      ralphProgress: sibling.ralphProgress,
      ralphCurrentStep: sibling.ralphCurrentStep,
      taskDescription: sibling.task?.description?.substring(0, 100) || null,
    };
  }).filter(Boolean);
}

/**
 * Update a worker's Ralph status (called when worker signals)
 * @param {string} workerId - Worker ID
 * @param {Object} signalData - Signal data containing:
 *   - status: 'in_progress', 'done', or 'blocked'
 *   - progress: 0-100 percentage (optional)
 *   - currentStep: Current step description (optional)
 *   - learnings: Summary/notes (optional)
 *   - outputs: Structured outputs { key: value } (optional)
 *   - artifacts: Array of file paths created (optional)
 *   - reason: Reason if blocked (optional)
 * @param {Object} io - Socket.io instance for events
 * @returns {boolean} True if update succeeded
 */
export function updateWorkerRalphStatus(workerId, signalData, io = null) {
  const worker = workers.get(workerId);
  if (!worker) {
    console.log(`[RalphStatus] Worker ${workerId} not found`);
    return false;
  }

  // Handle both old format (status, learnings) and new format (signalData object)
  const data = typeof signalData === 'string'
    ? { status: signalData }
    : signalData;

  const { status, progress, currentStep, learnings, outputs, artifacts, reason } = data;

  worker.ralphStatus = status;
  worker.lastActivity = new Date();

  // Only set signaled timestamp on terminal states
  if (status === 'done' || status === 'blocked') {
    worker.ralphSignaledAt = new Date();
  }

  // Update optional fields if provided
  if (progress !== undefined) worker.ralphProgress = progress;
  if (currentStep !== undefined) worker.ralphCurrentStep = currentStep;
  if (learnings !== undefined) worker.ralphLearnings = learnings;
  if (outputs !== undefined) worker.ralphOutputs = outputs;
  if (artifacts !== undefined) worker.ralphArtifacts = artifacts;

  console.log(`[RalphStatus] Worker ${workerId} signaled: ${status}${progress !== undefined ? ` (${progress}%)` : ''}`);

  // Emit update event
  if (io) {
    io.emit('worker:ralph:signaled', {
      workerId,
      status,
      progress,
      currentStep,
      learnings,
      outputs,
      artifacts,
      reason,
      signaledAt: worker.ralphSignaledAt
    });
    io.emit('worker:updated', normalizeWorker(worker));
  }

  // Also notify parent worker if exists
  if (worker.parentWorkerId) {
    const parent = workers.get(worker.parentWorkerId);
    if (parent && io) {
      io.emit('worker:child:signaled', {
        parentWorkerId: worker.parentWorkerId,
        childWorkerId: workerId,
        childLabel: worker.label,
        status,
        progress,
        currentStep,
        learnings,
        outputs
      });
    }
  }

  saveWorkerState();
  return true;
}

// ============================================
// UPDATE OPERATIONS
// ============================================

export function updateWorkerLabel(workerId, newLabel, io = null) {
  const worker = workers.get(workerId);

  if (!worker) {
    throw new Error(`Worker ${workerId} not found`);
  }

  worker.label = newLabel;
  worker.lastActivity = new Date();

  if (io) {
    io.emit('worker:updated', worker);
  }

  saveWorkerState();

  return worker;
}

// Track last resize dimensions per worker to avoid redundant resizes
const lastResizeSize = new Map();

export async function resizeWorkerTerminal(workerId, cols, rows, io = null) {
  const worker = workers.get(workerId);
  if (!worker) {
    throw new Error(`Worker ${workerId} not found`);
  }

  // Validate dimensions
  cols = Math.max(20, Math.min(500, parseInt(cols) || 80));
  rows = Math.max(5, Math.min(200, parseInt(rows) || 24));

  // Skip if same size as last resize
  const sizeKey = `${cols}x${rows}`;
  if (lastResizeSize.get(workerId) === sizeKey) {
    return { cols, rows, skipped: true };
  }
  lastResizeSize.set(workerId, sizeKey);

  try {
    // SECURITY: Validate session name before using
    validateSessionName(worker.tmuxSession);

    // SECURITY: Using spawn instead of exec prevents shell injection
    // Resize the tmux window/pane
    await spawnTmux(['resize-window', '-t', worker.tmuxSession, '-x', String(cols), '-y', String(rows)]);

    // Clear tmux scrollback history to avoid misaligned old content
    await spawnTmux(['clear-history', '-t', worker.tmuxSession]);

    // Send Ctrl+L to trigger screen redraw in Claude Code
    await spawnTmux(['send-keys', '-t', worker.tmuxSession, 'C-l']);

    // Note: Don't clear output buffer here - it causes flicker.
    // The next capture poll (1s) will naturally update with fresh content.

    console.log(`Resized ${worker.label} to ${cols}x${rows}`);

    return { cols, rows };
  } catch (error) {
    console.error(`Failed to resize ${worker.label}:`, error.message);
    throw error;
  }
}

export async function broadcastToProject(projectName, input) {
  const projectWorkers = getWorkersByProject(projectName);

  const results = await Promise.allSettled(
    projectWorkers.map(w => sendInput(w.id, input))
  );

  return results;
}

// ============================================
// WORKER DISCOVERY (for existing tmux sessions)
// ============================================

export async function discoverExistingWorkers(io = null) {
  try {
    // SECURITY: Using spawn for tmux list-sessions
    // Note: This command has no user input, but using spawn for consistency
    const { stdout } = await spawnTmux(['list-sessions', '-F', '#{session_name}']).catch(() => ({ stdout: '' }));

    const sessions = stdout.trim().split('\n').filter(s => s.startsWith(SESSION_PREFIX));

    for (const sessionName of sessions) {
      const id = sessionName.replace(SESSION_PREFIX, '');

      // Skip if already tracked
      if (workers.has(id)) continue;

      // Verify session exists
      const exists = await sessionExists(sessionName);
      if (!exists) continue;

      // Get working directory
      // SECURITY: Using spawn instead of exec prevents shell injection
      let workingDir = '/thea';
      try {
        const { stdout: cwd } = await spawnTmux([
          'display-message', '-t', sessionName, '-p', '#{pane_current_path}'
        ]);
        workingDir = cwd.trim();
      } catch {
        // Use default
      }

      const projectName = path.basename(workingDir);

      const worker = {
        id,
        label: projectName,
        project: projectName,
        workingDir,
        tmuxSession: sessionName,
        status: 'running',
        mode: 'tmux',
        createdAt: new Date(),
        lastActivity: new Date(),
        lastOutput: new Date(),
        health: 'healthy',
        queuedCommands: 0,
        dependsOn: [],
        workflowId: null,
        taskId: null
      };

      workers.set(id, worker);
      outputBuffers.set(id, '');
      commandQueues.set(id, []);

      // Start database session for output persistence
      dbStartSession(worker);

      // Start PTY capture for real-time output
      startPtyCapture(id, sessionName, io);

      // Start health monitoring
      startHealthMonitor(id, io);
    }

    return getWorkers();
  } catch {
    return [];
  }
}

// ============================================
// SESSION PERSISTENCE
// ============================================

async function saveWorkerState() {
  try {
    const state = {
      timestamp: new Date().toISOString(),
      workers: Array.from(workers.values()).map(w => ({
        id: w.id,
        label: w.label,
        project: w.project,
        workingDir: w.workingDir,
        tmuxSession: w.tmuxSession,
        createdAt: w.createdAt,
        autoAccept: w.autoAccept ?? false,
        ralphMode: w.ralphMode ?? false,
        ralphToken: w.ralphToken ?? null
      }))
    };

    await fs.writeFile(PERSISTENCE_FILE, JSON.stringify(state, null, 2));
  } catch (error) {
    console.error('Failed to save worker state:', error.message);
  }
}

export async function restoreWorkerState(io = null) {
  try {
    const data = await fs.readFile(PERSISTENCE_FILE, 'utf-8');
    const state = JSON.parse(data);

    console.log(`Restoring ${state.workers.length} workers from saved state...`);

    for (const savedWorker of state.workers) {
      // Check if tmux session still exists
      const exists = await sessionExists(savedWorker.tmuxSession);
      if (!exists) {
        console.log(`  Skipping ${savedWorker.label} - session no longer exists`);
        continue;
      }

      // Skip if already tracked
      if (workers.has(savedWorker.id)) continue;

      const worker = {
        ...savedWorker,
        status: 'running',
        mode: 'tmux',
        lastActivity: new Date(),
        lastOutput: new Date(),
        health: 'healthy',
        queuedCommands: 0,
        // Ensure these fields exist for consistency (may be missing from old saved states)
        dependsOn: savedWorker.dependsOn || [],
        workflowId: savedWorker.workflowId ?? null,
        taskId: savedWorker.taskId ?? null,
        // Auto-accept settings
        autoAccept: savedWorker.autoAccept ?? false,
        autoAcceptPaused: false,
        lastAutoAcceptHash: null,
        // Ralph mode settings
        ralphMode: savedWorker.ralphMode ?? false,
        ralphToken: savedWorker.ralphToken ?? null
      };

      workers.set(savedWorker.id, worker);
      outputBuffers.set(savedWorker.id, '');
      commandQueues.set(savedWorker.id, []);

      // Start database session for output persistence
      dbStartSession(worker);

      // Start PTY capture
      startPtyCapture(savedWorker.id, savedWorker.tmuxSession, io);

      // Start health monitoring
      startHealthMonitor(savedWorker.id, io);

      console.log(`  Restored ${savedWorker.label}`);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error('Failed to restore worker state:', error.message);
    }
  }
}

// ============================================
// CLAUDE HEADLESS MODE (for batch operations)
// ============================================

export async function runHeadless(projectPath, prompt, options = {}) {
  const {
    outputFormat = 'json',
    systemPrompt = null,
    timeout = 300000 // 5 minutes default
  } = options;

  // SECURITY: Validate project path before using
  const stats = await fs.stat(projectPath).catch(() => null);
  if (!stats || !stats.isDirectory()) {
    throw new Error(`Invalid project path: ${projectPath}`);
  }

  // SECURITY: Validate output format to prevent injection via args
  const validFormats = ['json', 'text', 'stream-json'];
  if (!validFormats.includes(outputFormat)) {
    throw new Error(`Invalid output format: ${outputFormat}`);
  }

  return new Promise((resolve, reject) => {
    const args = ['--print', '--output-format', outputFormat];

    if (systemPrompt) {
      args.push('--append-system-prompt', systemPrompt);
    }

    const proc = spawn('claude', args, {
      cwd: projectPath,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', chunk => stdout += chunk);
    proc.stderr.on('data', chunk => stderr += chunk);

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Claude exited with code ${code}: ${stderr}`));
        return;
      }

      try {
        if (outputFormat === 'json') {
          resolve(JSON.parse(stdout));
        } else {
          resolve(stdout);
        }
      } catch (e) {
        resolve(stdout); // Return raw output if JSON parse fails
      }
    });

    proc.on('error', reject);

    // Send prompt
    proc.stdin.write(prompt);
    proc.stdin.end();

    // Handle timeout
    setTimeout(() => {
      proc.kill();
      reject(new Error('Headless operation timed out'));
    }, timeout);
  });
}

// ============================================
// BATCH OPERATIONS
// ============================================

export async function runBatchOperation(projectPaths, prompt, options = {}) {
  const results = await Promise.allSettled(
    projectPaths.map(p => runHeadless(p, prompt, options))
  );

  return results.map((result, i) => ({
    project: path.basename(projectPaths[i]),
    path: projectPaths[i],
    success: result.status === 'fulfilled',
    result: result.status === 'fulfilled' ? result.value : null,
    error: result.status === 'rejected' ? result.reason.message : null
  }));
}

// ============================================
// DEPENDENCY MANAGEMENT
// ============================================

/**
 * Mark a worker as completed and trigger any dependent workers
 * @param {string} workerId
 * @param {Object|null} io - Socket.io instance
 * @returns {Object} Result with triggered workers and onComplete action
 */
export async function completeWorker(workerId, io = null, options = {}) {
  const { autoCleanup = true } = options;

  const worker = workers.get(workerId);
  if (!worker) {
    throw new Error(`Worker ${workerId} not found`);
  }

  // Mark as completed in dependency graph
  const { triggeredWorkers, onCompleteAction } = markWorkerCompleted(workerId);

  worker.status = 'completed';
  worker.completedAt = new Date();

  const activity = addActivity('worker_completed', workerId, worker.label, worker.project,
    `Worker "${worker.label}" completed`);

  if (io) {
    io.emit('worker:completed', { workerId, worker });
    io.emit('activity:new', activity);
  }

  // Start any workers that were waiting on this one
  const startedWorkers = [];
  for (const triggeredId of triggeredWorkers) {
    try {
      const started = await startPendingWorker(triggeredId, io);
      if (started) {
        startedWorkers.push(started);
      }
    } catch (error) {
      console.error(`Failed to start triggered worker ${triggeredId}:`, error.message);
    }
  }

  // Handle onComplete action
  if (onCompleteAction) {
    await handleOnCompleteAction(onCompleteAction, workerId, io);
  }

  // Emit event for triggered workers
  if (triggeredWorkers.length > 0 && io) {
    io.emit('dependencies:triggered', {
      completedWorkerId: workerId,
      triggeredWorkerIds: triggeredWorkers
    });
  }

  // Auto-cleanup: kill the worker after a delay to free resources
  if (autoCleanup) {
    setTimeout(async () => {
      try {
        const currentWorker = workers.get(workerId);
        if (currentWorker && currentWorker.status === 'completed') {
          console.log(`[AutoCleanup] Cleaning up completed worker ${workerId} (${worker.label})`);
          await killWorker(workerId, io);
        }
      } catch (error) {
        console.error(`[AutoCleanup] Failed to cleanup worker ${workerId}:`, error.message);
      }
    }, AUTO_CLEANUP_DELAY_MS);
  }

  return {
    worker,
    triggeredWorkers: startedWorkers,
    onCompleteAction
  };
}

/**
 * Handle onComplete action when a worker finishes
 */
async function handleOnCompleteAction(action, completedWorkerId, io) {
  if (!action || !action.type) return;

  switch (action.type) {
    case 'spawn':
      // Spawn another worker
      if (action.config && action.config.projectPath) {
        try {
          await spawnWorker(
            action.config.projectPath,
            action.config.label || null,
            io,
            action.config.options || {}
          );
        } catch (error) {
          console.error('onComplete spawn failed:', error.message);
        }
      }
      break;

    case 'webhook':
      // Call a webhook URL
      if (action.config && action.config.url) {
        try {
          const response = await fetch(action.config.url, {
            method: action.config.method || 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(action.config.headers || {})
            },
            body: JSON.stringify({
              event: 'worker_completed',
              workerId: completedWorkerId,
              timestamp: new Date().toISOString(),
              ...(action.config.body || {})
            })
          });
          console.log(`Webhook ${action.config.url} returned ${response.status}`);
        } catch (error) {
          console.error('onComplete webhook failed:', error.message);
        }
      }
      break;

    case 'emit':
      // Emit a custom socket event
      if (io && action.config && action.config.event) {
        io.emit(action.config.event, {
          workerId: completedWorkerId,
          ...(action.config.data || {})
        });
      }
      break;

    default:
      console.warn(`Unknown onComplete action type: ${action.type}`);
  }
}

/**
 * Get dependency information for a worker
 * @param {string} workerId
 * @returns {Object|null}
 */
export function getWorkerDependencies(workerId) {
  return getDependencyInfo(workerId);
}

/**
 * Get all pending workers (waiting on dependencies)
 * @returns {Object[]}
 */
export function getPendingWorkers() {
  return Array.from(pendingWorkers.entries()).map(([id, pending]) => ({
    id,
    label: pending.label,
    project: path.basename(pending.projectPath),
    workingDir: pending.projectPath,
    status: 'pending',
    dependsOn: pending.dependsOn,
    workflowId: pending.workflowId,
    taskId: pending.taskId
  }));
}

// ============================================
// PERIODIC CLEANUP SWEEP
// ============================================

let cleanupInterval = null;

/**
 * Start the periodic cleanup sweep that runs every minute.
 * Cleans up:
 * - Completed workers that weren't auto-cleaned (safety net)
 * - Optionally: stale workers with no activity for 30+ minutes
 */
export function startPeriodicCleanup(io = null) {
  if (cleanupInterval) {
    console.log('[PeriodicCleanup] Already running');
    return;
  }

  console.log('[PeriodicCleanup] Starting periodic cleanup sweep (every 60s)');

  cleanupInterval = setInterval(async () => {
    const now = Date.now();
    const workersToClean = [];

    for (const [id, worker] of workers.entries()) {
      // Clean up completed workers that are older than AUTO_CLEANUP_DELAY_MS
      if (worker.status === 'completed' && worker.completedAt) {
        const completedAge = now - new Date(worker.completedAt).getTime();
        if (completedAge > AUTO_CLEANUP_DELAY_MS + 10000) { // 10s buffer
          workersToClean.push({ id, reason: 'completed', label: worker.label });
        }
      }

      // Clean up stale running workers (no activity for 30+ minutes)
      if (worker.status === 'running' && worker.lastActivity) {
        const inactiveTime = now - new Date(worker.lastActivity).getTime();
        if (inactiveTime > STALE_WORKER_THRESHOLD_MS) {
          // Don't auto-kill, just log a warning - stale workers might be doing long tasks
          console.warn(`[PeriodicCleanup] Worker ${id} (${worker.label}) has been inactive for ${Math.round(inactiveTime / 60000)} minutes`);
        }
      }
    }

    // Perform cleanup
    for (const { id, reason, label } of workersToClean) {
      try {
        console.log(`[PeriodicCleanup] Cleaning up ${reason} worker ${id} (${label})`);
        await killWorker(id, io);
      } catch (error) {
        console.error(`[PeriodicCleanup] Failed to cleanup worker ${id}:`, error.message);
      }
    }

    if (workersToClean.length > 0) {
      console.log(`[PeriodicCleanup] Cleaned up ${workersToClean.length} workers`);
    }
  }, 60000); // Run every 60 seconds

  // Allow Node.js to exit gracefully even if interval is running
  if (cleanupInterval.unref) {
    cleanupInterval.unref();
  }
}

/**
 * Stop the periodic cleanup sweep
 */
export function stopPeriodicCleanup() {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
    console.log('[PeriodicCleanup] Stopped');
  }
}

/**
 * Get current resource usage stats
 */
export function getResourceStats() {
  const allWorkers = Array.from(workers.values());
  const running = allWorkers.filter(w => w.status === 'running').length;
  const completed = allWorkers.filter(w => w.status === 'completed').length;
  const pending = pendingWorkers.size;

  return {
    running,
    completed,
    pending,
    total: allWorkers.length,
    maxConcurrent: MAX_CONCURRENT_WORKERS,
    availableSlots: Math.max(0, MAX_CONCURRENT_WORKERS - running)
  };
}

// Re-export workflow functions from dependency graph
export {
  createWorkflow,
  startWorkflow,
  getWorkflow,
  getWorkflows,
  getNextWorkflowTasks,
  getDependencyStats
};

// Export saveWorkerState for graceful shutdown
export { saveWorkerState };
