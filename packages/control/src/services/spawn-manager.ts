/**
 * SpawnManager — orchestrates the full agent spawn flow.
 *
 * Extracted from routes/agents.ts POST / handler and templates/spawn.ts.
 * The legacy per-container spawn in templates/spawn.ts is superseded by
 * instance-based injection via ConfigFileLifecycle.
 */

import { randomUUID } from 'node:crypto';
import { agentsRepo, templatesRepo, instancesRepo } from '../repositories/index.js';
import { projectsRepo } from '../repositories/index.js';
import { eventBus } from '../infrastructure/event-bus.js';
import { mutationService } from './mutation-service.js';

import { instanceManager } from './instance-manager.js';
import { logActivity } from './activity-service.js';
import { dispatchWebhook } from './webhook-dispatcher.js';
import { getAgentLifecycle } from './config-file-lifecycle.js';
import { findOrCreateInstance } from './placement.js';
import { generateAvatar } from './avatar-generator.js';
import { resolveVariables } from '../templates/resolver.js';
import { isValidName } from '../utils/validate.js';
import type { AgentConfig } from './agent-lifecycle.js';
import type { Agent } from '@coderage-labs/armada-shared';
import type { NodeManager } from '../node-manager.js';
import type { PendingMutation } from '../repositories/index.js';

// ── Helpers ─────────────────────────────────────────────────────────

import { resolveTemplateModel } from './model-resolver.js';

// ── Interface ───────────────────────────────────────────────────────

export interface SpawnResult {
  agent: Agent;
  mutation: PendingMutation;
}

export interface SpawnManager {
  spawn(templateId: string, agentName: string, opts?: SpawnOptions): Promise<SpawnResult>;
  setNodeManager(nm: NodeManager): void;
}

export interface SpawnOptions {
  instanceId?: string;   // explicit instance placement
  projects?: string[];   // project overrides for template
}

// ── Implementation ──────────────────────────────────────────────────

class SpawnManagerImpl implements SpawnManager {
  private nodeManager!: NodeManager;

  setNodeManager(nm: NodeManager): void {
    this.nodeManager = nm;
  }

