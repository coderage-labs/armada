/**
 * instance-capacity.ts — utilities for checking instance capacity and load.
 */

import { instancesRepo, agentsRepo } from '../repositories/index.js';
import type { ArmadaInstance } from '@coderage-labs/armada-shared';

export interface InstanceLoad {
  instanceId: string;
  instanceName: string;
  current: number;
  max: number;
  available: number;
  nodeId: string;
}

export interface CapacitySuggestion {
  error: string;
  suggestion: string;
  instances: Array<{
    id: string;
    name: string;
    agents: number;
    capacity: number;
  }>;
}

/**
 * Get the current load for a specific instance.
 */
export function getInstanceLoad(instanceId: string): InstanceLoad | null {
  const instance = instancesRepo.getById(instanceId);
  if (!instance) return null;

  const agents = agentsRepo.getAll().filter((a) => a.instanceId === instanceId);
  const current = agents.length;
  const max = instance.capacity || 5; // Default capacity if not set
  const available = Math.max(0, max - current);

  return {
    instanceId: instance.id,
    instanceName: instance.name,
    current,
    max,
    available,
    nodeId: instance.nodeId,
  };
}

/**
 * Get load for all instances.
 */
export function getAllInstanceLoads(): InstanceLoad[] {
  const instances = instancesRepo.getAll();
  return instances
    .map((inst) => getInstanceLoad(inst.id))
    .filter((load): load is InstanceLoad => load !== null);
}

/**
 * Find an instance with available capacity, optionally filtering by node.
 */
export function findAvailableInstance(nodeId?: string): InstanceLoad | null {
  const loads = getAllInstanceLoads();
  const filtered = nodeId ? loads.filter((l) => l.nodeId === nodeId) : loads;
  
  // Sort by available capacity (most available first)
  const sorted = filtered
    .filter((l) => l.available > 0)
    .sort((a, b) => b.available - a.available);

  return sorted[0] || null;
}

/**
 * Check if any instance has capacity. If not, return a suggestion to create a new one.
 */
export function checkCapacityOrSuggest(): CapacitySuggestion | null {
  const loads = getAllInstanceLoads();
  const hasCapacity = loads.some((l) => l.available > 0);

  if (hasCapacity) return null;

  // No capacity available
  return {
    error: 'No capacity available',
    suggestion: 'Create a new instance to host this agent',
    instances: loads.map((l) => ({
      id: l.instanceId,
      name: l.instanceName,
      agents: l.current,
      capacity: l.max,
    })),
  };
}

/**
 * Get idle instances — instances where none of the agents have had a heartbeat
 * or completed a task in the threshold period (default 60 minutes).
 */
export function getIdleInstances(idleThresholdMinutes: number = 60): Array<{
  instanceId: string;
  instanceName: string;
  lastActivityAt: string;
  idleMinutes: number;
  agentCount: number;
}> {
  const instances = instancesRepo.getAll();
  const now = Date.now();
  const thresholdMs = idleThresholdMinutes * 60 * 1000;

  const idleInstances: Array<{
    instanceId: string;
    instanceName: string;
    lastActivityAt: string;
    idleMinutes: number;
    agentCount: number;
  }> = [];

  for (const instance of instances) {
    const agents = agentsRepo.getAll().filter((a) => a.instanceId === instance.id);
    
    if (agents.length === 0) {
      // Instance with no agents — use instance creation time as last activity
      const createdTime = new Date(instance.createdAt).getTime();
      const idleMs = now - createdTime;
      
      if (idleMs > thresholdMs) {
        idleInstances.push({
          instanceId: instance.id,
          instanceName: instance.name,
          lastActivityAt: instance.createdAt,
          idleMinutes: Math.round(idleMs / 60000),
          agentCount: 0,
        });
      }
      continue;
    }

    // Find the most recent activity across all agents in this instance
    let lastActivity: number | null = null;

    for (const agent of agents) {
      if (agent.lastHeartbeat) {
        const hbTime = new Date(agent.lastHeartbeat).getTime();
        if (!lastActivity || hbTime > lastActivity) {
          lastActivity = hbTime;
        }
      }
    }

    // If no heartbeat found, use instance creation time
    if (!lastActivity) {
      lastActivity = new Date(instance.createdAt).getTime();
    }

    const idleMs = now - lastActivity;

    if (idleMs > thresholdMs) {
      idleInstances.push({
        instanceId: instance.id,
        instanceName: instance.name,
        lastActivityAt: new Date(lastActivity).toISOString(),
        idleMinutes: Math.round(idleMs / 60000),
        agentCount: agents.length,
      });
    }
  }

  return idleInstances.sort((a, b) => b.idleMinutes - a.idleMinutes);
}
