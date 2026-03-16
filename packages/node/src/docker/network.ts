import { docker } from './client.js';
import { hostname } from 'node:os';

/**
 * Ensure a Docker network exists. Creates it if it doesn't.
 * Returns the network ID.
 */
export async function ensureNetwork(name: string): Promise<string> {
  const networks = await docker.listNetworks({
    filters: { name: [name] },
  });

  const existing = networks.find((n) => n.Name === name);
  if (existing) {
    return existing.Id;
  }

  const network = await docker.createNetwork({
    Name: name,
    Driver: 'bridge',
    Labels: { 'armada.network': 'true' },
  });

  return network.id;
}

/**
 * Detect the Docker network that this node agent is running on.
 * Returns the network name, or 'bridge' as a fallback.
 * 
 * Strategy:
 * 1. Find this container by hostname (Docker sets container hostname = container name by default)
 * 2. Inspect the container to get its networks
 * 3. Return the first non-bridge network, or 'bridge' if only on bridge
 */
export async function detectOwnNetwork(): Promise<string> {
  try {
    const currentHostname = hostname();
    
    // List all containers to find ourselves
    const containers = await docker.listContainers({ all: true });
    const selfContainer = containers.find(c => 
      c.Names.some(name => name.replace(/^\//, '') === currentHostname) ||
      c.Id.startsWith(currentHostname) ||
      c.Labels?.['armada.node'] === 'true'
    );

    if (!selfContainer) {
      console.warn('[network] Could not find own container, using bridge network');
      return 'bridge';
    }

    // Inspect the container to get network details
    const container = docker.getContainer(selfContainer.Id);
    const info = await container.inspect();
    
    // Get all networks this container is connected to
    const networks = Object.keys(info.NetworkSettings.Networks || {});
    
    if (networks.length === 0) {
      console.warn('[network] Container has no networks, using bridge');
      return 'bridge';
    }

    // Prefer non-bridge networks (armada-net, custom networks, etc.)
    const nonBridge = networks.find(n => n !== 'bridge');
    const detected = nonBridge || networks[0];
    
    console.log(`[network] Detected own network: ${detected}`);
    return detected;
  } catch (err) {
    console.warn('[network] Failed to detect own network, using bridge:', err);
    return 'bridge';
  }
}
