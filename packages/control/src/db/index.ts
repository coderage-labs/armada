import Database from 'better-sqlite3';
import { initSchema } from './schema.js';

let db: Database.Database;
let testDb: Database.Database | null = null;

/** Inject a test database (call with null to clear). */
export function setTestDb(d: Database.Database | null): void {
  testDb = d;
}

export function getDb(): Database.Database {
  if (testDb) return testDb;
  if (!db) {
    db = new Database(process.env.FLEET_DB_PATH || './fleet.db');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initSchema(db);
  }
  return db;
}
