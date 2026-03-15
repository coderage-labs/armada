/**
 * ConfigFileLifecycle — manages agents by editing openclaw.json on the instance
 * via the node agent's file endpoints, then reloading with SIGUSR1.
 *
 * All node agent communication goes through NodeClient.
 */

import type { AgentConfig, AgentInfo, AgentLifecycle } from './agent-lifecycle.js';
import { instancesRepo, nodesRepo } from '../repositories/index.js';
import { type NodeClient, getNodeClient } from '../infrastructure/node-client.js';

interface OpenClawConfig {
  agents?: {
    list?: Array<Record<string, any>>;
    [key: string]: any;
  };
  [key: string]: any;
}

const CONFIG_PATH = 'openclaw.json';

export class ConfigFileLifecycle implements AgentLifecycle {
  private client: NodeClient;

  constructor(client: NodeClient) {
    this.client = client;
  }

  // ── Helpers ─────────────────────────────────────────────────────

  private async getInstanceName(instanceId: string): Promise<string> {
    const instance = instancesRepo.getById(instanceId);
    if (!instance) throw new Error(`Instance not found: ${instanceId}`);
    return instance.name;
  }

  private async readConfig(instanceName: string): Promise<OpenClawConfig> {
    try {
      const json = await this.client.readInstanceFile(instanceName, CONFIG_PATH);
      // The response is { path, content } — parse content as JSON
      const data = typeof json === 'string' ? JSON.parse(json) : json;
      const content = data.content ?? data;
      try {
        return typeof content === 'string' ? JSON.parse(content) : content;
      } catch (err: any) {
        console.warn('[config-file-lifecycle] Failed to parse JSON field:', err.message);
        return {};
      }
    } catch (err: any) {
      if (err.message?.includes('404')) return {};
      throw err;
    }
  }

  private async writeConfig(instanceName: string, config: OpenClawConfig): Promise<void> {
    await this.client.writeInstanceFile(instanceName, CONFIG_PATH, JSON.stringify(config, null, 2));
  }

  private async reload(instanceName: string): Promise<void> {
    await this.client.reloadInstance(instanceName);
  }

  private async healthCheck(instanceName: string): Promise<boolean> {
    try {
      const data = await this.client.getInstanceHealth(instanceName);
      return data?.status === 'healthy';
    } catch (err: any) {
      console.warn('[config-file-lifecycle] healthCheck failed:', err.message);
      return false;
    }
  }

  /**
   * Write a per-agent .gitconfig that points to the agent-scoped credential helper.
   * Inside the instance container, credentials are at /etc/armada/{agentName}/.
   */
  private async writeAgentGitConfig(instanceName: string, agentId: string): Promise<void> {
    const gitConfigContent = [
      '[credential]',
      `\thelper = /etc/armada/${agentId}/credential-helper`,
      '',
    ].join('\n');

    const gitconfigPath = `workspace/agents/${agentId}/.gitconfig`;

    try {
      await this.client.writeInstanceFile(instanceName, gitconfigPath, gitConfigContent);
    } catch (err: any) {
      console.warn(`[config-file-lifecycle] Failed to write gitconfig for ${agentId} in ${instanceName}: ${err.message}`);
    }
  }

  // ── AgentLifecycle implementation ───────────────────────────────
  //
  // Agent CRUD no longer writes openclaw.json or restarts the gateway.
  // Config is generated from the DB by config-generator.ts and pushed
  // via the operations pipeline (push_config → restart_gateway → health_check).
  //
  // These methods now only handle workspace file setup (gitconfig, SOUL.md, etc.)

  async createAgent(instanceId: string, config: AgentConfig): Promise<void> {
    const instanceName = await this.getInstanceName(instanceId);

    // Set up per-agent gitconfig for credential scoping
    await this.writeAgentGitConfig(instanceName, config.id);

    // Note: openclaw.json is NOT written here — it's generated from DB
    // and pushed via the operations pipeline when the changeset is applied.
  }

  async updateAgent(instanceId: string, config: AgentConfig): Promise<void> {
    const instanceName = await this.getInstanceName(instanceId);

    // Re-write gitconfig in case agent name changed
    await this.writeAgentGitConfig(instanceName, config.id);

    // Note: openclaw.json update happens via operations pipeline.
  }

  // ── Interface methods for writeFile / reload (public) ─────────

  async writeInstanceFile(instanceId: string, path: string, content: string): Promise<void> {
    const instanceName = await this.getInstanceName(instanceId);
    await this.client.writeInstanceFile(instanceName, path, content);
  }

  async reloadInstance(instanceId: string): Promise<void> {
    const instanceName = await this.getInstanceName(instanceId);
    await this.reload(instanceName);
  }

  async removeAgent(instanceId: string, agentId: string): Promise<void> {
    // Note: openclaw.json update happens via operations pipeline.
    // Agent is removed from the DB by the caller; config-generator will
    // produce the correct agents.list on next push_config.
  }

  async listAgents(instanceId: string): Promise<AgentInfo[]> {
    const instanceName = await this.getInstanceName(instanceId);
    const config = await this.readConfig(instanceName);

    if (!config.agents?.list?.length) return [];

    return config.agents.list.map((a: any) => ({
      id: a.id,
      name: a.name ?? a.id,
      model: a.model,
      workspace: a.workspace ?? '',
    }));
  }

  async getAgent(instanceId: string, agentId: string): Promise<AgentInfo | null> {
    const instanceName = await this.getInstanceName(instanceId);
    const config = await this.readConfig(instanceName);

    if (!config.agents?.list?.length) return null;

    const agent = config.agents.list.find((a: any) => a.id === agentId);
    if (!agent) return null;

    return {
      id: agent.id,
      name: agent.name ?? agent.id,
      model: agent.model,
      workspace: agent.workspace ?? '',
    };
  }
}

// ── Factory ─────────────────────────────────────────────────────────

let _instance: ConfigFileLifecycle | null = null;

/**
 * Get the singleton AgentLifecycle implementation.
 * Uses the shared NodeClient from infrastructure/node-client.
 */
export function getAgentLifecycle(): AgentLifecycle {
  if (!_instance) {
    _instance = new ConfigFileLifecycle(getNodeClient());
  }
  return _instance;
}
