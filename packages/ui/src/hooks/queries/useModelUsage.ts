import { useQuery } from '@tanstack/react-query';
import type { ModelUsageDetail } from '@coderage-labs/armada-shared';
import { apiFetch } from '../useApi';
import type { UsagePeriod } from './useUsage';

export interface ModelUsageResponse extends ModelUsageDetail {
  period: UsagePeriod;
  modelId: string;
}

export function useModelUsage(modelId: string | null, period: UsagePeriod = 'week') {
  return useQuery({
    queryKey: ['models', modelId, 'usage', period],
    queryFn: () => apiFetch<ModelUsageResponse>(`/api/models/${modelId}/usage?period=${period}`),
    enabled: !!modelId,
    refetchInterval: 60_000,
  });
}
