import { eq, sql } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { getDrizzle } from '../db/drizzle.js';
import { agents, instances } from '../db/drizzle-schema.js';
import type { Agent, HealthStatus, HeartbeatMeta } from '@coderage-labs/armada-shared';
import { parseJsonWithSchema, heartbeatMetaSchema } from '../utils/json-schemas.js';

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
  avatar_version?: number;
  instance_name?: string | null;
  soul: string | null;
  agents_md: string | null;
}

function rowToAgent(r: AgentRow): Agent {
  const heartbeatMeta: HeartbeatMeta | null = r.heartbeat_meta_json
    ? parseJsonWithSchema('[agent-repo] heartbeatMeta', r.heartbeat_meta_json, heartbeatMetaSchema, null as unknown as HeartbeatMeta) as HeartbeatMeta
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
    avatarVersion: r.avatar_version ?? 0,
    soul: r.soul ?? null,
    agentsMd: r.agents_md ?? null,
  };
}

// Agent queries need JOIN for instance_name, so we use Drizzle sql`` template for selects
const AGENT_SELECT = sql`
  SELECT a.*, i.name AS instance_name
  FROM agents a
  LEFT JOIN instances i ON a.instance_id = i.id
`;

export const agentsRepo = {
  getAll(): Agent[] {
    return (getDrizzle().all(sql`${AGENT_SELECT}`) as AgentRow[]).map(rowToAgent);
  },

  getById(id: string): Agent | undefined {
    const row = getDrizzle().get(sql`${AGENT_SELECT} WHERE a.id = ${id}`) as AgentRow | undefined;
    return row ? rowToAgent(row) : undefined;
  },

  create(data: Omit<Agent, 'id' | 'uptime' | 'createdAt'>): Agent {
    const id = uuidv4();
    getDrizzle().insert(agents).values({
      id,
      name: data.name,
      nodeId: data.nodeId,
      instanceId: data.instanceId || '',
      templateId: data.templateId || null,
      containerId: data.containerId || null,
      port: data.port,
      status: data.status,
      role: data.role || null,
      skills: data.skills || null,
      model: data.model || null,
      soul: (data as any).soul || null,
      agentsMd: (data as any).agentsMd || null,
    }).run();
    const row = getDrizzle().get(sql`${AGENT_SELECT} WHERE a.id = ${id}`) as AgentRow;
    return rowToAgent(row);
  },

  update(id: string, data: Partial<Agent>): Agent | undefined {
    const existing = agentsRepo.getById(id);
    if (!existing) return undefined;
    const merged = { ...existing, ...data, id };
    getDrizzle().update(agents).set({
      name: merged.name,
      nodeId: merged.nodeId,
      instanceId: merged.instanceId || '',
      templateId: merged.templateId || null,
      containerId: merged.containerId || null,
      port: merged.port,
      status: merged.status,
      role: merged.role || null,
      skills: merged.skills || null,
      model: merged.model || null,
      lastHeartbeat: merged.lastHeartbeat ?? null,
      healthStatus: merged.healthStatus ?? 'unknown',
      heartbeatMetaJson: merged.heartbeatMeta ? JSON.stringify(merged.heartbeatMeta) : null,
      avatarGenerating: (merged as any).avatarGenerating ? 1 : 0,
      avatarVersion: (merged as any).avatarVersion ?? existing.avatarVersion ?? 0,
      soul: (merged as any).soul ?? null,
      agentsMd: (merged as any).agentsMd ?? null,
    }).where(eq(agents.id, id)).run();
    return merged;
  },

  remove(id: string): boolean {
    const result = getDrizzle().delete(agents).where(eq(agents.id, id)).run();
    return result.changes > 0;
  },
};
