import { drizzle } from 'drizzle-orm/better-sqlite3';
import { getDb } from './index.js';
import * as schema from './drizzle-schema.js';

let _drizzleDb: ReturnType<typeof drizzle> | null = null;

export function getDrizzle() {
  if (!_drizzleDb) {
    _drizzleDb = drizzle(getDb(), { schema });
  }
  return _drizzleDb;
}

/** Reset cached Drizzle instance (call after setTestDb to pick up new DB) */
export function resetDrizzle(): void {
  _drizzleDb = null;
}

export { schema };
