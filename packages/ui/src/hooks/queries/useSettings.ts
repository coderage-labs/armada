import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../useApi';

export function useSettings() {
  return useQuery({
    queryKey: ['settings'],
    queryFn: () => apiFetch('/api/settings'),
  });
}

export function useUpdateSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: any) =>
      apiFetch('/api/settings', { method: 'PATCH', body: JSON.stringify(data) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
  });
}
