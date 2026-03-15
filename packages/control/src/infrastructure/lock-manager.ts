// ── Lock Manager — instance/node/global concurrency control ──

import { eq, and, inArray } from 'drizzle-orm';
import { getDrizzle } from '../db/drizzle.js';
import { operationLocks, operations, instances } from '../db/drizzle-schema.js';

// ── Interface ────────────────────────────────────────────────────────

export interface LockManager {
  /** Acquire a lock. Returns true if acquired, false if already locked. */
  acquire(targetType: string, targetId: string, operationId: string): boolean;

  /** Release a lock for a specific operation. */
  release(targetType: string, targetId: string, operationId: string): boolean;

  /** Release ALL locks held by an operation. */
  releaseAll(operationId: string): number;

  /** Check if a target is locked. Returns the lock info or null. */
  check(targetType: string, targetId: string): { operationId: string; acquiredAt: string } | null;

  /** Check if ANY instance on a node is locked. */
  isNodeLocked(nodeId: string): boolean;

  /** Check if a global lock is active. */
  isGlobalLocked(): boolean;

  /** Get all active locks. */
  getAll(): Array<{ targetType: string; targetId: string; operationId: string; acquiredAt: string }>;

  /** Force-release stale locks (no operation events for staleDurationMs). */
  cleanupStale(staleDurationMs?: number): number;
}

// ── Implementation ───────────────────────────────────────────────────

function createLockManager(): LockManager {
  function acquire(targetType: string, targetId: string, operationId: string): boolean {
    const db = getDrizzle();
    const acquiredAt = new Date().toISOString();

    // Check if already locked
    const existing = db
      .select()
      .from(operationLocks)
      .where(
        and(
          eq(operationLocks.targetType, targetType),
          eq(operationLocks.targetId, targetId),
        ),
      )
      .get();

    if (existing) return false;

    // Insert — if a race condition results in conflict, the insert will throw;
    // we catch that and return false (already locked)
    try {
      db.insert(operationLocks).values({
        targetType,
        targetId,
        operationId,
        acquiredAt,
      }).run();
      return true;
    } catch (err: any) {
      console.warn('[lock-manager] Failed to acquire lock:', err.message);
      return false;
    }
  }

  function release(targetType: string, targetId: string, operationId: string): boolean {
    const db = getDrizzle();
    const result = db
      .delete(operationLocks)
      .where(
        and(
          eq(operationLocks.targetType, targetType),
          eq(operationLocks.targetId, targetId),
          eq(operationLocks.operationId, operationId),
        ),
      )
      .run();
    return result.changes > 0;
  }

  function releaseAll(operationId: string): number {
    const db = getDrizzle();
    const result = db
      .delete(operationLocks)
      .where(eq(operationLocks.operationId, operationId))
      .run();
    return result.changes;
  }

  function check(targetType: string, targetId: string): { operationId: string; acquiredAt: string } | null {
    const db = getDrizzle();
    const row = db
      .select({ operationId: operationLocks.operationId, acquiredAt: operationLocks.acquiredAt })
      .from(operationLocks)
      .where(
        and(
          eq(operationLocks.targetType, targetType),
          eq(operationLocks.targetId, targetId),
        ),
      )
      .get();
    return row ?? null;
  }

  function isNodeLocked(nodeId: string): boolean {
    const db = getDrizzle();

    // Check if there's a direct node-level lock
    const nodeLock = db
      .select({ operationId: operationLocks.operationId })
      .from(operationLocks)
      .where(
        and(
          eq(operationLocks.targetType, 'node'),
          eq(operationLocks.targetId, nodeId),
        ),
      )
      .get();

    if (nodeLock) return true;

    // Check if any instance on this node is locked
    const nodeInstances = db
      .select({ id: instances.id })
      .from(instances)
      .where(eq(instances.nodeId, nodeId))
      .all();

    if (nodeInstances.length === 0) return false;

    const instanceIds = nodeInstances.map((i) => i.id);
    const instanceLock = db
      .select({ operationId: operationLocks.operationId })
      .from(operationLocks)
      .where(
        and(
          eq(operationLocks.targetType, 'instance'),
          inArray(operationLocks.targetId, instanceIds),
        ),
      )
      .get();

    return !!instanceLock;
  }

  function isGlobalLocked(): boolean {
    return check('global', 'fleet') !== null;
  }

  function getAll(): Array<{ targetType: string; targetId: string; operationId: string; acquiredAt: string }> {
    const db = getDrizzle();
    return db.select().from(operationLocks).all();
  }

  function cleanupStale(staleDurationMs = 10 * 60 * 1000): number {
    const db = getDrizzle();
    const cutoff = new Date(Date.now() - staleDurationMs).toISOString();

    // Find all current lock operation IDs
    const locks = db.select({ operationId: operationLocks.operationId }).from(operationLocks).all();
    if (locks.length === 0) return 0;

    const lockOpIds = [...new Set(locks.map((l) => l.operationId))];

    // For each operation, check when its last event was
    const staleOpIds: string[] = [];
    for (const opId of lockOpIds) {
      const op = db
        .select({ eventsJson: operations.eventsJson, startedAt: operations.startedAt, completedAt: operations.completedAt, status: operations.status })
        .from(operations)
        .where(eq(operations.id, opId))
        .get();

      if (!op) {
        // Operation no longer exists — stale
        staleOpIds.push(opId);
        continue;
      }

      // If operation is already terminal, it's stale
      if (op.status === 'completed' || op.status === 'failed' || op.status === 'cancelled') {
        staleOpIds.push(opId);
        continue;
      }

      // Check last event timestamp
      let lastActivity: string = op.startedAt;
      try {
        const events: Array<{ timestamp: number }> = JSON.parse(op.eventsJson || '[]');
        if (events.length > 0) {
          const lastTs = events[events.length - 1].timestamp;
          lastActivity = new Date(lastTs).toISOString();
        }
      } catch (err: any) { console.warn('[lock-manager] Failed to parse JSON field:', err.message); }

      if (lastActivity < cutoff) {
        staleOpIds.push(opId);
      }
    }

    if (staleOpIds.length === 0) return 0;

    const result = db
      .delete(operationLocks)
      .where(inArray(operationLocks.operationId, staleOpIds))
      .run();

    return result.changes;
  }

  return { acquire, release, releaseAll, check, isNodeLocked, isGlobalLocked, getAll, cleanupStale };
}

/** Singleton lock manager */
export const lockManager = createLockManager();

/** Factory export for testing */
export { createLockManager };
