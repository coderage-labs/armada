import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../useApi';

export interface NotificationChannel {
  id: string;
  type: 'telegram' | 'slack' | 'discord' | 'email';
  name: string;
  enabled: boolean;
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export function useNotificationChannels() {
  return useQuery({
    queryKey: ['notification-channels'],
    queryFn: () => apiFetch<NotificationChannel[]>('/api/notification-channels'),
  });
}

export function useCreateNotificationChannel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Omit<NotificationChannel, 'id' | 'createdAt' | 'updatedAt'>) =>
      apiFetch<NotificationChannel>('/api/notification-channels', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notification-channels'] }),
  });
}

export function useUpdateNotificationChannel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: Partial<NotificationChannel> & { id: string }) =>
      apiFetch<NotificationChannel>(`/api/notification-channels/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notification-channels'] }),
  });
}

export function useDeleteNotificationChannel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ success: boolean }>(`/api/notification-channels/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notification-channels'] }),
  });
}

export function useTestNotificationChannel() {
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ success: boolean; message: string }>(`/api/notification-channels/${id}/test`, {
        method: 'POST',
      }),
  });
}