  async spawn(templateId: string, agentName: string, opts: SpawnOptions = {}): Promise<SpawnResult> {
    // ── 1. Validate ─────────────────────────────────────────────

    if (!agentName || !isValidName(agentName)) {
      throw Object.assign(
        new Error('Invalid name — must be lowercase alphanumeric with hyphens'),
        { statusCode: 400 },
      );
    }

    if (!templateId) {
      throw Object.assign(new Error('templateId is required'), { statusCode: 400 });
    }

    // Check name uniqueness
    const existing = agentsRepo.getAll().find((a) => a.name === agentName);
    if (existing) {
      throw Object.assign(new Error('Agent with this name already exists'), { statusCode: 409 });
    }

    // Validate template exists
    const template = templatesRepo.getById(templateId);
    if (!template) {
      throw Object.assign(new Error(`Template not found: ${templateId}`), { statusCode: 404 });
    }

    // If projects specified, stage template update mutation instead of direct DB write
    if (opts.projects && Array.isArray(opts.projects)) {
      mutationService.stage('template', 'update', { projects: opts.projects }, templateId);
    }

    // ── 2. Instance placement ───────────────────────────────────

    let placementInstanceId: string | undefined;
    let placementCreated = false;

    if (opts.instanceId) {
      // Explicit instance requested — validate capacity
      const instance = instancesRepo.getById(opts.instanceId);
      if (!instance) {
        throw Object.assign(new Error(`Instance not found: ${opts.instanceId}`), { statusCode: 404 });
      }
      const agentCount = instance.agentCount ?? 0;
      if (agentCount >= instance.capacity) {
        throw Object.assign(
          new Error(`Instance "${instance.name}" is at capacity (${agentCount}/${instance.capacity})`),
          { statusCode: 409 },
        );
      }
      placementInstanceId = instance.id;
    } else {
      // Auto-placement into existing or new instance
      const projectIds: string[] = (template as any).projects || [];
      const placement = await findOrCreateInstance({ projectIds });
      placementInstanceId = placement.instanceId;
      placementCreated = placement.created;
    }

    if (!placementInstanceId) {
      throw Object.assign(
        new Error('Failed to find or create an instance for agent placement'),
        { statusCode: 500 },
      );
    }

    const instance = instancesRepo.getById(placementInstanceId)!;

    // ── 3. Build agent config ───────────────────────────────────

    const agentConfig: AgentConfig = {
      id: agentName,
      name: agentName,
      model: resolveTemplateModel(template) || undefined,
      workspace: `agents/${agentName}`,
      tools: template.toolsAllow?.length ? { allow: template.toolsAllow } : undefined,
      skills: template.skillsList?.map((s: any) => s.name),
      identity: {
        name: agentName,
        emoji: '🤖',
      },
    };

    // ── 4. Plugin installation is handled by the `install_plugins` changeset step ──
    //    (no eager installation here — node may not be connected yet)

    // ── 5. Process template variables for SOUL.md and AGENTS.md ──

    const vars: Record<string, string> = {
      agent_name: agentName,
      role: template.role,
      skills: template.skills,
    };

    let processedSoul: string | undefined;
    let processedAgents: string | undefined;

    if (template.soul) {
      processedSoul = resolveVariables(template.soul, vars);
    }

    if (template.agents) {
      processedAgents = resolveVariables(template.agents, vars);

      // Append project context for PM-role agents
      const templateProjects = (template as any).projects as string[] | undefined;
      if (template.role === 'project-manager' && templateProjects?.length) {
        const projectLines: string[] = ['\n## Your Projects'];
        for (const projName of templateProjects) {
          const project = projectsRepo.getByName(projName);
          if (project) {
            const members = projectsRepo.getMembers(project.id);
            const memberList = members.length > 0 ? ` (${members.join(', ')})` : '';
            projectLines.push(`- **${project.name}**${memberList}: ${project.description || 'No description'}`);
          }
        }
        if (projectLines.length > 1) {
          processedAgents += '\n' + projectLines.join('\n');
        }
      }
    }

    // ── 6. Stage agent creation as a pending mutation (instead of writing directly to DB) ──
    // Include processed soul and agentsMd so the step-planner can write them during changeset apply

    const agentPayload = {
      name: agentName,
      nodeId: instance.nodeId,
      instanceId: placementInstanceId,
      templateId: template.id,
      containerId: '',  // no per-agent container anymore
      port: 0,
      status: 'running',
      role: template.role,
      skills: template.skills,
      model: template.model,
      lastHeartbeat: null,
      healthStatus: 'unknown',
      heartbeatMeta: null,
      soul: processedSoul,
      agentsMd: processedAgents,
    };

    const stagedMutation = mutationService.stage('agent', 'create', agentPayload);

    // Construct a synthetic agent object from the payload (no real DB ID yet)
    const syntheticId = randomUUID();
    const agent = {
      id: syntheticId,
      ...agentPayload,
    } as any;

    // ── 7. Set up agent workspace files on instance ─────────────
    // Note: SOUL.md and AGENTS.md are NO LONGER written here — they will be
    // written during changeset apply via the step-planner's push_config step.

    const lifecycle = getAgentLifecycle();
    await lifecycle.createAgent(placementInstanceId, agentConfig);

    // ── 8. Sync credentials if integrations are configured ──────
    // Credentials are synced at the instance level via the lifecycle's
    // writeAgentGitConfig (called inside createAgent). No extra step needed here.

    // Note: No direct reload here — the agent.created event triggers config
    // version bump + changeset creation. Config is pushed and gateway restarted
    // via the operations pipeline when the changeset is applied.

    // ── 9. Emit events, log activity, dispatch webhooks ─────────

    logActivity({
      eventType: 'agent.placement',
      agentName: agentName,
      detail: `Placed in instance ${placementInstanceId}${placementCreated ? ' (new)' : ''}`,
    });
    logActivity({ eventType: 'agent.spawn', agentName: agentName, detail: `Spawned from template ${templateId}` });
    // Note: agent.created is NOT emitted — mutation.staged replaces it.
    // The mutation will be applied when the draft changeset is approved and applied.
    eventBus.emit('agent.spawned', { agentId: agent.id, name: agentName, templateId, role: agent.role, status: agent.status });
    dispatchWebhook('agent.spawned', { name: agentName, templateId, role: agent.role });

    // Generate avatar in the background (non-blocking) — can work with just the name
    generateAvatar(agentName, agent.role || 'general').catch((err) =>
      console.warn(`[spawn-manager] post-spawn avatar generation failed for ${agentName}:`, err),
    );

    // ── 10. Return agent record and staged mutation ────────────

    return { agent, mutation: stagedMutation };
  }
}

// ── Singleton export ────────────────────────────────────────────────

export const spawnManager = new SpawnManagerImpl();
