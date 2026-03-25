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

  // ── notification channel linking (#63) ────────────────────────────
  {
    version: 32,
    description: 'Add unique constraint on notification_channels.type (#63)',
    sql: [
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_channels_type ON notification_channels(type)',
    ],
  },
  {
    version: 33,
    description: 'Add channels_json column to users table (#63)',
    sql: [
      "ALTER TABLE users ADD COLUMN channels_json TEXT NOT NULL DEFAULT '{}'",
    ],
  },
  {
    version: 34,
    description: 'Add impact analysis columns to changesets (#83)',
    sql: [
      "ALTER TABLE changesets ADD COLUMN impact_level TEXT NOT NULL DEFAULT 'none'",
      'ALTER TABLE changesets ADD COLUMN affected_resources_json TEXT NOT NULL DEFAULT \'[]\'',
      'ALTER TABLE changesets ADD COLUMN requires_restart INTEGER NOT NULL DEFAULT 0',
    ],
  },
  {
    version: 35,
    description: 'Add body column to github_issue_cache for triage modal',
    sql: [
      'ALTER TABLE github_issue_cache ADD COLUMN body TEXT',
    ],
  },
  {
    version: 36,
    description: 'Add html_url column to github_issue_cache for issue links',
    sql: [
      'ALTER TABLE github_issue_cache ADD COLUMN html_url TEXT',
    ],
  },

  // ── workflow_artifacts (#113) ─────────────────────────────────────
  {
    version: 37,
    description: 'Create workflow_artifacts table for file storage between steps (#113)',
    sql: [
      `CREATE TABLE IF NOT EXISTS workflow_artifacts (
        id           TEXT PRIMARY KEY,
        run_id       TEXT NOT NULL,
        step_id      TEXT NOT NULL,
        filename     TEXT NOT NULL,
        mime_type    TEXT NOT NULL DEFAULT 'application/octet-stream',
        size         INTEGER NOT NULL DEFAULT 0,
        storage_path TEXT NOT NULL,
        created_at   TEXT NOT NULL
      )`,
      'CREATE INDEX IF NOT EXISTS idx_workflow_artifacts_run_id ON workflow_artifacts(run_id)',
      'CREATE INDEX IF NOT EXISTS idx_workflow_artifacts_step_id ON workflow_artifacts(run_id, step_id)',
    ],
  },

  // ── issue_dependencies (#159) ─────────────────────────────────────
  {
    version: 38,
    description: 'Create issue_dependencies table for auto-dispatch on completion (#159)',
    sql: [
      `CREATE TABLE IF NOT EXISTS issue_dependencies (
        id                     TEXT PRIMARY KEY,
        project_id             TEXT NOT NULL,
        repo                   TEXT NOT NULL,
        issue_number           INTEGER NOT NULL,
        blocked_by_repo        TEXT NOT NULL,
        blocked_by_issue_number INTEGER NOT NULL,
        resolved               INTEGER NOT NULL DEFAULT 0,
        created_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      )`,
      'CREATE INDEX IF NOT EXISTS idx_issue_deps_blocked_by ON issue_dependencies(blocked_by_repo, blocked_by_issue_number)',
      'CREATE INDEX IF NOT EXISTS idx_issue_deps_issue ON issue_dependencies(repo, issue_number)',
    ],
  },

  // ── project_repos (#166) ──────────────────────────────────────────
  {
    version: 39,
    description: 'Create project_repos table for linking repos to source control integrations (#166)',
    sql: [
      `CREATE TABLE IF NOT EXISTS project_repos (
        id              TEXT PRIMARY KEY,
        project_id      TEXT NOT NULL,
        integration_id  TEXT NOT NULL,
        full_name       TEXT NOT NULL,
        default_branch  TEXT DEFAULT 'main',
        clone_url       TEXT,
        provider        TEXT NOT NULL,
        is_private      INTEGER NOT NULL DEFAULT 0,
        created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        UNIQUE(project_id, full_name)
      )`,
      'CREATE INDEX IF NOT EXISTS idx_project_repos_project ON project_repos(project_id)',
      'CREATE INDEX IF NOT EXISTS idx_project_repos_integration ON project_repos(integration_id)',
    ],
  },

  // ── migrate config.repositories → project_repos (#166) ───────────
  {
    version: 40,
    description: 'Migrate existing config.repositories data into project_repos table (#166)',
    run(db) {
      const uuidv4 = () => crypto.randomUUID();
      const projects = db.prepare('SELECT id, config_json FROM projects').all() as Array<{ id: string; config_json: string }>;

      for (const project of projects) {
        let config: any = {};
        try { config = JSON.parse(project.config_json || '{}'); } catch { continue; }
        if (!Array.isArray(config.repositories) || config.repositories.length === 0) continue;

        // Find a GitHub integration for this project
        const piRows = db.prepare(
          `SELECT pi.id, pi.integration_id, i.provider, i.auth_config
           FROM project_integrations pi
           JOIN integrations i ON i.id = pi.integration_id
           WHERE pi.project_id = ? AND i.provider IN ('github', 'bitbucket', 'gitlab')
           LIMIT 1`,
        ).get(project.id) as { id: string; integration_id: string; provider: string; auth_config: string } | undefined;

        if (!piRows) continue;

        for (const repo of config.repositories as Array<{ url: string; defaultBranch?: string }>) {
          const match = repo.url?.match(/(?:github\.com\/)?([^/]+\/[^/]+?)(?:\.git)?$/);
          if (!match) continue;
          const fullName = match[1].replace(/^\//, '');
          const existing = db.prepare('SELECT id FROM project_repos WHERE project_id = ? AND full_name = ?').get(project.id, fullName);
          if (existing) continue;
          const id = uuidv4();
          db.prepare(
            `INSERT OR IGNORE INTO project_repos (id, project_id, integration_id, full_name, default_branch, provider, is_private)
             VALUES (?, ?, ?, ?, ?, ?, 0)`,
          ).run(id, project.id, piRows.integration_id, fullName, repo.defaultBranch || 'main', piRows.provider);
        }
      }
    },
  },
  {
    version: 41,
    description: 'Create review_records, agent_lessons, and project_conventions tables (#185)',
    run(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS review_records (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          step_id TEXT NOT NULL,
          reviewer TEXT,
          executor TEXT,
          score INTEGER NOT NULL CHECK(score BETWEEN 1 AND 5),
          result TEXT NOT NULL CHECK(result IN ('approved', 'rejected')),
          feedback TEXT DEFAULT '',
          issues_json TEXT DEFAULT '[]',
          round INTEGER DEFAULT 1,
          category TEXT,
          created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        );
        CREATE INDEX IF NOT EXISTS idx_review_records_run ON review_records(run_id);
        CREATE INDEX IF NOT EXISTS idx_review_records_executor ON review_records(executor);

        CREATE TABLE IF NOT EXISTS agent_lessons (
          id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL,
          project_id TEXT,
          lesson TEXT NOT NULL,
          source TEXT DEFAULT 'review',
          severity TEXT DEFAULT 'medium',
          review_id TEXT,
          active INTEGER DEFAULT 1,
          times_injected INTEGER DEFAULT 0,
          created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          resolved_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_agent_lessons_agent ON agent_lessons(agent_id);
        CREATE INDEX IF NOT EXISTS idx_agent_lessons_active ON agent_lessons(active);

        CREATE TABLE IF NOT EXISTS project_conventions (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          convention TEXT NOT NULL,
          source TEXT DEFAULT 'extracted',
          evidence_count INTEGER DEFAULT 1,
          active INTEGER DEFAULT 1,
          created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        );
        CREATE INDEX IF NOT EXISTS idx_project_conventions_project ON project_conventions(project_id);

        CREATE TABLE IF NOT EXISTS agent_scores (
          agent_id TEXT NOT NULL,
          category TEXT NOT NULL DEFAULT 'overall',
          total_score INTEGER DEFAULT 0,
          review_count INTEGER DEFAULT 0,
          avg_score REAL DEFAULT 0,
          last_updated TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          PRIMARY KEY (agent_id, category)
        );
      `);
    },
  },
  {
    version: 42,
    description: 'Create prompt_versions table for tracking prompt evolution (#185 Phase 4)',
    run(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS prompt_versions (
          id TEXT PRIMARY KEY,
          workflow_id TEXT NOT NULL,
          step_id TEXT NOT NULL,
          version INTEGER NOT NULL DEFAULT 1,
          prompt_template TEXT NOT NULL,
          created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          retired_at TEXT,
          UNIQUE(workflow_id, step_id, version)
        );
        CREATE INDEX IF NOT EXISTS idx_prompt_versions_workflow ON prompt_versions(workflow_id, step_id);
      `);
    },
  },
  {
    version: 43,
    description: 'Add prompt_hash column to workflow_step_runs (#185 Phase 4)',
    sql: [
      "ALTER TABLE workflow_step_runs ADD COLUMN prompt_hash TEXT DEFAULT ''",
    ],
  },
  {
    version: 44,
    description: 'Add embeddings table for semantic search (#191)',
    run(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS embeddings (
          id TEXT PRIMARY KEY,
          entity_type TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          text TEXT NOT NULL,
          vector_json TEXT NOT NULL,
          model TEXT DEFAULT 'text-embedding-3-small',
          created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        );
        CREATE INDEX IF NOT EXISTS idx_embeddings_entity ON embeddings(entity_type, entity_id);
      `);
    },
  },
  {
    version: 45,
    description: 'Create patrol_records table for autonomous health monitoring (#194)',
    sql: [
      `CREATE TABLE IF NOT EXISTS patrol_records (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        severity TEXT NOT NULL,
        run_id TEXT,
        step_id TEXT,
        agent_id TEXT,
        description TEXT NOT NULL,
        action_taken TEXT DEFAULT '',
        status TEXT DEFAULT 'open',
        created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        resolved_at TEXT
      )`,
      'CREATE INDEX IF NOT EXISTS idx_patrol_type ON patrol_records(type)',
      'CREATE INDEX IF NOT EXISTS idx_patrol_status ON patrol_records(status)',
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
