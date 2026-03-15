/**
 * InstanceManager — single owner of ALL instance lifecycle operations.
 *
 * Every restart path in the system converges here. No more inline
 * restart/upgrade/maintain logic scattered across routes.
 */

import { instancesRepo, agentsRepo, nodesRepo, tasksRepo } from '../repositories/index.js';
import { eventBus } from '../infrastructure/event-bus.js';
import { operationManager } from '../infrastructure/operations.js';
import { getNodeClient, WsNodeClient } from '../infrastructure/node-client.js';
import { nodeConnectionManager } from '../ws/node-connections.js';
import { mutationService } from './mutation-service.js';
import { logActivity } from './activity-service.js';
import { isVersionCompatible } from '@coderage-labs/armada-shared';
import { MIN_AGENT_PLUGIN_VERSION } from '../version.js';
import type { ArmadaInstance } from '@coderage-labs/armada-shared';
import type { PendingMutation } from '../repositories/index.js';

// ── Types ───────────────────────────────────────────────────────────

export interface InstanceCreateParams {
  name: string;
  nodeId: string;
  capacity?: number;
  config?: Record<string, any> | string;
  url?: string;
  token?: string;
  memory?: string;
  cpus?: string;
  templateId?: string;
  image?: string;
}

export interface InstanceCreateResult {
  instance: ArmadaInstance;
  stagedMutation: PendingMutation;
}

// ── Heartbeat payload ────────────────────────────────────────────────

export interface InstanceHeartbeatPayload {
  instanceName: string;
  activeTasks?: any;
  version?: string;
  pluginVersions?: Record<string, string>;
  skillVersions?: Record<string, string>;
  agents?: Array<{ name?: string; id?: string; status?: string }>;
  status?: string;
}

export interface InstanceHeartbeatResult {
  ok: boolean;
  agents: number;
  agentStatus: Array<{ name: string; expected: boolean; reported: boolean; healthy: boolean }>;
  reported: number;
}

// ── Interface ───────────────────────────────────────────────────────

export interface InstanceManager {
  create(params: InstanceCreateParams): Promise<InstanceCreateResult>;
  restart(instanceId: string): Promise<void>;
  stop(instanceId: string): Promise<void>;
  start(instanceId: string): Promise<void>;
  reload(instanceId: string): Promise<void>;
  upgrade(instanceId: string, targetVersion: string): Promise<string>;
  maintain(instanceId: string, opts?: { reason?: string; timeoutMs?: number }): Promise<string>;
  waitForHealthy(instanceId: string, timeoutMs?: number): Promise<boolean>;
  processHeartbeat(payload: InstanceHeartbeatPayload): InstanceHeartbeatResult | { error: string; status: number };
}

// ── Implementation ──────────────────────────────────────────────────

class InstanceManagerImpl implements InstanceManager {

  private resolveInstance(instanceId: string) {
    const instance = instancesRepo.getById(instanceId);
    if (!instance) throw new Error(`Instance "${instanceId}" not found`);
    return instance;
  }

  // ── create ──────────────────────────────────────────────────────

  async create(params: InstanceCreateParams): Promise<InstanceCreateResult> {
    const { name, nodeId, capacity, config, url, token, memory, cpus, templateId, image } = params;

    const existing = instancesRepo.getByName(name);
    if (existing) {
      throw Object.assign(new Error(`Instance with name "${name}" already exists`), { statusCode: 409 });
    }

    const node = nodesRepo.getById(nodeId);
    if (!node) {
      throw Object.assign(new Error(`Node "${nodeId}" not found`), { statusCode: 400 });
    }

    const nodeStatus = nodeConnectionManager.getStatus(nodeId);
    if (nodeStatus === 'offline') {
      throw Object.assign(
        new Error(`Node "${nodeId}" is offline — cannot provision instance`),
        { statusCode: 400 },
      );
    }

    const parsedConfig = typeof config === 'string' ? JSON.parse(config) : (config ?? {});

    // Create the DB record (metadata only — container creation goes through the changeset pipeline)
    const instance = instancesRepo.create({
      name,
      nodeId,
      capacity: capacity ?? 5,
      config: parsedConfig,
      url: url ?? undefined,
      token: token ?? undefined,
      status: 'pending',
      statusMessage: 'Waiting for changeset to be applied',
      memory: typeof memory === 'string' ? memory : undefined,
      cpus: typeof cpus === 'string' ? cpus : undefined,
    });

    // Stage an instance.create mutation — this triggers the changeset pipeline
    // which will: pull_image → create_container → push_config → start_container → health_check
    const stagedMutation = mutationService.stage(
      'instance',
      'create',
      { instanceId: instance.id, nodeId, templateId, image },
      instance.id,
    );

    return { instance, stagedMutation };
  }

