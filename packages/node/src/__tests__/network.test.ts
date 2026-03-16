import { describe, it, expect, vi, beforeEach } from 'vitest';
import { detectOwnNetwork, ensureNetwork } from '../docker/network.js';
import { docker } from '../docker/client.js';

// Mock the Docker client
vi.mock('../docker/client.js', () => ({
  docker: {
    listContainers: vi.fn(),
    getContainer: vi.fn(),
    listNetworks: vi.fn(),
    createNetwork: vi.fn(),
  },
}));

// Mock hostname
vi.mock('node:os', () => ({
  hostname: vi.fn(() => 'test-node-agent'),
}));

describe('Network Detection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('detectOwnNetwork', () => {
    it('returns the detected network when container is found', async () => {
      const mockContainers = [
        {
          Id: 'abc123',
          Names: ['/test-node-agent'],
          Labels: {},
        },
      ];

      const mockInspect = {
        NetworkSettings: {
          Networks: {
            'armada-prep_armada': {},
            bridge: {},
          },
        },
      };

      vi.mocked(docker.listContainers).mockResolvedValue(mockContainers as any);
      vi.mocked(docker.getContainer).mockReturnValue({
        inspect: vi.fn().mockResolvedValue(mockInspect),
      } as any);

      const network = await detectOwnNetwork();
      // Should prefer non-bridge network
      expect(network).toBe('armada-prep_armada');
    });

    it('returns bridge when only bridge network is available', async () => {
      const mockContainers = [
        {
          Id: 'abc123',
          Names: ['/test-node-agent'],
          Labels: {},
        },
      ];

      const mockInspect = {
        NetworkSettings: {
          Networks: {
            bridge: {},
          },
        },
      };

      vi.mocked(docker.listContainers).mockResolvedValue(mockContainers as any);
      vi.mocked(docker.getContainer).mockReturnValue({
        inspect: vi.fn().mockResolvedValue(mockInspect),
      } as any);

      const network = await detectOwnNetwork();
      expect(network).toBe('bridge');
    });

    it('returns bridge fallback when container is not found', async () => {
      vi.mocked(docker.listContainers).mockResolvedValue([]);

      const network = await detectOwnNetwork();
      expect(network).toBe('bridge');
    });

    it('returns bridge fallback on error', async () => {
      vi.mocked(docker.listContainers).mockRejectedValue(new Error('Docker API error'));

      const network = await detectOwnNetwork();
      expect(network).toBe('bridge');
    });

    it('finds container by armada.node label', async () => {
      const mockContainers = [
        {
          Id: 'xyz789',
          Names: ['/some-other-name'],
          Labels: { 'armada.node': 'true' },
        },
      ];

      const mockInspect = {
        NetworkSettings: {
          Networks: {
            'custom-network': {},
          },
        },
      };

      vi.mocked(docker.listContainers).mockResolvedValue(mockContainers as any);
      vi.mocked(docker.getContainer).mockReturnValue({
        inspect: vi.fn().mockResolvedValue(mockInspect),
      } as any);

      const network = await detectOwnNetwork();
      expect(network).toBe('custom-network');
    });
  });

  describe('ensureNetwork', () => {
    it('returns existing network ID when network exists', async () => {
      const mockNetworks = [
        {
          Id: 'net123',
          Name: 'armada-net',
        },
      ];

      vi.mocked(docker.listNetworks).mockResolvedValue(mockNetworks as any);

      const networkId = await ensureNetwork('armada-net');
      expect(networkId).toBe('net123');
      expect(docker.createNetwork).not.toHaveBeenCalled();
    });

    it('creates network when it does not exist', async () => {
      vi.mocked(docker.listNetworks).mockResolvedValue([]);
      vi.mocked(docker.createNetwork).mockResolvedValue({ id: 'newnet456' } as any);

      const networkId = await ensureNetwork('armada-net');
      expect(networkId).toBe('newnet456');
      expect(docker.createNetwork).toHaveBeenCalledWith({
        Name: 'armada-net',
        Driver: 'bridge',
        Labels: { 'armada.network': 'true' },
      });
    });
  });
});
