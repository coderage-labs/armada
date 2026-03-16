// ── Changeset Service — CloudFormation-style declarative state management ──

import crypto from 'node:crypto';
import { eq, desc, inArray } from 'drizzle-orm';
import { getDrizzle } from '../db/drizzle.js';
import { getDb } from '../db/index.js';
import { getCurrentSchemaVersion } from '../db/migrations.js';
import { changesets, changesetOperations } from '../db/drizzle-schema.js';
import { instancesRepo, pendingMutationRepo, templatesRepo } from '../repositories/index.js';
import { configDiffService } from './config-diff.js';
import { eventBus } from '../infrastructure/event-bus.js';
import { operationManager } from '../infrastructure/operations.js';
import { changesetValidator, type ChangesetValidationResult } from './changeset-validator.js';
import { applyChangeset, retryFailedInstances } from './changeset-apply.js';
import { computeMutationDiffs } from './diff-computer.js';
import { buildStepsForInstance, dagToSteps } from './step-planner.js';
import type { StateChange, ChangesetPlan, Changeset, ArmadaInstance } from '@coderage-labs/armada-shared';

// ── Types ────────────────────────────────────────────────────────────

export interface ChangesetPreview {
  changes: StateChange[];
  plan: ChangesetPlan;
}

export type ChangesetWithValidation = Changeset & { validation?: ChangesetValidationResult };

export interface ChangesetService {
  /** Preview what a changeset would look like (dry run) */
  preview(): ChangesetPreview;

  /** Create a changeset from current state diff */
  create(opts?: { createdBy?: string }): ChangesetWithValidation;

  /** Get a changeset by ID */
  get(id: string): Changeset | null;

  /** List changesets (most recent first) */
  list(limit?: number): Changeset[];

  /** Rebuild steps for a draft changeset (called after mutations are created) */
  rebuildSteps(changesetId: string): void;

  /** Approve a changeset */
  approve(id: string, approvedBy?: string): Changeset;

  /**
   * Apply (execute) a changeset.
   * @param opts.force - if true, skips the staleness check (conflicts still block)
   * Returns the changeset; if validation fails, includes the `validation` result and does NOT execute.
   */
  apply(id: string, opts?: { force?: boolean }): Promise<ChangesetWithValidation>;

  /** Retry failed instances of a failed changeset */
  retry(id: string): Promise<ChangesetWithValidation>;

  /** Cancel a changeset */
  cancel(id: string): Changeset;
}

// ── Helpers ──────────────────────────────────────────────────────────

type ChangesetRow = typeof changesets.$inferSelect;

function rowToChangeset(row: ChangesetRow): Changeset {
  return {
    id: row.id,
    status: row.status as Changeset['status'],
    changes: JSON.parse(row.changesJson),
    plan: JSON.parse(row.planJson),
    rollback: row.rollbackJson ? JSON.parse(row.rollbackJson) : undefined,
    createdBy: row.createdBy ?? undefined,
    createdAt: row.createdAt,
    approvedBy: row.approvedBy ?? undefined,
    approvedAt: row.approvedAt ?? undefined,
    appliedAt: row.appliedAt ?? undefined,
    completedAt: row.completedAt ?? undefined,
    error: row.error ?? undefined,
    schemaVersion: row.schemaVersion ?? undefined,
  };
}

// ── Implementation ───────────────────────────────────────────────────

/**
 * Scope global mutations to instances that actually use the changed entity.
 * Falls back to all running instances if scoping can't determine affected set.
 */
