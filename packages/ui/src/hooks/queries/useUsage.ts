import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../useApi';

export type UsagePeriod = 'day' | 'week' | 'month' | 'all';

export interface UsageSummary {
  period: UsagePeriod;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  requestCount: number;
}

export interface UsageByDimension {
  key: string;
  label: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  requestCount: number;
}

export interface UsageByDimensionResult {
  period: UsagePeriod;
  rows: UsageByDimension[];
}

export function useUsageSummary(period: UsagePeriod = 'month') {
  return useQuery({
    queryKey: ['usage', 'summary', period],
    queryFn: () => apiFetch<UsageSummary>(`/api/usage/summary?period=${period}`),
    refetchInterval: 60_000,
  });
}

export function useUsageByProvider(period: UsagePeriod = 'month') {
  return useQuery({
    queryKey: ['usage', 'by-provider', period],
    queryFn: () => apiFetch<UsageByDimensionResult>(`/api/usage/by-provider?period=${period}`),
    refetchInterval: 60_000,
  });
}

export function useUsageByAgent(period: UsagePeriod = 'month') {
  return useQuery({
    queryKey: ['usage', 'by-agent', period],
    queryFn: () => apiFetch<UsageByDimensionResult>(`/api/usage/by-agent?period=${period}`),
    refetchInterval: 60_000,
  });
}

export function useUsageByKey(keyId: string, period: UsagePeriod = 'month') {
  return useQuery({
    queryKey: ['usage', 'by-key', keyId, period],
    queryFn: () => apiFetch<any>(`/api/usage/by-key/${encodeURIComponent(keyId)}?period=${period}`),
    enabled: !!keyId,
    refetchInterval: 60_000,
  });
}
