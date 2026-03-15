export * from './ws-protocol.js';

/** Armada protocol version — bump when WS commands or shared types change in breaking ways. */
export const FLEET_PROTOCOL_VERSION = 1;

/** Component versions — read from package.json at build time, fallback to these. */
export const FLEET_VERSIONS = {
  shared: '1.0.0',
} as const;

/** Simple semver comparison: returns true if version >= minimum. */
export function isVersionCompatible(version: string, minimum: string): boolean {
  const parse = (v: string) => v.split('.').map(Number);
  const ver = parse(version);
  const min = parse(minimum);
  for (let i = 0; i < Math.max(ver.length, min.length); i++) {
    if ((ver[i] || 0) > (min[i] || 0)) return true;
    if ((ver[i] || 0) < (min[i] || 0)) return false;
  }
  return true; // equal
}

// ── Operations Engine ────────────────────────────────────────────────

export interface OperationStep {
  id: string;
  name: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  startedAt?: string;
  completedAt?: string;
  error?: string;
  metadata?: Record<string, any>;
}

export interface OperationEvent {
  step?: string;
  level?: 'info' | 'warn' | 'error';
  message?: string;
  timestamp: number;
  [key: string]: any;
}

export interface Operation {
  id: string;
  type: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  targetType?: string;
  targetId?: string;
  target: any;
  steps: OperationStep[];
  priority: string;
  createdBy?: string;
  error?: string;
  startedAt: string;
  completedAt: string | null;
  events: OperationEvent[];
  result: any | null;
}

export interface ArmadaNode {
  id: string;
  hostname: string;
  /** @deprecated Nodes connect via WebSocket — no longer used */
  ip?: string;
  /** @deprecated Nodes connect via WebSocket — no longer used */
  port?: number;
  /** @deprecated Nodes connect via WebSocket — no longer used */
  url?: string;
  /** @deprecated Nodes connect via WebSocket — no longer used */
  token?: string;
  cores: number;
  memory: number;
  status: 'online' | 'offline' | 'degraded';
  lastSeen: string;
}

export interface ArmadaNodeEnriched extends ArmadaNode {
  agentCount: number;
  wsStatus: 'online' | 'offline' | 'stale';
  liveStats?: {
    cores: number;
    memory: number;
    hostname: string;
    containers: number;
  };
}

export type HealthStatus = 'healthy' | 'degraded' | 'unresponsive' | 'offline' | 'unknown';

export interface HeartbeatMeta {
  taskCount?: number;
  memoryMb?: number;
  uptimeMs?: number;
  uptime?: number;
  activeTasks?: number;
  status?: string;
  instanceName?: string;
  contacts?: number;
  pluginVersions?: Record<string, string>;
  skillVersions?: Record<string, string>;
  [key: string]: unknown;
}

export interface Agent {
  id: string;
  name: string;
  nodeId: string;
  instanceId: string;
  instanceName?: string;
  templateId: string;
  containerId: string;
  port: number;
  status: 'running' | 'stopped' | 'starting' | 'error';
  role: string;
  skills: string;
  model: string;
  uptime: number;
  createdAt: string;
  lastHeartbeat: string | null;
  healthStatus: HealthStatus;
  heartbeatMeta: HeartbeatMeta | null;
  avatarGenerating?: boolean;
  avatarVersion?: number;
  soul?: string | null;
  agentsMd?: string | null;
}

export interface TemplateAgent {
  name: string;
  model?: string;
  toolsProfile?: string;  // minimal | coding | messaging | full
  toolsAllow?: string[];
  soul?: string;  // SOUL.md content or inline personality description
}

export interface Template {
  id: string;
  name: string;
  description: string;
  image: string;
  role: string;
  skills: string;
  model: string;
  resources: { memory: string; cpus: string };
  plugins: PluginEntry[];
  pluginsList: TemplatePlugin[];
  skillsList: TemplateSkill[];
  /** @deprecated Use toolsAllow instead. Kept for DB migration compat. */
  toolsDeny?: string[];
  toolsAllow: string[];
  toolsProfile: string;
  soul: string;
  agents: string;
  env: string[];
  internalAgents: TemplateAgent[];
  models?: TemplateModel[];
  tools?: string[];
  projects?: string[];
  createdAt: string;
}

