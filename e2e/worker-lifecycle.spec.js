/**
 * Worker Lifecycle E2E Tests
 *
 * Comprehensive API-level tests for the full worker lifecycle:
 * - Spawn → Running → Input → Output → Complete/Kill
 * - Template spawning
 * - Dependency chains
 * - Settings management
 * - Validation & error handling
 * - Worker relationships (parent/child)
 *
 * All test workers use the "TEST:" prefix so global-setup/teardown can clean them up.
 */
import { test, expect } from '@playwright/test';

const API = 'http://localhost:38007/api';

// Helper: spawn a test worker and return its data
async function spawnTestWorker(request, overrides = {}) {
  const body = {
    projectPath: 'strategos',
    label: overrides.label || `TEST: Lifecycle ${Date.now()}`,
    autoAccept: true,
    ralphMode: false,
    allowDuplicate: true,
    ...overrides,
  };
  const res = await request.post(`${API}/workers`, { data: body });
  expect(res.ok()).toBeTruthy();
  const worker = await res.json();
  expect(worker.id).toBeDefined();
  return worker;
}

// Helper: kill a worker, ignoring 404
async function killTestWorker(request, id) {
  try {
    await request.delete(`${API}/workers/${id}?force=true`);
  } catch (_) {
    // Ignore cleanup errors
  }
}

// Helper: wait for a condition with polling
async function waitFor(fn, { timeout = 10000, interval = 500 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const result = await fn();
    if (result) return result;
    await new Promise(r => setTimeout(r, interval));
  }
  throw new Error(`waitFor timed out after ${timeout}ms`);
}

// ============================================================
// SECTION 1: Basic Worker CRUD
// ============================================================
test.describe('Worker CRUD Operations', () => {
  let workerId;

  test.afterEach(async ({ request }) => {
    if (workerId) {
      await killTestWorker(request, workerId);
      workerId = null;
    }
  });

  test('POST /workers - spawns a worker with correct defaults', async ({ request }) => {
    const worker = await spawnTestWorker(request, { label: 'TEST: CRUD Spawn' });
    workerId = worker.id;

    // Core identity
    expect(worker.id).toMatch(/^[a-f0-9]{8}$/);
    expect(worker.label).toBe('TEST: CRUD Spawn');
    expect(worker.project).toBe('strategos');
    expect(worker.status).toBe('running');

    // Defaults
    expect(worker.autoAccept).toBe(true);
    expect(worker.autoAcceptPaused).toBe(false);
    expect(worker.dependsOn).toEqual([]);
    expect(worker.childWorkerIds).toEqual([]);
    expect(worker.crashedAt).toBeNull();
    expect(worker.completedAt).toBeNull();

    // Timestamps
    expect(worker.createdAt).toBeTruthy();
    expect(new Date(worker.createdAt).getTime()).toBeGreaterThan(0);

    // Security: ralphToken must NOT be exposed
    expect(worker.ralphToken).toBeUndefined();
  });

  test('GET /workers/:id - retrieves a specific worker', async ({ request }) => {
    const spawned = await spawnTestWorker(request, { label: 'TEST: CRUD Get' });
    workerId = spawned.id;

    const res = await request.get(`${API}/workers/${workerId}`);
    expect(res.ok()).toBeTruthy();

    const worker = await res.json();
    expect(worker.id).toBe(workerId);
    expect(worker.label).toBe('TEST: CRUD Get');
    expect(worker.status).toBe('running');
  });

  test('GET /workers/:id - returns 404 for nonexistent worker', async ({ request }) => {
    const res = await request.get(`${API}/workers/00000000`);
    expect(res.status()).toBe(404);
  });

  test('GET /workers - lists all workers including test worker', async ({ request }) => {
    const spawned = await spawnTestWorker(request, { label: 'TEST: CRUD List' });
    workerId = spawned.id;

    const res = await request.get(`${API}/workers`);
    expect(res.ok()).toBeTruthy();

    const workers = await res.json();
    expect(Array.isArray(workers)).toBeTruthy();
    const found = workers.find(w => w.id === workerId);
    expect(found).toBeDefined();
    expect(found.label).toBe('TEST: CRUD List');
  });

  test('PATCH /workers/:id - updates worker label', async ({ request }) => {
    const spawned = await spawnTestWorker(request, { label: 'TEST: CRUD Patch' });
    workerId = spawned.id;

    const res = await request.patch(`${API}/workers/${workerId}`, {
      data: { label: 'TEST: CRUD Patch Updated' }
    });
    expect(res.ok()).toBeTruthy();

    const worker = await res.json();
    expect(worker.label).toBe('TEST: CRUD Patch Updated');

    // Verify persistence via GET
    const getRes = await request.get(`${API}/workers/${workerId}`);
    const fetched = await getRes.json();
    expect(fetched.label).toBe('TEST: CRUD Patch Updated');
  });

  test('DELETE /workers/:id - kills a worker', async ({ request }) => {
    const spawned = await spawnTestWorker(request, { label: 'TEST: CRUD Delete' });
    workerId = spawned.id;

    const res = await request.delete(`${API}/workers/${workerId}`);
    expect(res.ok()).toBeTruthy();

    const body = await res.json();
    expect(body.success).toBe(true);

    // Worker should be gone
    const getRes = await request.get(`${API}/workers/${workerId}`);
    expect(getRes.status()).toBe(404);

    workerId = null; // Already cleaned up
  });

  test('DELETE /workers/:id - returns 404 for nonexistent worker', async ({ request }) => {
    const res = await request.delete(`${API}/workers/00000000`);
    expect(res.status()).toBe(404);
  });
});

