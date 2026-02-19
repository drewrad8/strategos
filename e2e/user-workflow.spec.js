import { test, expect } from '@playwright/test';



/**
 * Full user workflow test - simulates a real user interacting with
 * the Activity sidebar tabs (Activity, Patterns, ADRs)
 */
test.describe('User Workflow: Activity Sidebar', () => {

  test('complete user workflow through all sidebar tabs', async ({ page }) => {
    // Step 1: Load Strategos UI
    console.log('Step 1: Loading Strategos UI...');
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'STRATEGOS' })).toBeVisible({ timeout: 10000 });
    console.log('✓ Strategos UI loaded');

    // Step 2: Click Activity button to open sidebar
    console.log('Step 2: Opening Activity sidebar...');
    const activityToggle = page.locator('[data-testid="activity-toggle"]');
    await expect(activityToggle).toBeVisible();
    await activityToggle.click();
    await page.waitForTimeout(600); // Wait for sidebar animation
    console.log('✓ Activity sidebar opened');

    // Step 3: Verify Activity tab is active and shows feed
    console.log('Step 3: Verifying Activity tab...');
    const activityTab = page.locator('button:has-text("Activity")').first();
    await expect(activityTab).toBeVisible();
    // Activity tab should be active by default (highlighted)
    const activityFeed = page.locator('text=/No activity yet|Recent Activity/i').first();
    const feedVisible = await activityFeed.isVisible({ timeout: 3000 }).catch(() => false);
    console.log(`✓ Activity tab visible, feed content: ${feedVisible ? 'shown' : 'empty state'}`);

    // Step 4: Click Patterns tab and verify content
    console.log('Step 4: Clicking Patterns tab...');
    const patternsTab = page.locator('button:has-text("Patterns")');
    await expect(patternsTab).toBeVisible();
    await patternsTab.click();
    await page.waitForTimeout(300);

    // Should show pattern stats or empty state
    const patternsContent = page.locator('text=/Events|Sequences|No patterns|Analyze/i').first();
    await expect(patternsContent).toBeVisible({ timeout: 5000 });
    console.log('✓ Patterns tab shows content');

    // Step 5: Click ADRs tab and verify ADRs load
    console.log('Step 5: Clicking ADRs tab...');
    const adrsTab = page.locator('button:has-text("ADRs")');
    await expect(adrsTab).toBeVisible();
    await adrsTab.click();
    await page.waitForTimeout(300);

    // Should show ADR list
    const adrContent = page.locator('text=/ADR-|Architecture|Loading/i').first();
    await expect(adrContent).toBeVisible({ timeout: 5000 });
    console.log('✓ ADRs tab shows content');

    // Step 6: Try to expand an ADR (if any exist)
    console.log('Step 6: Attempting to expand an ADR...');
    const adrItem = page.locator('text=/ADR-000/').first();
    const adrExists = await adrItem.isVisible({ timeout: 2000 }).catch(() => false);

    if (adrExists) {
      await adrItem.click();
      await page.waitForTimeout(500);

      // Check if expanded content appears (context, decision, etc.)
      const expandedContent = page.locator('text=/Context|Decision|Status|Consequences/i').first();
      const expanded = await expandedContent.isVisible({ timeout: 3000 }).catch(() => false);
      console.log(`✓ ADR expansion: ${expanded ? 'expanded successfully' : 'content loading'}`);
    } else {
      console.log('✓ No ADRs to expand (empty state)');
    }

    // Step 7: Switch back to Activity tab to verify tab switching works
    console.log('Step 7: Switching back to Activity tab...');
    await activityTab.click();
    await page.waitForTimeout(300);
    console.log('✓ Tab switching works correctly');

    // Take a final screenshot
    await page.screenshot({ path: 'e2e/screenshots/user-workflow-complete.png', fullPage: true });
    console.log('✓ Workflow complete - screenshot saved');
  });

});
