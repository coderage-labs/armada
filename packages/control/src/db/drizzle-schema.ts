/**
 * Drizzle ORM schema — mirrors the existing SQLite tables exactly.
 * This is additive only; the existing raw-SQL schema.ts is untouched.
 */
import { sqliteTable, text, integer, real, primaryKey, unique, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

// ── nodes ────────────────────────────────────────────────────────────
export const nodes = sqliteTable('nodes', {
  id: text('id').primaryKey(),
  hostname: text('hostname').notNull(),
  /** @deprecated Nodes connect via WebSocket — kept for migration safety, not actively used */
  ip: text('ip').notNull().default(''),
  /** @deprecated Nodes connect via WebSocket — kept for migration safety, not actively used */
  port: integer('port').notNull().default(8080),
  /** @deprecated Nodes connect via WebSocket — kept for migration safety, not actively used */
  url: text('url').notNull().default(''),
  /** @deprecated Nodes connect via WebSocket — kept for migration safety, not actively used */
  token: text('token').notNull().default(''),
  cores: integer('cores').notNull().default(0),
  memory: integer('memory').notNull().default(0),
  status: text('status').notNull().default('offline'),
  lastSeen: text('last_seen'),
  // ── Registration fields (WP6) ────────────────────────────────────
  /** One-time install token — nulled out after first use */
  installToken: text('install_token'),
  /** bcrypt hash of the long-lived session credential */
  sessionCredentialHash: text('session_credential_hash'),
  /** SHA-256 fingerprint of the node machine */
  fingerprint: text('fingerprint'),
  /** ISO timestamp of last credential rotation */
  credentialRotatedAt: text('credential_rotated_at'),
});

// ── templates ────────────────────────────────────────────────────────
export const templates = sqliteTable('templates', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  description: text('description'),
  image: text('image').notNull().default('openclaw/openclaw:latest'),
  role: text('role'),
  skills: text('skills'),
  model: text('model'),
  resourcesJson: text('resources_json').notNull().default('{"memory":"2g","cpus":"1"}'),
  pluginsJson: text('plugins_json').notNull().default('[]'),
  skillsListJson: text('skills_list_json').notNull().default('[]'),
  toolsDenyJson: text('tools_deny_json').notNull().default('[]'),
  soul: text('soul'),
  agentsMd: text('agents_md'),
  envJson: text('env_json').notNull().default('[]'),
  createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  pluginsListJson: text('plugins_list_json').notNull().default('[]'),
  toolsAllowJson: text('tools_allow_json').notNull().default('[]'),
  toolsProfile: text('tools_profile').notNull().default(''),
  internalAgentsJson: text('internal_agents_json').notNull().default('[]'),
  contactsJson: text('contacts_json').notNull().default('[]'),
  toolsJson: text('tools_json').notNull().default('[]'),
  projectsJson: text('projects_json').notNull().default('[]'),
  modelsJson: text('models_json').notNull().default('[]'),
});

// ── instances ────────────────────────────────────────────────────────
export const instances = sqliteTable('instances', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  nodeId: text('node_id').notNull().references(() => nodes.id),
  url: text('url'),
  token: text('token'),
  status: text('status').notNull().default('stopped'),
  statusMessage: text('status_message'),
  capacity: integer('capacity').notNull().default(5),
  config: text('config').default('{}'),
  createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  memory: text('memory').default('2g'),
  cpus: text('cpus').default('1'),
  version: text('version'),
  targetVersion: text('target_version'),
  appliedConfigVersion: integer('applied_config_version').default(0),
  drainMode: integer('drain_mode').default(0),
});

// ── agents ───────────────────────────────────────────────────────────
export const agents = sqliteTable('agents', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  nodeId: text('node_id').notNull().references(() => nodes.id),
  instanceId: text('instance_id').notNull().references(() => instances.id),
  templateId: text('template_id').references(() => templates.id),
  containerId: text('container_id'),
  port: integer('port').notNull(),
  status: text('status').notNull().default('stopped'),
  role: text('role'),
  skills: text('skills'),
  model: text('model'),
  createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  lastHeartbeat: text('last_heartbeat'),
  healthStatus: text('health_status').notNull().default('unknown'),
  heartbeatMetaJson: text('heartbeat_meta_json'),
  avatarGenerating: integer('avatar_generating').notNull().default(0),
  avatarVersion: integer('avatar_version').notNull().default(0),
  soul: text('soul'),
  agentsMd: text('agents_md'),
});

