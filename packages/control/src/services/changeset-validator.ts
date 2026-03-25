// ── Changeset Validator — conflict detection and staleness checks ──

import type { ConflictCheck, StalenessCheck, StateChange, Changeset } from '@coderage-labs/armada-shared';
import { lockManager } from '../infrastructure/lock-manager.js';
import { configDiffService } from './config-diff.js';
import { getDrizzle } from '../db/drizzle.js';
import { changesets } from '../db/drizzle-schema.js';
import { inArray } from 'drizzle-orm';

// ── Types ────────────────────────────────────────────────────────────

export interface ChangesetValidationResult {
  conflicts: ConflictCheck[];
  staleness: StalenessCheck;
  canApply: boolean;
}

export interface ChangesetValidator {
  /**
   * Validate a changeset for internal conflicts.
   * Called at creation time.
   */
  validateIntra(changes: StateChange[]): ConflictCheck[];

  /**
   * Validate against active operations/changesets.
   * Called at apply time.
   */
  validateInter(changesetId: string, changes: StateChange[]): ConflictCheck[];

  /**
   * Check if a changeset is stale (state changed since it was planned).
   * Called at apply time.
   */
  checkStaleness(changeset: Changeset): StalenessCheck;

  /**
   * Full validation — runs all checks.
   */
  validate(changeset: Changeset): ChangesetValidationResult;
}

// ── Implementation ───────────────────────────────────────────────────

