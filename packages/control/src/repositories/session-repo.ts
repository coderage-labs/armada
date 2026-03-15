import { eq, sql } from 'drizzle-orm';
import { getDrizzle } from '../db/drizzle.js';
import { sessions, users } from '../db/drizzle-schema.js';

export const sessionRepo = {
  create(data: { id: string; userId: string; tokenHash: string; expiresAt: string }) {
    getDrizzle().insert(sessions).values({
      id: data.id,
      userId: data.userId,
      tokenHash: data.tokenHash,
      expiresAt: data.expiresAt,
    }).run();
  },

  findByHash(hash: string) {
    return getDrizzle()
      .select({
        id: sessions.id,
        userId: sessions.userId,
        expiresAt: sessions.expiresAt,
        name: users.name,
        displayName: users.displayName,
        role: users.role,
        type: users.type,
      })
      .from(sessions)
      .innerJoin(users, eq(sessions.userId, users.id))
      .where(eq(sessions.tokenHash, hash))
      .get();
  },
};
