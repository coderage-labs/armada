/**
 * True E2E changeset lifecycle test — real SQLite, no mocked executor.
 *
 * What IS mocked:
 *   - operationExecutor.execute(): we skip real Docker/node operations by
 *     marking the operation completed via operationManager. Everything else
 *     (mutation flush, DB writes, status transitions) is fully real.
 *
 * What is NOT mocked:
 *   - SQLite DB (in-memory via setupTestDb)
 *   - mutationService.stage() — full implementation
 *   - changesetService.create/approve/apply/cancel — full implementation
 *   - executePendingMutations — full implementation (writes model to modelRegistry)
 *   - operationManager — full implementation (creates/updates operations in DB)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setupTestDb, teardownTestDb } from '../../test/helpers.js';
import { getDrizzle } from '../../db/drizzle.js';
import { nodes, instances, templates, modelRegistry, agents, pendingMutations, changesets } from '../../db/drizzle-schema.js';
import { eq } from 'drizzle-orm';
import { operationExecutor } from '../../infrastructure/executor-singleton.js';
import { operationManager } from '../../infrastructure/operations.js';

// Import singletons — they rely on getDrizzle() which points at the test DB after setupTestDb()
import { mutationService } from '../mutation-service.js';
import { changesetService } from '../changeset-service.js';
import { initConfigVersionTracker } from '../../infrastructure/config-version-tracker.js';

// Register the config version tracker so mutation.staged bumps the version (as in production)
initConfigVersionTracker();

// ── DB Seed Helpers ───────────────────────────────────────────────────

function seedNode(id = 'e2e-node') {
  getDrizzle().insert(nodes).values({
    id,
    hostname: 'e2e-host',
    status: 'online',
  }).run();
}

function seedTemplate(id = 'e2e-tmpl') {
  getDrizzle().insert(templates).values({
    id,
    name: 'e2e-template',
    image: 'openclaw/openclaw:latest',
    // model references the model we will create — pre-populate so scope matching works
    model: 'e2e-new-model',
  }).run();
}

function seedRunningInstance(opts: { id?: string; nodeId?: string; templateId?: string } = {}) {
  const { id = 'e2e-inst', nodeId = 'e2e-node', templateId = 'e2e-tmpl' } = opts;
  getDrizzle().insert(instances).values({
    id,
    name: 'e2e-instance',
    nodeId,
    status: 'running',
    capacity: 5,
    appliedConfigVersion: 0,
  }).run();

  // Link template via raw SQL (column exists in schema.ts but not in drizzle-schema.ts)
  if (templateId) {
    getDrizzle().run(
      getDrizzle().update(instances)
        .set({ status: 'running' } as any)
        .where(eq(instances.id, id)) as any,
    );
    // Set template_id via raw driver
    const db = getDrizzle() as any;
    if (db.run) {
      try {
        db.run(`UPDATE instances SET template_id = ? WHERE id = ?`, [templateId, id]);
      } catch { /* column might not exist in some test DBs */ }
    }
  }
}

// ── Mock Helpers ──────────────────────────────────────────────────────

/**
 * Spy on operationExecutor.execute and make it mark the operation as
 * completed (bypassing actual Docker/node step execution).
 * Mutation flush and all DB writes still happen normally.
 */
