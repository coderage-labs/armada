import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, authed } from '../../test/setup-integration.js';

describe('Plugin Library API', () => {
  let baseUrl: string;
  let token: string;
  let close: () => void;

  beforeAll(async () => {
    const s = await startTestServer();
    baseUrl = s.baseUrl;
    token = s.ctx.token;
    close = s.close;
  });

  afterAll(async () => {
    // Discard any staged working-copy changes left by tests (staged plugin creates/deletes)
    try {
      await fetch(`${baseUrl}/api/draft/discard`, {
        method: 'POST',
        headers: authed(token),
      });
    } catch {
      // ignore
    }
    close();
  });

  it('GET /api/plugins/library lists seeded plugins', async () => {
    const res = await fetch(`${baseUrl}/api/plugins/library`, { headers: authed(token) });
    expect(res.status).toBe(200);
    const plugins = await res.json();
    expect(Array.isArray(plugins)).toBe(true);
    expect(plugins.length).toBeGreaterThan(0);
  });

  it('POST /api/plugins/library stages a plugin creation', async () => {
    const res = await fetch(`${baseUrl}/api/plugins/library`, {
      method: 'POST',
      headers: authed(token),
      body: JSON.stringify({ name: 'test-plugin', source: 'github', url: 'https://github.com/test/plugin' }),
    });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.staged).toBe(true);
  });

  it('GET /api/plugins/library/:id returns a seeded plugin', async () => {
    // Use a seeded plugin (staged plugins don't appear in library until changeset applies)
    const listRes = await fetch(`${baseUrl}/api/plugins/library`, { headers: authed(token) });
    const plugins = await listRes.json();
    const seeded = plugins[0];

    const res = await fetch(`${baseUrl}/api/plugins/library/${seeded.id}`, {
      headers: authed(token),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).name).toBe(seeded.name);
  });

  it('DELETE non-system plugin stages deletion', async () => {
    // Get a non-system seeded plugin to delete
    const listRes = await fetch(`${baseUrl}/api/plugins/library`, { headers: authed(token) });
    const plugins = await listRes.json();
    const nonSystem = plugins.find((p: any) => !p.system);
    if (!nonSystem) return; // skip if all are system

    const res = await fetch(`${baseUrl}/api/plugins/library/${nonSystem.id}`, {
      method: 'DELETE',
      headers: authed(token),
    });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.staged).toBe(true);
  });
});
