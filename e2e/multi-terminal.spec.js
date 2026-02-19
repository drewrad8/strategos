/**
 * Multi-Terminal View E2E Tests
 *
 * Self-contained tests that spawn their own workers to validate:
 * - Entering/exiting multi-terminal view
 * - Layout switching (Single, Split H, Split V, 2x2)
 * - Worker assignment to panes
 * - Terminal output display in panes
 * - Add/remove panes
 *
 * All test workers use the "TEST:" prefix so global-setup/teardown can clean them up.
 */
import { test, expect } from '@playwright/test';

const API = 'http://localhost:38007/api';

// Helper: spawn a test worker via API
async function spawnTestWorker(request, label) {
  const res = await request.post(`${API}/workers`, {
    data: {
      projectPath: 'strategos',
      label: label || `TEST: MultiTerm ${Date.now()}`,
      autoAccept: true,
      ralphMode: false,
      allowDuplicate: true,
    },
  });
  expect(res.ok()).toBeTruthy();
  return res.json();
}

// Helper: kill a worker, ignoring errors
async function killTestWorker(request, id) {
  try {
    await request.delete(`${API}/workers/${id}?force=true`);
  } catch (_) {}
}

/**
 * Get the pane count from the toolbar indicator text "{N} pane(s)"
 */
async function getPaneCountFromToolbar(page) {
  const indicator = page.locator('text=/\\d+ panes?/');
  const text = await indicator.textContent({ timeout: 3000 });
  const match = text.match(/(\d+) panes?/);
  return match ? parseInt(match[1], 10) : 0;
}

