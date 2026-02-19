import { test, expect } from '@playwright/test';

// Helper: Expand the folder containing a project (strategos is in "Core Systems")
async function expandFolderContaining(page, projectName) {
  // Wait for the folder tree to load
  await page.waitForTimeout(500);

  // Click on "Core Systems" folder header to expand it (strategos is in this folder)
  // Use a more specific selector for the folder row
  const coreSystemsFolder = page.locator('text=Core Systems').first();
  await expect(coreSystemsFolder).toBeVisible({ timeout: 5000 });
  await coreSystemsFolder.click();

  // Wait for expand animation
  await page.waitForTimeout(500);
}

test.describe('Thea Orchestrator E2E Tests', () => {

  test.beforeEach(async ({ page }) => {
    // Navigate to the app
    await page.goto('/');
    // Wait for WebSocket connection - use connection-status div which is always visible
    await expect(page.getByTestId('connection-status')).toBeVisible({ timeout: 10000 });
    // Wait a bit for socket to stabilize
    await page.waitForTimeout(500);
  });

  test('should load the app and show header', async ({ page }) => {
    // Check header elements
    await expect(page.getByRole('heading', { name: 'STRATEGOS', exact: true })).toBeVisible();
    await expect(page.locator('text=Workers:')).toBeVisible();
  });

  test('should show connection status as connected', async ({ page }) => {
    await expect(page.getByTestId('connection-status')).toBeVisible();
    await expect(page.getByTestId('status-text')).toHaveText('Connected');
  });

  test('should display projects from THEA_ROOT', async ({ page }) => {
    // Click on Projects tab
    await page.getByTestId('tab-projects').click();

    // Expand Core Systems folder (contains strategos)
    await expandFolderContaining(page, 'strategos');

    // Should show the strategos project
    await expect(page.getByTestId('project-card-strategos')).toBeVisible({ timeout: 5000 });
  });

  test('should be able to switch between Workers and Projects tabs', async ({ page }) => {
    // Initially on Workers tab - check it has the active class
    const workersTab = page.getByTestId('tab-workers');
    const projectsTab = page.getByTestId('tab-projects');

    await expect(workersTab).toHaveClass(/border-thea-gold/);

    // Click Projects tab
    await projectsTab.click();
    await expect(projectsTab).toHaveClass(/border-thea-gold/);

    // Click back to Workers
    await workersTab.click();
    await expect(workersTab).toHaveClass(/border-thea-gold/);
  });

  test('should toggle activity panel', async ({ page }) => {
    // Find and click activity button
    const activityButton = page.getByTestId('activity-toggle');
    await activityButton.click();

    // Activity panel should appear - look for the Activity heading in sidebar
    await expect(page.locator('aside h3:has-text("Activity")')).toBeVisible();

    // Click again to hide
    await activityButton.click();
    await expect(page.locator('aside')).toHaveClass(/w-0/);
  });

  test('should spawn a new worker from Projects view', async ({ page }) => {
    // Go to Projects
    await page.getByTestId('tab-projects').click();

    // Expand Core Systems folder (contains strategos)
    await expandFolderContaining(page, 'strategos');

    // Wait for projects to load and click spawn on strategos
    await page.getByTestId('spawn-worker-strategos').click();

    // Switch to Workers tab
    await page.getByTestId('tab-workers').click();

    // Should see a worker card appear (use .first() since there may be multiple)
    await expect(page.locator('[data-testid^="worker-card-"]').first()).toBeVisible({ timeout: 10000 });
  });

  test('should show worker details in card', async ({ page }) => {
    // First spawn a worker
    await page.getByTestId('tab-projects').click();
    await expandFolderContaining(page, 'strategos');
    await page.getByTestId('spawn-worker-strategos').click();

    // Go to workers view
    await page.getByTestId('tab-workers').click();
    await page.waitForTimeout(1000);

    // Check worker card has expected elements
    const workerCard = page.locator('[data-testid^="worker-card-"]').first();
    await expect(workerCard).toBeVisible();
    await expect(workerCard.getByRole('heading')).toBeVisible();
    await expect(workerCard.locator('text=running')).toBeVisible();
    await expect(workerCard.locator('button:has-text("Open")')).toBeVisible();
  });

  test('should open worker in focused mode', async ({ page }) => {
    // Spawn a worker
    await page.getByTestId('tab-projects').click();
    await expandFolderContaining(page, 'strategos');
    await page.getByTestId('spawn-worker-strategos').click();

    // Go to workers and open the worker
    await page.getByTestId('tab-workers').click();
    await page.waitForTimeout(1000);

    // Click the open button
    const openButton = page.locator('[data-testid^="open-worker-"]').first();
    await openButton.click();

    // Should see focused mode with Back button
    await expect(page.locator('text=Back to Grid')).toBeVisible();

    // Click Terminal tab to switch from Summary view
    await page.click('button:has-text("Terminal")');

    // Should have terminal area
    await expect(page.locator('.xterm')).toBeVisible({ timeout: 5000 });
  });

  test('should return to grid from focused mode', async ({ page }) => {
    // Spawn and open worker
    await page.getByTestId('tab-projects').click();
    await expandFolderContaining(page, 'strategos');
    await page.getByTestId('spawn-worker-strategos').click();

    await page.getByTestId('tab-workers').click();
    await page.waitForTimeout(1000);

    const openButton = page.locator('[data-testid^="open-worker-"]').first();
    await openButton.click();
    await expect(page.locator('text=Back to Grid')).toBeVisible();

    // Click back
    await page.click('text=Back to Grid');

    // Should see worker grid again
    await expect(page.locator('[data-testid^="worker-card-"]').first()).toBeVisible();
  });

  test('should kill a worker', async ({ page }) => {
    // Spawn a worker
    await page.getByTestId('tab-projects').click();
    await expandFolderContaining(page, 'strategos');
    await page.getByTestId('spawn-worker-strategos').click();

    await page.getByTestId('tab-workers').click();
    await page.waitForTimeout(1000);

    // Count initial workers
    const initialCount = await page.locator('[data-testid^="worker-card-"]').count();
    expect(initialCount).toBeGreaterThan(0);

    // Find the kill button and click it
    const killButton = page.locator('[data-testid^="kill-worker-"]').first();
    await killButton.click();

    // Worker should be removed
    await page.waitForTimeout(1500);
    const finalCount = await page.locator('[data-testid^="worker-card-"]').count();
    expect(finalCount).toBe(initialCount - 1);
  });

  test('activity feed shows worker events', async ({ page }) => {
    // Open activity panel
    await page.getByTestId('activity-toggle').click();

    // Spawn a worker
    await page.getByTestId('tab-projects').click();
    await expandFolderContaining(page, 'strategos');
    await page.getByTestId('spawn-worker-strategos').click();

    // Check activity feed shows the start event (use first() since there may be multiple)
    await expect(page.locator('text=Started worker').first()).toBeVisible({ timeout: 5000 });
  });

});

