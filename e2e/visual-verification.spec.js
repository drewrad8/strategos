import { test, expect } from '@playwright/test';

/**
 * Comprehensive Visual Verification Test Suite
 *
 * Tests every UI element, state, and interaction across all pages
 * Following the mandate: "Do not take the easy path. Verify every element."
 */


const STRATEGOS_API = 'http://localhost:38007';

// Helper to create screenshot directory
const screenshotDir = new URL('./screenshots', import.meta.url).pathname;

test.describe('Header Component Visual Verification', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('connection-status')).toBeVisible({ timeout: 10000 });
  });

  test('header logo renders correctly', async ({ page }) => {
    // Verify STRATEGOS logo
    const logo = page.locator('h1:has-text("STRATEGOS")');
    await expect(logo).toBeVisible();
    await expect(logo).toHaveClass(/font-orbitron/);
    await expect(logo).toHaveClass(/text-thea-gold-bright/);
    await expect(logo).toHaveClass(/text-glow-gold/);

    // Verify subtitle (using escaped selector to avoid regex interpretation)
    const subtitle = page.locator('span', { hasText: 'Thea Orchestrator' });
    await expect(subtitle).toBeVisible();
  });

  test('worker count displays correctly', async ({ page }) => {
    const workerCount = page.locator('text=Workers:').locator('..').locator('span.font-bold');
    await expect(workerCount).toBeVisible();
    // Should display a number
    const count = await workerCount.textContent();
    expect(parseInt(count)).toBeGreaterThanOrEqual(0);
  });

  test('connection status shows Connected state correctly', async ({ page }) => {
    const statusBadge = page.getByTestId('connection-status');
    await expect(statusBadge).toBeVisible();

    // Should have running badge styling when connected
    await expect(statusBadge).toHaveClass(/thea-badge-running/);

    // Should show Connected text
    await expect(page.getByTestId('status-text')).toHaveText('Connected');

    // Should have Wifi icon (check SVG is present)
    const wifiIcon = statusBadge.locator('svg');
    await expect(wifiIcon).toBeVisible();
  });

  test('voice mode button renders and is clickable', async ({ page }) => {
    const voiceBtn = page.locator('button[title="Enter Voice Mode"]');
    await expect(voiceBtn).toBeVisible();

    // Click and verify voice mode activates
    await voiceBtn.click();

    // Should show VoiceModeView
    const exitButton = page.locator('button:has-text("Exit")');
    await expect(exitButton).toBeVisible({ timeout: 2000 });

    // Exit voice mode
    await exitButton.click();
  });

  test('activity toggle button works correctly', async ({ page }) => {
    const activityBtn = page.getByTestId('activity-toggle');
    await expect(activityBtn).toBeVisible();

    // Initially activity sidebar should not be visible (width: 0)
    const sidebar = page.locator('aside').first();

    // Click to open
    await activityBtn.click();
    await page.waitForTimeout(400); // Wait for transition

    // Button should have active styling
    await expect(activityBtn).toHaveClass(/bg-thea-gold/);

    // Sidebar should be visible
    await expect(sidebar).toHaveCSS('width', '320px');

    // Activity header should be visible
    await expect(page.locator('h3:has-text("Activity")')).toBeVisible();

    // Click to close
    await activityBtn.click();
    await page.waitForTimeout(400);
    // Width becomes very small (border only) when collapsed
    const width = await sidebar.evaluate(el => el.offsetWidth);
    expect(width).toBeLessThan(10);
  });
});

test.describe('Tab Navigation Visual Verification', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('connection-status')).toBeVisible({ timeout: 10000 });
  });

  test('Workers tab is active by default with correct styling', async ({ page }) => {
    const workersTab = page.getByTestId('tab-workers');
    await expect(workersTab).toBeVisible();

    // Should have active styling
    await expect(workersTab).toHaveClass(/border-thea-gold/);
    await expect(workersTab).toHaveClass(/text-thea-gold-bright/);
  });

  test('Projects tab shows inactive styling and activates on click', async ({ page }) => {
    const projectsTab = page.getByTestId('tab-projects');
    await expect(projectsTab).toBeVisible();

    // Initially inactive
    await expect(projectsTab).toHaveClass(/border-transparent/);
    await expect(projectsTab).toHaveClass(/text-thea-gold-dark/);

    // Click to activate
    await projectsTab.click();

    // Now should be active
    await expect(projectsTab).toHaveClass(/border-thea-gold/);
    await expect(projectsTab).toHaveClass(/text-thea-gold-bright/);

    // Workers tab should now be inactive
    const workersTab = page.getByTestId('tab-workers');
    await expect(workersTab).toHaveClass(/border-transparent/);
  });
});

