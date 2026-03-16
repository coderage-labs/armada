import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setupTestDb, teardownTestDb } from '../../test/helpers.js';
import { createChangesetService } from '../changeset-service.js';
import { getDrizzle } from '../../db/drizzle.js';
import { instances, nodes, changesets, pendingMutations } from '../../db/drizzle-schema.js';
import { configDiffService } from '../config-diff.js';
import { eq } from 'drizzle-orm';
import { operationExecutor } from '../../infrastructure/executor-singleton.js';
import { operationManager } from '../../infrastructure/operations.js';

// ── Helpers ──────────────────────────────────────────────────────────

/** Seed a global mutation so the changeset pipeline discovers all running instances */
function seedGlobalMutation(changesetId = 'draft-cs') {
  // Ensure a draft changeset exists for the mutation
  getDrizzle().insert(changesets).values({
    id: changesetId,
    status: 'draft',
    changesJson: '[]',
    planJson: '{"instanceOps":[],"order":"sequential","concurrency":1,"totalInstances":0,"totalChanges":0,"totalRestarts":0,"estimatedDuration":0}',
  }).onConflictDoNothing().run();

  getDrizzle().insert(pendingMutations).values({
    id: `mut-${Date.now()}`,
    changesetId,
    entityType: 'model',
    entityId: 'test-model-1',
    action: 'update',
    payloadJson: JSON.stringify({ name: 'test-model' }),
  }).run();
}

function seedNode(id = 'test-node') {
  getDrizzle().insert(nodes).values({
    id,
    hostname: 'test-host',
    status: 'online',
  }).run();
}

function seedInstance(overrides: {
  id?: string;
  name?: string;
  nodeId?: string;
  appliedConfigVersion?: number;
} = {}) {
  const {
    id = 'inst-1',
    name = 'instance-1',
    nodeId = 'test-node',
    appliedConfigVersion = 0,
  } = overrides;

  getDrizzle().insert(instances).values({
    id,
    name,
    nodeId,
    status: 'running',
    capacity: 5,
    appliedConfigVersion,
  }).run();
}

// ── Tests ────────────────────────────────────────────────────────────

