import { eq, sql } from 'drizzle-orm';
import { getDrizzle } from '../db/drizzle.js';
import { settings } from '../db/drizzle-schema.js';

export const settingsRepo = {
  get(key: string): string | undefined {
    const row = getDrizzle().select({ value: settings.value }).from(settings).where(eq(settings.key, key)).get();
    return row?.value;
  },

  set(key: string, value: string): void {
    getDrizzle().insert(settings).values({
      key,
      value,
      updatedAt: sql`datetime('now')`,
    }).onConflictDoUpdate({
      target: settings.key,
      set: {
        value,
        updatedAt: sql`datetime('now')`,
      },
    }).run();
  },

  remove(key: string): boolean {
    const result = getDrizzle().delete(settings).where(eq(settings.key, key)).run();
    return result.changes > 0;
  },

  getAll(): Record<string, string> {
    const rows = getDrizzle().select({ key: settings.key, value: settings.value }).from(settings).all();
    const result: Record<string, string> = {};
    for (const row of rows) {
      result[row.key] = row.value;
    }
    return result;
  },
};