export interface PluginEntry {
  id: string;
  config?: Record<string, any>;
}

export interface InstalledPlugin {
  id: string;
  name: string;
  version: string;
  path: string;
  updatedAt: string;
}

// ── Skills ──────────────────────────────────────────────────────────

export interface Skill {
  name: string;
  description: string;
  version?: string;
  source: 'clawhub' | 'github' | 'workspace' | 'upload';
  location?: string;
  size?: number;
}

export interface TemplateSkill {
  name: string;
  source: 'clawhub' | 'github' | 'workspace';
  version?: string;
}

export interface TemplatePlugin {
  name: string;
  source: 'github' | 'npm' | 'workspace';
  version?: string;
}

export interface AgentSkill extends Skill {
  inTemplate: boolean;
}

export interface LibrarySkill {
  id: string;
  name: string;
  source: 'clawhub' | 'github' | 'workspace';
  url: string | null;
  version: string | null;
  description: string;
  installedVersion: string | null;
  createdAt: string;
}

export interface LibraryPlugin {
  id: string;
  name: string;
  npmPkg?: string | null;
  source: 'github' | 'npm' | 'workspace';
  url: string | null;
  version: string | null;
  description: string;
  system?: boolean;
  createdAt: string;
}

// ── Mesh ────────────────────────────────────────────────────────────

export type TaskType = 'code_change' | 'review' | 'research' | 'deployment' | 'test' | 'generic';

export interface TaskPayload {
  type: TaskType;
  description: string;
  metadata?: Record<string, unknown>;
}

export interface MeshTask {
  id: string;
  fromAgent: string;
  toAgent: string;
  taskText: string;
  result: string | null;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'blocked';
  createdAt: string;
  completedAt: string | null;
  lastProgressAt?: string | null;
  blockedReason?: string;
  blockedAt?: string;
  projectId?: string;
  githubIssueUrl?: string;
  githubIssueNumber?: number;
  githubPrUrl?: string;
  boardColumn?: string;
  workflowRunId?: string;
  taskType?: TaskType;
  taskPayload?: TaskPayload | null;
}

export type BoardColumn = 'backlog' | 'queued' | 'in-progress' | 'review' | 'done';

export interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  url: string;
  htmlUrl: string;
  labels: string[];
  milestone?: string;
  state: string;
  createdAt: string;
  updatedAt: string;
  repo: string; // "owner/repo"
}

export interface MeshPeer {
  instanceId: string;
  name: string;
  host: string;
  port: number;
  role?: string;
  status?: string;
  skills?: string[];
  lastSeen: string;
  online?: boolean;
}

export interface MeshEvent {
  type: 'status' | 'task:received' | 'task:completed' | 'task:failed' | 'peer:discovered' | 'peer:lost' | 'peer:reconnected' | 'task:sent';
  data: Record<string, unknown>;
  timestamp: string;
}

// ── Role Metadata ───────────────────────────────────────────────────

export interface RoleMetadata {
  role: string;
  color: string;        // hex colour e.g. '#ec4899'
  description: string;  // e.g. 'Handles visual design and image generation'
  tier: number;          // 0 = top (operator), 1 = middle (PM), 2 = leaf (dev/research/design)
  icon?: string | null;  // optional emoji or icon identifier
}

// ── Projects ────────────────────────────────────────────────────────

export interface ProjectRepository {
  url: string;              // 'owner/repo' or full GitHub URL
  defaultBranch?: string;   // 'main', 'dev', etc.
  cloneDir?: string;        // suggested workspace path for agents
}

export interface Project {
  id: string;
  name: string;
  description: string;
  contextMd: string;
  color: string;
  icon: string | null;
  archived: boolean;
  configJson: string;
  repositories: ProjectRepository[];
  maxConcurrent: number;
  createdAt: string;
}

