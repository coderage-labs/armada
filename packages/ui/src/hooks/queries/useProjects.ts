import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../useApi';

export function useProjects() {
  return useQuery({
    queryKey: ['projects'],
    queryFn: () => apiFetch('/api/projects'),
  });
}

export function useProject(id: string | undefined) {
  return useQuery({
    queryKey: ['projects', id],
    queryFn: () => apiFetch(`/api/projects/${id}`),
    enabled: !!id,
  });
}
