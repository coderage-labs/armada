/**
 * Concurrency and race condition tests.
 *
 * These tests verify that the armada control system handles concurrent mutations,
 * lock conflicts, and re-entrant apply scenarios safely.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setupTestDb, teardownTestDb } from '../../test/helpers.js';
import { getDrizzle } from '../../db/drizzle.js';
import { nodes, instances, changesets, pendingMutations } from '../../db/drizzle-schema.js';
import { mutationService } from '../../services/mutation-service.js';
import { createChangesetService } from '../../services/changeset-service.js';
import { lockManager, createLockManager } from '../lock-manager.js';
import { createOperationManager } from '../operations.js';
import { createStepRegistry } from '../step-registry.js';
import { createOperationExecutor } from '../operation-executor.js';
import { operationExecutor } from '../executor-singleton.js';
import { operationManager } from '../operations.js';
import type { StepContext } from '../step-registry.js';
import type { OperationStep } from '@coderage-labs/armada-shared';
import { eq } from 'drizzle-orm';
import crypto from 'node:crypto';

// ── Helpers ────────────────────────────────────────────────────────────────

const mockServices: StepContext['services'] = {
  nodeClient: () => ({} as any),
  instanceRepo: {} as any,
  agentsRepo: {} as any,
  nodesRepo: {} as any,
  eventBus: { emit: vi.fn() } as any,
};

function makeStep(name: string, metadata?: Record<string, any>): OperationStep {
  return {
    id: crypto.randomUUID(),
    name,
    status: 'pending' as const,
    metadata,
  };
}

function seedNode(id = 'node-1') {
  getDrizzle().insert(nodes).values({
    id,
    hostname: 'test-host',
    status: 'online',
  }).run();
}

function seedInstance(overrides: { id?: string; name?: string; nodeId?: string } = {}) {
  const { id = 'inst-1', name = 'test-inst', nodeId = 'node-1' } = overrides;
  getDrizzle().insert(instances).values({
    id,
    name,
    nodeId,
    status: 'running',
    capacity: 5,
  }).run();
}

/** Insert a pending mutation directly (skips the full mutation-service pipeline). */
function insertPendingMutation(opts: { id?: string; entityType?: string; entityId?: string } = {}) {
  const {
    id = `mut-${crypto.randomUUID()}`,
    entityType = 'model',
    entityId = 'model-1',
  } = opts;
  getDrizzle().insert(pendingMutations).values({
    id,
    changesetId: 'pending',
    entityType,
    entityId,
    action: 'update',
    payloadJson: JSON.stringify({ name: 'test-model' }),
  }).run();
  return id;
}

// ── Suite ──────────────────────────────────────────────────────────────────

