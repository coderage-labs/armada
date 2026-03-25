/**
 * AgentManager — centralised owner of agent CRUD, redeploy, heartbeat,
 * nudge, and avatar operations.
 *
 * Extracted from routes/agents.ts so route handlers are thin wrappers.
 */

import { agentsRepo, templatesRepo, instancesRepo, deletedAgentRepo } from '../repositories/index.js';
import { resolveTemplateModel } from './model-resolver.js';
import { eventBus } from '../infrastructure/event-bus.js';
import { mutationService } from './mutation-service.js';
import { instanceManager } from './instance-manager.js';
import { logActivity } from './activity-service.js';
import { dispatchWebhook } from './webhook-dispatcher.js';
import { getAgentLifecycle } from './config-file-lifecycle.js';
import { sendMessage as messageSend, nudgeAgent } from './agent-message-service.js';
import { startAvatarGeneration, removeAvatar } from './agent-avatar-service.js';
import { deleteAvatar as deleteAvatarFile } from './avatar-generator.js';
import { resolveVariables } from '../templates/resolver.js';
import type { Agent, HeartbeatMeta } from '@coderage-labs/armada-shared';
import type { NodeManager } from '../node-manager.js';
import type { SendMessageResult } from './agent-message-service.js';

// Re-export for consumers that import from agent-manager
export type { SendMessageResult } from './agent-message-service.js';

export interface AgentManager {
  // CRUD
  getByName(name: string): Agent | undefined;
  getAll(): Agent[];
  getByInstance(instanceId: string): Agent[];
  update(id: string, patch: Partial<Agent>): Agent | undefined;
  destroy(agentName: string): Promise<import('../repositories/index.js').PendingMutation>;

  // Runtime
  redeploy(agentName: string): Promise<{ status: string; agent: string }>;
  redeployAll(): Promise<{ redeployed: string[]; errors: string[] }>;
  heartbeat(agentName: string, meta: Partial<HeartbeatMeta>): void;
  nudge(agentName: string, message?: string, timeoutMs?: number, callerName?: string): Promise<any>;
  sendMessage(agentName: string, message: string, opts?: { timeoutMs?: number; callerName?: string; callerRole?: string }): Promise<SendMessageResult>;

  // Avatars
  generateAvatar(agentName: string): { status: string };
  deleteAvatar(agentName: string): Promise<{ status: string }>;

  // Needs NodeManager injected once at startup
  setNodeManager(nm: NodeManager): void;
}

// ── Implementation ──────────────────────────────────────────────────

class AgentManagerImpl implements AgentManager {
  private nodeManager!: NodeManager;

  setNodeManager(nm: NodeManager): void {
    this.nodeManager = nm;
  }

  // ── CRUD ────────────────────────────────────────────────────────

  getByName(name: string): Agent | undefined {
    return agentsRepo.getAll().find((a) => a.name === name);
  }

  getAll(): Agent[] {
    return agentsRepo.getAll();
  }

  getByInstance(instanceId: string): Agent[] {
    return agentsRepo.getAll().filter((a) => a.instanceId === instanceId);
  }

  update(id: string, patch: Partial<Agent>): Agent | undefined {
    return agentsRepo.update(id, patch);
  }

  // ── destroy ─────────────────────────────────────────────────────

  async destroy(agentName: string): Promise<import('../repositories/index.js').PendingMutation> {
    const agent = this.getByName(agentName);
    if (!agent) throw Object.assign(new Error('Agent not found'), { statusCode: 404 });

    // Remove agent from instance config if it was placed in one
    if (agent.instanceId) {
      try {
        const lifecycle = getAgentLifecycle();
        await lifecycle.removeAgent(agent.instanceId, agent.name);
        logActivity({
          eventType: 'agent.placement',
          agentName: agent.name,
          detail: `Removed from instance ${agent.instanceId}`,
        });
      } catch (err: any) {
        console.warn(`[agent-manager] Failed to remove ${agent.name} from instance: ${err.message}`);
      }
    }

    // Stop + remove container if it exists (legacy per-container agents)
    if (agent.containerId) {
      try {
        const node = this.nodeManager.getNode(agent.nodeId) ?? this.nodeManager.getDefaultNode();
        await node.removeContainer(agent.containerId);
      } catch (err: any) {
        console.warn('[agent-manager] removeContainer failed:', err.message);
      }
    }

    // Stage the delete mutation — agent stays in DB until changeset is applied
    const stagedMutation = mutationService.stage('agent', 'delete', { name: agent.name, instanceId: agent.instanceId }, agent.id);

    deleteAvatarFile(agent.name, 'agent').catch(() => {});

    // Record deletion for workspace retention (#299)
    try {
      deletedAgentRepo.create({
        name: agent.name,
        nodeId: agent.nodeId,
        instanceId: agent.instanceId,
      });
    } catch (err: any) {
      console.warn(`[agent-manager] Failed to record deleted agent ${agent.name}: ${err.message}`);
    }

    logActivity({ eventType: 'agent.destroy', agentName: agent.name, detail: 'Agent destroy staged (pending changeset apply)' });
    // Note: agent.deleted is NOT emitted — mutation.staged replaces it.
    eventBus.emit('agent.removed', { agentId: agent.id, name: agent.name });
    dispatchWebhook('agent.destroyed', { name: agent.name });

    return stagedMutation;
  }

