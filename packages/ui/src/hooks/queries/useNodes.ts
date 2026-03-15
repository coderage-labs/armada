import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../useApi';

interface NodeData {
  id: string;
  hostname: string;
  cores: number;
  memory: number;
  status: 'online' | 'offline' | 'degraded';
  wsStatus: 'online' | 'offline' | 'stale';
  agentCount: number;
  url?: string;
  token?: string;
  liveStats?: any;
}

export function useNode(id: string) {
  return useQuery({
    queryKey: ['nodes', id],
    queryFn: () => apiFetch<any>(`/api/nodes/${id}`),
    enabled: !!id,
  });
}

export function useNodes() {
  return useQuery({
    queryKey: ['nodes'],
    queryFn: () => apiFetch<NodeData[]>('/api/nodes'),
  });
}

export function useCreateNode() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { hostname: string; url: string; token: string }) =>
      apiFetch('/api/nodes', { method: 'POST', body: JSON.stringify(data) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['nodes'] });
    },
  });
}

export function useUpdateNode() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<NodeData> }) =>
      apiFetch(`/api/nodes/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['nodes'] });
    },
  });
}

export function useDeleteNode() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/api/nodes/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['nodes'] });
    },
  });
}


