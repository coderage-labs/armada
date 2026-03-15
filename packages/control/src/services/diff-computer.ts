// ── Diff Computer — Compute field-level diffs for pending mutations ──

import diff from 'microdiff';
import { pendingMutationRepo, agentsRepo, modelRegistryRepo, modelProviderRepo } from '../repositories/index.js';
import type { MutationDiff, DiffNode } from '@coderage-labs/armada-shared';

const FIELD_LABELS: Record<string, string> = {
  name: 'Name',
  model: 'Model',
  role: 'Role',
  skills: 'Skills',
  soul: 'Soul',
  agentsMd: 'Agents.md',
  agents_md: 'Agents.md',
  instanceId: 'Instance',
  templateId: 'Template',
  provider: 'Provider',
  modelId: 'Model ID',
  description: 'Description',
  apiKeyEnvVar: 'API Key Env Var',
  capabilities: 'Capabilities',
  maxTokens: 'Max Tokens',
  costTier: 'Cost Tier',
  type: 'Type',
  apiKey: 'API Key',
  baseUrl: 'Base URL',
  enabled: 'Enabled',
  registryId: 'Registry ID',
  default: 'Default',
  apiKeyId: 'API Key',
  internalAgents: 'Internal Agents',
  contacts: 'Contacts',
  models: 'Models',
  plugins: 'Plugins',
  pluginsList: 'Plugins List',
  skillsList: 'Skills List',
  toolsAllow: 'Tools Allow',
  toolsProfile: 'Tools Profile',
  agents: 'Agents',
  env: 'Environment',
};

function getFieldLabel(field: string): string {
  return FIELD_LABELS[field] || field.replace(/([A-Z])/g, ' $1').replace(/^./, (s) => s.toUpperCase());
}

const SENSITIVE_FIELDS = new Set(['apiKey', 'api_key', 'secret', 'password', 'token']);

function maskSensitiveValue(field: string, value: any): any {
  if (SENSITIVE_FIELDS.has(field) && typeof value === 'string' && value.length > 4) {
    return '••••' + value.slice(-4);
  }
  return value;
}

function shouldTruncate(value: any): boolean {
  return typeof value === 'string' && value.length > 100;
}

function truncateValue(value: any): { value: any; truncated: boolean } {
  if (shouldTruncate(value)) {
    return { value: value.substring(0, 100) + '...', truncated: true };
  }
  return { value, truncated: false };
}

function getEntityName(entityType: string, entity: any, payload: any): string {
  if (entityType === 'agent' || entityType === 'model' || entityType === 'provider') {
    return entity?.name || payload?.name || 'Unknown';
  }
  return 'Unknown';
}

/**
 * Build a tree of DiffNode from microdiff output.
 * Groups changes by path prefix to create nested structure.
 */
