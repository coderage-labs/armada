import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../useApi';

export function useLogs(params?: Record<string, string>) {
  const search = params ? '?' + new URLSearchParams(params).toString() : '';
  return useQuery({
    queryKey: ['logs', params],
    queryFn: () => apiFetch<any[]>(`/api/logs${search}`),
    enabled: !!params && Object.keys(params).length > 0,
  });
}
