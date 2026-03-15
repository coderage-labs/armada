import { type Express } from 'express';
import { vi } from 'vitest';
import { setupTestDb, teardownTestDb } from './helpers.js';
import { createApp } from '../app.js';
import { NodeManager } from '../node-manager.js';

const TEST_TOKEN = 'test-api-token-12345';

// ── Mock Node Agent (WS-based) ───────────────────────────────────────
//
// WP7: HTTP mock server replaced with commandDispatcher mock.
// Tests that need node operations mock commandDispatcher.send directly.

interface MockNodeCommand {
  nodeId: string;
  action: string;
  params: object;
}

export interface MockNodeAgent {
  nodeId: string;
  commands: MockNodeCommand[];
  mockCommand(action: string, response: any): void;
  reset(): void;
  /** @deprecated HTTP server removed in WP7 — use commandDispatcher mocks */
  close(): void;
}

export function createMockNodeAgent(): MockNodeAgent {
  const commands: MockNodeCommand[] = [];
  const overrides = new Map<string, any>();

  // Default handler: track commands and return sensible defaults
  const mockSend = vi.fn(async (nodeId: string, action: string, params: object): Promise<any> => {
    commands.push({ nodeId, action, params });

    // Check for registered override
    if (overrides.has(action)) {
      const resp = overrides.get(action);
      return typeof resp === 'function' ? resp(nodeId, params) : resp;
    }

    // Built-in defaults
    switch (action) {
      case 'node.info': return { hostname: 'test-node', cores: 4, memory: 16 * 1024 * 1024 * 1024, containers: { running: 0 }, status: 'healthy' };
      case 'node.stats': return { cpu: 10, memory: 50 };
      case 'container.create': return { id: (params as any).name, status: 'created' };
      case 'container.remove': return { status: 'destroyed' };
      case 'container.start': return { status: 'started' };
      case 'container.stop': return { status: 'stopped' };
      case 'container.restart': return { status: 'restarted' };
      case 'container.inspect': return { State: { Running: true } };
      case 'container.list': return [];
      case 'container.logs': return { logs: 'test log output' };
      case 'container.signal': return { status: 'signalled' };
      case 'plugin.install': return { status: 'installed', name: (params as any).name };
      case 'plugin.list': return [];
      case 'file.read': return { content: '{}' };
      case 'file.write': return { status: 'written' };
      case 'instance.relay': return { status: 'ok' };
      case 'instance.upgrade': return { status: 'upgraded' };
      case 'instance.reload': return { status: 'reloaded' };
      case 'skills.list': return [];
      case 'skills.install': return { status: 'installed' };
      case 'tools.list': return [];
      case 'network.list': return [];
      case 'system.info': return { hostname: 'test-node', cores: 4 };
      default: return { status: 'ok', mock: true };
    }
  });

  return {
    nodeId: 'test-node-id',
    commands,
    mockCommand(action: string, response: any) {
      overrides.set(action, response);
    },
    reset() {
      commands.length = 0;
      overrides.clear();
      mockSend.mockClear();
    },
    close() {
      // No-op: no HTTP server in WP7
    },
    _mockSend: mockSend,
  } as any;
}

// ── Test Context ────────────────────────────────────────────────────

export interface TestContext {
  app: Express;
  token: string;
  mockNode: MockNodeAgent;
  nodeManager: NodeManager;
}

export async function createTestContext(): Promise<TestContext> {
  // Set auth token env BEFORE anything touches auth middleware
  process.env.ARMADA_API_TOKEN = TEST_TOKEN;
  process.env.ARMADA_HOOKS_TOKEN = 'test-hooks-token';

  setupTestDb();

  // Seed default plugins so plugin library routes work
  const { pluginManager } = await import('../services/plugin-manager.js');
  pluginManager.seed();

  // Register integration providers
  const { registerAllProviders } = await import('../services/integrations/index.js');
  registerAllProviders();

  const mockNode = createMockNodeAgent();
  const nodeManager = new NodeManager();

  // Mock commandDispatcher.send for this test context
  const { commandDispatcher } = await import('../ws/command-dispatcher.js');
  vi.spyOn(commandDispatcher, 'send').mockImplementation((mockNode as any)._mockSend);

  // Register a test node in the DB and NodeManager
  const { nodesRepo } = await import('../repositories/node-repo.js');
  const node = nodesRepo.create({
    hostname: 'test-node',
    ip: '127.0.0.1',
    port: 8080,
    url: 'ws://127.0.0.1:8080',
    token: '',
    cores: 4,
    memory: 16 * 1024 * 1024 * 1024,
    status: 'online',
    lastSeen: new Date().toISOString(),
  });
  // Override the nodeId so WsNodeClient routes to mock
  (mockNode as any).nodeId = node.id;
  nodeManager.addNode(node.id);

  const app = createApp({ nodeManager, skipBackgroundServices: true });

  return { app, token: TEST_TOKEN, mockNode, nodeManager };
}

export function destroyTestContext(ctx: TestContext) {
  ctx.mockNode.close();
  vi.restoreAllMocks();
  teardownTestDb();
}

// ── Convenience: start a full test server ───────────────────────────

export async function startTestServer(): Promise<{
  ctx: TestContext;
  baseUrl: string;
  close: () => void;
}> {
  const ctx = await createTestContext();
  const server = ctx.app.listen(0);
  const addr = server.address() as any;
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  return {
    ctx,
    baseUrl,
    close: () => {
      server.close();
      destroyTestContext(ctx);
    },
  };
}

export function authed(token: string) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

/**
 * Discard all staged working-copy changes on the test server.
 * Call in afterAll/afterEach for tests that stage entities via POST/PUT/DELETE,
 * to prevent orphaned draft state leaking between tests.
 */
export async function discardDraft(baseUrl: string, token: string): Promise<void> {
  try {
    await fetch(`${baseUrl}/api/draft/discard`, {
      method: 'POST',
      headers: authed(token),
    });
  } catch {
    // ignore — best-effort cleanup
  }
}

/**
 * Delete entities created during a test by their IDs.
 * Pass the resource path (e.g. '/api/tasks') and the array of IDs to clean up.
 */
export async function cleanupEntities(
  baseUrl: string,
  token: string,
  resourcePath: string,
  ids: string[],
): Promise<void> {
  for (const id of ids) {
    try {
      await fetch(`${baseUrl}${resourcePath}/${id}`, {
        method: 'DELETE',
        headers: authed(token),
      });
    } catch {
      // ignore — best-effort cleanup
    }
  }
}
