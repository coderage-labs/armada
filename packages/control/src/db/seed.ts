import type Database from 'better-sqlite3';

/**
 * Seed default reference data.
 *
 * All inserts use INSERT OR IGNORE / INSERT OR REPLACE so this function is
 * safe to call on every startup — it only fills in what's missing and
 * applies known corrections (e.g. provider display-name fixes).
 */
export function runSeed(db: Database.Database): void {
  seedRoleMetadata(db);
  seedDefaultProject(db);
  seedModelProviders(db);
  // Model registry no longer seeded — users manage their own models via the UI
  // No default users seeded — the setup wizard handles first user creation
}

// ── Role metadata ──────────────────────────────────────────────────────────

function seedRoleMetadata(db: Database.Database): void {
  const roles = [
    { role: 'operator',        color: '#8b5cf6', description: 'Armada operator and orchestrator',      tier: 0, icon: '🎯' },
    { role: 'lead',            color: '#8b5cf6', description: 'Team lead',                            tier: 0, icon: '👑' },
    { role: 'project-manager', color: '#3b82f6', description: 'Coordinates and delegates tasks',      tier: 1, icon: '📋' },
    { role: 'development',     color: '#10b981', description: 'Builds and codes solutions',           tier: 2, icon: '⚒️' },
    { role: 'research',        color: '#f97316', description: 'Investigates and gathers information', tier: 2, icon: '🔭' },
    { role: 'design',          color: '#ec4899', description: 'Visual design and image generation',   tier: 2, icon: '🎨' },
  ];

  const insert = db.prepare(`
    INSERT OR IGNORE INTO role_metadata (role, color, description, tier, icon)
    VALUES (?, ?, ?, ?, ?)
  `);

  for (const r of roles) {
    insert.run(r.role, r.color, r.description, r.tier, r.icon);
  }
}

// ── Default project ────────────────────────────────────────────────────────

function seedDefaultProject(db: Database.Database): void {
  const { cnt } = db.prepare('SELECT COUNT(*) as cnt FROM projects').get() as { cnt: number };
  if (cnt === 0) {
    db.prepare(`
      INSERT INTO projects (id, name, description, color, icon)
      VALUES (?, 'general', 'Default project for ungrouped tasks', '#6b7280', '📋')
    `).run(crypto.randomUUID());
  }
}

// ── Model providers ────────────────────────────────────────────────────────

const KNOWN_PROVIDERS = [
  { id: 'anthropic',      name: 'Anthropic',        type: 'anthropic',      hidden: 0 },
  { id: 'openai',         name: 'OpenAI',            type: 'openai',         hidden: 0 },
  { id: 'openrouter',     name: 'OpenRouter',        type: 'openrouter',     hidden: 0 },
  { id: 'google',         name: 'Google AI Studio',  type: 'google',         hidden: 1 },
  { id: 'bedrock',        name: 'AWS Bedrock',       type: 'bedrock',        hidden: 1 },
  { id: 'ollama',         name: 'Ollama',            type: 'ollama',         hidden: 0 },
  { id: 'github-copilot', name: 'GitHub Copilot',    type: 'github-copilot', hidden: 1 },
] as const;

function seedModelProviders(db: Database.Database): void {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO model_providers (id, name, type, enabled, hidden)
    VALUES (?, ?, ?, 1, ?)
  `);

  for (const p of KNOWN_PROVIDERS) {
    insert.run(p.id, p.name, p.type, p.hidden);
  }

  // Apply known display-name and visibility corrections for existing installs
  db.prepare(`UPDATE model_providers SET name = 'Google AI Studio', hidden = 1 WHERE id = 'google'`).run();
  db.prepare(`UPDATE model_providers SET hidden = 1 WHERE id = 'github-copilot'`).run();
  db.prepare(`UPDATE model_providers SET hidden = 1 WHERE id = 'bedrock'`).run();
}

// ── Model registry ─────────────────────────────────────────────────────────

function seedModelRegistry(db: Database.Database): void {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO model_registry
      (id, name, provider, model_id, description, api_key_env_var, capabilities, cost_tier)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const models = [
    {
      name: 'Claude Sonnet 4.5',
      provider: 'anthropic',
      modelId: 'claude-sonnet-4-5',
      description: 'Fast, intelligent model for everyday tasks',
      envVar: 'ANTHROPIC_API_KEY',
      capabilities: '["tools","thinking"]',
      tier: 'standard',
    },
    {
      name: 'Claude Sonnet 4.6',
      provider: 'anthropic',
      modelId: 'claude-sonnet-4-6',
      description: 'Latest Sonnet — improved coding and reasoning',
      envVar: 'ANTHROPIC_API_KEY',
      capabilities: '["tools","thinking"]',
      tier: 'standard',
    },
    {
      name: 'Claude Haiku 4.5',
      provider: 'anthropic',
      modelId: 'claude-haiku-4-5',
      description: 'Fastest Claude model, great for simple tasks',
      envVar: 'ANTHROPIC_API_KEY',
      capabilities: '["tools"]',
      tier: 'cheap',
    },
    {
      name: 'Claude Opus 4.6',
      provider: 'anthropic',
      modelId: 'claude-opus-4-6',
      description: 'Most capable Claude model with vision',
      envVar: 'ANTHROPIC_API_KEY',
      capabilities: '["tools","thinking","vision"]',
      tier: 'premium',
    },
    {
      name: 'GPT-4o',
      provider: 'openai',
      modelId: 'gpt-4o',
      description: 'OpenAI flagship multimodal model',
      envVar: 'OPENAI_API_KEY',
      capabilities: '["tools","vision"]',
      tier: 'standard',
    },
    {
      name: 'Gemini 2.5 Flash',
      provider: 'google',
      modelId: 'gemini-2.5-flash-preview',
      description: 'Fast Google model with tool support',
      envVar: 'GOOGLE_API_KEY',
      capabilities: '["tools"]',
      tier: 'cheap',
    },
  ];

  for (const m of models) {
    insert.run(crypto.randomUUID(), m.name, m.provider, m.modelId, m.description, m.envVar, m.capabilities, m.tier);
  }
}