  // ── restart ─────────────────────────────────────────────────────

  async restart(instanceId: string): Promise<void> {
    const instance = this.resolveInstance(instanceId);
    const node = getNodeClient(instance.nodeId ?? undefined);
    const containerName = `armada-instance-${instance.name}`;

    eventBus.emit('instance.restarting', { instanceId, name: instance.name });

    await node.stopInstance(containerName);
    await node.startInstance(containerName);

    instancesRepo.updateStatus(instance.id, 'running');

    eventBus.emit('instance.restarted', { instanceId, name: instance.name });
    logActivity({
      eventType: 'instance.restarted',
      detail: `Instance "${instance.name}" restarted`,
    });
  }

  // ── stop ────────────────────────────────────────────────────────

  async stop(instanceId: string): Promise<void> {
    const instance = this.resolveInstance(instanceId);
    const node = getNodeClient(instance.nodeId ?? undefined);
    const containerName = `armada-instance-${instance.name}`;

    await node.stopInstance(containerName);

    instancesRepo.updateStatus(instance.id, 'stopped');

    // Mark all agents in this instance as stopped/offline
    const agents = agentsRepo.getAll().filter(a => a.instanceId === instance.id);
    for (const agent of agents) {
      agentsRepo.update(agent.id, { status: 'stopped', healthStatus: 'offline' });
    }

    eventBus.emit('instance.stopped', { instanceId, name: instance.name });
    logActivity({
      eventType: 'instance.stopped',
      detail: `Instance "${instance.name}" stopped`,
    });
  }

  // ── start ───────────────────────────────────────────────────────

  async start(instanceId: string): Promise<void> {
    const instance = this.resolveInstance(instanceId);
    const node = getNodeClient(instance.nodeId ?? undefined);
    const containerName = `armada-instance-${instance.name}`;

    await node.startInstance(containerName);

    instancesRepo.updateStatus(instance.id, 'running');

    eventBus.emit('instance.started', { instanceId, name: instance.name });
    logActivity({
      eventType: 'instance.started',
      detail: `Instance "${instance.name}" started`,
    });
  }

  // ── reload (SIGUSR1) ───────────────────────────────────────────

  async reload(instanceId: string): Promise<void> {
    const instance = this.resolveInstance(instanceId);
    const node = getNodeClient(instance.nodeId ?? undefined);
    const containerName = `armada-instance-${instance.name}`;

    await node.reloadInstance(containerName);

    eventBus.emit('instance.reloaded', { instanceId, name: instance.name });
  }

  // ── upgrade (long-running operation) ───────────────────────────

  async upgrade(instanceId: string, targetVersion: string): Promise<string> {
    const instance = this.resolveInstance(instanceId);

    const opId = operationManager.create('instance.upgrade', {
      instanceId,
      name: instance.name,
      targetVersion,
    });

    // Fire and forget — tracked by operation
    this.runUpgrade(opId, instance, targetVersion).catch(err => {
      operationManager.fail(opId, err.message);
    });

    return opId;
  }