// ── plugins ──────────────────────────────────────────────────────────
export const plugins = sqliteTable('plugins', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  version: text('version').notNull(),
  path: text('path').notNull(),
  updatedAt: text('updated_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
});

// ── tasks ────────────────────────────────────────────────────────────
export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(),
  fromAgent: text('from_agent').notNull(),
  toAgent: text('to_agent').notNull(),
  taskText: text('task_text').notNull(),
  result: text('result'),
  status: text('status').notNull().default('pending'),
  createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  completedAt: text('completed_at'),
  blockedReason: text('blocked_reason'),
  blockedAt: text('blocked_at'),
  projectId: text('project_id'),
  githubIssueUrl: text('github_issue_url'),
  githubIssueNumber: integer('github_issue_number'),
  githubPrUrl: text('github_pr_url'),
  boardColumn: text('board_column'),
  workflowRunId: text('workflow_run_id'),
  lastProgressAt: text('last_progress_at'),
  taskType: text('task_type').notNull().default('generic'),
  taskPayload: text('task_payload'),
});

// ── deploys ──────────────────────────────────────────────────────────
export const deploys = sqliteTable('deploys', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  target: text('target'),
  status: text('status').notNull().default('pending'),
  log: text('log'),
  startedAt: text('started_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  completedAt: text('completed_at'),
});

// ── settings ─────────────────────────────────────────────────────────
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
});

// ── role_metadata ────────────────────────────────────────────────────
export const roleMetadata = sqliteTable('role_metadata', {
  role: text('role').primaryKey(),
  color: text('color').notNull().default('#6b7280'),
  description: text('description').notNull().default(''),
  tier: integer('tier').notNull().default(2),
  icon: text('icon'),
  allowedTools: text('allowed_tools'),
});

// ── activity ─────────────────────────────────────────────────────────
export const activity = sqliteTable('activity', {
  id: text('id').primaryKey(),
  eventType: text('event_type').notNull(),
  agentName: text('agent_name'),
  detail: text('detail'),
  metadata: text('metadata'),
  createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
});

// ── task_comments ────────────────────────────────────────────────────
export const taskComments = sqliteTable('task_comments', {
  id: text('id').primaryKey(),
  taskId: text('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  author: text('author').notNull(),
  content: text('content').notNull(),
  createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
});

// ── projects ─────────────────────────────────────────────────────────
export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  description: text('description').notNull().default(''),
  contextMd: text('context_md').notNull().default(''),
  color: text('color').notNull().default('#6b7280'),
  icon: text('icon'),
  archived: integer('archived').notNull().default(0),
  configJson: text('config_json').notNull().default('{}'),
  maxConcurrent: integer('max_concurrent').notNull().default(3),
  createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
});

// ── webhooks ─────────────────────────────────────────────────────────
export const webhooks = sqliteTable('webhooks', {
  id: text('id').primaryKey(),
  url: text('url').notNull(),
  events: text('events').notNull().default('*'),
  secret: text('secret'),
  enabled: integer('enabled').notNull().default(1),
  createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
});

// ── webhook_deliveries ────────────────────────────────────────────────
export const webhookDeliveries = sqliteTable('webhook_deliveries', {
  id: text('id').primaryKey(),
  webhookId: text('webhook_id').notNull().references(() => webhooks.id, { onDelete: 'cascade' }),
  eventType: text('event_type').notNull(),
  status: text('status').notNull().default('pending'),
  statusCode: integer('status_code'),
  responseBody: text('response_body'),
  payload: text('payload'),
  attempt: integer('attempt').default(1),
  error: text('error'),
  latencyMs: integer('latency_ms'),
  createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  completedAt: text('completed_at'),
});

