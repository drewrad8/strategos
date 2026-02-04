/**
 * ClaudeProvider - Claude Code CLI provider
 *
 * Uses the Claude Code CLI (`claude`) for interactive worker sessions.
 * This is the primary/default worker provider for Strategos.
 */

import { CliProvider } from '../CliProvider.js';

export class ClaudeProvider extends CliProvider {
  constructor(config = {}) {
    super({
      id: 'claude',
      name: 'Claude Code',
      capabilities: {
        canSpawnWorkers: true,
        canComplete: false, // CLI doesn't expose completion API
        canStream: false,
        canFunctionCall: true, // Has tools
        maxTokens: 200000,
        supportsImages: true
      },
      ...config
    });
  }

  /**
   * Get spawn command for Claude Code
   */
  getSpawnCommand(options) {
    return {
      command: 'claude',
      args: [],
      env: {}
    };
  }

  /**
   * Get context file name - Claude Code auto-loads .claudecontext
   */
  getContextFileName() {
    return '.claudecontext';
  }

  /**
   * Generate the Strategos context file for Claude Code workers
   */
  generateContextFile(workerContext) {
    const {
      workerId,
      workerLabel,
      projectPath,
      ralphToken,
      strategosApiUrl = 'http://localhost:38007'
    } = workerContext;

    const isGeneral = workerLabel?.toUpperCase().startsWith('GENERAL:');
    const projectName = projectPath.split('/').pop();

    // Ralph mode section - only included if token provided
    const ralphSection = ralphToken ? `
- **Ralph Mode:** ENABLED
- **Ralph Token:** ${ralphToken}

### Task Completion Signaling
When your task is complete, signal via the Ralph API:
\`\`\`bash
# Signal task completed successfully
curl -s -X POST ${strategosApiUrl}/api/ralph/signal/${ralphToken} \\
  -H "Content-Type: application/json" \\
  -d '{"status": "done", "learnings": "Brief summary of what was accomplished"}'

# Or signal blocked if you cannot proceed
curl -s -X POST ${strategosApiUrl}/api/ralph/signal/${ralphToken} \\
  -H "Content-Type: application/json" \\
  -d '{"status": "blocked", "reason": "Description of what is blocking progress"}'
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

Instead, use the **Strategos API** at ${strategosApiUrl}

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
curl -s ${strategosApiUrl}/api/workers | jq '.'
\`\`\`

### Spawn a new worker
\`\`\`bash
curl -s -X POST ${strategosApiUrl}/api/workers \\
  -H "Content-Type: application/json" \\
  -d '{
    "projectPath": "${projectPath}",
    "label": "ROLE: Task Description",
    "parentWorkerId": "${workerId}",
    "parentLabel": "${workerLabel}",
    "autoAccept": true,
    "ralphMode": true,
    "task": {
      "description": "What to do and why",
      "type": "implementation|research|testing|review",
      "context": "Background info the worker needs"
    }
  }'
\`\`\`

**autoAccept**: When \`true\`, the worker automatically accepts permission prompts (y/n).
**ralphMode**: When \`true\`, enables autonomous completion signaling.

### Get worker output
\`\`\`bash
curl -s ${strategosApiUrl}/api/workers/{id}/output
\`\`\`

### Send input to a worker
\`\`\`bash
curl -s -X POST ${strategosApiUrl}/api/workers/{id}/input \\
  -H "Content-Type: application/json" \\
  -d '{"input": "your instructions"}'
\`\`\`

### Terminate a worker
\`\`\`bash
curl -s -X DELETE ${strategosApiUrl}/api/workers/{id}
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
   * Claude-specific auto-accept patterns
   */
  getAutoAcceptPatterns() {
    return [
      /\[Y\/n\]/i,
      /\[y\/N\]/i,
      /\(Y\)es/i,
      /Do you want to proceed/i,
      /Do you want to make this edit/i,
      /Do you want to create/i,
      /Do you want to overwrite/i,
      /Allow (this|once|always)/i,
      /Yes.*to (allow|proceed|continue)/i,
      /Press Enter to continue/i,
      /Do you want to (run|execute|allow)/i,
    ];
  }

  /**
   * Claude-specific pause keywords
   */
  getAutoAcceptPauseKeywords() {
    return [
      'plan mode',
      'ExitPlanMode',
      'AskUserQuestion',
      'EnterPlanMode',
    ];
  }

  /**
   * Check if Claude Code CLI is installed
   */
  async checkHealth() {
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);

    try {
      const { stdout } = await execAsync('claude --version 2>/dev/null || claude -v 2>/dev/null || which claude');
      return {
        available: true,
        command: 'claude',
        details: { version: stdout.trim() }
      };
    } catch (error) {
      return {
        available: false,
        error: 'Claude Code CLI not found. Install from: https://github.com/anthropics/claude-code',
        command: 'claude'
      };
    }
  }
}

export default ClaudeProvider;
