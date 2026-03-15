import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../useApi';

export interface PluginVersionEntry {
  name: string;
  libraryVersion: string | null;
  instances: Array<{ name: string; installedVersion: string; outdated: boolean }>;
}

export function usePluginVersions() {
  return useQuery({
    queryKey: ['plugin-versions'],
    queryFn: () => apiFetch<{ plugins: PluginVersionEntry[] }>('/api/system/plugin-versions'),
    staleTime: 30_000,
  });
}
