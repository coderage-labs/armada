# Service Layer Architecture

## Problem

The API layer has no proper domain separation. Route handlers contain business logic, make direct HTTP calls to the node agent, duplicate restart/health patterns, and emit events inconsistently. There are ~7,900 lines across 26 route files doing work that should live in services.

### Current State

```
Route (agents.ts, 877 lines)
  → inline business logic
  → direct fetch() to node agent
  → direct DB calls
  → ad-hoc SSE setup
  → copy-pasted health polling loops
```

Routes that directly call the node agent: `plugin-library.ts`, `instances.ts`, `files.ts`, `skills.ts`, `template-sync.ts`, `agents.ts` (via maintenance), `spawn.ts`.

Health check patterns exist in 3 forms:
1. Heartbeat-based polling (plugin rollout, upgrade)
2. Direct HTTP probe to `fleet/status` (maintenance, health monitor)
3. Instance URL probe (health monitor)

Instance restart is done in 4 places with 4 different implementations.

### Target State

```
Route (thin HTTP handler)
  → validates input
  → calls Service
  → wires SSE if streaming
  → returns response

Service (domain logic)
  → orchestrates operations
  → calls other Services
  → emits events via EventBus
  → calls NodeClient for infrastructure

NodeClient (infrastructure adapter)
  → HTTP calls to node agent
  → no business logic
```

## Domain Services

### 1. `InstanceManager`

Owns instance lifecycle. Single source of truth for start/stop/restart/upgrade/health.

```typescript
interface InstanceManager {
  // Lifecycle
  create(opts: CreateInstanceOpts): Promise<Instance>;
  destroy(instanceId: string): Promise<void>;
  restart(instanceId: string): Promise<void>;
  stop(instanceId: string): Promise<void>;
  start(instanceId: string): Promise<void>;
  reload(instanceId: string): Promise<void>;  // SIGUSR1
  upgrade(instanceId: string, targetVersion: string): Promise<void>;
  maintain(instanceId: string, opts?: MaintenanceOpts): Promise<MaintenanceResult>;

  // Health
  waitForHealthy(instanceId: string, timeoutMs?: number): Promise<boolean>;

  // Status
  getStatus(instanceId: string): InstanceStatus;
  getAll(): Instance[];
}
```

Events emitted:
- `instance:restarting`, `instance:healthy`, `instance:stopped`, `instance:started`
- `instance:upgrading`, `instance:upgraded`, `instance:upgrade-failed`
- `instance:maintenance-started`, `instance:maintenance-completed`

Every other service that needs to restart an instance calls `instanceManager.restart(id)`. No exceptions.

`waitForHealthy()` uses heartbeat-based detection — no direct HTTP probes. The health monitor updates agent health from heartbeats; `waitForHealthy()` polls the DB.

### 2. `AgentManager`

Owns agent CRUD and agent-level operations.

```typescript
interface AgentManager {
  // CRUD
  create(opts: CreateAgentOpts): Promise<Agent>;
  destroy(agentName: string): Promise<void>;
  redeploy(agentName: string): Promise<void>;
  getByName(name: string): Agent | null;
  getAll(): Agent[];
  getByInstance(instanceId: string): Agent[];

  // Runtime
  nudge(agentName: string, message?: string): Promise<NudgeResult>;
  heartbeat(agentName: string, meta: HeartbeatMeta): void;

  // Avatars
  generateAvatar(agentName: string): Promise<void>;
  deleteAvatar(agentName: string): Promise<void>;
}
```

Events: `agent:created`, `agent:updated`, `agent:deleted`, `agent:health`

Redeploy writes config via `ConfigFileLifecycle`, then calls `instanceManager.reload(instanceId)`.

### 3. `PluginManager`

Owns plugin library, installation, rollout.

```typescript
interface PluginManager {
  // Library CRUD
  list(): LibraryPlugin[];
  get(id: string): LibraryPlugin | null;
  create(opts: CreatePluginOpts): LibraryPlugin;
  update(id: string, patch: Partial<LibraryPlugin>): LibraryPlugin;
  delete(id: string): void;
  getUsage(id: string): PluginUsage;

  // Node operations
  install(name: string, opts: InstallOpts): Promise<void>;
  cleanup(keep: string[]): Promise<CleanupResult>;

  // Rollout (the big one)
  batchRollout(pluginIds: string[]): AsyncGenerator<RolloutEvent>;
}
```

`batchRollout` is an async generator that yields progress events. The route wires these to SSE:

```typescript
router.post('/batch-rollout', async (req, res) => {
  const sse = setupSSE(res);
  try {
    for await (const event of pluginManager.batchRollout(req.body.pluginIds)) {
      sse.send('progress', event);
    }
  } finally {
    sse.close();
  }
});
```

Inside `batchRollout`, when it needs to restart instances:
```typescript
async function* batchRollout(pluginIds: string[]) {
  // ... backup, install ...
  for (const instance of affectedInstances) {
    yield { step: 'restart', instance: instance.name, status: 'restarting' };
    await instanceManager.restart(instance.id);
    const healthy = await instanceManager.waitForHealthy(instance.id, 60_000);
    yield { step: 'restart', instance: instance.name, status: healthy ? 'healthy' : 'timeout' };
  }
  yield { step: 'completed' };
}
```

