import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../useApi';

export function useActivity() {
  return useQuery({
    queryKey: ['activity'],
    queryFn: () => apiFetch<any[]>('/api/activity'),
  });
}