function createChangesetValidator(): ChangesetValidator {

  /**
   * Check for conflicts within a single changeset:
   * - modify + delete on the same instance
   * - duplicate targets (same instanceId + field)
   */
  function validateIntra(changes: StateChange[]): ConflictCheck[] {
    const conflicts: ConflictCheck[] = [];

    // Group indices by instanceId
    const byInstance = new Map<string, number[]>();
    for (let i = 0; i < changes.length; i++) {
      const { instanceId } = changes[i];
      if (!byInstance.has(instanceId)) byInstance.set(instanceId, []);
      byInstance.get(instanceId)!.push(i);
    }

    for (const [instanceId, indices] of byInstance) {
      // Check for modify + delete on same target
      // A "delete" change is one where desired === null
      const deleteIndices = indices.filter(i => changes[i].desired === null);
      const modifyIndices = indices.filter(i => changes[i].desired !== null);

      if (deleteIndices.length > 0 && modifyIndices.length > 0) {
        conflicts.push({
          type: 'error',
          code: 'MODIFY_DELETED_INSTANCE',
          message: `Instance "${instanceId}" has both modify and delete changes in the same changeset`,
          changeIndices: [...deleteIndices, ...modifyIndices],
          resolution: 'Remove either the modify or delete change for this instance',
        });
      }

      // Check for duplicate targets (same instanceId + type + field)
      const byField = new Map<string, number[]>();
      for (const i of indices) {
        const key = `${changes[i].type}:${changes[i].field}`;
        if (!byField.has(key)) byField.set(key, []);
        byField.get(key)!.push(i);
      }
      for (const [field, fieldIndices] of byField) {
        if (fieldIndices.length > 1) {
          conflicts.push({
            type: 'warning',
            code: 'DUPLICATE_TARGET',
            message: `Instance "${instanceId}" has ${fieldIndices.length} duplicate changes for field "${field}"`,
            changeIndices: fieldIndices,
            resolution: 'Merge duplicate changes into a single change',
          });
        }
      }
    }

    return conflicts;
  }

  /**
   * Check for conflicts against active operations and other changesets:
   * - global lock active
   * - target instance is locked by another operation
   * - overlapping draft/approved/applying changesets
   */
  function validateInter(changesetId: string, changes: StateChange[]): ConflictCheck[] {
    const conflicts: ConflictCheck[] = [];

    // Check global lock first
    if (lockManager.isGlobalLocked()) {
      conflicts.push({
        type: 'error',
        code: 'GLOBAL_LOCK',
        message: 'A global lock is active — another operation is in progress',
        changeIndices: changes.map((_, i) => i),
        resolution: 'Wait for the active global operation to complete before applying this changeset',
      });
      return conflicts; // No point checking individual locks
    }

    // Check per-instance locks
    const activeLocks = lockManager.getAll();
    const lockMap = new Map<string, string>(); // `${targetType}:${targetId}` -> operationId
    for (const lock of activeLocks) {
      lockMap.set(`${lock.targetType}:${lock.targetId}`, lock.operationId);
    }

    const checkedInstances = new Set<string>();
    for (let i = 0; i < changes.length; i++) {
      const { instanceId } = changes[i];
      if (checkedInstances.has(instanceId)) continue;
      checkedInstances.add(instanceId);

      const instanceLock = lockMap.get(`instance:${instanceId}`);
      if (instanceLock) {
        const affectedIndices = changes
          .map((c, idx) => ({ c, idx }))
          .filter(({ c }) => c.instanceId === instanceId)
          .map(({ idx }) => idx);

        conflicts.push({
          type: 'error',
          code: 'LOCKED_TARGET',
          message: `Instance "${instanceId}" is locked by operation "${instanceLock}"`,
          changeIndices: affectedIndices,
          resolution: `Wait for operation "${instanceLock}" to complete`,
        });
      }
    }

    // Check for overlapping draft/approved/applying changesets
    const instanceIds = [...new Set(changes.map(c => c.instanceId))];
    if (instanceIds.length === 0) return conflicts;

    const db = getDrizzle();
    const activeChangesets = db
      .select()
      .from(changesets)
      .where(inArray(changesets.status, ['draft', 'approved', 'applying']))
      .all();

    for (const other of activeChangesets) {
      if (other.id === changesetId) continue;

      const otherChanges: StateChange[] = JSON.parse(other.changesJson);
      const otherInstanceIds = new Set(otherChanges.map(c => c.instanceId));

      const overlappingMyIndices = changes
        .map((c, idx) => ({ c, idx }))
        .filter(({ c }) => otherInstanceIds.has(c.instanceId))
        .map(({ idx }) => idx);

      if (overlappingMyIndices.length > 0) {
        conflicts.push({
          type: 'error',
          code: 'OVERLAPPING_CHANGESET',
          message: `Changeset "${other.id}" (status: ${other.status}) affects the same instances`,
          changeIndices: overlappingMyIndices,
          resolution: `Cancel or complete changeset "${other.id}" before applying this one`,
        });
      }
    }

    return conflicts;
  }

  /**
   * Check if the state has drifted since the changeset was planned.
   * Compares the rollback snapshot (captured at create time) to the current snapshot.
   */
  function checkStaleness(changeset: Changeset): StalenessCheck {
    const rollbackSnapshot = changeset.rollback;
    if (!rollbackSnapshot) {
      return { stale: false, drift: [] };
    }

    const currentSnapshot = configDiffService.snapshot();
    const drift: StateChange[] = [];

    // Compare providers
    const rollbackProviders = JSON.stringify(rollbackSnapshot.providers ?? []);
    const currentProviders = JSON.stringify(currentSnapshot.providers);
    if (rollbackProviders !== currentProviders) {
      drift.push({
        instanceId: 'armada',
        type: 'model',
        field: 'providers',
        current: rollbackSnapshot.providers ?? [],
        desired: currentSnapshot.providers,
        requiresRestart: false,
      });
    }

    // Compare models
    const rollbackModels = JSON.stringify(rollbackSnapshot.models ?? []);
    const currentModels = JSON.stringify(currentSnapshot.models);
    if (rollbackModels !== currentModels) {
      drift.push({
        instanceId: 'armada',
        type: 'model',
        field: 'models',
        current: rollbackSnapshot.models ?? [],
        desired: currentSnapshot.models,
        requiresRestart: false,
      });
    }

    // Compare plugins
    const rollbackPlugins = JSON.stringify(rollbackSnapshot.plugins ?? []);
    const currentPlugins = JSON.stringify(currentSnapshot.plugins);
    if (rollbackPlugins !== currentPlugins) {
      drift.push({
        instanceId: 'armada',
        type: 'plugin',
        field: 'plugins',
        current: rollbackSnapshot.plugins ?? [],
        desired: currentSnapshot.plugins,
        requiresRestart: false,
      });
    }

    // Version-only drift is NOT considered stale — sequential changesets
    // always bump the version. Only actual entity drift matters.
    const stale = drift.length > 0;

    return {
      stale,
      reason: stale
        ? `State has changed since changeset was planned (snapshot v${rollbackSnapshot.version} → current v${currentSnapshot.version})`
        : undefined,
      drift,
    };
  }

  /**
   * Full validation — runs intra, inter, and staleness checks.
   * canApply = no errors (warnings are ok) AND not stale.
   */
  function validate(changeset: Changeset): ChangesetValidationResult {
    const intraConflicts = validateIntra(changeset.changes);
    const interConflicts = validateInter(changeset.id, changeset.changes);
    const staleness = checkStaleness(changeset);

    const conflicts = [...intraConflicts, ...interConflicts];
    const hasErrors = conflicts.some(c => c.type === 'error');

    // File-only changesets (no config_version bumps) are immune to staleness
    // They only write workspace files and update DB — no config drift to worry about
    const hasConfigVersionChange = changeset.changes.some(c => 
      c.type === 'config' && c.field === 'config_version'
    );
    
    // Agent-only changesets (no config/provider/model/plugin/instance changes)
    // are also immune to staleness — they don't conflict with config version drift
    const agentOnlyTypes = new Set(['agent']);
    const isAgentOnly = changeset.changes.every(c => agentOnlyTypes.has(c.type));
    
    // Skip staleness check if:
    // - No config_version change (file-only changeset)
    // - Agent-only changeset
    const canApply = !hasErrors && (!hasConfigVersionChange || isAgentOnly || !staleness.stale);

    return { conflicts, staleness, canApply };
  }

  return { validateIntra, validateInter, checkStaleness, validate };
}

/** Singleton validator */
export const changesetValidator = createChangesetValidator();

// Export factory for testing
export { createChangesetValidator };
