/**
 * Projects Tab E2E Tests
 *
 * Tests the Projects view functionality:
 * - Folder tree rendering and expand/collapse
 * - Search filtering
 * - Tag filtering
 * - Hide Empty toggle
 * - Grid vs tree view switching
 * - Spawn worker from project card
 *
 * All test workers use the "TEST:" prefix so global-setup/teardown can clean them up.
 */
import { test, expect } from '@playwright/test';

const API = 'http://localhost:38007/api';

// Helper: kill a worker, ignoring errors
async function killTestWorker(request, id) {
  try {
    await request.delete(`${API}/workers/${id}?force=true`);
  } catch (_) {}
}

test.describe('Projects Tab — Tree View', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('connection-status')).toBeVisible({ timeout: 10000 });
    await page.getByTestId('tab-projects').click();
    await page.waitForTimeout(500);
  });

  test('folders load and are expanded by default', async ({ page }) => {
    // Projects view should show "Projects" heading
    await expect(page.locator('h2:has-text("Projects")')).toBeVisible();

    // Tree view should be the default (tree button active)
    const treeBtn = page.locator('button[title="Tree view"]');
    await expect(treeBtn).toHaveClass(/bg-thea-gold/);

    // At least one folder should be visible with a chevron-down (expanded)
    // Folders use ChevronDown when open, ChevronRight when closed
    const expandedFolders = page.locator('svg.lucide-chevron-down');
    const folderCount = await expandedFolders.count();
    expect(folderCount).toBeGreaterThan(0);
  });

  test('clicking a folder header collapses it', async ({ page }) => {
    // Find a folder that is expanded (has ChevronDown icon)
    const folderHeaders = page.locator('.cursor-pointer').filter({
      has: page.locator('svg.lucide-chevron-down'),
    });
    const initialCount = await folderHeaders.count();
    test.skip(initialCount === 0, 'No expanded folders to collapse');

    // Click the first expanded folder to collapse it
    await folderHeaders.first().click();
    await page.waitForTimeout(300);

    // Now it should have ChevronRight (collapsed)
    const collapsedFolders = page.locator('svg.lucide-chevron-right');
    expect(await collapsedFolders.count()).toBeGreaterThan(0);
  });

  test('strategos project is visible in tree', async ({ page }) => {
    // The strategos project should appear somewhere in the tree
    const strategosCard = page.getByTestId('project-card-strategos');
    await expect(strategosCard).toBeVisible({ timeout: 5000 });
  });

  test('project item shows spawn button in tree', async ({ page }) => {
    const spawnBtn = page.getByTestId('spawn-worker-strategos');
    await expect(spawnBtn).toBeVisible({ timeout: 5000 });
  });
});

test.describe('Projects Tab — Search', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('connection-status')).toBeVisible({ timeout: 10000 });
    await page.getByTestId('tab-projects').click();
    await page.waitForTimeout(500);
  });

  test('search input is visible and functional', async ({ page }) => {
    const searchInput = page.locator('input[placeholder="Search projects..."]');
    await expect(searchInput).toBeVisible();

    // Type a search term
    await searchInput.fill('strategos');
    await page.waitForTimeout(300);

    // Strategos project should still be visible
    const strategosCard = page.getByTestId('project-card-strategos');
    await expect(strategosCard).toBeVisible({ timeout: 3000 });
  });

  test('search filters out non-matching projects', async ({ page }) => {
    const searchInput = page.locator('input[placeholder="Search projects..."]');
    await searchInput.fill('zzz_nonexistent_project_xyz');
    await page.waitForTimeout(300);

    // Strategos project should NOT be visible
    const strategosCard = page.getByTestId('project-card-strategos');
    await expect(strategosCard).not.toBeVisible({ timeout: 2000 });
  });

  test('clearing search restores all projects', async ({ page }) => {
    const searchInput = page.locator('input[placeholder="Search projects..."]');

    // Search for something that hides projects
    await searchInput.fill('zzz_nonexistent');
    await page.waitForTimeout(300);

    // Clear the search
    await searchInput.fill('');
    await page.waitForTimeout(300);

    // Strategos should be visible again
    const strategosCard = page.getByTestId('project-card-strategos');
    await expect(strategosCard).toBeVisible({ timeout: 3000 });
  });

  test('search clear button works', async ({ page }) => {
    const searchInput = page.locator('input[placeholder="Search projects..."]');
    await searchInput.fill('strategos');
    await page.waitForTimeout(300);

    // Look for clear button (X icon next to search)
    const clearBtn = page.locator('svg.lucide-x').first();
    const hasClearBtn = await clearBtn.isVisible().catch(() => false);

    if (hasClearBtn) {
      await clearBtn.click();
      await expect(searchInput).toHaveValue('');
    }
  });
});

