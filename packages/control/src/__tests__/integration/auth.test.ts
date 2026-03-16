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

  it('allows scoped token with tasks:write', async () => {
    // Create a scoped token with tasks:write scope
    const { createHash, randomUUID } = await import('node:crypto');
    const { authTokenRepo } = await import('../../repositories/auth-token-repo.js');

    const scopedToken = 'test-scoped-token-' + Date.now();
    const tokenHash = createHash('sha256').update(scopedToken).digest('hex');
    
    // Create token with tasks:write scope (stored as JSON string in DB)
    authTokenRepo.create({
      id: randomUUID(),
      tokenHash,
      userId: null, // instance token, not user token
      agentName: 'test-instance',
      label: 'test-instance-token',
      scopes: ['tasks:write'], // This will be JSON.stringify'd
    });

    // Should succeed with tasks:write scope
    const res = await fetch(`${baseUrl}/api/tasks/test-task-123/result`, {
      method: 'POST',
      headers: { 
        Authorization: `Bearer ${scopedToken}`, 
        'Content-Type': 'application/json' 
      },
      body: JSON.stringify({ result: 'test result' }),
    });

    // Should NOT be 403 (insufficient permissions)
    expect(res.status).not.toBe(403);
  });

  it('rejects scoped token without required scope', async () => {
    // Create a scoped token without tasks:write
    const { createHash, randomUUID } = await import('node:crypto');
    const { authTokenRepo } = await import('../../repositories/auth-token-repo.js');

    const scopedToken = 'test-scoped-token-read-' + Date.now();
    const tokenHash = createHash('sha256').update(scopedToken).digest('hex');
    
    authTokenRepo.create({
      id: randomUUID(),
      tokenHash,
      userId: null,
      agentName: 'test-instance-read',
      label: 'test-instance-read-token',
      scopes: ['tasks:read'], // Only read, not write
    });

    // Should fail with tasks:write scope required
    const res = await fetch(`${baseUrl}/api/tasks/test-task-456/result`, {
      method: 'POST',
      headers: { 
        Authorization: `Bearer ${scopedToken}`, 
        'Content-Type': 'application/json' 
      },
      body: JSON.stringify({ result: 'test result' }),
    });

    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe('Insufficient permissions');
    expect(json.missing).toContain('tasks:write');
  });
});
