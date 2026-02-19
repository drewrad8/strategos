import { test, expect } from '@playwright/test';

/**
 * Strategos x Architect Integration Tests
 * Tests the full workflow between both applications:
 * - Architect can trigger worker creation via Strategos API
 * - Workers appear in Strategos UI
 * - Status flows back to Architect
 */


const STRATEGOS_API = 'http://localhost:38007';
const ARCHITECT_URL = 'http://localhost:38010';
const ARCHITECT_API = 'http://localhost:38011';

test.describe('Strategos x Architect Integration', () => {

  test.describe('API Integration', () => {

    test('Strategos integration API is accessible', async ({ request }) => {
      const response = await request.get(`${STRATEGOS_API}/api/health`);
      expect(response.ok()).toBeTruthy();
      const data = await response.json();
      expect(data.status).toBe('ok');
    });

    test('workflow-execute endpoint spawns worker and sends prompt', async ({ request }) => {
      // Call the integration endpoint that Architect would call
      const response = await request.post(`${STRATEGOS_API}/api/integration/workflow-execute`, {
        data: {
          projectPath: 'strategos',
          prompt: 'echo "Integration test executed successfully"',
          label: 'TEST: Integration Worker',
          mode: 'interactive'
        }
      });

      expect(response.ok()).toBeTruthy();
      const data = await response.json();

      expect(data.success).toBe(true);
      expect(data.mode).toBe('interactive');
      expect(data.worker).toBeDefined();
      expect(data.worker.id).toBeDefined();
      expect(data.worker.label).toBe('TEST: Integration Worker');
      expect(data.promptSent).toBe(true);

      // Cleanup: kill the test worker
      const workerId = data.worker.id;
      await request.delete(`${STRATEGOS_API}/api/workers/${workerId}`);
    });

    test('worker status endpoint returns analysis', async ({ request }) => {
      // First spawn a worker
      const spawnResponse = await request.post(`${STRATEGOS_API}/api/workers`, {
        data: { projectPath: 'strategos', label: 'TEST: Status Worker' }
      });
      const worker = await spawnResponse.json();

      // Wait a moment for output to accumulate
      await new Promise(r => setTimeout(r, 2000));

      // Get status via integration endpoint
      const statusResponse = await request.get(
        `${STRATEGOS_API}/api/integration/worker/${worker.id}/status?includeContext=true`
      );

      expect(statusResponse.ok()).toBeTruthy();
      const status = await statusResponse.json();

      expect(status.worker).toBeDefined();
      expect(status.worker.id).toBe(worker.id);
      expect(status.analysis).toBeDefined();
      expect(status.context).toBeDefined();

      // Cleanup
      await request.delete(`${STRATEGOS_API}/api/workers/${worker.id}`);
    });

    test('batch operation runs across multiple projects', async ({ request }) => {
      // Test the batch endpoint (headless mode)
      const response = await request.post(`${STRATEGOS_API}/api/integration/batch`, {
        data: {
          projects: ['strategos'],
          prompt: 'echo "batch test"',
          timeout: 10000,
          outputFormat: 'text'
        }
      });

      expect(response.ok()).toBeTruthy();
      const data = await response.json();

      expect(data.success).toBe(true);
      expect(data.summary).toBeDefined();
      expect(data.summary.totalProjects).toBe(1);
    });

  });

  test.describe('UI Integration Flow', () => {

    test('worker spawned via API appears in Strategos UI', async ({ page, request }) => {
      // First spawn a worker via API (simulating Architect calling the integration endpoint)
      const spawnResponse = await request.post(`${STRATEGOS_API}/api/integration/workflow-execute`, {
        data: {
          projectPath: 'strategos',
          prompt: 'ls',
          label: 'TEST: Architect Spawned',
          mode: 'interactive'
        }
      });
      const spawnData = await spawnResponse.json();
      const workerId = spawnData.worker.id;

      // Now open Strategos UI and verify the worker appears
      await page.goto('/');
      await expect(page.getByTestId('connection-status')).toBeVisible({ timeout: 10000 });

      // Go to Workers tab
      await page.getByTestId('tab-workers').click();

      // Should see the worker we just spawned
      const workerCard = page.locator(`[data-testid="worker-card-${workerId}"]`);
      await expect(workerCard).toBeVisible({ timeout: 5000 });

      // Verify it has the correct label
      await expect(workerCard.locator('h3')).toContainText('TEST: Architect Spawned');

      // Cleanup
      await request.delete(`${STRATEGOS_API}/api/workers/${workerId}`);
    });

    test('full journey: Strategos spawns worker, monitor via UI, get summary', async ({ page, request }) => {
      // Navigate to Strategos
      await page.goto('/');
      await expect(page.getByTestId('connection-status')).toBeVisible({ timeout: 10000 });

      // Spawn worker via API (as Architect would)
      const spawnResponse = await request.post(`${STRATEGOS_API}/api/integration/workflow-execute`, {
        data: {
          projectPath: 'strategos',
          prompt: 'echo "Hello from Architect workflow"',
          label: 'TEST: Full Journey',
          mode: 'interactive'
        }
      });
      const { worker } = await spawnResponse.json();

      // Switch to Workers tab and wait for worker to appear
      await page.getByTestId('tab-workers').click();
      await page.waitForTimeout(1000);

      // Open the worker
      const openButton = page.locator(`[data-testid="open-worker-${worker.id}"]`);
      await expect(openButton).toBeVisible({ timeout: 5000 });
      await openButton.click();

      // Should see focused view
      await expect(page.locator('text=Back to Grid')).toBeVisible();

      // Check Summary view is available
      await expect(page.locator('button:has-text("Summary")')).toBeVisible();

      // Check Terminal view is available
      await page.click('button:has-text("Terminal")');
      await expect(page.locator('.xterm')).toBeVisible({ timeout: 5000 });

      // Go back and kill worker
      await page.click('text=Back to Grid');
      const killButton = page.locator(`[data-testid="kill-worker-${worker.id}"]`);
      await killButton.click();

      // Verify worker is removed
      await page.waitForTimeout(1500);
      await expect(page.locator(`[data-testid="worker-card-${worker.id}"]`)).not.toBeVisible();
    });

  });

  test.describe('ADR Integration', () => {

    test('ADR endpoints are accessible', async ({ request }) => {
      const response = await request.get(`${STRATEGOS_API}/api/adrs`);
      expect(response.ok()).toBeTruthy();
      const adrs = await response.json();
      expect(Array.isArray(adrs)).toBeTruthy();
    });

    test('can retrieve specific ADR', async ({ request }) => {
      const response = await request.get(`${STRATEGOS_API}/api/adrs/0001`);
      if (response.ok()) {
        const adr = await response.json();
        expect(adr.id).toBe('0001');
        expect(adr.title).toBeDefined();
      }
    });

    test('ADR stats endpoint works', async ({ request }) => {
      const response = await request.get(`${STRATEGOS_API}/api/adrs/stats`);
      expect(response.ok()).toBeTruthy();
      const stats = await response.json();
      expect(stats.total).toBeDefined();
    });

  });

  test.describe('Activity Pattern Integration', () => {

    test('activity patterns endpoint works', async ({ request }) => {
      const response = await request.get(`${STRATEGOS_API}/api/activity/patterns`);
      expect(response.ok()).toBeTruthy();
      const patterns = await response.json();
      expect(patterns.totalEvents).toBeDefined();
    });

    test('workflow suggestions endpoint works', async ({ request }) => {
      const response = await request.get(`${STRATEGOS_API}/api/activity/workflows`);
      expect(response.ok()).toBeTruthy();
      const workflows = await response.json();
      expect(Array.isArray(workflows)).toBeTruthy();
    });

  });

});