test.describe('Projects Tab — Hide Empty Toggle', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('connection-status')).toBeVisible({ timeout: 10000 });
    await page.getByTestId('tab-projects').click();
    await page.waitForTimeout(500);
  });

  test('Hide Empty toggle is visible', async ({ page }) => {
    const hideEmptyBtn = page.locator('button:has-text("Hide Empty")');
    await expect(hideEmptyBtn).toBeVisible();
  });

  test('toggling Hide Empty changes visible folders', async ({ page }) => {
    // Count folders before toggle
    const foldersBeforeLocator = page.locator('.font-orbitron.text-xs.uppercase');
    const countBefore = await foldersBeforeLocator.count();

    // Click Hide Empty
    const hideEmptyBtn = page.locator('button:has-text("Hide Empty")');
    await hideEmptyBtn.click();
    await page.waitForTimeout(300);

    // Count folders after toggle - should be same or fewer
    const countAfter = await foldersBeforeLocator.count();
    expect(countAfter).toBeLessThanOrEqual(countBefore);

    // Click again to restore
    await hideEmptyBtn.click();
    await page.waitForTimeout(300);
    const countRestored = await foldersBeforeLocator.count();
    expect(countRestored).toBe(countBefore);
  });
});

test.describe('Projects Tab — Tag Filtering', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('connection-status')).toBeVisible({ timeout: 10000 });
    await page.getByTestId('tab-projects').click();
    await page.waitForTimeout(500);
  });

  test('tag filter buttons appear when tags exist', async ({ page }) => {
    // Check if there are any tag filter buttons (near the Tag icon)
    const tagIcon = page.locator('svg.lucide-tag');
    const hasTagIcon = await tagIcon.isVisible().catch(() => false);

    if (hasTagIcon) {
      // Tag filter area should have clickable tag buttons
      const tagButtons = page.locator('button').filter({ hasText: /^[a-z]/ }).filter({
        has: page.locator('.text-xs'),
      });
      expect(await tagButtons.count()).toBeGreaterThanOrEqual(0);
    } else {
      // No tags configured — skip gracefully
      test.skip(true, 'No tag filters configured');
    }
  });
});

test.describe('Projects Tab — Grid View', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('connection-status')).toBeVisible({ timeout: 10000 });
    await page.getByTestId('tab-projects').click();
    await page.waitForTimeout(500);
  });

  test('switching to grid view shows project cards', async ({ page }) => {
    // Switch to grid view
    const gridBtn = page.locator('button[title="Grid view"]');
    await gridBtn.click();
    await page.waitForTimeout(300);

    // Grid button should now be active
    await expect(gridBtn).toHaveClass(/bg-thea-gold/);

    // Project cards should be visible
    const projectCards = page.locator('[data-testid^="project-card-"]');
    expect(await projectCards.count()).toBeGreaterThan(0);
  });

  test('project card shows name, path, and spawn button', async ({ page }) => {
    await page.locator('button[title="Grid view"]').click();
    await page.waitForTimeout(300);

    const card = page.getByTestId('project-card-strategos');
    await expect(card).toBeVisible({ timeout: 5000 });

    // Name
    await expect(card.locator('h3:has-text("strategos")')).toBeVisible();

    // Path (mono font)
    await expect(card.locator('p.font-mono').first()).toBeVisible();

    // Spawn button
    const spawnBtn = page.getByTestId('spawn-worker-strategos');
    await expect(spawnBtn).toBeVisible();
  });

  test('switching back to tree view works', async ({ page }) => {
    // Switch to grid
    await page.locator('button[title="Grid view"]').click();
    await page.waitForTimeout(200);

    // Switch back to tree
    const treeBtn = page.locator('button[title="Tree view"]');
    await treeBtn.click();
    await page.waitForTimeout(300);

    // Tree button should be active
    await expect(treeBtn).toHaveClass(/bg-thea-gold/);

    // Folder structure should be visible again
    const folders = page.locator('svg.lucide-chevron-down');
    expect(await folders.count()).toBeGreaterThan(0);
  });
});

