import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../useApi';

export function useIntegrations() {
  return useQuery({
    queryKey: ['integrations'],
    queryFn: () => apiFetch<any[]>('/api/integrations'),
  });
}
