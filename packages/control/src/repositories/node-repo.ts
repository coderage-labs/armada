import { eq, isNotNull } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { getDrizzle } from '../db/drizzle.js';
import { nodes } from '../db/drizzle-schema.js';
import type { ArmadaNode } from '@coderage-labs/armada-shared';

function rowToNode(r: typeof nodes.$inferSelect): ArmadaNode {
  return {
    id: r.id,
    hostname: r.hostname,
    ip: r.ip,
    port: r.port,
    url: r.url,
    token: r.token,
    cores: r.cores,
    memory: r.memory,
    status: r.status as ArmadaNode['status'],
    lastSeen: r.lastSeen ?? '',
  };
}

/** Internal row shape that includes sensitive registration fields */
interface NodeRegistrationRow {
  id: string;
  hostname: string;
  fingerprint: string | null;
  sessionCredentialHash: string | null;
}

export const nodesRepo = {
  getAll(): ArmadaNode[] {
    return getDrizzle().select().from(nodes).all().map(rowToNode);
  },

  getById(id: string): ArmadaNode | undefined {
    const row = getDrizzle().select().from(nodes).where(eq(nodes.id, id)).get();
    return row ? rowToNode(row) : undefined;
  },

  create(data: Omit<ArmadaNode, 'id'>): ArmadaNode {
    const id = uuidv4();
    getDrizzle().insert(nodes).values({
      id,
      hostname: data.hostname,
      ip: data.ip,
      port: data.port,
      url: data.url || '',
      token: data.token || '',
      cores: data.cores,
      memory: data.memory,
      status: data.status,
      lastSeen: data.lastSeen || null,
    }).run();
    return { id, ...data };
  },

  update(id: string, data: Partial<ArmadaNode>): ArmadaNode | undefined {
    const existing = nodesRepo.getById(id);
    if (!existing) return undefined;
    const merged = { ...existing, ...data, id };
    getDrizzle().update(nodes).set({
      hostname: merged.hostname,
      ip: merged.ip,
      port: merged.port,
      url: merged.url || '',
      token: merged.token || '',
      cores: merged.cores,
      memory: merged.memory,
      status: merged.status,
      lastSeen: merged.lastSeen || null,
    }).where(eq(nodes.id, id)).run();
    return merged;
  },

  remove(id: string): boolean {
    const result = getDrizzle().delete(nodes).where(eq(nodes.id, id)).run();
    return result.changes > 0;
  },

  // ── Registration methods (WP6) ──────────────────────────────────────

  /**
   * Find a node by its one-time install token.
   * Returns full registration row or null.
   */
  findByInstallToken(token: string): NodeRegistrationRow | null {
    const row = getDrizzle()
      .select({
        id: nodes.id,
        hostname: nodes.hostname,
        fingerprint: nodes.fingerprint,
        sessionCredentialHash: nodes.sessionCredentialHash,
      })
      .from(nodes)
      .where(eq(nodes.installToken, token))
      .get();
    return row ?? null;
  },

  /**
   * Get all nodes that have a session credential hash set.
   * Used for O(n) bcrypt comparison during session-credential auth.
   */
  getAllWithCredentials(): NodeRegistrationRow[] {
    return getDrizzle()
      .select({
        id: nodes.id,
        hostname: nodes.hostname,
        fingerprint: nodes.fingerprint,
        sessionCredentialHash: nodes.sessionCredentialHash,
      })
      .from(nodes)
      .where(isNotNull(nodes.sessionCredentialHash))
      .all();
  },

  /**
   * Store a bcrypt hash of the session credential, clear the install token,
   * and record the fingerprint. Called after a successful install-token auth.
   */
  issueSessionCredential(id: string, credentialHash: string, fingerprint: string): void {
    getDrizzle()
      .update(nodes)
      .set({
        sessionCredentialHash: credentialHash,
        installToken: null,
        fingerprint,
        credentialRotatedAt: new Date().toISOString(),
      })
      .where(eq(nodes.id, id))
      .run();
  },

  /**
   * Rotate the session credential — update hash and bump the rotated_at timestamp.
   */
  rotateSessionCredential(id: string, newCredentialHash: string): void {
    getDrizzle()
      .update(nodes)
      .set({
        sessionCredentialHash: newCredentialHash,
        credentialRotatedAt: new Date().toISOString(),
      })
      .where(eq(nodes.id, id))
      .run();
  },

  /**
   * Get extended node details including fingerprint and credential status.
   */
  getDetails(id: string): { fingerprint: string | null; hasCredential: boolean; credentialRotatedAt: string | null } | undefined {
    const row = getDrizzle()
      .select({
        fingerprint: nodes.fingerprint,
        sessionCredentialHash: nodes.sessionCredentialHash,
        credentialRotatedAt: nodes.credentialRotatedAt,
      })
      .from(nodes)
      .where(eq(nodes.id, id))
      .get();
    if (!row) return undefined;
    return {
      fingerprint: row.fingerprint ?? null,
      hasCredential: !!row.sessionCredentialHash,
      credentialRotatedAt: row.credentialRotatedAt ?? null,
    };
  },

  /**
   * Set (or reset) the install token for a node.
   * Clears the session credential so the node must re-register.
   */
  setInstallToken(id: string, installToken: string): void {
    getDrizzle()
      .update(nodes)
      .set({ installToken })
      .where(eq(nodes.id, id))
      .run();
  },
};