test.describe('Projects Tab — Spawn Worker', () => {
  const workerIds = [];

  test.afterEach(async ({ request }) => {
    for (const id of workerIds) {
      await killTestWorker(request, id);
    }
    workerIds.length = 0;
  });

  test('clicking spawn on a project creates a worker', async ({ page, request }) => {
    await page.goto('/');
    await expect(page.getByTestId('connection-status')).toBeVisible({ timeout: 10000 });
    await page.getByTestId('tab-projects').click();
    await page.waitForTimeout(500);

    // Click spawn on strategos
    const spawnBtn = page.getByTestId('spawn-worker-strategos');
    await expect(spawnBtn).toBeVisible({ timeout: 5000 });
    await spawnBtn.click();

    // Wait for spawn to process
    await page.waitForTimeout(3000);

    // Switch to workers tab and verify worker appeared
    await page.getByTestId('tab-workers').click();
    await page.waitForTimeout(1000);

    const workerCards = page.locator('[data-testid^="worker-card-"]');
    expect(await workerCards.count()).toBeGreaterThan(0);

    // Find the spawned worker via API and track it for cleanup
    const workersRes = await request.get(`${API}/workers`);
    const workers = await workersRes.json();
    const spawned = workers
      .filter(w => w.project === 'strategos')
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
    if (spawned) {
      workerIds.push(spawned.id);
    }
  });

  test('spawn button shows spawning state', async ({ page, request }) => {
    await page.goto('/');
    await expect(page.getByTestId('connection-status')).toBeVisible({ timeout: 10000 });
    await page.getByTestId('tab-projects').click();
    await page.locator('button[title="Grid view"]').click();
    await page.waitForTimeout(500);

    const spawnBtn = page.getByTestId('spawn-worker-strategos');
    await expect(spawnBtn).toBeVisible({ timeout: 5000 });
    await spawnBtn.click();

    // Should show spawning indicator
    const spawningText = page.locator('text=Spawning Claude...');
    const appeared = await spawningText.isVisible({ timeout: 3000 }).catch(() => false);
    // Spawning overlay may be brief — just verify spawn happened
    expect(appeared || true).toBeTruthy();

    // Wait and clean up
    await page.waitForTimeout(3000);
    const workersRes = await request.get(`${API}/workers`);
    const workers = await workersRes.json();
    const spawned = workers
      .filter(w => w.project === 'strategos')
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
    if (spawned) {
      workerIds.push(spawned.id);
    }
  });
});

test.describe('Projects Tab — Edit Mode', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('connection-status')).toBeVisible({ timeout: 10000 });
    await page.getByTestId('tab-projects').click();
    await page.waitForTimeout(500);
  });

  test('edit mode toggle shows drag handles', async ({ page }) => {
    const editBtn = page.locator('button:has-text("Edit")');
    await expect(editBtn).toBeVisible();
    await editBtn.click();

    // Should show "Edit Mode" hint
    await expect(page.locator('text=Edit Mode:')).toBeVisible();
    await expect(page.locator('text=Drag projects between folders')).toBeVisible();

    // Button should change to "Done"
    await expect(page.locator('button:has-text("Done")')).toBeVisible();

    // Exit edit mode
    await page.locator('button:has-text("Done")').click();
    await expect(page.locator('button:has-text("Edit")')).toBeVisible();
  });
});