test.describe('Multi-Terminal View', () => {
  const workerIds = [];

  test.beforeAll(async ({ request }) => {
    // Spawn 2 workers so multi-terminal tests have something to work with
    const w1 = await spawnTestWorker(request, 'TEST: MultiTerm Worker A');
    const w2 = await spawnTestWorker(request, 'TEST: MultiTerm Worker B');
    workerIds.push(w1.id, w2.id);
  });

  test.afterAll(async ({ request }) => {
    for (const id of workerIds) {
      await killTestWorker(request, id);
    }
  });

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('connection-status')).toBeVisible({ timeout: 10000 });
    // Ensure we're on the Workers tab
    await page.getByTestId('tab-workers').click();
    await page.waitForTimeout(1000);
  });

  test('Multi-Terminal View button is visible when workers exist', async ({ page }) => {
    const multiTermBtn = page.locator('button:has-text("Multi-Terminal View")');
    await expect(multiTermBtn).toBeVisible({ timeout: 5000 });
  });

  test('entering multi-terminal view shows layout toolbar', async ({ page }) => {
    await page.locator('button:has-text("Multi-Terminal View")').click();

    // Should see Back to Grid button
    await expect(page.locator('button:has-text("Back to Grid")')).toBeVisible({ timeout: 5000 });

    // Should see all layout buttons
    await expect(page.locator('button[title="Single"]')).toBeVisible();
    await expect(page.locator('button[title="Split H"]')).toBeVisible();
    await expect(page.locator('button[title="Split V"]')).toBeVisible();
    await expect(page.locator('button[title="2×2"]')).toBeVisible();

    // Add Pane button should be visible
    await expect(page.locator('button[title="Add Pane"]')).toBeVisible();
  });

  test('Single layout shows 1 pane in toolbar indicator', async ({ page }) => {
    await page.locator('button:has-text("Multi-Terminal View")').click();
    await expect(page.locator('button:has-text("Back to Grid")')).toBeVisible({ timeout: 5000 });

    // Click Single layout
    await page.locator('button[title="Single"]').click();
    await page.waitForTimeout(300);

    // Toolbar indicator should show "1 pane"
    await expect(page.locator('text=1 pane')).toBeVisible({ timeout: 5000 });
  });

  test('Split H layout shows 2 panes in toolbar indicator', async ({ page }) => {
    await page.locator('button:has-text("Multi-Terminal View")').click();
    await expect(page.locator('button:has-text("Back to Grid")')).toBeVisible({ timeout: 5000 });

    await page.locator('button[title="Split H"]').click();
    await page.waitForTimeout(300);

    // Toolbar should show "2 panes"
    await expect(page.locator('text=2 panes')).toBeVisible({ timeout: 5000 });
  });

  test('Split V layout shows 2 panes in toolbar indicator', async ({ page }) => {
    await page.locator('button:has-text("Multi-Terminal View")').click();
    await expect(page.locator('button:has-text("Back to Grid")')).toBeVisible({ timeout: 5000 });

    await page.locator('button[title="Split V"]').click();
    await page.waitForTimeout(300);

    await expect(page.locator('text=2 panes')).toBeVisible({ timeout: 5000 });
  });

  test('2x2 layout shows 4 panes in toolbar indicator', async ({ page }) => {
    await page.locator('button:has-text("Multi-Terminal View")').click();
    await expect(page.locator('button:has-text("Back to Grid")')).toBeVisible({ timeout: 5000 });

    await page.locator('button[title="2×2"]').click();
    await page.waitForTimeout(300);

    await expect(page.locator('text=4 panes')).toBeVisible({ timeout: 5000 });
  });

  test('panes auto-assign available workers on layout change', async ({ page }) => {
    await page.locator('button:has-text("Multi-Terminal View")').click();
    await expect(page.locator('button:has-text("Back to Grid")')).toBeVisible({ timeout: 5000 });

    // Switch to Split H — should auto-assign workers to both panes
    await page.locator('button[title="Split H"]').click();
    await page.waitForTimeout(500);

    // At least one xterm should be visible (auto-assigned workers get terminals)
    const xtermCount = await page.locator('.xterm').count();
    expect(xtermCount).toBeGreaterThanOrEqual(1);
  });

  test('selecting a worker in pane dropdown shows terminal', async ({ page }) => {
    await page.locator('button:has-text("Multi-Terminal View")').click();
    await expect(page.locator('button:has-text("Back to Grid")')).toBeVisible({ timeout: 5000 });

    // If a pane has "Select Worker" (no worker assigned), click to assign one
    const selectorBtn = page.locator('button:has-text("Select Worker")').first();
    const hasUnselected = await selectorBtn.isVisible().catch(() => false);

    if (hasUnselected) {
      await selectorBtn.click();
      await page.waitForTimeout(300);

      // Should see worker options in dropdown
      const workerOption = page.locator('.absolute.top-full button').first();
      await expect(workerOption).toBeVisible({ timeout: 3000 });

      // Click the first worker option
      await workerOption.click();
      await page.waitForTimeout(500);
    }

    // After selecting (or if already assigned), xterm container should be visible
    const xterm = page.locator('.xterm').first();
    await expect(xterm).toBeVisible({ timeout: 10000 });
  });

  test('terminal output is rendered in assigned pane', async ({ page }) => {
    await page.locator('button:has-text("Multi-Terminal View")').click();
    await expect(page.locator('button:has-text("Back to Grid")')).toBeVisible({ timeout: 5000 });

    // Ensure a worker is assigned — switch to Split H which auto-assigns
    await page.locator('button[title="Split H"]').click();
    await page.waitForTimeout(1000);

    // xterm should appear once worker is assigned and terminal loads
    const xterm = page.locator('.xterm').first();
    await expect(xterm).toBeVisible({ timeout: 15000 });

    // xterm rows should contain child elements (terminal is rendering)
    const xtermRows = page.locator('.xterm-rows').first();
    await expect(xtermRows).toBeVisible({ timeout: 5000 });
    const rowCount = await xtermRows.locator('> *').count();
    expect(rowCount).toBeGreaterThan(0);
  });

  test('Add Pane button increments pane count', async ({ page }) => {
    await page.locator('button:has-text("Multi-Terminal View")').click();
    await expect(page.locator('button:has-text("Back to Grid")')).toBeVisible({ timeout: 5000 });

    // Start in single mode
    await page.locator('button[title="Single"]').click();
    await page.waitForTimeout(300);

    // Verify we start with 1 pane
    await expect(page.locator('text=1 pane')).toBeVisible({ timeout: 3000 });

    // Click Add Pane
    await page.locator('button[title="Add Pane"]').click();
    await page.waitForTimeout(300);

    // Should now show 2 panes
    await expect(page.locator('text=2 panes')).toBeVisible({ timeout: 3000 });
  });

  test('Back to Grid returns to worker card view', async ({ page }) => {
    await page.locator('button:has-text("Multi-Terminal View")').click();
    await expect(page.locator('button:has-text("Back to Grid")')).toBeVisible({ timeout: 5000 });

    // Click Back to Grid
    await page.locator('button:has-text("Back to Grid")').click();
    await page.waitForTimeout(500);

    // Should see the Multi-Terminal View button again (grid mode)
    await expect(page.locator('button:has-text("Multi-Terminal View")')).toBeVisible({ timeout: 5000 });

    // Worker cards should be visible
    const workerCards = page.locator('[data-testid^="worker-card-"]');
    expect(await workerCards.count()).toBeGreaterThan(0);
  });

  test('pane close button decrements pane count', async ({ page }) => {
    await page.locator('button:has-text("Multi-Terminal View")').click();
    await expect(page.locator('button:has-text("Back to Grid")')).toBeVisible({ timeout: 5000 });

    // Switch to Split H for 2 panes
    await page.locator('button[title="Split H"]').click();
    await page.waitForTimeout(300);
    await expect(page.locator('text=2 panes')).toBeVisible({ timeout: 3000 });

    // Find and click the close button on the last pane
    const closeButtons = page.locator('button[title="Close pane"]');
    const closeCount = await closeButtons.count();
    if (closeCount > 0) {
      await closeButtons.last().click();
      await page.waitForTimeout(300);

      // Should now show 1 pane
      await expect(page.locator('text=1 pane')).toBeVisible({ timeout: 3000 });
    }
  });

  test('layout switching preserves assigned workers', async ({ page }) => {
    await page.locator('button:has-text("Multi-Terminal View")').click();
    await expect(page.locator('button:has-text("Back to Grid")')).toBeVisible({ timeout: 5000 });

    // Start with Split H — auto-assigns workers
    await page.locator('button[title="Split H"]').click();
    await page.waitForTimeout(500);

    // Verify xterm is visible (worker auto-assigned)
    await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 5000 });

    // Switch to 2x2 layout
    await page.locator('button[title="2×2"]').click();
    await page.waitForTimeout(500);

    // The previously assigned worker should still be visible (xterm still rendered)
    await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 5000 });

    // Pane count should be 4
    await expect(page.locator('text=4 panes')).toBeVisible({ timeout: 3000 });
  });

  test('switching back to Single from multi-pane keeps 1 pane', async ({ page }) => {
    await page.locator('button:has-text("Multi-Terminal View")').click();
    await expect(page.locator('button:has-text("Back to Grid")')).toBeVisible({ timeout: 5000 });

    // Go to 2x2 (auto-assigns workers)
    await page.locator('button[title="2×2"]').click();
    await page.waitForTimeout(500);
    await expect(page.locator('text=4 panes')).toBeVisible({ timeout: 3000 });

    // Switch back to Single
    await page.locator('button[title="Single"]').click();
    await page.waitForTimeout(500);

    // Should have 1 pane
    await expect(page.locator('text=1 pane')).toBeVisible({ timeout: 3000 });
  });
});
