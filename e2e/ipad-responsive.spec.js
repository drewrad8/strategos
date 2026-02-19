import { test, expect } from '@playwright/test';

test.use({ baseURL: 'http://localhost:38007' });

test.describe('iPad Responsive Layout', () => {
  // Test focused worker view on iPad
  test('iPad portrait - focused worker view fits properly', async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 768, height: 1024 },
      deviceScaleFactor: 2,
      isMobile: false,
      hasTouch: true,
    });
    const page = await context.newPage();

    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);

    // Click on first worker card to open focused view
    const openBtn = page.locator('[data-testid^="open-worker-"]').first();
    if (await openBtn.isVisible()) {
      await openBtn.click();
      await page.waitForTimeout(1000);

      // Check for horizontal scroll in focused view
      const hasHorizontalScroll = await page.evaluate(() => {
        return document.documentElement.scrollWidth > document.documentElement.clientWidth;
      });

      await page.screenshot({
        path: 'e2e/screenshots/ipad-portrait-focused.png',
        fullPage: true
      });

      expect(hasHorizontalScroll).toBe(false);

      // Check that VoiceInput is visible at bottom
      const voiceInputVisible = await page.locator('textarea[placeholder*="Send"]').isVisible();
      expect(voiceInputVisible).toBe(true);
    }

    await context.close();
  });


  // iPad Mini landscape (1024x768)
  test('iPad Mini landscape - no horizontal overflow', async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 1024, height: 768 },
      deviceScaleFactor: 2,
      isMobile: false,
      hasTouch: true,
    });
    const page = await context.newPage();

    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);

    // Check for horizontal scrollbar
    const hasHorizontalScroll = await page.evaluate(() => {
      return document.documentElement.scrollWidth > document.documentElement.clientWidth;
    });

    // Screenshot for debugging
    await page.screenshot({
      path: 'e2e/screenshots/ipad-mini-landscape.png',
      fullPage: true
    });

    expect(hasHorizontalScroll).toBe(false);

    await context.close();
  });

  // iPad portrait (768x1024)
  test('iPad portrait - no horizontal overflow', async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 768, height: 1024 },
      deviceScaleFactor: 2,
      isMobile: false,
      hasTouch: true,
    });
    const page = await context.newPage();

    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);

    // Check for horizontal scrollbar
    const hasHorizontalScroll = await page.evaluate(() => {
      return document.documentElement.scrollWidth > document.documentElement.clientWidth;
    });

    // Screenshot for debugging
    await page.screenshot({
      path: 'e2e/screenshots/ipad-portrait.png',
      fullPage: true
    });

    expect(hasHorizontalScroll).toBe(false);

    await context.close();
  });

  // iPad Pro 11 landscape (1194x834)
  test('iPad Pro 11 landscape - no horizontal overflow', async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 1194, height: 834 },
      deviceScaleFactor: 2,
      isMobile: false,
      hasTouch: true,
    });
    const page = await context.newPage();

    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);

    const hasHorizontalScroll = await page.evaluate(() => {
      return document.documentElement.scrollWidth > document.documentElement.clientWidth;
    });

    await page.screenshot({
      path: 'e2e/screenshots/ipad-pro-11-landscape.png',
      fullPage: true
    });

    expect(hasHorizontalScroll).toBe(false);

    await context.close();
  });

  // Check elements fit within viewport
  test('iPad portrait - elements do not overflow viewport width', async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 768, height: 1024 },
      deviceScaleFactor: 2,
      isMobile: false,
      hasTouch: true,
    });
    const page = await context.newPage();

    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);

    // Check if any elements overflow
    const overflowingElements = await page.evaluate(() => {
      const viewportWidth = window.innerWidth;
      const allElements = document.querySelectorAll('*');
      const overflowing = [];

      allElements.forEach((el) => {
        const rect = el.getBoundingClientRect();
        if (rect.right > viewportWidth + 1 || rect.left < -1) {
          // Ignore fixed position elements that are intentionally off-screen
          const style = getComputedStyle(el);
          if (style.position !== 'fixed' && style.visibility !== 'hidden' && style.display !== 'none') {
            overflowing.push({
              tag: el.tagName,
              class: el.className?.toString().slice(0, 80),
              left: rect.left,
              right: rect.right,
              width: rect.width,
              viewportWidth
            });
          }
        }
      });

      return overflowing.slice(0, 10); // Limit to first 10
    });

    if (overflowingElements.length > 0) {
      console.log('Overflowing elements:', JSON.stringify(overflowingElements, null, 2));
    }

    expect(overflowingElements.length).toBe(0);

    await context.close();
  });

  // Check header fits
  test('iPad portrait - header elements do not wrap awkwardly', async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 768, height: 1024 },
      deviceScaleFactor: 2,
      isMobile: false,
      hasTouch: true,
    });
    const page = await context.newPage();

    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);

    // Get header height - should be reasonable (not multi-line wrapped)
    const headerInfo = await page.evaluate(() => {
      const header = document.querySelector('header');
      if (!header) return null;
      const rect = header.getBoundingClientRect();
      return {
        height: rect.height,
        width: rect.width
      };
    });

    console.log('Header info:', headerInfo);

    // Header should be single-line height (around 64px)
    expect(headerInfo.height).toBeLessThan(100);

    await context.close();
  });

  // Check with sidebar open
  test('iPad portrait - sidebar open does not cause overflow', async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 768, height: 1024 },
      deviceScaleFactor: 2,
      isMobile: false,
      hasTouch: true,
    });
    const page = await context.newPage();

    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);

    // Open activity sidebar
    const activityToggle = page.locator('[data-testid="activity-toggle"]');
    if (await activityToggle.isVisible()) {
      await activityToggle.click();
      await page.waitForTimeout(500);
    }

    const hasHorizontalScroll = await page.evaluate(() => {
      return document.documentElement.scrollWidth > document.documentElement.clientWidth;
    });

    await page.screenshot({
      path: 'e2e/screenshots/ipad-portrait-sidebar.png',
      fullPage: true
    });

    expect(hasHorizontalScroll).toBe(false);

    await context.close();
  });

  // Check worker cards grid
  test('iPad portrait - worker cards grid layout is reasonable', async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 768, height: 1024 },
      deviceScaleFactor: 2,
      isMobile: false,
      hasTouch: true,
    });
    const page = await context.newPage();

    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);

    // Check grid layout
    const gridInfo = await page.evaluate(() => {
      const grid = document.querySelector('.grid');
      if (!grid) return { hasGrid: false };

      const style = getComputedStyle(grid);
      const cards = grid.querySelectorAll('[data-testid^="worker-card-"]');

      return {
        hasGrid: true,
        gridTemplateColumns: style.gridTemplateColumns,
        cardCount: cards.length,
        gridWidth: grid.getBoundingClientRect().width
      };
    });

    console.log('Grid info:', gridInfo);

    // Grid should exist and cards should fit
    if (gridInfo.cardCount > 0) {
      expect(gridInfo.gridWidth).toBeLessThanOrEqual(768);
    }

    await context.close();
  });
});