  private async runUpgrade(opId: string, instance: { id: string; name: string; nodeId?: string | null }, targetVersion: string): Promise<void> {
    const node = getNodeClient(instance.nodeId ?? undefined);

    operationManager.emit(opId, { step: 'upgrading', instance: instance.name });

    instancesRepo.update(instance.id, { targetVersion });

    const upgradeContainerName = `armada-instance-${instance.name}`;
    await node.upgradeInstance(upgradeContainerName, { tag: targetVersion });

    operationManager.emit(opId, { step: 'waiting_healthy', instance: instance.name });

    const healthy = await this.waitForHealthy(instance.id, 90_000);

    if (healthy) {
      instancesRepo.update(instance.id, { version: targetVersion, targetVersion: null as any });
      operationManager.complete(opId, { instance: instance.name, version: targetVersion });
      eventBus.emit('instance.upgraded', { instanceId: instance.id, name: instance.name, version: targetVersion });
      logActivity({
        eventType: 'instance.upgraded',
        detail: `Instance "${instance.name}" upgraded to ${targetVersion}`,
      });
    } else {
      instancesRepo.update(instance.id, { status: 'error' });
      operationManager.fail(opId, 'Instance did not become healthy');
      eventBus.emit('instance.upgrade_failed', { instanceId: instance.id, name: instance.name, targetVersion });
      logActivity({
        eventType: 'instance.upgrade_failed',
        detail: `Instance "${instance.name}" failed to become healthy after upgrade to ${targetVersion}`,
      });
    }
  }

  // ── maintain (long-running operation) ──────────────────────────

  async maintain(instanceId: string, opts?: { reason?: string; timeoutMs?: number }): Promise<string> {
    const instance = this.resolveInstance(instanceId);

    const opId = operationManager.create('instance.maintenance', {
      instanceId,
      name: instance.name,
      reason: opts?.reason,
    });

    // Fire and forget — tracked by operation
    this.runMaintenance(opId, instance, opts).catch(err => {
      operationManager.fail(opId, err.message);
    });

    return opId;
  }

  private async runMaintenance(
    opId: string,
    instance: { id: string; name: string; nodeId?: string | null },
    opts?: { reason?: string; timeoutMs?: number },
  ): Promise<void> {
    const node = getNodeClient(instance.nodeId ?? undefined);
    const drainTimeout = opts?.timeoutMs ?? 60_000;

    // 1. Drain — notify agents to stop accepting tasks
    operationManager.emit(opId, { step: 'draining' });

    const agents = agentsRepo.getAll().filter(a => a.instanceId === instance.id);
    for (const agent of agents) {
      try {
        const containerName = `armada-instance-${instance.name}`;
        await node.drainContainer(containerName, opts?.reason || 'maintenance');
      } catch (err: any) {
        console.warn('[instance-manager] drainContainer failed:', err.message);
      }
    }

    // 2. Wait for idle (activeTasks === 0)
    operationManager.emit(opId, { step: 'waiting_idle' });

    const drainStart = Date.now();
    while (Date.now() - drainStart < drainTimeout) {
      await new Promise(r => setTimeout(r, 5000));
      const currentAgents = agentsRepo.getAll().filter(a => a.instanceId === instance.id);
      const allIdle = currentAgents.every(a => {
        const meta = a.heartbeatMeta as { activeTasks?: number } | undefined;
        return !meta?.activeTasks || meta.activeTasks === 0;
      });
      if (allIdle) break;
    }

    // 3. Reload (SIGUSR1)
    operationManager.emit(opId, { step: 'reloading' });
    const reloadContainerName = `armada-instance-${instance.name}`;
    await node.reloadInstance(reloadContainerName);

    // 4. Wait for healthy
    operationManager.emit(opId, { step: 'waiting_healthy' });
    const healthy = await this.waitForHealthy(instance.id, 90_000);

    if (healthy) {
      operationManager.complete(opId, { instance: instance.name });
      eventBus.emit('instance.maintenance_completed', { instanceId: instance.id, name: instance.name });
      logActivity({
        eventType: 'instance.maintenance_completed',
        detail: `Instance "${instance.name}" maintenance completed`,
      });
    } else {
      operationManager.fail(opId, 'Instance did not recover');
      eventBus.emit('instance.maintenance_failed', { instanceId: instance.id, name: instance.name });
      logActivity({
        eventType: 'instance.maintenance_failed',
        detail: `Instance "${instance.name}" did not recover after maintenance`,
      });
    }
  }

  // ── waitForContainerHealthy (container.inspect polling) ────────