test.describe('Cross-Application Workflow', () => {

  test.skip('complete Architect → Strategos workflow', async ({ page, request, context }) => {
    // This test requires both Architect and Strategos to be running
    // Skip if Architect isn't available

    const architectHealth = await request.get(`${ARCHITECT_API}/api/health`).catch(() => null);
    if (!architectHealth?.ok()) {
      test.skip('Architect not running');
      return;
    }

    // Open Architect
    const architectPage = await context.newPage();
    await architectPage.goto(ARCHITECT_URL);
    await architectPage.waitForLoadState('networkidle');

    // Wait for app to load
    await architectPage.waitForSelector('.app-header', { timeout: 30000 });

    // Open node library
    const nodeLibraryBtn = architectPage.locator('button[title="Node Library"]');
    if (await nodeLibraryBtn.isVisible()) {
      await nodeLibraryBtn.click();
      await architectPage.waitForTimeout(500);

      // Look for Claude Worker node
      const claudeWorkerNode = architectPage.locator('.node-type:has-text("Claude Worker"), .palette-item:has-text("Claude")');
      if (await claudeWorkerNode.first().isVisible({ timeout: 2000 }).catch(() => false)) {
        await claudeWorkerNode.first().click();
        await architectPage.waitForTimeout(500);

        // A Claude Worker node should now be on the canvas
        const nodes = architectPage.locator('.react-flow__node');
        const nodeCount = await nodes.count();
        expect(nodeCount).toBeGreaterThan(0);
      }
    }

    // Now check Strategos to see if integration would work
    const strategosPage = await context.newPage();
    await strategosPage.goto(STRATEGOS_URL);
    await expect(strategosPage.getByTestId('connection-status')).toBeVisible({ timeout: 10000 });

    // Both apps are running and accessible
    await architectPage.close();
    await strategosPage.close();
  });

});
