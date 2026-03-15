import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setupTestDb, teardownTestDb } from '../../test/helpers.js';
import { nodeRemovalService } from '../node-removal.js';
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

// Mock nodeConnectionManager — node is offline by default
vi.mock('../../ws/node-connections.js', () => ({
  nodeConnectionManager: {
    isOnline: vi.fn().mockReturnValue(false),
    connections: new Map(),
    unregister: vi.fn(),
  },
}));

function createTestNode(overrides?: Partial<Parameters<typeof nodesRepo.create>[0]>) {
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
    ...overrides,
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
    status: 'stopped',
    role: '',
    skills: '',
    model: '',
    lastHeartbeat: null,
    healthStatus: 'healthy',
    heartbeatMeta: null,
  });
}

describe('NodeRemovalService', () => {
  beforeEach(() => {
    setupTestDb();
  });

  afterEach(() => {
    teardownTestDb();
    vi.clearAllMocks();
  });

  // 1. assessImpact returns correct node, instances, agents
  it('assessImpact returns correct node, instances, and agents', () => {
    const node = createTestNode();
    const instance1 = createTestInstance(node.id, 'instance-a');
    const instance2 = createTestInstance(node.id, 'instance-b');
    const agent1 = createTestAgent(node.id, instance1.id, 'agent-1');
    const agent2 = createTestAgent(node.id, instance2.id, 'agent-2');

    const impact = nodeRemovalService.assessImpact(node.id);

    expect(impact.node).toEqual({ id: node.id, hostname: 'test-node' });
    expect(impact.instances).toHaveLength(2);
    expect(impact.instances.map(i => i.id)).toContain(instance1.id);
    expect(impact.instances.map(i => i.id)).toContain(instance2.id);
    expect(impact.agents).toHaveLength(2);
    expect(impact.agents.map(a => a.id)).toContain(agent1.id);
    expect(impact.agents.map(a => a.id)).toContain(agent2.id);
  });

  // 2. assessImpact throws for unknown node
  it('assessImpact throws for unknown node', () => {
    expect(() => nodeRemovalService.assessImpact('non-existent-id')).toThrow('Node not found');
  });

  // 3. remove creates operation with correct steps for node with instances (online)
  it('remove creates operation with correct steps for online node with instances', async () => {
    const { nodeConnectionManager } = await import('../../ws/node-connections.js');
    (nodeConnectionManager.isOnline as ReturnType<typeof vi.fn>).mockReturnValue(true);

    const node = createTestNode();
    const instance = createTestInstance(node.id, 'my-container');
    createTestAgent(node.id, instance.id);

    const opId = await nodeRemovalService.remove(node.id);
    expect(typeof opId).toBe('string');

    const op = operationManager.get(opId);
    expect(op).not.toBeNull();
    expect(op!.type).toBe('node.removal');
    expect(op!.targetType).toBe('node');
    expect(op!.targetId).toBe(node.id);

    const stepNames = op!.steps.map(s => s.name);
    expect(stepNames).toContain('drain_node');
    expect(stepNames).toContain('stop_agents');
    expect(stepNames).toContain('stop_container');
    expect(stepNames).toContain('destroy_container');
    expect(stepNames).toContain('disconnect_node');
    expect(stepNames).toContain('cleanup_node_db');

    // drain_node should be first, cleanup_node_db last
    expect(stepNames[0]).toBe('drain_node');
    expect(stepNames[stepNames.length - 1]).toBe('cleanup_node_db');
  });

  // 4. remove handles node with no instances (just disconnect + cleanup)
  it('remove handles offline node with no instances (skip container steps, just cleanup_node_db)', async () => {
    const node = createTestNode();

    const opId = await nodeRemovalService.remove(node.id);
    const op = operationManager.get(opId);

    expect(op).not.toBeNull();
    const stepNames = op!.steps.map(s => s.name);

    // For offline node with no instances, only cleanup_node_db should be present
    expect(stepNames).toEqual(['cleanup_node_db']);
  });
});
