import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, authed } from '../../test/setup-integration.js';

describe('Operations API', () => {
  let baseUrl: string;
  let token: string;
  let close: () => void;

  beforeAll(async () => {
    const s = await startTestServer();
    baseUrl = s.baseUrl;
    token = s.ctx.token;
    close = s.close;
  });

  afterAll(() => close());

  it('GET /api/operations returns empty initially', async () => {
    const res = await fetch(`${baseUrl}/api/operations`, { headers: authed(token) });
    expect(res.status).toBe(200);
    const ops = await res.json();
    expect(Array.isArray(ops)).toBe(true);
  });

  it('GET /api/operations/:id returns 404 for missing', async () => {
    const res = await fetch(`${baseUrl}/api/operations/nonexistent`, { headers: authed(token) });
    expect(res.status).toBe(404);
  });
});