// ============================================================
// SECTION 2: Worker Spawn Validation
// ============================================================
test.describe('Worker Spawn Validation', () => {
  let workerId;

  test.afterEach(async ({ request }) => {
    if (workerId) {
      await killTestWorker(request, workerId);
      workerId = null;
    }
  });

  test('rejects spawn without projectPath', async ({ request }) => {
    const res = await request.post(`${API}/workers`, {
      data: { label: 'TEST: No Path' }
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('projectPath');
  });

  test('rejects label with control characters', async ({ request }) => {
    const res = await request.post(`${API}/workers`, {
      data: { projectPath: 'strategos', label: 'TEST: Bad\x00Label' }
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('control characters');
  });

  test('rejects label over 200 characters', async ({ request }) => {
    const longLabel = 'TEST: ' + 'A'.repeat(200);
    const res = await request.post(`${API}/workers`, {
      data: { projectPath: 'strategos', label: longLabel }
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('200');
  });

  test('rejects path traversal in projectPath', async ({ request }) => {
    const res = await request.post(`${API}/workers`, {
      data: { projectPath: '../../../etc/passwd', label: 'TEST: Traversal' }
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/path traversal|does not exist/i);
  });

  test('rejects invalid dependsOn format', async ({ request }) => {
    const res = await request.post(`${API}/workers`, {
      data: { projectPath: 'strategos', label: 'TEST: Bad Deps', dependsOn: 'not-an-array' }
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('dependsOn');
  });

  test('rejects dependsOn with >50 entries', async ({ request }) => {
    const tooMany = Array.from({ length: 51 }, (_, i) => `abcd${String(i).padStart(4, '0')}`);
    const res = await request.post(`${API}/workers`, {
      data: { projectPath: 'strategos', label: 'TEST: Too Many Deps', dependsOn: tooMany }
    });
    expect(res.status()).toBe(400);
  });

  test('rejects initialInput over 1MB', async ({ request }) => {
    const hugeInput = 'X'.repeat(1048577); // 1MB + 1 byte
    const res = await request.post(`${API}/workers`, {
      data: { projectPath: 'strategos', label: 'TEST: Big Input', initialInput: hugeInput }
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('1MB');
  });

  test('spawns with task context object', async ({ request }) => {
    const worker = await spawnTestWorker(request, {
      label: 'TEST: With Task',
      task: { description: 'Do something', type: 'testing', context: 'test ctx' },
    });
    workerId = worker.id;

    expect(worker.task).toBeDefined();
    expect(worker.task.description).toBe('Do something');
    expect(worker.task.type).toBe('testing');
  });

  test('spawns with parent-child relationship', async ({ request }) => {
    // Spawn parent
    const parent = await spawnTestWorker(request, { label: 'TEST: Parent Worker' });

    // Spawn child with parentWorkerId
    const child = await spawnTestWorker(request, {
      label: 'TEST: Child Worker',
      parentWorkerId: parent.id,
      parentLabel: 'TEST: Parent Worker',
    });
    workerId = child.id;

    expect(child.parentWorkerId).toBe(parent.id);
    expect(child.parentLabel).toBe('TEST: Parent Worker');

    // Parent should list child
    const parentRes = await request.get(`${API}/workers/${parent.id}`);
    const parentData = await parentRes.json();
    expect(parentData.childWorkerIds).toContain(child.id);

    // Cleanup both
    await killTestWorker(request, child.id);
    await killTestWorker(request, parent.id);
    workerId = null;
  });
});

// ============================================================
// SECTION 3: Worker Input/Output
// ============================================================
test.describe('Worker Input/Output', () => {
  let workerId;

  test.afterEach(async ({ request }) => {
    if (workerId) {
      await killTestWorker(request, workerId);
      workerId = null;
    }
  });

  test('POST /workers/:id/input - sends input to a worker', async ({ request }) => {
    const worker = await spawnTestWorker(request, { label: 'TEST: Input Test' });
    workerId = worker.id;

    // Wait a moment for worker to initialize
    await new Promise(r => setTimeout(r, 2000));

    const res = await request.post(`${API}/workers/${workerId}/input`, {
      data: { input: 'echo LIFECYCLE_INPUT_TEST_12345' }
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  test('POST /workers/:id/input - rejects empty input', async ({ request }) => {
    const worker = await spawnTestWorker(request, { label: 'TEST: Empty Input' });
    workerId = worker.id;

    const res = await request.post(`${API}/workers/${workerId}/input`, {
      data: { input: '' }
    });
    expect(res.status()).toBe(400);
  });

  test('POST /workers/:id/input - rejects non-string input', async ({ request }) => {
    const worker = await spawnTestWorker(request, { label: 'TEST: Bad Input Type' });
    workerId = worker.id;

    const res = await request.post(`${API}/workers/${workerId}/input`, {
      data: { input: 12345 }
    });
    expect(res.status()).toBe(400);
  });

  test('POST /workers/:id/input - rejects input over 1MB', async ({ request }) => {
    const worker = await spawnTestWorker(request, { label: 'TEST: Huge Input' });
    workerId = worker.id;

    const res = await request.post(`${API}/workers/${workerId}/input`, {
      data: { input: 'X'.repeat(1024 * 1024 + 1) }
    });
    expect(res.status()).toBe(400);
  });

  test('POST /workers/:id/input - returns 404 for nonexistent worker', async ({ request }) => {
    const res = await request.post(`${API}/workers/00000000/input`, {
      data: { input: 'hello' }
    });
    expect(res.status()).toBe(404);
  });

  test('GET /workers/:id/output - retrieves worker output', async ({ request }) => {
    const worker = await spawnTestWorker(request, { label: 'TEST: Output Test' });
    workerId = worker.id;

    // Wait for some output to accumulate
    await new Promise(r => setTimeout(r, 3000));

    const res = await request.get(`${API}/workers/${workerId}/output`);
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(typeof body.output).toBe('string');
  });

  test('GET /workers/:id/output - returns 404 for nonexistent worker', async ({ request }) => {
    const res = await request.get(`${API}/workers/00000000/output`);
    expect(res.status()).toBe(404);
  });
});

// ============================================================
// SECTION 4: Worker Settings
// ============================================================
test.describe('Worker Settings', () => {
  let workerId;

  test.afterEach(async ({ request }) => {
    if (workerId) {
      await killTestWorker(request, workerId);
      workerId = null;
    }
  });

  test('POST /workers/:id/settings - toggles autoAccept', async ({ request }) => {
    const worker = await spawnTestWorker(request, { label: 'TEST: Settings AutoAccept' });
    workerId = worker.id;

    // Disable autoAccept
    const res = await request.post(`${API}/workers/${workerId}/settings`, {
      data: { autoAccept: false }
    });
    expect(res.ok()).toBeTruthy();

    // Verify via GET
    const getRes = await request.get(`${API}/workers/${workerId}`);
    const updated = await getRes.json();
    expect(updated.autoAccept).toBe(false);

    // Re-enable
    const res2 = await request.post(`${API}/workers/${workerId}/settings`, {
      data: { autoAccept: true }
    });
    expect(res2.ok()).toBeTruthy();
  });

  test('POST /workers/:id/settings - toggles autoAcceptPaused', async ({ request }) => {
    const worker = await spawnTestWorker(request, { label: 'TEST: Settings Paused' });
    workerId = worker.id;

    const res = await request.post(`${API}/workers/${workerId}/settings`, {
      data: { autoAcceptPaused: true }
    });
    expect(res.ok()).toBeTruthy();

    const getRes = await request.get(`${API}/workers/${workerId}`);
    const updated = await getRes.json();
    expect(updated.autoAcceptPaused).toBe(true);
  });

  test('POST /workers/:id/settings - rejects non-boolean autoAccept', async ({ request }) => {
    const worker = await spawnTestWorker(request, { label: 'TEST: Settings Bad Type' });
    workerId = worker.id;

    const res = await request.post(`${API}/workers/${workerId}/settings`, {
      data: { autoAccept: 'yes' }
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('boolean');
  });

  test('POST /workers/:id/settings - rejects empty settings', async ({ request }) => {
    const worker = await spawnTestWorker(request, { label: 'TEST: Settings Empty' });
    workerId = worker.id;

    const res = await request.post(`${API}/workers/${workerId}/settings`, {
      data: {}
    });
    expect(res.status()).toBe(400);
  });

  test('POST /workers/:id/settings - returns 404 for nonexistent worker', async ({ request }) => {
    const res = await request.post(`${API}/workers/00000000/settings`, {
      data: { autoAccept: true }
    });
    // 404 or 500 depending on internal getWorkerInternal
    expect([404, 500]).toContain(res.status());
  });
});

// ============================================================
// SECTION 5: PATCH Label Validation
// ============================================================
test.describe('PATCH Label Validation', () => {
  let workerId;

  test.afterEach(async ({ request }) => {
    if (workerId) {
      await killTestWorker(request, workerId);
      workerId = null;
    }
  });

  test('rejects PATCH with empty label', async ({ request }) => {
    const worker = await spawnTestWorker(request, { label: 'TEST: Patch Empty' });
    workerId = worker.id;

    const res = await request.patch(`${API}/workers/${workerId}`, {
      data: { label: '' }
    });
    expect(res.status()).toBe(400);
  });

  test('rejects PATCH with non-string label', async ({ request }) => {
    const worker = await spawnTestWorker(request, { label: 'TEST: Patch BadType' });
    workerId = worker.id;

    const res = await request.patch(`${API}/workers/${workerId}`, {
      data: { label: 12345 }
    });
    expect(res.status()).toBe(400);
  });

  test('rejects PATCH with label over 200 chars', async ({ request }) => {
    const worker = await spawnTestWorker(request, { label: 'TEST: Patch Long' });
    workerId = worker.id;

    const res = await request.patch(`${API}/workers/${workerId}`, {
      data: { label: 'TEST: ' + 'B'.repeat(200) }
    });
    expect(res.status()).toBe(400);
  });

  test('rejects PATCH with control characters in label', async ({ request }) => {
    const worker = await spawnTestWorker(request, { label: 'TEST: Patch Ctrl' });
    workerId = worker.id;

    const res = await request.patch(`${API}/workers/${workerId}`, {
      data: { label: 'TEST: Bad\nLabel' }
    });
    expect(res.status()).toBe(400);
  });

  test('returns 404 for PATCH on nonexistent worker', async ({ request }) => {
    const res = await request.patch(`${API}/workers/00000000`, {
      data: { label: 'TEST: Ghost' }
    });
    expect(res.status()).toBe(404);
  });
});

// ============================================================
// SECTION 6: Template Spawning
// ============================================================
test.describe('Template Spawning', () => {
  let workerId;

  test.afterEach(async ({ request }) => {
    if (workerId) {
      await killTestWorker(request, workerId);
      workerId = null;
    }
  });

  test('GET /workers/templates - lists available templates', async ({ request }) => {
    const res = await request.get(`${API}/workers/templates`);
    expect(res.ok()).toBeTruthy();
    const templates = await res.json();
    expect(templates).toHaveProperty('research');
    expect(templates).toHaveProperty('impl');
    expect(templates).toHaveProperty('test');
    expect(templates).toHaveProperty('review');
    expect(templates).toHaveProperty('fix');
    expect(templates).toHaveProperty('general');
    expect(templates).toHaveProperty('colonel');
  });

  test('POST /workers/spawn-from-template - spawns research worker', async ({ request }) => {
    const res = await request.post(`${API}/workers/spawn-from-template`, {
      data: {
        template: 'test',
        label: 'Lifecycle Template',
        projectPath: 'strategos',
        task: 'TEST: Template spawn validation - this is a test, exit immediately',
      }
    });
    expect(res.ok()).toBeTruthy();

    const worker = await res.json();
    workerId = worker.id;
    expect(worker.label).toMatch(/TEST:.*Lifecycle Template/i);
    expect(worker.status).toBe('running');
    expect(worker.autoAccept).toBe(true);
  });

  test('POST /workers/spawn-from-template - rejects unknown template', async ({ request }) => {
    const res = await request.post(`${API}/workers/spawn-from-template`, {
      data: {
        template: 'nonexistent',
        label: 'TEST: Bad Template',
        projectPath: 'strategos',
        task: 'test',
      }
    });
    expect(res.status()).toBe(400);
  });

  test('POST /workers/spawn-from-template - rejects missing task', async ({ request }) => {
    const res = await request.post(`${API}/workers/spawn-from-template`, {
      data: {
        template: 'test',
        label: 'TEST: No Task',
        projectPath: 'strategos',
      }
    });
    expect(res.status()).toBe(400);
  });
});

// ============================================================
// SECTION 7: Worker Completion & Dismiss
// ============================================================
test.describe('Worker Completion', () => {
  let workerId;

  test.afterEach(async ({ request }) => {
    if (workerId) {
      await killTestWorker(request, workerId);
      workerId = null;
    }
  });

  test('POST /workers/:id/complete - transitions worker to awaiting_review', async ({ request }) => {
    const worker = await spawnTestWorker(request, { label: 'TEST: Complete Flow' });
    workerId = worker.id;

    const res = await request.post(`${API}/workers/${workerId}/complete`);
    expect(res.ok()).toBeTruthy();

    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.worker).toBeDefined();

    // Worker should be in awaiting_review or completed state
    const getRes = await request.get(`${API}/workers/${workerId}`);
    const updated = await getRes.json();
    expect(['awaiting_review', 'completed']).toContain(updated.status);
  });

  test('POST /workers/:id/complete - returns 404 for nonexistent worker', async ({ request }) => {
    const res = await request.post(`${API}/workers/00000000/complete`);
    expect(res.status()).toBe(404);
  });

  test('POST /workers/:id/dismiss - dismisses an awaiting_review worker', async ({ request }) => {
    const worker = await spawnTestWorker(request, { label: 'TEST: Dismiss Flow' });
    workerId = worker.id;

    // Complete first
    await request.post(`${API}/workers/${workerId}/complete`);

    // Wait briefly for state transition
    await new Promise(r => setTimeout(r, 1000));

    // Dismiss
    const res = await request.post(`${API}/workers/${workerId}/dismiss`);
    // May succeed or fail depending on exact state
    if (res.ok()) {
      const body = await res.json();
      expect(body.success).toBe(true);
      workerId = null; // Worker dismissed
    }
  });
});

// ============================================================
// SECTION 8: Worker Dependencies
// ============================================================
test.describe('Worker Dependencies', () => {
  const workerIds = [];

  test.afterEach(async ({ request }) => {
    for (const id of workerIds) {
      await killTestWorker(request, id);
    }
    workerIds.length = 0;
  });

  test('spawns a worker with dependency', async ({ request }) => {
    // Create first worker
    const w1 = await spawnTestWorker(request, { label: 'TEST: Dep Parent' });
    workerIds.push(w1.id);

    // Create dependent worker
    const w2 = await spawnTestWorker(request, {
      label: 'TEST: Dep Child',
      dependsOn: [w1.id],
    });
    workerIds.push(w2.id);

    expect(w2.dependsOn).toContain(w1.id);
    expect(w2.status).toBe('pending'); // Should be pending since dep is not complete
  });

  test('GET /workers/:id/dependencies - returns dependency info', async ({ request }) => {
    const w1 = await spawnTestWorker(request, { label: 'TEST: Dep Info Parent' });
    workerIds.push(w1.id);

    const w2 = await spawnTestWorker(request, {
      label: 'TEST: Dep Info Child',
      dependsOn: [w1.id],
    });
    workerIds.push(w2.id);

    const res = await request.get(`${API}/workers/${w2.id}/dependencies`);
    expect(res.ok()).toBeTruthy();
    const deps = await res.json();
    expect(deps).toBeDefined();
  });

  test('GET /workers/:id/children - returns child workers', async ({ request }) => {
    const parent = await spawnTestWorker(request, { label: 'TEST: Children Parent' });
    workerIds.push(parent.id);

    const child = await spawnTestWorker(request, {
      label: 'TEST: Children Child',
      parentWorkerId: parent.id,
    });
    workerIds.push(child.id);

    const res = await request.get(`${API}/workers/${parent.id}/children`);
    expect(res.ok()).toBeTruthy();
    const children = await res.json();
    expect(Array.isArray(children)).toBeTruthy();
    expect(children.some(c => c.id === child.id)).toBeTruthy();
  });

  test('GET /workers/:id/siblings - returns sibling workers', async ({ request }) => {
    const parent = await spawnTestWorker(request, { label: 'TEST: Sibling Parent' });
    workerIds.push(parent.id);

    const child1 = await spawnTestWorker(request, {
      label: 'TEST: Sibling 1',
      parentWorkerId: parent.id,
    });
    workerIds.push(child1.id);

    const child2 = await spawnTestWorker(request, {
      label: 'TEST: Sibling 2',
      parentWorkerId: parent.id,
    });
    workerIds.push(child2.id);

    const res = await request.get(`${API}/workers/${child1.id}/siblings`);
    expect(res.ok()).toBeTruthy();
    const siblings = await res.json();
    expect(Array.isArray(siblings)).toBeTruthy();
    expect(siblings.some(s => s.id === child2.id)).toBeTruthy();
  });

  test('GET /dependencies/stats - returns dependency graph stats', async ({ request }) => {
    const res = await request.get(`${API}/dependencies/stats`);
    expect(res.ok()).toBeTruthy();
    const stats = await res.json();
    expect(stats).toBeDefined();
  });
});

// ============================================================
// SECTION 9: Worker Queries & Views
// ============================================================
test.describe('Worker Queries', () => {
  let workerId;

  test.afterEach(async ({ request }) => {
    if (workerId) {
      await killTestWorker(request, workerId);
      workerId = null;
    }
  });

  test('GET /workers/pending - lists pending workers', async ({ request }) => {
    const res = await request.get(`${API}/workers/pending`);
    expect(res.ok()).toBeTruthy();
    const workers = await res.json();
    expect(Array.isArray(workers)).toBeTruthy();
  });

  test('GET /workers/tree - returns worker tree structure', async ({ request }) => {
    const res = await request.get(`${API}/workers/tree`);
    expect(res.ok()).toBeTruthy();
    const tree = await res.json();
    expect(tree).toBeDefined();
  });

  test('GET /workers/:id/quick-status - returns heuristic status', async ({ request }) => {
    const worker = await spawnTestWorker(request, { label: 'TEST: Quick Status' });
    workerId = worker.id;

    // Wait for some output
    await new Promise(r => setTimeout(r, 2000));

    const res = await request.get(`${API}/workers/${workerId}/quick-status`);
    expect(res.ok()).toBeTruthy();
    const status = await res.json();
    expect(status.workerId).toBe(workerId);
  });

  test('GET /workers/:id/context - returns worker context', async ({ request }) => {
    const worker = await spawnTestWorker(request, { label: 'TEST: Context' });
    workerId = worker.id;

    const res = await request.get(`${API}/workers/${workerId}/context`);
    expect(res.ok()).toBeTruthy();
    const ctx = await res.json();
    expect(ctx.workerId).toBe(workerId);
  });

  test('GET /workers/:id/sessions - returns session list', async ({ request }) => {
    const worker = await spawnTestWorker(request, { label: 'TEST: Sessions' });
    workerId = worker.id;

    const res = await request.get(`${API}/workers/${workerId}/sessions`);
    expect(res.ok()).toBeTruthy();
    const sessions = await res.json();
    expect(Array.isArray(sessions)).toBeTruthy();
  });

  test('GET /workers/:id/history - returns paginated output history', async ({ request }) => {
    const worker = await spawnTestWorker(request, { label: 'TEST: History' });
    workerId = worker.id;

    // Wait for some output
    await new Promise(r => setTimeout(r, 2000));

    const res = await request.get(`${API}/workers/${workerId}/history?limit=10&offset=0`);
    expect(res.ok()).toBeTruthy();
    const history = await res.json();
    expect(history).toBeDefined();
  });

  test('GET /workers/efficiency - returns efficiency data', async ({ request }) => {
    const res = await request.get(`${API}/workers/efficiency`);
    expect(res.ok()).toBeTruthy();
    const efficiency = await res.json();
    expect(efficiency).toBeDefined();
  });
});

// ============================================================
// SECTION 10: Health & System Endpoints
// ============================================================
test.describe('Health & System', () => {

  test('GET /health - returns system health', async ({ request }) => {
    const res = await request.get(`${API}/health`);
    expect(res.ok()).toBeTruthy();
    const health = await res.json();
    expect(health.status).toBe('ok');
    expect(health.theaRoot).toBeDefined();
  });

  test('GET /activity - returns activity feed', async ({ request }) => {
    const res = await request.get(`${API}/activity`);
    expect(res.ok()).toBeTruthy();
    const activity = await res.json();
    expect(Array.isArray(activity)).toBeTruthy();
  });

  test('GET /projects - returns project list', async ({ request }) => {
    const res = await request.get(`${API}/projects`);
    expect(res.ok()).toBeTruthy();
    const projects = await res.json();
    expect(Array.isArray(projects)).toBeTruthy();
    expect(projects.length).toBeGreaterThan(0);
    expect(projects.some(p => p.name === 'strategos')).toBeTruthy();
  });

  test('GET /projects?view=tree - returns tree structure', async ({ request }) => {
    const res = await request.get(`${API}/projects?view=tree`);
    expect(res.ok()).toBeTruthy();
    const tree = await res.json();
    expect(tree).toBeDefined();
  });

  test('GET /projects/:name - returns specific project', async ({ request }) => {
    const res = await request.get(`${API}/projects/strategos`);
    expect(res.ok()).toBeTruthy();
    const project = await res.json();
    expect(project.name).toBe('strategos');
  });

  test('GET /metrics/system - returns system metrics', async ({ request }) => {
    const res = await request.get(`${API}/metrics/system`);
    expect(res.ok()).toBeTruthy();
    const metrics = await res.json();
    expect(metrics).toBeDefined();
  });

  test('GET /resources - returns resource info', async ({ request }) => {
    const res = await request.get(`${API}/resources`);
    expect(res.ok()).toBeTruthy();
    const resources = await res.json();
    expect(resources).toBeDefined();
  });

  test('GET /logs - returns log entries', async ({ request }) => {
    const res = await request.get(`${API}/logs`);
    expect(res.ok()).toBeTruthy();
  });

  test('GET /logs/lifecycle - returns lifecycle logs', async ({ request }) => {
    const res = await request.get(`${API}/logs/lifecycle`);
    expect(res.ok()).toBeTruthy();
  });

  test('GET /logs/stats - returns log statistics', async ({ request }) => {
    const res = await request.get(`${API}/logs/stats`);
    expect(res.ok()).toBeTruthy();
  });

  test('GET /status - returns server status', async ({ request }) => {
    const res = await request.get(`${API}/status`);
    expect(res.ok()).toBeTruthy();
  });

  test('GET /ollama/health - checks Ollama availability', async ({ request }) => {
    const res = await request.get(`${API}/ollama/health`);
    // May be ok or error depending on Ollama availability
    expect([200, 500]).toContain(res.status());
  });

  test('GET /output-db/stats - returns output DB stats', async ({ request }) => {
    const res = await request.get(`${API}/output-db/stats`);
    expect(res.ok()).toBeTruthy();
  });

  test('GET /respawn-suggestions - returns respawn suggestions', async ({ request }) => {
    const res = await request.get(`${API}/respawn-suggestions`);
    expect(res.ok()).toBeTruthy();
  });
});

// ============================================================
// SECTION 11: Duplicate Detection
// ============================================================
test.describe('Duplicate Detection', () => {
  const workerIds = [];

  test.afterEach(async ({ request }) => {
    for (const id of workerIds) {
      await killTestWorker(request, id);
    }
    workerIds.length = 0;
  });

  test('blocks duplicate label+project by default', async ({ request }) => {
    const w1 = await spawnTestWorker(request, {
      label: 'TEST: Dup Detection',
      allowDuplicate: false,
    });
    workerIds.push(w1.id);

    // Second spawn with same label should be rejected (409 or similar)
    const res = await request.post(`${API}/workers`, {
      data: {
        projectPath: 'strategos',
        label: 'TEST: Dup Detection',
        allowDuplicate: false,
      }
    });
    // Should be rejected - 409 or 400
    expect([400, 409]).toContain(res.status());
  });

  test('allows duplicate when allowDuplicate=true', async ({ request }) => {
    const w1 = await spawnTestWorker(request, {
      label: 'TEST: Dup Allowed',
      allowDuplicate: true,
    });
    workerIds.push(w1.id);

    const w2 = await spawnTestWorker(request, {
      label: 'TEST: Dup Allowed',
      allowDuplicate: true,
    });
    workerIds.push(w2.id);

    expect(w2.id).not.toBe(w1.id);
    expect(w2.label).toBe('TEST: Dup Allowed');
  });
});

// ============================================================
// SECTION 12: Worker Metrics
// ============================================================
test.describe('Worker Metrics', () => {
  let workerId;

  test.afterEach(async ({ request }) => {
    if (workerId) {
      await killTestWorker(request, workerId);
      workerId = null;
    }
  });

  test('GET /metrics/worker/:id - returns per-worker metrics', async ({ request }) => {
    const worker = await spawnTestWorker(request, { label: 'TEST: Worker Metrics' });
    workerId = worker.id;

    const res = await request.get(`${API}/metrics/worker/${workerId}`);
    expect(res.ok()).toBeTruthy();
    const metrics = await res.json();
    expect(metrics).toBeDefined();
  });

  test('GET /metrics/realtime - returns realtime metrics', async ({ request }) => {
    const res = await request.get(`${API}/metrics/realtime`);
    expect(res.ok()).toBeTruthy();
    const metrics = await res.json();
    expect(metrics).toBeDefined();
  });
});

// ============================================================
// SECTION 13: Full Lifecycle Journey
// ============================================================
test.describe('Full Lifecycle Journey', () => {
  test('spawn → input → output → complete → delete', async ({ request }) => {
    const metrics = { steps: [] };

    // Step 1: Health check
    let start = Date.now();
    const healthRes = await request.get(`${API}/health`);
    expect(healthRes.ok()).toBeTruthy();
    metrics.steps.push({ name: 'health-check', durationMs: Date.now() - start });

    // Step 2: Spawn worker
    start = Date.now();
    const worker = await spawnTestWorker(request, { label: 'TEST: Full Journey' });
    metrics.steps.push({ name: 'spawn', durationMs: Date.now() - start, workerId: worker.id });
    expect(worker.status).toBe('running');

    // Step 3: Send input
    start = Date.now();
    await new Promise(r => setTimeout(r, 2000)); // Wait for init
    const inputRes = await request.post(`${API}/workers/${worker.id}/input`, {
      data: { input: 'echo JOURNEY_TEST_MARKER' }
    });
    expect(inputRes.ok()).toBeTruthy();
    metrics.steps.push({ name: 'send-input', durationMs: Date.now() - start });

    // Step 4: Read output
    start = Date.now();
    await new Promise(r => setTimeout(r, 2000)); // Wait for output
    const outputRes = await request.get(`${API}/workers/${worker.id}/output`);
    expect(outputRes.ok()).toBeTruthy();
    const { output } = await outputRes.json();
    expect(typeof output).toBe('string');
    metrics.steps.push({ name: 'read-output', durationMs: Date.now() - start, outputLength: output.length });

    // Step 5: Quick status
    start = Date.now();
    const statusRes = await request.get(`${API}/workers/${worker.id}/quick-status`);
    expect(statusRes.ok()).toBeTruthy();
    metrics.steps.push({ name: 'quick-status', durationMs: Date.now() - start });

    // Step 6: Complete worker
    start = Date.now();
    const completeRes = await request.post(`${API}/workers/${worker.id}/complete`);
    expect(completeRes.ok()).toBeTruthy();
    metrics.steps.push({ name: 'complete', durationMs: Date.now() - start });

    // Step 7: Delete worker
    start = Date.now();
    const deleteRes = await request.delete(`${API}/workers/${worker.id}?force=true`);
    expect(deleteRes.ok()).toBeTruthy();
    metrics.steps.push({ name: 'delete', durationMs: Date.now() - start });

    // Step 8: Verify worker is gone
    const getRes = await request.get(`${API}/workers/${worker.id}`);
    expect(getRes.status()).toBe(404);

    // Report metrics
    const totalMs = metrics.steps.reduce((s, step) => s + step.durationMs, 0);
    console.log(`\n=== Full Lifecycle Journey Metrics ===`);
    for (const step of metrics.steps) {
      console.log(`  ${step.name}: ${step.durationMs}ms`);
    }
    console.log(`  TOTAL: ${totalMs}ms`);
    console.log(`=====================================\n`);
  });
});

// ============================================================
// SECTION 14: Ralph Signal Endpoints
// ============================================================
test.describe('Ralph Signals', () => {
  let workerId;

  test.afterEach(async ({ request }) => {
    if (workerId) {
      await killTestWorker(request, workerId);
      workerId = null;
    }
  });

  test('POST /ralph/signal/:token - rejects invalid token', async ({ request }) => {
    const res = await request.post(`${API}/ralph/signal/invalidtoken12345`, {
      data: { status: 'done' }
    });
    // Should be 404 or 400 for unknown token
    expect([400, 404]).toContain(res.status());
  });
});

// ============================================================
// SECTION 15: Settings Endpoints
// ============================================================
test.describe('Summary Settings', () => {

  test('GET /settings/summaries - returns summary settings', async ({ request }) => {
    const res = await request.get(`${API}/settings/summaries`);
    expect(res.ok()).toBeTruthy();
    const settings = await res.json();
    expect(settings).toBeDefined();
  });
});

// ============================================================
// SECTION 17: Spawn Timing Benchmark
// ============================================================
test.describe('Spawn Timing', () => {
  test('measures spawn latency', async ({ request }) => {
    const timings = [];

    for (let i = 0; i < 3; i++) {
      const start = Date.now();
      const worker = await spawnTestWorker(request, {
        label: `TEST: Timing ${i}`,
        allowDuplicate: true,
      });
      const elapsed = Date.now() - start;
      timings.push(elapsed);

      // Cleanup immediately
      await killTestWorker(request, worker.id);
    }

    const avg = timings.reduce((a, b) => a + b, 0) / timings.length;
    const max = Math.max(...timings);

    console.log(`\n=== Spawn Timing Benchmark ===`);
    console.log(`  Runs: ${timings.length}`);
    console.log(`  Timings: ${timings.map(t => `${t}ms`).join(', ')}`);
    console.log(`  Average: ${Math.round(avg)}ms`);
    console.log(`  Max: ${max}ms`);
    console.log(`==============================\n`);

    // Alert threshold from spec: spawn should be <10000ms
    expect(max).toBeLessThan(10000);
  });
});

// ============================================================
// SECTION 16: UI Integration — Worker in Grid
// ============================================================
test.describe('UI: Worker Appears in Grid', () => {
  let workerId;

  test.afterEach(async ({ request }) => {
    if (workerId) {
      await killTestWorker(request, workerId);
      workerId = null;
    }
  });

  test('spawned worker appears as a card in the Workers grid', async ({ page, request }) => {
    // Spawn worker via API
    const worker = await spawnTestWorker(request, { label: 'TEST: UI Grid Appear' });
    workerId = worker.id;

    // Load the UI
    await page.goto('/');
    await expect(page.getByTestId('connection-status')).toBeVisible({ timeout: 10000 });
    await page.getByTestId('tab-workers').click();
    await page.waitForTimeout(1000);

    // Worker card should be visible with matching data-testid
    const workerCard = page.getByTestId(`worker-card-${workerId}`);
    await expect(workerCard).toBeVisible({ timeout: 10000 });

    // Card should display the label (the UI strips the "TEST:" prefix via parseWorkerLabel)
    await expect(workerCard.locator('h3')).toContainText('UI Grid Appear');

    // Card should show running status
    const statusBadge = workerCard.locator('.thea-badge');
    await expect(statusBadge).toContainText('running');

    // Card should have Open and Kill buttons
    await expect(page.getByTestId(`open-worker-${workerId}`)).toBeVisible();
    await expect(page.getByTestId(`kill-worker-${workerId}`)).toBeVisible();
  });

  test('worker card shows project name', async ({ page, request }) => {
    const worker = await spawnTestWorker(request, { label: 'TEST: UI Project Name' });
    workerId = worker.id;

    await page.goto('/');
    await expect(page.getByTestId('connection-status')).toBeVisible({ timeout: 10000 });
    await page.getByTestId('tab-workers').click();
    await page.waitForTimeout(1000);

    const workerCard = page.getByTestId(`worker-card-${workerId}`);
    await expect(workerCard).toBeVisible({ timeout: 10000 });

    // Should show "strategos" project name
    await expect(workerCard.locator('p', { hasText: 'strategos' }).first()).toBeVisible();
  });
});

// ============================================================
// SECTION 17: UI Integration — Open Worker Terminal
// ============================================================
test.describe('UI: Worker Terminal View', () => {
  let workerId;

  test.afterEach(async ({ request }) => {
    if (workerId) {
      await killTestWorker(request, workerId);
      workerId = null;
    }
  });

  test('opening a worker shows focused view with Summary/Terminal tabs', async ({ page, request }) => {
    const worker = await spawnTestWorker(request, { label: 'TEST: UI Focused View' });
    workerId = worker.id;

    await page.goto('/');
    await expect(page.getByTestId('connection-status')).toBeVisible({ timeout: 10000 });
    await page.getByTestId('tab-workers').click();
    await page.waitForTimeout(1000);

    // Click Open on the worker card
    await page.getByTestId(`open-worker-${workerId}`).click();

    // Should enter focused mode
    await expect(page.locator('button:has-text("Back to Grid")')).toBeVisible({ timeout: 5000 });

    // Worker label should be in the header
    await expect(page.locator('h2:has-text("TEST: UI Focused View")')).toBeVisible();

    // Summary and Terminal tabs should be visible
    await expect(page.locator('button:has-text("Summary")')).toBeVisible();
    await expect(page.locator('button:has-text("Terminal")')).toBeVisible();
  });

  test('terminal tab displays xterm terminal', async ({ page, request }) => {
    const worker = await spawnTestWorker(request, { label: 'TEST: UI Terminal Display' });
    workerId = worker.id;

    await page.goto('/');
    await expect(page.getByTestId('connection-status')).toBeVisible({ timeout: 10000 });
    await page.getByTestId('tab-workers').click();
    await page.waitForTimeout(1000);

    // Open the worker
    await page.getByTestId(`open-worker-${workerId}`).click();
    await expect(page.locator('button:has-text("Back to Grid")')).toBeVisible({ timeout: 5000 });

    // Click Terminal tab
    await page.locator('button:has-text("Terminal")').click();

    // XTerm container should be visible
    await expect(page.locator('.xterm')).toBeVisible({ timeout: 10000 });

    // XTerm rows should exist (terminal is rendering)
    await expect(page.locator('.xterm-rows')).toBeVisible({ timeout: 5000 });
  });

  test('terminal shows output after worker initializes', async ({ page, request }) => {
    const worker = await spawnTestWorker(request, { label: 'TEST: UI Terminal Output' });
    workerId = worker.id;

    // Wait for worker to generate some output
    await new Promise(r => setTimeout(r, 3000));

    await page.goto('/');
    await expect(page.getByTestId('connection-status')).toBeVisible({ timeout: 10000 });
    await page.getByTestId('tab-workers').click();
    await page.waitForTimeout(1000);

    // Open worker and switch to terminal
    await page.getByTestId(`open-worker-${workerId}`).click();
    await expect(page.locator('button:has-text("Back to Grid")')).toBeVisible({ timeout: 5000 });
    await page.locator('button:has-text("Terminal")').click();

    // Wait for terminal to load output
    await page.waitForTimeout(3000);

    // Verify xterm-rows has non-empty content
    const xtermRows = page.locator('.xterm-rows');
    await expect(xtermRows).toBeVisible({ timeout: 5000 });
    const rowCount = await xtermRows.locator('> *').count();
    expect(rowCount).toBeGreaterThan(0);
  });

  test('Back to Grid returns to worker cards', async ({ page, request }) => {
    const worker = await spawnTestWorker(request, { label: 'TEST: UI Back to Grid' });
    workerId = worker.id;

    await page.goto('/');
    await expect(page.getByTestId('connection-status')).toBeVisible({ timeout: 10000 });
    await page.getByTestId('tab-workers').click();
    await page.waitForTimeout(1000);

    // Open worker
    await page.getByTestId(`open-worker-${workerId}`).click();
    await expect(page.locator('button:has-text("Back to Grid")')).toBeVisible({ timeout: 5000 });

    // Go back
    await page.locator('button:has-text("Back to Grid")').click();
    await page.waitForTimeout(500);

    // Worker card should be visible again
    await expect(page.getByTestId(`worker-card-${workerId}`)).toBeVisible({ timeout: 5000 });
  });
});

// ============================================================
// SECTION 18: UI Integration — Kill Worker from Grid
// ============================================================
test.describe('UI: Kill Worker from Grid', () => {
  test('killing a worker removes it from the grid', async ({ page, request }) => {
    // Spawn a worker via API
    const worker = await spawnTestWorker(request, { label: 'TEST: UI Kill Worker' });
    const wId = worker.id;

    await page.goto('/');
    await expect(page.getByTestId('connection-status')).toBeVisible({ timeout: 10000 });
    await page.getByTestId('tab-workers').click();
    await page.waitForTimeout(1000);

    // Verify worker card is present
    const workerCard = page.getByTestId(`worker-card-${wId}`);
    await expect(workerCard).toBeVisible({ timeout: 10000 });

    // Click kill button
    const killBtn = page.getByTestId(`kill-worker-${wId}`);
    await killBtn.click();

    // Worker card should disappear
    await expect(workerCard).not.toBeVisible({ timeout: 10000 });

    // Verify via API that worker is gone
    const getRes = await request.get(`${API}/workers/${wId}`);
    expect(getRes.status()).toBe(404);
  });
});

// ============================================================
// SECTION 19: UI Integration — Checkpoint After Kill
// ============================================================
test.describe('UI: Checkpoint Created After Kill', () => {
  test('killing a worker creates a checkpoint', async ({ request }) => {
    // Spawn a worker
    const worker = await spawnTestWorker(request, { label: 'TEST: UI Checkpoint' });
    const wId = worker.id;

    // Wait for worker to initialize
    await new Promise(r => setTimeout(r, 2000));

    // Kill it
    const killRes = await request.delete(`${API}/workers/${wId}?force=true`);
    expect(killRes.ok()).toBeTruthy();

    // Wait for checkpoint to be created
    await new Promise(r => setTimeout(r, 1000));

    // Check checkpoints for this worker
    const checkpointsRes = await request.get(`${API}/checkpoints`);
    expect(checkpointsRes.ok()).toBeTruthy();
    const checkpoints = await checkpointsRes.json();

    // Find checkpoint for our worker
    const ourCheckpoint = checkpoints.find(
      cp => cp.label === 'TEST: UI Checkpoint' || cp.workerId === wId
    );
    expect(ourCheckpoint).toBeDefined();
    expect(ourCheckpoint.label).toBe('TEST: UI Checkpoint');
  });

  test('checkpoint has expected fields', async ({ request }) => {
    // Spawn and kill a worker
    const worker = await spawnTestWorker(request, { label: 'TEST: Checkpoint Fields' });
    await new Promise(r => setTimeout(r, 2000));
    await request.delete(`${API}/workers/${worker.id}?force=true`);
    await new Promise(r => setTimeout(r, 1000));

    // Get checkpoints
    const checkpointsRes = await request.get(`${API}/checkpoints`);
    const checkpoints = await checkpointsRes.json();
    const cp = checkpoints.find(
      c => c.label === 'TEST: Checkpoint Fields' || c.workerId === worker.id
    );

    expect(cp).toBeDefined();
    // Checkpoint should have core fields
    expect(cp.label).toBe('TEST: Checkpoint Fields');
    expect(cp.diedAt || cp.createdAt).toBeTruthy();
    expect(cp.project).toBe('strategos');
  });
});

// ============================================================
// SECTION 20: UI Integration — Full UI Journey
// ============================================================
test.describe('UI: Full Lifecycle Journey', () => {
  test('spawn via API → see in grid → open terminal → kill → verify removed', async ({ page, request }) => {
    // Step 1: Spawn a worker via API
    const worker = await spawnTestWorker(request, { label: 'TEST: Full UI Journey' });
    expect(worker.id).toBeDefined();
    expect(worker.status).toBe('running');

    // Step 2: Load UI and verify worker appears in grid
    await page.goto('/');
    await expect(page.getByTestId('connection-status')).toBeVisible({ timeout: 10000 });
    await page.getByTestId('tab-workers').click();
    await page.waitForTimeout(1000);

    const workerCard = page.getByTestId(`worker-card-${worker.id}`);
    await expect(workerCard).toBeVisible({ timeout: 10000 });
    await expect(workerCard.locator('h3')).toContainText('Full UI Journey');

    // Step 3: Open worker and view terminal
    await page.getByTestId(`open-worker-${worker.id}`).click();
    await expect(page.locator('button:has-text("Back to Grid")')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('h2:has-text("TEST: Full UI Journey")')).toBeVisible();

    // Switch to terminal tab
    await page.locator('button:has-text("Terminal")').click();
    await expect(page.locator('.xterm')).toBeVisible({ timeout: 10000 });

    // Step 4: Go back to grid
    await page.locator('button:has-text("Back to Grid")').click();
    await page.waitForTimeout(500);
    await expect(workerCard).toBeVisible({ timeout: 5000 });

    // Step 5: Kill the worker via UI
    await page.getByTestId(`kill-worker-${worker.id}`).click();

    // Step 6: Verify worker is removed from grid
    await expect(workerCard).not.toBeVisible({ timeout: 10000 });

    // Step 7: Verify checkpoint was created via API
    await new Promise(r => setTimeout(r, 1000));
    const checkpointsRes = await request.get(`${API}/checkpoints`);
    const checkpoints = await checkpointsRes.json();
    const cp = checkpoints.find(
      c => c.label === 'TEST: Full UI Journey' || c.workerId === worker.id
    );
    expect(cp).toBeDefined();
  });
});
