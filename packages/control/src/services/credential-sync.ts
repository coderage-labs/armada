/**
 * Credential sync service — pushes credentials to agent containers
 * via the node agent.
 *
 * All agents must belong to an instance. Two types of credentials are synced:
 *   1. API keys (ANTHROPIC_API_KEY, etc.) → written to secrets.json
 *   2. Git credentials → resolved from project integrations, written to git-credentials.json
 */

import { agentsRepo, instancesRepo, projectsRepo } from '../repositories/index.js';
import { projectIntegrationsRepo } from './integrations/project-integrations-repo.js';
import { integrationsRepo } from './integrations/integrations-repo.js';
import type { NodeManager } from '../node-manager.js';

interface GitCredential {
  host: string;
  protocol: string;
  username: string;
  password: string;
  paths: string[];
}

/**
 * Resolve git credentials from all project integrations that an agent
 * has access to (via project assignments).
 */
function resolveGitCredentials(agentName: string): GitCredential[] {
  const credentials: GitCredential[] = [];
  const seenTokens = new Set<string>();

  // Get all projects — agents may work on any project via workflows
  const projects = projectsRepo.getAll();

  for (const project of projects) {
    const projectIntegrations = projectIntegrationsRepo.getByProject(project.id);

    for (const pi of projectIntegrations) {
      if (!pi.enabled) continue;
      const integration = integrationsRepo.getById(pi.integrationId);
      if (!integration) continue;
      if (integration.status !== 'active') continue;

      const token = integration.authConfig?.token as string | undefined;
      if (!token || seenTokens.has(token)) continue;
      seenTokens.add(token);

      // Determine host and paths based on provider
      let host = 'github.com';
      const paths: string[] = [];

      if (integration.provider === 'github') {
        host = (integration.authConfig?.url as string)?.replace('https://api.', '').replace('https://', '') || 'github.com';
        // Scope to repos configured on the project
        const config = JSON.parse(project.configJson || '{}');
        const repos: Array<{ url: string }> = config.repositories || [];
        for (const repo of repos) {
          const match = repo.url.match(/(?:github\.com\/)?([^/]+\/[^/]+?)(?:\.git)?$/);
          if (match) {
            const slug = match[1].replace(/^\//, '');
            // Add org-level wildcard
            const org = slug.split('/')[0];
            if (!paths.includes(`${org}/*`) && !paths.includes('*')) {
              paths.push(`${org}/*`);
            }
          }
        }
      } else if (integration.provider === 'bitbucket') {
        host = 'bitbucket.org';
      }

      // If no specific paths, allow all (wildcard)
      if (paths.length === 0) {
        paths.push('*');
      }

      credentials.push({
        host,
        protocol: 'https',
        username: 'x-access-token',
        password: token,
        paths,
      });
    }
  }

  return credentials;
}

/**
 * Trigger credential sync for a single agent by:
 * 1. Resolving git credentials from project integrations
 * 2. Writing git-credentials.json to the instance's credential mount
 * 3. Writing API keys to secrets.json
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

  // 1. Resolve git credentials from integrations
  const gitCredentials = resolveGitCredentials(agentName);
  const credentialsPayload = JSON.stringify({ credentials: gitCredentials }, null, 2);

  // Write credentials to the instance's credential directory on the node.
  // Node DATA_DIR is /data. Path: /data/armada/instance-{name}/credentials/
  // Bind-mounted as /etc/armada/ (read-only) inside the container.

  // JSON format (for tooling/debugging)
  await node.writeInstanceFile(
    instance.name,
    `armada/instance-${instance.name}/credentials/git-credentials.json`,
    credentialsPayload,
  );

  // Plain-text format for git credential store helper
  // Format: https://username:password@host (one per line)
  const plainCreds = gitCredentials
    .map(c => `${c.protocol}://${c.username}:${c.password}@${c.host}`)
    .join('\n');
  await node.writeInstanceFile(
    instance.name,
    `armada/instance-${instance.name}/credentials/git-credentials`,
    plainCreds + '\n',
  );

  // Write .gitconfig to the persistent openclaw directory.
  // /home/node/.openclaw maps to /data/armada/instances/{name} on the node.
  // Git picks it up via GIT_CONFIG_GLOBAL or include directives.
  const gitConfigContent = [
    '[credential]',
    '\thelper = store --file=/etc/armada/git-credentials',
    '[user]',
    '\temail = armada@coderage.co.uk',
    '\tname = Armada Agent',
    '',
  ].join('\n');
  await node.writeInstanceFile(
    instance.name,
    `armada/instances/${instance.name}/.gitconfig`,
    gitConfigContent,
  );

  console.log(`[credential-sync] Synced ${gitCredentials.length} git credential(s) for agent ${agentName}`);

  // 2. Sync API keys to secrets.json
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
}

/**
 * Sync credentials for all running agents.
 * Called after integration changes.
 */
export async function syncAllAgentCredentials(nodeManager: NodeManager): Promise<void> {
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