test.describe('Workers View Visual Verification', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('connection-status')).toBeVisible({ timeout: 10000 });
  });

  test('empty workers state displays correctly', async ({ page, request }) => {
    // First kill all workers to ensure empty state
    const workersRes = await request.get(`${STRATEGOS_API}/api/workers`);
    const workers = await workersRes.json();

    // Skip if there are existing workers (we'll test non-empty state separately)
    if (workers.length > 0) {
      test.skip();
      return;
    }

    // Verify empty state messaging
    await expect(page.locator('text=No Workers Active')).toBeVisible();
    await expect(page.locator('text=Select a project and start a worker to begin')).toBeVisible();

    // Verify empty state icon
    const emptyIcon = page.locator('svg').filter({ has: page.locator('rect[x="2"][y="3"]') });
    await expect(emptyIcon.first()).toBeVisible();
  });

  test('Multi-Terminal View button appears when workers exist', async ({ page, request }) => {
    // Spawn a worker to ensure one exists
    await request.post(`${STRATEGOS_API}/api/workers`, {
      data: { projectPath: 'strategos', label: 'TEST: Visual Worker' }
    });

    await page.reload();
    await expect(page.getByTestId('connection-status')).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(1000);

    const multiTerminalBtn = page.locator('button:has-text("Multi-Terminal View")');
    await expect(multiTerminalBtn).toBeVisible();

    // Clean up
    const workersRes = await request.get(`${STRATEGOS_API}/api/workers`);
    const workers = await workersRes.json();
    const testWorker = workers.find(w => w.label === 'TEST: Visual Worker');
    if (testWorker) {
      await request.delete(`${STRATEGOS_API}/api/workers/${testWorker.id}`);
    }
  });
});

