// ── Changeset Apply Pipeline — execution of an approved changeset ──

import { eq } from 'drizzle-orm';
import { getDrizzle } from '../db/drizzle.js';
import { changesets, changesetOperations } from '../db/drizzle-schema.js';
import { executePendingMutations } from './mutation-executor.js';
import { operationManager } from '../infrastructure/operations.js';
import { operationExecutor } from '../infrastructure/executor-singleton.js';
import { changesetValidator } from './changeset-validator.js';
import { configDiffService } from './config-diff.js';
import { eventBus } from '../infrastructure/event-bus.js';
import type { ChangesetPlan, Changeset } from '@coderage-labs/armada-shared';
import type { ChangesetWithValidation } from './changeset-service.js';

// ── Concurrency constants ─────────────────────────────────────────────────

/**
 * Maximum number of instances that may be applied concurrently on the same node.
 * Instances on different nodes always run in parallel (unlimited cross-node).
 */
export const MAX_CONCURRENT_PER_NODE = 2;

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Extract the nodeId for an instanceOp from its step metadata.
 * Falls back to 'unknown' if no step has a nodeId (treated as a single group).
 */
function getInstanceNodeId(instanceOp: ChangesetPlan['instanceOps'][0]): string {
  const stepWithNode = instanceOp.steps.find(s => s.metadata?.nodeId);
  return stepWithNode?.metadata?.nodeId ?? 'unknown';
}

/**
 * Run a list of async tasks with a maximum concurrency limit.
 * Tasks are processed in order; a new task starts as soon as a slot frees up.
 */
async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  async function worker() {
    while (queue.length > 0) {
      const item = queue.shift()!;
      await fn(item); // errors are swallowed here — caller wraps in try/catch or tracks externally
    }
  }
  const workerCount = Math.min(concurrency, items.length);
  const workers: Promise<void>[] = [];
  for (let i = 0; i < workerCount; i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
}

/**
 * Execute an approved changeset.
 *
 * @param id          - Changeset ID to apply
 * @param opts        - Options (force skips staleness check, conflicts still block)
 * @param getChangeset - Injected getter to avoid circular import with changeset-service
 */