// ── webhooks_inbound ──────────────────────────────────────────────────
export const webhooksInbound = sqliteTable('webhooks_inbound', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  hookId: text('hook_id').notNull().unique(),
  secret: text('secret'),
  action: text('action').notNull(), // 'workflow' | 'task' | 'event'
  actionConfig: text('action_config').notNull().default('{}'),
  enabled: integer('enabled').notNull().default(1),
  lastDeliveryAt: text('last_delivery_at'),
  deliveryCount: integer('delivery_count').notNull().default(0),
  createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
});

// ── skill_library ────────────────────────────────────────────────────
export const skillLibrary = sqliteTable('skill_library', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  source: text('source').notNull().default('clawhub'),
  url: text('url'),
  version: text('version'),
  description: text('description').default(''),
  installedVersion: text('installed_version'),
  createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
});

// ── plugin_library ───────────────────────────────────────────────────
export const pluginLibrary = sqliteTable('plugin_library', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  source: text('source').notNull().default('github'),
  url: text('url'),
  version: text('version'),
  description: text('description').notNull().default(''),
  createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  system: integer('system').notNull().default(0),
  npmPkg: text('npm_pkg'),
});

// ── workflows ────────────────────────────────────────────────────────
export const workflows = sqliteTable('workflows', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  stepsJson: text('steps_json').notNull().default('[]'),
  enabled: integer('enabled').notNull().default(1),
  createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
});

// ── workflow_projects ────────────────────────────────────────────────
export const workflowProjects = sqliteTable('workflow_projects', {
  workflowId: text('workflow_id').notNull().references(() => workflows.id, { onDelete: 'cascade' }),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
}, (table) => [
  primaryKey({ columns: [table.workflowId, table.projectId] }),
]);

// ── workflow_runs ────────────────────────────────────────────────────
export const workflowRuns = sqliteTable('workflow_runs', {
  id: text('id').primaryKey(),
  workflowId: text('workflow_id').notNull().references(() => workflows.id, { onDelete: 'cascade' }),
  projectId: text('project_id').notNull(),
  triggerType: text('trigger_type').notNull().default('manual'),
  triggerRef: text('trigger_ref'),
  status: text('status').notNull().default('running'),
  currentStep: text('current_step'),
  contextJson: text('context_json').notNull().default('{}'),
  createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  completedAt: text('completed_at'),
});

// ── workflow_step_runs ───────────────────────────────────────────────
export const workflowStepRuns = sqliteTable('workflow_step_runs', {
  id: text('id').primaryKey(),
  runId: text('run_id').notNull().references(() => workflowRuns.id, { onDelete: 'cascade' }),
  stepId: text('step_id').notNull(),
  stepIndex: integer('step_index').notNull(),
  role: text('role').notNull(),
  agentName: text('agent_name'),
  taskId: text('task_id'),
  status: text('status').notNull().default('pending'),
  inputJson: text('input_json').notNull().default('{}'),
  output: text('output'),
  sharedRefsJson: text('shared_refs_json').notNull().default('[]'),
  startedAt: text('started_at'),
  completedAt: text('completed_at'),
  retryConfigJson: text('retry_config'),
  telegramNotificationsJson: text('telegram_notifications_json'),
});

// ── users ────────────────────────────────────────────────────────────
export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  displayName: text('display_name').notNull(),
  type: text('type').notNull().default('operator'),
  role: text('role').notNull().default('viewer'),
  avatarUrl: text('avatar_url'),
  passwordHash: text('password_hash'),
  linkedAccountsJson: text('linked_accounts_json').notNull().default('{}'),
  notificationsJson: text('notifications_json').notNull().default('{}'),
  channelsJson: text('channels_json').notNull().default('{}'),
  createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  avatarGenerating: integer('avatar_generating').notNull().default(0),
  avatarVersion: integer('avatar_version').notNull().default(0),
});

// ── user_projects ────────────────────────────────────────────────────
export const userProjects = sqliteTable('user_projects', {
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  role: text('role').notNull().default('member'),
  createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
}, (table) => [
  primaryKey({ columns: [table.userId, table.projectId] }),
]);

