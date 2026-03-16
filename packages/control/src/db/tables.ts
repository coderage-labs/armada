import type Database from 'better-sqlite3';

// ─────────────────────────────────────────────────────────────────────────────
// Table definitions
//
// Rule: define every column that belongs to the table here (including columns
// that were added via early migrations).  Migrations still exist for the ALTER
// TABLE path on *existing* databases; for fresh installs these CREATE TABLE
// statements are the source of truth.
// ─────────────────────────────────────────────────────────────────────────────

export function createTables(db: Database.Database): void {
  db.exec(`
    -- ── Core entities ────────────────────────────────────────────────

    CREATE TABLE IF NOT EXISTS nodes (
      id                      TEXT PRIMARY KEY,
      hostname                TEXT NOT NULL,
      ip                      TEXT NOT NULL,
      port                    INTEGER NOT NULL DEFAULT 8080,
      url                     TEXT NOT NULL DEFAULT '',
      token                   TEXT NOT NULL DEFAULT '',
      cores                   INTEGER NOT NULL DEFAULT 0,
      memory                  INTEGER NOT NULL DEFAULT 0,
      status                  TEXT NOT NULL DEFAULT 'offline',
      last_seen               TEXT,
      install_token           TEXT,
      session_credential_hash TEXT,
      fingerprint             TEXT,
      credential_rotated_at   TEXT
    );

    CREATE TABLE IF NOT EXISTS templates (
      id                    TEXT PRIMARY KEY,
      name                  TEXT NOT NULL UNIQUE,
      description           TEXT,
      image                 TEXT NOT NULL DEFAULT 'openclaw/openclaw:latest',
      role                  TEXT,
      skills                TEXT,
      model                 TEXT,
      resources_json        TEXT NOT NULL DEFAULT '{"memory":"2g","cpus":"1"}',
      plugins_json          TEXT NOT NULL DEFAULT '[]',
      skills_list_json      TEXT NOT NULL DEFAULT '[]',
      plugins_list_json     TEXT NOT NULL DEFAULT '[]',
      tools_deny_json       TEXT NOT NULL DEFAULT '[]',
      tools_allow_json      TEXT NOT NULL DEFAULT '[]',
      tools_json            TEXT NOT NULL DEFAULT '[]',
      tools_profile         TEXT NOT NULL DEFAULT '',
      models_json           TEXT NOT NULL DEFAULT '[]',
      soul                  TEXT,
      agents_md             TEXT,
      env_json              TEXT NOT NULL DEFAULT '[]',
      projects_json         TEXT NOT NULL DEFAULT '[]',
      internal_agents_json  TEXT NOT NULL DEFAULT '[]',
      contacts_json         TEXT NOT NULL DEFAULT '[]',
      created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS instances (
      id                      TEXT PRIMARY KEY,
      name                    TEXT NOT NULL UNIQUE,
      node_id                 TEXT NOT NULL REFERENCES nodes(id),
      url                     TEXT,
      token                   TEXT,
      status                  TEXT NOT NULL DEFAULT 'stopped',
      status_message          TEXT,
      capacity                INTEGER NOT NULL DEFAULT 5,
      config                  TEXT DEFAULT '{}',
      memory                  TEXT DEFAULT '2g',
      cpus                    TEXT DEFAULT '1',
      version                 TEXT DEFAULT NULL,
      target_version          TEXT DEFAULT NULL,
      applied_config_version  INTEGER DEFAULT 0,
      drain_mode              INTEGER DEFAULT 0,
      created_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE INDEX IF NOT EXISTS idx_instances_node_id ON instances(node_id);
    CREATE INDEX IF NOT EXISTS idx_instances_status  ON instances(status);

    CREATE TABLE IF NOT EXISTS agents (
      id                    TEXT PRIMARY KEY,
      name                  TEXT NOT NULL UNIQUE,
      node_id               TEXT NOT NULL,
      instance_id           TEXT NOT NULL REFERENCES instances(id),
      template_id           TEXT,
      container_id          TEXT,
      port                  INTEGER NOT NULL,
      status                TEXT NOT NULL DEFAULT 'stopped',
      role                  TEXT,
      skills                TEXT,
      model                 TEXT,
      last_heartbeat        TEXT,
      health_status         TEXT NOT NULL DEFAULT 'unknown',
      heartbeat_meta_json   TEXT,
      avatar_generating     INTEGER NOT NULL DEFAULT 0,
      soul                  TEXT,
      agents_md             TEXT,
      created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      FOREIGN KEY (node_id)      REFERENCES nodes(id),
      FOREIGN KEY (template_id)  REFERENCES templates(id)
    );

    CREATE TABLE IF NOT EXISTS plugins (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      version    TEXT NOT NULL,
      path       TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id                   TEXT PRIMARY KEY,
      from_agent           TEXT NOT NULL,
      to_agent             TEXT NOT NULL,
      task_text            TEXT NOT NULL,
      result               TEXT,
      status               TEXT NOT NULL DEFAULT 'pending',
      blocked_reason       TEXT,
      blocked_at           TEXT,
      project_id           TEXT DEFAULT NULL,
      github_issue_url     TEXT DEFAULT NULL,
      github_issue_number  INTEGER DEFAULT NULL,
      github_pr_url        TEXT DEFAULT NULL,
      board_column         TEXT DEFAULT NULL,
      workflow_run_id      TEXT DEFAULT NULL,
      last_progress_at     TEXT DEFAULT NULL,
      created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      completed_at         TEXT
    );

    CREATE TABLE IF NOT EXISTS deploys (
      id           TEXT PRIMARY KEY,
      type         TEXT NOT NULL,
      target       TEXT,
      status       TEXT NOT NULL DEFAULT 'pending',
      log          TEXT,
      started_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS settings (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS role_metadata (
      role          TEXT PRIMARY KEY,
      color         TEXT NOT NULL DEFAULT '#6b7280',
      description   TEXT NOT NULL DEFAULT '',
      tier          INTEGER NOT NULL DEFAULT 2,
      icon          TEXT DEFAULT NULL,
      allowed_tools TEXT DEFAULT NULL
    );

    CREATE TABLE IF NOT EXISTS activity (
      id         TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      agent_name TEXT,
      detail     TEXT,
      metadata   TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS task_comments (
      id         TEXT PRIMARY KEY,
      task_id    TEXT NOT NULL,
      author     TEXT NOT NULL,
      content    TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    );

    -- ── Projects & workflows ───────────────────────────────────────────────

    CREATE TABLE IF NOT EXISTS projects (
      id             TEXT PRIMARY KEY,
      name           TEXT UNIQUE NOT NULL,
      description    TEXT NOT NULL DEFAULT '',
      context_md     TEXT NOT NULL DEFAULT '',
      color          TEXT NOT NULL DEFAULT '#6b7280',
      icon           TEXT DEFAULT NULL,
      archived       INTEGER NOT NULL DEFAULT 0,
      config_json    TEXT NOT NULL DEFAULT '{}',
      max_concurrent INTEGER NOT NULL DEFAULT 3,
      created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS workflows (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      steps_json  TEXT NOT NULL DEFAULT '[]',
      enabled     INTEGER NOT NULL DEFAULT 1,
      created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS workflow_projects (
      workflow_id TEXT NOT NULL,
      project_id  TEXT NOT NULL,
      PRIMARY KEY (workflow_id, project_id),
      FOREIGN KEY (workflow_id) REFERENCES workflows(id)  ON DELETE CASCADE,
      FOREIGN KEY (project_id)  REFERENCES projects(id)   ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS workflow_runs (
      id           TEXT PRIMARY KEY,
      workflow_id  TEXT NOT NULL,
      project_id   TEXT NOT NULL,
      trigger_type TEXT NOT NULL DEFAULT 'manual',
      trigger_ref  TEXT DEFAULT NULL,
      status       TEXT NOT NULL DEFAULT 'running',
      current_step TEXT DEFAULT NULL,
      context_json TEXT NOT NULL DEFAULT '{}',
      created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      completed_at TEXT DEFAULT NULL,
      FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS workflow_step_runs (
      id                          TEXT PRIMARY KEY,
      run_id                      TEXT NOT NULL,
      step_id                     TEXT NOT NULL,
      step_index                  INTEGER NOT NULL,
      role                        TEXT NOT NULL,
      agent_name                  TEXT DEFAULT NULL,
      task_id                     TEXT DEFAULT NULL,
      status                      TEXT NOT NULL DEFAULT 'pending',
      input_json                  TEXT NOT NULL DEFAULT '{}',
      output                      TEXT DEFAULT NULL,
      shared_refs_json            TEXT NOT NULL DEFAULT '[]',
      telegram_notifications_json TEXT DEFAULT NULL,
      started_at                  TEXT DEFAULT NULL,
      completed_at                TEXT DEFAULT NULL,
      FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
    );

    -- ── Webhooks ───────────────────────────────────────────────────────────

    CREATE TABLE IF NOT EXISTS webhooks (
      id         TEXT PRIMARY KEY,
      url        TEXT NOT NULL,
      events     TEXT NOT NULL DEFAULT '*',
      secret     TEXT DEFAULT NULL,
      enabled    INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS webhook_deliveries (
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
    );
    CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_webhook_id ON webhook_deliveries(webhook_id);

    CREATE TABLE IF NOT EXISTS webhooks_inbound (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      hook_id         TEXT NOT NULL UNIQUE,
      secret          TEXT,
      action          TEXT NOT NULL,
      action_config   TEXT NOT NULL DEFAULT '{}',
      enabled         INTEGER NOT NULL DEFAULT 1,
      last_delivery_at TEXT,
      delivery_count  INTEGER NOT NULL DEFAULT 0,
      created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    -- ── Skills & plugins library ──────────────────────────────────────────

    CREATE TABLE IF NOT EXISTS skill_library (
      id                TEXT PRIMARY KEY,
      name              TEXT UNIQUE NOT NULL,
      source            TEXT NOT NULL DEFAULT 'clawhub',
      url               TEXT DEFAULT NULL,
      version           TEXT DEFAULT NULL,
      description       TEXT DEFAULT '',
      installed_version TEXT DEFAULT NULL,
      created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS plugin_library (
      id          TEXT PRIMARY KEY,
      name        TEXT UNIQUE NOT NULL,
      source      TEXT NOT NULL DEFAULT 'github',
      url         TEXT DEFAULT NULL,
      version     TEXT DEFAULT NULL,
      description TEXT NOT NULL DEFAULT '',
      system      INTEGER NOT NULL DEFAULT 0,
      npm_pkg     TEXT,
      created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    -- ── Users, auth & access control ──────────────────────────────────────

    CREATE TABLE IF NOT EXISTS users (
      id                   TEXT PRIMARY KEY,
      name                 TEXT NOT NULL UNIQUE,
      display_name         TEXT NOT NULL,
      type                 TEXT NOT NULL DEFAULT 'operator',
      role                 TEXT NOT NULL DEFAULT 'viewer',
      avatar_url           TEXT DEFAULT NULL,
      avatar_generating    INTEGER NOT NULL DEFAULT 0,
      password_hash        TEXT DEFAULT NULL,
      linked_accounts_json TEXT NOT NULL DEFAULT '{}',
      notifications_json   TEXT NOT NULL DEFAULT '{}',
      created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS user_projects (
      user_id    TEXT NOT NULL,
      project_id TEXT NOT NULL,
      role       TEXT NOT NULL DEFAULT 'member',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      PRIMARY KEY (user_id, project_id),
      FOREIGN KEY (user_id)    REFERENCES users(id)    ON DELETE CASCADE,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS auth_tokens (
      id          TEXT PRIMARY KEY,
      token_hash  TEXT NOT NULL UNIQUE,
      user_id     TEXT,
      agent_name  TEXT,
      label       TEXT NOT NULL DEFAULT '',
      scopes      TEXT NOT NULL DEFAULT '[]',
      expires_at  TEXT,
      last_used_at TEXT,
      created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS passkeys (
      id            TEXT PRIMARY KEY,
      user_id       TEXT NOT NULL,
      credential_id TEXT NOT NULL UNIQUE,
      public_key    TEXT NOT NULL,
      counter       INTEGER NOT NULL DEFAULT 0,
      transports    TEXT,
      label         TEXT NOT NULL DEFAULT 'Passkey',
      created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS auth_challenges (
      id         TEXT PRIMARY KEY,
      challenge  TEXT NOT NULL,
      user_id    TEXT,
      type       TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS invites (
      id           TEXT PRIMARY KEY,
      token_hash   TEXT NOT NULL UNIQUE,
      created_by   TEXT NOT NULL,
      role         TEXT NOT NULL DEFAULT 'viewer',
      display_name TEXT,
      expires_at   TEXT NOT NULL,
      used_at      TEXT,
      used_by      TEXT,
      created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id            TEXT PRIMARY KEY,
      timestamp     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      caller_id     TEXT,
      caller_name   TEXT,
      caller_type   TEXT NOT NULL DEFAULT 'system',
      action        TEXT NOT NULL,
      resource_type TEXT,
      resource_id   TEXT,
      detail        TEXT,
      ip_address    TEXT
    );

    -- ── Integrations ───────────────────────────────────────────────────────

    CREATE TABLE IF NOT EXISTS integrations (
      id             TEXT PRIMARY KEY,
      name           TEXT NOT NULL UNIQUE,
      provider       TEXT NOT NULL,
      auth_type      TEXT NOT NULL,
      auth_config    TEXT NOT NULL,
      capabilities   TEXT NOT NULL DEFAULT '[]',
      status         TEXT DEFAULT 'active',
      status_message TEXT,
      created_at     TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at     TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS project_integrations (
      id             TEXT PRIMARY KEY,
      project_id     TEXT NOT NULL,
      integration_id TEXT NOT NULL,
      capability     TEXT NOT NULL,
      config         TEXT NOT NULL DEFAULT '{}',
      enabled        INTEGER DEFAULT 1,
      sync_cursor    TEXT,
      last_synced_at TEXT,
      created_at     TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      UNIQUE(project_id, integration_id, capability),
      FOREIGN KEY (project_id)     REFERENCES projects(id)     ON DELETE CASCADE,
      FOREIGN KEY (integration_id) REFERENCES integrations(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS triaged_issues (
      id           TEXT PRIMARY KEY,
      project_id   TEXT NOT NULL,
      issue_number INTEGER NOT NULL,
      triaged_at   TEXT NOT NULL,
      UNIQUE(project_id, issue_number)
    );

    CREATE TABLE IF NOT EXISTS github_issue_cache (
      id           TEXT PRIMARY KEY,
      project_id   TEXT NOT NULL,
      repo         TEXT NOT NULL,
      issue_number INTEGER NOT NULL,
      title        TEXT,
      state        TEXT,
      labels_json  TEXT,
      assignees_json TEXT,
      created_at   TEXT,
      updated_at   TEXT,
      cached_at    TEXT NOT NULL,
      UNIQUE(project_id, repo, issue_number)
    );

    CREATE TABLE IF NOT EXISTS external_issues (
      id                     TEXT PRIMARY KEY,
      project_integration_id TEXT NOT NULL,
      external_id            TEXT NOT NULL,
      title                  TEXT NOT NULL,
      description            TEXT,
      status                 TEXT,
      priority               TEXT,
      assignee               TEXT,
      labels                 TEXT DEFAULT '[]',
      url                    TEXT,
      raw_data               TEXT,
      created_at             TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at             TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      synced_at              TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      UNIQUE(project_integration_id, external_id),
      FOREIGN KEY (project_integration_id) REFERENCES project_integrations(id) ON DELETE CASCADE
    );

    -- ── Model providers & registry ────────────────────────────────────────

    CREATE TABLE IF NOT EXISTS model_providers (
      id               TEXT PRIMARY KEY,
      name             TEXT NOT NULL,
      type             TEXT NOT NULL,
      api_key          TEXT,
      base_url         TEXT,
      enabled          INTEGER NOT NULL DEFAULT 1,
      hidden           INTEGER NOT NULL DEFAULT 0,
      fallback_enabled INTEGER NOT NULL DEFAULT 0,
      fallback_behavior TEXT NOT NULL DEFAULT 'immediate',
      last_sync_at     TEXT,
      model_count      INTEGER NOT NULL DEFAULT 0,
      created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS provider_api_keys (
      id          TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      name        TEXT NOT NULL,
      api_key     TEXT NOT NULL,
      is_default  INTEGER NOT NULL DEFAULT 0,
      priority    INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS model_registry (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL UNIQUE,
      provider        TEXT NOT NULL,
      model_id        TEXT NOT NULL,
      description     TEXT NOT NULL DEFAULT '',
      api_key_env_var TEXT DEFAULT NULL,
      capabilities    TEXT NOT NULL DEFAULT '[]',
      max_tokens      INTEGER DEFAULT NULL,
      cost_tier       TEXT DEFAULT 'standard',
      provider_id     TEXT,
      source          TEXT DEFAULT 'manual',
      created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    -- ── Operations engine ─────────────────────────────────────────────────

    CREATE TABLE IF NOT EXISTS operations (
      id           TEXT PRIMARY KEY,
      type         TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'running',
      target_type  TEXT,
      target_id    TEXT,
      target_json  TEXT,
      steps_json   TEXT DEFAULT '[]',
      priority     TEXT NOT NULL DEFAULT 'normal',
      created_by   TEXT,
      error        TEXT,
      started_at   TEXT NOT NULL,
      completed_at TEXT,
      events_json  TEXT DEFAULT '[]',
      result_json  TEXT
    );

    CREATE TABLE IF NOT EXISTS operation_locks (
      target_type  TEXT NOT NULL,
      target_id    TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      acquired_at  TEXT NOT NULL,
      PRIMARY KEY (target_type, target_id)
    );

    -- ── Changesets & mutations ────────────────────────────────────────────

    CREATE TABLE IF NOT EXISTS changesets (
      id           TEXT PRIMARY KEY,
      status       TEXT NOT NULL DEFAULT 'draft',
      changes_json TEXT NOT NULL DEFAULT '[]',
      plan_json    TEXT NOT NULL DEFAULT '{}',
      rollback_json TEXT,
      created_by   TEXT,
      created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      approved_by  TEXT,
      approved_at  TEXT,
      applied_at   TEXT,
      completed_at TEXT,
      error        TEXT
    );

    CREATE TABLE IF NOT EXISTS changeset_operations (
      changeset_id TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      instance_id  TEXT NOT NULL,
      PRIMARY KEY (changeset_id, operation_id)
    );

    CREATE TABLE IF NOT EXISTS pending_mutations (
      id            TEXT PRIMARY KEY,
      changeset_id  TEXT NOT NULL,
      entity_type   TEXT NOT NULL,
      entity_id     TEXT,
      action        TEXT NOT NULL CHECK(action IN ('create', 'update', 'delete')),
      payload_json  TEXT NOT NULL DEFAULT '{}',
      instance_id   TEXT,
      created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE INDEX IF NOT EXISTS idx_pending_mutations_changeset ON pending_mutations(changeset_id);

    -- ── Deleted agents (workspace retention, #299) ────────────────────────

    CREATE TABLE IF NOT EXISTS deleted_agents (
      id               TEXT PRIMARY KEY,
      name             TEXT NOT NULL,
      node_id          TEXT NOT NULL,
      instance_id      TEXT NOT NULL,
      deleted_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      workspace_deleted INTEGER NOT NULL DEFAULT 0
    );

    -- ── Notification channels (#512) ─────────────────────────────────────

    CREATE TABLE IF NOT EXISTS notification_channels (
      id         TEXT PRIMARY KEY,
      type       TEXT NOT NULL,
      name       TEXT NOT NULL,
      enabled    INTEGER NOT NULL DEFAULT 1,
      config     TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    -- ── Schema version tracking ───────────────────────────────────────────

    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY
    );
  `);
}