function buildDiffTree(changes: any[]): DiffNode[] {
  if (changes.length === 0) return [];

  // Build a tree structure
  const root: Map<string, any> = new Map();

  for (const change of changes) {
    const path = change.path;
    const pathStr = path.join('.');
    
    // Navigate/create nested structure
    let current = root;
    for (let i = 0; i < path.length; i++) {
      const segment = path[i];
      const key = String(segment);
      
      if (i === path.length - 1) {
        // Leaf node
        if (!current.has(key)) {
          current.set(key, []);
        }
        current.get(key).push({
          change,
          fullPath: pathStr,
          segment: key,
        });
      } else {
        // Branch node
        if (!current.has(key)) {
          current.set(key, new Map());
        }
        if (!(current.get(key) instanceof Map)) {
          // Convert leaf to branch if needed
          const existing = current.get(key);
          current.set(key, new Map());
          // Store leaf data at special key
          if (Array.isArray(existing)) {
            current.get(key).set('__leaf__', existing);
          }
        }
        current = current.get(key);
      }
    }
  }

  // Convert map structure to DiffNode array
  function mapToNodes(map: Map<string, any>, pathPrefix: string[] = []): DiffNode[] {
    const nodes: DiffNode[] = [];
    
    for (const [key, value] of map.entries()) {
      if (key === '__leaf__') continue; // Skip special leaf marker
      
      const currentPath = [...pathPrefix, key];
      const pathStr = currentPath.join('.');
      
      if (value instanceof Map) {
        // Branch node
        const children = mapToNodes(value, currentPath);
        const leafData = value.get('__leaf__');
        
        // If has leaf data, create leaf node alongside children
        if (leafData && Array.isArray(leafData)) {
          for (const item of leafData) {
            const { change } = item;
            const maskedOld = maskSensitiveValue(key, change.oldValue);
            const maskedNew = maskSensitiveValue(key, change.value);
            const { value: truncOld, truncated: truncOldFlag } = truncateValue(maskedOld);
            const { value: truncNew, truncated: truncNewFlag } = truncateValue(maskedNew);
            
            nodes.push({
              path: pathStr,
              label: getFieldLabel(key),
              type: change.type === 'CHANGE' ? 'change' : change.type === 'CREATE' ? 'create' : 'remove',
              oldValue: change.type === 'REMOVE' || change.type === 'CHANGE' ? truncOld : undefined,
              newValue: change.type === 'CREATE' || change.type === 'CHANGE' ? truncNew : undefined,
              ...(truncOldFlag || truncNewFlag ? { truncated: true } : {}),
            });
          }
        }
        
        if (children.length > 0) {
          nodes.push({
            path: pathStr,
            label: getFieldLabel(key),
            type: 'change',
            children,
          });
        }
      } else if (Array.isArray(value)) {
        // Leaf node(s)
        for (const item of value) {
          const { change } = item;
          const maskedOld = maskSensitiveValue(key, change.oldValue);
          const maskedNew = maskSensitiveValue(key, change.value);
          const { value: truncOld, truncated: truncOldFlag } = truncateValue(maskedOld);
          const { value: truncNew, truncated: truncNewFlag } = truncateValue(maskedNew);
          
          nodes.push({
            path: pathStr,
            label: getFieldLabel(key),
            type: change.type === 'CHANGE' ? 'change' : change.type === 'CREATE' ? 'create' : 'remove',
            oldValue: change.type === 'REMOVE' || change.type === 'CHANGE' ? truncOld : undefined,
            newValue: change.type === 'CREATE' || change.type === 'CHANGE' ? truncNew : undefined,
            ...(truncOldFlag || truncNewFlag ? { truncated: true } : {}),
          });
        }
      }
    }
    
    return nodes;
  }

  return mapToNodes(root);
}

/**
 * Compute field-level diffs for pending mutations.
 * @param changesetIdOrMutations - Either a changeset ID to look up mutations, or an array of mutations
 * Returns an array of mutation diffs showing current vs pending values as a tree structure.
 */
export function computeMutationDiffs(changesetIdOrMutations: string | any[]): MutationDiff[] {
  const mutations = typeof changesetIdOrMutations === 'string'
    ? pendingMutationRepo.getByChangeset(changesetIdOrMutations)
    : changesetIdOrMutations;
  
  const diffs: MutationDiff[] = [];

  for (const mutation of mutations) {
    let currentEntity: any = null;
    
    // Look up current entity for updates/deletes
    if (mutation.entityId && mutation.action !== 'create') {
      if (mutation.entityType === 'agent') {
        currentEntity = agentsRepo.getById(mutation.entityId);
      } else if (mutation.entityType === 'model') {
        currentEntity = modelRegistryRepo.getById(mutation.entityId);
      } else if (mutation.entityType === 'provider') {
        currentEntity = modelProviderRepo.getById(mutation.entityId);
      }
    }

    const entityName = getEntityName(mutation.entityType, currentEntity, mutation.payload);
    let changes: DiffNode[] = [];

    if (mutation.action === 'create') {
      // For creates, diff {} vs payload
      const microdiffChanges = diff({}, mutation.payload);
      changes = buildDiffTree(microdiffChanges);
    } else if (mutation.action === 'delete') {
      // For deletes, diff currentEntity vs {}
      if (currentEntity) {
        // Filter out metadata fields
        const filtered: Record<string, any> = {};
        for (const [field, value] of Object.entries(currentEntity)) {
          if (!['id', 'createdAt', 'uptime', 'lastHeartbeat', 'healthStatus', 'heartbeatMeta', 'avatarGenerating', 'instanceName'].includes(field)) {
            filtered[field] = value;
          }
        }
        const microdiffChanges = diff(filtered, {});
        changes = buildDiffTree(microdiffChanges);
      }
    } else if (mutation.action === 'update') {
      // For updates, only diff fields in the payload
      const relevantCurrent: Record<string, any> = {};
      const relevantPending: Record<string, any> = {};
      
      for (const key of Object.keys(mutation.payload)) {
        relevantCurrent[key] = currentEntity?.[key] ?? null;
        relevantPending[key] = mutation.payload[key];
      }
      
      const microdiffChanges = diff(relevantCurrent, relevantPending);
      changes = buildDiffTree(microdiffChanges);
    }

    diffs.push({
      mutationId: mutation.id,
      entityType: mutation.entityType,
      entityId: mutation.entityId,
      entityName,
      action: mutation.action,
      changes,
    });
  }

  return diffs;
}