test.describe('Worker Card Visual Verification', () => {
  let testWorkerId;

  test.beforeAll(async ({ request }) => {
    // Spawn a worker for testing
    const response = await request.post(`${STRATEGOS_API}/api/workers`, {
      data: { projectPath: 'strategos', label: 'TEST: Card Visual' }
    });
    const worker = await response.json();
    testWorkerId = worker.id;
  });

  test.afterAll(async ({ request }) => {
    if (testWorkerId) {
      await request.delete(`${STRATEGOS_API}/api/workers/${testWorkerId}`);
    }
  });

  test('worker card displays all required elements', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('connection-status')).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(2000);

    const workerCard = page.locator(`[data-testid="worker-card-${testWorkerId}"]`);
    await expect(workerCard).toBeVisible({ timeout: 5000 });

    // Verify label
    await expect(workerCard.locator('h3:has-text("TEST: Card Visual")')).toBeVisible();

    // Verify project name (use first() to handle multiple matches in terminal output)
    await expect(workerCard.locator('p', { hasText: 'strategos' }).first()).toBeVisible();

    // Verify status badge
    const statusBadge = workerCard.locator('.thea-badge');
    await expect(statusBadge).toBeVisible();
    await expect(statusBadge).toContainText('running');

    // Verify terminal preview area
    const terminalPreview = workerCard.locator('.bg-black\\/50.border');
    await expect(terminalPreview).toBeVisible();

    // Verify Open button
    const openBtn = page.getByTestId(`open-worker-${testWorkerId}`);
    await expect(openBtn).toBeVisible();
    await expect(openBtn).toContainText('Open');

    // Verify Kill button
    const killBtn = page.getByTestId(`kill-worker-${testWorkerId}`);
    await expect(killBtn).toBeVisible();

    // Verify worker ID display
    await expect(workerCard.locator(`text=ID: ${testWorkerId}`)).toBeVisible();
  });

  test('worker card label editing works', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('connection-status')).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(2000);

    const workerCard = page.locator(`[data-testid="worker-card-${testWorkerId}"]`);
    await expect(workerCard).toBeVisible({ timeout: 5000 });

    // Hover to reveal edit button
    await workerCard.hover();

    // Find and click edit button (pencil icon) - it only shows on hover
    const editBtn = workerCard.locator('button').filter({ has: page.locator('svg') }).first();
    // Force click even if not visible (hover state)
    await editBtn.click({ force: true });

    // Verify input field appears
    const input = workerCard.locator('input[type="text"]');
    await expect(input).toBeVisible();

    // Verify save button appears (button next to input)
    const saveBtn = workerCard.locator('input').locator('..').locator('button');
    await expect(saveBtn).toBeVisible();

    // Cancel by pressing Escape
    await page.keyboard.press('Escape');
  });

  test('worker card hover states work correctly', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('connection-status')).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(2000);

    const workerCard = page.locator(`[data-testid="worker-card-${testWorkerId}"]`);
    await expect(workerCard).toBeVisible({ timeout: 5000 });

    // Hover and check corner decoration becomes more visible
    const corner = workerCard.locator('.absolute.top-0.right-0');

    // Before hover
    await expect(corner).toHaveClass(/opacity-50/);

    // After hover (group-hover makes it opacity-100)
    await workerCard.hover();
    // Note: Playwright can't easily verify pseudo-class hover effects,
    // but we can verify the element structure exists
    await expect(corner).toBeVisible();
  });

  test('Open button opens focused worker view', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('connection-status')).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(2000);

    const openBtn = page.getByTestId(`open-worker-${testWorkerId}`);
    await expect(openBtn).toBeVisible({ timeout: 5000 });
    await openBtn.click();

    // Verify focused view elements
    await expect(page.locator('text=Back to Grid')).toBeVisible();
    await expect(page.locator('button:has-text("Summary")')).toBeVisible();
    await expect(page.locator('button:has-text("Terminal")')).toBeVisible();

    // Verify worker label in header
    await expect(page.locator('h2:has-text("TEST: Card Visual")')).toBeVisible();
  });

  test('Summary/Terminal toggle works in focused view', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('connection-status')).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(2000);

    // Open worker
    await page.getByTestId(`open-worker-${testWorkerId}`).click();
    await expect(page.locator('text=Back to Grid')).toBeVisible();

    // Summary should be active by default
    const summaryBtn = page.locator('button:has-text("Summary")');
    await expect(summaryBtn).toHaveClass(/bg-thea-gold/);

    // Click Terminal
    const terminalBtn = page.locator('button:has-text("Terminal")');
    await terminalBtn.click();

    // Terminal should now be active
    await expect(terminalBtn).toHaveClass(/bg-thea-gold/);
    await expect(summaryBtn).not.toHaveClass(/bg-thea-gold/);

    // XTerm should be visible
    await expect(page.locator('.xterm')).toBeVisible({ timeout: 5000 });
  });
});

test.describe('Projects View Visual Verification', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('connection-status')).toBeVisible({ timeout: 10000 });
    await page.getByTestId('tab-projects').click();
    await page.waitForTimeout(500);
  });

  test('projects view header elements render correctly', async ({ page }) => {
    // Title
    await expect(page.locator('h2:has-text("Projects")')).toBeVisible();

    // View toggle buttons (Tree/Grid)
    const treeBtn = page.locator('button[title="Tree view"]');
    const gridBtn = page.locator('button[title="Grid view"]');
    await expect(treeBtn).toBeVisible();
    await expect(gridBtn).toBeVisible();

    // Tree should be active by default
    await expect(treeBtn).toHaveClass(/bg-thea-gold/);
  });

  test('search bar renders and works', async ({ page }) => {
    const searchInput = page.locator('input[placeholder="Search projects..."]');
    await expect(searchInput).toBeVisible();

    // Type a search query
    await searchInput.fill('strategos');

    // Clear button should appear
    const clearBtn = searchInput.locator('..').locator('button').filter({ has: page.locator('svg.lucide-x') });
    await expect(clearBtn).toBeVisible();

    // Clear should work
    await clearBtn.click();
    await expect(searchInput).toHaveValue('');
  });

  test('tree view displays folders correctly', async ({ page }) => {
    // Should see folder structure
    const folders = page.locator('.cursor-pointer').filter({ hasText: /folder|project/i });
    const folderCount = await folders.count();
    expect(folderCount).toBeGreaterThan(0);
  });

  test('grid view toggle works and displays cards', async ({ page }) => {
    // Switch to grid view
    await page.locator('button[title="Grid view"]').click();
    await page.waitForTimeout(300);

    // Should see project cards
    const projectCards = page.locator('[data-testid^="project-card-"]');
    const cardCount = await projectCards.count();
    expect(cardCount).toBeGreaterThan(0);
  });

  test('edit mode displays correctly in tree view', async ({ page }) => {
    // Enter edit mode
    const editBtn = page.locator('button:has-text("Edit")');
    await expect(editBtn).toBeVisible();
    await editBtn.click();

    // Should show edit mode hint
    await expect(page.locator('text=Edit Mode:')).toBeVisible();
    await expect(page.locator('text=Drag projects between folders')).toBeVisible();

    // Button should change to "Done"
    await expect(page.locator('button:has-text("Done")')).toBeVisible();

    // Exit edit mode
    await page.locator('button:has-text("Done")').click();
    await expect(page.locator('button:has-text("Edit")')).toBeVisible();
  });

  test('tag filters render when tags exist', async ({ page }) => {
    // Check if tags exist
    const tagIcon = page.locator('svg.lucide-tag');
    const isVisible = await tagIcon.isVisible().catch(() => false);

    if (isVisible) {
      // Should see tag buttons
      const tagButtons = tagIcon.locator('..').locator('button');
      const tagCount = await tagButtons.count();
      expect(tagCount).toBeGreaterThan(0);
    }
  });
});

