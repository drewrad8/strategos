import { test, expect } from '@playwright/test';



test.describe('Activity Sidebar Tabs', () => {

  test('sidebar has Activity and ADRs tabs', async ({ page }) => {
    await page.goto('/');

    // Wait for app to load - use heading specifically
    await expect(page.getByRole('heading', { name: 'STRATEGOS' })).toBeVisible({ timeout: 10000 });

    // Click Activity button to open sidebar
    await page.click('[data-testid="activity-toggle"]');

    // Wait for sidebar to animate open
    await page.waitForTimeout(500);

    // Check for tab buttons
    const activityTab = page.locator('button:has-text("Activity")').first();
    const adrsTab = page.locator('button:has-text("ADRs")');

    await expect(activityTab).toBeVisible({ timeout: 5000 });
    await expect(adrsTab).toBeVisible({ timeout: 5000 });
  });

  test('clicking ADRs tab loads ADRPanel component', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'STRATEGOS' })).toBeVisible({ timeout: 10000 });

    // Open sidebar
    await page.click('[data-testid="activity-toggle"]');
    await page.waitForTimeout(500);

    // Click ADRs tab
    await page.click('button:has-text("ADRs")');
    await page.waitForTimeout(300);

    // Should see ADR-related content
    const hasADRContent = await page.locator('text=/ADR-|Architecture Decision|Security/i').first().isVisible({ timeout: 5000 }).catch(() => false);
    expect(hasADRContent).toBeTruthy();
  });

});
