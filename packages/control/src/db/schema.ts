/**
 * Barrel — re-exports from tables.ts and init.ts for backward compatibility.
 *
 * Prefer importing directly from the source modules in new code:
 *   import { createTables } from './tables.js';
 *   import { initDb }       from './init.js';
 */
export { createTables } from './tables.js';
export { initDb } from './init.js';

// Backward-compat alias: existing callers use `initSchema`
export { initDb as initSchema } from './init.js';
