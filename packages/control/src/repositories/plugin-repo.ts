import { eq, sql } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { getDrizzle } from '../db/drizzle.js';
import { plugins } from '../db/drizzle-schema.js';
import type { InstalledPlugin } from '@coderage-labs/armada-shared';

type PluginRow = typeof plugins.$inferSelect;

function rowToPlugin(r: PluginRow): InstalledPlugin {
  return {
    id: r.id,
    name: r.name,
    version: r.version,
    path: r.path,
    updatedAt: r.updatedAt,
  };
}

export const pluginsRepo = {
  getAll(): InstalledPlugin[] {
    return getDrizzle().select().from(plugins).all().map(rowToPlugin);
  },

  getById(id: string): InstalledPlugin | undefined {
    const row = getDrizzle().select().from(plugins).where(eq(plugins.id, id)).get();
    return row ? rowToPlugin(row) : undefined;
  },

  create(data: Omit<InstalledPlugin, 'id' | 'updatedAt'>): InstalledPlugin {
    const id = uuidv4();
    getDrizzle().insert(plugins).values({
      id,
      name: data.name,
      version: data.version,
      path: data.path,
    }).run();
    const row = getDrizzle().select().from(plugins).where(eq(plugins.id, id)).get()!;
    return rowToPlugin(row);
  },

  update(id: string, data: Partial<InstalledPlugin>): InstalledPlugin | undefined {
    const existing = pluginsRepo.getById(id);
    if (!existing) return undefined;
    const merged = { ...existing, ...data, id };
    getDrizzle().update(plugins).set({
      name: merged.name,
      version: merged.version,
      path: merged.path,
      updatedAt: sql`strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    }).where(eq(plugins.id, id)).run();
    const row = getDrizzle().select().from(plugins).where(eq(plugins.id, id)).get()!;
    return rowToPlugin(row);
  },

  remove(id: string): boolean {
    const result = getDrizzle().delete(plugins).where(eq(plugins.id, id)).run();
    return result.changes > 0;
  },
};
