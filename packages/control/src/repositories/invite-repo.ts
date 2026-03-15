import { eq, desc, sql } from 'drizzle-orm';
import { getDrizzle } from '../db/drizzle.js';
import { invites } from '../db/drizzle-schema.js';

export const inviteRepo = {
  create(data: { id: string; tokenHash: string; createdBy: string; role: string; displayName?: string | null; expiresAt: string }) {
    getDrizzle().insert(invites).values({
      id: data.id,
      tokenHash: data.tokenHash,
      createdBy: data.createdBy,
      role: data.role,
      displayName: data.displayName || null,
      expiresAt: data.expiresAt,
    }).run();
  },

  listAll() {
    return getDrizzle()
      .select({
        id: invites.id,
        createdBy: invites.createdBy,
        role: invites.role,
        displayName: invites.displayName,
        expiresAt: invites.expiresAt,
        usedAt: invites.usedAt,
        usedBy: invites.usedBy,
        createdAt: invites.createdAt,
      })
      .from(invites)
      .orderBy(desc(invites.createdAt))
      .all();
  },

  findByTokenHash(hash: string) {
    return getDrizzle()
      .select({
        id: invites.id,
        role: invites.role,
        displayName: invites.displayName,
        expiresAt: invites.expiresAt,
        usedAt: invites.usedAt,
      })
      .from(invites)
      .where(eq(invites.tokenHash, hash))
      .get();
  },

  findById(id: string) {
    return getDrizzle()
      .select({
        id: invites.id,
        usedAt: invites.usedAt,
      })
      .from(invites)
      .where(eq(invites.id, id))
      .get();
  },

  markUsed(id: string, userId: string) {
    getDrizzle()
      .update(invites)
      .set({ usedAt: sql`strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`, usedBy: userId })
      .where(eq(invites.id, id))
      .run();
  },

  deleteById(id: string) {
    getDrizzle().delete(invites).where(eq(invites.id, id)).run();
  },
};