function findAffectedInstances(globalMutations: Array<{ entityType: string; entityId?: string | null; payload?: any }>): Array<{ id: string; name: string }> {
  const allRunning = instancesRepo.getAll().filter(i => i.status === 'running');
  if (allRunning.length === 0) return [];

  // Build a map: templateId → instances
  const templateInstances = new Map<string, typeof allRunning>();
  for (const inst of allRunning) {
    const tid = inst.templateId;
    if (tid) {
      const list = templateInstances.get(tid) || [];
      list.push(inst);
      templateInstances.set(tid, list);
    }
  }

  // Load all templates once
  const allTemplates = templatesRepo.getAll();
  const templateById = new Map(allTemplates.map(t => [t.id, t]));

  const affected = new Set<string>();

  for (const m of globalMutations) {
    const entityName = m.payload?.name || m.entityId;

    if (m.entityType === 'model') {
      // Find templates that reference this model
      for (const [tid, template] of templateById) {
        const usesModel = template.model === entityName ||
          (template.models || []).some((mod: any) => mod.name === entityName || mod.model === entityName);
        if (usesModel) {
          for (const inst of templateInstances.get(tid) || []) affected.add(inst.id);
        }
      }
    } else if (m.entityType === 'provider' || m.entityType === 'api_key') {
      // Provider/key changes could affect any instance using models from that provider
      // Scoping precisely requires knowing which models use which provider — fall back to all
      for (const inst of allRunning) affected.add(inst.id);
    } else if (m.entityType === 'plugin') {
      // Find templates that list this plugin
      const pluginName = m.payload?.name || m.payload?.npmPkg || m.entityId;
      for (const [tid, template] of templateById) {
        const usesPlugin = (template.pluginsList || []).some((p: any) => p.name === pluginName || p.npmPkg === pluginName);
        if (usesPlugin) {
          for (const inst of templateInstances.get(tid) || []) affected.add(inst.id);
        }
      }
    }
  }

  // If scoping found nothing but we have global mutations, fall back to all running
  if (affected.size === 0 && globalMutations.length > 0) {
    for (const inst of allRunning) affected.add(inst.id);
  }

  return allRunning.filter(i => affected.has(i.id));
}

