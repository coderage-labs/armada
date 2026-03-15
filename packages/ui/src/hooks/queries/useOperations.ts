import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../useApi';

export function useOperations() {
  return useQuery({
    queryKey: ['operations'],
    queryFn: () => apiFetch('/api/operations'),
  });
}
