import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../useApi';

interface DraftStatus {
  hasChanges: boolean;
  entityCount: number;
  refs: Array<{ type: string; id: string }>;
}

export function useDraftStatus() {
  return useQuery({
    queryKey: ['draft', 'status'],
    queryFn: () => apiFetch<DraftStatus>('/api/draft/status'),
  });
}

interface DraftDiff {
  hasChanges: boolean;
  entityCount: number;
  diffs: Array<{
    type: string;
    id: string;
    action: 'create' | 'update' | 'delete';
    fields: Record<string, any> | null;
  }>;
}

export function useDraftDiff() {
  return useQuery({
    queryKey: ['draft', 'diff'],
    queryFn: () => apiFetch<DraftDiff>('/api/draft/diff'),
  });
}