  private async waitForContainerHealthy(node: WsNodeClient, containerName: string, timeoutMs: number): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const result = await node.getInstanceHealth(containerName) as { State?: { Running?: boolean } } | null;
        if (result?.State?.Running === true) return true;
      } catch (err: any) {
        console.warn('[instance-manager] getInstanceHealth failed:', err.message);
      }
      await new Promise(r => setTimeout(r, 3000)); // Poll every 3s
    }
    return false;
  }

  // ── waitForHealthy (heartbeat-based DB polling) ────────────────

  async waitForHealthy(instanceId: string, timeoutMs = 60_000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await new Promise(r => setTimeout(r, 5000));
      const agents = agentsRepo.getAll().filter(a => a.instanceId === instanceId);
      const healthy = agents.some(a =>
        a.lastHeartbeat &&
        new Date(a.lastHeartbeat).getTime() > start &&
        a.healthStatus === 'healthy',
      );
      if (healthy) return true;
    }
    return false;
  }

  // ── processHeartbeat ────────────────────────────────────────────

  processHeartbeat(payload: InstanceHeartbeatPayload): InstanceHeartbeatResult | { error: string; status: number } {
    const { instanceName, activeTasks, version, pluginVersions, skillVersions, agents: reportedAgents, status } = payload;

    if (!instanceName) return { error: 'instanceName required', status: 400 };

    const instance = instancesRepo.getByName(instanceName);
    if (!instance) return { error: 'Instance not found', status: 404 };

    const expectedAgents = agentsRepo.getAll().filter(a => a.instanceId === instance.id);
    const now = new Date().toISOString();

    // Build a map of reported agents for matching
    const reportedMap = new Map<string, any>();
    if (Array.isArray(reportedAgents)) {
      for (const ra of reportedAgents) {
        reportedMap.set(ra.name || ra.id || 'unknown', ra);
      }
    }

    // Update each expected agent's health based on what the instance reported
    const agentStatus: Array<{ name: string; expected: boolean; reported: boolean; healthy: boolean }> = [];
    for (const agent of expectedAgents) {
      const reported = reportedMap.get(agent.name);
      const isHealthy = !!reported && reported.status === 'active';
      agentsRepo.update(agent.id, {
        status: 'running',
        lastHeartbeat: now,
        healthStatus: isHealthy ? 'healthy' : (reported ? 'degraded' : 'unresponsive'),
        heartbeatMeta: {
          activeTasks: activeTasks ?? 0,
          instance: instanceName,
          version,
          pluginVersions,
          skillVersions,
          reportedStatus: reported?.status ?? 'missing',
        },
      });
      agentStatus.push({ name: agent.name, expected: true, reported: !!reported, healthy: isHealthy });
    }

    instancesRepo.update(instance.id, { status: 'running', ...(version ? { version } : {}) });

    // Check armada-agent plugin version compatibility
    const agentPluginVersion = pluginVersions?.['armada-agent'] ?? pluginVersions?.['@coderage-labs/armada-agent'] ?? null;
    if (agentPluginVersion && !isVersionCompatible(agentPluginVersion, MIN_AGENT_PLUGIN_VERSION)) {
      console.warn(`[heartbeat] Instance ${instanceName} has armada-agent plugin ${agentPluginVersion}, needs >= ${MIN_AGENT_PLUGIN_VERSION}`);
    }

    // Update lastProgressAt for active tasks reported by the agent
    if (Array.isArray(activeTasks)) {
      const progressNow = new Date().toISOString();
      for (const taskId of activeTasks) {
        try { tasksRepo.update(taskId, { lastProgressAt: progressNow }); } catch (err: any) { console.warn('[instance-manager] Failed to update task lastProgressAt:', err.message); }
      }
    }

    // Emit instance.ready event (used by health_check step)
    eventBus.emit('instance.ready', {
      instanceId: instance.id,
      instanceName,
      status: status ?? 'ready',
      agents: agentStatus,
      reportedAgents: reportedAgents ?? [],
      version,
    });

    return {
      ok: true,
      agents: expectedAgents.length,
      agentStatus,
      reported: reportedMap.size,
    };
  }
}

// ── Singleton export ────────────────────────────────────────────────

export const instanceManager = new InstanceManagerImpl();
