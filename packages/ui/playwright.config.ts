import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30000,
  expect: { timeout: 5000 },
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: process.env.ARMADA_URL || 'https://armada.example.com',
    headless: true,
    storageState: 'e2e/.auth/state.json',
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || '/usr/bin/chromium',
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    },
  },
  reporter: [['list'], ['html', { open: 'never' }]],
});
