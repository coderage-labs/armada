import { webhooksRepo } from '../repositories/index.js';
import { webhookDeliveryRepo } from '../repositories/webhook-delivery-repo.js';
import crypto from 'node:crypto';
import type { Webhook } from '@coderage-labs/armada-shared';

export async function dispatchWebhook(event: string, payload: any) {
  const hooks = webhooksRepo.getForEvent(event);

  for (const hook of hooks) {
    // Fire and forget — don't block on webhook delivery
    deliverWebhook(hook, event, payload).catch(() => {});
  }
}

/**
 * Deliver a webhook payload and return the outcome.
 * Used both by fire-and-forget dispatch and by the retry endpoint.
 */
export async function deliverWebhookRaw(
  hook: Webhook,
  event: string,
  payload: any,
): Promise<{ success: boolean; statusCode?: number; responseBody?: string; error?: string; latencyMs: number }> {
  const body = JSON.stringify({ event, payload, timestamp: new Date().toISOString() });
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };

  if (hook.secret) {
    const signature = crypto.createHmac('sha256', hook.secret).update(body).digest('hex');
    headers['X-Armada-Signature'] = `sha256=${signature}`;
  }

  const start = Date.now();
  try {
    const response = await fetch(hook.url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(10_000),
    });
    const latencyMs = Date.now() - start;
    const responseBody = await response.text().catch(() => '');
    return {
      success: response.ok,
      statusCode: response.status,
      responseBody: responseBody.slice(0, 2000), // cap stored response
      latencyMs,
    };
  } catch (err: any) {
    const latencyMs = Date.now() - start;
    return { success: false, error: err?.message ?? 'Delivery failed', latencyMs };
  }
}

async function deliverWebhook(hook: Webhook, event: string, payload: any, attempt = 1) {
  const result = await deliverWebhookRaw(hook, event, payload);

  webhookDeliveryRepo.create({
    id: crypto.randomUUID(),
    webhookId: hook.id,
    eventType: event,
    status: result.success ? 'success' : 'failed',
    statusCode: result.statusCode ?? null,
    responseBody: result.responseBody ?? null,
    error: result.error ?? null,
    latencyMs: result.latencyMs,
    payload: JSON.stringify(payload),
    attempt,
    completedAt: new Date().toISOString(),
  });
}

/**
 * Retry a specific delivery — re-dispatches the stored payload and logs a new delivery record.
 */
export async function retryDelivery(hook: Webhook, originalDelivery: {
  id: string;
  eventType: string;
  payload: string | null;
  attempt: number;
}): Promise<void> {
  let payload: any = {};
  try {
    if (originalDelivery.payload) {
      payload = JSON.parse(originalDelivery.payload);
    }
  } catch {
    // keep empty payload
  }

  await deliverWebhook(hook, originalDelivery.eventType, payload, originalDelivery.attempt + 1);
}
