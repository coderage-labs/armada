/**
 * Step Handler Tests — Issue #459
 *
 * Tests for the step handlers in packages/control/src/infrastructure/steps/.
 * Each handler is tested in isolation with a mocked WsNodeClient (the external
 * dependency that talks to Docker / node agent over WebSocket).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock heavy infrastructure before importing handlers ──────────────────────

// health-check.ts imports these singletons at module level
vi.mock('../../event-bus.js', () => {
  const listeners: Map<string, ((e: any) => void)[]> = new Map();
  const mockEventBus = {
    emit: vi.fn((event: string, data: any) => {
      const handlers = listeners.get(event) ?? [];
      handlers.forEach(h => h({ id: 1, event, data, timestamp: Date.now() }));
    }),
    on: vi.fn((pattern: string, handler: (e: any) => void) => {
      const existing = listeners.get(pattern) ?? [];
      listeners.set(pattern, [...existing, handler]);
      return () => {
        const current = listeners.get(pattern) ?? [];
        listeners.set(pattern, current.filter(h => h !== handler));
      };
    }),
    once: vi.fn(),
    replay: vi.fn(() => []),
    getLastId: vi.fn(() => 0),
    onError: vi.fn(() => () => {}),
  };
  return { eventBus: mockEventBus };
});

vi.mock('../../../repositories/index.js', () => ({
  instancesRepo: {
    getById: vi.fn(),
    update: vi.fn(),
  },
  agentsRepo: {
    listByInstance: vi.fn(() => []),
  },
  nodesRepo: {
    getById: vi.fn(),
  },
}));

// config-generator is a DB-heavy function — mock it for push-config tests
vi.mock('../../../services/config-generator.js', () => ({
  generateInstanceConfig: vi.fn(() => ({
    models: { providers: [] },
    gateway: { controlUi: { dangerouslyAllowHostHeaderOriginFallback: true } },
  })),
}));

// ── Import handlers after mocks ──────────────────────────────────────────────

import { pushConfigHandler } from '../push-config.js';
import { createContainerHandler } from '../create-container.js';
import { healthCheckHandler } from '../health-check.js';
import { installPluginsHandler } from '../install-plugins.js';
import { restartGatewayHandler } from '../restart-gateway.js';
import { eventBus } from '../../event-bus.js';
import { instancesRepo } from '../../../repositories/index.js';
import { generateInstanceConfig } from '../../../services/config-generator.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeNodeClient(overrides: Record<string, any> = {}) {
  return {
    createInstance: vi.fn().mockResolvedValue({ containerId: 'ctr-123', instanceUrl: 'http://node:4000' }),
    readInstanceFile: vi.fn().mockResolvedValue(null),
    writeInstanceFile: vi.fn().mockResolvedValue(undefined),
    relayRequest: vi.fn().mockResolvedValue({ status: 200 }),
    signalContainer: vi.fn().mockResolvedValue(undefined),
    listPlugins: vi.fn().mockResolvedValue([]),
    installPlugin: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeCtx(nodeClient: any, params: Record<string, any> = {}) {
  return {
    operationId: 'op-1',
    stepId: 'step-1',
    params,
    emit: vi.fn(),
    services: {
      nodeClient: vi.fn().mockReturnValue(nodeClient),
      instanceRepo: instancesRepo,
      agentsRepo: { listByInstance: vi.fn(() => []) },
      nodesRepo: { getById: vi.fn() },
      eventBus: eventBus as any,
    },
  };
}

// ── push-config ──────────────────────────────────────────────────────────────

describe('push-config handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes generated config JSON to the correct path', async () => {
    const node = makeNodeClient();
    const ctx = makeCtx(node, {
      instanceId: 'inst-1',
      nodeId: 'node-1',
      containerName: 'armada-instance-alpha',
      configVersion: 3,
    });

    await pushConfigHandler.execute(ctx as any);

    expect(node.writeInstanceFile).toHaveBeenCalledOnce();
    const [instanceName, path, content] = node.writeInstanceFile.mock.calls[0];
    expect(instanceName).toBe('alpha');
    expect(path).toBe('fleet/instances/alpha/openclaw.json');
    const written = JSON.parse(content);
    // config-generator mock returns a models key
    expect(written).toHaveProperty('models');
  });

  it('preserves existing gateway auth token from existing config', async () => {
    const existingConfig = {
      models: { providers: [] },
      gateway: { auth: { token: 'existing-secret-token' } },
    };
    const node = makeNodeClient({
      readInstanceFile: vi.fn().mockResolvedValue(JSON.stringify(existingConfig)),
    });
    const ctx = makeCtx(node, {
      instanceId: 'inst-1',
      nodeId: 'node-1',
      containerName: 'armada-instance-beta',
    });

    await pushConfigHandler.execute(ctx as any);

    const [, , content] = node.writeInstanceFile.mock.calls[0];
    const written = JSON.parse(content);
    expect(written.gateway?.auth?.token).toBe('existing-secret-token');
  });

  it('proceeds without error when no existing config is found (first deploy)', async () => {
    const node = makeNodeClient({
      readInstanceFile: vi.fn().mockRejectedValue(new Error('file not found')),
    });
    const ctx = makeCtx(node, {
      instanceId: 'inst-1',
      nodeId: 'node-1',
      containerName: 'armada-instance-gamma',
    });

    await expect(pushConfigHandler.execute(ctx as any)).resolves.not.toThrow();
    expect(node.writeInstanceFile).toHaveBeenCalledOnce();
  });

  it('calls generateInstanceConfig with the correct instanceId', async () => {
    const node = makeNodeClient();
    const ctx = makeCtx(node, {
      instanceId: 'inst-xyz',
      nodeId: 'node-1',
      containerName: 'armada-instance-delta',
    });

    await pushConfigHandler.execute(ctx as any);

    expect(generateInstanceConfig).toHaveBeenCalledWith('inst-xyz');
  });
});

// ── create-container ─────────────────────────────────────────────────────────

describe('create-container handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls node.createInstance with correct image, env, volumes, and network', async () => {
    const node = makeNodeClient();
    const ctx = makeCtx(node, {
      nodeId: 'node-1',
      containerName: 'armada-instance-epsilon',
      image: 'ghcr.io/openclaw/openclaw:latest',
      env: ['NODE_ENV=production', 'PORT=3000'],
      volumes: { '/data': '/data' },
      network: 'armada-net',
      resources: { memory: '2g', cpus: '2' },
      labels: { 'fleet.managed': 'true' },
      instanceId: 'inst-1',
    });

    await createContainerHandler.execute(ctx as any);

    expect(node.createInstance).toHaveBeenCalledOnce();
    const [containerName, config] = node.createInstance.mock.calls[0];
    expect(containerName).toBe('armada-instance-epsilon');
    expect(config.image).toBe('ghcr.io/openclaw/openclaw:latest');
    expect(config.env).toEqual(['NODE_ENV=production', 'PORT=3000']);
    expect(config.volumes).toEqual({ '/data': '/data' });
    expect(config.network).toBe('armada-net');
    expect(config.resources).toEqual({ memory: '2g', cpus: '2' });
  });

  it('uses sensible defaults for env, volumes, resources, and network when omitted', async () => {
    const node = makeNodeClient();
    const ctx = makeCtx(node, {
      nodeId: 'node-1',
      containerName: 'armada-instance-zeta',
      image: 'ghcr.io/openclaw/openclaw:latest',
      instanceId: 'inst-2',
    });

    await createContainerHandler.execute(ctx as any);

    const [, config] = node.createInstance.mock.calls[0];
    expect(config.env).toEqual([]);
    expect(config.volumes).toEqual({});
    expect(config.network).toBe('armada-net');
    expect(config.resources).toEqual({ memory: '2g', cpus: '1' });
  });

  // instanceUrl tests removed — #438: url field no longer stored
});

// ── health-check ─────────────────────────────────────────────────────────────

describe('health-check handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('succeeds immediately when HTTP probe returns 200', async () => {
    const node = makeNodeClient({
      relayRequest: vi.fn().mockResolvedValue({ status: 200 }),
    });
    const ctx = makeCtx(node, {
      nodeId: 'node-1',
      instanceId: 'inst-1',
      containerName: 'armada-instance-health',
      timeoutMs: 10_000,
    });

    const promise = healthCheckHandler.execute(ctx as any);
    // Advance past the initial 3s probe delay
    await vi.advanceTimersByTimeAsync(3500);
    await promise;

    expect(node.relayRequest).toHaveBeenCalledWith(
      'armada-instance-health',
      'GET',
      '/api/health',
    );
    expect(instancesRepo.update).toHaveBeenCalledWith('inst-1', {
      status: 'running',
      statusMessage: '',
    });
  });

  it('resolves via plugin event (instance.ready) before probe fires', async () => {
    const node = makeNodeClient({
      relayRequest: vi.fn().mockResolvedValue({ status: 503 }),
    });
    const ctx = makeCtx(node, {
      nodeId: 'node-1',
      instanceId: 'inst-plugin',
      containerName: 'armada-instance-plugin',
      timeoutMs: 10_000,
    });

    const promise = healthCheckHandler.execute(ctx as any);

    // Fire the plugin event after a short delay (before the 3s probe delay)
    await vi.advanceTimersByTimeAsync(500);
    (eventBus.emit as any)('instance.ready', {
      instanceId: 'inst-plugin',
      agents: [{ healthy: true, reported: true, name: 'main' }],
      version: '1.2.3',
    });

    await promise;

    expect(instancesRepo.update).toHaveBeenCalledWith('inst-plugin', {
      status: 'running',
      statusMessage: '',
    });
  });

  it('retries probe on failure and eventually succeeds', async () => {
    let callCount = 0;
    const node = makeNodeClient({
      relayRequest: vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount < 3) throw new Error('connection refused');
        return { status: 200 };
      }),
    });
    const ctx = makeCtx(node, {
      nodeId: 'node-1',
      instanceId: 'inst-retry',
      containerName: 'armada-instance-retry',
      timeoutMs: 30_000,
    });

    const promise = healthCheckHandler.execute(ctx as any);
    // Each retry waits 2s after the initial 3s delay
    await vi.advanceTimersByTimeAsync(10_000);
    await promise;

    expect(node.relayRequest).toHaveBeenCalledTimes(3);
    expect(instancesRepo.update).toHaveBeenCalledWith('inst-retry', {
      status: 'running',
      statusMessage: '',
    });
  });

  it('throws after timeout expires with no healthy response', async () => {
    const node = makeNodeClient({
      relayRequest: vi.fn().mockRejectedValue(new Error('connection refused')),
    });
    const ctx = makeCtx(node, {
      nodeId: 'node-1',
      instanceId: 'inst-timeout',
      containerName: 'armada-instance-timeout',
      timeoutMs: 5_000,
    });

    const promise = healthCheckHandler.execute(ctx as any);
    // Attach catch before advancing timers to prevent unhandled rejection
    // while timers fire and the promise rejects
    const caught = promise.catch((e) => e);

    await vi.advanceTimersByTimeAsync(6_000);

    const err = await caught;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/failed health check/i);
  });
});

// ── install-plugins ───────────────────────────────────────────────────────────

describe('install-plugins handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls node.installPlugin with correct name, npmPkg, and version', async () => {
    const node = makeNodeClient({ listPlugins: vi.fn().mockResolvedValue([]) });
    const ctx = makeCtx(node, {
      nodeId: 'node-1',
      containerName: 'armada-instance-iota',
      plugins: [
        { name: 'my-plugin', npmPkg: '@scope/my-plugin', source: 'npm', version: '1.2.3' },
      ],
    });

    await installPluginsHandler.execute(ctx as any);

    expect(node.installPlugin).toHaveBeenCalledWith({
      name: 'my-plugin',
      npmPkg: '@scope/my-plugin',
      source: 'npm',
      url: undefined,
      version: '1.2.3',
    });
  });

  it('skips plugins that are already installed', async () => {
    const node = makeNodeClient({
      listPlugins: vi.fn().mockResolvedValue([{ name: 'already-installed' }]),
    });
    const ctx = makeCtx(node, {
      nodeId: 'node-1',
      containerName: 'armada-instance-kappa',
      plugins: [{ name: 'already-installed', source: 'npm' }],
    });

    await installPluginsHandler.execute(ctx as any);

    expect(node.installPlugin).not.toHaveBeenCalled();
  });

  it('continues installing remaining plugins when one fails (non-fatal)', async () => {
    // With withRetry defaults (3 attempts), the failing plugin will be tried 3 times
    // before giving up and continuing to the next plugin.
    const node = makeNodeClient({
      listPlugins: vi.fn().mockResolvedValue([]),
      installPlugin: vi.fn()
        .mockRejectedValueOnce(new Error('install failed'))
        .mockRejectedValueOnce(new Error('install failed'))
        .mockRejectedValueOnce(new Error('install failed'))
        .mockResolvedValueOnce(undefined),
    });
    const ctx = makeCtx(node, {
      nodeId: 'node-1',
      containerName: 'armada-instance-lambda',
      plugins: [
        { name: 'failing-plugin', source: 'npm' },
        { name: 'ok-plugin', source: 'npm' },
      ],
    });

    const promise = installPluginsHandler.execute(ctx as any);
    await vi.runAllTimersAsync();
    await expect(promise).resolves.not.toThrow();
    // 3 retry attempts for failing-plugin + 1 successful call for ok-plugin
    expect(node.installPlugin).toHaveBeenCalledTimes(4);
  });

  it('installs multiple plugins in order', async () => {
    const node = makeNodeClient({ listPlugins: vi.fn().mockResolvedValue([]) });
    const ctx = makeCtx(node, {
      nodeId: 'node-1',
      containerName: 'armada-instance-mu',
      plugins: [
        { name: 'plugin-a', source: 'npm' },
        { name: 'plugin-b', npmPkg: '@scope/plugin-b', source: 'npm', version: '2.0.0' },
      ],
    });

    await installPluginsHandler.execute(ctx as any);

    expect(node.installPlugin).toHaveBeenCalledTimes(2);
    const calls = node.installPlugin.mock.calls.map((c: any[]) => c[0].name);
    expect(calls).toEqual(['plugin-a', 'plugin-b']);
  });

  it('proceeds with full install when listPlugins is not supported', async () => {
    const node = makeNodeClient({
      listPlugins: vi.fn().mockRejectedValue(new Error('not supported')),
    });
    const ctx = makeCtx(node, {
      nodeId: 'node-1',
      containerName: 'armada-instance-nu',
      plugins: [{ name: 'any-plugin', source: 'npm' }],
    });

    await installPluginsHandler.execute(ctx as any);

    expect(node.installPlugin).toHaveBeenCalledOnce();
  });
});

// ── restart-gateway ───────────────────────────────────────────────────────────

describe('restart-gateway handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends SIGUSR1 signal to the correct container', async () => {
    const node = makeNodeClient();
    const ctx = makeCtx(node, {
      nodeId: 'node-1',
      containerName: 'armada-instance-xi',
    });

    const promise = restartGatewayHandler.execute(ctx as any);
    await vi.runAllTimersAsync();
    await promise;

    expect(node.signalContainer).toHaveBeenCalledWith('armada-instance-xi', 'SIGUSR1');
  });

  it('emits progress events before and after signalling', async () => {
    const node = makeNodeClient();
    const ctx = makeCtx(node, {
      nodeId: 'node-1',
      containerName: 'armada-instance-omicron',
    });

    const promise = restartGatewayHandler.execute(ctx as any);
    await vi.runAllTimersAsync();
    await promise;

    const emitCalls: string[] = (ctx.emit as any).mock.calls.map((c: any[]) => c[0] as string);
    expect(emitCalls.some(m => m.includes('SIGUSR1'))).toBe(true);
    expect(emitCalls.some(m => m.includes('reload signal sent') || m.includes('Gateway'))).toBe(true);
  });

  it('uses the nodeClient for the specified nodeId', async () => {
    const node = makeNodeClient();
    const ctx = makeCtx(node, {
      nodeId: 'specific-node-42',
      containerName: 'armada-instance-pi',
    });

    const promise = restartGatewayHandler.execute(ctx as any);
    await vi.runAllTimersAsync();
    await promise;

    expect(ctx.services.nodeClient).toHaveBeenCalledWith('specific-node-42');
  });
});