// ── Task Comments ───────────────────────────────────────────────────

export interface TaskComment {
  id: string;
  taskId: string;
  author: string;
  content: string;
  createdAt: string;
}

// ── Webhooks ────────────────────────────────────────────────────────

export interface Webhook {
  id: string;
  url: string;
  events: string;
  secret: string | null;
  enabled: boolean;
  createdAt: string;
}

export interface WebhookDelivery {
  id: string;
  webhookId: string;
  eventType: string;
  status: 'pending' | 'success' | 'failed';
  statusCode: number | null;
  responseBody: string | null;
  payload: string | null;
  attempt: number;
  error: string | null;
  latencyMs: number | null;
  createdAt: string;
  completedAt: string | null;
}

export interface WebhookMetrics {
  total: number;
  success: number;
  failed: number;
  successRate: number;
  avgLatencyMs: number | null;
  lastDelivery: string | null;
}

// ── Utils ───────────────────────────────────────────────────────────

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const val = bytes / Math.pow(1024, i);
  return `${val.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

// ── Resource Monitoring Types ───────────────────────────────────────

export interface HostStats {
  cpu: { cores: number; usage: number; loadAvg: [number, number, number] };
  memory: { total: number; used: number; available: number };
  disk: { total: number; used: number; available: number };
}

export interface ContainerResourceStats {
  id: string;
  name: string;
  cpu: number;
  memory: { usage: number; limit: number };
  network: { rx: number; tx: number };
  uptime: number;
}

export interface ResourceSnapshot {
  timestamp: number;
  host: HostStats;
  containers: ContainerResourceStats[];
  fleet: {
    running: number;
    allocatedMemory: number;
    allocatedCpu: number;
  };
}

export interface CapacityResult {
  canSpawn: boolean;
  availableMemory: number;
  reason?: string;
}

export interface ArmadaNodeEnrichedWithResources extends ArmadaNodeEnriched {
  liveStats?: ArmadaNodeEnriched['liveStats'] & {
    cpu?: { cores: number; usage: number; loadAvg: [number, number, number] };
    memory?: { total: number; used: number; available: number };
    disk?: { total: number; used: number; available: number };
    fleet?: { running: number; allocatedMemory: number; allocatedCpu: number };
    capacity?: CapacityResult;
  };
}

// ── Activity ────────────────────────────────────────────────────────

export interface ActivityEvent {
  id: string;
  eventType: string;
  action: string;
  agentName: string | null;
  detail: string | null;
  metadata: string | null;
  createdAt: string;
}

// ── Deployments ─────────────────────────────────────────────────────

export interface Deployment {
  id: string;
  type: 'image-update' | 'plugin-update' | 'rolling-restart';
  target: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  log: string | null;
  startedAt: string;
  completedAt: string | null;
}

// ── Workflows ───────────────────────────────────────────────────────

export interface WorkflowStep {
  id: string;
  /** Human-readable step name (defaults to id) */
  name?: string;
  role: string;
  prompt: string;
  /** Steps that can run in parallel share the same parallel group ID */
  parallel?: string;
  /** Step IDs that must complete before this step starts */
  waitFor?: string[];
  /** If true, step failure doesn't block the workflow */
  optional?: boolean;
  /** Manual gate — pauses and notifies operator for approval */
  gate?: 'manual';
  /** Gate notification and approval policy */
  gatePolicy?: {
    notifyOnly?: ('human' | 'operator')[];
    approveOnly?: ('human' | 'operator')[];
  };
  /** Auto-retry on step failure */
  retryOnFailure?: boolean;
  /** Maximum retry attempts (default 3) */
  maxRetries?: number;
  /** Delay between retries in ms (default 5000) */
  retryDelayMs?: number;
  /** Keep retrying until a review step approves */
  loopUntilApproved?: boolean;
  /** Step ID to loop back to when review rejects */
  loopBackToStep?: string;
  /** Maximum loop iterations (default 5) */
  maxLoopIterations?: number;
}

export interface Workflow {
  id: string;
  projectId: string;
  name: string;
  description: string;
  steps: WorkflowStep[];
  enabled: boolean;
  createdAt: string;
}

export type WorkflowRunStatus = 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
export type StepRunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'waiting_gate';

export interface WorkflowRun {
  id: string;
  workflowId: string;
  projectId: string;
  triggerType: 'manual' | 'issue' | 'api';
  triggerRef: string | null;
  status: WorkflowRunStatus;
  currentStep: string | null;
  /** Accumulated context from completed steps — keyed by step ID */
  context: Record<string, { output: string; sharedRefs: string[] }>;
  createdAt: string;
  completedAt: string | null;
}

// ── Users ───────────────────────────────────────────────────────────

export interface ArmadaUser {
  id: string;
  name: string;
  displayName: string;
  type: 'human' | 'operator';
  role: 'owner' | 'operator' | 'viewer';
  avatarUrl: string | null;
  avatarGenerating?: boolean;
  avatarVersion?: number;
  linkedAccounts: { telegram?: string; github?: string; email?: string; callbackUrl?: string; hooksToken?: string };
  notifications: {
    channels: string[];
    telegram?: { chatId: string };
    email?: { address: string };
    webhook?: { url: string };
    preferences: { gates: boolean; completions: boolean; failures: boolean; quietHours?: { start: string; end: string } };
  };
  projects?: string[];
  createdAt: string;
}

export interface WorkflowStepRun {
  id: string;
  runId: string;
  stepId: string;
  stepIndex: number;
  role: string;
  agentName: string | null;
  taskId: string | null;
  status: StepRunStatus;
  input: Record<string, any>;
  output: string | null;
  sharedRefs: string[];
  startedAt: string | null;
  completedAt: string | null;
}

export interface ModelRegistryEntry {
  id: string;
  name: string;
  provider: string;
  modelId: string;
  description: string;
  apiKeyEnvVar: string | null;
  capabilities: string[];
  maxTokens: number | null;
  costTier: string;
  providerId: string | null;
  source: string;
  createdAt: string;
}

export interface ModelUsageSummary {
  totalTokens: number;
  requestCount: number;
  lastUsed: string | null;
}

export interface ModelUsageDetail extends ModelUsageSummary {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface ModelRegistryEntryWithUsage extends ModelRegistryEntry {
  usage: ModelUsageSummary;
}

export interface TemplateModel {
  registryId: string;
  default: boolean;
  apiKeyId?: string; // optional override — null/undefined = use provider's default key
}

export interface ArmadaInstance {
  id: string;
  name: string;
  nodeId: string;
  templateId?: string;
  url?: string;
  token?: string;
  status: 'pending' | 'provisioning' | 'running' | 'stopping' | 'stopped' | 'error' | 'pending_delete';
  statusMessage?: string;
  capacity: number;
  config: Record<string, any>;
  memory?: string;
  cpus?: string;
  version?: string;
  targetVersion?: string;
  createdAt: string;
  updatedAt: string;
  // Operations engine
  appliedConfigVersion?: number;
  drainMode?: boolean;
  // Enriched
  agentCount?: number;
  nodeName?: string;
  agents?: Agent[];
}

export interface ProviderApiKey {
  id: string;
  providerId: string;
  name: string;
  apiKey: string | null; // masked in responses
  isDefault: number;
  priority: number;
  createdAt: string;
}

export interface ModelProvider {
  id: string;
  name: string;
  type: string; // 'anthropic' | 'openai' | 'openrouter' | 'google' | 'bedrock' | 'ollama' | 'openai-compat' | 'github-copilot'
  /** @deprecated Keys are now managed via ProviderApiKey entries */
  apiKey?: string | null; // masked in responses, kept for migration compat
  baseUrl: string | null;
  hidden: number;
  enabled: number;
  /** Automatic failover: when true, fleet generates fallback model entries for lower-priority keys */
  fallbackEnabled: number;
  /** Fallback behaviour: 'immediate' = try next key on any error, 'backoff' = exponential retry before failover */
  fallbackBehavior: 'immediate' | 'backoff';
  lastSyncAt: string | null;
  modelCount: number;
  createdAt: string;
  /** Named API keys for this provider */
  keys?: ProviderApiKey[];
  /** Provider capabilities — what the model listing API supports */
  capabilities?: {
    canList: boolean;   // can list available models
    canSearch: boolean; // has native search (none do currently)
  };
}

// ── Operation Locks ──────────────────────────────────────────────────

export interface OperationLock {
  targetType: string;
  targetId: string;
  operationId: string;
  acquiredAt: string;
}

// ── Config Version Tracking (#316) ────────────────────────────────────────────

export interface StateChange {
  instanceId: string;
  type: 'config' | 'image' | 'plugin' | 'env' | 'model';
  field: string;
  current: any;
  desired: any;
  requiresRestart: boolean;
}

export interface ConfigSnapshot {
  version: number;
  providers: Array<{ id: string; type: string; keys: Array<{ name: string; isDefault: boolean }> }>;
  models: Array<{ id: string; name: string; modelId: string; providerId: string }>;
  plugins: Array<{ name: string; version?: string }>;
  templateModels: Record<string, string>;
}

export interface ConfigStatus {
  version: number;
  staleInstances: Array<{ instanceId: string; instanceName: string; appliedVersion: number; currentVersion: number }>;
}

export interface DiffNode {
  path: string;           // dot-separated path e.g. "models.0.registryId"
  label: string;          // human-friendly label for the leaf or branch
  type: 'change' | 'create' | 'remove';
  oldValue?: any;         // for change/remove
  newValue?: any;         // for change/create
  children?: DiffNode[];  // for nested objects/arrays — branch nodes
  truncated?: boolean;    // true if values were truncated
}

export interface MutationDiff {
  mutationId: string;
  entityType: string;
  entityId: string | null;
  entityName: string;
  action: 'create' | 'update' | 'delete';
  /** Tree of changes (replaces flat fields array) */
  changes: DiffNode[];
}

export interface ChangesetPlan {
  instanceOps: Array<{
    instanceId: string;
    instanceName: string;
    changes: StateChange[];
    steps: OperationStep[];
    /** Step dependency edges: [prerequisiteStepId, dependentStepId][] */
    stepDeps: [string, string][];
    estimatedDowntime: number; // seconds
  }>;
  order: 'sequential' | 'parallel' | 'rolling';
  concurrency: number;
  totalInstances: number;
  totalChanges: number;
  totalRestarts: number;
  estimatedDuration: number; // seconds
  diffs?: MutationDiff[]; // Snapshot of field-level changes (survives mutation cleanup)
  /** Config version at approval time — used to detect fleet config drift before apply */
  approvedConfigVersion?: number;
}

export interface Changeset {
  id: string;
  status: 'draft' | 'approved' | 'applying' | 'completed' | 'failed' | 'rolled_back' | 'cancelled';
  changes: StateChange[];
  plan: ChangesetPlan;
  rollback?: any;
  createdBy?: string;
  createdAt: string;
  approvedBy?: string;
  approvedAt?: string;
  appliedAt?: string;
  completedAt?: string;
  error?: string;
  /** Schema version when this changeset was created — stale if current version is higher */
  schemaVersion?: number;
}

// ── Changeset Conflict Resolution (#320) ───────────────────────────

export interface ConflictCheck {
  type: 'error' | 'warning';
  code: string;           // e.g. 'CREATE_ON_DELETED_NODE', 'MODIFY_DELETED_INSTANCE'
  message: string;
  changeIndices: number[]; // indices into the changes array that conflict
  resolution?: string;     // suggested fix
}

export interface StalenessCheck {
  stale: boolean;
  reason?: string;
  drift: StateChange[];
}
