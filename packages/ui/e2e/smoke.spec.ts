import { test, expect } from '@playwright/test';

/**
 * Armada UI Smoke Tests — verifies every page loads and renders its header.
 * Uses domcontentloaded (not networkidle) because SSE connections stay open.
 * Targets h1.text-2xl which is the PageHeader's h1 (not the sidebar's hidden h1).
 */

const PAGES: Array<{ path: string; heading: RegExp; label: string }> = [
  { path: '/', heading: /dashboard/i, label: 'Dashboard' },
  { path: '/instances', heading: /instance/i, label: 'Instances' },
  { path: '/nodes', heading: /node/i, label: 'Nodes' },
  { path: '/providers', heading: /provider/i, label: 'Providers' },
  { path: '/models', heading: /model/i, label: 'Models' },
  { path: '/projects', heading: /project/i, label: 'Projects' },
  { path: '/workflows', heading: /workflow/i, label: 'Workflows' },
  { path: '/tasks', heading: /task/i, label: 'Tasks' },
  { path: '/hierarchy', heading: /hierarchy|routing/i, label: 'Hierarchy' },
  { path: '/users', heading: /user/i, label: 'Users' },
  { path: '/webhooks', heading: /webhook/i, label: 'Webhooks' },
  { path: '/changesets', heading: /changeset/i, label: 'Changesets' },
  { path: '/activity', heading: /activity/i, label: 'Activity' },
  { path: '/usage', heading: /usage/i, label: 'Usage' },
  { path: '/notifications', heading: /notification/i, label: 'Notifications' },
  { path: '/plugins', heading: /plugin/i, label: 'Plugins' },
  { path: '/settings', heading: /setting/i, label: 'Settings' },
  { path: '/logs', heading: /log/i, label: 'Logs' },
  { path: '/integrations', heading: /integration|connected/i, label: 'Integrations' },
  { path: '/operations', heading: /operation/i, label: 'Operations' },
];

test.describe('Armada UI Smoke Tests', () => {
  for (const { path, heading, label } of PAGES) {
    test(`${label} (${path})`, async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', (err) => errors.push(err.message));

      await page.goto(path, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(2500);

      // Page header should be visible with expected text
      const h1 = page.locator('h1.text-2xl').first();
      await expect(h1).toBeVisible({ timeout: 5000 });
      const text = await h1.textContent();
      expect(text).toMatch(heading);

      // No critical JS errors
      const critical = errors.filter(e =>
        e.includes('Cannot read properties of') ||
        e.includes('is not a function') ||
        e.includes('Unhandled')
      );
      expect(critical).toHaveLength(0);
    });
  }
});