// ── integrations ─────────────────────────────────────────────────────
export const integrations = sqliteTable('integrations', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  provider: text('provider').notNull(),
  authType: text('auth_type').notNull(),
  authConfig: text('auth_config').notNull(),
  capabilities: text('capabilities').notNull().default('[]'),
  status: text('status').default('active'),
  statusMessage: text('status_message'),
  createdAt: text('created_at').default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  updatedAt: text('updated_at').default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
});

// ── project_integrations ─────────────────────────────────────────────
export const projectIntegrations = sqliteTable('project_integrations', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  integrationId: text('integration_id').notNull().references(() => integrations.id, { onDelete: 'cascade' }),
  capability: text('capability').notNull(),
  config: text('config').notNull().default('{}'),
  enabled: integer('enabled').default(1),
  syncCursor: text('sync_cursor'),
  lastSyncedAt: text('last_synced_at'),
  createdAt: text('created_at').default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
}, (table) => [
  unique().on(table.projectId, table.integrationId, table.capability),
]);

// ── triaged_issues ───────────────────────────────────────────────────
export const triagedIssues = sqliteTable('triaged_issues', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull(),
  issueNumber: integer('issue_number').notNull(),
  triagedAt: text('triaged_at').notNull(),
}, (table) => [
  unique().on(table.projectId, table.issueNumber),
]);

// ── github_issue_cache ───────────────────────────────────────────────
export const githubIssueCache = sqliteTable('github_issue_cache', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull(),
  repo: text('repo').notNull(),
  issueNumber: integer('issue_number').notNull(),
  title: text('title'),
  body: text('body'),
  htmlUrl: text('html_url'),
  state: text('state'),
  labelsJson: text('labels_json'),
  assigneesJson: text('assignees_json'),
  createdAt: text('created_at'),
  updatedAt: text('updated_at'),
  cachedAt: text('cached_at').notNull(),
}, (table) => [
  unique().on(table.projectId, table.repo, table.issueNumber),
]);

// ── external_issues ──────────────────────────────────────────────────
export const externalIssues = sqliteTable('external_issues', {
  id: text('id').primaryKey(),
  projectIntegrationId: text('project_integration_id').notNull().references(() => projectIntegrations.id, { onDelete: 'cascade' }),
  externalId: text('external_id').notNull(),
  title: text('title').notNull(),
  description: text('description'),
  status: text('status'),
  priority: text('priority'),
  assignee: text('assignee'),
  labels: text('labels').default('[]'),
  url: text('url'),
  rawData: text('raw_data'),
  createdAt: text('created_at').default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  updatedAt: text('updated_at').default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  syncedAt: text('synced_at').default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
}, (table) => [
  unique().on(table.projectIntegrationId, table.externalId),
]);

// ── auth_tokens ──────────────────────────────────────────────────────
export const authTokens = sqliteTable('auth_tokens', {
  id: text('id').primaryKey(),
  tokenHash: text('token_hash').notNull().unique(),
  userId: text('user_id').references(() => users.id),
  agentName: text('agent_name'),
  label: text('label').notNull().default(''),
  scopes: text('scopes').notNull().default('[]'),
  expiresAt: text('expires_at'),
  lastUsedAt: text('last_used_at'),
  createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
});

// ── sessions ─────────────────────────────────────────────────────────
export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: text('expires_at').notNull(),
  createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
});

// ── audit_log ────────────────────────────────────────────────────────
export const auditLog = sqliteTable('audit_log', {
  id: text('id').primaryKey(),
  timestamp: text('timestamp').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  callerId: text('caller_id'),
  callerName: text('caller_name'),
  callerType: text('caller_type').notNull().default('system'),
  action: text('action').notNull(),
  resourceType: text('resource_type'),
  resourceId: text('resource_id'),
  detail: text('detail'),
  ipAddress: text('ip_address'),
});

// ── passkeys ─────────────────────────────────────────────────────────
export const passkeys = sqliteTable('passkeys', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  credentialId: text('credential_id').notNull().unique(),
  publicKey: text('public_key').notNull(),
  counter: integer('counter').notNull().default(0),
  transports: text('transports'),
  label: text('label').notNull().default('Passkey'),
  createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
});

