import { eq, and, desc, sql } from 'drizzle-orm';
import { getDrizzle } from '../db/drizzle.js';
import { authChallenges } from '../db/drizzle-schema.js';

export const challengeRepo = {
  create(data: { id: string; challenge: string; userId: string | null; type: string; expiresAt: string }) {
    getDrizzle().insert(authChallenges).values({
      id: data.id,
      challenge: data.challenge,
      userId: data.userId,
      type: data.type,
      expiresAt: data.expiresAt,
    }).run();
  },

  findLatestForUser(userId: string, type: string) {
    return getDrizzle()
      .select()
      .from(authChallenges)
      .where(and(
        eq(authChallenges.userId, userId),
        eq(authChallenges.type, type),
        sql`${authChallenges.expiresAt} > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
      ))
      .orderBy(desc(authChallenges.createdAt))
      .limit(1)
      .get();
  },

  findLatestByType(type: string) {
    return getDrizzle()
      .select()
      .from(authChallenges)
      .where(and(
        eq(authChallenges.type, type),
        sql`${authChallenges.expiresAt} > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
      ))
      .orderBy(desc(authChallenges.createdAt))
      .limit(1)
      .get();
  },

  deleteById(id: string) {
    getDrizzle().delete(authChallenges).where(eq(authChallenges.id, id)).run();
  },

  deleteExpired() {
    getDrizzle()
      .delete(authChallenges)
      .where(sql`${authChallenges.expiresAt} < strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`)
      .run();
  },
};
