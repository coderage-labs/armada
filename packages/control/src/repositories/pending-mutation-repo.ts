import { eq, and, sql } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { getDrizzle } from '../db/drizzle.js';
import { pendingMutations } from '../db/drizzle-schema.js';

export interface PendingMutation {
  id: string;
  changesetId: string;
  entityType: string;
  entityId: string | null;
  action: 'create' | 'update' | 'delete';
  payload: Record<string, any>;
  instanceId: string | null;
  createdAt: string;
}

function rowToMutation(r: typeof pendingMutations.$inferSelect): PendingMutation {
  return {
    id: r.id,
    changesetId: r.changesetId,
    entityType: r.entityType,
    entityId: r.entityId ?? null,
    action: r.action as 'create' | 'update' | 'delete',
    payload: JSON.parse(r.payloadJson),
    instanceId: r.instanceId ?? null,
    createdAt: r.createdAt,
  };
}

export const pendingMutationRepo = {
  create(data: Omit<PendingMutation, 'id' | 'createdAt'>): PendingMutation {
    // Check for existing mutation with same changeset + entity + action (fixes #22)
    const entityId = data.entityId ?? null;
    const conditions = [
      eq(pendingMutations.changesetId, data.changesetId),
      eq(pendingMutations.entityType, data.entityType),
      eq(pendingMutations.action, data.action),
    ];
    
    // Handle nullable entityId properly
    if (entityId !== null) {
      conditions.push(eq(pendingMutations.entityId, entityId));
    } else {
      conditions.push(sql`${pendingMutations.entityId} IS NULL`);
    }
    
    const existing = getDrizzle()
      .select()
      .from(pendingMutations)
      .where(and(...conditions))
      .get();
    
    if (existing) {
      // Update the existing mutation instead of creating a duplicate
      getDrizzle()
        .update(pendingMutations)
        .set({ payloadJson: JSON.stringify(data.payload) })
        .where(eq(pendingMutations.id, existing.id))
        .run();
      return rowToMutation(existing);
    }

    const id = uuidv4();
    getDrizzle().insert(pendingMutations).values({
      id,
      changesetId: data.changesetId,
      entityType: data.entityType,
      entityId: entityId,
      action: data.action,
      payloadJson: JSON.stringify(data.payload),
      instanceId: data.instanceId ?? null,
    }).run();
    return rowToMutation(
      getDrizzle().select().from(pendingMutations).where(eq(pendingMutations.id, id)).get()!,
    );
  },

  getByChangeset(changesetId: string): PendingMutation[] {
    return getDrizzle()
      .select()
      .from(pendingMutations)
      .where(eq(pendingMutations.changesetId, changesetId))
      .all()
      .map(rowToMutation);
  },

  getByEntity(entityType: string, entityId?: string): PendingMutation[] {
    const db = getDrizzle();
    if (entityId !== undefined) {
      return db
        .select()
        .from(pendingMutations)
        .where(and(
          eq(pendingMutations.entityType, entityType),
          eq(pendingMutations.entityId, entityId),
        ))
        .all()
        .map(rowToMutation);
    }
    return db
      .select()
      .from(pendingMutations)
      .where(eq(pendingMutations.entityType, entityType))
      .all()
      .map(rowToMutation);
  },

  getAll(): PendingMutation[] {
    return getDrizzle()
      .select()
      .from(pendingMutations)
      .all()
      .map(rowToMutation);
  },

  linkToChangeset(mutationId: string, changesetId: string): void {
    getDrizzle()
      .update(pendingMutations)
      .set({ changesetId })
      .where(eq(pendingMutations.id, mutationId))
      .run();
  },

  removeByChangeset(changesetId: string): number {
    const existing = pendingMutationRepo.getByChangeset(changesetId);
    const count = existing.length;
    if (count > 0) {
      getDrizzle()
        .delete(pendingMutations)
        .where(eq(pendingMutations.changesetId, changesetId))
        .run();
    }
    return count;
  },

  removeById(id: string): boolean {
    const existing = getDrizzle()
      .select()
      .from(pendingMutations)
      .where(eq(pendingMutations.id, id))
      .get();
    if (!existing) return false;
    getDrizzle().delete(pendingMutations).where(eq(pendingMutations.id, id)).run();
    return true;
  },

  update(id: string, payload: Record<string, any>): PendingMutation | null {
    const existing = getDrizzle()
      .select()
      .from(pendingMutations)
      .where(eq(pendingMutations.id, id))
      .get();
    if (!existing) return null;
    getDrizzle()
      .update(pendingMutations)
      .set({ payloadJson: JSON.stringify(payload) })
      .where(eq(pendingMutations.id, id))
      .run();
    return rowToMutation(
      getDrizzle().select().from(pendingMutations).where(eq(pendingMutations.id, id)).get()!,
    );
  },

  /**
   * Get all pending mutations for agents assigned to a specific instance.
   * Uses the dedicated instance_id column — no LIKE hacks (#445).
   */
  getByInstance(instanceId: string): PendingMutation[] {
    return getDrizzle()
      .select()
      .from(pendingMutations)
      .where(
        and(
          eq(pendingMutations.entityType, 'agent'),
          eq(pendingMutations.instanceId, instanceId),
        ),
      )
      .all()
      .map(rowToMutation);
  },
};