export async function applyChangeset(
  id: string,
  opts: { force?: boolean } | undefined,
  getChangeset: (id: string) => Changeset | null,
): Promise<ChangesetWithValidation> {
  const existing = getChangeset(id);
  if (!existing) throw new Error(`Changeset "${id}" not found`);
  if (existing.status !== 'approved') throw new Error(`Changeset "${id}" is not approved (current: ${existing.status})`);

  // Stale draft detection: reject if schema migrated since changeset was created
  if (existing.schemaVersion != null) {
    try {
      const { getDb } = await import('../db/index.js');
      const { getCurrentSchemaVersion } = await import('../db/migrations.js');
      const currentSchema = getCurrentSchemaVersion(getDb());
      if (currentSchema > existing.schemaVersion) {
        throw new Error(
          `Changeset "${id}" was created at schema v${existing.schemaVersion} but current schema is v${currentSchema}. ` +
          `Discard and recreate to pick up the new schema.`
        );
      }
    } catch (err: any) {
      if (err.message?.includes('was created at schema')) throw err;
      // non-fatal if we can't read schema version
    }
  }

  // Full validation before executing
  const validation = changesetValidator.validate(existing);

  // If force=true, ignore staleness but still block on errors
  const effectiveCanApply = opts?.force
    ? !validation.conflicts.some(c => c.type === 'error')
    : validation.canApply;

  if (!effectiveCanApply) {
    // Return the changeset with validation info — let the caller/UI decide
    return { ...existing, validation };
  }

  // Capture as const so TypeScript tracks non-nullability inside async closures
  const cs = existing;

  const now = new Date().toISOString();
  getDrizzle().update(changesets).set({
    status: 'applying',
    appliedAt: now,
  }).where(eq(changesets.id, id)).run();
  eventBus.emit('changeset.applying', { changesetId: id });

  const db = getDrizzle();
  const plan: ChangesetPlan = existing.plan;
  const currentVersion = configDiffService.getCurrentVersion();

  // ── Staleness note ──────────────────────────────────────────────────────
  // Global version-based staleness was removed — it caused every sequential
  // changeset to fail because each apply bumps the version. The validator's
  // inter-changeset conflict detection (validateInter) handles real conflicts
  // e.g. two changesets modifying the same entity or locked operations.

  // ── Use the locked plan steps from approval time ──────────────────────────
  // Do NOT call buildStepsForInstance() here — that would rebuild steps from
  // the current pending_mutations state (which may have changed since approval).
  // The approved plan already contains the exact steps the user reviewed.

  // THEN flush mutations to real DB (deletes pending_mutations, writes to agents/providers/models)
  // This must happen before step execution — push_config reads from agents table
  const { executed: mutationsExecuted, errors: mutationErrors } = executePendingMutations(id);
  if (mutationErrors.length > 0) {
    getDrizzle().update(changesets).set({
      status: 'failed',
      error: `Mutation errors: ${mutationErrors.join('; ')}`,
      completedAt: new Date().toISOString(),
    }).where(eq(changesets.id, id)).run();
    return getChangeset(id)! as ChangesetWithValidation;
  }
  if (mutationsExecuted > 0) {
    console.log(`[changeset] Flushed ${mutationsExecuted} pending mutations to DB`);
  }

  // ── Per-instance result tracking (for isolated failure handling) ──────────
  const instanceResults = new Map<string, { success: boolean; instanceName: string; error?: string }>();

  /**
   * Apply a single instanceOp. Errors are caught and recorded — they do NOT
   * propagate so that sibling instances (same or different node) can continue.
   */
  async function applyInstanceOp(instanceOp: ChangesetPlan['instanceOps'][0]): Promise<void> {
    const { instanceId, instanceName } = instanceOp;

    // Use the steps and deps locked at approval time — never rebuild from current state
    const steps = instanceOp.steps;
    const stepDeps = instanceOp.stepDeps ?? [];

    const opId = operationManager.create('changeset_apply', { instanceId, instanceName, changesetId: id }, {
      targetType: 'instance',
      targetId: instanceId,
      steps,
      stepDeps,
      createdBy: cs.createdBy,
    });

    // Link to changeset
    db.insert(changesetOperations).values({
      changesetId: id,
      operationId: opId,
      instanceId,
    }).run();

    // Execute the operation — errors are surfaced via op.status, not thrown
    try {
      await operationExecutor.execute(opId);
    } catch (err: any) {
      // Unexpected executor error — record and continue with other instances
      instanceResults.set(instanceId, {
        success: false,
        instanceName,
        error: err?.message ?? String(err),
      });
      return;
    }

    const op = operationManager.get(opId);
    if (op?.status === 'completed') {
      configDiffService.markApplied(instanceId, currentVersion);
      instanceResults.set(instanceId, { success: true, instanceName });
    } else {
      instanceResults.set(instanceId, {
        success: false,
        instanceName,
        error: op?.error ?? 'unknown error',
      });
    }
  }

  // ── Concurrent execution: unlimited across nodes, MAX_CONCURRENT_PER_NODE per node ──
  //
  // 1. Group instanceOps by the nodeId found in their step metadata.
  // 2. Each node group runs with a per-node concurrency cap (MAX_CONCURRENT_PER_NODE).
  // 3. All node groups execute in parallel — a slow node does not block a fast one.
  // 4. Per-instance isolation: applyInstanceOp never throws, so one instance's failure
  //    cannot prevent other instances (on any node) from completing.

  const byNode = new Map<string, ChangesetPlan['instanceOps']>();
  for (const instanceOp of plan.instanceOps) {
    const nodeId = getInstanceNodeId(instanceOp);
    if (!byNode.has(nodeId)) byNode.set(nodeId, []);
    byNode.get(nodeId)!.push(instanceOp);
  }

  await Promise.all(
    Array.from(byNode.values()).map(nodeOps =>
      runWithConcurrency(nodeOps, MAX_CONCURRENT_PER_NODE, applyInstanceOp),
    ),
  );

  // ── Collect results ───────────────────────────────────────────────────────
  const errors: string[] = [];
  for (const result of instanceResults.values()) {
    if (!result.success) {
      errors.push(`Instance ${result.instanceName}: ${result.error ?? 'unknown error'}`);
    }
  }
  const anyFailed = errors.length > 0;

  const completedAt = new Date().toISOString();
  if (anyFailed) {
    getDrizzle().update(changesets).set({
      status: 'failed',
      completedAt,
      error: errors.join('; '),
    }).where(eq(changesets.id, id)).run();
    eventBus.emit('changeset.failed', { changesetId: id, error: errors.join('; ') });
  } else {
    getDrizzle().update(changesets).set({
      status: 'completed',
      completedAt,
    }).where(eq(changesets.id, id)).run();
    eventBus.emit('changeset.completed', { changesetId: id });
  }

  return getChangeset(id)! as ChangesetWithValidation;
}

