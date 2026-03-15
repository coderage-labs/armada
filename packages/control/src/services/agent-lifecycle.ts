/**
 * AgentLifecycle — abstraction for managing agents within instances.
 *
 * Current implementation: ConfigFileLifecycle (edits openclaw.json + SIGUSR1).
 * Future: api.registerAgent() when OpenClaw ships native multi-agent support.
 */

export interface AgentConfig {
  id: string;           // Internal agent ID (e.g. "forge")
  name: string;         // Display name
  model?: string;       // LLM model (e.g. "anthropic/claude-sonnet-4-20250514")
  workspace: string;    // Workspace path relative to instance root
  tools?: {
    allow?: string[];
    deny?: string[];
  };
  skills?: string[];
  identity?: {
    name?: string;
    emoji?: string;
    theme?: string;
  };
  heartbeat?: {
    every?: string;
  };
  /** Raw extra config to merge into the agent entry */
  extra?: Record<string, any>;
}

export interface AgentInfo {
  id: string;
  name: string;
  model?: string;
  workspace: string;
}

export interface AgentLifecycle {
  createAgent(instanceId: string, config: AgentConfig): Promise<void>;
  updateAgent(instanceId: string, config: AgentConfig): Promise<void>;
  removeAgent(instanceId: string, agentId: string): Promise<void>;
  listAgents(instanceId: string): Promise<AgentInfo[]>;
  getAgent(instanceId: string, agentId: string): Promise<AgentInfo | null>;
  writeInstanceFile(instanceId: string, path: string, content: string): Promise<void>;
  reloadInstance(instanceId: string): Promise<void>;
}
