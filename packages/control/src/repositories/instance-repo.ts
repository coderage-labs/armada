import { eq, sql } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { getDrizzle } from '../db/drizzle.js';
import { instances, agents, nodes } from '../db/drizzle-schema.js';
import type { ArmadaInstance, Agent, HealthStatus, HeartbeatMeta } from '@coderage-labs/armada-shared';
import {
  parseJsonWithSchema,
  instanceConfigSchema,
  heartbeatMetaSchema,
} from '../utils/json-schemas.js';

interface InstanceRow {
  id: string;
  name: string;
  node_id: string;
  template_id?: string | null;
  url: string | null;
  token: string | null;
  status: string;
  status_message: string | null;
  capacity: number;
  config: string;
  memory: string | null;
  cpus: string | null;
  created_at: string;
  updated_at: string;
  version?: string | null;
  target_version?: string | null;
  applied_config_version?: number | null;
  drain_mode?: number | null;
  agent_count?: number;
  node_name?: string | null;
}

interface AgentRow {
  id: string;
  name: string;
  node_id: string;
  instance_id: string;
  template_id: string | null;
  container_id: string | null;
  port: number;
  status: string;
  role: string | null;
  skills: string | null;
  model: string | null;
  created_at: string;
  last_heartbeat: string | null;
  health_status: string | null;
  heartbeat_meta_json: string | null;
  avatar_generating?: number;
  instance_name?: string | null;
}

function rowToInstance(r: InstanceRow): ArmadaInstance {
  const config = parseJsonWithSchema('[instance-repo] config', r.config || '{}', instanceConfigSchema, {});
  return {
    id: r.id,
    name: r.name,
    nodeId: r.node_id,
    templateId: r.template_id ?? undefined,
    url: r.url ?? undefined,
    token: r.token ?? undefined,
    status: r.status as ArmadaInstance['status'],
    statusMessage: r.status_message ?? undefined,
    capacity: r.capacity,
    config,
    memory: r.memory ?? undefined,
    cpus: r.cpus ?? undefined,
    version: r.version ?? undefined,
    targetVersion: r.target_version ?? undefined,
    appliedConfigVersion: r.applied_config_version ?? 0,
    drainMode: (r.drain_mode ?? 0) === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    agentCount: r.agent_count,
    nodeName: r.node_name ?? undefined,
  };
}

function rowToAgent(r: AgentRow): Agent {
  const heartbeatMeta: HeartbeatMeta | null = r.heartbeat_meta_json
    ? parseJsonWithSchema('[instance-repo] heartbeatMeta', r.heartbeat_meta_json, heartbeatMetaSchema, null as unknown as HeartbeatMeta) as HeartbeatMeta
    : null;
  return {
    id: r.id,
    name: r.name,
    nodeId: r.node_id,
    instanceId: r.instance_id,
    instanceName: r.instance_name ?? undefined,
    templateId: r.template_id ?? '',
    containerId: r.container_id ?? '',
    port: r.port,
    status: r.status as Agent['status'],
    role: r.role ?? '',
    skills: r.skills ?? '',
    model: r.model ?? '',
    uptime: 0,
    createdAt: r.created_at,
    lastHeartbeat: r.last_heartbeat ?? null,
    healthStatus: (r.health_status as HealthStatus) ?? 'unknown',
    heartbeatMeta,
    avatarGenerating: !!r.avatar_generating,
  };
}

const INSTANCE_SELECT = sql`
  SELECT i.*, n.hostname AS node_name,
    (SELECT COUNT(*) FROM agents a WHERE a.instance_id = i.id) AS agent_count
  FROM instances i
  LEFT JOIN nodes n ON i.node_id = n.id
`;

