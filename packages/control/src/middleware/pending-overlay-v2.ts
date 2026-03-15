/**
 * Pending Overlay v2 — reads from working copy instead of mutation records.
 *
 * For each entity in a GET response:
 * - If working copy has a version: return working copy data + diff as pendingFields
 * - If not: return committed data with pendingAction=null
 *
 * Much simpler than v1 — no mutation merging, no entity type mapping.
 */

import type { Request, Response, NextFunction } from 'express';
import { workingCopy } from '../services/working-copy.js';
import type { EntityType } from '../services/working-copy.js';

// ── Sensitive field masking ──

const SENSITIVE_FIELDS = new Set(['apiKey', 'api_key', 'secret', 'password', 'token']);

function maskSensitive(entity: Record<string, any>): Record<string, any> {
  const result = { ...entity };
  for (const field of SENSITIVE_FIELDS) {
    if (typeof result[field] === 'string' && result[field].length > 4) {
      result[field] = '••••' + result[field].slice(-4);
    }
  }
  return result;
}

// ── Route → entity type mapping ──

interface RouteMapping {
  pattern: RegExp;
  entityType: EntityType;
  idField?: string;
  isSingle?: boolean;
  /** For sub-resources: overlay children too (e.g., provider.keys) */
  childOverlay?: {
    dataField: string;       // field name in parent response containing children
    entityType: EntityType;
  };
}

const ROUTE_MAPPINGS: RouteMapping[] = [
  {
    pattern: /^\/providers$/,
    entityType: 'provider',
    childOverlay: { dataField: 'keys', entityType: 'api_key' },
  },
  { pattern: /^\/providers\/([^/]+)$/, entityType: 'provider', isSingle: true,
    childOverlay: { dataField: 'keys', entityType: 'api_key' },
  },
  { pattern: /^\/providers\/([^/]+)\/keys$/, entityType: 'api_key' },
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

// ── Overlay a single entity ──

function overlayEntity(entity: Record<string, any>, entityType: EntityType, idField = 'id'): Record<string, any> {
  const id = entity[idField] ?? entity.id;
  const wc = workingCopy.get(entityType, id);

  if (!wc) {
    return { ...entity, pendingAction: null, pendingFields: null };
  }

  if (wc.deleted) {
    return { ...entity, pendingAction: 'delete', pendingFields: null };
  }

  if (wc.created) {
    return { ...maskSensitive(wc.data), pendingAction: 'create', pendingFields: null };
  }

  // Update — MERGE working copy fields on top of the original response.
  // The original response may have joined data (keys, models, etc.) that
  // the working copy doesn't know about. We only override changed fields.
  const diff = workingCopy.diff(entityType, id);
  const merged = { ...entity };
  if (diff.fields) {
    for (const [field, fieldDiff] of Object.entries(diff.fields)) {
      if (field === '_changed') continue;
      if ((fieldDiff as any)?._changed) {
        merged[field] = SENSITIVE_FIELDS.has(field) && typeof wc.data[field] === 'string' && wc.data[field].length > 4
          ? '••••' + wc.data[field].slice(-4)
          : wc.data[field];
      }
    }
  }
  return {
    ...merged,
    pendingAction: diff.action,
    pendingFields: diff.fields,
  };
}

// ── Overlay children (e.g., provider.keys) ──

function overlayChildren(
  entity: Record<string, any>,
  childField: string,
  childType: EntityType,
): Record<string, any> {
  if (!Array.isArray(entity[childField])) return entity;

  const overlaidChildren = entity[childField].map((child: Record<string, any>) =>
    overlayEntity(child, childType)
  );

  // Check if any child has pending changes
  const hasChildChanges = overlaidChildren.some((c: any) => c.pendingAction != null);

  const result = { ...entity, [childField]: overlaidChildren };

  // If children changed but parent isn't already pending, mark parent
  if (hasChildChanges && !result.pendingAction) {
    result.pendingAction = 'update';
    result.pendingFields = { _changed: true, [childField]: { _changed: true } };
  } else if (hasChildChanges && result.pendingFields) {
    result.pendingFields = { ...result.pendingFields, [childField]: { _changed: true } };
  }

  return result;
}

// ── Middleware ──

export function pendingOverlayV2(req: Request, res: Response, next: NextFunction): void {
  if (req.method !== 'GET') {
    next();
    return;
  }

  const path = req.path.replace(/^\/api/, '');

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

  const originalJson = res.json.bind(res);
  res.json = function (data: any) {
    try {
      const idField = mapping!.idField || 'id';

      if (mapping!.isSingle) {
        if (data && typeof data === 'object' && !data.error) {
          data = overlayEntity(data, mapping!.entityType, idField);
          if (mapping!.childOverlay) {
            data = overlayChildren(data, mapping!.childOverlay.dataField, mapping!.childOverlay.entityType);
          }
        }
      } else if (Array.isArray(data)) {
        data = data.map(item => {
          let overlaid = overlayEntity(item, mapping!.entityType, idField);
          if (mapping!.childOverlay) {
            overlaid = overlayChildren(overlaid, mapping!.childOverlay.dataField, mapping!.childOverlay.entityType);
          }
          return overlaid;
        });
      }

      return originalJson(data);
    } catch (err) {
      console.warn('[pending-overlay-v2] Error:', err);
      return originalJson(data);
    }
  } as any;

  next();
}