function mockExecutorSuccess() {
  return vi.spyOn(operationExecutor, 'execute').mockImplementation(async (opId: string) => {
    operationManager.setRunning(opId);
    operationManager.complete(opId);
  });
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('Changeset E2E — full lifecycle (real SQLite)', () => {
  beforeEach(() => {
    setupTestDb();
    seedNode();
    seedTemplate();
    seedRunningInstance();
  });

  afterEach(() => {
    teardownTestDb();
    vi.restoreAllMocks();
  });

  // ────────────────────────────────────────────────────────────────────
  // APPLY PATH: stage → draft → approve → apply → verify
  // ────────────────────────────────────────────────────────────────────

  it('apply path: stages mutation, creates draft, approves, applies, and persists model to DB', async () => {
    const execSpy = mockExecutorSuccess();

    // 1. Stage a model create mutation
    const mutation = mutationService.stage('model', 'create', {
      name: 'e2e-new-model',
      provider: 'openai',
      modelId: 'gpt-4o',
      description: 'E2E test model',
    });

    expect(mutation).toBeDefined();
    expect(mutation.entityType).toBe('model');
    expect(mutation.action).toBe('create');

    // 2. Verify a draft changeset was created
    const pending = mutationService.getPending();
    expect(pending.length).toBeGreaterThan(0);

    const draftChangesets = changesetService.list(10).filter(c => c.status === 'draft');
    expect(draftChangesets.length).toBe(1);
    const draft = draftChangesets[0]!;

    // Mutation should now be linked to the draft changeset
    const linkedMutation = getDrizzle()
      .select()
      .from(pendingMutations)
      .where(eq(pendingMutations.changesetId, draft.id))
      .all();
    expect(linkedMutation.length).toBeGreaterThan(0);
    expect(linkedMutation.some(m => m.entityType === 'model')).toBe(true);

    // 3. Approve the changeset
    const approved = changesetService.approve(draft.id, 'e2e-test');
    expect(approved.status).toBe('approved');
    expect(approved.approvedBy).toBe('e2e-test');
    expect(approved.approvedAt).toBeTruthy();

    // 4. Apply the changeset (executor mocked — only step execution bypassed)
    const result = await changesetService.apply(draft.id);

    // 5a. Executor was called
    expect(execSpy).toHaveBeenCalled();

    // 5b. Changeset completed
    expect(result.status).toBe('completed');
    expect(result.completedAt).toBeTruthy();
    expect(result.appliedAt).toBeTruthy();

    // 5c. Model persisted in DB (mutation was flushed to modelRegistry)
    const models = getDrizzle().select().from(modelRegistry).all();
    expect(models.some(m => m.name === 'e2e-new-model')).toBe(true);

    // 5d. Pending mutations cleared
    const remaining = getDrizzle()
      .select()
      .from(pendingMutations)
      .where(eq(pendingMutations.changesetId, draft.id))
      .all();
    expect(remaining).toHaveLength(0);

    // 5e. Instance config version updated
    const updatedInstance = getDrizzle()
      .select()
      .from(instances)
      .where(eq(instances.id, 'e2e-inst'))
      .get();
    expect(updatedInstance).toBeDefined();
    // appliedConfigVersion should have been bumped by configDiffService.markApplied()
    expect(updatedInstance!.appliedConfigVersion).toBeGreaterThan(0);
  });

  it('apply path: changeset status transitions are correct (draft → approved → applying → completed)', async () => {
    mockExecutorSuccess();

    mutationService.stage('model', 'create', {
      name: 'e2e-transition-model',
      provider: 'anthropic',
      modelId: 'claude-3-opus',
    });

    const drafts = changesetService.list(10).filter(c => c.status === 'draft');
    expect(drafts.length).toBeGreaterThan(0);
    const draft = drafts[0]!;

    // draft → approved
    const approved = changesetService.approve(draft.id);
    expect(approved.status).toBe('approved');

    // approved → completed (transitions through 'applying' internally)
    const completed = await changesetService.apply(draft.id);
    expect(completed.status).toBe('completed');

    // Verify no operations are stuck in 'applying' state
    const row = getDrizzle()
      .select({ status: changesets.status })
      .from(changesets)
      .where(eq(changesets.id, draft.id))
      .get();
    expect(row?.status).toBe('completed');
  });

  it('apply path: instance status is correct after apply', async () => {
    mockExecutorSuccess();

    mutationService.stage('model', 'create', {
      name: 'e2e-instance-status-model',
      provider: 'openai',
      modelId: 'gpt-4',
    });

    const [draft] = changesetService.list(1);
    expect(draft).toBeDefined();

    changesetService.approve(draft!.id);
    await changesetService.apply(draft!.id);

    // Instance should still exist (no orphan cleanup) and have status = 'running'
    const inst = getDrizzle()
      .select()
      .from(instances)
      .where(eq(instances.id, 'e2e-inst'))
      .get();
    expect(inst).toBeDefined();
    // Instance was not deleted — only config version was updated
    expect(inst!.status).toBe('running');
  });

  // ────────────────────────────────────────────────────────────────────
  // CANCEL PATH: stage → draft → cancel → verify
  // ────────────────────────────────────────────────────────────────────

  it('cancel path: mutations are cleared after cancel, model NOT written to DB', () => {
    mutationService.stage('model', 'create', {
      name: 'cancelled-model',
      provider: 'openai',
      modelId: 'gpt-3.5-turbo',
    });

    const drafts = changesetService.list(10).filter(c => c.status === 'draft');
    expect(drafts.length).toBe(1);
    const draft = drafts[0]!;

    // Verify mutation is present before cancel
    const beforeCancel = getDrizzle()
      .select()
      .from(pendingMutations)
      .where(eq(pendingMutations.changesetId, draft.id))
      .all();
    expect(beforeCancel.length).toBeGreaterThan(0);

    // Cancel the changeset
    const cancelled = changesetService.cancel(draft.id);
    expect(cancelled.status).toBe('cancelled');

    // Mutations must be cleared
    const afterCancel = getDrizzle()
      .select()
      .from(pendingMutations)
      .where(eq(pendingMutations.changesetId, draft.id))
      .all();
    expect(afterCancel).toHaveLength(0);

    // Model must NOT be in DB (mutations were discarded, not flushed)
    const models = getDrizzle().select().from(modelRegistry).all();
    expect(models.some(m => m.name === 'cancelled-model')).toBe(false);
  });

  it('cancel path: approved changeset can also be cancelled', () => {
    mutationService.stage('model', 'create', {
      name: 'approved-then-cancelled-model',
      provider: 'openai',
      modelId: 'gpt-4o-mini',
    });

    const [draft] = changesetService.list(10).filter(c => c.status === 'draft');
    expect(draft).toBeDefined();

    changesetService.approve(draft!.id, 'admin');

    const approvedCs = changesetService.get(draft!.id);
    expect(approvedCs?.status).toBe('approved');

    const cancelled = changesetService.cancel(draft!.id);
    expect(cancelled.status).toBe('cancelled');

    // Mutations cleared
    const remaining = getDrizzle()
      .select()
      .from(pendingMutations)
      .where(eq(pendingMutations.changesetId, draft!.id))
      .all();
    expect(remaining).toHaveLength(0);

    // Model NOT in DB
    const models = getDrizzle().select().from(modelRegistry).all();
    expect(models.some(m => m.name === 'approved-then-cancelled-model')).toBe(false);
  });

  it('cancel path: orphaned pending instances are cleaned up', () => {
    // Seed a pending instance (as would be created by POST /api/instances)
    const pendingInstId = 'inst-orphan-e2e';
    getDrizzle().insert(instances).values({
      id: pendingInstId,
      name: 'orphan-e2e-instance',
      nodeId: 'e2e-node',
      status: 'pending',
      capacity: 5,
    }).run();

    // Stage an instance create mutation referencing the pending instance
    const csId = 'e2e-cs-orphan';
    getDrizzle().insert(changesets).values({
      id: csId,
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

    getDrizzle().insert(pendingMutations).values({
      id: 'mut-orphan-e2e',
      changesetId: csId,
      entityType: 'instance',
      entityId: pendingInstId,
      action: 'create',
      payloadJson: JSON.stringify({ name: 'orphan-e2e-instance', nodeId: 'e2e-node' }),
    }).run();

    // Verify orphan exists
    const before = getDrizzle()
      .select()
      .from(instances)
      .where(eq(instances.id, pendingInstId))
      .get();
    expect(before).toBeDefined();

    // Cancel
    changesetService.cancel(csId);

    // Orphan must be deleted
    const after = getDrizzle()
      .select()
      .from(instances)
      .where(eq(instances.id, pendingInstId))
      .get();
    expect(after).toBeUndefined();
  });

  it('cancel path: hasPending() returns false after cancel', () => {
    mutationService.stage('model', 'create', {
      name: 'check-pending-model',
      provider: 'openai',
      modelId: 'gpt-4',
    });

    expect(mutationService.hasPending()).toBe(true);

    const [draft] = changesetService.list(10).filter(c => c.status === 'draft');
    changesetService.cancel(draft!.id);

    expect(mutationService.hasPending()).toBe(false);
  });
});

// ── Multi-entity changeset coverage ───────────────────────────────────

describe('Changeset E2E — multiple entity types', () => {
  beforeEach(() => {
    setupTestDb();
    seedNode();
    seedTemplate();
    seedRunningInstance();
  });

  afterEach(() => {
    teardownTestDb();
    vi.restoreAllMocks();
  });

  it('full lifecycle: create model + agent in one changeset, approve, apply — verify both persisted in DB', async () => {
    mockExecutorSuccess();

    // 1. Stage model.create
    mutationService.stage('model', 'create', {
      name: 'multi-entity-model',
      provider: 'openai',
      modelId: 'gpt-4o',
      description: 'Multi-entity test model',
    });

    // 2. Stage agent.create — second mutation goes onto the SAME draft changeset
    mutationService.stage('agent', 'create', {
      name: 'multi-entity-agent',
      nodeId: 'e2e-node',
      instanceId: 'e2e-inst',
      port: 9900,
      status: 'stopped',
    });

    // Both mutations should be on the same draft
    const drafts = changesetService.list(10).filter(c => c.status === 'draft');
    expect(drafts.length).toBe(1);
    const draft = drafts[0]!;

    const linked = getDrizzle()
      .select()
      .from(pendingMutations)
      .where(eq(pendingMutations.changesetId, draft.id))
      .all();
    expect(linked.length).toBe(2);
    expect(linked.some(m => m.entityType === 'model')).toBe(true);
    expect(linked.some(m => m.entityType === 'agent')).toBe(true);

    // 3. Approve and apply
    changesetService.approve(draft.id, 'e2e-multi');
    const result = await changesetService.apply(draft.id);
    expect(result.status).toBe('completed');

    // 4. Model persisted in DB
    const allModels = getDrizzle().select().from(modelRegistry).all();
    expect(allModels.some(m => m.name === 'multi-entity-model')).toBe(true);

    // 5. Agent persisted in DB
    const allAgents = getDrizzle().select().from(agents).all();
    expect(allAgents.some(a => a.name === 'multi-entity-agent')).toBe(true);

    // 6. Pending mutations cleared — nothing left
    const remaining = getDrizzle()
      .select()
      .from(pendingMutations)
      .where(eq(pendingMutations.changesetId, draft.id))
      .all();
    expect(remaining).toHaveLength(0);
  });

  it('discard after multi-entity staging: neither model nor agent written to DB', () => {
    mutationService.stage('model', 'create', {
      name: 'discard-model',
      provider: 'anthropic',
      modelId: 'claude-3-haiku',
    });

    mutationService.stage('agent', 'create', {
      name: 'discard-agent',
      nodeId: 'e2e-node',
      instanceId: 'e2e-inst',
      port: 9901,
      status: 'stopped',
    });

    const [draft] = changesetService.list(10).filter(c => c.status === 'draft');
    expect(draft).toBeDefined();

    // Discard
    const cancelled = changesetService.cancel(draft!.id);
    expect(cancelled.status).toBe('cancelled');

    // Neither entity was written to DB
    const allModels = getDrizzle().select().from(modelRegistry).all();
    expect(allModels.some(m => m.name === 'discard-model')).toBe(false);

    const allAgents = getDrizzle().select().from(agents).all();
    expect(allAgents.some(a => a.name === 'discard-agent')).toBe(false);

    // No pending mutations remain
    const remaining = getDrizzle()
      .select()
      .from(pendingMutations)
      .where(eq(pendingMutations.changesetId, draft!.id))
      .all();
    expect(remaining).toHaveLength(0);
  });
});

// ── Multiple instances targeted by one changeset ──────────────────────

describe('Changeset E2E — multiple instances in one changeset', () => {
  beforeEach(() => {
    setupTestDb();
    seedNode();
    seedTemplate(); // e2e-tmpl references 'e2e-new-model'

    // Seed two instances with unique names (avoids UNIQUE constraint on instances.name)
    getDrizzle().insert(instances).values({
      id: 'e2e-inst-a',
      name: 'e2e-instance-a',
      nodeId: 'e2e-node',
      status: 'running',
      capacity: 5,
      appliedConfigVersion: 0,
    }).run();
    getDrizzle().insert(instances).values({
      id: 'e2e-inst-b',
      name: 'e2e-instance-b',
      nodeId: 'e2e-node',
      status: 'running',
      capacity: 5,
      appliedConfigVersion: 0,
    }).run();

    // Link both instances to e2e-tmpl so model mutation scopes to them
    const db = getDrizzle() as any;
    if (db.run) {
      try {
        db.run(`UPDATE instances SET template_id = ? WHERE id IN (?, ?)`, ['e2e-tmpl', 'e2e-inst-a', 'e2e-inst-b']);
      } catch { /* ignore if column not present */ }
    }
  });

  afterEach(() => {
    teardownTestDb();
    vi.restoreAllMocks();
  });

  it('model mutation scopes to both instances that reference the template', async () => {
    mockExecutorSuccess();

    // Stage a model mutation — template 'e2e-tmpl' has model: 'e2e-new-model' which matches
    mutationService.stage('model', 'create', {
      name: 'e2e-new-model',
      provider: 'openai',
      modelId: 'gpt-4o',
    });

    const [draft] = changesetService.list(1);
    expect(draft).toBeDefined();

    // Plan should include ops for both instances
    const affectedIds = draft!.plan.instanceOps.map(op => op.instanceId);
    expect(affectedIds).toContain('e2e-inst-a');
    expect(affectedIds).toContain('e2e-inst-b');
    expect(draft!.plan.instanceOps.length).toBeGreaterThanOrEqual(2);

    // Apply completes successfully
    changesetService.approve(draft!.id, 'e2e-multi-inst');
    const result = await changesetService.apply(draft!.id);
    expect(result.status).toBe('completed');

    // Model persisted
    const allModels = getDrizzle().select().from(modelRegistry).all();
    expect(allModels.some(m => m.name === 'e2e-new-model')).toBe(true);
  });
});

// ── Error handling during apply ───────────────────────────────────────

describe('Changeset E2E — error handling', () => {
  beforeEach(() => {
    setupTestDb();
    seedNode();
    seedTemplate();
    seedRunningInstance();
  });

  afterEach(() => {
    teardownTestDb();
    vi.restoreAllMocks();
  });

  it('operation failure: changeset transitions to failed when executor marks operation failed', async () => {
    // Mock executor to FAIL (not complete) the operation
    vi.spyOn(operationExecutor, 'execute').mockImplementation(async (opId: string) => {
      operationManager.setRunning(opId);
      operationManager.fail(opId, 'Simulated container failure');
    });

    mutationService.stage('model', 'create', {
      name: 'fail-test-model',
      provider: 'openai',
      modelId: 'gpt-4o',
    });

    const [draft] = changesetService.list(1);
    expect(draft).toBeDefined();

    changesetService.approve(draft!.id, 'e2e-fail-test');
    const result = await changesetService.apply(draft!.id);

    // Changeset must be in 'failed' status
    expect(result.status).toBe('failed');
    expect(result.error).toContain('Simulated container failure');

    // Mutations were already flushed to DB before step execution (see changeset-apply.ts)
    // Model is in DB even though changeset failed
    const allModels = getDrizzle().select().from(modelRegistry).all();
    expect(allModels.some(m => m.name === 'fail-test-model')).toBe(true);

    // Pending mutations were removed as part of flush
    const remaining = getDrizzle()
      .select()
      .from(pendingMutations)
      .where(eq(pendingMutations.changesetId, draft!.id))
      .all();
    expect(remaining).toHaveLength(0);

    // Verify changeset row in DB has 'failed' status
    const row = getDrizzle()
      .select({ status: changesets.status })
      .from(changesets)
      .where(eq(changesets.id, draft!.id))
      .get();
    expect(row?.status).toBe('failed');
  });

  it('apply on non-approved changeset throws immediately', async () => {
    mutationService.stage('model', 'create', {
      name: 'throw-test-model',
      provider: 'openai',
      modelId: 'gpt-4',
    });

    const [draft] = changesetService.list(1);
    expect(draft).toBeDefined();

    // Attempt to apply without approving first
    await expect(changesetService.apply(draft!.id)).rejects.toThrow(/not approved/);
  });
});

// ── Status guards: cannot re-approve non-draft changesets ─────────────

describe('Changeset E2E — status guards', () => {
  beforeEach(() => {
    setupTestDb();
    seedNode();
    seedTemplate();
    seedRunningInstance();
  });

  afterEach(() => {
    teardownTestDb();
    vi.restoreAllMocks();
  });

  it('cannot approve a completed changeset (re-approve not supported)', async () => {
    mockExecutorSuccess();

    mutationService.stage('model', 'create', {
      name: 'guard-test-model',
      provider: 'openai',
      modelId: 'gpt-4',
    });

    const [draft] = changesetService.list(1);
    changesetService.approve(draft!.id);
    await changesetService.apply(draft!.id);

    // Now completed — attempting to approve again must throw
    expect(() => changesetService.approve(draft!.id)).toThrow(/not in draft status/);
  });

  it('cannot approve a cancelled changeset', () => {
    mutationService.stage('model', 'create', {
      name: 'guard-cancel-model',
      provider: 'openai',
      modelId: 'gpt-4',
    });

    const [draft] = changesetService.list(1);
    changesetService.cancel(draft!.id);

    // Cancelled — re-approve must throw
    expect(() => changesetService.approve(draft!.id)).toThrow(/not in draft status/);
  });

  it('cannot cancel a completed changeset', async () => {
    mockExecutorSuccess();

    mutationService.stage('model', 'create', {
      name: 'guard-cancel2-model',
      provider: 'openai',
      modelId: 'gpt-4',
    });

    const [draft] = changesetService.list(1);
    changesetService.approve(draft!.id);
    await changesetService.apply(draft!.id);

    // Completed — cancel must throw
    expect(() => changesetService.cancel(draft!.id)).toThrow(/cannot be cancelled/);
  });

  it('cannot apply a draft (non-approved) changeset', async () => {
    mutationService.stage('model', 'create', {
      name: 'guard-draft-model',
      provider: 'openai',
      modelId: 'gpt-4',
    });

    const [draft] = changesetService.list(1);
    // draft — applying directly must throw
    await expect(changesetService.apply(draft!.id)).rejects.toThrow(/not approved/);
  });
});
