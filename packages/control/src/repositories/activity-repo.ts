import { eq, like, desc, sql } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { getDrizzle } from '../db/drizzle.js';
import { activity, roleMetadata } from '../db/drizzle-schema.js';
import type { ActivityEvent, RoleMetadata } from '@coderage-labs/armada-shared';

// ── Row → domain mappers ────────────────────────────────────────────

function rowToActivity(r: typeof activity.$inferSelect): ActivityEvent {
  return {
    id: r.id,
    eventType: r.eventType,
    action: r.eventType.includes('.') ? r.eventType.split('.').pop()! : r.eventType,
    agentName: r.agentName,
    detail: r.detail,
    metadata: r.metadata,
    createdAt: r.createdAt,
  };
}

function rowToRoleMeta(r: typeof roleMetadata.$inferSelect): RoleMetadata {
  return {
    role: r.role,
    color: r.color,
    description: r.description,
    tier: r.tier,
    icon: r.icon,
  };
}

// ── Activity Repository ─────────────────────────────────────────────

export const activityRepo = {
  create(data: { eventType: string; agentName?: string; detail?: string; metadata?: string }): ActivityEvent {
    const id = uuidv4();
    getDrizzle().insert(activity).values({
      id,
      eventType: data.eventType,
      agentName: data.agentName ?? null,
      detail: data.detail ?? null,
      metadata: data.metadata ?? null,
    }).run();
    return rowToActivity(getDrizzle().select().from(activity).where(eq(activity.id, id)).get()!);
  },

  getRecent(limit = 50): ActivityEvent[] {
    return getDrizzle()
      .select().from(activity)
      .orderBy(desc(activity.createdAt))
      .limit(limit)
      .all()
      .map(rowToActivity);
  },

  getByAgent(name: string, limit = 50): ActivityEvent[] {
    return getDrizzle()
      .select().from(activity)
      .where(eq(activity.agentName, name))
      .orderBy(desc(activity.createdAt))
      .limit(limit)
      .all()
      .map(rowToActivity);
  },

  getByType(eventType: string, limit = 50): ActivityEvent[] {
    return getDrizzle()
      .select().from(activity)
      .where(like(activity.eventType, `${eventType}%`))
      .orderBy(desc(activity.createdAt))
      .limit(limit)
      .all()
      .map(rowToActivity);
  },
};

// ── Role Metadata Repository ────────────────────────────────────────

export const roleMetaRepo = {
  getAll(): RoleMetadata[] {
    return getDrizzle()
      .select().from(roleMetadata)
      .orderBy(roleMetadata.tier, roleMetadata.role)
      .all()
      .map(rowToRoleMeta);
  },

  get(role: string): RoleMetadata | null {
    const row = getDrizzle().select().from(roleMetadata).where(eq(roleMetadata.role, role)).get();
    return row ? rowToRoleMeta(row) : null;
  },

  upsert(role: string, data: { color?: string; description?: string; tier?: number; icon?: string | null }): void {
    // Use raw SQL for the complex upsert logic
    const db = getDrizzle();
    db.run(sql`
      INSERT INTO role_metadata (role, color, description, tier, icon, allowed_tools)
      VALUES (${role}, ${data.color ?? '#6b7280'}, ${data.description ?? ''}, ${data.tier ?? 2}, ${data.icon ?? null}, NULL)
      ON CONFLICT(role) DO UPDATE SET
        color = COALESCE(${data.color ?? null}, color),
        description = COALESCE(${data.description ?? null}, description),
        tier = COALESCE(${data.tier ?? null}, tier),
        icon = ${data.icon !== undefined ? (data.icon ?? null) : null}
    `);
  },

  delete(role: string): boolean {
    const result = getDrizzle().delete(roleMetadata).where(eq(roleMetadata.role, role)).run();
    return result.changes > 0;
  },
};
