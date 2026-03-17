/**
 * Unit tests for scoped changeset apply (#87)
 *
 * Verifies that:
 * - zero-impact changesets (model add) write to DB only — no instance operations
 * - medium-impact changesets (running agent config update) use push_config + SIGUSR1 restart
 * - high-impact changesets (instance delete) use full redeploy (current behavior)
 *
 * NOTE: Uses vi.mock to break the ws-node-client → @coderage-labs/armada-shared import chain
 * (same resolution issue that affects concurrency.test.ts and event-failures.test.ts).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock @coderage-labs/armada-shared — it's not built in the test environment.
// This breaks the import chain that would otherwise fail every test in this file.
vi.mock('@coderage-labs/armada-shared', () => ({
  isVersionCompatible: vi.fn().mockReturnValue(true),
  ARMADA_PROTOCOL_VERSION: '1.0.0',
  WsErrorCode: {},
}));

// Mock the executor singleton BEFORE any service imports to avoid
// ws-node-client → @coderage-labs/armada-shared import chain failure.
vi.mock('../../infrastructure/executor-singleton.js', () => ({
  operationExecutor: {
    execute: vi.fn().mockResolvedValue(undefined),
  },
}));

// Mock ws-node-client and node-connections to avoid WebSocket setup
vi.mock('../../infrastructure/ws-node-client.js', () => ({
  WsNodeClient: class MockWsNodeClient {
    async send() {}
    async pushConfig() {}
    async signalContainer() {}
    async healthCheck() { return true; }
  },
}));

vi.mock('../../ws/node-connections.js', () => ({
  nodeConnectionManager: {
    get: vi.fn(),
    getAll: vi.fn().mockReturnValue([]),
  },
}));

import { setupTestDb, teardownTestDb } from '../../test/helpers.js';
import { getDrizzle } from '../../db/drizzle.js';
import {
  nodes,
  instances,
  agents,
  modelRegistry,
  changesets,
  pendingMutations,
  changesetOperations,
} from '../../db/drizzle-schema.js';
import { eq } from 'drizzle-orm';
import { applyChangeset } from '../../services/changeset-apply.js';
import { operationExecutor } from '../../infrastructure/executor-singleton.js';
import { operationManager } from '../../infrastructure/operations.js';

// ── Seed helpers ────────────────────────────────────────────────────

function seedNode(id = 'test-node') {
  getDrizzle().insert(nodes).values({ id, hostname: 'test-host', status: 'online' }).run();
}

function seedInstance(opts: {
  id?: string;
  name?: string;
  nodeId?: string;
  status?: string;
  url?: string;
} = {}) {
  const { id = 'test-inst', name = 'test-instance', nodeId = 'test-node', status = 'running', url = 'http://localhost:9000' } = opts;
  getDrizzle().insert(instances).values({
    id,
    name,
    nodeId,
    status,
    capacity: 5,
    appliedConfigVersion: 0,
    url,
  }).run();
}

function seedAgent(opts: {
  id?: string;
  name?: string;
  instanceId?: string;
  nodeId?: string;
  status?: string;
} = {}) {
  const { id = 'test-agent', name = 'test-agent', instanceId = 'test-inst', nodeId = 'test-node', status = 'running' } = opts;
  getDrizzle().insert(agents).values({
    id,
    name,
    instanceId,
    nodeId,
    port: 8080,
    status,
    healthStatus: 'healthy',
    avatarGenerating: 0,
  }).run();
}

let _csCounter = 0;

function seedChangeset(opts: {
  id?: string;
  impactLevel?: string;
  status?: string;
  planJson?: string;
} = {}) {
  const { id = `cs-${++_csCounter}`, impactLevel = 'none', status = 'approved', planJson } = opts;
  const plan = planJson ?? JSON.stringify({
    instanceOps: [],
    order: 'sequential',
    concurrency: 1,
    totalInstances: 0,
    totalChanges: 0,
    totalRestarts: 0,
    estimatedDuration: 0,
  });
  getDrizzle().insert(changesets).values({
    id,
    status,
    changesJson: '[]',
    planJson: plan,
    impactLevel,
    affectedResourcesJson: '[]',
    requiresRestart: 0,
  }).run();
  return id;
}

function stageMutation(opts: {
  changesetId: string;
  entityType: string;
  entityId?: string | null;
  action: 'create' | 'update' | 'delete';
  payload?: Record<string, any>;
}) {
  getDrizzle().insert(pendingMutations).values({
    id: `mut-${Date.now()}-${Math.random()}`,
    changesetId: opts.changesetId,
    entityType: opts.entityType,
    entityId: opts.entityId ?? null,
    action: opts.action,
    payloadJson: JSON.stringify(opts.payload ?? {}),
  }).run();
}

function getChangeset(id: string) {
  const row = getDrizzle().select().from(changesets).where(eq(changesets.id, id)).get();
  if (!row) return null;
  return {
    id: row.id,
    status: row.status as any,
    changes: JSON.parse(row.changesJson),
    plan: JSON.parse(row.planJson),
    impactLevel: (row.impactLevel ?? 'none') as any,
    affectedResources: JSON.parse(row.affectedResourcesJson ?? '[]'),
    requiresRestart: row.requiresRestart === 1,
    schemaVersion: row.schemaVersion ?? undefined,
    rollback: row.rollbackJson ? JSON.parse(row.rollbackJson) : undefined,
    createdBy: row.createdBy ?? undefined,
    createdAt: row.createdAt,
    approvedBy: row.approvedBy ?? undefined,
    approvedAt: row.approvedAt ?? undefined,
    appliedAt: row.appliedAt ?? undefined,
    completedAt: row.completedAt ?? undefined,
    error: row.error ?? undefined,
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('Scoped changeset apply (#87)', () => {
  beforeEach(() => {
    setupTestDb();
    _csCounter = 0;
    vi.clearAllMocks();
  });

  afterEach(() => {
    teardownTestDb();
    vi.restoreAllMocks();
  });

  // ── Zero-impact: model add ──────────────────────────────────────

  describe('zero-impact (impactLevel=none) — model add', () => {
    it('completes without calling operationExecutor.execute', async () => {
      seedNode();
      seedInstance();

      const executeSpy = vi.mocked(operationExecutor.execute);

      // Changeset for adding a new model (zero impact)
      const csId = seedChangeset({ impactLevel: 'none' });
      stageMutation({
        changesetId: csId,
        entityType: 'model',
        action: 'create',
        payload: { name: 'new-gpt-4o', provider: 'openai', modelId: 'gpt-4o' },
      });

      const result = await applyChangeset(csId, {}, getChangeset);
      expect(result.status).toBe('completed');

      // No instance operations should have been triggered
      expect(executeSpy).not.toHaveBeenCalled();
    });

    it('writes model mutation to DB', async () => {
      seedNode();
      seedInstance();

      const csId = seedChangeset({ impactLevel: 'none' });
      stageMutation({
        changesetId: csId,
        entityType: 'model',
        action: 'create',
        payload: { name: 'zero-impact-model', provider: 'openai', modelId: 'gpt-3.5-turbo' },
      });

      await applyChangeset(csId, {}, getChangeset);

      // Model should be in the DB now
      const model = getDrizzle().select().from(modelRegistry).where(eq(modelRegistry.name, 'zero-impact-model')).get();
      expect(model).toBeDefined();
      expect(model!.provider).toBe('openai');
    });

    it('creates no changeset operations', async () => {
      seedNode();
      seedInstance();

      const csId = seedChangeset({ impactLevel: 'none' });
      stageMutation({
        changesetId: csId,
        entityType: 'model',
        action: 'create',
        payload: { name: 'no-ops-model', provider: 'openai', modelId: 'gpt-4-turbo' },
      });

      await applyChangeset(csId, {}, getChangeset);

      const ops = getDrizzle().select().from(changesetOperations).where(eq(changesetOperations.changesetId, csId)).all();
      expect(ops).toHaveLength(0);
    });

    it('marks changeset as completed immediately', async () => {
      seedNode();
      seedInstance();

      const csId = seedChangeset({ impactLevel: 'none' });
      stageMutation({
        changesetId: csId,
        entityType: 'model',
        action: 'create',
        payload: { name: 'quick-model', provider: 'anthropic', modelId: 'claude-3' },
      });

      const result = await applyChangeset(csId, {}, getChangeset);
      expect(result.status).toBe('completed');
      expect(result.error).toBeUndefined();
    });
  });

  // ── Medium-impact: running agent config update ──────────────────

  describe('medium-impact (impactLevel=medium) — running agent config update', () => {
    it('uses push_config + restart_gateway + health_check steps (not full redeploy)', async () => {
      seedNode();
      seedInstance({ id: 'med-inst', name: 'medium-instance', url: 'http://localhost:9001' });
      seedAgent({ id: 'med-agent', instanceId: 'med-inst', status: 'running' });

      const capturedSteps: string[] = [];
      vi.mocked(operationExecutor.execute).mockImplementation(async (opId: string) => {
        const op = operationManager.get(opId);
        if (op) {
          for (const step of op.steps) {
            capturedSteps.push(step.name);
          }
          operationManager.complete(opId, {});
        }
      });

      const csId = seedChangeset({ impactLevel: 'medium' });
      stageMutation({
        changesetId: csId,
        entityType: 'agent',
        entityId: 'med-agent',
        action: 'update',
        payload: { model: 'gpt-4o', instanceId: 'med-inst' },
      });

      const result = await applyChangeset(csId, {}, getChangeset);
      expect(result.status).toBe('completed');

      // Should have run push_config + restart_gateway + health_check
      expect(capturedSteps).toContain('push_config');
      expect(capturedSteps).toContain('restart_gateway');
      expect(capturedSteps).toContain('health_check');

      // Should NOT have run full redeploy steps
      expect(capturedSteps).not.toContain('pull_image');
      expect(capturedSteps).not.toContain('create_container');
      expect(capturedSteps).not.toContain('install_plugins');
    });

    it('does NOT recreate the container', async () => {
      seedNode();
      seedInstance({ id: 'med-inst2', name: 'medium-instance-2', url: 'http://localhost:9002' });
      seedAgent({ id: 'med-agent2', instanceId: 'med-inst2', status: 'running' });

      const stepNames: string[] = [];
      vi.mocked(operationExecutor.execute).mockImplementation(async (opId: string) => {
        const op = operationManager.get(opId);
        if (op) {
          for (const step of op.steps) stepNames.push(step.name);
          operationManager.complete(opId, {});
        }
      });

      const csId = seedChangeset({ impactLevel: 'medium' });
      stageMutation({
        changesetId: csId,
        entityType: 'agent',
        entityId: 'med-agent2',
        action: 'update',
        payload: { role: 'reviewer', instanceId: 'med-inst2' },
      });

      await applyChangeset(csId, {}, getChangeset);

      expect(stepNames).not.toContain('create_container');
      expect(stepNames).not.toContain('destroy_container');
      expect(stepNames).not.toContain('stop_container');
    });
  });

  // ── High-impact: instance delete / full redeploy ─────────────────

  describe('high-impact (impactLevel=high) — instance operations run verbatim from plan', () => {
    it('uses the plan instanceOps steps without overriding them', async () => {
      seedNode();
      seedInstance({ id: 'high-inst', name: 'high-instance', url: 'http://localhost:9003' });

      const capturedSteps: string[] = [];
      vi.mocked(operationExecutor.execute).mockImplementation(async (opId: string) => {
        const op = operationManager.get(opId);
        if (op) {
          for (const step of op.steps) capturedSteps.push(step.name);
          operationManager.complete(opId, {});
        }
      });

      // Manually build the plan with destroy steps (as buildStepsForInstance would generate)
      const destroyPlan = JSON.stringify({
        instanceOps: [
          {
            instanceId: 'high-inst',
            instanceName: 'high-instance',
            changes: [],
            steps: [
              { id: 'step-1', name: 'stop_container', status: 'pending', metadata: { nodeId: 'test-node', containerName: 'armada-instance-high-instance' } },
              { id: 'step-2', name: 'destroy_container', status: 'pending', metadata: { nodeId: 'test-node', containerName: 'armada-instance-high-instance' } },
              { id: 'step-3', name: 'cleanup_instance_db', status: 'pending', metadata: { instanceId: 'high-inst', nodeId: 'test-node' } },
            ],
            stepDeps: [['step-1', 'step-2'], ['step-2', 'step-3']],
            estimatedDowntime: 10,
          },
        ],
        order: 'sequential',
        concurrency: 1,
        totalInstances: 1,
        totalChanges: 1,
        totalRestarts: 0,
        estimatedDuration: 15,
      });

      const csId = seedChangeset({ impactLevel: 'high', planJson: destroyPlan });
      stageMutation({
        changesetId: csId,
        entityType: 'instance',
        entityId: 'high-inst',
        action: 'delete',
        payload: { name: 'high-instance', previousStatus: 'running' },
      });

      const result = await applyChangeset(csId, {}, getChangeset);
      expect(result.status).toBe('completed');

      // Full redeploy steps must have been used verbatim from the plan
      expect(capturedSteps).toContain('stop_container');
      expect(capturedSteps).toContain('destroy_container');
      expect(capturedSteps).toContain('cleanup_instance_db');

      // NOT the scoped minimal steps
      expect(capturedSteps).not.toContain('push_config');
      expect(capturedSteps).not.toContain('restart_gateway');
    });

    it('calls operationExecutor.execute (high-impact always runs instance ops)', async () => {
      seedNode();
      seedInstance({ id: 'high-inst3', name: 'high-instance-3', url: 'http://localhost:9005' });

      const executeSpy = vi.mocked(operationExecutor.execute);
      executeSpy.mockImplementation(async (opId: string) => {
        operationManager.complete(opId, {});
      });

      const fullPlan = JSON.stringify({
        instanceOps: [
          {
            instanceId: 'high-inst3',
            instanceName: 'high-instance-3',
            changes: [],
            steps: [
              { id: 'step-x', name: 'push_config', status: 'pending', metadata: { instanceId: 'high-inst3', nodeId: 'test-node', configVersion: 1 } },
              { id: 'step-y', name: 'restart_gateway', status: 'pending', metadata: { nodeId: 'test-node' } },
            ],
            stepDeps: [['step-x', 'step-y']],
            estimatedDowntime: 5,
          },
        ],
        order: 'sequential',
        concurrency: 1,
        totalInstances: 1,
        totalChanges: 1,
        totalRestarts: 1,
        estimatedDuration: 15,
      });

      const csId = seedChangeset({ impactLevel: 'high', planJson: fullPlan });
      stageMutation({
        changesetId: csId,
        entityType: 'instance',
        entityId: 'high-inst3',
        action: 'update',
        payload: { config: { key: 'value' } },
      });

      const result = await applyChangeset(csId, {}, getChangeset);
      expect(result.status).toBe('completed');
      expect(executeSpy).toHaveBeenCalledTimes(1);
    });
  });
});