// ── auth_challenges ──────────────────────────────────────────────────
export const authChallenges = sqliteTable('auth_challenges', {
  id: text('id').primaryKey(),
  challenge: text('challenge').notNull(),
  userId: text('user_id'),
  type: text('type').notNull(),
  expiresAt: text('expires_at').notNull(),
  createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
});

// ── operations ───────────────────────────────────────────────────────
export const operations = sqliteTable('operations', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  status: text('status').notNull().default('pending'),
  targetType: text('target_type'),
  targetId: text('target_id'),
  targetJson: text('target_json'),
  stepsJson: text('steps_json').default('[]'),
  stepDepsJson: text('step_deps_json').default('[]'),
  priority: text('priority').notNull().default('normal'),
  createdBy: text('created_by'),
  error: text('error'),
  startedAt: text('started_at').notNull(),
  completedAt: text('completed_at'),
  eventsJson: text('events_json').default('[]'),
  resultJson: text('result_json'),
});

// ── model_providers ──────────────────────────────────────────────────
export const modelProviders = sqliteTable('model_providers', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  type: text('type').notNull(), // 'anthropic' | 'openai' | 'openrouter' | 'google' | 'bedrock' | 'ollama' | 'openai-compat' | 'github-copilot'
  apiKey: text('api_key'), // legacy, keys now in provider_api_keys
  baseUrl: text('base_url'), // custom URL for proxies
  enabled: integer('enabled').notNull().default(1),
  hidden: integer('hidden').notNull().default(0),
  /** When true, armada generates fallback model entries for lower-priority keys (#303) */
  fallbackEnabled: integer('fallback_enabled').notNull().default(0),
  /** 'immediate' = fail over instantly, 'backoff' = exponential retry before failover (#303) */
  fallbackBehavior: text('fallback_behavior').notNull().default('immediate'),
  lastSyncAt: text('last_sync_at'),
  modelCount: integer('model_count').notNull().default(0),
  createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
});

// ── provider_api_keys ────────────────────────────────────────────────
export const providerApiKeys = sqliteTable('provider_api_keys', {
  id: text('id').primaryKey(),
  providerId: text('provider_id').notNull(),
  name: text('name').notNull(),
  apiKey: text('api_key').notNull(),
  isDefault: integer('is_default').notNull().default(0),
  priority: integer('priority').notNull().default(0),
  createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
});

// ── model_registry ───────────────────────────────────────────────────
export const modelRegistry = sqliteTable('model_registry', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  provider: text('provider').notNull(),
  modelId: text('model_id').notNull(),
  description: text('description').notNull().default(''),
  apiKeyEnvVar: text('api_key_env_var'),
  capabilities: text('capabilities').notNull().default('[]'),
  maxTokens: integer('max_tokens'),
  costTier: text('cost_tier').default('standard'),
  providerId: text('provider_id'),
  source: text('source').default('manual'),
  createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
});

// ── deleted_agents ────────────────────────────────────────────────────
export const deletedAgents = sqliteTable('deleted_agents', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  nodeId: text('node_id').notNull(),
  instanceId: text('instance_id').notNull(),
  deletedAt: text('deleted_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  workspaceDeleted: integer('workspace_deleted').notNull().default(0),
});

// ── invites ──────────────────────────────────────────────────────────
export const invites = sqliteTable('invites', {
  id: text('id').primaryKey(),
  tokenHash: text('token_hash').notNull().unique(),
  createdBy: text('created_by').notNull(),
  role: text('role').notNull().default('viewer'),
  displayName: text('display_name'),
  expiresAt: text('expires_at').notNull(),
  usedAt: text('used_at'),
  usedBy: text('used_by'),
  createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
});

// ── operation_locks ──────────────────────────────────────────────────
export const operationLocks = sqliteTable('operation_locks', {
  targetType: text('target_type').notNull(), // 'instance' | 'node' | 'global'
  targetId: text('target_id').notNull(),     // instance/node ID, or 'armada' for global
  operationId: text('operation_id').notNull(),
  acquiredAt: text('acquired_at').notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.targetType, table.targetId] }),
}));