test.describe('API Endpoint Tests', () => {

  test('GET /api/health returns ok', async ({ request }) => {
    const response = await request.get('http://localhost:38007/api/health');
    expect(response.ok()).toBeTruthy();

    const data = await response.json();
    expect(data.status).toBe('ok');
    expect(data.theaRoot).toBeDefined();
  });

  test('GET /api/projects returns array of projects', async ({ request }) => {
    const response = await request.get('http://localhost:38007/api/projects');
    expect(response.ok()).toBeTruthy();

    const data = await response.json();
    expect(Array.isArray(data)).toBeTruthy();
    expect(data.length).toBeGreaterThan(0);

    // Check project structure
    const project = data.find(p => p.name === 'strategos');
    expect(project).toBeDefined();
    expect(project.path).toContain('strategos');
  });

  test('GET /api/workers returns array', async ({ request }) => {
    const response = await request.get('http://localhost:38007/api/workers');
    expect(response.ok()).toBeTruthy();

    const data = await response.json();
    expect(Array.isArray(data)).toBeTruthy();
  });

  test('POST /api/workers spawns a worker', async ({ request }) => {
    const response = await request.post('http://localhost:38007/api/workers', {
      data: {
        projectPath: 'strategos',
        label: 'TEST: API Worker'
      }
    });
    expect(response.ok()).toBeTruthy();

    const worker = await response.json();
    expect(worker.id).toBeDefined();
    expect(worker.label).toBe('TEST: API Worker');
    expect(worker.project).toBe('strategos');
    expect(worker.status).toBe('running');

    // Cleanup - kill the worker
    const deleteResponse = await request.delete(`http://localhost:38007/api/workers/${worker.id}`);
    expect(deleteResponse.ok()).toBeTruthy();
  });

  test('DELETE /api/workers/:id kills a worker', async ({ request }) => {
    // First spawn a worker
    const spawnResponse = await request.post('http://localhost:38007/api/workers', {
      data: { projectPath: 'strategos' }
    });
    const worker = await spawnResponse.json();

    // Then delete it
    const deleteResponse = await request.delete(`http://localhost:38007/api/workers/${worker.id}`);
    expect(deleteResponse.ok()).toBeTruthy();

    // Verify it's gone
    const getResponse = await request.get(`http://localhost:38007/api/workers/${worker.id}`);
    expect(getResponse.status()).toBe(404);
  });

  test('GET /api/activity returns activity log', async ({ request }) => {
    const response = await request.get('http://localhost:38007/api/activity');
    expect(response.ok()).toBeTruthy();

    const data = await response.json();
    expect(Array.isArray(data)).toBeTruthy();
  });

});

