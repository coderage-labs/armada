import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../useApi';
import type { Changeset } from '@coderage-labs/armada-shared';

const ACTIVE_STATUSES = ['draft', 'approved', 'applying', 'failed'];

export function useChangesets(limit = 20) {
  return useQuery({
    queryKey: ['changesets'],
    queryFn: () => apiFetch<Changeset[]>(`/api/changesets?limit=${limit}`),
  });
}

/** Returns the most recent active changeset (draft/approved/applying), or null */
export function useActiveChangeset() {
  return useQuery({
    queryKey: ['changesets', 'active'],
    queryFn: () => apiFetch<Changeset[]>('/api/changesets?limit=5'),
    select: (data) => {
      // Find most recent active changeset
      const active = data.find(cs => ACTIVE_STATUSES.includes(cs.status));
      if (active) return active;
      // If none active, check for recently completed/failed (for brief display)
      const recent = data.find(cs => cs.status === 'completed' || cs.status === 'failed');
      return recent ?? null;
    },
    // Poll slightly faster since this is the global status indicator
    refetchInterval: false, // SSE handles real-time updates
  });
}
