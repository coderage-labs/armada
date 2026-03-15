import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../useApi';

export function usePlugins() {
  return useQuery({
    queryKey: ['plugins'],
    queryFn: () => apiFetch<any[]>('/api/plugins/library'),
  });
}
