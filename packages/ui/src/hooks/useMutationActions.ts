/**
 * useMutationActions — thin action-only hook for staging/removing pending mutations.
 *
 * Display is handled by the server-side overlay middleware + react-query.
 * This hook ONLY provides actions (stage, remove). SSE → react-query handles reactivity.
 */

import { apiFetch } from './useApi';

export function useMutationActions(entityType: string) {
  /** Stage a mutation (create/update/delete) */
  async function stage(
    action: 'create' | 'update' | 'delete',
    payload: Record<string, any>,
    entityId?: string,
  ): Promise<void> {
    await apiFetch('/api/pending-mutations', {
      method: 'POST',
      body: JSON.stringify({ entityType, action, payload, entityId }),
    });
    // SSE event → SSEProvider → invalidateQueries handles reactivity
  }

  /** Remove a pending mutation by ID */
  async function remove(mutationId: string): Promise<void> {
    await apiFetch(`/api/pending-mutations/${mutationId}`, { method: 'DELETE' });
    // SSE handles reactivity
  }

  /** Find mutation for an entity in the pending mutations list */
  async function findMutation(entityId: string): Promise<{ id: string; payload: Record<string, any> } | null> {
    try {
      const mutations = await apiFetch<Array<{ id: string; entityId: string | null; payload: Record<string, any> }>>(
        `/api/pending-mutations?entityType=${entityType}`,
      );
      return mutations.find(m => m.entityId === entityId) ?? null;
    } catch {
      return null;
    }
  }

  return { stage, remove, findMutation };
}