describe('Concurrency & race conditions', () => {
  beforeEach(() => {
    setupTestDb();
  });

  afterEach(() => {
    teardownTestDb();
    vi.restoreAllMocks();
  });

  // ── 1. Two mutations staged simultaneously ───────────────────────────────

  it('two mutations staged back-to-back share the same draft changeset', () => {
    seedNode();
    seedInstance();

    // Stage two mutations synchronously — no await between them
    const mut1 = mutationService.stage('model', 'update', { name: 'model-a' }, 'model-1');
    const mut2 = mutationService.stage('provider', 'update', { name: 'provider-b' }, 'provider-1');

    // Both mutations should be in the DB
    const allMuts = getDrizzle().select().from(pendingMutations).all();
    const linked = allMuts.filter(m => m.changesetId !== 'pending');

    expect(linked.length).toBeGreaterThanOrEqual(2);

    // Both mutations must belong to the same changeset
    const changesetIds = new Set(linked.map(m => m.changesetId));
    expect(changesetIds.size).toBe(1);

    // That changeset must be a draft
    const cs = getDrizzle()
      .select()
      .from(changesets)
      .where(eq(changesets.id, [...changesetIds][0]!))
      .get();
    expect(cs).toBeDefined();
    expect(cs!.status).toBe('draft');

    // There should be exactly one draft changeset
    const drafts = getDrizzle().select().from(changesets).all().filter(c => c.status === 'draft');
    expect(drafts).toHaveLength(1);
  });

  // ── 2. Apply while locked ────────────────────────────────────────────────

  it('apply is blocked when the target instance is already locked', async () => {
    seedNode();
    seedInstance();
    insertPendingMutation();

    const service = createChangesetService();
    const created = service.create();
    service.approve(created.id);

    // Acquire an external lock on the instance before applying
    const acquired = lockManager.acquire('instance', 'inst-1', 'external-op-1');
    expect(acquired).toBe(true);

    try {
      const result = await service.apply(created.id);

      // apply() should return without executing (returns changeset with validation info)
      expect(result.validation).toBeDefined();
      const lockConflict = result.validation!.conflicts.find(c => c.code === 'LOCKED_TARGET');
      expect(lockConflict).toBeDefined();
      expect(result.status).toBe('approved'); // status should NOT have changed to 'applying'
    } finally {
      lockManager.release('instance', 'inst-1', 'external-op-1');
    }
  });

  // ── 3. Mutation staged during changeset apply ────────────────────────────

  it('mutation staged while another changeset is applying creates a new draft', () => {
    seedNode();
    seedInstance();
    insertPendingMutation({ entityType: 'model', entityId: 'model-1' });

    const service = createChangesetService();
    const cs1 = service.create();

    // Simulate mid-apply: manually set the changeset to 'applying' status
    getDrizzle()
      .update(changesets)
      .set({ status: 'applying' })
      .where(eq(changesets.id, cs1.id))
      .run();

    // Stage a new mutation while cs1 is 'applying'
    const mut2 = mutationService.stage('provider', 'update', { name: 'provider-x' }, 'provider-2');

    // The new mutation should NOT be linked to the applying changeset
    const afterMut = getDrizzle()
      .select()
      .from(pendingMutations)
      .where(eq(pendingMutations.id, mut2.id))
      .get();

    expect(afterMut).toBeDefined();
    // If linked, it must be to a different (new draft) changeset
    if (afterMut!.changesetId && afterMut!.changesetId !== 'pending') {
      expect(afterMut!.changesetId).not.toBe(cs1.id);

      // The new changeset should be a draft
      const newCs = getDrizzle()
        .select()
        .from(changesets)
        .where(eq(changesets.id, afterMut!.changesetId))
        .get();
      expect(newCs).toBeDefined();
      expect(newCs!.status).toBe('draft');
    }

    // The applying changeset should remain applying
    const cs1After = getDrizzle()
      .select()
      .from(changesets)
      .where(eq(changesets.id, cs1.id))
      .get();
    expect(cs1After!.status).toBe('applying');
  });

  // ── 4. Concurrent draft creation ─────────────────────────────────────────

  it('calling getOrCreateDraft twice rapidly yields a single draft changeset', () => {
    seedNode();
    seedInstance();

    // Seed a pending mutation manually so create() can find work to do
    insertPendingMutation({ entityType: 'model', entityId: 'model-1' });

    // Call getOrCreateDraft() back-to-back without any await
    const draft1 = mutationService.getOrCreateDraft();
    const draft2 = mutationService.getOrCreateDraft();

    expect(draft1).not.toBeNull();
    expect(draft2).not.toBeNull();

    // Both calls must return the same draft
    expect(draft1!.id).toBe(draft2!.id);

    // Only one draft changeset should exist in the DB
    const allChangesets = getDrizzle().select().from(changesets).all();
    const drafts = allChangesets.filter(c => c.status === 'draft');
    expect(drafts).toHaveLength(1);
  });

  // ── 5. Lock release on step failure ──────────────────────────────────────

  it('lock is released after an operation step fails', async () => {
    const ops = createOperationManager();
    const registry = createStepRegistry();
    const executor = createOperationExecutor(ops, registry, mockServices);

    registry.register({
      name: 'failing_step',
      async execute() {
        throw new Error('simulated step failure');
      },
    });

    const opId = ops.create('test.failure', { instanceId: 'inst-lock-test' }, {
      targetType: 'instance',
      targetId: 'inst-lock-test',
      steps: [makeStep('failing_step', { instanceId: 'inst-lock-test' })],
    });

    // Lock is NOT held before execution
    expect(lockManager.check('instance', 'inst-lock-test')).toBeNull();

    await executor.execute(opId);

    const op = ops.get(opId);
    expect(op!.status).toBe('failed');
    expect(op!.error).toContain('simulated step failure');

    // Lock MUST be released even though the step failed
    expect(lockManager.check('instance', 'inst-lock-test')).toBeNull();
  });

  // ── 6. Double apply prevention ───────────────────────────────────────────

  it('applying a changeset twice throws on the second apply', async () => {
    seedNode();
    seedInstance();
    insertPendingMutation();

    const service = createChangesetService();
    const created = service.create();
    service.approve(created.id);

    // Mock the executor so it doesn't do real operations
    vi.spyOn(operationExecutor, 'execute').mockResolvedValue(undefined);

    // Mock operationManager to return a completed operation
    vi.spyOn(operationManager, 'get').mockReturnValue({
      id: 'mock-op-id',
      type: 'changeset_apply',
      status: 'completed',
      target: {},
      steps: [],
      stepDeps: [],
      priority: 'normal',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      events: [],
      result: null,
    });

    // First apply — should succeed
    const result1 = await service.apply(created.id);
    expect(result1.status).toBe('completed');

    // Second apply — should throw because status is now 'completed', not 'approved'
    await expect(service.apply(created.id)).rejects.toThrow(/not approved/);
  });
});
