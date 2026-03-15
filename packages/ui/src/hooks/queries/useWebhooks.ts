import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../useApi';
import type { WebhookDelivery, WebhookMetrics } from '@coderage-labs/armada-shared';

export function useWebhooks() {
  return useQuery({
    queryKey: ['webhooks'],
    queryFn: () => apiFetch<any[]>('/api/webhooks'),
  });
}

export function useInboundWebhooks() {
  return useQuery({
    queryKey: ['inbound-webhooks'],
    queryFn: () => apiFetch<any[]>('/api/webhooks/inbound'),
  });
}

export function useWebhookMetrics(webhookId: string | null) {
  return useQuery({
    queryKey: ['webhook-metrics', webhookId],
    queryFn: () => apiFetch<WebhookMetrics>(`/api/webhooks/${webhookId}/metrics`),
    enabled: !!webhookId,
  });
}

export function useWebhookDeliveries(webhookId: string | null, limit = 20) {
  return useQuery({
    queryKey: ['webhook-deliveries', webhookId, limit],
    queryFn: () => apiFetch<WebhookDelivery[]>(`/api/webhooks/${webhookId}/deliveries?limit=${limit}`),
    enabled: !!webhookId,
  });
}
