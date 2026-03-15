import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { getDrizzle } from '../db/drizzle.js';
import { notificationChannels } from '../db/drizzle-schema.js';

export type NotificationChannelType = 'telegram' | 'slack' | 'discord' | 'email';

export interface NotificationChannel {
  id: string;
  type: NotificationChannelType;
  name: string;
  enabled: boolean;
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CreateNotificationChannelData {
  type: NotificationChannelType;
  name: string;
  enabled?: boolean;
  config: Record<string, unknown>;
}

export interface UpdateNotificationChannelData {
  type?: NotificationChannelType;
  name?: string;
  enabled?: boolean;
  config?: Record<string, unknown>;
}

type ChannelRow = typeof notificationChannels.$inferSelect;

function rowToChannel(r: ChannelRow): NotificationChannel {
  let config: Record<string, unknown> = {};
  try { config = JSON.parse(r.config); } catch { /* ignore */ }
  return {
    id: r.id,
    type: r.type as NotificationChannelType,
    name: r.name,
    enabled: r.enabled === 1,
    config,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export const notificationChannelRepo = {
  findById(id: string): NotificationChannel | null {
    const row = getDrizzle()
      .select()
      .from(notificationChannels)
      .where(eq(notificationChannels.id, id))
      .get();
    return row ? rowToChannel(row) : null;
  },

  findAll(): NotificationChannel[] {
    return getDrizzle().select().from(notificationChannels).all().map(rowToChannel);
  },

  /** Returns all enabled channels. */
  getEnabled(): NotificationChannel[] {
    return getDrizzle()
      .select()
      .from(notificationChannels)
      .where(eq(notificationChannels.enabled, 1))
      .all()
      .map(rowToChannel);
  },

  /** Filter by channel type. */
  getByType(type: NotificationChannelType): NotificationChannel[] {
    return getDrizzle()
      .select()
      .from(notificationChannels)
      .where(eq(notificationChannels.type, type))
      .all()
      .map(rowToChannel);
  },

  create(data: CreateNotificationChannelData): NotificationChannel {
    const id = randomUUID();
    getDrizzle()
      .insert(notificationChannels)
      .values({
        id,
        type: data.type,
        name: data.name,
        enabled: (data.enabled ?? true) ? 1 : 0,
        config: JSON.stringify(data.config),
      })
      .run();
    return this.findById(id)!;
  },

  update(id: string, data: UpdateNotificationChannelData): NotificationChannel | null {
    const existing = this.findById(id);
    if (!existing) return null;

    const patch: Partial<ChannelRow> = {
      updatedAt: sql`datetime('now')` as unknown as string,
    };
    if (data.type !== undefined) patch.type = data.type;
    if (data.name !== undefined) patch.name = data.name;
    if (data.enabled !== undefined) patch.enabled = data.enabled ? 1 : 0;
    if (data.config !== undefined) patch.config = JSON.stringify(data.config);

    getDrizzle()
      .update(notificationChannels)
      .set(patch)
      .where(eq(notificationChannels.id, id))
      .run();
    return this.findById(id)!;
  },

  delete(id: string): boolean {
    const result = getDrizzle()
      .delete(notificationChannels)
      .where(eq(notificationChannels.id, id))
      .run();
    return result.changes > 0;
  },
};
