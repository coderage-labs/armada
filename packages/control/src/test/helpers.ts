import Database from 'better-sqlite3';
import { initSchema } from '../db/schema.js';
import { setTestDb } from '../db/index.js';
import { resetDrizzle } from '../db/drizzle.js';

/**
 * Creates an in-memory SQLite database with all migrations applied.
 * Use in tests to get a clean database for each test run.
 */
export function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  initSchema(db);
  return db;
}

/**
 * Sets up an in-memory test database and registers it as the global db.
 * Returns the database instance. Call `teardownTestDb()` in afterEach.
 */
export function setupTestDb(): Database.Database {
  const db = createTestDb();
  setTestDb(db);
  resetDrizzle(); // Force Drizzle to pick up the new test DB
  return db;
}

/**
 * Clears the global test database override.
 */
export function teardownTestDb(): void {
  setTestDb(null);
  resetDrizzle();
}