  // ── redeploy ────────────────────────────────────────────────────

  async redeploy(agentName: string): Promise<{ status: string; agent: string }> {
    const agent = this.getByName(agentName);
    if (!agent) throw Object.assign(new Error('Agent not found'), { statusCode: 404 });

    if (!agent.instanceId) {
      throw Object.assign(new Error('Agent has no instance — cannot redeploy'), { statusCode: 400 });
    }

    const template = templatesRepo.getById(agent.templateId);
    if (!template) throw Object.assign(new Error('Template not found'), { statusCode: 404 });

    dispatchWebhook('deploy.started', { name: agent.name, templateId: agent.templateId });

    const lifecycle = getAgentLifecycle() as any;

    const vars: Record<string, string> = {
      agent_name: agent.name,
      role: template.role,
      skills: template.skills,
    };

    // Build the agent config entry from template
    // workspace should be the container-side absolute path (relative to /home/node/.openclaw)
    const agentConfig: Record<string, any> = {
      id: agent.name,
      name: agent.name,
      workspace: 'workspace', // This resolves to /home/node/.openclaw/workspace inside the container
      model: resolveTemplateModel(template),
      tools: undefined as any,
      identity: { name: agent.name },
    };
    if (template.toolsAllow?.length) {
      agentConfig.tools = { allow: template.toolsAllow };
    }

    // Update workspace files (SOUL.md, AGENTS.md, gitconfig) — these don't need restart
    await lifecycle.updateAgent(agent.instanceId, agentConfig);

    // Write files to absolute paths within the container workspace
    // These paths should resolve to /home/node/.openclaw/workspace inside the container
    if (template.soul) {
      await lifecycle.writeInstanceFile(agent.instanceId, `/home/node/.openclaw/workspace/SOUL.md`, resolveVariables(template.soul, vars));
    }
    if (template.agents) {
      await lifecycle.writeInstanceFile(agent.instanceId, `/home/node/.openclaw/workspace/AGENTS.md`, resolveVariables(template.agents, vars));
    }

    // Stage the update mutation — DB record stays as-is until changeset is applied
    mutationService.stage('agent', 'update', {
      model: resolveTemplateModel(template),
      role: template.role,
      soul: template.soul,
      agentsMd: template.agents,
    }, agent.id);

    logActivity({ eventType: 'agent.redeploy', agentName: agent.name, detail: 'Agent update staged (pending changeset apply)' });
    // Note: agent.updated is NOT emitted — mutation.staged replaces it.
    dispatchWebhook('agent.redeploy', { name: agent.name });
    dispatchWebhook('deploy.completed', { name: agent.name, templateId: agent.templateId });

    return { status: 'redeployed', agent: agent.name };
  }

  async redeployAll(): Promise<{ redeployed: string[]; errors: string[] }> {
    const agents = this.getAll();
    const redeployed: string[] = [];
    const errors: string[] = [];

    for (const agent of agents) {
      try {
        await this.redeploy(agent.name);
        redeployed.push(agent.name);
      } catch (err: any) {
        errors.push(`${agent.name}: ${err.message}`);
      }
    }

    return { redeployed, errors };
  }

  // ── heartbeat ───────────────────────────────────────────────────

  heartbeat(agentName: string, meta: Partial<HeartbeatMeta>): void {
    const agent = this.getByName(agentName);
    if (!agent) throw Object.assign(new Error('Agent not found'), { statusCode: 404 });

    const cleanMeta: HeartbeatMeta = {};
    if (meta.taskCount !== undefined) cleanMeta.taskCount = meta.taskCount;
    if (meta.memoryMb !== undefined) cleanMeta.memoryMb = meta.memoryMb;
    if (meta.uptimeMs !== undefined) cleanMeta.uptimeMs = meta.uptimeMs;

    const previousStatus = agent.status;
    agentsRepo.update(agent.id, {
      status: 'running',
      lastHeartbeat: new Date().toISOString(),
      healthStatus: 'healthy',
      heartbeatMeta: Object.keys(cleanMeta).length > 0 ? cleanMeta : agent.heartbeatMeta,
    });

    eventBus.emit('agent.heartbeat', { name: agentName, ...cleanMeta });
    if (previousStatus !== 'running') {
      eventBus.emit('agent.status', { agentId: agent.id, name: agent.name, status: 'running', previousStatus });
    }
  }

  // ── nudge ───────────────────────────────────────────────────────

  async nudge(agentName: string, message?: string, timeoutMs?: number, callerName?: string): Promise<any> {
    return nudgeAgent(agentName, message, timeoutMs, callerName);
  }

  // ── sendMessage ─────────────────────────────────────────────────

  async sendMessage(agentName: string, message: string, opts?: { timeoutMs?: number; callerName?: string; callerRole?: string }): Promise<SendMessageResult> {
    return messageSend(agentName, message, opts);
  }

  // ── avatars ─────────────────────────────────────────────────────

  generateAvatar(agentName: string): { status: string } {
    return startAvatarGeneration(agentName);
  }

  async deleteAvatar(agentName: string): Promise<{ status: string }> {
    return removeAvatar(agentName);
  }
}

// ── Singleton export ────────────────────────────────────────────────

export const agentManager = new AgentManagerImpl();
