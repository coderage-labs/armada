import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from '../../test/setup-integration.js';

describe('Install Script', () => {
  let baseUrl: string;
  let close: () => void;

  beforeAll(async () => {
    const s = await startTestServer();
    baseUrl = s.baseUrl;
    close = s.close;
  });

  afterAll(() => close());

  it('returns 200 with text/plain content', async () => {
    const res = await fetch(`${baseUrl}/install`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
  });

  it('contains the install script shebang', async () => {
    const res = await fetch(`${baseUrl}/install`);
    const script = await res.text();
    expect(script).toContain('#!/bin/bash');
  });

  it('derives the control URL from the request', async () => {
    const res = await fetch(`${baseUrl}/install`);
    const script = await res.text();
    
    // The script should contain a WebSocket URL, not the placeholder
    expect(script).not.toContain('__CONTROL_URL__');
    expect(script).toMatch(/ws:\/\/.*\/api\/nodes\/ws/);
  });

  it('uses wss:// protocol when X-Forwarded-Proto is https', async () => {
    const res = await fetch(`${baseUrl}/install`, {
      headers: {
        'X-Forwarded-Proto': 'https',
        'X-Forwarded-Host': 'fleet.coderage.co.uk',
      },
    });
    const script = await res.text();
    
    expect(script).toContain('wss://fleet.coderage.co.uk/api/nodes/ws');
  });

  it('allows no-auth access', async () => {
    // Public endpoint should not require authentication
    const res = await fetch(`${baseUrl}/install`);
    expect(res.status).toBe(200);
  });
});
