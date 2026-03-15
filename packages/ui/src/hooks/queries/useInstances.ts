import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../useApi';

export function useInstances() {
  return useQuery({
    queryKey: ['instances'],
    queryFn: () => apiFetch('/api/instances'),
  });
}