// ── changesets ───────────────────────────────────────────────────────
export const changesets = sqliteTable('changesets', {
  id: text('id').primaryKey(),
  status: text('status').notNull().default('draft'), // draft | approved | applying | completed | failed | rolled_back | cancelled
  changesJson: text('changes_json').notNull().default('[]'),
  planJson: text('plan_json').notNull().default('{}'),
  rollbackJson: text('rollback_json'),
  createdBy: text('created_by'),
  createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  approvedBy: text('approved_by'),
  approvedAt: text('approved_at'),
  appliedAt: text('applied_at'),
  completedAt: text('completed_at'),
  error: text('error'),
  /** Schema version when this changeset was created — used to detect stale drafts after migrations */
  schemaVersion: integer('schema_version'),
  /** Impact level calculated at creation time: none | low | medium | high (#83) */
  impactLevel: text('impact_level').notNull().default('none'),
  /** JSON array of AffectedResource objects (#83) */
  affectedResourcesJson: text('affected_resources_json').notNull().default('[]'),
  /** Whether this changeset requires an agent/instance restart (#83) */
  requiresRestart: integer('requires_restart').notNull().default(0),
});

// ── changeset_operations ─────────────────────────────────────────────
export const changesetOperations = sqliteTable('changeset_operations', {
  changesetId: text('changeset_id').notNull(),
  operationId: text('operation_id').notNull(),
  instanceId: text('instance_id').notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.changesetId, table.operationId] }),
}));

// ── api_usage_log ────────────────────────────────────────────────────
export const apiUsageLog = sqliteTable('api_usage_log', {
  id: text('id').primaryKey(),
  apiKeyId: text('api_key_id'),
  providerId: text('provider_id'),
  agentId: text('agent_id'),
  modelId: text('model_id'),
  instanceId: text('instance_id'),
  inputTokens: integer('input_tokens').default(0),
  outputTokens: integer('output_tokens').default(0),
  totalTokens: integer('total_tokens').default(0),
  costUsd: real('cost_usd').default(0),
  sessionKey: text('session_key'),
  createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
});

// ── pending_mutations ────────────────────────────────────────────────
export const pendingMutations = sqliteTable('pending_mutations', {
  id: text('id').primaryKey(),
  changesetId: text('changeset_id').notNull(),
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id'),
  action: text('action').notNull(), // 'create' | 'update' | 'delete'
  payloadJson: text('payload_json').notNull().default('{}'),
  instanceId: text('instance_id'),
  createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
});

// ── project_assignments (#77) ────────────────────────────────────────
export const projectAssignments = sqliteTable('project_assignments', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  assignmentType: text('assignment_type').notNull(), // 'triager' | 'approver' | 'owner'
  assigneeType: text('assignee_type').notNull(),     // 'user' | 'agent' | 'role'
  assigneeId: text('assignee_id').notNull(),
  createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
}, (table) => [
  uniqueIndex('project_assignment_unique').on(table.projectId, table.assignmentType),
]);

// ── workflow_artifacts (#113) ────────────────────────────────────────
export const workflowArtifacts = sqliteTable('workflow_artifacts', {
  id: text('id').primaryKey(),
  runId: text('run_id').notNull(),
  stepId: text('step_id').notNull(),
  filename: text('filename').notNull(),
  mimeType: text('mime_type').notNull().default('application/octet-stream'),
  size: integer('size').notNull().default(0),
  storagePath: text('storage_path').notNull(),
  createdAt: text('created_at').notNull(),
});

// ── notification_channels (#512) ────────────────────────────────────
export const notificationChannels = sqliteTable('notification_channels', {
  id: text('id').primaryKey(),
  type: text('type').notNull(), // telegram | slack | discord | email
  name: text('name').notNull(),
  enabled: integer('enabled').notNull().default(1),
  config: text('config').notNull().default('{}'), // JSON blob: channel-specific config
  createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
});
