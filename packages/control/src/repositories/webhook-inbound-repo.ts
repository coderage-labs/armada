import { eq, sql } from 'drizzle-orm';
import { getDrizzle } from '../db/drizzle.js';
import { webhooksInbound } from '../db/drizzle-schema.js';

export interface WebhookInbound {
  id: string;
  name: string;
  hookId: string;
  secret: string | null;
  action: string;
  actionConfig: Record<string, any>;
  enabled: boolean;
  lastDeliveryAt: string | null;
  deliveryCount: number;
  createdAt: string;
}

function rowToWebhookInbound(r: typeof webhooksInbound.$inferSelect): WebhookInbound {
  return {
    id: r.id,
    name: r.name,
    hookId: r.hookId,
    secret: r.secret ?? null,
    action: r.action,
    actionConfig: JSON.parse(r.actionConfig ?? '{}'),
    enabled: r.enabled === 1,
    lastDeliveryAt: r.lastDeliveryAt ?? null,
    deliveryCount: r.deliveryCount,
    createdAt: r.createdAt,
  };
}

export const webhooksInboundRepo = {
  getAll(): WebhookInbound[] {
    return getDrizzle()
      .select()
      .from(webhooksInbound)
      .orderBy(webhooksInbound.createdAt)
      .all()
      .map(rowToWebhookInbound);
  },

  get(id: string): WebhookInbound | null {
    const row = getDrizzle()
      .select()
      .from(webhooksInbound)
      .where(eq(webhooksInbound.id, id))
      .get();
    return row ? rowToWebhookInbound(row) : null;
  },

  getByHookId(hookId: string): WebhookInbound | null {
    const row = getDrizzle()
      .select()
      .from(webhooksInbound)
      .where(eq(webhooksInbound.hookId, hookId))
      .get();
    return row ? rowToWebhookInbound(row) : null;
  },

  create(data: {
    name: string;
    hookId: string;
    secret?: string;
    action: string;
    actionConfig?: Record<string, any>;
  }): WebhookInbound {
    const id = crypto.randomUUID();
    getDrizzle().insert(webhooksInbound).values({
      id,
      name: data.name,
      hookId: data.hookId,
      secret: data.secret ?? null,
      action: data.action,
      actionConfig: JSON.stringify(data.actionConfig ?? {}),
    }).run();
    return rowToWebhookInbound(
      getDrizzle().select().from(webhooksInbound).where(eq(webhooksInbound.id, id)).get()!,
    );
  },

  update(id: string, data: Partial<{
    name: string;
    secret: string | null;
    action: string;
    actionConfig: Record<string, any>;
    enabled: boolean;
  }>): WebhookInbound {
    const updates: Partial<typeof webhooksInbound.$inferInsert> = {};
    if (data.name !== undefined) updates.name = data.name;
    if (data.secret !== undefined) updates.secret = data.secret;
    if (data.action !== undefined) updates.action = data.action;
    if (data.actionConfig !== undefined) updates.actionConfig = JSON.stringify(data.actionConfig);
    if (data.enabled !== undefined) updates.enabled = data.enabled ? 1 : 0;

    if (Object.keys(updates).length > 0) {
      getDrizzle().update(webhooksInbound).set(updates).where(eq(webhooksInbound.id, id)).run();
    }
    return webhooksInboundRepo.get(id)!;
  },

  delete(id: string): void {
    getDrizzle().delete(webhooksInbound).where(eq(webhooksInbound.id, id)).run();
  },

  recordDelivery(id: string): void {
    getDrizzle()
      .update(webhooksInbound)
      .set({
        lastDeliveryAt: new Date().toISOString(),
        deliveryCount: sql`${webhooksInbound.deliveryCount} + 1`,
      })
      .where(eq(webhooksInbound.id, id))
      .run();
  },
};
