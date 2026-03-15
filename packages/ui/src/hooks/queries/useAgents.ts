import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../useApi';

export function useAgent(name: string) {
  return useQuery({
    queryKey: ['agents', name],
    queryFn: () => apiFetch<any>(`/api/agents/${name}`),
    enabled: !!name,
  });
}

export function useAgents() {
  return useQuery({
    queryKey: ['agents'],
    queryFn: () => apiFetch('/api/agents'),
  });
}

export function useSpawnAgent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: any) =>
      apiFetch('/api/agents', { method: 'POST', body: JSON.stringify(data) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agents'] });
    },
  });
}

export function useDeleteAgent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      apiFetch(`/api/agents/${name}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agents'] });
    },
  });
}
