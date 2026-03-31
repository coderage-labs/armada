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
import { changesetService, getOrCreateDraftChangeset } from './changeset-service.js';
import { instanceManager } from './instance-manager.js';
import { logActivity } from './activity-service.js';
import { dispatchWebhook } from './webhook-dispatcher.js';
import { getAgentLifecycle } from './config-file-lifecycle.js';
import { sendMessage as messageSend, nudgeAgent } from './agent-message-service.js';
import { startAvatarGeneration, removeAvatar } from './agent-avatar-service.js';
import { deleteAvatar as deleteAvatarFile } from './avatar-generator.js';
import { resolveVariables } from '../templates/resolver.js';
import { getInstanceLoad } from './instance-capacity.js';
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
  updateOperational(id: string, patch: Pick<Partial<Agent>, 'status' | 'healthStatus' | 'lastHeartbeat' | 'heartbeatMeta' | 'avatarGenerating' | 'avatarVersion'>): Agent | undefined;
  destroy(agentName: string): Promise<import('../repositories/index.js').PendingMutation>;

  // Runtime
  redeploy(agentName: string): Promise<{ status: string; agent: string }>;
  redeployAll(): Promise<{ redeployed: string[]; errors: string[] }>;
  heartbeat(agentName: string, meta: Partial<HeartbeatMeta>): void;
  nudge(agentName: string, message?: string, timeoutMs?: number, callerName?: string): Promise<any>;
  sendMessage(agentName: string, message: string, opts?: { timeoutMs?: number; callerName?: string; callerRole?: string }): Promise<SendMessageResult>;

  // Transfer
  transfer(agentName: string, targetInstanceId: string, keepData?: boolean): Promise<{ status: string; agent: string; targetInstance: string }>;

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

  updateOperational(id: string, patch: Pick<Partial<Agent>, 'status' | 'healthStatus' | 'lastHeartbeat' | 'heartbeatMeta' | 'avatarGenerating' | 'avatarVersion'>): Agent | undefined {
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

    // Stage the update mutation with soul and agentsMd
    // The step-planner's resolveFileWrites() will write these files during changeset apply
    mutationService.stage('agent', 'update', {
      model: resolveTemplateModel(template),
      role: template.role,
      soul: template.soul ? resolveVariables(template.soul, vars) : undefined,
      agentsMd: template.agents ? resolveVariables(template.agents, vars) : undefined,
    }, agent.id);

    // Auto-create and apply changeset for immediate effect
    // Redeploy is an explicit user action that expects immediate effect
    const changeset = getOrCreateDraftChangeset('system');
    if (changeset) {
      await changesetService.apply(changeset.id, { force: true });
    }

    logActivity({ eventType: 'agent.redeploy', agentName: agent.name, detail: 'Agent redeployed via changeset' });
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

  // ── transfer ────────────────────────────────────────────────────

  async transfer(agentName: string, targetInstanceId: string, keepData = true): Promise<{ status: string; agent: string; targetInstance: string }> {
    const agent = this.getByName(agentName);
    if (!agent) throw Object.assign(new Error('Agent not found'), { statusCode: 404 });

    const sourceInstanceId = agent.instanceId;
    if (!sourceInstanceId) {
      throw Object.assign(new Error('Agent has no instance'), { statusCode: 400 });
    }

    if (sourceInstanceId === targetInstanceId) {
      throw Object.assign(new Error('Agent is already on target instance'), { statusCode: 400 });
    }

    // Check target instance exists and has capacity
    const targetInstance = instancesRepo.getById(targetInstanceId);
    if (!targetInstance) {
      throw Object.assign(new Error('Target instance not found'), { statusCode: 404 });
    }

    const targetLoad = getInstanceLoad(targetInstanceId);
    if (!targetLoad || targetLoad.available <= 0) {
      throw Object.assign(new Error('Target instance has no available capacity'), { statusCode: 400 });
    }

    const sourceInstance = instancesRepo.getById(sourceInstanceId);
    if (!sourceInstance) {
      throw Object.assign(new Error('Source instance not found'), { statusCode: 404 });
    }

    const lifecycle = getAgentLifecycle();
    const template = templatesRepo.getById(agent.templateId);
    if (!template) {
      throw Object.assign(new Error('Template not found'), { statusCode: 404 });
    }

    logActivity({
      eventType: 'agent.transfer',
      agentName: agent.name,
      detail: `Starting transfer from ${sourceInstance.name} to ${targetInstance.name}`,
    });

    // Step 1: Read workspace files from source instance (if keepData is true)
    let soulContent: string | undefined;
    let agentsMdContent: string | undefined;

    if (keepData) {
      try {
        const sourceNode = this.nodeManager.getNode(sourceInstance.nodeId) ?? this.nodeManager.getDefaultNode();
        const soulPath = `workspace/agents/${agent.name}/SOUL.md`;
        const agentsPath = `workspace/agents/${agent.name}/AGENTS.md`;

        try {
          const soulResult = await sourceNode.readInstanceFile(sourceInstance.name, soulPath);
          soulContent = typeof soulResult === 'string' ? soulResult : soulResult.content;
        } catch (err: any) {
          console.warn(`[agent-manager] Could not read SOUL.md from source: ${err.message}`);
        }

        try {
          const agentsResult = await sourceNode.readInstanceFile(sourceInstance.name, agentsPath);
          agentsMdContent = typeof agentsResult === 'string' ? agentsResult : agentsResult.content;
        } catch (err: any) {
          console.warn(`[agent-manager] Could not read AGENTS.md from source: ${err.message}`);
        }
      } catch (err: any) {
        console.warn(`[agent-manager] Failed to read workspace data: ${err.message}`);
      }
    }

    // Step 2: Remove agent from source instance
    try {
      await lifecycle.removeAgent(sourceInstanceId, agent.name);
      logActivity({
        eventType: 'agent.transfer',
        agentName: agent.name,
        detail: `Removed from source instance ${sourceInstance.name}`,
      });
    } catch (err: any) {
      throw Object.assign(new Error(`Failed to remove agent from source: ${err.message}`), { statusCode: 500 });
    }

    // Step 3: Update agent's instance and node in DB
    const updatedAgent = agentsRepo.update(agent.id, {
      instanceId: targetInstanceId,
      nodeId: targetInstance.nodeId,
    });

    if (!updatedAgent) {
      throw Object.assign(new Error('Failed to update agent record'), { statusCode: 500 });
    }

    // Step 4: Create agent on target instance
    try {
      const vars: Record<string, string> = {
        agent_name: agent.name,
        role: template.role,
        skills: template.skills,
      };

      const agentConfig: any = {
        id: agent.name,
        name: agent.name,
        workspace: 'workspace',
        model: resolveTemplateModel(template),
        identity: { name: agent.name },
      };

      if (template.toolsAllow?.length) {
        agentConfig.tools = { allow: template.toolsAllow };
      }

      await lifecycle.createAgent(targetInstanceId, agentConfig);

      logActivity({
        eventType: 'agent.transfer',
        agentName: agent.name,
        detail: `Created on target instance ${targetInstance.name}`,
      });
    } catch (err: any) {
      // Rollback: restore agent to source instance
      try {
        agentsRepo.update(agent.id, {
          instanceId: sourceInstanceId,
          nodeId: sourceInstance.nodeId,
        });
      } catch (rollbackErr: any) {
        console.error(`[agent-manager] Failed to rollback agent after transfer failure: ${rollbackErr.message}`);
      }
      throw Object.assign(new Error(`Failed to create agent on target: ${err.message}`), { statusCode: 500 });
    }

    // Step 5: Write workspace files to target instance (if we have them)
    if (keepData && (soulContent || agentsMdContent)) {
      try {
        const targetNode = this.nodeManager.getNode(targetInstance.nodeId) ?? this.nodeManager.getDefaultNode();

        if (soulContent) {
          const soulPath = `workspace/agents/${agent.name}/SOUL.md`;
          await targetNode.writeInstanceFile(targetInstance.name, soulPath, soulContent);
        }

        if (agentsMdContent) {
          const agentsPath = `workspace/agents/${agent.name}/AGENTS.md`;
          await targetNode.writeInstanceFile(targetInstance.name, agentsPath, agentsMdContent);
        }

        logActivity({
          eventType: 'agent.transfer',
          agentName: agent.name,
          detail: `Workspace files copied to ${targetInstance.name}`,
        });
      } catch (err: any) {
        console.warn(`[agent-manager] Failed to copy workspace files: ${err.message}`);
        // Don't fail the transfer if workspace copy fails
      }
    }

    logActivity({
      eventType: 'agent.transfer',
      agentName: agent.name,
      detail: `Transfer completed: ${sourceInstance.name} → ${targetInstance.name}`,
    });

    eventBus.emit('agent.transferred', {
      agentId: agent.id,
      name: agent.name,
      sourceInstance: sourceInstance.name,
      targetInstance: targetInstance.name,
    });

    dispatchWebhook('agent.transferred', {
      name: agent.name,
      sourceInstance: sourceInstance.name,
      targetInstance: targetInstance.name,
    });

    return {
      status: 'transferred',
      agent: agent.name,
      targetInstance: targetInstance.name,
    };
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
    this.updateOperational(agent.id, {
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
