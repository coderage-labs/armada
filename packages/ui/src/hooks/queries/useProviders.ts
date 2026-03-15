import { useQuery } from '@tanstack/react-query';
import type { ModelProvider } from '@coderage-labs/armada-shared';
import { apiFetch } from '../useApi';

export function useProviders() {
  return useQuery({
    queryKey: ['providers'],
    queryFn: () => apiFetch<(ModelProvider & { configured: boolean })[]>('/api/providers'),
  });
}
