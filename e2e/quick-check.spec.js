import { test } from '@playwright/test';


test('screenshot current state', async ({ page }) => {
  page.on('console', msg => console.log('PAGE:', msg.text()));

  await page.goto('/');
  await page.waitForTimeout(2000);

  // Click Workers tab
  await page.click('text=Workers');
  await page.waitForTimeout(1000);

  // Screenshot the grid view
  await page.screenshot({ path: 'e2e/screenshots/strategos-grid.png', fullPage: true });

  // Try to click OPEN on first worker
  const openBtn = page.locator('[data-testid^="open-worker-"]').first();
  if (await openBtn.isVisible()) {
    await openBtn.click();
    await page.waitForTimeout(3000);

    // Check what output was received via WebSocket
    const apiKey = process.env.STRATEGOS_API_KEY || '';
    const debugInfo = await page.evaluate(async (key) => {
      // Check the API directly
      const headers = {};
      if (key) headers['Authorization'] = `Bearer ${key}`;
      const resp = await fetch('http://localhost:38007/api/workers', { headers });
      const workers = await resp.json();
      const workerId = workers[0]?.id;

      if (!workerId) return { error: 'no workers' };

      const outputResp = await fetch(`http://localhost:38007/api/workers/${workerId}/output`, { headers });
      const outputData = await outputResp.json();

      const rows = document.querySelector('.xterm-rows');
      const rowTexts = rows ? Array.from(rows.children).map(r => r.textContent) : [];

      return {
        workerId,
        outputLength: outputData.output?.length || 0,
        outputSample: outputData.output?.substring(0, 200) || 'none',
        totalRows: rows?.children.length || 0,
        nonEmptyRows: rowTexts.filter(t => t.trim()).length,
      };
    }, apiKey);
    console.log('Debug info:', JSON.stringify(debugInfo, null, 2));

    // Screenshot focused mode
    await page.screenshot({ path: 'e2e/screenshots/strategos-focused.png', fullPage: true });

    // Screenshot just the terminal
    const xterm = page.locator('.xterm').first();
    if (await xterm.isVisible()) {
      await xterm.screenshot({ path: 'e2e/screenshots/strategos-terminal.png' });
    }
  }
});