// ── Retry failed instances ────────────────────────────────────────────────

/**
 * Retry only the failed instance operations for a `failed` changeset.
 *
 * Successful instances are left untouched. If all retried instances succeed the
 * changeset status moves to `completed`; if any still fail it remains `failed`.
 */
export async function retryFailedInstances(
  id: string,
  getChangeset: (id: string) => Changeset | null,
  listChangesets: (limit: number) => Changeset[],
): Promise<ChangesetWithValidation> {
  const existing = getChangeset(id);
  if (!existing) throw new Error(`Changeset "${id}" not found`);
  if (existing.status !== 'failed') {
    throw new Error(`Changeset "${id}" is not in failed state (current: ${existing.status})`);
  }

  // Guard: block retry if there's an active (draft/approved/applying) changeset
  const allChangesets = listChangesets(50);
  const activeCs = allChangesets.find(cs =>
    cs.id !== id && ['draft', 'approved', 'applying'].includes(cs.status),
  );
  if (activeCs) {
    throw new Error(
      `Cannot retry: there is an active changeset (${activeCs.id.slice(0, 8)}… — ${activeCs.status}). ` +
      `Discard or complete it first.`
    );
  }

  // Guard: block retry if a newer completed changeset already covers the same instances
  const db = getDrizzle();
  const plan: ChangesetPlan = existing.plan;
  const failedInstanceIdsInPlan = new Set(plan.instanceOps.map(op => op.instanceId));

  const newerCompleted = allChangesets.find(cs =>
    cs.id !== id &&
    cs.status === 'completed' &&
    cs.completedAt && existing.completedAt &&
    cs.completedAt > existing.completedAt,
  );
  if (newerCompleted) {
    // Check if the newer changeset touched any of the same instances
    const newerOps = db
      .select()
      .from(changesetOperations)
      .where(eq(changesetOperations.changesetId, newerCompleted.id))
      .all();
    const newerInstanceIds = new Set(newerOps.map(o => o.instanceId));
    const overlap = [...failedInstanceIdsInPlan].filter(iid => newerInstanceIds.has(iid));
    if (overlap.length > 0) {
      throw new Error(
        `Cannot retry: a newer changeset (${newerCompleted.id.slice(0, 8)}…) has already been applied ` +
        `to the same instance(s). Discard this changeset and create a new one.`
      );
    }
  }

  // Schema version check — same guard as applyChangeset
  if (existing.schemaVersion != null) {
    try {
      const { getDb } = await import('../db/index.js');
      const { getCurrentSchemaVersion } = await import('../db/migrations.js');
      const currentSchema = getCurrentSchemaVersion(getDb());
      if (currentSchema > existing.schemaVersion) {
        throw new Error(
          `Changeset "${id}" was created at schema v${existing.schemaVersion} but current schema is v${currentSchema}. ` +
          `Discard and recreate to pick up the new schema.`
        );
      }
    } catch (err: any) {
      if (err.message?.includes('was created at schema')) throw err;
    }
  }

  const currentVersion = configDiffService.getCurrentVersion();

  // Find which instanceIds previously failed by inspecting their linked operations
  const linkedOps = db
    .select()
    .from(changesetOperations)
    .where(eq(changesetOperations.changesetId, id))
    .all();

  const failedInstanceIds = new Set<string>();
  for (const link of linkedOps) {
    const op = operationManager.get(link.operationId);
    if (op?.status === 'failed') {
      failedInstanceIds.add(link.instanceId);
    }
  }

  if (failedInstanceIds.size === 0) {
    // Nothing to retry — mark as completed since all ops apparently succeeded
    db.update(changesets).set({
      status: 'completed',
      completedAt: new Date().toISOString(),
      error: null,
    }).where(eq(changesets.id, id)).run();
    eventBus.emit('changeset.completed', { changesetId: id });
    return getChangeset(id)! as ChangesetWithValidation;
  }

  // Filter plan to only the failed instances, with FRESH steps (reset status)
  const failedInstanceOps = plan.instanceOps
    .filter(op => failedInstanceIds.has(op.instanceId))
    .map(op => ({
      ...op,
      // Reset all step statuses to pending so they execute fresh
      steps: op.steps.map(s => ({ ...s, status: 'pending' as const, error: undefined, startedAt: undefined, completedAt: undefined })),
    }));

  // Move back to 'applying' — this makes it the active changeset again
  const now = new Date().toISOString();
  db.update(changesets).set({ status: 'applying', appliedAt: now, error: null }).where(eq(changesets.id, id)).run();
  eventBus.emit('changeset.applying', { changesetId: id });

  const cs = existing;

  // Per-instance result tracking (same pattern as applyChangeset)
  const retryResults = new Map<string, { success: boolean; instanceName: string; error?: string }>();

  async function retryInstanceOp(instanceOp: ChangesetPlan['instanceOps'][0]): Promise<void> {
    const { instanceId, instanceName } = instanceOp;
    const steps = instanceOp.steps;
    const stepDeps = instanceOp.stepDeps ?? [];

    const opId = operationManager.create('changeset_apply', { instanceId, instanceName, changesetId: id }, {
      targetType: 'instance',
      targetId: instanceId,
      steps,
      stepDeps,
      createdBy: cs.createdBy,
    });

    db.insert(changesetOperations).values({
      changesetId: id,
      operationId: opId,
      instanceId,
    }).run();

    try {
      await operationExecutor.execute(opId);
    } catch (err: any) {
      retryResults.set(instanceId, {
        success: false,
        instanceName,
        error: err?.message ?? String(err),
      });
      return;
    }

    const op = operationManager.get(opId);
    if (op?.status === 'completed') {
      configDiffService.markApplied(instanceId, currentVersion);
      retryResults.set(instanceId, { success: true, instanceName });
    } else {
      retryResults.set(instanceId, {
        success: false,
        instanceName,
        error: op?.error ?? 'unknown error',
      });
    }
  }

  // Run with same node-aware concurrency as the original apply
  const byNode = new Map<string, ChangesetPlan['instanceOps']>();
  for (const instanceOp of failedInstanceOps) {
    const nodeId = getInstanceNodeId(instanceOp);
    if (!byNode.has(nodeId)) byNode.set(nodeId, []);
    byNode.get(nodeId)!.push(instanceOp);
  }

  await Promise.all(
    Array.from(byNode.values()).map(nodeOps =>
      runWithConcurrency(nodeOps, MAX_CONCURRENT_PER_NODE, retryInstanceOp),
    ),
  );

  // ── Update plan JSON with latest step statuses from retry operations ──
  // The UI reads `changeset.plan.instanceOps[].steps` — if we don't update
  // the plan, the old failed steps still show even after a successful retry.
  const retryLinkedOps = db
    .select()
    .from(changesetOperations)
    .where(eq(changesetOperations.changesetId, id))
    .all();

  // Build a map of instanceId → latest operation steps (most recently created)
  const latestStepsByInstance = new Map<string, typeof plan.instanceOps[0]['steps']>();
  for (const link of retryLinkedOps) {
    const op = operationManager.get(link.operationId);
    if (op && failedInstanceIds.has(link.instanceId)) {
      // Always overwrite — later operations are from the retry
      latestStepsByInstance.set(link.instanceId, op.steps);
    }
  }

  // Merge updated steps back into the plan
  const updatedPlan: ChangesetPlan = {
    ...plan,
    instanceOps: plan.instanceOps.map(iop => {
      const retrySteps = latestStepsByInstance.get(iop.instanceId);
      return retrySteps ? { ...iop, steps: retrySteps } : iop;
    }),
  };

  // Collect new errors
  const errors: string[] = [];
  for (const result of retryResults.values()) {
    if (!result.success) {
      errors.push(`Instance ${result.instanceName}: ${result.error ?? 'unknown error'}`);
    }
  }
  const anyFailed = errors.length > 0;

  const completedAt = new Date().toISOString();
  if (anyFailed) {
    db.update(changesets).set({
      status: 'failed',
      completedAt,
      error: errors.join('; '),
      planJson: JSON.stringify(updatedPlan),
    }).where(eq(changesets.id, id)).run();
    eventBus.emit('changeset.failed', { changesetId: id, error: errors.join('; ') });
  } else {
    db.update(changesets).set({
      status: 'completed',
      completedAt,
      error: null,
      planJson: JSON.stringify(updatedPlan),
    }).where(eq(changesets.id, id)).run();
    eventBus.emit('changeset.completed', { changesetId: id });
  }

  return getChangeset(id)! as ChangesetWithValidation;
}