export const instancesRepo = {
  getAll(): ArmadaInstance[] {
    return (getDrizzle().all(sql`${INSTANCE_SELECT} ORDER BY i.name`) as InstanceRow[]).map(rowToInstance);
  },

  getById(id: string): (ArmadaInstance & { agents?: Agent[] }) | undefined {
    const row = getDrizzle().get(sql`${INSTANCE_SELECT} WHERE i.id = ${id}`) as InstanceRow | undefined;
    if (!row) return undefined;
    const instance = rowToInstance(row);
    const agentRows = getDrizzle().all(sql`
      SELECT a.*, inst.name AS instance_name
      FROM agents a
      LEFT JOIN instances inst ON a.instance_id = inst.id
      WHERE a.instance_id = ${id}
    `) as AgentRow[];
    (instance as ArmadaInstance & { agents?: Agent[] }).agents = agentRows.map(rowToAgent);
    return instance as ArmadaInstance & { agents?: Agent[] };
  },

  getByName(name: string): ArmadaInstance | undefined {
    const row = getDrizzle().get(sql`${INSTANCE_SELECT} WHERE i.name = ${name}`) as InstanceRow | undefined;
    return row ? rowToInstance(row) : undefined;
  },

  getByNodeId(nodeId: string): ArmadaInstance[] {
    return (getDrizzle().all(sql`${INSTANCE_SELECT} WHERE i.node_id = ${nodeId} ORDER BY i.name`) as InstanceRow[]).map(rowToInstance);
  },

  create(data: Omit<ArmadaInstance, 'id' | 'createdAt' | 'updatedAt' | 'agentCount' | 'nodeName' | 'agents'> & { id?: string }): ArmadaInstance {
    const id = data.id ?? uuidv4();
    getDrizzle().insert(instances).values({
      id,
      name: data.name,
      nodeId: data.nodeId,
      url: data.url ?? null,
      token: data.token ?? null,
      status: data.status ?? 'stopped',
      statusMessage: data.statusMessage ?? null,
      capacity: data.capacity ?? 5,
      config: JSON.stringify(data.config ?? {}),
      memory: data.memory ?? '2g',
      cpus: data.cpus ?? '1',
    }).run();
    return instancesRepo.getById(id)!;
  },

  update(id: string, data: Partial<Omit<ArmadaInstance, 'id' | 'createdAt' | 'agentCount' | 'nodeName' | 'agents'>>): ArmadaInstance | undefined {
    const existing = instancesRepo.getById(id);
    if (!existing) return undefined;

    const updateData: Record<string, any> = {};
    if (data.name !== undefined) updateData.name = data.name;
    if (data.nodeId !== undefined) updateData.nodeId = data.nodeId;
    if (data.url !== undefined) updateData.url = data.url;
    if (data.token !== undefined) updateData.token = data.token;
    if (data.status !== undefined) updateData.status = data.status;
    if (data.statusMessage !== undefined) updateData.statusMessage = data.statusMessage;
    if (data.capacity !== undefined) updateData.capacity = data.capacity;
    if (data.config !== undefined) updateData.config = JSON.stringify(data.config);
    if (data.memory !== undefined) updateData.memory = data.memory;
    if (data.cpus !== undefined) updateData.cpus = data.cpus;
    if (data.version !== undefined) updateData.version = data.version;
    if (data.targetVersion !== undefined) updateData.targetVersion = data.targetVersion;

    if (Object.keys(updateData).length > 0) {
      updateData.updatedAt = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;
      getDrizzle().update(instances).set(updateData).where(eq(instances.id, id)).run();
    }

    return instancesRepo.getById(id);
  },

  remove(id: string): { success: boolean; error?: string } {
    const agentCount = getDrizzle().get(sql`SELECT COUNT(*) as cnt FROM agents WHERE instance_id = ${id}`) as { cnt: number };
    if (agentCount.cnt > 0) {
      return { success: false, error: `Cannot delete instance: ${agentCount.cnt} agent(s) still assigned` };
    }
    const result = getDrizzle().delete(instances).where(eq(instances.id, id)).run();
    return { success: result.changes > 0 };
  },

  updateStatus(id: string, status: ArmadaInstance['status'], message?: string): ArmadaInstance | undefined {
    const existing = instancesRepo.getById(id);
    if (!existing) return undefined;
    getDrizzle().update(instances).set({
      status,
      statusMessage: message ?? null,
      updatedAt: sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
    }).where(eq(instances.id, id)).run();
    return instancesRepo.getById(id);
  },
};
