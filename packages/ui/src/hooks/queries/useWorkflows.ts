import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../useApi';

export function useWorkflows() {
  return useQuery({
    queryKey: ['workflows'],
    queryFn: () => apiFetch('/api/workflows'),
  });
}

export function useWorkflow(id: string | undefined) {
  return useQuery({
    queryKey: ['workflows', id],
    queryFn: () => apiFetch(`/api/workflows/${id}`),
    enabled: !!id,
  });
}