No direct node agent calls. No direct DB calls for instance status.

### 4. `SkillManager`

Owns skill library and per-agent skill operations.

```typescript
interface SkillManager {
  // Library
  list(): LibrarySkill[];
  get(id: string): LibrarySkill | null;
  create(opts: CreateSkillOpts): LibrarySkill;
  update(id: string, patch: Partial<LibrarySkill>): LibrarySkill;
  delete(id: string): void;

  // Agent skills (resolves instance internally)
  listForAgent(agentName: string): Promise<Skill[]>;
  install(agentName: string, skill: string): Promise<void>;
  remove(agentName: string, skill: string): Promise<void>;
  sync(agentName: string): Promise<SyncResult>;
}
```

No more `containerId` in routes. `SkillManager` resolves agent → instance → node client internally.

### 5. `WorkflowManager`

Already partially separated as `workflow-engine.ts`. Formalise the interface.

```typescript
interface WorkflowManager {
  create(opts: CreateWorkflowOpts): Workflow;
  update(id: string, patch: Partial<Workflow>): Workflow;
  delete(id: string): void;
  run(workflowId: string, opts?: RunOpts): Promise<WorkflowRun>;
  approveGate(runId: string, stepId: string): Promise<void>;
  rejectGate(runId: string, stepId: string, reason?: string): Promise<void>;
  retryStep(runId: string, stepId: string, feedback?: string): Promise<void>;
  cancelRun(runId: string): Promise<void>;
}
```

### 6. `TaskManager`

Owns task CRUD, board operations, dispatch.

```typescript
interface TaskManager {
  create(opts: CreateTaskOpts): Task;
  update(id: string, patch: Partial<Task>): Task;
  dispatch(taskId: string, agentName: string): Promise<void>;
  moveColumn(taskId: string, column: string): void;
  addComment(taskId: string, author: string, content: string): TaskComment;
  unblock(taskId: string): void;
}
```

### 7. `IntegrationManager`

Owns integration CRUD, credential sync, proxy operations.

```typescript
interface IntegrationManager {
  // CRUD
  create(opts: CreateIntegrationOpts): Integration;
  update(id: string, patch: Partial<Integration>): Integration;
  delete(id: string): void;
  test(id: string): Promise<TestResult>;

  // Credential sync
  syncCredentials(agentName: string): Promise<void>;
  syncAllCredentials(): Promise<void>;

  // Project bindings
  attach(projectId: string, integrationId: string, capability: string, config?: any): void;
  detach(projectId: string, piId: string): void;
}
```

### 8. `ProjectManager`

Owns project CRUD, membership, board, metrics, issue sync.

```typescript
interface ProjectManager {
  create(opts: CreateProjectOpts): Project;
  update(id: string, patch: Partial<Project>): Project;
  delete(id: string): void;
  archive(id: string): void;
  syncIssues(id: string): Promise<void>;
  getBoard(id: string): Board;
  getMetrics(id: string): ProjectMetrics;
}
```

### 9. `TemplateManager`

Owns template CRUD, drift detection, contact resolution.

```typescript
interface TemplateManager {
  create(opts: CreateTemplateOpts): Template;
  update(id: string, patch: Partial<Template>): Template;
  delete(id: string): void;
  checkDrift(agentName: string): DriftResult;
  syncContacts(): Promise<void>;
}
```

### 10. `SpawnManager`

Orchestrates agent creation: template resolution → config generation → plugin install → instance file writes → reload.

```typescript
interface SpawnManager {
  spawn(templateId: string, agentName: string, opts?: SpawnOpts): Promise<Agent>;
}
```

Internally calls: `TemplateManager` (get template), `PluginManager` (ensure plugins), `ConfigFileLifecycle` (write config), `InstanceManager` (reload), `AgentManager` (create record), `IntegrationManager` (sync credentials).

### 11. `NodeClient` (already exists, formalise)

Pure infrastructure adapter. No business logic. All node agent HTTP calls go through here.

```typescript
interface NodeClient {
  // Instance lifecycle
  createInstance(name: string, config: any): Promise<void>;
  destroyInstance(name: string): Promise<void>;
  startInstance(name: string): Promise<void>;
  stopInstance(name: string): Promise<void>;
  reloadInstance(name: string): Promise<void>;
  upgradeInstance(name: string, image: string): Promise<void>;

  // Plugins (shared directory on node)
  installPlugin(opts: InstallPluginOpts): Promise<void>;
  backupPlugin(name: string): Promise<void>;
  restorePlugin(name: string): Promise<void>;
  cleanupPlugins(keep: string[]): Promise<CleanupResult>;

  // Files
  readFile(instanceName: string, path: string): Promise<string>;
  writeFile(instanceName: string, path: string, content: string): Promise<void>;

  // Skills (per-agent inside instance container)
  listSkills(instanceName: string, agentName: string): Promise<Skill[]>;
  installSkill(instanceName: string, agentName: string, opts: any): Promise<void>;
  removeSkill(instanceName: string, agentName: string, name: string): Promise<void>;

  // Node health
  healthCheck(): Promise<boolean>;
  getStats(): Promise<NodeStats>;
}
```

