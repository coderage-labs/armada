# Operations Engine Spec

## Overview

Every disruptive action in Armada goes through a single operations engine. Whether it's pushing config, upgrading an image, removing a node, or installing a plugin — the same pipeline handles it. One engine, consistent behaviour, full observability.

## Core Concepts

### Operation

A tracked unit of work with a lifecycle:

```
pending → running → [step1 → step2 → ... → stepN] → completed | failed | cancelled
```

Every operation has:
- **Type** — what kind of work (config_push, upgrade, node_removal, etc.)
- **Target** — what it affects (instance ID, node ID, "all")
- **Steps** — ordered list of things to do
- **Events** — timestamped log of what happened
- **Status** — current state
- **Creator** — who/what initiated it
- **Priority** — normal, high, critical

### Step

An atomic unit within an operation:

```typescript
interface OperationStep {
  id: string;
  name: string;              // "drain_agents", "push_config", "health_check"
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  startedAt?: string;
  completedAt?: string;
  error?: string;
  metadata?: Record<string, any>;  // step-specific data
}
```

### Event

Everything that happens gets logged:

```typescript
interface OperationEvent {
  id: string;
  operationId: string;
  step?: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  timestamp: string;
  data?: Record<string, any>;
}
```

## Pipeline

Every operation follows the same pattern, with type-specific steps plugged in:

```
┌─────────────┐
│  Pre-flight  │  Validate targets exist, check permissions, assess impact
└──────┬──────┘
       │
┌──────▼──────┐
│    Drain     │  Stop dispatching new work to affected targets
└──────┬──────┘
       │
┌──────▼──────┐
│   Execute    │  Type-specific steps (config write, container ops, etc.)
└──────┬──────┘
       │
┌──────▼──────┐
│   Verify     │  Health checks, state validation
└──────┬──────┘
       │
┌──────▼──────┐
│  Complete    │  Update state, resume dispatch, notify
└─────────────┘
```

At any point, failure → rollback (if possible) → mark failed → alert.

## Operation Types

### 1. Config Push

**Trigger**: API key, model, plugin, or template change in armada DB.

**Scope**: Affected instances (global changes → all, template change → instances using that template).

**Steps**:
1. `detect_changes` — Compare armada DB state with instance's applied config version
2. `generate_config` — Build openclaw.json sections from DB (models.providers, plugins, agent defaults)
3. `drain` — Wait for active turns to complete (or timeout)
4. `push_config` — Write config to instance via node agent
5. `restart` — SIGUSR1 to gateway (drains 30s, then restarts)
6. `health_check` — Verify container healthy within 60s
7. `update_version` — Set `applied_config_version` on instance

**Rollback**: Restore config backup, restart again.

**Coalescing**: Multiple rapid changes debounce (30s window) into a single operation.

### 2. Rolling Upgrade

**Trigger**: New OpenClaw version approved, or manual "upgrade all".

**Scope**: All instances (or selected subset).

**Steps** (per instance, sequential):
1. `pull_image` — Pull new image on target node
2. `drain` — Wait for idle
3. `stop_container` — Stop current container
4. `create_container` — Create new container with updated image
5. `start_container` — Start it
6. `health_check` — Wait for healthy
7. `verify_version` — Confirm new version running

**Rollback**: Stop new container, restart old one.

**Concurrency**: One instance at a time (configurable: 1, 2, or percentage).

### 3. Plugin Update

**Trigger**: Plugin version change, staged rollout.

**Scope**: Selected instances.

**Steps**:
1. `resolve_plugins` — Determine what to install/update
2. `install_plugins` — Install via node agent (npm install in container)
3. `restart` — SIGUSR1
4. `health_check` — Verify container + plugin loaded
5. `verify_plugins` — Check plugin versions match expected

**Rollback**: Reinstall previous plugin version, restart.

### 4. Node Removal

**Trigger**: User deletes a node.

**Scope**: Single node + all its instances and agents.

**Steps**:
1. `pre_check` — List affected instances and agents
2. `confirm` — Require user confirmation (UI dialog with impact summary)
3. `drain_node` — Mark node as `draining`, stop task dispatch
4. `stop_agents` — SIGUSR1 to each agent container, wait for drain
5. `destroy_instances` — Remove containers via node agent
6. `disconnect_node` — Close WS connection
7. `remove_node` — Delete from DB
8. `cleanup_refs` — Update orphaned instance/agent records

