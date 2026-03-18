/**
 * Tests for fix #112: health monitor uses DB task count to override stale heartbeat activeTasks.
 *
 * Covers:
 * - getAllAgentCapacity returns 0 tasks when no tasks exist for an agent
 * - getAllAgentCapacity reflects DB running task count, not heartbeat meta
 * - Completed/failed tasks are not counted
 * - Multiple agents tracked independently
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setupTestDb, teardownTestDb } from '../../test/helpers.js';
import { agentsRepo, tasksRepo, nodesRepo, instancesRepo, templatesRepo } from '../../repositories/index.js';

// ── Stub eventBus so health-monitor doesn't need the full event system ──

vi.mock('../../infrastructure/event-bus.js', () => ({
  eventBus: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
}));

describe('health-monitor: DB-authoritative task count (#112)', () => {
  let nodeId: string;
  let instanceId: string;
  let templateId: string;

  beforeEach(() => {
    setupTestDb();

    // Insert prerequisite rows required by the agents FK constraints
    const node = nodesRepo.create({
      hostname: 'test-node',
      ip: '127.0.0.1',
      port: 3000,
      url: 'http://127.0.0.1:3000',
      token: 'test-token',
      cores: 4,
      memory: 8192,
      status: 'online',
      lastSeen: new Date().toISOString(),
    });
    nodeId = node.id;

    const instance = instancesRepo.create({
      name: 'test-instance',
      nodeId,
      status: 'running',
      capacity: 5,
      config: {},
      memory: '2g',
      cpus: '1',
    });
    instanceId = instance.id;

    const template = templatesRepo.create({
      name: 'test-template',
      description: null,
      image: 'test-image',
      role: 'worker',
      skills: null,
      model: null,
      resources: {},
      plugins: {},
      pluginsList: [],
      skillsList: [],
      toolsAllow: [],
      toolsProfile: '',
      soul: null,
      agents: null,
      env: {},
      internalAgents: [],
      contacts: [],
      projects: [],
      models: [],
      toolsDeny: [],
    } as any);
    templateId = template.id;
  });

  afterEach(() => {
    teardownTestDb();
    vi.resetAllMocks();
  });

  // ── Helper to create a minimal agent ────────────────────────────

  function createAgent(name: string, heartbeatActiveTasks = 0) {
    return agentsRepo.create({
      name,
      nodeId,
      instanceId,
      templateId,
      containerId: '',
      port: 0,
      status: 'running',
      role: 'worker',
      skills: '',
      model: 'claude-opus-4',
      lastHeartbeat: new Date().toISOString(),
      healthStatus: 'healthy',
      // Heartbeat meta deliberately reports a (potentially stale) count
      heartbeatMeta: { activeTasks: heartbeatActiveTasks, taskCount: heartbeatActiveTasks },
    });
  }

  // ── Helper to create a task for an agent ────────────────────────

  function createTask(toAgent: string, status: 'running' | 'pending' | 'completed' | 'failed') {
    return tasksRepo.create({
      fromAgent: 'orchestrator',
      toAgent,
      taskText: 'do something',
      result: null,
      status,
      taskType: 'generic',
      taskPayload: null,
    });
  }

  describe('countActiveByAgent', () => {
    it('returns 0 when agent has no tasks', () => {
      createAgent('scout');
      expect(tasksRepo.countActiveByAgent('scout')).toBe(0);
    });

    it('counts running tasks for the agent', () => {
      createAgent('scout');
      createTask('scout', 'running');
      expect(tasksRepo.countActiveByAgent('scout')).toBe(1);
    });

    it('counts pending tasks for the agent', () => {
      createAgent('scout');
      createTask('scout', 'pending');
      expect(tasksRepo.countActiveByAgent('scout')).toBe(1);
    });

    it('does not count completed tasks', () => {
      createAgent('scout');
      createTask('scout', 'completed');
      expect(tasksRepo.countActiveByAgent('scout')).toBe(0);
    });

    it('does not count failed tasks', () => {
      createAgent('scout');
      createTask('scout', 'failed');
      expect(tasksRepo.countActiveByAgent('scout')).toBe(0);
    });

    it('counts multiple active tasks', () => {
      createAgent('scout');
      createTask('scout', 'running');
      createTask('scout', 'running');
      createTask('scout', 'pending');
      createTask('scout', 'completed'); // should not count
      expect(tasksRepo.countActiveByAgent('scout')).toBe(3);
    });

    it('only counts tasks for the specific agent', () => {
      createAgent('scout');
      createAgent('forge');
      createTask('scout', 'running');
      createTask('forge', 'running');
      createTask('forge', 'running');
      expect(tasksRepo.countActiveByAgent('scout')).toBe(1);
      expect(tasksRepo.countActiveByAgent('forge')).toBe(2);
    });
  });

  describe('health-monitor uses DB count (not heartbeat meta)', () => {
    it('getAllAgentCapacity reflects DB running tasks, ignoring stale heartbeat', async () => {
      // Agent heartbeat claims 1 active task (stale — step completed but session open)
      const agent = createAgent('scout', /* heartbeatActiveTasks */ 1);

      // But the DB shows no running tasks (step actually completed)
      // No tasks created → countActiveByAgent returns 0

      // Import after DB is set up
      const { getAllAgentCapacity, startHealthMonitor, stopHealthMonitor } = await import('../../services/health-monitor.js');

      startHealthMonitor();
      // Give the synchronous check a tick to run
      await Promise.resolve();

      const capacity = getAllAgentCapacity();
      const scoutCapacity = capacity.find(c => c.name === 'scout');
      expect(scoutCapacity).toBeDefined();
      // Should be 0 from DB, NOT 1 from the stale heartbeat meta
      expect(scoutCapacity!.taskCount).toBe(0);

      stopHealthMonitor();

      void agent; // suppress unused warning
    });

    it('getAllAgentCapacity shows correct count when agent has active DB tasks', async () => {
      const agent = createAgent('forge', /* heartbeatActiveTasks */ 0);

      // Create an actually running task in the DB
      createTask('forge', 'running');

      const { getAllAgentCapacity, startHealthMonitor, stopHealthMonitor } = await import('../../services/health-monitor.js');

      startHealthMonitor();
      await Promise.resolve();

      const capacity = getAllAgentCapacity();
      const forgeCapacity = capacity.find(c => c.name === 'forge');
      expect(forgeCapacity).toBeDefined();
      // DB has 1 running task — must show 1
      expect(forgeCapacity!.taskCount).toBe(1);

      stopHealthMonitor();

      void agent;
    });

    it('tracks multiple agents independently', async () => {
      createAgent('scout', 1); // stale heartbeat says 1
      createAgent('forge', 0); // heartbeat says 0

      // Actual DB state: scout has 0 active, forge has 2 active
      createTask('forge', 'running');
      createTask('forge', 'pending');

      const { getAllAgentCapacity, startHealthMonitor, stopHealthMonitor } = await import('../../services/health-monitor.js');

      startHealthMonitor();
      await Promise.resolve();

      const capacity = getAllAgentCapacity();
      const scoutCap = capacity.find(c => c.name === 'scout');
      const forgeCap = capacity.find(c => c.name === 'forge');

      expect(scoutCap!.taskCount).toBe(0); // DB says 0, not heartbeat's 1
      expect(forgeCap!.taskCount).toBe(2); // DB says 2

      stopHealthMonitor();
    });
  });
});