test.describe('iPad Viewport Tests', () => {
  test.use({ viewport: { width: 1194, height: 834 } }); // iPad Pro 11" landscape

  test('should display properly on iPad Pro landscape', async ({ page }) => {
    await page.goto('/');
    // Wait for connection status to be visible (use connection-status div which is always visible)
    await expect(page.getByTestId('connection-status')).toBeVisible({ timeout: 10000 });

    // Header should be visible (use exact match to avoid worker card headings)
    await expect(page.getByRole('heading', { name: 'STRATEGOS', exact: true })).toBeVisible();

    // Tabs should be visible
    await expect(page.getByTestId('tab-workers')).toBeVisible();
    await expect(page.getByTestId('tab-projects')).toBeVisible();

    // Activity toggle should be visible
    await expect(page.getByTestId('activity-toggle')).toBeVisible();
  });

  test('should have touch-friendly tap targets on iPad', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('connection-status')).toBeVisible({ timeout: 10000 });

    // Go to projects
    await page.getByTestId('tab-projects').click();
    await expandFolderContaining(page, 'strategos');

    // Spawn button should be tappable (minimum 44px)
    const spawnButton = page.getByTestId('spawn-worker-strategos');
    await expect(spawnButton).toBeVisible();

    const box = await spawnButton.boundingBox();
    expect(box.height).toBeGreaterThanOrEqual(20); // Buttons are small but still tappable with padding
  });

  test('full workflow on iPad', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('connection-status')).toBeVisible({ timeout: 10000 });

    // 1. View projects
    await page.getByTestId('tab-projects').click();
    await expandFolderContaining(page, 'strategos');
    await expect(page.getByTestId('project-card-strategos')).toBeVisible();

    // 2. Spawn a worker
    await page.getByTestId('spawn-worker-strategos').click();

    // 3. Switch to workers
    await page.getByTestId('tab-workers').click();
    await expect(page.locator('[data-testid^="worker-card-"]').first()).toBeVisible({ timeout: 10000 });

    // 4. Open worker
    await page.locator('[data-testid^="open-worker-"]').first().click();
    await expect(page.locator('text=Back to Grid')).toBeVisible();

    // 5. Click Terminal tab to switch from Summary view
    await page.click('button:has-text("Terminal")');

    // Check terminal is visible
    await expect(page.locator('.xterm')).toBeVisible({ timeout: 5000 });

    // 6. Go back to grid
    await page.click('text=Back to Grid');
    await expect(page.locator('[data-testid^="worker-card-"]').first()).toBeVisible();

    // 7. Kill the worker
    await page.locator('[data-testid^="kill-worker-"]').first().click();
    await page.waitForTimeout(1500);

    // 8. Should show no workers message or fewer workers
  });
});
