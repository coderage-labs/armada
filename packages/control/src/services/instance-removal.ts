// ── Instance Removal Service — orchestrates cascading instance destruction ──

import crypto from 'node:crypto';
import { operationManager } from '../infrastructure/operations.js';
import { operationExecutor } from '../infrastructure/executor-singleton.js';
import { instancesRepo, agentsRepo } from '../repositories/index.js';
import type { OperationStep } from '@coderage-labs/armada-shared';

// ── Types ────────────────────────────────────────────────────────────

export interface InstanceImpactAssessment {
  instance: { id: string; name: string; status: string };
  agents: Array<{ id: string; name: string; status: string }>;
}

export interface InstanceRemovalService {
  /**
   * Get impact assessment for destroying an instance.
   */
  assessImpact(instanceId: string): InstanceImpactAssessment;

  /**
   * Destroy an instance through the operations pipeline.
   * Returns the operation ID for tracking.
   */
  destroy(instanceId: string, opts?: { createdBy?: string; deleteWorkspace?: boolean }): Promise<string>;
}

// ── Implementation ───────────────────────────────────────────────────

export const instanceRemovalService: InstanceRemovalService = {
  assessImpact(instanceId: string): InstanceImpactAssessment {
    const instance = instancesRepo.getById(instanceId);
    if (!instance) throw new Error(`Instance not found: ${instanceId}`);

    const agents = agentsRepo.getAll().filter(a => a.instanceId === instanceId);

    return {
      instance: { id: instance.id, name: instance.name, status: instance.status },
      agents: agents.map(a => ({ id: a.id, name: a.name, status: a.status })),
    };
  },

  async destroy(instanceId: string, opts?: { createdBy?: string; deleteWorkspace?: boolean }): Promise<string> {
    const instance = instancesRepo.getById(instanceId);
    if (!instance) throw new Error(`Instance not found: ${instanceId}`);

    const instanceAgents = agentsRepo.getAll().filter(a => a.instanceId === instanceId);
    const nodeId = instance.nodeId;
    const containerName = instance.name;

    const steps: OperationStep[] = [];

    // If instance has agents, stop them gracefully first
    if (instanceAgents.length > 0) {
      steps.push({
        id: crypto.randomUUID(),
        name: 'stop_agents',
        status: 'pending',
        metadata: { nodeId, containerName, instanceId },
      });
    }

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

    // Clean up DB
    steps.push({
      id: crypto.randomUUID(),
      name: 'cleanup_instance_db',
      status: 'pending',
      metadata: { instanceId },
    });

    const opId = operationManager.create(
      'instance.destroy',
      { instanceId, name: instance.name, nodeId },
      {
        steps,
        targetType: 'instance',
        targetId: instanceId,
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
