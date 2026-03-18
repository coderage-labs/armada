import { chromium } from '@playwright/test';

export default async function globalSetup() {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || '/usr/bin/chromium',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  const baseURL = process.env.ARMADA_URL || 'https://armada.example.com';

  await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
  await page.evaluate((token: string) => {
    document.cookie = 'armada_authed=true; path=/; max-age=3600';
    localStorage.setItem('armada_token', token);
  }, process.env.ARMADA_TOKEN ?? 'test-token');

  await context.storageState({ path: 'e2e/.auth/state.json' });
  await browser.close();
}
