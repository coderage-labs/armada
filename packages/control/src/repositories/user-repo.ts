import { eq } from 'drizzle-orm';
import { getDrizzle } from '../db/drizzle.js';
import { users } from '../db/drizzle-schema.js';
import type { ArmadaUser } from '@coderage-labs/armada-shared';
import { parseJsonWithSchema, linkedAccountsSchema, notificationsSchema, defaultNotifications } from '../utils/json-schemas.js';

function rowToUser(r: typeof users.$inferSelect): ArmadaUser {
  const linkedAccounts = parseJsonWithSchema('[user-repo] linkedAccounts', r.linkedAccountsJson, linkedAccountsSchema, {}) as ArmadaUser['linkedAccounts'];
  const notifications = parseJsonWithSchema('[user-repo] notifications', r.notificationsJson, notificationsSchema, defaultNotifications()) as ArmadaUser['notifications'];
  return {
    id: r.id,
    name: r.name,
    displayName: r.displayName,
    type: r.type as ArmadaUser['type'],
    role: r.role as ArmadaUser['role'],
    avatarUrl: r.avatarUrl,
    avatarGenerating: !!r.avatarGenerating,
    avatarVersion: r.avatarVersion ?? 0,
    linkedAccounts,
    notifications,
    createdAt: r.createdAt,
  };
}

export const usersRepo = {
  getAll(): ArmadaUser[] {
    return getDrizzle().select().from(users).orderBy(users.createdAt).all().map(rowToUser);
  },

  getById(id: string): ArmadaUser | null {
    const row = getDrizzle().select().from(users).where(eq(users.id, id)).get();
    return row ? rowToUser(row) : null;
  },

  getByName(name: string): ArmadaUser | null {
    const row = getDrizzle().select().from(users).where(eq(users.name, name)).get();
    return row ? rowToUser(row) : null;
  },

  create(data: { name: string; displayName: string; type?: string; role?: string; avatarUrl?: string | null; linkedAccounts?: Record<string, any>; notifications?: Record<string, any> }): ArmadaUser {
    const id = crypto.randomUUID();
    getDrizzle().insert(users).values({
      id,
      name: data.name,
      displayName: data.displayName,
      type: data.type ?? 'operator',
      role: data.role ?? 'viewer',
      avatarUrl: data.avatarUrl ?? null,
      linkedAccountsJson: JSON.stringify(data.linkedAccounts ?? {}),
      notificationsJson: JSON.stringify(data.notifications ?? { channels: [], preferences: { gates: false, completions: false, failures: false } }),
    }).run();
    return usersRepo.getById(id)!;
  },

  update(id: string, data: Partial<{ name: string; displayName: string; type: string; role: string; avatarUrl: string | null; avatarGenerating: number; avatarVersion: number; linkedAccounts: Record<string, any>; notifications: Record<string, any> }>): ArmadaUser {
    const existing = usersRepo.getById(id);
    if (!existing) throw new Error(`User not found: ${id}`);

    const updates: Partial<typeof users.$inferInsert> = {};
    if (data.name !== undefined) updates.name = data.name;
    if (data.displayName !== undefined) updates.displayName = data.displayName;
    if (data.type !== undefined) updates.type = data.type;
    if (data.role !== undefined) updates.role = data.role;
    if (data.avatarUrl !== undefined) updates.avatarUrl = data.avatarUrl;
    if (data.avatarGenerating !== undefined) updates.avatarGenerating = data.avatarGenerating;
    if (data.avatarVersion !== undefined) updates.avatarVersion = data.avatarVersion;
    if (data.linkedAccounts !== undefined) updates.linkedAccountsJson = JSON.stringify(data.linkedAccounts);
    if (data.notifications !== undefined) updates.notificationsJson = JSON.stringify(data.notifications);

    if (Object.keys(updates).length > 0) {
      getDrizzle().update(users).set(updates).where(eq(users.id, id)).run();
    }

    return usersRepo.getById(id)!;
  },

  delete(id: string): void {
    getDrizzle().delete(users).where(eq(users.id, id)).run();
  },
};
