/**
 * useUsers — react-query powered hook for the fleet user list.
 * Keeps a module-level sync cache so resolveUser() still works synchronously.
 */

import { useQuery } from '@tanstack/react-query';
import { apiFetch } from './useApi';
import type { ArmadaUser } from '@coderage-labs/armada-shared';

/* ── Module-level sync cache (for resolveUser) ─────────────────────── */

let _syncCache: ArmadaUser[] | null = null;

/* ── Hook ──────────────────────────────────────────────────────────── */

export function useUsers() {
  return useQuery({
    queryKey: ['users'],
    queryFn: async () => {
      const users = await apiFetch<ArmadaUser[]>('/api/users');
      _syncCache = users;
      return users;
    },
  });
}

/* ── Resolver ──────────────────────────────────────────────────────── */

export interface ResolvedUser {
  displayName: string;
  avatar: string | null;
  role: string;
}

/**
 * Resolve a user by ID or username synchronously against the cached list.
 * Returns a fallback if not found.
 */
export function resolveUser(idOrName: string): ResolvedUser {
  const users = _syncCache ?? [];
  const user = users.find(u => u.id === idOrName || u.name === idOrName);
  if (user) {
    return {
      displayName: user.displayName,
      avatar: user.avatarUrl,
      role: user.role,
    };
  }
  return {
    displayName: idOrName,
    avatar: null,
    role: 'unknown',
  };
}

/**
 * Invalidate the sync cache. React-query invalidation must be done via
 * queryClient.invalidateQueries({ queryKey: ['users'] }) in components.
 */
export function invalidateUsersCache() {
  _syncCache = null;
}

/**
 * No-op: pre-warming is handled automatically by react-query when the hook
 * is first mounted. Kept for backward compatibility.
 */
export function prewarmUsers(): void {
  // no-op
}
