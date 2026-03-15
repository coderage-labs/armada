import { agentsRepo } from '../repositories/index.js';
import { eventBus } from '../infrastructure/event-bus.js';
import type { HealthStatus } from '@coderage-labs/armada-shared';

// ── SSE event bus for agent health changes ──────────────────────────

type HealthListener = (agentName: string, oldStatus: HealthStatus, newStatus: HealthStatus) => void;

const listeners = new Set<HealthListener>();

export function onHealthChange(listener: HealthListener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function emitHealthChange(agentName: string, oldStatus: HealthStatus, newStatus: HealthStatus) {
  for (const listener of listeners) {
    try {
      listener(agentName, oldStatus, newStatus);
    } catch (err: any) {
      console.warn('[health-monitor] listener threw:', err.message);
    }
  }
}

// ── Capacity tracking ───────────────────────────────────────────────

interface AgentCapacity {
  taskCount: number;
  responseMs: number;
  healthy: boolean;
}

const capacityMap = new Map<string, AgentCapacity>();

/**
 * Get all running agents with a given role, enriched with capacity data.
 * Results are sorted by capacity: healthy first, then lowest taskCount, then lowest responseMs.
 */
export function getAgentsByRoleWithCapacity(role: string): Array<{ name: string; url: string; instanceId?: string; taskCount: number; responseMs: number }> {
  const agents = agentsRepo.getAll();
  const candidates = agents
    .filter(a => a.role === role && (a.status === 'running' || (a.status as string) === 'healthy'))
    .map(a => {
      const cap = capacityMap.get(a.name) ?? { taskCount: 0, responseMs: Infinity, healthy: false };
      return {
        name: a.name,
        url: '',
        instanceId: a.instanceId,
        taskCount: cap.taskCount,
        responseMs: cap.responseMs,
        healthy: cap.healthy,
      };
    });

  // Sort: healthy first, then lowest taskCount, then lowest responseMs
  candidates.sort((a, b) => {
    if (a.healthy !== b.healthy) return a.healthy ? -1 : 1;
    if (a.taskCount !== b.taskCount) return a.taskCount - b.taskCount;
    return a.responseMs - b.responseMs;
  });

  return candidates;
}

/**
 * Get all agents with their capacity info (for the /api/agents/capacity endpoint).
 */
export function getAllAgentCapacity(): Array<{ name: string; role: string; taskCount: number; responseMs: number; healthy: boolean }> {
  const agents = agentsRepo.getAll();
  return agents.map(a => {
    const cap = capacityMap.get(a.name) ?? { taskCount: 0, responseMs: Infinity, healthy: false };
    return {
      name: a.name,
      role: a.role || '',
      taskCount: cap.taskCount,
      responseMs: cap.healthy ? cap.responseMs : 0,
      healthy: cap.healthy,
    };
  });
}

// ── Heartbeat-based health monitoring ───────────────────────────────
// Agents push heartbeats to the control plane. The health monitor
// simply checks heartbeat staleness — no network probing needed.

const CHECK_INTERVAL_MS = 30_000;       // 30s
const HEARTBEAT_STALE_MS = 90_000;      // 90s without heartbeat = degraded
const HEARTBEAT_DEAD_MS = 180_000;      // 3 min without heartbeat = unresponsive

let intervalHandle: ReturnType<typeof setInterval> | null = null;

function checkHealth() {
  const agents = agentsRepo.getAll();
  const now = Date.now();

  for (const agent of agents) {
    // Stopped/stopping agents are offline
    if (agent.status === 'stopped' || (agent.status as string) === 'stopping') {
      const currentHealth = agent.healthStatus as string;
      if (currentHealth !== 'offline') {
        agentsRepo.update(agent.id, { healthStatus: 'offline' });
        emitHealthChange(agent.name, agent.healthStatus, 'offline');
        eventBus.emit('agent.health', { name: agent.name, healthStatus: 'offline' });
      }
      capacityMap.set(agent.name, { taskCount: 0, responseMs: 0, healthy: false });
      continue;
    }

    const oldStatus = agent.healthStatus;
    let newStatus: HealthStatus;

    if (!agent.lastHeartbeat) {
      // Never received a heartbeat — might be starting up
      newStatus = 'unresponsive';
    } else {
      const elapsed = now - new Date(agent.lastHeartbeat).getTime();
      if (elapsed < HEARTBEAT_STALE_MS) {
        newStatus = 'healthy';
      } else if (elapsed < HEARTBEAT_DEAD_MS) {
        newStatus = 'degraded';
      } else {
        newStatus = 'unresponsive';
      }
    }

    // Update capacity from heartbeat meta
    const meta = agent.heartbeatMeta as Record<string, unknown> | null;
    const taskCount = (meta?.activeTasks as number) ?? 0;
    capacityMap.set(agent.name, {
      taskCount,
      responseMs: 0,
      healthy: newStatus === 'healthy',
    });

    if (newStatus !== oldStatus) {
      agentsRepo.update(agent.id, { healthStatus: newStatus });
      emitHealthChange(agent.name, oldStatus, newStatus);
      eventBus.emit('agent.health', { name: agent.name, healthStatus: newStatus });
      console.log(`[health-monitor] ${agent.name}: ${oldStatus} → ${newStatus}`);
    }
  }
}

export function startHealthMonitor(): void {
  if (intervalHandle) return;
  console.log('💓 Health monitor started (30s heartbeat checks)');
  intervalHandle = setInterval(checkHealth, CHECK_INTERVAL_MS);
  // Run first check immediately
  checkHealth();
}

export function stopHealthMonitor(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    console.log('💓 Health monitor stopped');
  }
}
