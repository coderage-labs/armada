import type Database from 'better-sqlite3';

type Migration = {
  version: number;
  description: string;
  sql?: string | string[];
  run?: (db: Database.Database) => void;
};

/**
 * Versioned migrations for armada.
 *
 * Rules:
 * - Each migration gets a unique, ever-increasing version number.
 * - sql: run one or more SQL statements directly.
 * - run: a function for migrations that need logic (data transforms, table
 *   recreation, etc.).
 * - Do NOT remove or renumber old entries — that would break existing installs.
 * - ALTER TABLE statements are safe to add here; the migration runner only
 *   executes a migration if its version > the stored schema_version.
 */
const migrations: Migration[] = [
  // ── nodes ─────────────────────────────────────────────────────────
  {
    version: 1,
    description: 'Add url and token columns to nodes',
    sql: [
      "ALTER TABLE nodes ADD COLUMN url TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE nodes ADD COLUMN token TEXT NOT NULL DEFAULT ''",
    ],
  },
  {
    version: 2,
    description: 'Add WP6 registration fields to nodes',
    sql: [
      'ALTER TABLE nodes ADD COLUMN install_token TEXT',
      'ALTER TABLE nodes ADD COLUMN session_credential_hash TEXT',
      'ALTER TABLE nodes ADD COLUMN fingerprint TEXT',
      'ALTER TABLE nodes ADD COLUMN credential_rotated_at TEXT',
    ],
  },

  // ── templates ─────────────────────────────────────────────────────
  {
    version: 3,
    description: 'Add skills/plugins/tools columns to templates',
    sql: [
      "ALTER TABLE templates ADD COLUMN skills_list_json TEXT NOT NULL DEFAULT '[]'",
      "ALTER TABLE templates ADD COLUMN plugins_list_json TEXT NOT NULL DEFAULT '[]'",
      "ALTER TABLE templates ADD COLUMN tools_allow_json TEXT NOT NULL DEFAULT '[]'",
      "ALTER TABLE templates ADD COLUMN tools_profile TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE templates ADD COLUMN internal_agents_json TEXT NOT NULL DEFAULT '[]'",
      "ALTER TABLE templates ADD COLUMN contacts_json TEXT NOT NULL DEFAULT '[]'",
    ],
  },

  // ── agents ────────────────────────────────────────────────────────
  {
    version: 4,
    description: 'Add heartbeat columns to agents',
    sql: [
      'ALTER TABLE agents ADD COLUMN last_heartbeat TEXT',
      "ALTER TABLE agents ADD COLUMN health_status TEXT NOT NULL DEFAULT 'unknown'",
      'ALTER TABLE agents ADD COLUMN heartbeat_meta_json TEXT',
    ],
  },
  {
    version: 5,
    description: 'Add instance_id column to agents and remove orphans',
    run(db) {
      const cols = db.prepare('PRAGMA table_info(agents)').all() as { name: string }[];
      const hasInstanceId = cols.some(c => c.name === 'instance_id');
      if (!hasInstanceId) {
        db.exec('ALTER TABLE agents ADD COLUMN instance_id TEXT REFERENCES instances(id)');
      }
      db.exec('DELETE FROM agents WHERE instance_id IS NULL');
    },
  },
  {
    version: 6,
    description: 'Add avatar/workspace columns to agents',
    sql: [
      'ALTER TABLE agents ADD COLUMN avatar_generating INTEGER NOT NULL DEFAULT 0',
      'ALTER TABLE agents ADD COLUMN soul TEXT',
      'ALTER TABLE agents ADD COLUMN agents_md TEXT',
    ],
  },

  // ── users ─────────────────────────────────────────────────────────
  {
    version: 7,
    description: 'Add avatar_generating and password_hash to users',
    sql: [
      'ALTER TABLE users ADD COLUMN avatar_generating INTEGER NOT NULL DEFAULT 0',
      'ALTER TABLE users ADD COLUMN password_hash TEXT DEFAULT NULL',
    ],
  },

  // ── tasks ─────────────────────────────────────────────────────────
  {
    version: 8,
    description: 'Add blocked/project/github/board columns to tasks',
    sql: [
      'ALTER TABLE tasks ADD COLUMN blocked_reason TEXT',
      'ALTER TABLE tasks ADD COLUMN blocked_at TEXT',
      'ALTER TABLE tasks ADD COLUMN project_id TEXT DEFAULT NULL',
      'ALTER TABLE tasks ADD COLUMN github_issue_url TEXT DEFAULT NULL',
      'ALTER TABLE tasks ADD COLUMN github_issue_number INTEGER DEFAULT NULL',
      'ALTER TABLE tasks ADD COLUMN github_pr_url TEXT DEFAULT NULL',
      'ALTER TABLE tasks ADD COLUMN board_column TEXT DEFAULT NULL',
      'ALTER TABLE tasks ADD COLUMN workflow_run_id TEXT DEFAULT NULL',
      'ALTER TABLE tasks ADD COLUMN last_progress_at TEXT DEFAULT NULL',
    ],
  },

  // ── templates (continued) ─────────────────────────────────────────
  {
    version: 9,
    description: 'Add tools_json and projects_json to templates',
    sql: [
      "ALTER TABLE templates ADD COLUMN tools_json TEXT NOT NULL DEFAULT '[]'",
      "ALTER TABLE templates ADD COLUMN projects_json TEXT NOT NULL DEFAULT '[]'",
    ],
  },

  // ── projects ──────────────────────────────────────────────────────
  {
    version: 10,
    description: 'Add max_concurrent to projects',
    sql: ['ALTER TABLE projects ADD COLUMN max_concurrent INTEGER NOT NULL DEFAULT 3'],
  },

  // ── workflows: migrate project_id → junction table ────────────────
  {
    version: 11,
    description: 'Migrate workflows.project_id to workflow_projects junction table',
    run(db) {
      const wfCols = db.prepare('PRAGMA table_info(workflows)').all() as { name: string }[];
      if (!wfCols.some(c => c.name === 'project_id')) return;

      const existingWorkflows = db
        .prepare('SELECT id, project_id FROM workflows WHERE project_id IS NOT NULL')
        .all() as { id: string; project_id: string }[];

      for (const wf of existingWorkflows) {
        db
          .prepare('INSERT OR IGNORE INTO workflow_projects (workflow_id, project_id) VALUES (?, ?)')
          .run(wf.id, wf.project_id);
      }

      // SQLite can't DROP COLUMN — recreate without project_id
      db.exec(`
        CREATE TABLE IF NOT EXISTS workflows_new (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          steps_json TEXT NOT NULL DEFAULT '[]',
          enabled INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        );
        INSERT INTO workflows_new (id, name, description, steps_json, enabled, created_at)
          SELECT id, name, description, steps_json, enabled, created_at FROM workflows;
        DROP TABLE workflows;
        ALTER TABLE workflows_new RENAME TO workflows;
      `);
    },
  },

  // ── model_registry ────────────────────────────────────────────────
  {
    version: 12,
    description: 'Add provider_id and source columns to model_registry',
    sql: [
      'ALTER TABLE model_registry ADD COLUMN provider_id TEXT',
      "ALTER TABLE model_registry ADD COLUMN source TEXT DEFAULT 'manual'",
    ],
  },

  // ── templates (continued) ─────────────────────────────────────────
  {
    version: 13,
    description: 'Add models_json to templates',
    sql: ["ALTER TABLE templates ADD COLUMN models_json TEXT NOT NULL DEFAULT '[]'"],
  },

  // ── role_metadata ─────────────────────────────────────────────────
  {
    version: 14,
    description: 'Add allowed_tools to role_metadata',
    sql: ['ALTER TABLE role_metadata ADD COLUMN allowed_tools TEXT DEFAULT NULL'],
  },

  // ── instances ────────────────────────────────────────────────────
  {
    version: 15,
    description: 'Add version tracking and resource limit columns to instances',
    sql: [
      'ALTER TABLE instances ADD COLUMN version TEXT DEFAULT NULL',
      'ALTER TABLE instances ADD COLUMN target_version TEXT DEFAULT NULL',
      'ALTER TABLE instances ADD COLUMN applied_config_version INTEGER DEFAULT 0',
      'ALTER TABLE instances ADD COLUMN drain_mode INTEGER DEFAULT 0',
      "ALTER TABLE instances ADD COLUMN memory TEXT DEFAULT '2g'",
      "ALTER TABLE instances ADD COLUMN cpus TEXT DEFAULT '1'",
    ],
  },

  // ── plugin_library ────────────────────────────────────────────────
  {
    version: 16,
    description: 'Add system flag and npm_pkg to plugin_library',
    sql: [
      'ALTER TABLE plugin_library ADD COLUMN system INTEGER NOT NULL DEFAULT 0',
      'ALTER TABLE plugin_library ADD COLUMN npm_pkg TEXT',
    ],
  },

  // ── workflow_step_runs / model_providers ──────────────────────────
  {
    version: 17,
    description: 'Add telegram_notifications_json to workflow_step_runs',
    sql: ['ALTER TABLE workflow_step_runs ADD COLUMN telegram_notifications_json TEXT DEFAULT NULL'],
  },
  {
    version: 18,
    description: 'Add hidden column to model_providers',
    sql: ['ALTER TABLE model_providers ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0'],
  },

  // ── Migrate provider api_key → provider_api_keys ──────────────────
  {
    version: 19,
    description: 'Migrate model_providers.api_key into provider_api_keys table',
    run(db) {
      const providers = db
        .prepare('SELECT id, api_key FROM model_providers WHERE api_key IS NOT NULL')
        .all() as Array<{ id: string; api_key: string }>;

      const insertKey = db.prepare(`
        INSERT OR IGNORE INTO provider_api_keys (id, provider_id, name, api_key, is_default, priority)
        VALUES (?, ?, 'Default', ?, 1, 0)
      `);
      const clearKey = db.prepare('UPDATE model_providers SET api_key = NULL WHERE id = ?');

      for (const p of providers) {
        if (!p.api_key) continue;
        const existing = db.prepare('SELECT id FROM provider_api_keys WHERE provider_id = ?').get(p.id);
        if (!existing) {
          insertKey.run(`${p.id}-default`, p.id, p.api_key);
          clearKey.run(p.id);
        }
      }
    },
  },

  // ── operations engine columns (WP8) ───────────────────────────────
  {
    version: 20,
    description: 'Add WP8 operations engine columns',
    sql: [
      'ALTER TABLE operations ADD COLUMN target_type TEXT',
      'ALTER TABLE operations ADD COLUMN target_id TEXT',
      "ALTER TABLE operations ADD COLUMN steps_json TEXT DEFAULT '[]'",
      "ALTER TABLE operations ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal'",
      'ALTER TABLE operations ADD COLUMN created_by TEXT',
      'ALTER TABLE operations ADD COLUMN error TEXT',
    ],
  },

  // ── pending_mutations ─────────────────────────────────────────────
  {
    version: 21,
    description: 'Add instance_id column to pending_mutations (#445)',
    sql: ['ALTER TABLE pending_mutations ADD COLUMN instance_id TEXT'],
  },
  {
    version: 22,
    description: 'Add step_deps_json column to operations for DAG dependency storage (#541)',
    sql: ["ALTER TABLE operations ADD COLUMN step_deps_json TEXT DEFAULT '[]'"],
  },

  // ── webhook_deliveries (#267) ─────────────────────────────────────
  {
    version: 23,
    description: 'Add webhook_deliveries table for delivery tracking, metrics, and retry (#267)',
    sql: [
      `CREATE TABLE IF NOT EXISTS webhook_deliveries (
        id           TEXT PRIMARY KEY,
        webhook_id   TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
        event_type   TEXT NOT NULL,
        status       TEXT NOT NULL DEFAULT 'pending',
        status_code  INTEGER,
        response_body TEXT,
        payload      TEXT,
        attempt      INTEGER DEFAULT 1,
        error        TEXT,
        latency_ms   INTEGER,
        created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        completed_at TEXT
      )`,
      'CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_webhook_id ON webhook_deliveries(webhook_id)',
    ],
  },

  // ── API key priority & provider fallback (#303) ───────────────────
  {
    version: 24,
    description: 'Add priority column to provider_api_keys (#303)',
    sql: ['ALTER TABLE provider_api_keys ADD COLUMN priority INTEGER NOT NULL DEFAULT 0'],
  },
  {
    version: 25,
    description: 'Add fallback_enabled and fallback_behavior to model_providers (#303)',
    sql: [
      'ALTER TABLE model_providers ADD COLUMN fallback_enabled INTEGER NOT NULL DEFAULT 0',
      "ALTER TABLE model_providers ADD COLUMN fallback_behavior TEXT NOT NULL DEFAULT 'immediate'",
    ],
  },

  // ── API usage & cost tracking (#302) ─────────────────────────────
  {
    version: 26,
    description: 'Create api_usage_log table for cost tracking per key/provider/agent (#302)',
    sql: [
      `CREATE TABLE IF NOT EXISTS api_usage_log (
        id          TEXT PRIMARY KEY,
        api_key_id  TEXT,
        provider_id TEXT,
        agent_id    TEXT,
        model_id    TEXT,
        instance_id TEXT,
        input_tokens  INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0,
        total_tokens  INTEGER DEFAULT 0,
        cost_usd      REAL DEFAULT 0,
        session_key   TEXT,
        created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      )`,
      'CREATE INDEX IF NOT EXISTS idx_usage_api_key ON api_usage_log(api_key_id)',
      'CREATE INDEX IF NOT EXISTS idx_usage_provider ON api_usage_log(provider_id)',
      'CREATE INDEX IF NOT EXISTS idx_usage_agent ON api_usage_log(agent_id)',
      'CREATE INDEX IF NOT EXISTS idx_usage_created ON api_usage_log(created_at)',
    ],
  },

  // ── tasks: structured task types and payloads (#36) ──────────────
  {
    version: 27,
    description: 'Add task_type and task_payload columns to tasks',
    sql: [
      "ALTER TABLE tasks ADD COLUMN task_type TEXT NOT NULL DEFAULT 'generic'",
      'ALTER TABLE tasks ADD COLUMN task_payload TEXT',
    ],
  },
  {
    version: 28,
    description: 'Add schema_version column to changesets for stale draft detection',
    sql: [
      'ALTER TABLE changesets ADD COLUMN schema_version INTEGER',
    ],
  },
  {
    version: 29,
    description: 'Add avatar_version counter to agents and users for cache busting',
    sql: [
      'ALTER TABLE agents ADD COLUMN avatar_version INTEGER NOT NULL DEFAULT 0',
      'ALTER TABLE users ADD COLUMN avatar_version INTEGER NOT NULL DEFAULT 0',
    ],
  },
  {
    version: 30,
    description: 'Add retry_config column to workflow_step_runs',
    sql: [
      'ALTER TABLE workflow_step_runs ADD COLUMN retry_config TEXT DEFAULT NULL',
    ],
  },

  // ── notification_channels (#512) ──────────────────────────────────
  {
    version: 31,
    description: 'Create notification_channels table (#512)',
    sql: [
      `CREATE TABLE IF NOT EXISTS notification_channels (
        id         TEXT PRIMARY KEY,
        type       TEXT NOT NULL,
        name       TEXT NOT NULL,
        enabled    INTEGER NOT NULL DEFAULT 1,
        config     TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      )`,
    ],
  },
];

