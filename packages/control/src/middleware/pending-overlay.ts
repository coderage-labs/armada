/**
 * Pending Overlay Middleware
 * 
 * Intercepts GET responses on entity endpoints and merges pending mutations
 * into the response data. Each entity gets:
 * - pendingAction: 'create' | 'update' | 'delete' | null
 * - pendingFields: nested object marking which fields changed (with _changed flags)
 * 
 * Pure-create mutations are injected as new items in list responses.
 * Sensitive fields are masked in pending values.
 */

import type { Request, Response, NextFunction } from 'express';
import { pendingMutationRepo } from '../repositories/index.js';
import type { PendingMutation } from '../repositories/pending-mutation-repo.js';
import diff from 'microdiff';

// ── Route → entity type mapping ──

interface RouteMapping {
  pattern: RegExp;
  entityType: string;
  idField?: string;          // field name for entity ID (default: 'id')
  isSingle?: boolean;        // true for /api/entities/:id detail endpoints
  nested?: {                 // for sub-resources like /api/providers/:id/keys
    entityType: string;
    parentIdParam: string;   // param name in the parent route
    idField?: string;
  };
}

const ROUTE_MAPPINGS: RouteMapping[] = [
  { pattern: /^\/providers\/([^/]+)\/keys$/, entityType: 'provider', nested: { entityType: 'api_key', parentIdParam: 'providerId', idField: 'id' } },
  { pattern: /^\/providers$/, entityType: 'provider' },
  { pattern: /^\/providers\/([^/]+)$/, entityType: 'provider', isSingle: true },
  { pattern: /^\/agents$/, entityType: 'agent' },
  { pattern: /^\/agents\/([^/]+)$/, entityType: 'agent', isSingle: true, idField: 'name' },
  { pattern: /^\/models$/, entityType: 'model' },
  { pattern: /^\/models\/([^/]+)$/, entityType: 'model', isSingle: true },
  { pattern: /^\/templates$/, entityType: 'template' },
  { pattern: /^\/templates\/([^/]+)$/, entityType: 'template', isSingle: true },
  { pattern: /^\/instances$/, entityType: 'instance' },
  { pattern: /^\/instances\/([^/]+)$/, entityType: 'instance', isSingle: true },
  { pattern: /^\/plugins\/library$/, entityType: 'plugin' },
  { pattern: /^\/skills\/library$/, entityType: 'skill' },
  { pattern: /^\/webhooks$/, entityType: 'webhook' },
  { pattern: /^\/integrations$/, entityType: 'integration' },
];

// ── Sensitive field masking ──

const SENSITIVE_FIELDS = new Set(['apiKey', 'api_key', 'secret', 'password', 'token']);

function maskValue(field: string, value: any): any {
  if (SENSITIVE_FIELDS.has(field) && typeof value === 'string' && value.length > 4) {
    return '••••' + value.slice(-4);
  }
  return value;
}

// ── Build pendingFields tree with _changed bubbling ──

interface PendingFieldNode {
  _changed: boolean;
  committed?: any;
  pending?: any;
  [key: string]: any;
}

function buildPendingFields(committed: Record<string, any>, pendingPayload: Record<string, any>): PendingFieldNode | null {
  // Only diff fields present in the payload
  const relevantCommitted: Record<string, any> = {};
  const relevantPending: Record<string, any> = {};

  for (const key of Object.keys(pendingPayload)) {
    relevantCommitted[key] = committed?.[key] ?? null;
    relevantPending[key] = pendingPayload[key];
  }

  const changes = diff(relevantCommitted, relevantPending);
  if (changes.length === 0) return null;

  const root: PendingFieldNode = { _changed: true };

  for (const change of changes) {
    let cursor: any = root;

    // Walk the path, creating nodes and marking _changed at every level
    for (let i = 0; i < change.path.length; i++) {
      const segment = String(change.path[i]);

      if (i === change.path.length - 1) {
        // Leaf node — store committed/pending values
        cursor[segment] = {
          _changed: true,
          committed: change.type === 'CREATE' ? undefined : maskValue(segment, change.oldValue),
          pending: change.type === 'REMOVE' ? undefined : maskValue(segment, change.value),
        };
      } else {
        // Branch node — ensure exists and mark changed
        if (!cursor[segment] || typeof cursor[segment] !== 'object') {
          cursor[segment] = { _changed: true };
        } else {
          cursor[segment]._changed = true;
        }
        cursor = cursor[segment];
      }
    }
  }

  return root;
}

// ── Apply overlay to a single entity ──

function overlayEntity(
  entity: Record<string, any>,
  mutations: PendingMutation[],
  idField: string = 'id',
): Record<string, any> {
  const entityId = entity[idField];
  const mutation = mutations.find(m =>
    m.entityId === entityId || m.entityId === entity.id || m.entityId === entity.name
  );

  if (!mutation) {
    return { ...entity, pendingAction: null, pendingFields: null };
  }

  if (mutation.action === 'delete') {
    return { ...entity, pendingAction: 'delete', pendingFields: null };
  }

  if (mutation.action === 'update') {
    // Merge pending payload over committed data for display
    const merged = { ...entity };
    for (const [key, value] of Object.entries(mutation.payload)) {
      if (SENSITIVE_FIELDS.has(key)) {
        merged[key] = maskValue(key, value);
      } else {
        merged[key] = value;
      }
    }

    const pendingFields = buildPendingFields(entity, mutation.payload);
    return { ...merged, pendingAction: 'update', pendingFields };
  }

  return { ...entity, pendingAction: null, pendingFields: null };
}

