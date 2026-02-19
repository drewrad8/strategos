/**
 * Global setup for Playwright tests
 * ONLY cleans up stale TEST workers before running tests
 *
 * IMPORTANT: This must NOT kill user workers - only stale test workers
 */

const API_BASE = 'http://localhost:38007';
const API_KEY = process.env.STRATEGOS_API_KEY || '';

function authHeaders() {
  const headers = {};
  if (API_KEY) headers['Authorization'] = `Bearer ${API_KEY}`;
  return headers;
}

// Labels that indicate a worker was created by tests
// IMPORTANT: Only match labels with explicit test prefixes to avoid killing user workers
// All test workers MUST use the "TEST:" prefix in their labels
const TEST_WORKER_PATTERNS = [
  /^TEST:/i,           // Universal test prefix - all test workers should use this
];

function isTestWorker(worker) {
  // Check if the label matches any test pattern
  return TEST_WORKER_PATTERNS.some(pattern => pattern.test(worker.label));
}

async function globalSetup() {
  console.log('Global setup: Cleaning up stale workers...');

  try {
    // Get all existing workers
    const response = await fetch(`${API_BASE}/api/workers`, { headers: authHeaders() });
    if (!response.ok) {
      console.log('Server not ready or no workers to clean');
      return;
    }

    const workers = await response.json();

    if (workers.length === 0) {
      console.log('No workers to clean up');
      return;
    }

    // Filter to only test workers
    const testWorkers = workers.filter(isTestWorker);
    const userWorkers = workers.filter(w => !isTestWorker(w));

    if (userWorkers.length > 0) {
      console.log(`Preserving ${userWorkers.length} user worker(s): ${userWorkers.map(w => w.label).join(', ')}`);
    }

    if (testWorkers.length === 0) {
      console.log('No stale test workers to clean up');
      return;
    }

    console.log(`Cleaning up ${testWorkers.length} stale test workers`);

    // Kill only test workers
    for (const worker of testWorkers) {
      try {
        await fetch(`${API_BASE}/api/workers/${worker.id}`, {
          method: 'DELETE',
          headers: authHeaders()
        });
        console.log(`Killed stale test worker ${worker.id} (${worker.label})`);
      } catch (err) {
        console.log(`Failed to kill worker ${worker.id}: ${err.message}`);
      }
    }

    console.log('Global setup complete');
  } catch (err) {
    console.log(`Global setup error: ${err.message}`);
  }
}

export default globalSetup;
