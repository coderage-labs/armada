import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../useApi';

export function useHierarchy() {
  return useQuery({
    queryKey: ['hierarchy'],
    queryFn: () => apiFetch<any>('/api/hierarchy'),
  });
}
