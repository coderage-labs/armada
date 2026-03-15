import { eq, sql } from 'drizzle-orm';
import { getDrizzle } from '../db/drizzle.js';
import { authTokens, users } from '../db/drizzle-schema.js';

export const authTokenRepo = {
  create(data: { id: string; tokenHash: string; userId?: string | null; agentName?: string | null; label?: string; scopes?: string[]; expiresAt?: string | null }) {
    getDrizzle().insert(authTokens).values({
      id: data.id,
      tokenHash: data.tokenHash,
      userId: data.userId || null,
      agentName: data.agentName || null,
      label: data.label || '',
      scopes: JSON.stringify(data.scopes || []),
      expiresAt: data.expiresAt || null,
    }).run();
  },

  listAll() {
    return getDrizzle()
      .select({
        id: authTokens.id,
        userId: authTokens.userId,
        agentName: authTokens.agentName,
        label: authTokens.label,
        scopes: authTokens.scopes,
        expiresAt: authTokens.expiresAt,
        lastUsedAt: authTokens.lastUsedAt,
        createdAt: authTokens.createdAt,
      })
      .from(authTokens)
      .orderBy(sql`${authTokens.createdAt} DESC`)
      .all();
  },

  listByUser(userId: string) {
    return getDrizzle()
      .select({
        id: authTokens.id,
        userId: authTokens.userId,
        agentName: authTokens.agentName,
        label: authTokens.label,
        scopes: authTokens.scopes,
        expiresAt: authTokens.expiresAt,
        lastUsedAt: authTokens.lastUsedAt,
        createdAt: authTokens.createdAt,
      })
      .from(authTokens)
      .where(eq(authTokens.userId, userId))
      .orderBy(sql`${authTokens.createdAt} DESC`)
      .all();
  },

  deleteById(id: string): number {
    return getDrizzle().delete(authTokens).where(eq(authTokens.id, id)).run().changes;
  },

  deleteByIdAndUser(id: string, userId: string): number {
    return getDrizzle()
      .delete(authTokens)
      .where(sql`${authTokens.id} = ${id} AND ${authTokens.userId} = ${userId}`)
      .run().changes;
  },

  findByHash(hash: string) {
    return getDrizzle()
      .select({
        tokenId: authTokens.id,
        userId: authTokens.userId,
        agentName: authTokens.agentName,
        scopes: authTokens.scopes,
        expiresAt: authTokens.expiresAt,
        uid: users.id,
        name: users.name,
        displayName: users.displayName,
        role: users.role,
        type: users.type,
      })
      .from(authTokens)
      .leftJoin(users, eq(authTokens.userId, users.id))
      .where(eq(authTokens.tokenHash, hash))
      .get();
  },

  updateLastUsed(id: string) {
    getDrizzle()
      .update(authTokens)
      .set({ lastUsedAt: sql`strftime('%Y-%m-%dT%H:%M:%fZ', 'now')` })
      .where(eq(authTokens.id, id))
      .run();
  },
};
