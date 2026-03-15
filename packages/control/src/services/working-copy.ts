/**
 * Working Copy — Shadow Data Layer
 *
 * Maintains an in-memory shadow of entity state that diverges from the committed DB.
 * All pending changes live here. The diff between committed and working copy IS the
 * pending mutation state. Discarding = clearing the working copy. Applying = writing
 * the working copy diff to the DB.
 *
 * Understands entity relationships (parent-child, mutex flags, cascade deletes).
 */

import {
  modelProviderRepo, providerApiKeyRepo, modelRegistryRepo,
  agentsRepo, instancesRepo, templatesRepo, pluginsRepo,
  pendingMutationRepo,
} from '../repositories/index.js';
import { eventBus } from '../infrastructure/event-bus.js';
import { changesetService, getOrCreateDraftChangeset } from './changeset-service.js';

// ── Types ──────────────────────────────────────────────────────────

export type EntityType = 'provider' | 'api_key' | 'model' | 'agent' | 'instance' | 'template' | 'plugin' | 'skill' | 'webhook' | 'integration';

export interface EntityRef {
  type: EntityType;
  id: string;
}

export interface WorkingEntity {
  /** The entity data (shadow copy) */
  data: Record<string, any>;
  /** Whether this entity is marked for deletion */
  deleted: boolean;
  /** Whether this entity is a new creation (not in committed DB) */
  created: boolean;
}

export interface FieldDiff {
  _changed: boolean;
  committed?: any;
  pending?: any;
}

export interface EntityDiff {
  action: 'create' | 'update' | 'delete' | null;
  fields: Record<string, FieldDiff> | null;
}

// ── Sensitive field masking ──

const SENSITIVE_FIELDS = new Set(['apiKey', 'api_key', 'secret', 'password', 'token']);

function maskValue(field: string, value: any): any {
  if (SENSITIVE_FIELDS.has(field) && typeof value === 'string' && value.length > 4) {
    return '••••' + value.slice(-4);
  }
  return value;
}

// ── Entity Graph ───────────────────────────────────────────────────

interface ChildRelation {
  type: EntityType;
  foreignKey: string;
}

interface MutexFlag {
  /** Which field on children is the mutex */
  field: string;
  /** Which field scopes the mutex group (e.g., providerId) */
  scopeField: string;
  /** Child entity type */
  childType: EntityType;
}

interface EntityGraphNode {
  children?: ChildRelation[];
  mutexFlags?: MutexFlag[];
}

const ENTITY_GRAPH: Partial<Record<EntityType, EntityGraphNode>> = {
  provider: {
    children: [
      { type: 'api_key', foreignKey: 'providerId' },
    ],
    mutexFlags: [
      { field: 'isDefault', scopeField: 'providerId', childType: 'api_key' },
    ],
  },
  instance: {
    children: [
      { type: 'agent', foreignKey: 'instanceId' },
    ],
  },
};

// ── Committed State Readers ────────────────────────────────────────

function getCommitted(type: EntityType, id: string): Record<string, any> | null {
  switch (type) {
    case 'provider': return modelProviderRepo.getById(id) ?? null;
    case 'api_key': return providerApiKeyRepo.getById(id) ?? null;
    case 'model': return modelRegistryRepo.getById(id) ?? null;
    case 'agent': return agentsRepo.getById(id) ?? null;
    case 'instance': return instancesRepo.getById(id) ?? null;
    case 'template': return templatesRepo.getById(id) ?? null;
    case 'plugin': return pluginsRepo.getById(id) ?? null;
    default: return null;
  }
}

function getAllCommitted(type: EntityType): Record<string, any>[] {
  switch (type) {
    case 'provider': return modelProviderRepo.getAll();
    case 'api_key': return []; // fetched via provider
    case 'model': return modelRegistryRepo.getAll();
    case 'agent': return agentsRepo.getAll();
    case 'instance': return instancesRepo.getAll();
    case 'template': return templatesRepo.getAll();
    case 'plugin': return pluginsRepo.getAll();
    default: return [];
  }
}

function getCommittedChildren(childType: EntityType, foreignKey: string, parentId: string): Record<string, any>[] {
  switch (childType) {
    case 'api_key': return providerApiKeyRepo.getByProvider(parentId);
    case 'agent': return agentsRepo.getAll().filter(a => a.instanceId === parentId);
    default: return [];
  }
}

// ── Working Copy Store ─────────────────────────────────────────────

