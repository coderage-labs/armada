import { useState, useEffect, useCallback, useRef } from 'react';
import { apiFetch } from './useApi';
import { useSSEAll } from '../providers/SSEProvider';
import type { Operation } from '@coderage-labs/armada-shared';

interface UseOperationsResult {
  active: Operation[];
  recent: Operation[];
  loading: boolean;
  refresh: () => void;
}

/**
 * Fetch armada operations list. Refreshes via SSE events (no polling).
 */
export function useOperations(): UseOperationsResult {
  const [active, setActive] = useState<Operation[]>([]);
  const [recent, setRecent] = useState<Operation[]>([]);
  const [loading, setLoading] = useState(true);
  const mountedRef = useRef(true);

  const fetchAll = useCallback(async () => {
    try {
      const all = await apiFetch<Operation[]>('/api/operations').catch(() => [] as Operation[]);

      if (!mountedRef.current) return;

      const activeOps = all.filter(op => op.status === 'running' || op.status === 'pending');
      const recentOps = all.filter(op => op.status !== 'running' && op.status !== 'pending');

      setActive(activeOps);
      setRecent(recentOps);
    } catch {
      // silently ignore
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  // Initial load
  useEffect(() => {
    mountedRef.current = true;
    fetchAll();
    return () => { mountedRef.current = false; };
  }, [fetchAll]);

  // Refetch on operation/changeset SSE events
  useSSEAll(useCallback((type: string) => {
    if (type.startsWith('operation.') || type.startsWith('changeset.') || type.startsWith('task.')) {
      fetchAll();
    }
  }, [fetchAll]));

  return { active, recent, loading, refresh: fetchAll };
}