Note: skills resolve via instance name, not container ID.

## Event Bus

Expand the existing event bus to be the backbone for cross-service communication and SSE.

```typescript
interface FleetEventBus {
  emit(event: string, data: any): void;
  on(event: string, handler: (data: any) => void): () => void;
  once(event: string, handler: (data: any) => void): () => void;
  stream(prefix: string): AsyncGenerator<{ event: string; data: any }>;
}
```

The `stream()` method enables routes to wire SSE directly to event patterns:

```typescript
// SSE route for instance events
router.get('/instances/events', (req, res) => {
  const sse = setupSSE(res);
  const unsub = eventBus.on('instance:*', (data) => sse.send(data.event, data));
  res.on('close', unsub);
});
```

Standard event namespaces:
- `instance:*` — lifecycle events
- `agent:*` — agent events
- `plugin:*` — plugin operations
- `workflow:*` — workflow run progress
- `task:*` — task status changes
- `project:*` — project updates

## Route Pattern (after refactor)

Routes become thin. Example — plugin batch rollout:

```typescript
// BEFORE: 150 lines of inline logic
// AFTER:
router.post('/batch-rollout', async (req, res) => {
  const { pluginIds } = req.body;
  if (!pluginIds?.length) return res.status(400).json({ error: 'pluginIds required' });

  const sse = setupSSE(res);
  try {
    for await (const event of pluginManager.batchRollout(pluginIds)) {
      sse.send('progress', event);
    }
  } catch (err: any) {
    sse.send('progress', { step: 'failed', error: err.message });
  } finally {
    sse.close();
  }
});
```

Example — instance restart:

```typescript
// BEFORE: inline fetch + DB update + no events
// AFTER:
router.post('/:id/restart', async (req, res, next) => {
  try {
    const instance = instanceManager.get(req.params.id);
    if (!instance) return res.status(404).json({ error: 'Not found' });
    await instanceManager.restart(instance.id);
    res.json({ ok: true });
  } catch (err) { next(err); }
});
```

## Migration Strategy

This is a big refactor. Do it incrementally:

### Phase 1: Extract `InstanceManager` + `NodeClient`
- Biggest impact — used by plugin rollout, upgrade, maintenance, redeploy
- Unifies all restart paths
- Unifies health checking on heartbeat-based approach
- Removes direct `fetch()` to node agent from routes

### Phase 2: Extract `PluginManager` + `SkillManager`
- Plugin rollout, batch rollout, install, cleanup all move to service
- Skills stop using `containerId`, resolve through instance
- Routes shrink dramatically

### Phase 3: Extract `AgentManager` + `SpawnManager`
- Agent CRUD, redeploy, heartbeat all move to service
- Spawn flow gets proper orchestration

### Phase 4: Extract `TemplateManager` + `IntegrationManager`
- Template sync, drift detection, contact resolution
- Credential sync, proxy operations

### Phase 5: Extract `ProjectManager` + `TaskManager`
- Already cleaner but still have inline logic

### Each phase:
1. Create service with interface
2. Move logic from routes into service
3. Route calls service
4. Add proper event emissions
5. Tests if applicable

## File Structure (target)

```
packages/api/src/
  services/
    instance-manager.ts      ← NEW
    agent-manager.ts         ← NEW (replaces agent-lifecycle.ts)
    plugin-manager.ts        ← NEW
    skill-manager.ts         ← NEW
    spawn-manager.ts         ← NEW (replaces templates/spawn.ts)
    template-manager.ts      ← NEW
    integration-manager.ts   ← NEW
    project-manager.ts       ← NEW
    task-manager.ts          ← NEW
    workflow-engine.ts        ← EXISTS (formalise interface)
    health-monitor.ts         ← EXISTS (simplify: only heartbeat-based)
    credential-sync.ts        ← EXISTS (move into IntegrationManager)
    maintenance.ts            ← REMOVE (merge into InstanceManager)
    placement.ts              ← EXISTS (used by SpawnManager)
    ...
  routes/
    *.ts                      ← thin handlers, <50 lines each ideally
  infrastructure/
    node-client.ts            ← MOVE + expand
    event-bus.ts              ← MOVE + expand
  db/
    repositories.ts           ← EXISTS (no change, services use these)
```

## Dependency Graph

```
Routes
  ↓
Services (PluginManager, InstanceManager, etc.)
  ↓                    ↓
Repositories        NodeClient
  ↓                    ↓
SQLite              Node Agent HTTP
```

Services can depend on other services (PluginManager → InstanceManager). No circular deps — enforce via initialization order or lazy injection.

Routes NEVER call NodeClient or Repositories directly.
Services NEVER call Routes.

## Non-Goals

- Not changing the DB schema
- Not changing the node agent API
- Not changing the UI (routes keep same HTTP contract)
- Not changing the event/SSE wire format
- Not adding DI framework (simple constructor injection)
