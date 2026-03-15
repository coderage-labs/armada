import { docker } from './client.js';

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
