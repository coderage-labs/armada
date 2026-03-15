import { eq, desc, sql } from 'drizzle-orm';
import { getDrizzle } from '../db/drizzle.js';
import { webhookDeliveries } from '../db/drizzle-schema.js';
import type { WebhookDelivery, WebhookMetrics } from '@coderage-labs/armada-shared';

function rowToDelivery(r: typeof webhookDeliveries.$inferSelect): WebhookDelivery {
  return {
    id: r.id,
    webhookId: r.webhookId,
    eventType: r.eventType,
    status: r.status as WebhookDelivery['status'],
    statusCode: r.statusCode ?? null,
    responseBody: r.responseBody ?? null,
    payload: r.payload ?? null,
    attempt: r.attempt ?? 1,
    error: r.error ?? null,
    latencyMs: r.latencyMs ?? null,
    createdAt: r.createdAt,
    completedAt: r.completedAt ?? null,
  };
}

export const webhookDeliveryRepo = {
  create(data: {
    id: string;
    webhookId: string;
    eventType: string;
    status: string;
    statusCode?: number | null;
    responseBody?: string | null;
    payload?: string | null;
    attempt?: number;
    error?: string | null;
    latencyMs?: number | null;
    completedAt?: string | null;
  }): void {
    getDrizzle().insert(webhookDeliveries).values({
      id: data.id,
      webhookId: data.webhookId,
      eventType: data.eventType,
      status: data.status,
      statusCode: data.statusCode ?? null,
      responseBody: data.responseBody ?? null,
      payload: data.payload ?? null,
      attempt: data.attempt ?? 1,
      error: data.error ?? null,
      latencyMs: data.latencyMs ?? null,
      completedAt: data.completedAt ?? null,
    }).run();
  },

  get(id: string): WebhookDelivery | null {
    const row = getDrizzle()
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.id, id))
      .get();
    return row ? rowToDelivery(row) : null;
  },

  getRecent(webhookId: string, limit = 20): WebhookDelivery[] {
    return getDrizzle()
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.webhookId, webhookId))
      .orderBy(desc(webhookDeliveries.createdAt))
      .limit(limit)
      .all()
      .map(rowToDelivery);
  },

  getMetrics(webhookId: string): WebhookMetrics {
    const db = getDrizzle();

    const rows = db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.webhookId, webhookId))
      .all();

    const total = rows.length;
    const success = rows.filter(r => r.status === 'success').length;
    const failed = rows.filter(r => r.status === 'failed').length;
    const successRate = total > 0 ? Math.round((success / total) * 1000) / 10 : 0;

    const latencies = rows.filter(r => r.latencyMs != null).map(r => r.latencyMs as number);
    const avgLatencyMs = latencies.length > 0
      ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
      : null;

    const sorted = [...rows].sort((a, b) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
    const lastDelivery = sorted[0]?.createdAt ?? null;

    return { total, success, failed, successRate, avgLatencyMs, lastDelivery };
  },
};