// ── Overlay api_key mutations onto provider.keys arrays ──

function overlayProviderKeys(providers: Record<string, any>[]): Record<string, any>[] {
  const keyMutations = pendingMutationRepo.getByEntity('api_key');
  if (keyMutations.length === 0) return providers;

  // Build a map of key ID → provider ID from the data
  const keyToProvider = new Map<string, number>();
  for (let i = 0; i < providers.length; i++) {
    const p = providers[i];
    if (Array.isArray(p.keys)) {
      for (const k of p.keys) {
        keyToProvider.set(k.id, i);
      }
    }
  }

  // Group key mutations by provider index
  const providerKeyMutations = new Map<number, PendingMutation[]>();
  for (const m of keyMutations) {
    const pIdx = m.entityId ? keyToProvider.get(m.entityId) : undefined;
    if (pIdx !== undefined) {
      const existing = providerKeyMutations.get(pIdx) || [];
      existing.push(m);
      providerKeyMutations.set(pIdx, existing);
    }
  }

  // Apply key overlays
  for (const [pIdx, mutations] of providerKeyMutations) {
    const provider = { ...providers[pIdx] };
    if (Array.isArray(provider.keys)) {
      provider.keys = provider.keys.map((k: Record<string, any>) => overlayEntity(k, mutations));
    }

    // Mark provider as having pending changes if it isn't already
    if (!provider.pendingAction) {
      provider.pendingAction = 'update';
      provider.pendingFields = { _changed: true, keys: { _changed: true } };
    } else if (provider.pendingFields) {
      provider.pendingFields = { ...provider.pendingFields, keys: { _changed: true } };
    }

    providers[pIdx] = provider;
  }

  return providers;
}

// ── Inject pure-create mutations as new entities in list ──

function injectCreateMutations(
  entities: Record<string, any>[],
  mutations: PendingMutation[],
): Record<string, any>[] {
  const creates = mutations.filter(m => m.action === 'create');
  
  for (const mutation of creates) {
    const maskedPayload = { ...mutation.payload };
    for (const field of SENSITIVE_FIELDS) {
      if (typeof maskedPayload[field] === 'string') {
        maskedPayload[field] = maskValue(field, maskedPayload[field]);
      }
    }

    entities.push({
      ...maskedPayload,
      id: mutation.entityId || `pending-${mutation.id}`,
      pendingAction: 'create',
      pendingFields: null,
    });
  }

  return entities;
}

// ── The middleware ──

export function pendingOverlayMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Only intercept GETs
  if (req.method !== 'GET') {
    next();
    return;
  }

  // Strip /api prefix to match routes
  const path = req.path.replace(/^\/api/, '');

  // Find matching route
  let mapping: RouteMapping | undefined;
  for (const m of ROUTE_MAPPINGS) {
    if (m.pattern.test(path)) {
      mapping = m;
      break;
    }
  }

  if (!mapping) {
    next();
    return;
  }

  // Intercept res.json
  const originalJson = res.json.bind(res);
  res.json = function (data: any) {
    try {
      // Handle nested sub-resources (e.g., provider keys)
      if (mapping!.nested) {
        const { entityType: nestedType } = mapping!.nested;
        const mutations = pendingMutationRepo.getByEntity(nestedType);

        if (mutations.length > 0 && Array.isArray(data)) {
          data = data.map(item => overlayEntity(item, mutations));
          data = injectCreateMutations(data, mutations);
        } else if (Array.isArray(data)) {
          data = data.map(item => ({ ...item, pendingAction: null, pendingFields: null }));
        }

        return originalJson(data);
      }

      const mutations = pendingMutationRepo.getByEntity(mapping!.entityType);
      const hasEntityMutations = mutations.length > 0;

      // For providers, also check api_key mutations
      const hasKeyMutations = mapping!.entityType === 'provider' &&
        pendingMutationRepo.getByEntity('api_key').length > 0;

      if (!hasEntityMutations && !hasKeyMutations) {
        // No pending mutations — pass through with null markers
        if (Array.isArray(data)) {
          data = data.map((item: any) => ({ ...item, pendingAction: null, pendingFields: null }));
        } else if (data && typeof data === 'object' && !data.error) {
          data = { ...data, pendingAction: null, pendingFields: null };
        }
        return originalJson(data);
      }

      const idField = mapping!.idField || 'id';

      if (mapping!.isSingle) {
        // Single entity response
        if (data && typeof data === 'object' && !data.error) {
          data = overlayEntity(data, mutations, idField);
        }
      } else if (Array.isArray(data)) {
        // List response
        data = data.map(item => overlayEntity(item, mutations, idField));
        data = injectCreateMutations(data, mutations);

        // For providers, also overlay api_key mutations onto keys arrays
        if (mapping!.entityType === 'provider' && hasKeyMutations) {
          data = overlayProviderKeys(data);
        }
      }

      return originalJson(data);
    } catch (err) {
      // If overlay fails, don't break the response — send original data
      console.warn('[pending-overlay] Error applying overlay:', err);
      return originalJson(data);
    }
  } as any;

  next();
}
