import { eq, and, sql } from 'drizzle-orm';
import { getDrizzle } from '../db/drizzle.js';
import { passkeys } from '../db/drizzle-schema.js';

export const passkeyRepo = {
  listByUser(userId: string) {
    return getDrizzle()
      .select({
        id: passkeys.id,
        credentialId: passkeys.credentialId,
        label: passkeys.label,
        createdAt: passkeys.createdAt,
      })
      .from(passkeys)
      .where(eq(passkeys.userId, userId))
      .all();
  },

  getCredentialIdsByUser(userId: string) {
    return getDrizzle()
      .select({ credentialId: passkeys.credentialId })
      .from(passkeys)
      .where(eq(passkeys.userId, userId))
      .all();
  },

  findByCredentialId(credentialId: string) {
    return getDrizzle()
      .select()
      .from(passkeys)
      .where(eq(passkeys.credentialId, credentialId))
      .get();
  },

  create(data: { id: string; userId: string; credentialId: string; publicKey: string; counter: number; transports: string; label: string }) {
    getDrizzle().insert(passkeys).values({
      id: data.id,
      userId: data.userId,
      credentialId: data.credentialId,
      publicKey: data.publicKey,
      counter: data.counter,
      transports: data.transports,
      label: data.label,
    }).run();
  },

  updateCounter(id: string, counter: number) {
    getDrizzle().update(passkeys).set({ counter }).where(eq(passkeys.id, id)).run();
  },

  countByUser(userId: string): number {
    const row = getDrizzle()
      .select({ count: sql<number>`COUNT(*)` })
      .from(passkeys)
      .where(eq(passkeys.userId, userId))
      .get();
    return row?.count ?? 0;
  },

  renameByIdAndUser(id: string, userId: string, label: string): number {
    return getDrizzle()
      .update(passkeys)
      .set({ label })
      .where(and(eq(passkeys.id, id), eq(passkeys.userId, userId)))
      .run().changes;
  },

  deleteByIdAndUser(id: string, userId: string): number {
    return getDrizzle()
      .delete(passkeys)
      .where(and(eq(passkeys.id, id), eq(passkeys.userId, userId)))
      .run().changes;
  },
};
