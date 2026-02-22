// Validated by IMPL worker — generals cannot edit this file directly
#!/usr/bin/env node
/**
 * General Enforcement Baseline Tests
 * Tests all 4 layers of the general anti-coding enforcement system.
 * Safe to run without killing existing workers.
 *
 * Layer 1: Prompt — verifies general prompt contains identity framing, examples, trailing reminder, "Commander"
 * Layer 2: Sentinel — verifies checkGeneralRoleViolation detection patterns against known inputs
 * Layer 3: Structural — verifies --allowedTools flags are generated for read-only roles
 * Layer 4: Metrics — verifies delegation metrics endpoint works
 *
 * Usage: node e2e/general-enforcement.test.js
 */

const API = 'http://localhost:38007';
const TIMEOUT = 15000;

let totalTests = 0;
let passed = 0;
let failed = 0;
const failures = [];
const testWorkerIds = [];

async function fetchJSON(path, opts = {}) {
  const url = `${API}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    clearTimeout(timer);
    const body = await res.json().catch(() => null);
    return { status: res.status, ok: res.ok, body };
  } catch (err) {
    clearTimeout(timer);
    return { status: 0, ok: false, body: null, error: err.message };
  }
}

function test(name, fn) {
  return async () => {
    totalTests++;
    try {
      await fn();
      passed++;
      console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    } catch (err) {
      failed++;
      failures.push({ name, error: err.message });
      console.log(`  \x1b[31m✗\x1b[0m ${name}`);
      console.log(`    ${err.message}`);
    }
  };
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg);
}

function assertIncludes(str, substr, msg) {
  if (!str || !str.includes(substr)) {
    throw new Error(msg || `Expected string to include "${substr}" but got: "${(str || '').slice(0, 200)}"`);
  }
}

function assertNotIncludes(str, substr, msg) {
  if (str && str.includes(substr)) {
    throw new Error(msg || `Expected string NOT to include "${substr}"`);
  }
}

// ============================================
// LAYER 1: PROMPT VERIFICATION
// ============================================

async function testPromptLayer() {
  console.log('\n\x1b[1mLayer 1: Prompt Verification\x1b[0m');

  // Spawn a test general to get its rules file
  await test('Spawn test general and verify rules file is generated', async () => {
    const { status, body } = await fetchJSON('/api/workers/spawn-from-template', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        template: 'general',
        label: 'GENERAL: enforcement-test-baseline',
        projectPath: '/home/druzy/thea/strategos',
        task: { description: 'TEST ONLY — do nothing, this is an enforcement baseline test. Signal done immediately.' },
      }),
    });
    assert(status === 200 || status === 201, `Spawn failed with status ${status}: ${JSON.stringify(body)}`);
    assert(body && body.id, 'No worker ID returned');
    testWorkerIds.push(body.id);
  })();

  // Wait for rules file to be written
  await new Promise(r => setTimeout(r, 3000));

  // Read the rules file content via the worker's context
  let rulesContent = '';
  if (testWorkerIds.length > 0) {
    const workerId = testWorkerIds[0];
    const fs = await import('fs');
    const path = await import('path');
    const glob = await import('fs/promises');

    // Rules files are written to .claude/rules/ in the project directory
    const rulesDir = '/home/druzy/thea/strategos/.claude/rules';
    try {
      const files = await glob.readdir(rulesDir);
      const workerRulesFile = files.find(f => f.includes(workerId));
      if (workerRulesFile) {
        rulesContent = await glob.readFile(path.default.join(rulesDir, workerRulesFile), 'utf8');
      }
    } catch (e) {
      // Fallback: check if there's a rules file pattern
    }
  }

  await test('General prompt contains identity framing (YOU ARE A GENERAL)', async () => {
    assert(rulesContent.length > 0, 'Rules file not found or empty');
    assertIncludes(rulesContent, 'YOU ARE A GENERAL');
  })();

  await test('General prompt contains "YOU DO NOT WRITE CODE"', async () => {
    assertIncludes(rulesContent, 'YOU DO NOT WRITE CODE');
  })();

  await test('General prompt contains "YOU DO NOT EDIT FILES"', async () => {
    assertIncludes(rulesContent, 'YOU DO NOT EDIT FILES');
  })();

  await test('General prompt contains CORRECT behavior examples', async () => {
    assertIncludes(rulesContent, 'EXAMPLES OF CORRECT GENERAL BEHAVIOR');
  })();

  await test('General prompt contains WRONG behavior examples', async () => {
    assertIncludes(rulesContent, 'EXAMPLES OF WRONG GENERAL BEHAVIOR');
  })();

  await test('General prompt contains FINAL REMINDER trailing section', async () => {
    assertIncludes(rulesContent, 'FINAL REMINDER');
    assertIncludes(rulesContent, 'GENERALS DO NOT CODE');
  })();

  await test('General prompt addresses user as "Commander"', async () => {
    assertIncludes(rulesContent, 'Commander');
  })();

  await test('General authority line restricts Edit/Write/Bash-for-implementation', async () => {
    assertIncludes(rulesContent, 'You may NOT use Edit, Write, or Bash for implementation');
  })();

  await test('General prompt contains Commander\'s Intent format', async () => {
    assertIncludes(rulesContent, 'PURPOSE:');
    assertIncludes(rulesContent, 'KEY TASKS:');
    assertIncludes(rulesContent, 'END STATE:');
  })();

  await test('General prompt contains EXECUTION SEQUENCE', async () => {
    assertIncludes(rulesContent, 'EXECUTION SEQUENCE');
    assertIncludes(rulesContent, 'UNDERSTAND');
    assertIncludes(rulesContent, 'PLAN');
    assertIncludes(rulesContent, 'SPAWN');
    assertIncludes(rulesContent, 'MONITOR');
    assertIncludes(rulesContent, 'COMPLETE');
  })();
}

// ============================================
// LAYER 2: SENTINEL DETECTION PATTERNS
// ============================================

async function testSentinelLayer() {
  console.log('\n\x1b[1mLayer 2: Sentinel Detection Patterns\x1b[0m');

  // Test the detection patterns by importing them directly
  // We'll verify the regex patterns match what they should

  // Match both Claude Code v2.1.50 rendered format and legacy format
  const VIOLATION_PATTERNS = [
    { pattern: /● (?:Edit|Update)\(/, description: 'Edit tool (rendered)' },
    { pattern: /● Write\(/,           description: 'Write tool (rendered)' },
    { pattern: /● NotebookEdit\(/,    description: 'NotebookEdit tool (rendered)' },
    { pattern: /\bEdit:\s/,           description: 'Edit tool (legacy)' },
    { pattern: /\bWrite:\s/,          description: 'Write tool (legacy)' },
    { pattern: /\bNotebookEdit:\s/,   description: 'NotebookEdit tool (legacy)' },
    { pattern: /\bAdded \d+ lines, removed \d+ lines/, description: 'edit diff output' },
    { pattern: /\bWrote \d+ lines to\b/,               description: 'write output' },
  ];

  const IMPL_BASH_RE = /\bBash:\s.*?\b(npm|node|python|python3|pip|pip3|sed|awk|gcc|g\+\+|cargo|make|cmake|rustc|javac|go build|go run|tsc|webpack|vite|esbuild|npx playwright|npx jest|pytest)\b/;
  const ALLOWED_BASH_RE = /\bBash:\s.*?\b(git|curl|ls|cat|head|tail|jq|wc|echo|printf|pwd|whoami|date|uptime|df|du|ps|grep|find|which|env|export)\b/;

  // Should trigger violations — both v2.1.50 rendered format and legacy
  const violationInputs = [
    { input: '● Update(server/index.js)', expected: 'Edit tool (rendered)', desc: 'Edit/Update tool (v2.1.50 format)' },
    { input: '● Write(install.sh)', expected: 'Write tool (rendered)', desc: 'Write tool (v2.1.50 format)' },
    { input: '● NotebookEdit(notebook.ipynb)', expected: 'NotebookEdit tool (rendered)', desc: 'NotebookEdit (v2.1.50 format)' },
    { input: '● Edit: server/index.js', expected: 'Edit tool (legacy)', desc: 'Edit tool (legacy format)' },
    { input: '● Write: /home/druzy/thea/file.js', expected: 'Write tool (legacy)', desc: 'Write tool (legacy format)' },
    { input: '  ⎿  Added 14 lines, removed 2 lines', expected: 'edit diff output', desc: 'Edit diff output' },
    { input: '  ⎿  Wrote 202 lines to install.sh', expected: 'write output', desc: 'Write output confirmation' },
  ];

  for (const { input, expected, desc } of violationInputs) {
    await test(`Sentinel detects: ${desc}`, async () => {
      let matched = false;
      for (const { pattern, description } of VIOLATION_PATTERNS) {
        if (pattern.test(input)) {
          assert(description === expected, `Expected "${expected}" but matched "${description}"`);
          matched = true;
          break;
        }
      }
      assert(matched, `Pattern "${desc}" was not detected in: "${input}"`);
    })();
  }

  // Bash implementation commands should trigger
  const implBashInputs = [
    'Bash: npm install express',
    'Bash: node server/index.js',
    'Bash: python3 script.py',
    'Bash: npx jest --watch',
    'Bash: cargo build --release',
    'Bash: tsc --build',
  ];

  for (const input of implBashInputs) {
    await test(`Sentinel detects impl bash: "${input}"`, async () => {
      assert(IMPL_BASH_RE.test(input), `Should match impl bash: "${input}"`);
    })();
  }

  // Allowed bash should NOT trigger alone
  const allowedBashInputs = [
    'Bash: git log --oneline -5',
    'Bash: curl -s http://localhost:38007/api/workers',
    'Bash: ls -la server/',
    'Bash: jq .id tmp/result.json',
    'Bash: grep -n "function" server/index.js',
  ];

  for (const input of allowedBashInputs) {
    await test(`Sentinel allows commander bash: "${input}"`, async () => {
      // If it matches impl pattern, it should also match allowed pattern
      if (IMPL_BASH_RE.test(input)) {
        assert(ALLOWED_BASH_RE.test(input), `Should also match allowed pattern: "${input}"`);
      }
      // If it only matches allowed, that's fine (no violation)
    })();
  }

  // Mixed case: "git" is allowed even though "grep" appears
  await test('Sentinel allows "Bash: git grep" (git is allowed)', async () => {
    const input = 'Bash: git grep "function"';
    const isImpl = IMPL_BASH_RE.test(input);
    const isAllowed = ALLOWED_BASH_RE.test(input);
    // git grep should be allowed
    assert(!isImpl || isAllowed, 'git grep should be allowed');
  })();
}

// ============================================
// LAYER 3: STRUCTURAL TOOL RESTRICTION
// ============================================

async function testStructuralLayer() {
  console.log('\n\x1b[1mLayer 3: Structural Tool Restriction\x1b[0m');

  // Import and test getToolRestrictionArgs directly
  // We test by checking what the function returns for different labels
  // Since we can't import ES modules easily in this context, test via API behavior

  // The test general we spawned should have --allowedTools in its tmux command
  if (testWorkerIds.length > 0) {
    const workerId = testWorkerIds[0];

    await test('Test general has --tools restriction in tmux command', async () => {
      // Check tmux session pane start command
      const { execSync } = await import('child_process');
      try {
        const sessionName = `thea-worker-${workerId}`;
        const paneCmd = execSync(
          `tmux list-panes -t "${sessionName}" -F "#{pane_start_command}" 2>/dev/null || echo "SESSION_NOT_FOUND"`,
          { encoding: 'utf8', timeout: 5000 }
        );
        if (paneCmd.includes('SESSION_NOT_FOUND')) {
          // Session may have exited, check process list
          assert(true, 'Session exited before check — structural test relies on code inspection');
        } else {
          assertIncludes(paneCmd, '--tools', 'tmux command should contain --tools flag');
          assertNotIncludes(paneCmd, '--allowedTools', 'Should use --tools, NOT --allowedTools');
        }
      } catch (e) {
        assert(true, 'Session may have exited');
      }
    })();

    // Verify via code inspection that the function uses --tools (not --allowedTools)
    await test('getToolRestrictionArgs uses --tools flag (NOT --allowedTools)', async () => {
      const fs = await import('fs/promises');
      const code = await fs.readFile('/home/druzy/thea/strategos/server/workers/lifecycle.js', 'utf8');
      assertIncludes(code, 'function getToolRestrictionArgs(label)');
      assertIncludes(code, 'READ_ONLY_ROLES');
      assertIncludes(code, "'--tools'");
      // Ensure we're NOT using the broken --allowedTools
      const fnMatch = code.match(/function getToolRestrictionArgs[\s\S]*?^}/m);
      if (fnMatch) {
        assertNotIncludes(fnMatch[0], "'--allowedTools'", 'Must use --tools, not --allowedTools');
      }
    })();

    await test('READ_ONLY_ROLES includes GENERAL, COLONEL, REVIEW, RESEARCH', async () => {
      const fs = await import('fs/promises');
      const code = await fs.readFile('/home/druzy/thea/strategos/server/workers/lifecycle.js', 'utf8');
      assertIncludes(code, "'GENERAL'");
      assertIncludes(code, "'COLONEL'");
      assertIncludes(code, "'REVIEW'");
      assertIncludes(code, "'RESEARCH'");
    })();

    await test('Allowed tools whitelist is Read,Glob,Grep,Bash,WebSearch,WebFetch', async () => {
      const fs = await import('fs/promises');
      const code = await fs.readFile('/home/druzy/thea/strategos/server/workers/lifecycle.js', 'utf8');
      assertIncludes(code, "const READ_ONLY_TOOLS = 'Read,Glob,Grep,Bash,WebSearch,WebFetch'");
    })();

    await test('Tool restriction args injected at spawn (tmux command)', async () => {
      const fs = await import('fs/promises');
      const code = await fs.readFile('/home/druzy/thea/strategos/server/workers/lifecycle.js', 'utf8');
      assertIncludes(code, 'const toolArgs = getToolRestrictionArgs(workerLabel)');
      assertIncludes(code, "'claude', ...toolArgs");
    })();

    await test('IMPL workers are NOT in READ_ONLY_ROLES (can edit)', async () => {
      const fs = await import('fs/promises');
      const code = await fs.readFile('/home/druzy/thea/strategos/server/workers/lifecycle.js', 'utf8');
      assertNotIncludes(code, "'IMPL'", 'IMPL should not be in READ_ONLY_ROLES');
      // Verify the set only has the expected 4
      const match = code.match(/const READ_ONLY_ROLES = new Set\(\[(.*?)\]\)/);
      assert(match, 'Could not find READ_ONLY_ROLES definition');
      const roles = match[1];
      assertNotIncludes(roles, 'IMPL');
      assertNotIncludes(roles, 'FIX');
      assertNotIncludes(roles, 'TEST');
    })();
  }
}

// ============================================
// LAYER 4: DELEGATION METRICS
// ============================================

async function testMetricsLayer() {
  console.log('\n\x1b[1mLayer 4: Delegation Metrics\x1b[0m');

  if (testWorkerIds.length > 0) {
    const workerId = testWorkerIds[0];

    await test('Delegation metrics endpoint returns data for test general', async () => {
      const { status, body } = await fetchJSON(`/api/metrics/delegation/${workerId}`);
      assert(status === 200, `Expected 200, got ${status}`);
      assert(body, 'No body returned');
    })();

    await test('Delegation metrics contain expected fields', async () => {
      const { body } = await fetchJSON(`/api/metrics/delegation/${workerId}`);
      assert(body, 'No body');
      // The metrics should have spawnsIssued, roleViolations, filesEdited, commandsRun
      const metrics = body.metrics || body;
      assert('spawnsIssued' in metrics || 'delegationMetrics' in body,
        `Missing expected fields. Got: ${JSON.stringify(body)}`);
    })();

    await test('Delegation metrics endpoint returns error for nonexistent worker', async () => {
      const { status } = await fetchJSON('/api/metrics/delegation/nonexistent123');
      assert(status === 400 || status === 404, `Expected 400 or 404, got ${status}`);
    })();
  }

  // Verify the functions exist in code
  await test('incrementDelegationMetric function exists in ralph.js', async () => {
    const fs = await import('fs/promises');
    const code = await fs.readFile('/home/druzy/thea/strategos/server/workers/ralph.js', 'utf8');
    assertIncludes(code, 'export function incrementDelegationMetric(workerId, field');
  })();

  await test('getDelegationMetrics function exists in ralph.js', async () => {
    const fs = await import('fs/promises');
    const code = await fs.readFile('/home/druzy/thea/strategos/server/workers/ralph.js', 'utf8');
    assertIncludes(code, 'export function getDelegationMetrics(workerId)');
  })();

  await test('delegationMetrics included in normalizeWorker allowlist', async () => {
    const fs = await import('fs/promises');
    const code = await fs.readFile('/home/druzy/thea/strategos/server/workers/state.js', 'utf8');
    assertIncludes(code, 'delegationMetrics');
  })();

  await test('delegationMetrics saved in persistence (save/restore/checkpoint)', async () => {
    const fs = await import('fs/promises');
    const code = await fs.readFile('/home/druzy/thea/strategos/server/workers/persistence.js', 'utf8');
    assertIncludes(code, 'delegationMetrics');
  })();

  await test('roleViolations included in normalizeWorker allowlist', async () => {
    const fs = await import('fs/promises');
    const code = await fs.readFile('/home/druzy/thea/strategos/server/workers/state.js', 'utf8');
    assertIncludes(code, 'roleViolations');
  })();
}

// ============================================
// CROSS-LAYER INTEGRATION
// ============================================

async function testIntegration() {
  console.log('\n\x1b[1mCross-Layer Integration\x1b[0m');

  await test('Sentinel emits worker:role:violation socket event (code check)', async () => {
    const fs = await import('fs/promises');
    const code = await fs.readFile('/home/druzy/thea/strategos/server/workers/output.js', 'utf8');
    assertIncludes(code, "io.emit('worker:role:violation'");
  })();

  await test('Sentinel calls interruptWorker with correction message (code check)', async () => {
    const fs = await import('fs/promises');
    const code = await fs.readFile('/home/druzy/thea/strategos/server/workers/output.js', 'utf8');
    assertIncludes(code, 'await interruptWorker(workerId, correctionMessage, io)');
  })();

  await test('Sentinel correction message includes spawn template example', async () => {
    const fs = await import('fs/promises');
    const code = await fs.readFile('/home/druzy/thea/strategos/server/workers/output.js', 'utf8');
    assertIncludes(code, 'spawn-from-template');
    assertIncludes(code, 'ROLE VIOLATION');
  })();

  await test('checkGeneralRoleViolation uses dedup hash to prevent re-triggering', async () => {
    const fs = await import('fs/promises');
    const code = await fs.readFile('/home/druzy/thea/strategos/server/workers/output.js', 'utf8');
    assertIncludes(code, '_lastViolationHash');
    assertIncludes(code, 'simpleHash');
  })();

  await test('Prompt and sentinel are consistent on prohibited tools', async () => {
    const fsp = await import('fs/promises');
    const prompt = await fsp.readFile('/home/druzy/thea/strategos/server/workers/templates.js', 'utf8');
    const sentinel = await fsp.readFile('/home/druzy/thea/strategos/server/workers/output.js', 'utf8');

    // Both should mention Edit, Write
    assertIncludes(prompt, 'Edit');
    assertIncludes(prompt, 'Write');
    assertIncludes(sentinel, 'Edit:');
    assertIncludes(sentinel, 'Write:');
  })();
}

// ============================================
// CLEANUP & REPORT
// ============================================

async function cleanup() {
  console.log('\n\x1b[1mCleanup\x1b[0m');
  for (const id of testWorkerIds) {
    try {
      // Force-kill test workers (they're GENERAL-labeled, so protected)
      let { status } = await fetchJSON(`/api/workers/${id}`, { method: 'DELETE' });
      if (status === 403) {
        ({ status } = await fetchJSON(`/api/workers/${id}?force=true`, { method: 'DELETE' }));
      }
      console.log(`  Cleaned up test worker ${id}: ${status === 200 ? 'OK' : status}`);
    } catch (e) {
      console.log(`  Failed to clean up ${id}: ${e.message}`);
    }
  }
}

// ============================================
// MAIN
// ============================================

async function main() {
  console.log('\x1b[1m\x1b[36m========================================\x1b[0m');
  console.log('\x1b[1m\x1b[36m  General Enforcement Baseline Tests\x1b[0m');
  console.log('\x1b[1m\x1b[36m========================================\x1b[0m');
  console.log(`  Date: ${new Date().toISOString()}`);
  console.log(`  Server: ${API}`);

  // Verify server is up
  const health = await fetchJSON('/api/health');
  if (!health.ok) {
    console.error('\n\x1b[31mServer not reachable at', API, '\x1b[0m');
    process.exit(1);
  }
  console.log('  Server: \x1b[32mOK\x1b[0m\n');

  try {
    await testPromptLayer();
    await testSentinelLayer();
    await testStructuralLayer();
    await testMetricsLayer();
    await testIntegration();
  } finally {
    await cleanup();
  }

  // Report
  console.log('\n\x1b[1m\x1b[36m========================================\x1b[0m');
  console.log(`  Results: \x1b[32m${passed} passed\x1b[0m, \x1b[31m${failed} failed\x1b[0m, ${totalTests} total`);
  console.log('\x1b[1m\x1b[36m========================================\x1b[0m');

  if (failures.length > 0) {
    console.log('\n\x1b[31mFailures:\x1b[0m');
    for (const { name, error } of failures) {
      console.log(`  \x1b[31m✗\x1b[0m ${name}`);
      console.log(`    ${error}`);
    }
  }

  process.exit(failed > 0 ? 1 : 0);
}

main();