describe('ChangesetService', () => {
  beforeEach(() => {
    setupTestDb();
  });

  afterEach(() => {
    teardownTestDb();
    vi.restoreAllMocks();
  });

  // 1. preview returns empty changes when no pending restarts
  it('preview returns empty changes when no pending restarts', () => {
    seedNode();
    seedInstance({ appliedConfigVersion: 0 });
    // Ensure version is 0 too — so instance is NOT stale
    // (appliedConfigVersion 0 == currentVersion 0 → not stale)

    const service = createChangesetService();
    const { changes, plan } = service.preview();

    expect(changes).toHaveLength(0);
    expect(plan.totalInstances).toBe(0);
    expect(plan.instanceOps).toHaveLength(0);
  });

  // 2. create throws when no pending changes
  it('create throws when no pending changes', () => {
    seedNode();
    seedInstance({ appliedConfigVersion: 0 });

    const service = createChangesetService();
    expect(() => service.create()).toThrow('No pending changes');
  });

  // 3. create succeeds when instances have pending restarts
  it('create succeeds when instances have pending restarts', () => {
    seedNode();
    seedInstance({ appliedConfigVersion: 0 });
    seedGlobalMutation();

    const service = createChangesetService();
    const changeset = service.create({ createdBy: 'test-user' });

    expect(changeset.id).toBeTruthy();
    expect(changeset.status).toBe('draft');
    expect(changeset.createdBy).toBe('test-user');
    expect(changeset.changes.length).toBeGreaterThan(0);
    expect(changeset.plan.totalInstances).toBe(1);
    expect(changeset.plan.instanceOps[0].instanceId).toBe('inst-1');
    expect(changeset.rollback).toBeDefined();
  });

  // 3b. create succeeds when instances have stale config version
  it('create succeeds when instances have stale config version', () => {
    seedNode();
    // Bump the global version to 1, instance at 0 with stale appliedConfigVersion
    configDiffService.bumpVersion();
    seedInstance({ appliedConfigVersion: 0 });
    seedGlobalMutation();

    const service = createChangesetService();
    const changeset = service.create();

    expect(changeset.status).toBe('draft');
    expect(changeset.plan.totalInstances).toBe(1);
  });

  // 4. approve changes status from draft to approved
  it('approve changes status from draft to approved', () => {
    seedNode();
    seedInstance();
    seedGlobalMutation();

    const service = createChangesetService();
    const created = service.create();
    expect(created.status).toBe('draft');

    const approved = service.approve(created.id, 'admin-user');
    expect(approved.status).toBe('approved');
    expect(approved.approvedBy).toBe('admin-user');
    expect(approved.approvedAt).toBeTruthy();
  });

  // 5. approve throws on non-draft changeset
  it('approve throws on non-draft changeset', () => {
    seedNode();
    seedInstance();
    seedGlobalMutation();

    const service = createChangesetService();
    const created = service.create();
    service.approve(created.id); // move to approved

    // Trying to approve again should fail
    expect(() => service.approve(created.id)).toThrow(/not in draft status/);
  });

  // 5b. approve throws on non-existent changeset
  it('approve throws on non-existent changeset', () => {
    const service = createChangesetService();
    expect(() => service.approve('non-existent-id')).toThrow(/not found/);
  });

  // 6. cancel changes status (draft)
  it('cancel changes status from draft', () => {
    seedNode();
    seedInstance();
    seedGlobalMutation();

    const service = createChangesetService();
    const created = service.create();
    const cancelled = service.cancel(created.id);

    expect(cancelled.status).toBe('cancelled');
  });

  // 6b. cancel changes status from approved
  it('cancel changes status from approved', () => {
    seedNode();
    seedInstance();
    seedGlobalMutation();

    const service = createChangesetService();
    const created = service.create();
    service.approve(created.id);
    const cancelled = service.cancel(created.id);

    expect(cancelled.status).toBe('cancelled');
  });

  // 6b2. cancel deletes orphaned pending instances (instance.create mutations)
  it('cancel deletes orphaned pending instances staged for creation', () => {
    seedNode();

    // Seed an instance in 'pending' status (as POST /api/instances would create it)
    const pendingInstanceId = 'inst-pending-orphan';
    getDrizzle().insert(instances).values({
      id: pendingInstanceId,
      name: 'orphan-instance',
      nodeId: 'test-node',
      status: 'pending',
      capacity: 5,
    }).run();

    // Create a draft changeset
    const changesetId = 'cs-with-create';
    getDrizzle().insert(changesets).values({
      id: changesetId,
      status: 'draft',
      changesJson: '[]',
      planJson: '{"instanceOps":[],"order":"sequential","concurrency":1,"totalInstances":0,"totalChanges":0,"totalRestarts":0,"estimatedDuration":0}',
    }).run();

    // Seed an instance.create mutation referencing the pending instance
    getDrizzle().insert(pendingMutations).values({
      id: 'mut-create-1',
      changesetId,
      entityType: 'instance',
      entityId: pendingInstanceId,
      action: 'create',
      payloadJson: JSON.stringify({ name: 'orphan-instance', nodeId: 'test-node' }),
    }).run();

    const service = createChangesetService();

    // Verify the instance exists before cancel
    const beforeCancel = getDrizzle().select().from(instances).where(eq(instances.id, pendingInstanceId)).get();
    expect(beforeCancel).toBeDefined();

    service.cancel(changesetId);

    // The orphaned pending instance should be deleted
    const afterCancel = getDrizzle().select().from(instances).where(eq(instances.id, pendingInstanceId)).get();
    expect(afterCancel).toBeUndefined();
  });

  // 6b3. cancel restores pending_delete instances to their previous status
  it('cancel restores pending_delete instances to their previous status', () => {
    seedNode();

    const instanceId = 'inst-pending-delete';
    getDrizzle().insert(instances).values({
      id: instanceId,
      name: 'to-delete-instance',
      nodeId: 'test-node',
      status: 'pending_delete',
      capacity: 5,
    }).run();

    const changesetId = 'cs-with-delete';
    getDrizzle().insert(changesets).values({
      id: changesetId,
      status: 'draft',
      changesJson: '[]',
      planJson: '{"instanceOps":[],"order":"sequential","concurrency":1,"totalInstances":0,"totalChanges":0,"totalRestarts":0,"estimatedDuration":0}',
    }).run();

    // Seed an instance.delete mutation with previousStatus
    getDrizzle().insert(pendingMutations).values({
      id: 'mut-delete-1',
      changesetId,
      entityType: 'instance',
      entityId: instanceId,
      action: 'delete',
      payloadJson: JSON.stringify({ previousStatus: 'running' }),
    }).run();

    const service = createChangesetService();
    service.cancel(changesetId);

    // The instance should be restored to its previous status
    const restored = getDrizzle().select().from(instances).where(eq(instances.id, instanceId)).get();
    expect(restored).toBeDefined();
    expect(restored!.status).toBe('running');
  });

  // 6c. cancel throws on non-cancellable status
  it('cancel throws on non-cancellable status', () => {
    seedNode();
    seedInstance();
    seedGlobalMutation();

    const service = createChangesetService();
    const created = service.create();

    // Manually update status to completed in DB
    getDrizzle().update(changesets).set({ status: 'completed' }).where(eq(changesets.id, created.id)).run();

    expect(() => service.cancel(created.id)).toThrow(/cannot be cancelled/);
  });

  // 7. get returns correct changeset
  it('get returns correct changeset', () => {
    seedNode();
    seedInstance();
    seedGlobalMutation();

    const service = createChangesetService();
    const created = service.create();
    const fetched = service.get(created.id);

    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(created.id);
    expect(fetched!.status).toBe('draft');
  });

  // 7b. get returns null for non-existent
  it('get returns null for non-existent id', () => {
    const service = createChangesetService();
    expect(service.get('non-existent')).toBeNull();
  });

  // 8. list returns most recent first
  it('list returns most recent first', () => {
    seedNode();
    seedInstance({ id: 'inst-a', name: 'instance-a' });
    seedGlobalMutation();

    const service = createChangesetService();

    // Create first changeset
    const first = service.create({ createdBy: 'first' });

    // Mark the instance as needing restart again (reset)
    seedGlobalMutation('draft-cs-2');

    // Create second changeset
    const second = service.create({ createdBy: 'second' });

    const listed = service.list();
    expect(listed.length).toBeGreaterThanOrEqual(2);
    // Most recent first — second should appear before first
    const ids = listed.map(c => c.id);
    expect(ids.indexOf(second.id)).toBeLessThan(ids.indexOf(first.id));
  });

  // 9. apply changes status to applying then completed (mock executor)
  it('apply changes status through applying to completed', async () => {
    seedNode();
    seedInstance({ appliedConfigVersion: 0 });
    seedGlobalMutation();

    // Mock the executor so it doesn't try real Docker/node operations
    const mockExecute = vi.spyOn(operationExecutor, 'execute').mockResolvedValue(undefined);

    // Also mock operationManager.get to return a completed operation
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

    const service = createChangesetService();
    const created = service.create();
    service.approve(created.id, 'admin');

    const result = await service.apply(created.id);

    expect(mockExecute).toHaveBeenCalled();
    expect(result.status).toBe('completed');
    expect(result.completedAt).toBeTruthy();
    expect(result.appliedAt).toBeTruthy();
  });

  // 9b. apply marks as failed if executor reports failure
  it('apply marks changeset as failed when operation fails', async () => {
    seedNode();
    seedInstance();
    seedGlobalMutation();

    vi.spyOn(operationExecutor, 'execute').mockResolvedValue(undefined);

    vi.spyOn(operationManager, 'get').mockReturnValue({
      id: 'mock-op-id',
      type: 'changeset_apply',
      status: 'failed',
      target: {},
      steps: [],
      stepDeps: [],
      priority: 'normal',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      events: [],
      result: null,
      error: 'Something went wrong',
    });

    const service = createChangesetService();
    const created = service.create();
    service.approve(created.id);

    const result = await service.apply(created.id);

    expect(result.status).toBe('failed');
    expect(result.error).toContain('Something went wrong');
  });

  // 10. apply throws when changeset is not approved
  it('apply throws when changeset is not approved', async () => {
    seedNode();
    seedInstance();
    seedGlobalMutation();

    const service = createChangesetService();
    const created = service.create();
    // Still in draft — not approved

    await expect(service.apply(created.id)).rejects.toThrow(/not approved/);
  });

  // 11. rebuildSteps handles pending instance create mutations (regression test for #21)
  it('rebuildSteps includes instances from pending create mutations (not yet committed to DB)', () => {
    seedNode();
    const service = createChangesetService();

    // Create a draft changeset manually
    const changesetId = 'cs-test-rebuild';
    getDrizzle().insert(changesets).values({
      id: changesetId,
      status: 'draft',
      changesJson: '[]',
      planJson: JSON.stringify({
        instanceOps: [],
        order: 'sequential',
        concurrency: 1,
        totalInstances: 0,
        totalChanges: 0,
        totalRestarts: 0,
        estimatedDuration: 0,
      }),
    }).run();

    // Add a pending instance create mutation (instance not in DB yet)
    const newInstanceId = 'inst-new-create';
    getDrizzle().insert(pendingMutations).values({
      id: 'mut-inst-create',
      changesetId,
      entityType: 'instance',
      entityId: newInstanceId,
      action: 'create',
      payloadJson: JSON.stringify({
        name: 'fresh-instance',
        nodeId: 'test-node',
        capacity: 5,
      }),
    }).run();

    // Add a pending agent create mutation for the new instance
    getDrizzle().insert(pendingMutations).values({
      id: 'mut-agent-create',
      changesetId,
      entityType: 'agent',
      entityId: 'agent-new',
      action: 'create',
      payloadJson: JSON.stringify({
        name: 'fresh-agent',
        instanceId: newInstanceId,
        templateId: 'tmpl-1',
      }),
    }).run();

    // Rebuild steps — should discover the new instance from the pending mutation
    service.rebuildSteps(changesetId);

    // Verify the changeset plan includes the new instance
    const updated = service.get(changesetId);
    expect(updated).toBeTruthy();
    expect(updated!.plan.instanceOps).toHaveLength(1);
    expect(updated!.plan.instanceOps[0]!.instanceId).toBe(newInstanceId);
    expect(updated!.plan.instanceOps[0]!.instanceName).toBe('fresh-instance');

    // Verify the steps include container bootstrap sequence
    const stepNames = updated!.plan.instanceOps[0]!.steps.map((s: any) => s.name);
    expect(stepNames).toContain('pull_image');
    expect(stepNames).toContain('create_container');
    expect(stepNames).toContain('install_plugins');
    expect(stepNames).toContain('push_config');
    expect(stepNames).toContain('start_container');
    expect(stepNames).toContain('health_check');
  });
});
