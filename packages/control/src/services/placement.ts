/**
 * Placement service — finds or creates an instance for a new agent.
 *
 * Scoring:
 *   1. Filter instances with capacity (agentCount < capacity) and status 'running'
 *   2. If nodeId specified, prefer instances on that node
 *   3. Co-location: prefer instances whose existing agents share projects
 *   4. Spread: prefer instances with fewer agents (lower density)
 *   5. If no suitable instance, create a new one
 */

import { instancesRepo, agentsRepo, templatesRepo, nodesRepo } from '../repositories/index.js';
import type { ArmadaInstance, Agent } from '@coderage-labs/armada-shared';

export interface PlacementResult {
  instanceId: string;
  instanceName: string;
  nodeId: string;
  created: boolean;  // true if a new instance was created
}

export interface PlacementOptions {
  nodeId?: string;       // preferred node
  projectIds?: string[]; // agent's projects (for co-location scoring)
}

/**
 * Find the best existing instance or create a new one for agent placement.
 */
export async function findOrCreateInstance(opts: PlacementOptions = {}): Promise<PlacementResult> {
  const { nodeId, projectIds = [] } = opts;

  // 1. Get all instances with their agent counts
  const allInstances = instancesRepo.getAll();
  const candidates = allInstances.filter(i =>
    i.status === 'running' &&
    (i.agentCount ?? 0) < i.capacity,
  );

  // 2. Filter by nodeId if specified
  let filtered = nodeId
    ? candidates.filter(i => i.nodeId === nodeId)
    : candidates;

  // If nodeId filter yields nothing, fall back to all candidates
  if (filtered.length === 0 && nodeId) {
    filtered = candidates;
  }

  if (filtered.length > 0) {
    // 3. Score candidates
    const scored = filtered.map(instance => {
      let score = 0;

      // Co-location bonus: how many of this instance's agents share projects?
      if (projectIds.length > 0 && instance.agents) {
        for (const agent of instance.agents) {
          if (!agent.templateId) continue;
          const tmpl = templatesRepo.getById(agent.templateId);
          if (!tmpl) continue;
          const agentProjects: string[] = (tmpl as any).projects || [];
          const overlap = projectIds.filter(p => agentProjects.includes(p)).length;
          score += overlap * 10;  // strong signal
        }
      }
      // For instances without enriched agents, query them
      if (!instance.agents && projectIds.length > 0) {
        const instanceDetail = instancesRepo.getById(instance.id);
        if (instanceDetail?.agents) {
          for (const agent of instanceDetail.agents) {
            if (!agent.templateId) continue;
            const tmpl = templatesRepo.getById(agent.templateId);
            if (!tmpl) continue;
            const agentProjects: string[] = (tmpl as any).projects || [];
            const overlap = projectIds.filter(p => agentProjects.includes(p)).length;
            score += overlap * 10;
          }
        }
      }

      // Prefer instances on the requested node
      if (nodeId && instance.nodeId === nodeId) {
        score += 5;
      }

      // Spread: prefer lower density (more room = higher score)
      const agentCount = instance.agentCount ?? 0;
      score += (instance.capacity - agentCount);

      return { instance, score };
    });

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    const best = scored[0].instance;
    return {
      instanceId: best.id,
      instanceName: best.name,
      nodeId: best.nodeId,
      created: false,
    };
  }

  // 4. No suitable instance found — create a new one
  const targetNodeId = nodeId || getDefaultNodeId();
  if (!targetNodeId) {
    throw new Error('No nodes available to create an instance');
  }

  const instanceName = `instance-${Date.now().toString(36)}`;
  const instance = instancesRepo.create({
    name: instanceName,
    nodeId: targetNodeId,
    capacity: 5,
    config: {},
    status: 'running',  // Will be provisioned as part of spawn
  });

  return {
    instanceId: instance.id,
    instanceName: instance.name,
    nodeId: targetNodeId,
    created: true,
  };
}

/**
 * Get the default node ID (first available node).
 */
function getDefaultNodeId(): string | undefined {
  const nodes = nodesRepo.getAll();
  const online = nodes.find(n => n.status === 'online');
  return online?.id ?? nodes[0]?.id;
}
