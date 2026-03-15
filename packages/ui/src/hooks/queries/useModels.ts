import { useQuery } from '@tanstack/react-query';
import type { ModelRegistryEntryWithUsage } from '@coderage-labs/armada-shared';
import { apiFetch } from '../useApi';
import type { UsagePeriod } from './useUsage';

export function useModels(period: UsagePeriod = 'all') {
  return useQuery({
    queryKey: ['models', period],
    queryFn: () => apiFetch<ModelRegistryEntryWithUsage[]>(`/api/models?period=${period}`),
  });
}
