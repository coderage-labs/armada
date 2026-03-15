import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, authed } from '../../test/setup-integration.js';

describe('Auth', () => {
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

  it('returns 401 without token', async () => {
    const res = await fetch(`${baseUrl}/api/templates`);
    expect(res.status).toBe(401);
  });

  it('returns 401 with wrong token', async () => {
    const res = await fetch(`${baseUrl}/api/templates`, {
      headers: { Authorization: 'Bearer wrong-token' },
    });
    expect(res.status).toBe(401);
  });

  it('allows request with valid token', async () => {
    const res = await fetch(`${baseUrl}/api/templates`, {
      headers: authed(token),
    });
    expect(res.status).toBe(200);
  });

  it('accepts hooks token', async () => {
    const res = await fetch(`${baseUrl}/api/templates`, {
      headers: { Authorization: 'Bearer test-hooks-token', 'Content-Type': 'application/json' },
    });
    expect(res.status).toBe(200);
  });

  it('allows health without auth', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
  });
});
