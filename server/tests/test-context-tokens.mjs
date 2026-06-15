import assert from 'assert';

/**
 * Unit test for PR1 context token capture feature.
 * Tests the regex and parsing logic for detecting "/clear to save N.Nk tokens" messages
 * from Claude Code's idle status bar.
 */

// The regex from output.js line 526
const TOKEN_PATTERN = /\/clear to save ([\d.]+)k?\s*tokens/i;

function testContextTokenParsing() {
  const tests = [
    {
      name: 'Valid: 234.5k tokens (with k)',
      output: 'some output /clear to save 234.5k tokens here',
      expected: 234.5,
      shouldMatch: true
    },
    {
      name: 'Valid: 234.5 tokens (without k)',
      output: 'some output /clear to save 234.5 tokens here',
      expected: 234.5,
      shouldMatch: true
    },
    {
      name: 'Valid: 1000k tokens (large number)',
      output: '/clear to save 1000k tokens',
      expected: 1000,
      shouldMatch: true
    },
    {
      name: 'Valid: 0.5k tokens (fractional)',
      output: '/clear to save 0.5k tokens',
      expected: 0.5,
      shouldMatch: true
    },
    {
      name: 'Valid: case insensitive (uppercase CLEAR)',
      output: '/CLEAR to save 500k tokens',
      expected: 500,
      shouldMatch: true
    },
    {
      name: 'Invalid: missing /clear prefix',
      output: 'clear to save 234.5k tokens',
      expected: null,
      shouldMatch: false
    },
    {
      name: 'Invalid: no pattern present',
      output: 'worker output with no token info',
      expected: null,
      shouldMatch: false
    },
    {
      name: 'Invalid: malformed (no number)',
      output: '/clear to save k tokens',
      expected: null,
      shouldMatch: false
    },
    {
      name: 'Valid: extra whitespace',
      output: '/clear to save 456.7k  tokens',
      expected: 456.7,
      shouldMatch: true
    }
  ];

  let passed = 0;
  let failed = 0;

  for (const test of tests) {
    const match = test.output.match(TOKEN_PATTERN);

    if (test.shouldMatch) {
      if (!match) {
        console.error(`❌ FAIL: ${test.name}`);
        console.error(`  Expected match but got null`);
        console.error(`  Output: "${test.output}"`);
        failed++;
        continue;
      }

      const value = parseFloat(match[1]);
      if (value !== test.expected) {
        console.error(`❌ FAIL: ${test.name}`);
        console.error(`  Expected parseFloat(${match[1]}) === ${test.expected}`);
        console.error(`  Got: ${value}`);
        failed++;
        continue;
      }

      console.log(`✓ PASS: ${test.name} → ${value}`);
      passed++;
    } else {
      if (match) {
        console.error(`❌ FAIL: ${test.name}`);
        console.error(`  Expected no match but got: "${match[0]}"`);
        console.error(`  Output: "${test.output}"`);
        failed++;
        continue;
      }

      console.log(`✓ PASS: ${test.name} (correctly rejected)`);
      passed++;
    }
  }

  console.log(`\n════════════════════════════════════════`);
  console.log(`Test Results: ${passed} passed, ${failed} failed`);
  console.log(`════════════════════════════════════════\n`);

  return failed === 0;
}

// Worker state simulation test
function testWorkerStateIntegration() {
  console.log('Testing worker state integration...\n');

  // Simulate a minimal worker object
  const mockWorker = {
    id: 'test-worker-123',
    label: 'TEST: context-token-verify',
    autoContinue: true,
    backend: 'claude' // Not gemini or aider
  };

  // Simulate detectSessionLimits behavior
  function simulateDetectSessionLimits(worker, stdout) {
    const tail = stdout.slice(-1500);
    const tokenMatch = tail.match(TOKEN_PATTERN);

    if (tokenMatch) {
      worker.contextTokens = parseFloat(tokenMatch[1]);
      worker.contextTokensUpdatedAt = Date.now();
      return { contextTokens: worker.contextTokens, success: true };
    }
    return { contextTokens: null, success: false };
  }

  // Test 1: Token detection with realistic tmux output
  const realisticOutput = `
    [16:32:14] Worker active
    status bar: /clear to save 456.2k tokens
  `;

  const result1 = simulateDetectSessionLimits(mockWorker, realisticOutput);
  assert.strictEqual(result1.contextTokens, 456.2, 'Should parse 456.2k tokens');
  assert.strictEqual(result1.success, true, 'Should detect tokens');
  console.log('✓ PASS: Realistic tmux output detection');

  // Test 2: No token info present
  const noTokenOutput = `
    [16:32:14] Worker active
    Processing task...
    Done.
  `;

  const result2 = simulateDetectSessionLimits(mockWorker, noTokenOutput);
  assert.strictEqual(result2.contextTokens, null, 'Should not set contextTokens');
  assert.strictEqual(result2.success, false, 'Should not detect tokens');
  console.log('✓ PASS: No token info (correctly returns null)');

  // Test 3: Token value 0
  const zeroOutput = '/clear to save 0k tokens';
  const result3 = simulateDetectSessionLimits(mockWorker, zeroOutput);
  assert.strictEqual(result3.contextTokens, 0, 'Should parse 0 as valid');
  console.log('✓ PASS: Zero token count');

  console.log('\n════════════════════════════════════════');
  console.log('Worker integration tests: ALL PASSED');
  console.log('════════════════════════════════════════\n');

  return true;
}

// Run all tests
try {
  const parsingPassed = testContextTokenParsing();
  const integrationPassed = testWorkerStateIntegration();

  if (parsingPassed && integrationPassed) {
    console.log('🟢 ALL TESTS PASSED\n');
    process.exit(0);
  } else {
    console.log('🔴 SOME TESTS FAILED\n');
    process.exit(1);
  }
} catch (err) {
  console.error('💥 Test execution error:', err);
  process.exit(1);
}