**Edge case — offline node**: Skip steps 4-6, go straight to DB cleanup. Warn user containers may still be running on host.

**No rollback** — destructive by design. Confirmation gate is the safety net.

### 5. Instance Destroy

**Trigger**: User deletes an instance.

**Scope**: Single instance + its agents.

**Steps**:
1. `pre_check` — List running agents
2. `stop_agents` — Drain active turns, force after timeout
3. `remove_container` — Via node agent
4. `cleanup_db` — Remove instance, update agent records
5. `workspace_cleanup` — If workspace retention enabled, mark for retention service

### 6. Instance Provisioning (existing)

Already implemented as an operation (#283). Steps: pull_image → create_container → start_container → health_check.

## Schema

```sql
-- Already exists, may need extensions
CREATE TABLE operations (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,           -- 'config_push' | 'upgrade' | 'plugin_update' | 'node_removal' | 'instance_destroy' | 'provision'
  status TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
  target_type TEXT NOT NULL,    -- 'instance' | 'node' | 'global'
  target_id TEXT,               -- specific ID or null for global
  priority TEXT NOT NULL DEFAULT 'normal',
  steps_json TEXT NOT NULL DEFAULT '[]',
  created_by TEXT,              -- user ID or 'system'
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  completed_at TEXT,
  error TEXT
);

CREATE TABLE operation_events (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL,
  step TEXT,
  level TEXT NOT NULL DEFAULT 'info',
  message TEXT NOT NULL,
  data_json TEXT,
  timestamp TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Per-instance config tracking
ALTER TABLE instances ADD COLUMN applied_config_version INTEGER DEFAULT 0;
ALTER TABLE instances ADD COLUMN pending_restart INTEGER DEFAULT 0;
ALTER TABLE instances ADD COLUMN drain_mode INTEGER DEFAULT 0;

-- Global config version
-- (in settings table: armada_config_version INTEGER)
```

## SSE Integration

All operation events stream via the existing SSE endpoint:

```typescript
// Event types
eventBus.emit('operation:created', { operationId, type, target });
eventBus.emit('operation:step', { operationId, step, status, message });
eventBus.emit('operation:completed', { operationId, result });
eventBus.emit('operation:failed', { operationId, error });
```

UI subscribes and shows real-time progress bars, step indicators, logs.

## Concurrency & Queuing

- Operations targeting the same instance are serialised (queue)
- Operations targeting different instances can run in parallel
- Global operations (e.g. "upgrade all") internally spawn per-instance sub-operations
- Node removal blocks all other operations on that node's instances
- Priority ordering: critical > high > normal

## UI

### Operations Page (existing)
- List of active/recent operations with status badges
- Click to expand: step-by-step progress, event log, timing
- Cancel button for running operations

### Instance Indicators
- Yellow dot: "Restart pending (3 config changes)"
- Tooltip: list of pending changes
- "Apply Now" button: skip debounce, push immediately

### Node Indicators
- "Draining" badge when drain_mode active
- Blocked task dispatch shown in task assignment UI

### Settings Banner
- "X instances need restart" after global config changes
- "Apply All" button for bulk push

## Implementation Phases

### Phase 1: Operation Tracking
- Extend existing operations table
- All operation types create tracked operations
- SSE events for progress
- UI shows progress

### Phase 2: Config Push
- Config version tracking on instances
- Config generation from armada DB
- Debounced auto-push on change
- SIGUSR1-based restart

### Phase 3: Drain & Idle Detection
- Instance idle detection (via OpenClaw status or health endpoint)
- Drain mode (stop dispatch, wait for idle)
- Configurable timeout before force

### Phase 4: Cascading Removal
- Node removal with full cascade
- Instance destroy with agent cleanup
- Confirmation dialogs with impact summary

## Changesets — Declarative State Management

Inspired by CloudFormation/Terraform. Instead of imperative "do this now", armada uses declarative "here's what I want" with computed changesets.

### Concept

```
Desired State → Diff → Changeset → Review → Apply → Verify
```

The user (or system) declares what the armada should look like. The engine figures out what's different, generates a plan, and executes it as one coordinated unit.

### Desired State Declaration

```typescript
interface armadaDesiredState {
  // Global config
  providers?: { id: string; apiKeys: { name: string; key: string }[] }[];
  models?: { name: string; modelId: string; providerId: string }[];
  
  // Per-instance
  instances?: {
    id: string;
    image?: string;           // target image version
    plugins?: PluginEntry[];  // desired plugin set
    config?: Partial<OpenClawConfig>;  // config overrides
    env?: Record<string, string>;
  }[];
  
  // Per-template (cascades to instances using it)
  templates?: {
    id: string;
    model?: string;
    plugins?: PluginEntry[];
  }[];
}
```

### Diff Engine

Compares desired state against current state per instance:

```typescript
interface StateChange {
  instanceId: string;
  type: 'config' | 'image' | 'plugin' | 'env' | 'model';
  field: string;
  current: any;
  desired: any;
  requiresRestart: boolean;
}
```

Groups changes by instance, determines what actually needs to happen:

| Change | Requires Restart | Can Hot-Reload |
|--------|-----------------|----------------|
| API key | Yes | No |
| Model | Yes | No |
| Plugin install | Yes | No |
| Image version | Yes (container recreation) | No |
| Env var | Yes | No |
| AGENTS.md / soul | No | Yes (next session) |
| Workspace files | No | Yes (immediate) |

### Changeset

The plan to get from current → desired:

```typescript
interface Changeset {
  id: string;
  status: 'draft' | 'approved' | 'applying' | 'completed' | 'failed' | 'rolled_back';
  changes: StateChange[];
  
  // Computed execution plan
  plan: {
    // Grouped by instance — one restart per instance
    instanceOps: {
      instanceId: string;
      changes: StateChange[];     // all changes for this instance
      steps: OperationStep[];     // merged steps (one drain, one restart)
      estimatedDowntime: number;  // seconds
    }[];
    
    // Execution order (respects dependencies)
    order: 'sequential' | 'parallel' | 'rolling';
    concurrency: number;          // how many instances at once
    
    // Summary
    totalInstances: number;
    totalChanges: number;
    totalRestarts: number;        // always ≤ totalInstances
    estimatedDuration: number;
  };
  
  createdAt: string;
  createdBy: string;
  approvedAt?: string;
  approvedBy?: string;
}
```

### Key Optimisation: Change Batching

Multiple changes to the same instance collapse into a single restart:

```
Before (naive):
  Instance A: push API key → restart → push plugin → restart → push model → restart
  = 3 restarts

After (changeset):
  Instance A: push API key + plugin + model → restart once
  = 1 restart
```

### Workflow

1. **Changes accumulate** — user adds API key, updates plugin, changes model
2. **Changeset auto-generated** — engine diffs current vs desired (debounce window: 30s–5min configurable)
3. **Review** — UI shows changeset:
   ```
   Changeset #42 — 3 changes across 2 instances
   
   Instance: foundry
     ✦ API key "Work" added to Anthropic
     ✦ Plugin openclaw-wake-after → v0.2.0
     → 1 restart required (~30s downtime)
   
   Instance: watchtower  
     ✦ API key "Work" added to Anthropic
     → 1 restart required (~30s downtime)
   
   Total: 2 restarts, est. 60s (rolling)
   ```
4. **Approve** — owner clicks "Apply Changeset" (or auto-approve for low-risk changes)
5. **Execute** — operations engine runs the plan, rolling through instances
6. **Verify** — health checks on each instance after changes applied
7. **Complete or rollback** — all green → done; any failure → rollback affected instances

### Auto-Apply Rules

Not everything needs manual approval:

| Change | Default | Configurable |
|--------|---------|-------------|
| Workspace file update | Auto-apply | Yes |
| AGENTS.md change | Auto-apply | Yes |
| API key rotation | Auto-apply | Yes |
| Plugin update (patch) | Auto-apply | Yes |
| Plugin update (minor/major) | Require approval | Yes |
| Image upgrade | Require approval | Yes |
| Model change | Require approval | Yes |
| Node removal | Always require approval | No |
| New environment variable | Require approval | Yes |

### Rollback

Every changeset captures the "before" state:

```typescript
interface ChangesetRollback {
  changesetId: string;
  snapshots: {
    instanceId: string;
    previousConfig: OpenClawConfig;
    previousImage: string;
    previousPlugins: PluginEntry[];
    previousEnv: Record<string, string>;
  }[];
}
```

Rollback = generate a new changeset from the snapshots, apply it.

### Schema

```sql
CREATE TABLE changesets (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'draft',
  changes_json TEXT NOT NULL,     -- StateChange[]
  plan_json TEXT NOT NULL,        -- execution plan
  rollback_json TEXT,             -- before-state snapshots
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  approved_by TEXT,
  approved_at TEXT,
  applied_at TEXT,
  completed_at TEXT,
  error TEXT
);

-- Links changesets to operations (1 changeset → N operations)
CREATE TABLE changeset_operations (
  changeset_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  PRIMARY KEY (changeset_id, operation_id)
);
```

### API

```
POST   /api/changesets/preview    — compute changeset from desired state (dry run)
POST   /api/changesets            — create changeset
GET    /api/changesets             — list changesets
GET    /api/changesets/:id         — get changeset detail + plan
POST   /api/changesets/:id/approve — approve for execution
POST   /api/changesets/:id/apply   — execute the changeset
POST   /api/changesets/:id/cancel  — cancel a draft/running changeset
POST   /api/changesets/:id/rollback — rollback a completed changeset
```

### UI

**Pending Changes Banner** (top of page when changes are staged):
```
┌──────────────────────────────────────────────────────┐
│ ⚡ 3 pending changes · 2 instances affected           │
│ [Review Changeset]                    [Apply Now]     │
└──────────────────────────────────────────────────────┘
```

**Changeset Detail Page**:
- Visual diff per instance (before/after)
- Step-by-step execution plan with time estimates
- Approve / Apply / Cancel buttons
- Live progress during execution
- Rollback button after completion

## Locking & Concurrency Control

### Instance Locks

While an operation targets an instance, that instance is **locked**:
- API mutations return `409 Conflict` with `{ error: "Operation in progress", operationId: "..." }`
- UI shows instance greyed out with spinner + "Operation in progress" badge
- Read operations (GET) still work — you can watch but not touch

Locked actions: config changes, container lifecycle, agent spawn/stop, plugin changes, delete.

### Global Lock

Global operations (upgrade all, bulk config push) lock the entire armada:
- All instance mutations blocked
- Sidebar banner: "Armada operation in progress"
- Settings/provider/model changes are **staged, not blocked** — they queue for the next changeset

### Change Queuing

Changes made during a lock aren't rejected — they're staged:
1. User adds API key while upgrade is running
2. Change saved to armada DB immediately
3. Flagged as "pending sync" — not yet pushed to instances
4. After current operation completes, new changeset auto-generated
5. Auto-apply rules determine if it needs approval or goes straight through

This means the UI never tells you "no" — it tells you "queued, will apply after current operation."

### Lock Table

```sql
CREATE TABLE operation_locks (
  target_type TEXT NOT NULL,    -- 'instance' | 'node' | 'global'
  target_id TEXT NOT NULL,      -- instance/node ID, or 'armada' for global
  operation_id TEXT NOT NULL,
  acquired_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (target_type, target_id)
);
```

Locks are acquired when operation starts, released on completion/failure/cancellation. Stale lock detection: if operation is stuck (no events for 10 min), lock can be force-released by owner.

## Real-Time Operation View

### Live Timeline

During changeset execution, UI shows:

```
Changeset #42 — Applying...
━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 60%

Instance: foundry                          [2/3 steps]
  ✅ Push config (API key + model)          0.3s
  ✅ Restart gateway (SIGUSR1)              4.2s  
  🔄 Health check...                        12s elapsed

Instance: watchtower                       [queued]
  ⏳ Waiting for foundry to complete...
```

### Event Stream

Expandable log per instance showing raw events:

```
[11:32:01] foundry: Starting config push
[11:32:01] foundry: Writing openclaw.json (3 changes)
[11:32:02] foundry: Sending SIGUSR1
[11:32:02] foundry: Gateway draining active turns...
[11:32:06] foundry: Gateway restarted
[11:32:06] foundry: Health check: waiting for healthy...
[11:32:18] foundry: ✓ Healthy — config version 42 applied
[11:32:18] watchtower: Starting config push...
```

### Notifications

- **Telegram**: Summary when changeset completes or fails
- **Webhook**: Full event payload for external integrations
- **In-app**: Toast notification + badge on Operations nav item

## Open Questions

1. Should agents be able to modify their own config? If so, we need merge logic, not overwrite.
2. Per-agent config overrides within an instance?
3. Should config changes require owner approval, or auto-apply?
4. Should node removal offer "migrate instances to another node" before destroying?
5. Should we support "maintenance windows" — scheduled times when operations can run?
6. Operation retry: automatic retry on transient failures, or always manual?
