import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setupTestDb, teardownTestDb } from '../../test/helpers.js';
import { instanceRemovalService } from '../instance-removal.js';
import { nodesRepo } from '../../repositories/node-repo.js';
import { instancesRepo } from '../../repositories/instance-repo.js';
import { agentsRepo } from '../../repositories/agent-repo.js';
import { operationManager } from '../../infrastructure/operations.js';

// Mock operationExecutor to avoid actually running steps in tests
vi.mock('../../infrastructure/executor-singleton.js', () => ({
  operationExecutor: {
    execute: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn().mockResolvedValue(undefined),
  },
}));

function createTestNode() {
  return nodesRepo.create({
    hostname: 'test-node',
    ip: '10.0.0.1',
    port: 2376,
    url: '',
    token: '',
    cores: 4,
    memory: 8192,
    status: 'offline',
    lastSeen: '',
  });
}

function createTestInstance(nodeId: string, name = 'test-instance') {
  return instancesRepo.create({
    name,
    nodeId,
    capacity: 5,
    config: {},
    status: 'stopped',
  });
}

function createTestAgent(nodeId: string, instanceId: string, name = 'test-agent') {
  return agentsRepo.create({
    name,
    nodeId,
    instanceId,
    templateId: '',
    containerId: '',
    port: 3000,
    status: 'running',
    role: '',
    skills: '',
    model: '',
    lastHeartbeat: null,
    healthStatus: 'healthy',
    heartbeatMeta: null,
  });
}

describe('InstanceRemovalService', () => {
  beforeEach(() => {
    setupTestDb();
  });

  afterEach(() => {
    teardownTestDb();
    vi.clearAllMocks();
  });

  // 1. assessImpact returns correct instance and agents
  it('assessImpact returns correct instance and agents', () => {
    const node = createTestNode();
    const instance = createTestInstance(node.id);
    const agent1 = createTestAgent(node.id, instance.id, 'agent-1');
    const agent2 = createTestAgent(node.id, instance.id, 'agent-2');

    const impact = instanceRemovalService.assessImpact(instance.id);

    expect(impact.instance).toEqual({
      id: instance.id,
      name: instance.name,
      status: instance.status,
    });
    expect(impact.agents).toHaveLength(2);
    expect(impact.agents.map(a => a.id)).toContain(agent1.id);
    expect(impact.agents.map(a => a.id)).toContain(agent2.id);
  });

  // 2. assessImpact throws for unknown instance
  it('assessImpact throws for unknown instance', () => {
    expect(() => instanceRemovalService.assessImpact('non-existent-id')).toThrow('Instance not found');
  });

  // 3. destroy creates operation with correct steps (with agents)
  it('destroy creates operation with correct steps when instance has agents', async () => {
    const node = createTestNode();
    const instance = createTestInstance(node.id, 'my-container');
    createTestAgent(node.id, instance.id);

    const opId = await instanceRemovalService.destroy(instance.id);
    expect(typeof opId).toBe('string');

    const op = operationManager.get(opId);
    expect(op).not.toBeNull();
    expect(op!.type).toBe('instance.destroy');
    expect(op!.targetType).toBe('instance');
    expect(op!.targetId).toBe(instance.id);

    const stepNames = op!.steps.map(s => s.name);
    expect(stepNames).toContain('stop_agents');
    expect(stepNames).toContain('stop_container');
    expect(stepNames).toContain('destroy_container');
    expect(stepNames).toContain('cleanup_instance_db');

    // stop_agents should come before stop_container
    const stopAgentsIdx = stepNames.indexOf('stop_agents');
    const stopContainerIdx = stepNames.indexOf('stop_container');
    expect(stopAgentsIdx).toBeLessThan(stopContainerIdx);

    // cleanup_instance_db should be last
    expect(stepNames[stepNames.length - 1]).toBe('cleanup_instance_db');
  });

  // 4. destroy handles instance with no agents (skip stop_agents step)
  it('destroy handles instance with no agents (skip stop_agents step)', async () => {
    const node = createTestNode();
    const instance = createTestInstance(node.id, 'empty-instance');

    const opId = await instanceRemovalService.destroy(instance.id);
    const op = operationManager.get(opId);

    expect(op).not.toBeNull();
    const stepNames = op!.steps.map(s => s.name);

    expect(stepNames).not.toContain('stop_agents');
    expect(stepNames).toContain('stop_container');
    expect(stepNames).toContain('destroy_container');
    expect(stepNames).toContain('cleanup_instance_db');
    expect(stepNames[stepNames.length - 1]).toBe('cleanup_instance_db');
  });
});
