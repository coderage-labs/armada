import { eq } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { getDrizzle } from '../db/drizzle.js';
import { deploys } from '../db/drizzle-schema.js';
import type { Deployment } from '@coderage-labs/armada-shared';

type DeployRow = typeof deploys.$inferSelect;

function rowToDeploy(r: DeployRow): Deployment {
  return {
    id: r.id,
    type: r.type as Deployment['type'],
    target: r.target ?? '',
    status: r.status as Deployment['status'],
    log: r.log,
    startedAt: r.startedAt,
    completedAt: r.completedAt,
  };
}

export const deploysRepo = {
  getAll(): Deployment[] {
    return getDrizzle().select().from(deploys).all().map(rowToDeploy);
  },

  getById(id: string): Deployment | undefined {
    const row = getDrizzle().select().from(deploys).where(eq(deploys.id, id)).get();
    return row ? rowToDeploy(row) : undefined;
  },

  create(data: Omit<Deployment, 'id' | 'startedAt' | 'completedAt'>): Deployment {
    const id = uuidv4();
    getDrizzle().insert(deploys).values({
      id,
      type: data.type,
      target: data.target || null,
      status: data.status,
      log: null,
    }).run();
    const row = getDrizzle().select().from(deploys).where(eq(deploys.id, id)).get()!;
    return rowToDeploy(row);
  },

  update(id: string, data: Partial<Deployment>): Deployment | undefined {
    const existing = deploysRepo.getById(id);
    if (!existing) return undefined;
    const merged = { ...existing, ...data, id };
    getDrizzle().update(deploys).set({
      type: merged.type,
      target: merged.target || null,
      status: merged.status,
      log: merged.log ?? null,
      completedAt: merged.completedAt ?? null,
    }).where(eq(deploys.id, id)).run();
    return merged;
  },

  remove(id: string): boolean {
    const result = getDrizzle().delete(deploys).where(eq(deploys.id, id)).run();
    return result.changes > 0;
  },
};
