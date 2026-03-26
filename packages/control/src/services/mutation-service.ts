/**
 * MutationService — intercepts mutations and stages them as pending
 * changes attached to a draft changeset instead of writing directly to the DB.
 */

import { pendingMutationRepo, agentsRepo, modelRegistryRepo, modelProviderRepo, providerApiKeyRepo, templatesRepo, instancesRepo, pluginsRepo } from '../repositories/index.js';
import type { PendingMutation } from '../repositories/index.js';
import { changesetService, getOrCreateDraftChangeset } from './changeset-service.js';
import { eventBus } from '../infrastructure/event-bus.js';
import type { Changeset } from '@coderage-labs/armada-shared';

// ── Types ──────────────────────────────────────────────────────────

export type EntityType = 'agent' | 'provider' | 'api_key' | 'model' | 'plugin' | 'template' | 'instance';

export interface MutationService {
  /** Stage a mutation — attaches to current draft changeset (creates one if needed) */
  stage(
    entityType: EntityType,
    action: 'create' | 'update' | 'delete',
    payload: Record<string, any>,
    entityId?: string,
  ): PendingMutation;

  /** Get or create the current draft changeset */
  getOrCreateDraft(): Changeset;

  /** Get all pending mutations */
  getPending(): PendingMutation[];

  /** Get pending mutations for an entity type */
  getPendingForEntity(entityType: EntityType, entityId?: string): PendingMutation[];

  /** Check if there are any pending mutations */
  hasPending(): boolean;
}

// ── Implementation ─────────────────────────────────────────────────

// ── No-op detection ────────────────────────────────────────────────

function resolveEntity(entityType: EntityType, entityId: string): Record<string, any> | null {
  switch (entityType) {
    case 'agent': return agentsRepo.getById(entityId) ?? agentsRepo.getAll().find(a => a.name === entityId) ?? null;
    case 'provider': return modelProviderRepo.getById(entityId) ?? null;
    case 'api_key': return providerApiKeyRepo.getById(entityId) ?? null;
    case 'model': return modelRegistryRepo.getById(entityId) ?? null;
    case 'template': return templatesRepo.getById(entityId) ?? null;
    case 'instance': return instancesRepo.getById(entityId) ?? null;
    case 'plugin': return pluginsRepo.getById(entityId) ?? null;
    default: return null;
  }
}

/** Check if every field in payload matches the committed entity value */
function isNoOp(committed: Record<string, any>, payload: Record<string, any>): boolean {
  for (const [key, value] of Object.entries(payload)) {
    const committedValue = committed[key];
    // Loose comparison to handle 0/false, 1/true, null/undefined
    if (JSON.stringify(committedValue) !== JSON.stringify(value)) {
      return false;
    }
  }
  return true;
}

/** If a changeset has zero mutations remaining, auto-discard it */
function cleanupEmptyChangesets(): void {
  const drafts = changesetService.list(20).filter(c => c.status === 'draft');
  for (const draft of drafts) {
    const mutations = pendingMutationRepo.getByChangeset(draft.id);
    if (mutations.length === 0) {
      try {
        changesetService.cancel(draft.id);
      } catch (err: any) {
        console.warn('[mutation-service] Failed to auto-discard empty changeset:', err.message);
      }
    }
  }
}

function createMutationService(): MutationService {

  function getOrCreateDraft(): Changeset {
    // Delegate to the single shared owner for draft creation — see
    // getOrCreateDraftChangeset() in changeset-service.ts for the full
    // rationale.  This function is kept for backwards-compatibility with
    // callers outside stage() that still reference it on the service interface.
    return getOrCreateDraftChangeset('mutation-service') as Changeset;
  }

  function stage(
    entityType: EntityType,
    action: 'create' | 'update' | 'delete',
    payload: Record<string, any>,
    entityId?: string,
  ): PendingMutation {
    // Remove any existing mutations for the same entity — last action wins
    if (entityId) {
      const existing = pendingMutationRepo.getAll()
        .filter(m => m.entityType === entityType && m.entityId === entityId);
      for (const m of existing) {
        pendingMutationRepo.removeById(m.id);
      }
    }

    // For updates: check if payload matches committed state — if so, it's a no-op
    if (action === 'update' && entityId) {
      const committed = resolveEntity(entityType, entityId);
      if (committed && isNoOp(committed, payload)) {
        // Mutation would result in no change — clean up empty changesets and notify UI
        cleanupEmptyChangesets();
        eventBus.emit('mutation.staged', { entityType, action: 'noop', entityId });
        return { id: 'noop', changesetId: '', entityType, entityId, action, payload, instanceId: null, createdAt: new Date().toISOString() } as PendingMutation;
      }
    }

    // Derive instanceId for agent mutations so getByInstance() can use the proper column (#445)
    const instanceId = entityType === 'agent' ? (payload.instanceId ?? null) : null;

    // 1. Get or create draft changeset FIRST
    const changeset = getOrCreateDraft();
    const changesetId = changeset?.id ?? 'pending';

    // 2. Write mutation to DB, linked to the draft changeset
    // This prevents orphaned mutations during the create flow (#237)
    const mutation = pendingMutationRepo.create({
      changesetId,
      entityType,
      entityId: entityId ?? null,
      action,
      payload,
      instanceId,
    });

    // 3. Rebuild draft changeset steps
    if (changesetId !== 'pending') {
      try {
        changesetService.rebuildSteps(changesetId);
      } catch (err: any) {
        console.warn('[mutation-service] rebuildSteps failed:', err.message);
      }
    }

    // 4. Emit AFTER everything is consistent — DB, changeset, steps all ready
    eventBus.emit('mutation.staged', { entityType, action, entityId, changesetId });

    return mutation;
  }

  function getPending(): PendingMutation[] {
    return pendingMutationRepo.getAll();
  }

  function getPendingForEntity(entityType: EntityType, entityId?: string): PendingMutation[] {
    return pendingMutationRepo.getByEntity(entityType, entityId);
  }

  function hasPending(): boolean {
    return pendingMutationRepo.getAll().length > 0;
  }

  return { stage, getOrCreateDraft, getPending, getPendingForEntity, hasPending };
}

/** Singleton mutation service */
export const mutationService = createMutationService();

/** Exported for use in routes that remove mutations directly */
export { cleanupEmptyChangesets };
