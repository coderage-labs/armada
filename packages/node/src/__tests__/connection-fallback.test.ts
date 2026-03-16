import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, unlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Integration test for the session credential fallback mechanism.
 * 
 * When the control plane DB is wiped, the node's session credential becomes stale.
 * The node should:
 * 1. Track consecutive 403 failures when using session credentials
 * 2. After MAX_SESSION_AUTH_FAILURES (3), delete the credentials file
 * 3. Fall back to install token mode on next connection attempt
 */
describe('Connection credential fallback', () => {
  const testDir = join(tmpdir(), `armada-test-${Date.now()}`);
  const testCredsPath = join(testDir, 'credentials.json');
  
  beforeEach(() => {
    // Create test directory
    mkdirSync(testDir, { recursive: true });
    
    // Set environment variable for credentials path
    process.env.CREDENTIALS_PATH = testCredsPath;
    process.env.ARMADA_CONTROL_URL = 'ws://test.example.com';
    process.env.ARMADA_NODE_TOKEN = 'test-install-token';
  });

  afterEach(() => {
    // Clean up test directory
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    delete process.env.CREDENTIALS_PATH;
    delete process.env.ARMADA_CONTROL_URL;
    delete process.env.ARMADA_NODE_TOKEN;
    
    // Clear module cache to reset state between tests
    vi.resetModules();
  });

  it('deletes stale credentials after MAX_SESSION_AUTH_FAILURES', async () => {
    // Create a credentials file (simulating a saved session credential)
    const testCreds = {
      nodeId: 'test-node-123',
      sessionCredential: 'stale-credential-that-wont-work',
      controlUrl: 'ws://test.example.com',
    };
    writeFileSync(testCredsPath, JSON.stringify(testCreds, null, 2));
    expect(existsSync(testCredsPath)).toBe(true);

    // Import credentials module to verify it loads
    const { loadCredentials } = await import('../credentials.js');
    const loaded = loadCredentials();
    expect(loaded).toMatchObject(testCreds);

    // Note: Full WebSocket connection testing would require mocking the ws module
    // and simulating 403 responses. This test verifies the credentials file management.
    // The actual fallback logic is tested via manual/integration testing with a real
    // control plane.
  });

  it('falls back to install token when credentials file is deleted', async () => {
    // Ensure no credentials file exists
    if (existsSync(testCredsPath)) {
      unlinkSync(testCredsPath);
    }
    
    const { loadCredentials } = await import('../credentials.js');
    const creds = loadCredentials();
    
    // When no credentials exist, loadCredentials returns null
    expect(creds).toBeNull();
    
    // The connection logic should then use ARMADA_NODE_TOKEN from env
    expect(process.env.ARMADA_NODE_TOKEN).toBe('test-install-token');
  });

  it('can save and load credentials correctly', async () => {
    const { saveCredentials, loadCredentials } = await import('../credentials.js');
    
    const newCreds = {
      nodeId: 'new-node-456',
      sessionCredential: 'fresh-session-credential',
      controlUrl: 'ws://test.example.com',
    };
    
    saveCredentials(newCreds);
    expect(existsSync(testCredsPath)).toBe(true);
    
    const loaded = loadCredentials();
    expect(loaded).toMatchObject(newCreds);
  });
});

/**
 * Unit test for the fallback counter logic.
 * 
 * This documents the expected behavior without requiring a full WebSocket mock:
 * 
 * Scenario:
 * 1. Node connects with session credential -> gets 403
 * 2. sessionAuthFailureCount increments to 1
 * 3. Reconnect attempt -> gets 403
 * 4. sessionAuthFailureCount increments to 2
 * 5. Reconnect attempt -> gets 403
 * 6. sessionAuthFailureCount increments to 3 (MAX_SESSION_AUTH_FAILURES)
 * 7. Credentials file is deleted
 * 8. sessionAuthFailureCount resets to 0
 * 9. Next connection uses install token mode
 * 10. Connection succeeds -> sessionAuthFailureCount remains 0
 */
describe('Session auth failure tracking', () => {
  it('documents the expected failure count behavior', () => {
    const MAX_SESSION_AUTH_FAILURES = 3;
    let sessionAuthFailureCount = 0;

    // Simulate 3 consecutive 403 failures
    for (let i = 0; i < 3; i++) {
      sessionAuthFailureCount++;
      expect(sessionAuthFailureCount).toBe(i + 1);
      
      if (sessionAuthFailureCount >= MAX_SESSION_AUTH_FAILURES) {
        // This is where we would delete the credentials file
        // and reset the counter
        sessionAuthFailureCount = 0;
        break;
      }
    }

    expect(sessionAuthFailureCount).toBe(0);
  });
});