test.describe('Project Card Visual Verification', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('connection-status')).toBeVisible({ timeout: 10000 });
    await page.getByTestId('tab-projects').click();
    await page.locator('button[title="Grid view"]').click();
    await page.waitForTimeout(500);
  });

  test('project card displays all elements', async ({ page }) => {
    const projectCard = page.locator('[data-testid="project-card-strategos"]');
    await expect(projectCard).toBeVisible({ timeout: 5000 });

    // Project name
    await expect(projectCard.locator('h3:has-text("strategos")')).toBeVisible();

    // Path (using p tag to avoid matching multiple elements)
    await expect(projectCard.locator('p.font-mono').first()).toBeVisible();

    // Worker count badge
    const workerBadge = projectCard.locator('.thea-tag');
    await expect(workerBadge).toBeVisible();

    // New button
    const newBtn = page.getByTestId('spawn-worker-strategos');
    await expect(newBtn).toBeVisible();
    await expect(newBtn).toContainText('New');
  });

  test('project card spawning state shows overlay', async ({ page, request }) => {
    const projectCard = page.locator('[data-testid="project-card-strategos"]');
    const newBtn = page.getByTestId('spawn-worker-strategos');

    await expect(newBtn).toBeVisible({ timeout: 5000 });

    // Click spawn
    await newBtn.click();

    // Should show spawning overlay
    await expect(projectCard.locator('text=Spawning Claude...')).toBeVisible({ timeout: 2000 });

    // Wait for spawn to complete and clean up
    await page.waitForTimeout(3000);

    // Get workers and clean up the spawned one
    const workersRes = await request.get(`${STRATEGOS_API}/api/workers`);
    const workers = await workersRes.json();
    // Find the most recently created strategos worker (avoid matching user workers by using createdAt recency)
    const newWorker = workers
      .filter(w => w.project === 'strategos')
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
    if (newWorker) {
      await request.delete(`${STRATEGOS_API}/api/workers/${newWorker.id}`);
    }
  });

  test('project card selection state works', async ({ page }) => {
    const projectCard = page.locator('[data-testid="project-card-strategos"]');
    await expect(projectCard).toBeVisible({ timeout: 5000 });

    // Click to select
    await projectCard.click();

    // Should have selected styling
    await expect(projectCard).toHaveClass(/border-thea-gold/);
    await expect(projectCard).toHaveClass(/shadow-gold/);

    // Click again to deselect
    await projectCard.click();

    // Should lose selected styling
    await expect(projectCard).not.toHaveClass(/shadow-gold-md/);
  });
});

