import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../useApi';

export function useTasks() {
  return useQuery({
    queryKey: ['tasks'],
    queryFn: () => apiFetch('/api/tasks'),
  });
}
