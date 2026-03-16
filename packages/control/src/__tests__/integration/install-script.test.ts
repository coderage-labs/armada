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

  describe('GET /install (no token)', () => {
    it('returns 400 with helpful error message', async () => {
      const res = await fetch(`${baseUrl}/install`);
      expect(res.status).toBe(400);
      expect(res.headers.get('content-type')).toContain('text/plain');
      
      const text = await res.text();
      expect(text).toContain('Missing install token');
      expect(text).toContain('Armada dashboard');
    });

    it('does not return a bash script', async () => {
      const res = await fetch(`${baseUrl}/install`);
      const text = await res.text();
      expect(text).not.toContain('#!/bin/bash');
    });
  });

  describe('GET /install/:token', () => {
    it('returns 200 with text/plain content', async () => {
      const res = await fetch(`${baseUrl}/install/test-token-123`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/plain');
    });

    it('contains the node installer shebang', async () => {
      const res = await fetch(`${baseUrl}/install/test-token-123`);
      const script = await res.text();
      expect(script).toContain('#!/bin/bash');
    });

    it('contains node installer content', async () => {
      const res = await fetch(`${baseUrl}/install/test-token-123`);
      const script = await res.text();
      
      // Verify it's the node installer, not the old multi-mode script
      expect(script).toContain('Armada Node Installer');
      expect(script).toContain('armada-node');
    });

    it('bakes the token into the script', async () => {
      const res = await fetch(`${baseUrl}/install/my-secret-token`);
      const script = await res.text();
      
      // Token should be baked in, not a placeholder
      expect(script).toContain('ARMADA_NODE_TOKEN="my-secret-token"');
      expect(script).not.toContain('__NODE_TOKEN__');
    });

    it('does not have --token CLI flag', async () => {
      const res = await fetch(`${baseUrl}/install/test-token-123`);
      const script = await res.text();
      
      // Old --token flag should be gone
      expect(script).not.toContain('--token');
    });

    it('does not contain old mode flags', async () => {
      const res = await fetch(`${baseUrl}/install/test-token-123`);
      const script = await res.text();
      
      // Old flags should be gone
      expect(script).not.toContain('--node-only');
      expect(script).not.toContain('--control-only');
      expect(script).not.toContain('--full');
      expect(script).not.toContain('docker compose');
    });

    it('derives the control URL from the request', async () => {
      const res = await fetch(`${baseUrl}/install/test-token-123`);
      const script = await res.text();
      
      // The script should contain a WebSocket URL, not the placeholder
      expect(script).not.toContain('__CONTROL_URL__');
      expect(script).toMatch(/CONTROL_URL="ws:\/\/.*\/api\/nodes\/ws"/);
    });

    it('uses wss:// protocol when X-Forwarded-Proto is https', async () => {
      const res = await fetch(`${baseUrl}/install/test-token-123`, {
        headers: {
          'X-Forwarded-Proto': 'https',
          'X-Forwarded-Host': 'fleet.coderage.co.uk',
        },
      });
      const script = await res.text();
      
      expect(script).toContain('CONTROL_URL="wss://fleet.coderage.co.uk/api/nodes/ws"');
    });

    it('allows no-auth access', async () => {
      // Public endpoint should not require authentication
      const res = await fetch(`${baseUrl}/install/test-token-123`);
      expect(res.status).toBe(200);
    });

    it('handles whitespace-only token path gracefully', async () => {
      // Note: Express normalizes `/install/   ` to `/install/`, so it hits the no-token route
      const res = await fetch(`${baseUrl}/install/   `);
      expect(res.status).toBe(400);
      
      const text = await res.text();
      expect(text).toContain('Missing install token');
    });
  });
});
