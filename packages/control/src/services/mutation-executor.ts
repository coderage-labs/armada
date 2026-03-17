import {
  pendingMutationRepo,
  agentsRepo,
  modelProviderRepo,
  providerApiKeyRepo,
  modelRegistryRepo,
  pluginLibraryRepo,
  instancesRepo,
  assignmentRepo,
} from '../repositories/index.js';
import type { PendingMutation } from '../repositories/pending-mutation-repo.js';
import { pluginManager } from './plugin-manager.js';
import { instanceManager } from './instance-manager.js';
import { getDrizzle } from '../db/drizzle.js';
import { eventBus } from '../infrastructure/event-bus.js';

/** Execute all pending mutations for a changeset, flushing them to the real DB */
export function executePendingMutations(changesetId: string): { executed: number; errors: string[] } {
  const mutations = pendingMutationRepo.getByChangeset(changesetId);
  if (mutations.length === 0) return { executed: 0, errors: [] };

  const errors: string[] = [];
  let executed = 0;

  // Sort: creates first, then updates, then deletes
  const sorted = [...mutations].sort((a, b) => {
    const order: Record<string, number> = { create: 0, update: 1, delete: 2 };
    return order[a.action] - order[b.action];
  });

  // Wrap the entire flush in a single DB transaction so all mutations succeed
  // atomically — if any one fails, the whole batch is rolled back.
  // better-sqlite3 is synchronous and single-connection: repos that call
  // getDrizzle() internally will automatically participate in the same
  // transaction without needing an explicit `tx` parameter.
  try {
    getDrizzle().transaction(() => {
      for (const mutation of sorted) {
        executeMutation(mutation);
        executed++;
      }

      // Remove pending mutations inside the same transaction so they
      // disappear only if all mutations committed successfully.
      pendingMutationRepo.removeByChangeset(changesetId);
    });

    // Emit entity events AFTER successful commit so SSE listeners (UI) update
    for (const mutation of sorted) {
      emitEntityEvent(mutation);
    }
  } catch (err: any) {
    // The transaction was rolled back — report which mutation triggered it.
    // `executed` reflects how far we got before the error.
    const failedMutation = sorted[executed];
    const label = failedMutation
      ? `${failedMutation.entityType}.${failedMutation.action}(${failedMutation.entityId ?? 'new'})`
      : 'unknown';
    errors.push(`${label}: ${err.message}`);
    // Reset counter — nothing was committed.
    executed = 0;
  }

  return { executed, errors };
}

/** Emit SSE events so the UI updates after mutations are flushed to real DB */
function emitEntityEvent(mutation: PendingMutation): void {
  const { entityType, action, entityId, payload } = mutation;
  const eventAction = action === 'create' ? 'created' : action === 'update' ? 'updated' : 'deleted';
  const eventName = `${entityType}.${eventAction}`;

  // For creates/updates, try to read the current entity from DB for full data
  // For deletes, emit with just the id
  let data: any = { id: entityId, ...payload };

  if (entityType === 'agent' && entityId) {
    if (action === 'delete') {
      data = { id: entityId, name: payload?.name };
    } else {
      const agent = agentsRepo.getById(entityId);
      if (agent) data = agent;
    }
  } else if (entityType === 'instance' && entityId) {
    if (action === 'delete') {
      data = { id: entityId, name: payload?.name };
    } else {
      const instance = instancesRepo.getById(entityId);
      if (instance) data = instance;
    }
  }

  eventBus.emit(eventName, data);
}

function executeMutation(mutation: PendingMutation): void {
  const { entityType, action, payload, entityId } = mutation;

  switch (entityType) {
    case 'agent':
      if (action === 'create') {
        agentsRepo.create(payload as any);
      } else if (action === 'update' && entityId) {
        agentsRepo.update(entityId, payload as any);
      } else if (action === 'delete' && entityId) {
        // Capture name before deletion for assignment cleanup
        const agentToDelete = agentsRepo.getById(entityId);
        agentsRepo.remove(entityId);
        if (agentToDelete?.name) {
          const cleaned = assignmentRepo.removeAssignmentsForAssignee('agent', agentToDelete.name);
          if (cleaned > 0) {
            console.log(`[mutation-executor] Cleaned ${cleaned} stale assignment(s) for deleted agent "${agentToDelete.name}"`);
          }
        }
      }
      break;

    case 'provider':
      if (action === 'create') {
        modelProviderRepo.create(payload as any);
      } else if (action === 'update' && entityId) {
        modelProviderRepo.update(entityId, payload as any);
      } else if (action === 'delete' && entityId) {
        modelProviderRepo.delete(entityId);
      }
      break;

    case 'api_key':
      if (action === 'create') {
        providerApiKeyRepo.create(payload as any);
      } else if (action === 'update' && entityId) {
        providerApiKeyRepo.update(entityId, payload as any);
      } else if (action === 'delete' && entityId) {
        providerApiKeyRepo.delete(entityId);
      }
      break;

    case 'model':
      if (action === 'create') {
        modelRegistryRepo.create(payload as any);
      } else if (action === 'update' && entityId) {
        modelRegistryRepo.update(entityId, payload as any);
      } else if (action === 'delete' && entityId) {
        modelRegistryRepo.delete(entityId);
      }
      break;

    case 'plugin':
      // Plugin mutations update the library entry — templates/instances pick up the change at push_config time.
      // Use pluginManager so that events (plugin.library.add/update/remove) and activity logging are triggered.
      if (action === 'create') {
        pluginManager.create(payload as any);
      } else if (action === 'update' && entityId) {
        pluginManager.update(entityId, payload as any);
      } else if (action === 'delete' && entityId) {
        pluginManager.delete(entityId);
      }
      break;

    case 'instance':
      if (action === 'create' && entityId) {
        // Create the instance record if it doesn't exist yet (working copy flow),
        // or update it if it was pre-created by an older code path.
        const existing = instancesRepo.getById(entityId);
        if (!existing) {
          instancesRepo.create({
            id: entityId,
            name: payload?.name ?? entityId,
            nodeId: payload?.nodeId ?? '',
            status: 'provisioning',
            statusMessage: 'Changeset applying: creating container',
            memory: payload?.memory ?? '2g',
            cpus: payload?.cpus ?? '1',
            capacity: payload?.capacity ?? 5,
            config: payload?.config ?? {},
          });
        } else {
          instancesRepo.update(entityId, { status: 'provisioning', statusMessage: 'Changeset applying: creating container' });
        }
      } else if (action === 'update' && entityId) {
        const { restart, ...rest } = (payload ?? {}) as any;
        if (restart) {
          // Restart flag — trigger actual restart after the transaction commits
          const instanceIdForRestart = entityId;
          Promise.resolve().then(() =>
            instanceManager.restart(instanceIdForRestart).catch((err: any) => {
              console.error(`[mutation-executor] instance restart failed for ${instanceIdForRestart}: ${err.message}`);
              instancesRepo.updateStatus(instanceIdForRestart, 'error');
            })
          );
        } else if (Object.keys(rest).length > 0) {
          instancesRepo.update(entityId, rest as any);
        }
      } else if (action === 'delete' && entityId) {
        // Mark as 'stopping' to indicate the destroy pipeline has started.
        // The actual container removal and DB cleanup are performed by the
        // operation steps (stop_container → destroy_container → cleanup_instance_db).
        instancesRepo.update(entityId, { status: 'stopping' });
      }
      break;

    default:
      console.warn(`[mutation-executor] Unknown entity type: ${entityType}`);
  }
}
