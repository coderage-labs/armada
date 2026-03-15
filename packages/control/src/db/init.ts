import type Database from 'better-sqlite3';
import { createTables } from './tables.js';
import { runMigrations } from './migrations.js';
import { runSeed } from './seed.js';
import { runStartupCleanup } from './startup-cleanup.js';

/**
 * Initialise the database.
 *
 * Execution order:
 *   1. CREATE TABLE IF NOT EXISTS — idempotent, safe on every startup.
 *   2. runMigrations()  — versioned ALTER TABLE / data transforms.
 *   3. runSeed()        — default reference data (INSERT OR IGNORE).
 *   4. runStartupCleanup() — recover from interrupted previous run.
 */
export function initDb(db: Database.Database): void {
  createTables(db);
  runMigrations(db);
  runSeed(db);
  runStartupCleanup(db);
}