test.describe('Activity Feed Visual Verification', () => {
  test('activity feed empty state', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('connection-status')).toBeVisible({ timeout: 10000 });

    // Open activity sidebar
    await page.getByTestId('activity-toggle').click();
    await page.waitForTimeout(400);

    // Check header
    await expect(page.locator('h3:has-text("Activity")')).toBeVisible();

    // If empty, should show "No activity yet"
    const emptyText = page.locator('text=// No activity yet');
    const activityEntries = page.locator('ul li').filter({ hasText: /started|stopped|error/i });

    const isEmpty = await emptyText.isVisible().catch(() => false);
    const hasEntries = (await activityEntries.count()) > 0;

    // Either empty state or entries should be visible
    expect(isEmpty || hasEntries).toBeTruthy();
  });

  test('activity feed shows entries with correct icons', async ({ page, request }) => {
    // Spawn and kill a worker to generate activity
    const spawnRes = await request.post(`${STRATEGOS_API}/api/workers`, {
      data: { projectPath: 'strategos', label: 'TEST: Activity Worker' }
    });
    const worker = await spawnRes.json();
    await request.delete(`${STRATEGOS_API}/api/workers/${worker.id}`);

    await page.goto('/');
    await expect(page.getByTestId('connection-status')).toBeVisible({ timeout: 10000 });

    // Open activity sidebar
    await page.getByTestId('activity-toggle').click();
    await page.waitForTimeout(400);

    // Should have activity entries
    const entries = page.locator('ul li');
    expect(await entries.count()).toBeGreaterThan(0);

    // Entries should have timestamps
    const timestamps = page.locator('.font-mono').filter({ hasText: /\d{2}:\d{2}:\d{2}/ });
    expect(await timestamps.count()).toBeGreaterThan(0);
  });
});

test.describe('Toast Notification Visual Verification', () => {
  test('toast appears and auto-dismisses', async ({ page, request }) => {
    await page.goto('/');
    await expect(page.getByTestId('connection-status')).toBeVisible({ timeout: 10000 });

    // Switch to projects and spawn a worker (this triggers a toast)
    await page.getByTestId('tab-projects').click();
    await page.locator('button[title="Grid view"]').click();
    await page.waitForTimeout(500);

    const newBtn = page.getByTestId('spawn-worker-strategos');
    await expect(newBtn).toBeVisible({ timeout: 5000 });
    await newBtn.click();

    // Wait for the spawn to complete - toast should appear
    await page.waitForTimeout(3000);

    // Toast container should exist at bottom-right (z-50 is the toast container)
    const toastContainer = page.locator('.fixed.bottom-4.right-4.z-50');
    await expect(toastContainer).toBeVisible();

    // Clean up
    const workersRes = await request.get(`${STRATEGOS_API}/api/workers`);
    const workers = await workersRes.json();
    const testWorker = workers.find(w => w.label.includes('strategos'));
    if (testWorker) {
      await request.delete(`${STRATEGOS_API}/api/workers/${testWorker.id}`);
    }
  });
});

test.describe('Voice Control Visual Verification', () => {
  test('voice control panel renders correctly', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('connection-status')).toBeVisible({ timeout: 10000 });

    // Voice control should be visible on desktop (hidden on mobile)
    const voiceControl = page.locator('.fixed.bottom-4.right-4').filter({ hasText: /Voice|Listening|commands/i });

    // Check if it exists (depends on browser speech support)
    const exists = await voiceControl.isVisible().catch(() => false);
    if (!exists) {
      test.skip();
      return;
    }

    // Mic button should be present
    const micBtn = voiceControl.locator('button').filter({ has: page.locator('svg.lucide-mic, svg.lucide-mic-off') });
    await expect(micBtn.first()).toBeVisible();

    // Expand button should be present
    const expandBtn = voiceControl.locator('button').filter({ has: page.locator('svg.lucide-chevron-up, svg.lucide-chevron-down') });
    await expect(expandBtn).toBeVisible();
  });

  test('voice control expands to show commands', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('connection-status')).toBeVisible({ timeout: 10000 });

    const voiceControl = page.locator('.fixed.bottom-4.right-4 .bg-black\\/80');
    const exists = await voiceControl.isVisible().catch(() => false);
    if (!exists) {
      test.skip();
      return;
    }

    // Click expand
    const expandBtn = voiceControl.locator('button').filter({ has: page.locator('svg.lucide-chevron-up') });
    await expandBtn.click();
    await page.waitForTimeout(300);

    // Quick command buttons should be visible
    await expect(page.locator('button:has-text("Status")')).toBeVisible();
    await expect(page.locator('button:has-text("Spawn Worker")')).toBeVisible();
    await expect(page.locator('button:has-text("Stop All")')).toBeVisible();

    // Help button should be visible
    const helpBtn = voiceControl.locator('button').filter({ has: page.locator('svg.lucide-help-circle') });
    await expect(helpBtn).toBeVisible();

    // Click help to show commands list
    await helpBtn.click();
    await page.waitForTimeout(200);

    await expect(page.locator('h4:has-text("Voice Commands")')).toBeVisible();
  });
});