/** Map of "type:id" → WorkingEntity */
const store = new Map<string, WorkingEntity>();

function key(type: EntityType, id: string): string {
  return `${type}:${id}`;
}

/** Track the draft changeset ID created for the current working copy */
let draftChangesetId: string | null = null;

function emitChange(): void {
  syncToChangesetPipeline();
  eventBus.emit('draft.updated', { timestamp: Date.now() });
}

/**
 * Sync working copy state → pending_mutations table + draft changeset.
 * This bridges the working copy (shadow layer) with the existing changeset
 * pipeline so approve/apply/UI all work unchanged.
 */
function syncToChangesetPipeline(): void {
  // Clear existing pending mutations for our draft changeset AND temp mutations.
  // This prevents duplicates when syncToChangesetPipeline() is called multiple
  // times before a changeset is created (fixes #22).
  if (draftChangesetId) {
    pendingMutationRepo.removeByChangeset(draftChangesetId);
  }
  // Also clear any temp mutations from previous syncs
  pendingMutationRepo.removeByChangeset('pending-wc');

  // If working copy is empty, cancel the draft changeset
  if (store.size === 0) {
    if (draftChangesetId) {
      try {
        changesetService.cancel(draftChangesetId);
      } catch { /* already cancelled or applied */ }
      draftChangesetId = null;
    }
    return;
  }

  // Ensure a draft changeset exists.
  // NOTE: do NOT create the changeset here — mutations must be written first so
  // that changesetService.create() → preview() can find pending changes.
  // Creation happens below via getOrCreateDraftChangeset() after the mutations
  // have been inserted.
  if (!draftChangesetId) {
    const drafts = changesetService.list(20).filter((c: any) => c.status === 'draft');
    if (drafts.length > 0) {
      draftChangesetId = drafts[0]!.id;
    }
  }

  // Write mutations from working copy diff
  const tempChangesetId = draftChangesetId || 'pending-wc'; // Temp ID until real changeset created

  for (const [k, wc] of store) {
    const [type, ...rest] = k.split(':');
    const id = rest.join(':');
    const entityType = type;
    
    if (wc.deleted) {
      pendingMutationRepo.create({
        changesetId: tempChangesetId,
        entityType,
        entityId: id,
        action: 'delete',
        payload: {},
        instanceId: null,
      });
    } else if (wc.created) {
      pendingMutationRepo.create({
        changesetId: tempChangesetId,
        entityType,
        entityId: id,
        action: 'create',
        payload: wc.data,
        instanceId: wc.data.instanceId ?? null,
      });
    } else {
      // Update — only include changed fields
      const committed = getCommitted(entityType as EntityType, id);
      if (!committed) continue;
      const changedPayload: Record<string, any> = {};
      for (const [field, value] of Object.entries(wc.data)) {
        if (field === 'id' || field === 'createdAt' || field === 'updatedAt') continue;
        if (JSON.stringify(committed[field]) !== JSON.stringify(value)) {
          changedPayload[field] = value;
        }
      }
      if (Object.keys(changedPayload).length === 0) continue;
      
      pendingMutationRepo.create({
        changesetId: tempChangesetId,
        entityType,
        entityId: id,
        action: 'update',
        payload: changedPayload,
        instanceId: null,
      });
    }
  }

  // Now create or update the changeset.
  // getOrCreateDraftChangeset() is the single owner for draft creation — it
  // centralises the check-then-create logic and documents why the pattern is
  // safe (see changeset-service.ts).
  if (!draftChangesetId) {
    const cs = getOrCreateDraftChangeset('working-copy');
    if (cs) {
      draftChangesetId = cs.id;
      // Re-link temp mutations to the real changeset ID
      const tempMutations = pendingMutationRepo.getByChangeset('pending-wc');
      for (const m of tempMutations) {
        pendingMutationRepo.linkToChangeset(m.id, cs.id);
      }
    }
    // If cs is null there are no instances yet — mutations stay as 'pending-wc'
    // and will be re-linked on the next sync once instances exist.
  } else {
    // Rebuild the changeset steps for the updated mutations
    try {
      changesetService.rebuildSteps(draftChangesetId);
    } catch { /* ignore */ }
  }
}

// ── Public API ─────────────────────────────────────────────────────

