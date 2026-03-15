/**
 * Credential sync service — pushes credentials to agent containers
 * via the node agent.
 *
 * All agents must belong to an instance. Two types of credentials are synced:
 *   1. API keys (ANTHROPIC_API_KEY, etc.) → written to secrets.json in the
 *      instance's credential mount (/etc/fleet/secrets.json inside container)
 *   2. Git credentials → synced via the instance-based per-agent endpoint
 */

import { agentsRepo, nodesRepo, instancesRepo } from '../repositories/index.js';
import type { NodeManager } from '../node-manager.js';

/**
 * Trigger credential sync for a single agent by calling the node agent's
 * instance-based credential sync endpoint (git credentials) and writing
 * secrets.json (API keys).
 */
export async function syncAgentCredentials(agentName: string, nodeManager: NodeManager): Promise<void> {
  const agents = agentsRepo.getAll();
  const agent = agents.find(a => a.name === agentName);
  if (!agent || !agent.nodeId) return;

  if (!agent.instanceId) {
    throw new Error(`[credential-sync] Agent ${agentName} has no instanceId — all agents must belong to an instance`);
  }

  const instance = instancesRepo.getById(agent.instanceId);
  if (!instance) {
    throw new Error(`[credential-sync] Agent ${agentName} has instanceId ${agent.instanceId} but instance not found`);
  }

  const node = nodeManager.getNode(agent.nodeId) ?? nodeManager.getDefaultNode();

  // 1. Sync API keys to secrets.json
  const secrets: Record<string, string> = {};
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (anthropicKey) {
    secrets.ANTHROPIC_API_KEY = anthropicKey;
  }
  if (Object.keys(secrets).length > 0) {
    await node.writeInstanceFile(
      instance.name,
      'credentials/secrets.json',
      JSON.stringify(secrets, null, 2),
    );
  }

  // 2. Sync git credentials via per-agent endpoint
  await node.syncCredentials(instance.name, agentName);
}

/**
 * Sync credentials for all running agents.
 * Useful after integration changes.
 * @reserved - Not yet wired up; keep for future use when integration change triggers are added.
 */
async function syncAllAgentCredentials(nodeManager: NodeManager): Promise<void> {
  const agents = agentsRepo.getAll().filter(a => a.status === 'running');
  const results = await Promise.allSettled(
    agents.map(a => syncAgentCredentials(a.name, nodeManager)),
  );

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === 'rejected') {
      console.warn(`[credential-sync] Failed for ${agents[i].name}:`, result.reason);
    }
  }
}

// TODO: Wire syncAllAgentCredentials into these trigger points:
// - Integration created/updated/deleted (packages/api/src/routes/integrations.ts)
// - Project integration attached/detached (packages/api/src/routes/integrations.ts)
// - Agent spawned (packages/api/src/routes/agents.ts — after contact sync)
