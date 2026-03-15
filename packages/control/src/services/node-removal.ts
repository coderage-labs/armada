// ── Node Removal Service — orchestrates cascading node removal ──

import crypto from 'node:crypto';
import { operationManager } from '../infrastructure/operations.js';
import { operationExecutor } from '../infrastructure/executor-singleton.js';
import { instancesRepo, agentsRepo, nodesRepo } from '../repositories/index.js';
import { nodeConnectionManager } from '../ws/node-connections.js';
import type { OperationStep } from '@coderage-labs/armada-shared';

// ── Types ────────────────────────────────────────────────────────────

export interface NodeImpactAssessment {
  node: { id: string; hostname: string };
  instances: Array<{ id: string; name: string; status: string }>;
  agents: Array<{ id: string; name: string; status: string }>;
}

export interface NodeRemovalService {
  /**
   * Get impact assessment for removing a node.
   * Returns list of instances and agents that will be affected.
   */
  assessImpact(nodeId: string): NodeImpactAssessment;

  /**
   * Remove a node through the operations pipeline.
   * Returns the operation ID for tracking.
   */
  remove(nodeId: string, opts?: { createdBy?: string }): Promise<string>;
}

// ── Implementation ───────────────────────────────────────────────────

export const nodeRemovalService: NodeRemovalService = {
  assessImpact(nodeId: string): NodeImpactAssessment {
    const node = nodesRepo.getById(nodeId);
    if (!node) throw new Error(`Node not found: ${nodeId}`);

    const instances = instancesRepo.getByNodeId(nodeId);
    const allAgents = agentsRepo.getAll().filter(a => a.nodeId === nodeId);

    return {
      node: { id: node.id, hostname: node.hostname },
      instances: instances.map(i => ({ id: i.id, name: i.name, status: i.status })),
      agents: allAgents.map(a => ({ id: a.id, name: a.name, status: a.status })),
    };
  },

  async remove(nodeId: string, opts?: { createdBy?: string }): Promise<string> {
    const node = nodesRepo.getById(nodeId);
    if (!node) throw new Error(`Node not found: ${nodeId}`);

    const instances = instancesRepo.getByNodeId(nodeId);
    const isOnline = nodeConnectionManager.isOnline(nodeId);

    const steps: OperationStep[] = [];

    if (isOnline && instances.length > 0) {
      // Drain the node first — stops new task dispatch
      steps.push({
        id: crypto.randomUUID(),
        name: 'drain_node',
        status: 'pending',
        metadata: { nodeId },
      });

      // For each instance: stop agents, stop container, then destroy container
      for (const instance of instances) {
        const containerName = instance.name;

        // Gracefully stop agents on this instance
        steps.push({
          id: crypto.randomUUID(),
          name: 'stop_agents',
          status: 'pending',
          metadata: { nodeId, containerName, instanceId: instance.id },
        });

        // Stop the container
        steps.push({
          id: crypto.randomUUID(),
          name: 'stop_container',
          status: 'pending',
          metadata: { nodeId, containerName },
        });

        // Destroy the container
        steps.push({
          id: crypto.randomUUID(),
          name: 'destroy_container',
          status: 'pending',
          metadata: { nodeId, containerName },
        });
      }

      // Disconnect the WS connection
      steps.push({
        id: crypto.randomUUID(),
        name: 'disconnect_node',
        status: 'pending',
        metadata: { nodeId },
      });
    }

    // Always clean up the DB — even if offline
    steps.push({
      id: crypto.randomUUID(),
      name: 'cleanup_node_db',
      status: 'pending',
      metadata: { nodeId },
    });

    const opId = operationManager.create(
      'node.removal',
      { nodeId, hostname: node.hostname },
      {
        steps,
        targetType: 'node',
        targetId: nodeId,
        createdBy: opts?.createdBy,
      },
    );

    // Fire-and-forget — tracked by operation
    operationExecutor.execute(opId).catch(() => {
      // Errors are captured in the operation's status
    });

    return opId;
  },
};
