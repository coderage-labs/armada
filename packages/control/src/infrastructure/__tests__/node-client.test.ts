/**
 * node-client tests (WP7) — now tests WsNodeClient via the re-exported NodeClient.
 *
 * WsNodeClient delegates everything to commandDispatcher.send(). We mock
 * commandDispatcher to verify the right actions/params are sent.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NodeClient } from '../node-client.js';

// Mock the commandDispatcher used by WsNodeClient
vi.mock('../../ws/command-dispatcher.js', () => ({
  commandDispatcher: {
    send: vi.fn(),
  },
}));

import { commandDispatcher } from '../../ws/command-dispatcher.js';

const NODE_ID = 'test-node-id';

describe('NodeClient (WsNodeClient)', () => {
  let client: InstanceType<typeof NodeClient>;
  const mockSend = commandDispatcher.send as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    client = new NodeClient(NODE_ID);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('instance lifecycle', () => {
    it('createInstance sends container.create with name and config', async () => {
      mockSend.mockResolvedValue({ id: 'inst-1' });
      const result = await client.createInstance('my-instance', { capacity: 5 });

      expect(mockSend).toHaveBeenCalledWith(
        NODE_ID,
        'container.create',
        { name: 'my-instance', capacity: 5 },
        120_000,
      );
      expect(result).toEqual({ id: 'inst-1' });
    });

    it('destroyInstance sends container.remove with force', async () => {
      mockSend.mockResolvedValue(undefined);
      await client.destroyInstance('my-instance');

      expect(mockSend).toHaveBeenCalledWith(
        NODE_ID,
        'container.remove',
        { id: 'my-instance', force: true },
        60_000,
      );
    });

    it('startInstance sends container.start', async () => {
      mockSend.mockResolvedValue(undefined);
      await client.startInstance('my-instance');

      expect(mockSend).toHaveBeenCalledWith(NODE_ID, 'container.start', { id: 'my-instance' }, undefined);
    });

    it('stopInstance sends container.stop', async () => {
      mockSend.mockResolvedValue(undefined);
      await client.stopInstance('my-instance');

      expect(mockSend).toHaveBeenCalledWith(NODE_ID, 'container.stop', { id: 'my-instance' }, undefined);
    });

    it('restartInstance sends container.restart', async () => {
      mockSend.mockResolvedValue(undefined);
      await client.restartInstance('my-instance');

      expect(mockSend).toHaveBeenCalledWith(NODE_ID, 'container.restart', { id: 'my-instance' }, undefined);
    });
  });

  describe('plugins', () => {
    it('installPlugin sends plugin.install with npmPkg as name', async () => {
      mockSend.mockResolvedValue({ installed: true });
      await client.installPlugin({ name: 'my-plugin', npmPkg: '@scope/plugin', version: '1.0.0' });

      expect(mockSend).toHaveBeenCalledWith(
        NODE_ID,
        'plugin.install',
        { name: '@scope/plugin', version: '1.0.0', directory: undefined },
        180_000,
      );
    });

    it('installPlugin falls back to name when no npmPkg', async () => {
      mockSend.mockResolvedValue({ installed: true });
      await client.installPlugin({ name: 'my-plugin', version: '2.0.0' });

      expect(mockSend).toHaveBeenCalledWith(
        NODE_ID,
        'plugin.install',
        { name: 'my-plugin', version: '2.0.0', directory: undefined },
        180_000,
      );
    });

    it('listPlugins sends plugin.list', async () => {
      mockSend.mockResolvedValue([{ name: 'foo' }]);
      const result = await client.listPlugins();

      expect(mockSend).toHaveBeenCalledWith(NODE_ID, 'plugin.list', {}, undefined);
      expect(result).toEqual([{ name: 'foo' }]);
    });
  });

  describe('node health', () => {
    it('healthCheck sends node.info', async () => {
      mockSend.mockResolvedValue({ hostname: 'test', cores: 4, memory: 8192, containers: 2 });
      const result = await client.healthCheck();

      expect(mockSend).toHaveBeenCalledWith(NODE_ID, 'node.info', {}, undefined);
      expect(result).toEqual(expect.objectContaining({ hostname: 'test' }));
    });

    it('getStats sends node.stats', async () => {
      mockSend.mockResolvedValue({ cpu: 10, memory: 50 });
      const result = await client.getStats();

      expect(mockSend).toHaveBeenCalledWith(NODE_ID, 'node.stats', {}, undefined);
      expect(result).toEqual({ cpu: 10, memory: 50 });
    });
  });

  describe('containers', () => {
    it('getContainerLogs sends container.logs and returns logs string', async () => {
      mockSend.mockResolvedValue({ logs: 'log line 1\nlog line 2' });
      const result = await client.getContainerLogs('my-container', 50);

      expect(mockSend).toHaveBeenCalledWith(
        NODE_ID,
        'container.logs',
        { id: 'my-container', tail: 50 },
        undefined,
      );
      expect(result).toBe('log line 1\nlog line 2');
    });

    it('getContainerLogs returns empty string when logs missing', async () => {
      mockSend.mockResolvedValue({});
      const result = await client.getContainerLogs('my-container');
      expect(result).toBe('');
    });

    it('signalContainer sends container.signal with signal', async () => {
      mockSend.mockResolvedValue(undefined);
      await client.signalContainer('my-container', 'SIGTERM');

      expect(mockSend).toHaveBeenCalledWith(
        NODE_ID,
        'container.signal',
        { id: 'my-container', signal: 'SIGTERM' },
        undefined,
      );
    });

    it('listContainers sends container.list', async () => {
      mockSend.mockResolvedValue([{ id: 'c1' }]);
      const result = await client.listContainers();

      expect(mockSend).toHaveBeenCalledWith(NODE_ID, 'container.list', {}, undefined);
    });
  });

  describe('instance files', () => {
    it('readInstanceFile sends file.read', async () => {
      mockSend.mockResolvedValue({ content: 'hello' });
      const result = await client.readInstanceFile('inst-1', '/etc/config.json');

      expect(mockSend).toHaveBeenCalledWith(
        NODE_ID,
        'file.read',
        { instance: 'inst-1', path: '/etc/config.json' },
        undefined,
      );
    });

    it('writeInstanceFile sends file.write', async () => {
      mockSend.mockResolvedValue(undefined);
      await client.writeInstanceFile('inst-1', '/etc/config.json', '{}');

      expect(mockSend).toHaveBeenCalledWith(
        NODE_ID,
        'file.write',
        { instance: 'inst-1', path: '/etc/config.json', content: '{}' },
        undefined,
      );
    });
  });

  describe('nodeId property', () => {
    it('exposes the nodeId', () => {
      expect(client.nodeId).toBe(NODE_ID);
    });
  });
});
