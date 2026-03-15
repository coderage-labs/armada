import { eq } from 'drizzle-orm';
import { getDrizzle } from '../db/drizzle.js';
import { webhooks } from '../db/drizzle-schema.js';
import type { Webhook } from '@coderage-labs/armada-shared';

function rowToWebhook(r: typeof webhooks.$inferSelect): Webhook {
  return {
    id: r.id,
    url: r.url,
    events: r.events,
    secret: r.secret,
    enabled: r.enabled === 1,
    createdAt: r.createdAt,
  };
}

export const webhooksRepo = {
  getAll(): Webhook[] {
    return getDrizzle().select().from(webhooks).orderBy(webhooks.createdAt).all().map(rowToWebhook);
  },

  get(id: string): Webhook | null {
    const row = getDrizzle().select().from(webhooks).where(eq(webhooks.id, id)).get();
    return row ? rowToWebhook(row) : null;
  },

  create(data: { url: string; events?: string; secret?: string }): Webhook {
    const id = crypto.randomUUID();
    getDrizzle().insert(webhooks).values({
      id,
      url: data.url,
      events: data.events ?? '*',
      secret: data.secret ?? null,
    }).run();
    return rowToWebhook(getDrizzle().select().from(webhooks).where(eq(webhooks.id, id)).get()!);
  },

  update(id: string, data: Partial<{ url: string; events: string; secret: string | null; enabled: boolean }>): Webhook {
    const existing = webhooksRepo.get(id);
    if (!existing) throw new Error(`Webhook not found: ${id}`);

    const updates: Partial<typeof webhooks.$inferInsert> = {};
    if (data.url !== undefined) updates.url = data.url;
    if (data.events !== undefined) updates.events = data.events;
    if (data.secret !== undefined) updates.secret = data.secret;
    if (data.enabled !== undefined) updates.enabled = data.enabled ? 1 : 0;

    if (Object.keys(updates).length > 0) {
      getDrizzle().update(webhooks).set(updates).where(eq(webhooks.id, id)).run();
    }

    return webhooksRepo.get(id)!;
  },

  delete(id: string): void {
    getDrizzle().delete(webhooks).where(eq(webhooks.id, id)).run();
  },

  getForEvent(event: string): Webhook[] {
    return getDrizzle()
      .select().from(webhooks)
      .where(eq(webhooks.enabled, 1))
      .all()
      .map(rowToWebhook)
      .filter(h => {
        if (h.events === '*') return true;
        const subscribed = h.events.split(',').map(e => e.trim());
        return subscribed.includes(event);
      });
  },
};