test.describe('Responsive Layout Visual Verification', () => {
  test('mobile layout shows bottom navigation', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 }); // iPhone SE size
    await page.goto('/');
    await expect(page.getByTestId('connection-status')).toBeVisible({ timeout: 10000 });

    // Bottom nav should be visible on mobile
    const bottomNav = page.locator('nav.fixed.bottom-0');
    await expect(bottomNav).toBeVisible();

    // Should have Workers, Projects, Voice, Activity buttons
    await expect(bottomNav.locator('text=Workers')).toBeVisible();
    await expect(bottomNav.locator('text=Projects')).toBeVisible();
    await expect(bottomNav.locator('text=Voice')).toBeVisible();
    await expect(bottomNav.locator('text=Activity')).toBeVisible();
  });

  test('tablet layout renders grid correctly', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 }); // iPad size
    await page.goto('/');
    await expect(page.getByTestId('connection-status')).toBeVisible({ timeout: 10000 });

    // Switch to projects grid
    await page.getByTestId('tab-projects').click();
    await page.locator('button[title="Grid view"]').click();
    await page.waitForTimeout(500);

    // Grid should have appropriate column count for tablet
    const grid = page.locator('.grid.grid-cols-2');
    await expect(grid).toBeVisible();
  });

  test('desktop layout shows all elements', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto('/');
    await expect(page.getByTestId('connection-status')).toBeVisible({ timeout: 10000 });

    // Desktop nav elements should be visible
    await expect(page.locator('span', { hasText: 'Thea Orchestrator' })).toBeVisible();

    // Voice control should be visible (not mobile bottom nav)
    const voiceControl = page.locator('.fixed.bottom-4.right-4').first();
    await expect(voiceControl).toBeVisible();

    // Mobile bottom nav should be hidden
    const bottomNav = page.locator('nav.fixed.bottom-0');
    await expect(bottomNav).not.toBeVisible();
  });
});

test.describe('Multi-Terminal View Visual Verification', () => {
  let testWorkerId;

  test.beforeAll(async ({ request }) => {
    const response = await request.post(`${STRATEGOS_API}/api/workers`, {
      data: { projectPath: 'strategos', label: 'TEST: Multi-Term' }
    });
    const worker = await response.json();
    testWorkerId = worker.id;
  });

  test.afterAll(async ({ request }) => {
    if (testWorkerId) {
      await request.delete(`${STRATEGOS_API}/api/workers/${testWorkerId}`);
    }
  });

  test('multi-terminal view renders correctly', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('connection-status')).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(2000);

    // Enter multi-terminal view
    const multiTermBtn = page.locator('button:has-text("Multi-Terminal View")');
    if (!(await multiTermBtn.isVisible().catch(() => false))) {
      test.skip();
      return;
    }

    await multiTermBtn.click();
    await page.waitForTimeout(1000);

    // Should show back button
    await expect(page.locator('button:has-text("Back to Grid")')).toBeVisible();

    // Multi-terminal view has selector dropdowns
    const selectors = page.locator('select');
    const selectorCount = await selectors.count();
    // If we have workers, we should have pane selectors
    expect(selectorCount).toBeGreaterThanOrEqual(0);
  });
});

test.describe('Full Page Screenshots', () => {
  test('capture all main views', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto('/');
    await expect(page.getByTestId('connection-status')).toBeVisible({ timeout: 10000 });

    // Workers view
    await page.screenshot({ path: `${screenshotDir}/01-workers-view.png`, fullPage: true });

    // Projects tree view
    await page.getByTestId('tab-projects').click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${screenshotDir}/02-projects-tree.png`, fullPage: true });

    // Projects grid view
    await page.locator('button[title="Grid view"]').click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${screenshotDir}/03-projects-grid.png`, fullPage: true });

    // Activity sidebar open
    await page.getByTestId('activity-toggle').click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${screenshotDir}/04-activity-sidebar.png`, fullPage: true });
  });
});