export const workingCopy = {

  // ── Read ──

  /** Get the working copy of an entity, or null if not in working copy */
  get(type: EntityType, id: string): WorkingEntity | null {
    return store.get(key(type, id)) ?? null;
  },

  /** Get the effective data for an entity (working copy if exists, else committed) */
  getEffective(type: EntityType, id: string): Record<string, any> | null {
    const wc = store.get(key(type, id));
    if (wc) return wc.deleted ? null : wc.data;
    return getCommitted(type, id);
  },

  /** Get all entities of a type, with working copy overlaid */
  getAllEffective(type: EntityType): Array<Record<string, any> & { _wcAction?: 'create' | 'update' | 'delete' | null }> {
    const committed = getAllCommitted(type);
    const result: Array<Record<string, any> & { _wcAction?: 'create' | 'update' | 'delete' | null }> = [];

    // Track which committed entities have working copies
    const seenIds = new Set<string>();

    for (const entity of committed) {
      const id = entity.id ?? entity.name;
      const wc = store.get(key(type, id));
      seenIds.add(id);

      if (wc) {
        if (wc.deleted) {
          result.push({ ...entity, _wcAction: 'delete' });
        } else {
          result.push({ ...wc.data, _wcAction: 'update' });
        }
      } else {
        result.push({ ...entity, _wcAction: null });
      }
    }

    // Add created entities (in working copy but not committed)
    for (const [k, wc] of store) {
      if (!k.startsWith(type + ':')) continue;
      const id = k.slice(type.length + 1);
      if (!seenIds.has(id) && wc.created && !wc.deleted) {
        result.push({ ...wc.data, _wcAction: 'create' });
      }
    }

    return result;
  },

  /** Check if there are ANY changes in the working copy */
  hasChanges(): boolean {
    return store.size > 0;
  },

  /** Get all entity refs that have working copies */
  getChangedRefs(): EntityRef[] {
    const refs: EntityRef[] = [];
    for (const [k] of store) {
      const [type, ...rest] = k.split(':');
      refs.push({ type: type as EntityType, id: rest.join(':') });
    }
    return refs;
  },

  // ── Write ──

  /** Update fields on an entity in the working copy.
   *  If not already in WC, clones from committed first. */
  update(type: EntityType, id: string, fields: Record<string, any>): void {
    const k = key(type, id);
    let wc = store.get(k);

    if (!wc) {
      // Clone from committed
      const committed = getCommitted(type, id);
      if (!committed) throw new Error(`Entity ${type}:${id} not found`);
      wc = { data: { ...committed }, deleted: false, created: false };
      store.set(k, wc);
    }

    // Apply field updates
    Object.assign(wc.data, fields);

    // No-op check: if working copy now matches committed, remove it
    const committed = getCommitted(type, id);
    if (committed && !wc.created) {
      if (this._isIdentical(committed, wc.data)) {
        store.delete(k);
      }
    }

    emitChange();
  },

  /** Create a new entity in the working copy (not yet in DB) */
  create(type: EntityType, id: string, data: Record<string, any>): void {
    store.set(key(type, id), {
      data: { ...data, id },
      deleted: false,
      created: true,
    });
    emitChange();
  },

  /** Mark an entity for deletion. Cascades to children. */
  delete(type: EntityType, id: string): void {
    const k = key(type, id);
    const wc = store.get(k);

    if (wc?.created) {
      // It was created in WC and now deleted — just remove it entirely
      store.delete(k);
    } else {
      // Mark existing entity for deletion
      const committed = getCommitted(type, id);
      if (committed) {
        store.set(k, { data: committed, deleted: true, created: false });
      }
    }

    // Cascade delete to children
    const graph = ENTITY_GRAPH[type];
    if (graph?.children) {
      for (const child of graph.children) {
        const children = getCommittedChildren(child.type, child.foreignKey, id);
        for (const c of children) {
          const childId = c.id ?? c.name;
          this.delete(child.type, childId);
        }
        // Also delete any WC-created children
        for (const [ck, cwc] of store) {
          if (ck.startsWith(child.type + ':') && cwc.created && cwc.data[child.foreignKey] === id) {
            store.delete(ck);
          }
        }
      }
    }

    // Remove any pending modifications to this entity's children
    // (they're being deleted — modifications are moot)
    if (graph?.children) {
      for (const child of graph.children) {
        for (const [ck, cwc] of store) {
          if (ck.startsWith(child.type + ':') && !cwc.deleted && !cwc.created) {
            if (cwc.data[child.foreignKey] === id) {
              store.delete(ck);
            }
          }
        }
      }
    }

    emitChange();
  },

  /** Set a mutex flag — ensures only one entity in the group has the flag active */
  setMutexFlag(type: EntityType, id: string, field: string, parentId: string): void {
    // Get all siblings (committed + WC-created)
    const graph = ENTITY_GRAPH[type] ?? Object.values(ENTITY_GRAPH).find(g =>
      g?.mutexFlags?.some(m => m.childType === type && m.field === field)
    );

    // Find the mutex definition
    let mutex: MutexFlag | undefined;
    for (const [, node] of Object.entries(ENTITY_GRAPH)) {
      mutex = node?.mutexFlags?.find(m => m.childType === type && m.field === field);
      if (mutex) break;
    }
    if (!mutex) {
      // No mutex config — just update the field
      this.update(type, id, { [field]: 1 });
      return;
    }

    // Get all siblings in this scope
    const siblings = getCommittedChildren(type, mutex.scopeField, parentId);

    // Set the target to active
    this.update(type, id, { [field]: 1 });

    // Set all others to inactive
    for (const sibling of siblings) {
      const sibId = sibling.id ?? sibling.name;
      if (sibId !== id) {
        this.update(type, sibId, { [field]: 0 });
      }
    }

    // emitChange already called by update()
  },

  // ── Diff ──

  /** Compute diff for a single entity */
  diff(type: EntityType, id: string): EntityDiff {
    const wc = store.get(key(type, id));
    if (!wc) return { action: null, fields: null };

    if (wc.deleted) return { action: 'delete', fields: null };
    if (wc.created) return { action: 'create', fields: null };

    // Update — compute field-level diff
    const committed = getCommitted(type, id);
    if (!committed) return { action: 'create', fields: null };

    const fields: Record<string, FieldDiff> = {};
    let hasChanges = false;

    for (const [k, v] of Object.entries(wc.data)) {
      if (k === 'id' || k === 'createdAt' || k === 'updatedAt') continue;
      const cv = committed[k];
      if (JSON.stringify(cv) !== JSON.stringify(v)) {
        fields[k] = {
          _changed: true,
          committed: maskValue(k, cv),
          pending: maskValue(k, v),
        };
        hasChanges = true;
      }
    }

    if (!hasChanges) return { action: null, fields: null };
    return { action: 'update', fields: { _changed: true, ...fields } as any };
  },

  /** Get all diffs across all entities in working copy */
  allDiffs(): Array<EntityRef & EntityDiff> {
    const result: Array<EntityRef & EntityDiff> = [];
    for (const [k] of store) {
      const [type, ...rest] = k.split(':');
      const id = rest.join(':');
      const d = this.diff(type as EntityType, id);
      if (d.action) {
        result.push({ type: type as EntityType, id, ...d });
      }
    }
    return result;
  },

  // ── Lifecycle ──

  /** Discard all changes — clear working copy and cancel changeset */
  discard(): void {
    store.clear();
    // Cancel the draft changeset and clear mutations
    if (draftChangesetId) {
      pendingMutationRepo.removeByChangeset(draftChangesetId);
      try {
        changesetService.cancel(draftChangesetId);
      } catch { /* already cancelled */ }
      draftChangesetId = null;
    }
    // Also clean up any temp mutations
    const tempMutations = pendingMutationRepo.getByChangeset('pending-wc');
    for (const m of tempMutations) {
      pendingMutationRepo.removeById(m.id);
    }
    eventBus.emit('draft.discarded', { timestamp: Date.now() });
  },

  /** Get entity count in working copy */
  size(): number {
    return store.size;
  },

  // ── Internal ──

  _isIdentical(committed: Record<string, any>, working: Record<string, any>): boolean {
    for (const [k, v] of Object.entries(working)) {
      if (k === 'id' || k === 'createdAt' || k === 'updatedAt') continue;
      if (JSON.stringify(committed[k]) !== JSON.stringify(v)) return false;
    }
    return true;
  },
};

// ── Auto-clear working copy when its changeset is completed or discarded ──
eventBus.on('changeset.completed', (event) => {
  if (event.data?.changesetId === draftChangesetId) {
    store.clear();
    draftChangesetId = null;
    eventBus.emit('draft.discarded', { timestamp: Date.now() });
  }
});

eventBus.on('changeset.discarded', (event) => {
  if (event.data?.changesetId === draftChangesetId) {
    store.clear();
    draftChangesetId = null;
    eventBus.emit('draft.discarded', { timestamp: Date.now() });
  }
});
