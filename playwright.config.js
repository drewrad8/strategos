import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: 'html',
  timeout: 60000,

  // Global setup/teardown for worker cleanup
  globalSetup: './e2e/global-setup.js',
  globalTeardown: './e2e/global-teardown.js',

  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:38007',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'iPad Pro',
      use: {
        ...devices['iPad Pro 11 landscape'],
        // Use Chromium instead of WebKit for iPad tests
        browserName: 'chromium',
      },
    },
    {
      name: 'Desktop Chrome',
      use: {
        ...devices['Desktop Chrome'],
      },
    },
  ],

  // webServer disabled - run 'npm run dev' manually before tests
  // Server: http://localhost:38007, Client: http://localhost:38008
});