export function createChangesetService(): ChangesetService {

  function preview(): ChangesetPreview {
    const currentVersion = configDiffService.getCurrentVersion();

    // Discover target instances purely from pending mutations
    const instanceMap = new Map<string, { instanceId: string; instanceName: string }>();
    const allMutations = pendingMutationRepo.getAll();

    // Global mutations scoped to affected instances (not all running)
    const globalMutations = allMutations.filter(m =>
      ['provider', 'model', 'api_key', 'plugin'].includes(m.entityType));
    if (globalMutations.length > 0) {
      const affected = findAffectedInstances(globalMutations);
      for (const inst of affected) {
        instanceMap.set(inst.id, { instanceId: inst.id, instanceName: inst.name });
      }
    }

    // Instance-specific mutations (create, delete, update)
    for (const m of allMutations.filter(m => m.entityType === 'instance' && m.entityId)) {
      const inst = instancesRepo.getById(m.entityId!);
      if (inst && !instanceMap.has(inst.id)) {
        instanceMap.set(inst.id, { instanceId: inst.id, instanceName: inst.name });
      } else if (!inst && m.action === 'create' && m.payload) {
        // New instance not yet committed — use data from the mutation payload
        const id = m.entityId!;
        if (!instanceMap.has(id)) {
          instanceMap.set(id, { instanceId: id, instanceName: m.payload.name || id });
        }
      }
    }

    // Agent mutations — find which instance they belong to
    for (const m of allMutations.filter(m => m.entityType === 'agent')) {
      const instanceId = m.payload?.instanceId;
      if (instanceId) {
        const inst = instancesRepo.getById(instanceId);
        if (inst && !instanceMap.has(inst.id)) {
          instanceMap.set(inst.id, { instanceId: inst.id, instanceName: inst.name });
        } else if (!inst && !instanceMap.has(instanceId)) {
          // Instance may be a pending create — check if there's a mutation for it
          const instMutation = allMutations.find(
            im => im.entityType === 'instance' && im.entityId === instanceId && im.action === 'create'
          );
          if (instMutation) {
            instanceMap.set(instanceId, { instanceId, instanceName: instMutation.payload?.name || instanceId });
          }
        }
      }
    }

    const targetInstances = Array.from(instanceMap.values());

    // Global changes = snapshot diff between "empty" prior and current state
    // The actual changes are the global config diff for any instance that needs updating
    const currentSnapshot = configDiffService.snapshot();

    // Build the plan
    const instanceOps = targetInstances.map(inst => {
      const dag = buildStepsForInstance(inst.instanceId, currentVersion);
      const steps = dagToSteps(dag);
      // Each stale instance gets the full set of global changes
      const instChanges: StateChange[] = currentSnapshot.providers.length > 0 ||
        currentSnapshot.models.length > 0 ||
        currentSnapshot.plugins.length > 0
        ? [
            {
              instanceId: inst.instanceId,
              type: 'config' as const,
              field: 'config_version',
              current: null,
              desired: currentVersion,
              requiresRestart: true,
            },
          ]
        : [
            {
              instanceId: inst.instanceId,
              type: 'config' as const,
              field: 'config_version',
              current: null,
              desired: currentVersion,
              requiresRestart: true,
            },
          ];

      return {
        instanceId: inst.instanceId,
        instanceName: inst.instanceName,
        changes: instChanges,
        steps,
        stepDeps: dag.deps,
        estimatedDowntime: 5, // ~5s per restart
      };
    });

    // Filter out instances with no actual steps (unaffected by this changeset)
    const activeOps = instanceOps.filter(op => op.steps.length > 0);
    const totalChanges = activeOps.reduce((acc, op) => acc + op.changes.length, 0);

    const plan: ChangesetPlan = {
      instanceOps: activeOps,
      order: 'sequential',
      concurrency: 1,
      totalInstances: activeOps.length,
      totalChanges,
      totalRestarts: activeOps.filter(op => op.steps.some(s => s.name === 'restart_gateway')).length,
      estimatedDuration: activeOps.length * 15, // ~15s per instance
    };

    // Global changes (platform-level diff, not per-instance)
    const changes: StateChange[] = targetInstances.map(inst => ({
      instanceId: inst.instanceId,
      type: 'config' as const,
      field: 'config_version',
      current: null,
      desired: currentVersion,
      requiresRestart: true,
    }));

    return { changes, plan };
  }

  function create(opts?: { createdBy?: string }): ChangesetWithValidation {
    const { changes, plan } = preview();

    if (changes.length === 0) {
      throw new Error('No pending changes');
    }

    // Validate intra-changeset conflicts (warnings only at creation time)
    const intraConflicts = changesetValidator.validateIntra(changes);

    // Capture rollback snapshot
    const rollback = configDiffService.snapshot();

    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    // Stamp with current schema version for stale draft detection after migrations
    let schemaVersion: number | null = null;
    try {
      schemaVersion = getCurrentSchemaVersion(getDb());
    } catch { /* non-fatal */ }

    getDrizzle().insert(changesets).values({
      id,
      status: 'draft',
      changesJson: JSON.stringify(changes),
      planJson: JSON.stringify(plan),
      rollbackJson: JSON.stringify(rollback),
      createdBy: opts?.createdBy ?? null,
      createdAt: now,
      schemaVersion,
    }).run();

    const changeset = get(id)!;

    // Attach warnings to result (informational — does not block creation)
    if (intraConflicts.length > 0) {
      return {
        ...changeset,
        validation: {
          conflicts: intraConflicts,
          staleness: { stale: false, drift: [] },
          canApply: !intraConflicts.some(c => c.type === 'error'),
        },
      };
    }

    return changeset;
  }

  function get(id: string): Changeset | null {
    const row = getDrizzle().select().from(changesets).where(eq(changesets.id, id)).get();
    if (!row) return null;
    const cs = rowToChangeset(row);

    // Overlay actual operation step status onto the plan
    if (cs.plan?.instanceOps?.length) {
      const opLinks = getDrizzle().select().from(changesetOperations).where(eq(changesetOperations.changesetId, id)).all();
      for (const link of opLinks) {
        const op = operationManager.get(link.operationId);
        if (!op?.steps?.length) continue;

        // Find the matching instanceOp in the plan
        const instanceOp = cs.plan.instanceOps.find((io: any) => io.instanceId === link.instanceId);
        if (!instanceOp?.steps?.length) continue;

        // Overlay step status from the operation (match by name, not ID — 
        // plan and operation generate separate UUIDs for their steps)
        for (const opStep of op.steps) {
          const planStep = instanceOp.steps.find((s: any) => s.name === opStep.name);
          if (planStep) {
            planStep.status = opStep.status;
            if (opStep.startedAt) planStep.startedAt = opStep.startedAt;
            if (opStep.completedAt) planStep.completedAt = opStep.completedAt;
            if (opStep.error) planStep.error = opStep.error;
          }
        }
      }
    }

    return cs;
  }

  function list(limit = 20): Changeset[] {
    // Fetch all changeset rows in a single query
    const rows = getDrizzle()
      .select()
      .from(changesets)
      .orderBy(desc(changesets.createdAt))
      .limit(limit)
      .all();

    if (rows.length === 0) return [];

    // Convert rows → Changeset objects (no DB calls)
    const changesetList = rows.map(rowToChangeset);

    // Batch-fetch ALL operation links for these changesets in ONE query
    const ids = rows.map(r => r.id);
    const allOpLinks = getDrizzle()
      .select()
      .from(changesetOperations)
      .where(inArray(changesetOperations.changesetId, ids))
      .all();

    // Group links by changesetId for O(1) lookup
    const linksByChangesetId = new Map<string, typeof allOpLinks>();
    for (const link of allOpLinks) {
      let bucket = linksByChangesetId.get(link.changesetId);
      if (!bucket) {
        bucket = [];
        linksByChangesetId.set(link.changesetId, bucket);
      }
      bucket.push(link);
    }

    // Overlay operation step status in memory — same logic as get(), no extra DB queries
    for (const cs of changesetList) {
      if (!cs.plan?.instanceOps?.length) continue;

      const opLinks = linksByChangesetId.get(cs.id);
      if (!opLinks?.length) continue;

      for (const link of opLinks) {
        const op = operationManager.get(link.operationId);
        if (!op?.steps?.length) continue;

        const instanceOp = cs.plan.instanceOps.find((io: any) => io.instanceId === link.instanceId);
        if (!instanceOp?.steps?.length) continue;

        for (const opStep of op.steps) {
          const planStep = instanceOp.steps.find((s: any) => s.name === opStep.name);
          if (planStep) {
            planStep.status = opStep.status;
            if (opStep.startedAt) planStep.startedAt = opStep.startedAt;
            if (opStep.completedAt) planStep.completedAt = opStep.completedAt;
            if (opStep.error) planStep.error = opStep.error;
          }
        }
      }
    }

    return changesetList;
  }

  function rebuildSteps(changesetId: string): void {
    const existing = get(changesetId);
    if (!existing || existing.status !== 'draft') {
        return;
    }

    const currentVersion = configDiffService.getCurrentVersion();

    // Rebuild target instances purely from pending mutations
    const instanceMap = new Map<string, { instanceId: string; instanceName: string }>();
    const allMutations = pendingMutationRepo.getAll();

    const globalMutations = allMutations.filter(m =>
      ['provider', 'model', 'api_key', 'plugin'].includes(m.entityType));
    if (globalMutations.length > 0) {
      const affected = findAffectedInstances(globalMutations);
      for (const inst of affected) {
        instanceMap.set(inst.id, { instanceId: inst.id, instanceName: inst.name });
      }
    }

    for (const m of allMutations.filter(m => m.entityType === 'instance' && m.entityId)) {
      const inst = instancesRepo.getById(m.entityId!);
      if (inst && !instanceMap.has(inst.id)) {
        instanceMap.set(inst.id, { instanceId: inst.id, instanceName: inst.name });
      } else if (!inst && m.action === 'create' && m.payload) {
        // New instance not yet committed — use data from the mutation payload
        const id = m.entityId!;
        if (!instanceMap.has(id)) {
          instanceMap.set(id, { instanceId: id, instanceName: m.payload.name || id });
        }
      }
    }

    for (const m of allMutations.filter(m => m.entityType === 'agent' && m.payload?.instanceId)) {
      const inst = instancesRepo.getById(m.payload.instanceId);
      if (inst && !instanceMap.has(inst.id)) {
        instanceMap.set(inst.id, { instanceId: inst.id, instanceName: inst.name });
      }
    }

    const rebuiltOps = Array.from(instanceMap.values()).map(target => {
      const dag = buildStepsForInstance(target.instanceId, currentVersion);
      const steps = dagToSteps(dag);
      return {
        instanceId: target.instanceId,
        instanceName: target.instanceName,
        changes: steps.length > 0 ? [{
          instanceId: target.instanceId,
          type: 'config' as const,
          field: 'config_version',
          current: null,
          desired: currentVersion,
          requiresRestart: true,
        }] : [],
        steps,
        stepDeps: dag.deps,
        estimatedDowntime: 5,
      };
    }).filter(op => op.steps.length > 0);

    const mutations = pendingMutationRepo.getByChangeset(changesetId);
    const diffs = computeMutationDiffs(mutations);

    const updatedPlan: ChangesetPlan = {
      ...existing.plan,
      instanceOps: rebuiltOps,
      totalInstances: rebuiltOps.length,
      totalChanges: rebuiltOps.reduce((acc, op) => acc + op.changes.length, 0),
      totalRestarts: rebuiltOps.filter(op => op.steps.some(s => s.name === 'restart_gateway')).length,
      diffs,
    };

    getDrizzle().update(changesets).set({
      planJson: JSON.stringify(updatedPlan),
    }).where(eq(changesets.id, changesetId)).run();
  }

  function approve(id: string, approvedBy?: string): Changeset {
    const existing = get(id);
    if (!existing) throw new Error(`Changeset "${id}" not found`);
    if (existing.status !== 'draft') throw new Error(`Changeset "${id}" is not in draft status (current: ${existing.status})`);

    // Rebuild steps and snapshot diffs at approve time — mutations exist now.
    // The resulting plan is LOCKED: apply() will use these steps verbatim.
    const currentVersion = configDiffService.getCurrentVersion();
    const rebuiltOps = existing.plan.instanceOps.map(op => {
      const dag = buildStepsForInstance(op.instanceId, currentVersion);
      return { ...op, steps: dagToSteps(dag), stepDeps: dag.deps };
    }).filter(op => op.steps.length > 0);
    const mutations = pendingMutationRepo.getByChangeset(id);
    const diffs = computeMutationDiffs(mutations);
    const updatedPlan: ChangesetPlan = {
      ...existing.plan,
      instanceOps: rebuiltOps,
      diffs,
      totalRestarts: rebuiltOps.filter(op => op.steps.some(s => s.name === 'restart_gateway')).length,
      // Lock the config version at approval time so apply() can detect drift
      approvedConfigVersion: currentVersion,
    };

    const now = new Date().toISOString();
    getDrizzle().update(changesets).set({
      status: 'approved',
      approvedBy: approvedBy ?? null,
      approvedAt: now,
      planJson: JSON.stringify(updatedPlan),
    }).where(eq(changesets.id, id)).run();

    return get(id)!;
  }

  async function apply(id: string, opts?: { force?: boolean }): Promise<ChangesetWithValidation> {
    return applyChangeset(id, opts, get);
  }

  async function retry(id: string): Promise<ChangesetWithValidation> {
    return retryFailedInstances(id, get, list);
  }

  function cancel(id: string): Changeset {
    const existing = get(id);
    if (!existing) throw new Error(`Changeset "${id}" not found`);
    if (existing.status !== 'draft' && existing.status !== 'approved' && existing.status !== 'failed') {
      throw new Error(`Changeset "${id}" cannot be cancelled (current status: ${existing.status})`);
    }

    // Restore any instances that were staged for deletion back to their previous status
    const changesetMutations = pendingMutationRepo.getByChangeset(id);
    const instanceDeleteMutations = changesetMutations.filter(
      m => m.entityType === 'instance' && m.action === 'delete' && m.entityId,
    );
    for (const m of instanceDeleteMutations) {
      const prevStatus = (m.payload.previousStatus as ArmadaInstance['status']) ?? 'stopped';
      instancesRepo.update(m.entityId!, { status: prevStatus });
      console.log(`[changeset] Restored instance ${m.entityId} status to '${prevStatus}' after changeset cancel`);
    }

    // Delete any instances that were staged for creation — they are 'pending' orphans with no container
    const instanceCreateMutations = changesetMutations.filter(
      m => m.entityType === 'instance' && m.action === 'create' && m.entityId,
    );
    for (const m of instanceCreateMutations) {
      instancesRepo.remove(m.entityId!);
      console.log(`[changeset] Deleted orphaned pending instance ${m.entityId} after changeset cancel`);
    }

    // Clean up pending mutations — nothing was applied, so discard them
    const removed = pendingMutationRepo.removeByChangeset(id);
    if (removed > 0) {
      console.log(`[changeset] Discarded ${removed} pending mutation(s) for cancelled changeset ${id}`);
    }

    getDrizzle().update(changesets).set({
      status: 'cancelled',
    }).where(eq(changesets.id, id)).run();

    eventBus.emit('changeset.discarded', { changesetId: id, mutationsRemoved: removed });

    return get(id)!;
  }

  return { preview, create, get, list, rebuildSteps, approve, apply, retry, cancel } as ChangesetService;
}

/** Singleton changeset service */
export const changesetService = createChangesetService();

/**
 * Single owner for draft changeset creation.
 *
 * Both `mutationService` and `workingCopy` need a draft changeset to attach
 * pending changes to.  Having two independent "check-then-create" code paths
 * is architecturally fragile even when it appears safe, so all creation is
 * centralised here.
 *
 * Safety note: Node.js is single-threaded and every SQLite call used by this
 * package is synchronous (better-sqlite3), so no true data-race can occur
 * between the two callers.  This function still acts as the *single point of
 * creation* to make the invariant explicit and to protect against regressions
 * if either caller is ever made asynchronous.
 *
 * @param createdBy - label stored on the row for observability
 * @returns the existing or newly-created draft, or null when there are no
 *          pending changes yet (e.g. system mutations targeting zero instances)
 */
export function getOrCreateDraftChangeset(createdBy: string): import('@coderage-labs/armada-shared').Changeset | null {
  const existing = changesetService.list(20).find(c => c.status === 'draft');
  if (existing) return existing;

  try {
    return changesetService.create({ createdBy });
  } catch (err: any) {
    if (err.message?.includes('No pending changes')) return null;
    throw err;
  }
}