/**
 * Run all pending schema migrations against `db`.
 *
 * Creates the `schema_version` table on first call, then applies every
 * migration whose version is greater than the currently stored version.
 * Each migration runs in its own transaction so a failure is isolated.
 */
/** Returns the current schema version from the DB (0 if no migrations run). */
export function getCurrentSchemaVersion(db: Database.Database): number {
  try {
    const row = db.prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number | null } | undefined;
    return row?.v ?? 0;
  } catch {
    return 0;
  }
}

export function runMigrations(db: Database.Database): void {
  // Ensure the version tracking table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY
    )
  `);

  // Determine the current version (0 = no migrations run yet)
  const row = db.prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number | null };
  const currentVersion = row.v ?? 0;

  const pending = migrations.filter(m => m.version > currentVersion);
  if (pending.length === 0) return;

  console.log(`[migrations] Current schema version: ${currentVersion}. Applying ${pending.length} migration(s)…`);

  for (const migration of pending) {
    const apply = db.transaction(() => {
      console.log(`[migrations] Applying v${migration.version}: ${migration.description}`);

      if (migration.run) {
        migration.run(db);
      } else if (migration.sql) {
        const statements = Array.isArray(migration.sql) ? migration.sql : [migration.sql];
        for (const stmt of statements) {
          try {
            db.exec(stmt);
          } catch (err: unknown) {
            // ALTER TABLE ADD COLUMN fails if the column already exists (e.g. on
            // first-time adoption of versioning on an existing database).
            // This is safe to ignore — the column is there, which is all we need.
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes('duplicate column name') || msg.includes('already exists')) {
              console.log(`[migrations] v${migration.version}: column already exists, skipping: ${stmt.slice(0, 60)}`);
            } else {
              throw err;
            }
          }
        }
      }

      db.prepare('INSERT OR REPLACE INTO schema_version (version) VALUES (?)').run(migration.version);
    });

    apply();
  }

  console.log(`[migrations] Schema is now at version ${migrations[migrations.length - 1]?.version ?? currentVersion}`);
}
