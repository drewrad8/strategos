#!/usr/bin/env node
/**
 * Self-test script for summary service quality
 *
 * Usage: node test-summary.js [--verbose]
 *
 * Tests:
 * 1. Ollama connectivity and model availability
 * 2. Summary generation against live workers
 * 3. Quality checks on summary output
 */

const API_BASE = process.env.API_BASE || 'http://localhost:38007';
const VERBOSE = process.argv.includes('--verbose') || process.argv.includes('-v');

function log(msg) {
  console.log(msg);
}

function verbose(msg) {
  if (VERBOSE) console.log(`  ${msg}`);
}

function pass(test) {
  console.log(`✓ ${test}`);
}

function fail(test, reason) {
  console.log(`✗ ${test}`);
  console.log(`  → ${reason}`);
}

function warn(test, reason) {
  console.log(`⚠ ${test}`);
  console.log(`  → ${reason}`);
}

const API_KEY = process.env.STRATEGOS_API_KEY || '';

async function fetchJson(path) {
  const headers = {};
  if (API_KEY) headers['Authorization'] = `Bearer ${API_KEY}`;
  const res = await fetch(`${API_BASE}${path}`, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

async function testOllamaHealth() {
  log('\n── Ollama Health ──');
  try {
    const health = await fetchJson('/api/ollama/health');
    verbose(`Model: ${health.model}`);
    verbose(`Available: ${health.available}`);
    verbose(`Model available: ${health.modelAvailable}`);

    if (!health.available) {
      fail('Ollama connectivity', 'Ollama is not running');
      return false;
    }
    pass('Ollama connectivity');

    if (!health.modelAvailable) {
      fail('Model availability', `Model ${health.model} not found in Ollama`);
      return false;
    }
    pass(`Model available (${health.model})`);
    return true;
  } catch (e) {
    fail('Ollama health check', e.message);
    return false;
  }
}

async function testSummaryQuality() {
  log('\n── Summary Quality ──');

  // Get workers
  let workers;
  try {
    workers = await fetchJson('/api/workers');
    verbose(`Found ${workers.length} worker(s)`);
  } catch (e) {
    fail('Worker list', e.message);
    return false;
  }

  if (workers.length === 0) {
    warn('Summary test', 'No workers running - spawn a worker to test summaries');
    return true;
  }

  let allPassed = true;

  for (const worker of workers) {
    log(`\n  Worker: ${worker.label || worker.id}`);

    // Get raw output for comparison
    let output;
    try {
      const outputRes = await fetchJson(`/api/workers/${worker.id}/output`);
      output = outputRes.output || '';
      verbose(`Output length: ${output.length} chars`);
    } catch (e) {
      fail(`  Get output`, e.message);
      allPassed = false;
      continue;
    }

    if (output.length < 100) {
      warn(`  Output check`, 'Very little output - summary may be limited');
    }

    // Get summary with forced refresh
    let summary;
    try {
      const start = Date.now();
      summary = await fetchJson(`/api/workers/${worker.id}/summary?refresh=true`);
      const duration = Date.now() - start;
      verbose(`Summary generated in ${duration}ms`);

      if (duration > 10000) {
        warn(`  Response time`, `Slow: ${duration}ms (>10s)`);
      } else {
        pass(`  Response time (${duration}ms)`);
      }
    } catch (e) {
      fail(`  Generate summary`, e.message);
      allPassed = false;
      continue;
    }

    // Quality checks
    const checks = [
      {
        name: 'Has task',
        test: () => summary.task && summary.task !== 'Unknown' && summary.task.length > 5,
        value: () => summary.task
      },
      {
        name: 'Has valid status',
        test: () => ['idle', 'thinking', 'coding', 'running_command', 'waiting_input', 'error'].includes(summary.status),
        value: () => summary.status
      },
      {
        name: 'Has lastAction',
        test: () => summary.lastAction && (summary.lastAction.length > 5 || summary.lastAction === 'Bash'),
        value: () => summary.lastAction
      },
      {
        name: 'Has summary text',
        test: () => summary.summary && summary.summary.length > 20,
        value: () => summary.summary?.slice(0, 80) + '...'
      },
      {
        name: 'Has recentProgress',
        test: () => Array.isArray(summary.recentProgress) && summary.recentProgress.length > 0,
        value: () => `${summary.recentProgress?.length || 0} items`
      },
      {
        name: 'pendingItems matches status',
        test: () => {
          if (summary.status === 'waiting_input') {
            return Array.isArray(summary.pendingItems) && summary.pendingItems.length > 0;
          }
          return true; // Not waiting, so no requirement
        },
        value: () => summary.status === 'waiting_input'
          ? (summary.pendingItems?.join(', ') || 'MISSING')
          : 'N/A (not waiting)'
      }
    ];

    for (const check of checks) {
      if (check.test()) {
        pass(`  ${check.name}`);
        verbose(`    ${check.value()}`);
      } else {
        fail(`  ${check.name}`, check.value() || 'empty/missing');
        allPassed = false;
      }
    }

    // Cross-check: if output contains "Do you want to proceed" status should be waiting_input
    if (output.includes('Do you want to proceed') || output.includes('Esc to exit')) {
      if (summary.status === 'waiting_input') {
        pass(`  Status detection (waiting_input)`);
      } else {
        fail(`  Status detection`, `Output shows prompt but status is "${summary.status}"`);
        allPassed = false;
      }
    }

    // Print full summary in verbose mode
    if (VERBOSE) {
      log('\n  Full summary:');
      console.log(JSON.stringify(summary, null, 2).split('\n').map(l => `    ${l}`).join('\n'));
    }
  }

  return allPassed;
}

async function main() {
  log('Strategos Summary Service Self-Test');
  log('====================================');
  log(`API: ${API_BASE}`);
  log(`Verbose: ${VERBOSE}`);

  const ollamaOk = await testOllamaHealth();
  if (!ollamaOk) {
    log('\n❌ Ollama checks failed - fix before testing summaries');
    process.exit(1);
  }

  const summaryOk = await testSummaryQuality();

  log('\n────────────────────');
  if (summaryOk) {
    log('✓ All tests passed');
    process.exit(0);
  } else {
    log('✗ Some tests failed');
    process.exit(1);
  }
}

main().catch(e => {
  console.error('Test error:', e);
  process.exit(1);
});
