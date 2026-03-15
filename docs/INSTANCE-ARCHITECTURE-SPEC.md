# Instance Architecture Spec

> **Status:** Draft  
> **Author:** Robin (generated 2026-03-09)  
> **Audience:** Armada contributors, OpenClaw core team

---

## 1. Problem Statement

Armada currently deploys **one Docker container per agent**. Each container is a full OpenClaw instance — Node.js runtime, gateway, plugin system, workspace — consuming ~2 GB of memory. A armada of 10 agents eats 20 GB before any work happens.

OpenClaw already supports multiple internal agents within a single instance. Armada doesn't use this. Every agent gets its own container, its own event loop, its own copy of every plugin.

This spec introduces **instances** as a first-class entity between nodes and agents, enabling multiple agents to share a single OpenClaw process.

---

## 2. Architecture Overview

### Current (v1)

```
┌─────────────────────────────────────────────────┐
│  Node (Docker host)                             │
│                                                 │
│  ┌──────────────┐  ┌──────────────┐             │
│  │ Container    │  │ Container    │   ...       │
│  │ (OpenClaw)   │  │ (OpenClaw)   │             │
│  │              │  │              │             │
│  │  Agent:      │  │  Agent:      │             │
│  │  forge       │  │  scout       │             │
│  │              │  │              │             │
│  │  ~2 GB RAM   │  │  ~2 GB RAM   │             │
│  └──────────────┘  └──────────────┘             │
└─────────────────────────────────────────────────┘

  1 container = 1 OpenClaw instance = 1 agent
  N agents = N containers = N × 2 GB
```

### Proposed (v2)

```
┌──────────────────────────────────────────────────────────┐
│  Node (Docker host)                                      │
│                                                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │  Instance: "dev-team" (single OpenClaw container)  │  │
│  │                                                    │  │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐        │  │
│  │  │ Agent:   │  │ Agent:   │  │ Agent:   │        │  │
│  │  │ forge    │  │ frontend │  │ qa       │        │  │
│  │  │ (lead)   │  │          │  │          │        │  │
│  │  └──────────┘  └──────────┘  └──────────┘        │  │
│  │                                                    │  │
│  │  Shared: event loop, plugins, node_modules         │  │
│  │  Isolated: workspaces, sessions, memory, creds     │  │
│  │                                                    │  │
│  │  ~500 MB RAM (for 3 agents)                        │  │
│  └────────────────────────────────────────────────────┘  │
│                                                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │  Instance: "pm-team" (single OpenClaw container)   │  │
│  │                                                    │  │
│  │  ┌──────────┐                                     │  │
│  │  │ Agent:   │                                     │  │
│  │  │ nexus    │                                     │  │
│  │  │ (lead)   │                                     │  │
│  │  └──────────┘                                     │  │
│  │                                                    │  │
│  │  ~2 GB RAM                                         │  │
│  └────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘

  1 instance = 1 OpenClaw container = N agents
  Shared runtime amortises overhead across agents
```

### Entity Hierarchy

```
Armada Control (API server)
  │
  ├── Node (Docker host, runs node-agent)
  │     │
  │     ├── Instance (OpenClaw container)
  │     │     ├── Agent (internal agent, lead)
  │     │     ├── Agent (internal agent)
  │     │     └── Agent (internal agent)
  │     │
  │     └── Instance (OpenClaw container)
  │           └── Agent (internal agent, lead)
  │
  └── Node (another Docker host)
        └── Instance (OpenClaw container)
              ├── Agent (internal agent, lead)
              └── Agent (internal agent)
```

### Key Terminology

| Term | Definition |
|------|-----------|
| **Node** | A Docker host running the armada node-agent. Manages containers. |
| **Instance** | A single running OpenClaw container. Has its own gateway, plugins, workspace root. Contains one or more agents. |
| **Agent** | An internal agent within an OpenClaw instance. Has its own identity, model, workspace, and sessions. Defined in the instance's `agents.list[]` config. |
| **Lead agent** | The primary agent in an instance (agent id `main`). Receives armada tasks, coordinates internal agents. Every instance has exactly one lead. |
| **Template** | Blueprint for an agent — defines SOUL.md, AGENTS.md, model, tools, skills. Does NOT define container resources. |
| **Instance template** | Blueprint for an instance — defines image, resources, plugins, env vars, capacity limits. |

---

## 3. Instance Management

### 3.1 Instance Record

Armada tracks instances in a new `instances` table:

```sql
CREATE TABLE instances (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,        -- e.g. "dev-team", "pm-1"
  node_id       TEXT NOT NULL,               -- which node hosts this
  container_id  TEXT,                        -- Docker container ID
  url           TEXT NOT NULL,               -- e.g. "http://armada-dev-team:18789"
  port          INTEGER NOT NULL,            -- exposed gateway port
  token         TEXT NOT NULL,               -- gateway auth token
  hooks_token   TEXT NOT NULL,               -- org-level hooks token
  status        TEXT NOT NULL DEFAULT 'stopped',  -- stopped|starting|running|draining|error
  config_json   TEXT NOT NULL DEFAULT '{}',  -- instance-level config overrides
  capacity_json TEXT NOT NULL DEFAULT '{}',  -- { maxAgents: 8, memoryCeiling: "8g" }
  image         TEXT NOT NULL DEFAULT 'openclaw/openclaw:latest',
  resources_json TEXT NOT NULL DEFAULT '{"memory":"4g","cpus":"2"}',
  plugins_json  TEXT NOT NULL DEFAULT '[]',  -- instance-level plugins
  env_json      TEXT NOT NULL DEFAULT '[]',  -- environment variables
  last_heartbeat TEXT,
  health_status TEXT NOT NULL DEFAULT 'unknown',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),

  FOREIGN KEY (node_id) REFERENCES nodes(id)
);
```

### 3.2 Instance Lifecycle

```
                    armada_spawn_instance()
                           │
             ┌─────────────▼──────────────┐
             │      CREATING               │
             │  - Allocate port            │
             │  - Create volume dirs       │
             │  - Write openclaw.json      │
             │  - Create container         │
             └─────────────┬──────────────┘
                           │
             ┌─────────────▼──────────────┐
             │      STARTING               │
             │  - Container booting        │
             │  - Waiting for health       │
             └─────────────┬──────────────┘
                           │
             ┌─────────────▼──────────────┐
             │      RUNNING         ◄──────┼──── armada_start_instance()
             │  - Healthy, accepting       │
             │    agent placements         │
             └──┬──────────┬──────────┬───┘
                │          │          │
    armada_drain │  armada_  │   armada_ │
    _instance() │  stop_   │   destroy│
                │  instance│   _inst  │
             ┌──▼────┐  ┌─▼────┐  ┌──▼─────┐
             │DRAIN- │  │STOP- │  │DESTROY │
             │ING    │  │PED   │  │        │
             └───────┘  └──────┘  └────────┘
```

### 3.3 Instance Provisioning

When armada-control creates an instance:

1. **Select node** — based on available resources or explicit node specification
2. **Allocate port** — find unused port on the node
3. **Generate config** — produce `openclaw.json` with:
   - Gateway settings (port, auth token)
   - Hooks settings (org-level token, mappings)
   - Plugin configuration (armada-agent, wake-after, etc.)
   - Empty `agents.list[]` (agents added later)
   - Model provider configuration
4. **Create volume** — directory structure for instance data:
   ```
   /data/armada/volumes/{instance-name}/
     .openclaw/
       openclaw.json           ← instance config
       workspace/              ← shared workspace root
       agents/                 ← per-agent data (OpenClaw manages this)
         {agent-id}/
           workspace/          ← agent-specific workspace
           memory/             ← agent memory files
   ```
5. **Create container** — via node-agent Docker API
6. **Health check** — poll until instance is responsive
7. **Insert record** — into `instances` table

### 3.4 Instance Configuration

Instance-level config covers everything about the container and shared runtime:

```typescript
interface InstanceConfig {
  // Container
  image: string;              // "openclaw/openclaw:latest"
  resources: {
    memory: string;           // "4g"
    cpus: string;             // "2"
  };
  env: string[];              // ["ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}", ...]

  // Capacity
  maxAgents: number;          // maximum agents in this instance (default: 8)
  memoryCeiling: string;      // memory alert threshold (e.g. "7g" for 8g container)

  // Shared runtime
  plugins: PluginRef[];       // plugins loaded once, available to all agents
  skillsLibrary: string[];    // shared skills directory
  network: string;            // Docker network name
}
```

### 3.5 Instance Health Monitoring

Armada control monitors instances via the existing armada-agent plugin HTTP endpoints:

| Endpoint | Purpose |
|----------|---------|
| `GET /hooks/armada/health` | Basic liveness — `{ healthy, uptime, version }` |
| `GET /hooks/armada/status` | Detailed — `{ status, activeAgents, activeSessions, memoryUsage }` |
| `GET /hooks/armada/capacity` | Placement info — `{ currentAgents, maxAgents, availableMemory }` |

The health monitor polls every 30 seconds. If an instance misses 3 consecutive checks, it's marked `unhealthy` and agents can be migrated off.

---

## 4. Agent Placement

### 4.1 Spawn Flow (New)

```
User: armada_spawn(templateId: "forge", name: "forge")
                    │
                    ▼
          ┌─────────────────┐
          │  Resolve template│
          │  (agent config)  │
          └────────┬────────┘
                   │
                   ▼
          ┌─────────────────┐     instanceId provided?
          │  Select instance │────── YES ──► Use specified instance
          │                  │
          │  (auto-place)    │────── NO ───► Auto-placement algorithm
          └────────┬────────┘
                   │
                   ▼
          ┌─────────────────┐
          │  Check capacity  │
          │  - maxAgents     │
          │  - memory usage  │
          └────────┬────────┘
                   │
                   ▼
          ┌─────────────────────────────┐
          │  Tell instance to add agent │
          │  POST /hooks/armada/agents   │
          │  Body: {                    │
          │    name, model, soul,       │
          │    agentsMd, tools, skills  │
          │  }                          │
          └────────┬────────────────────┘
                   │
                   ▼
          ┌─────────────────┐
          │  Instance adds   │
          │  agent to its    │
          │  agents.list[]   │
          │  and reloads     │
          └────────┬────────┘
                   │
                   ▼
          ┌─────────────────┐
          │  Insert agent    │
          │  record with     │
          │  instance_id     │
          └─────────────────┘
```

### 4.2 Auto-Placement Algorithm

When no `instanceId` is specified, armada-control picks one:

```
1. Get all running instances on all nodes
2. Filter: instances with status === 'running' AND currentAgents < maxAgents
3. Score each candidate:
     +10  same project agents already present (co-location)
     +5   same node as majority of project agents
     +3   lowest agent count (spread load)
     +2   most available memory headroom
     -5   instance at >80% memory ceiling
     -10  instance health_status !== 'healthy'
4. Pick highest-scoring instance
5. If no instance has capacity: create a new one (using default instance template)
```

### 4.3 Template Separation

Currently, a template defines both container-level AND agent-level config. This spec separates them:

**Agent template** (existing `templates` table, modified):
```typescript
interface AgentTemplate {
  id: string;
  name: string;
  role: string;
  model: string;
  soul: string;           // SOUL.md content
  agents: string;         // AGENTS.md content
  skills: string;         // comma-separated skill tags
  skillsList: Skill[];    // skills to install
  toolsProfile: string;
  toolsAllow: string[];
  internalAgents: InternalAgentDef[];  // sub-agents within the same instance
  // REMOVED: image, resources_json, env_json, plugins_json
  //          (these move to instance templates)
}
```

**Instance template** (new):
```typescript
interface InstanceTemplate {
  id: string;
  name: string;           // "standard", "gpu", "lightweight"
  image: string;
  resources: { memory: string; cpus: string };
  env: string[];
  plugins: PluginRef[];
  pluginsList: PluginLibRef[];
  maxAgents: number;
  memoryCeiling: string;
}
```

### 4.4 How Agent Spawn Works on the Instance

Armada control calls a **new endpoint on the armada-agent plugin** inside the instance:

```
POST /hooks/armada/agents
Authorization: Bearer <org-hooks-token>
Content-Type: application/json

{
  "action": "create",
  "agent": {
    "id": "forge",
    "name": "Forge",
    "model": "anthropic/claude-sonnet-4-5",
    "soul": "# SOUL.md content...",
    "agentsMd": "# AGENTS.md content...",
    "toolsProfile": "coding",
    "toolsAllow": [],
    "skills": ["github", "supabase"]
  }
}
```

The armada-agent plugin on the instance:

1. Writes `SOUL.md` and `AGENTS.md` to the agent's workspace directory
2. Updates `openclaw.json` → `agents.list[]` to add the new agent entry
3. Calls the gateway reload endpoint (or SIGUSR1) to pick up the new agent
4. Installs agent-specific skills
5. Returns `{ ok: true, agentId: "forge" }`

### 4.5 Agent Identity Within an Instance

Each agent in an instance has:

| Aspect | Scope | Example |
|--------|-------|---------|
| Agent ID | Unique within instance | `forge`, `frontend-dev`, `qa` |
| Armada name | Unique across armada | `forge` (same as today) |
| Workspace | Per-agent directory | `/home/node/.openclaw/agents/forge/workspace/` |
| Sessions | Per-agent session store | Managed by OpenClaw |
| Model | Per-agent (can differ) | `claude-sonnet-4-5` vs `claude-haiku-4-5` |
| Tools | Per-agent allow/deny | Lead gets full tools, QA gets minimal |
| Memory files | Per-agent | `SOUL.md`, `MEMORY.md`, daily notes |
| Credentials | Per-agent | API keys scoped to agent identity |

---

## 5. Agent Transfers / Migration

### 5.1 Why Transfer?

- **Resource pressure** — instance running out of memory
- **Node maintenance** — need to drain a node for updates
- **Rebalancing** — agents moved to co-locate with collaborators
- **Scaling** — moving agents to a larger instance

### 5.2 Transfer Process

```
Source Instance                Armada Control               Target Instance
     │                             │                             │
     │   ◄── initiate transfer ──  │                             │
     │                             │                             │
     │   ── export agent state ──► │                             │
     │      (workspace tarball,    │                             │
     │       config, memory)       │                             │
     │                             │  ── create agent ──────────►│
     │                             │     (state + config)        │
     │                             │                             │
     │                             │  ◄── agent ready ───────────│
     │                             │                             │
     │                             │  ── verify health ─────────►│
     │                             │  ◄── healthy ───────────────│
     │                             │                             │
     │   ◄── remove agent ──────── │                             │
     │                             │                             │
     │   ── agent removed ──────►  │                             │
     │                             │  ── update routing ────────►│
     │                             │                             │
```

### 5.3 State Transfer

What needs to move:

| State | Transfer method | Notes |
|-------|----------------|-------|
| Workspace files | Tar + copy via node-agent file API | SOUL.md, AGENTS.md, memory/, scripts/, etc. |
| Agent config | Regenerated from template | Ensures consistency |
| Memory files | Included in workspace tar | Daily notes, MEMORY.md |
| Active sessions | **Not transferred** — sessions drain first | Agent must be idle before transfer |
| Credentials | Re-injected by armada-control | Via credential-sync to target instance |
| Skills | Re-installed on target | Using armada skill install flow |

### 5.4 Transfer API

```
POST /api/agents/:name/transfer
Content-Type: application/json

{
  "targetInstanceId": "inst-abc123",  // or null for auto-placement
  "reason": "resource-pressure"       // audit trail
}
```

Response: `{ transferId, status: "in-progress" }`

Transfer is async — armada-control tracks progress and emits activity events at each step.

---

## 6. Resource Sharing Within Instances

### 6.1 What's Shared

```
┌─────────────────────────────────────────────────┐
│  OpenClaw Instance                              │
│                                                 │
│  ┌──────────────── Shared ───────────────────┐  │
│  │  Node.js event loop (single process)      │  │
│  │  Gateway HTTP server (one port)           │  │
│  │  Plugin system (loaded once)              │  │
│  │  node_modules/                            │  │
│  │  Extensions directory                     │  │
│  │  Model provider connections               │  │
│  │  Hooks token (one per instance)           │  │
│  └───────────────────────────────────────────┘  │
│                                                 │
│  ┌──── Agent: forge ────┐  ┌── Agent: qa ────┐  │
│  │  Workspace files     │  │  Workspace      │  │
│  │  Session store       │  │  Session store  │  │
│  │  Memory files        │  │  Memory files   │  │
│  │  SOUL.md / identity  │  │  SOUL.md        │  │
│  │  Tool permissions    │  │  Tool perms     │  │
│  │  Scoped credentials  │  │  Scoped creds   │  │
│  └──────────────────────┘  └─────────────────┘  │
└─────────────────────────────────────────────────┘
```

### 6.2 Memory Savings Estimate

| Scenario | Current (v1) | Proposed (v2) | Savings |
|----------|-------------|---------------|---------|
| 3 agents, 1 team | 3 × 2 GB = 6 GB | 1 × ~0.5 GB = 0.5 GB | **92%** |
| 6 agents, 2 teams | 6 × 2 GB = 12 GB | 2 × ~0.5 GB = 1.0 GB | **92%** |
| 10 agents, 3 teams | 10 × 2 GB = 20 GB | 3 × ~0.6 GB = 1.8 GB | **91%** |

The shared runtime (Node.js, gateway, plugins) is ~200 MB. Each additional agent within the instance adds ~50–100 MB (session state, workspace indexing). These figures are based on OpenClaw's config schema analysis — each agent adds session state and workspace indexing overhead, much lighter than a full container since the Node.js runtime and plugin compilation are shared.

### 6.3 Plugin Loading

Plugins are loaded once per instance. The armada-agent plugin must be instance-aware:

- It holds the contact list for **all agents** in the instance
- When a task arrives for a specific agent, it routes to that agent's session
- The `armada_task()` tool is available to all agents but uses the calling agent's identity

### 6.4 Credential Scoping

Credentials are injected per-agent, not per-instance. However, since `env.vars` is instance-global (see §11, Q4/Q10), credential scoping **must use file-based helpers** rather than environment variables:

```
POST /hooks/armada/credentials
{
  "agentId": "forge",
  "credentials": {
    "GITHUB_TOKEN": "ghp_xxx...",
    "NPM_TOKEN": "npm_xxx..."
  }
}
```

The armada-agent plugin stores these in the agent's isolated workspace as file-based credentials:

```
/data/armada/volumes/{instance-name}/.openclaw/agents/{agent-id}/workspace/
  .git-credentials          ← per-agent git credentials
  .credential-helper.json   ← credential helper config
```

The existing armada credential helper reads from workspace-level files, making this transparent to the agent. Each agent's credential-helper config points to its own workspace path, ensuring isolation without needing per-agent environment variables.

---

## 7. Communication

### 7.1 Communication Topology

```
┌───────────────────────┐        HTTP         ┌───────────────────────┐
│  Instance: pm-team    │◄───────────────────►│  Instance: dev-team   │
│                       │  (armada routing)     │                       │
│  ┌─────────────────┐  │                      │  ┌────────┐ ┌──────┐ │
│  │  nexus (lead)   │  │                      │  │ forge  │ │ qa   │ │
│  └─────────────────┘  │                      │  │ (lead) │ │      │ │
│                       │                      │  └────────┘ └──────┘ │
└───────────────────────┘                      │                      │
                                               │  ┌──────────┐       │
                                               │  │ frontend │       │
                                               │  └──────────┘       │
                                               └──────────────────────┘
                                                        ▲
                                                        │ OpenClaw native
                                                        │ (no HTTP)
                                          forge ◄──► frontend (same instance)
```

### 7.2 Inter-Agent Communication Matrix

| From → To | Same Instance | Cross-Instance |
|-----------|---------------|----------------|
| Agent → Agent | OpenClaw native (subagent, sessions) | HTTP via Armada plugin |
| Agent → Armada Control | HTTP (armada-agent plugin → API) | HTTP (same) |
| Armada Control → Agent | HTTP (via instance's hooks endpoint) | HTTP (same) |

### 7.3 Task Routing (Updated)

Currently, armada-control routes tasks to containers by agent name. With instances, routing adds one level:

```
armada_task("forge", "implement feature X")

1. Armada-control looks up agent "forge" → instance "dev-team" at http://armada-dev-team:18789
2. POST http://armada-dev-team:18789/hooks/armada/task
   Body: { from: "nexus", targetAgent: "forge", message: "...", callbackUrl: "..." }
3. Instance's armada-agent plugin receives the task
4. Plugin routes to agent "forge" within the instance (callGateway with agent specifier)
5. Forge processes the task, result flows back via callback
```

The key change: the task payload now includes `targetAgent` to identify which agent within the instance should handle it. The armada-agent plugin on the instance does the internal routing.

### 7.4 Updated Armada Agent Plugin API

```typescript
// === New/Modified HTTP Routes ===

// Receive task — now includes targetAgent
POST /hooks/armada/task
  Body: {
    from: string,
    targetAgent: string,      // NEW: which agent in this instance
    taskId: string,
    message: string,
    callbackUrl: string
  }

// Agent CRUD — armada-control manages agents remotely
POST /hooks/armada/agents
  Body: {
    action: "create" | "update" | "remove" | "list",
    agent?: { id, name, model, soul, agentsMd, ... }
  }

// Export agent state (for transfers)
POST /hooks/armada/agents/export
  Body: { agentId: string }
  Response: { workspace: <base64 tarball>, config: {...} }

// Import agent state (for transfers)
POST /hooks/armada/agents/import
  Body: { agent: {...}, workspace: <base64 tarball> }

// Instance capacity
GET /hooks/armada/capacity
  Response: {
    currentAgents: number,
    maxAgents: number,
    agents: [{ id, name, status, memoryEstimate }],
    totalMemory: string,
    usedMemory: string
  }

// Per-agent credential injection
POST /hooks/armada/credentials
  Body: { agentId: string, credentials: Record<string, string> }
```

---

## 8. What Changes in Armada

### 8.1 Database Schema Changes

#### New table: `instances`

See §3.1 above for full schema.

#### New table: `instance_templates`

```sql
CREATE TABLE instance_templates (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL UNIQUE,
  description     TEXT,
  image           TEXT NOT NULL DEFAULT 'openclaw/openclaw:latest',
  resources_json  TEXT NOT NULL DEFAULT '{"memory":"4g","cpus":"2"}',
  plugins_json    TEXT NOT NULL DEFAULT '[]',
  plugins_list_json TEXT NOT NULL DEFAULT '[]',
  env_json        TEXT NOT NULL DEFAULT '[]',
  max_agents      INTEGER NOT NULL DEFAULT 8,
  memory_ceiling  TEXT NOT NULL DEFAULT '7g',
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
```

#### Modified table: `agents`

```sql
-- ADD column
ALTER TABLE agents ADD COLUMN instance_id TEXT REFERENCES instances(id);

-- These columns become optional / deprecated:
--   container_id  → NULL (instance owns the container)
--   port          → NULL (instance owns the port)
--   node_id       → derived from instance.node_id (kept for convenience / backward compat)
```

#### Modified table: `templates`

```sql
-- REMOVE these columns (move to instance_templates):
--   image
--   resources_json
--   env_json
--   plugins_json (instance-level plugins)
--
-- KEEP these columns:
--   soul, agents_md, role, model, skills, tools_*, internal_agents_json, contacts_json
--
-- ADD:
ALTER TABLE templates ADD COLUMN instance_template_id TEXT REFERENCES instance_templates(id);
```

### 8.2 API Changes

#### New endpoints: Instance CRUD

```
GET    /api/instances                    List all instances
POST   /api/instances                    Create instance (from instance template)
GET    /api/instances/:id                Get instance details
PUT    /api/instances/:id                Update instance config
DELETE /api/instances/:id                Destroy instance (must have 0 agents)

POST   /api/instances/:id/start         Start stopped instance
POST   /api/instances/:id/stop          Stop instance (drains agents first)
POST   /api/instances/:id/drain         Enter drain mode
GET    /api/instances/:id/logs           Get instance container logs
GET    /api/instances/:id/capacity       Get capacity info
GET    /api/instances/:id/agents         List agents in instance
```

#### New endpoints: Instance Templates

```
GET    /api/instance-templates           List instance templates
POST   /api/instance-templates           Create instance template
GET    /api/instance-templates/:id       Get instance template
PUT    /api/instance-templates/:id       Update instance template
DELETE /api/instance-templates/:id       Delete instance template
```

#### New endpoint: Agent Transfer

```
POST   /api/agents/:name/transfer       Initiate agent transfer
GET    /api/transfers/:id                Get transfer status
```

#### Modified endpoints: Agent Spawn

```
POST   /api/agents/spawn
  Body: {
    templateId: string,
    name: string,
    instanceId?: string,       // NEW: target instance (or auto-place)
    nodeId?: string            // Kept for backward compat; ignored if instanceId given
  }
```

#### Modified endpoints: Agent operations

```
GET    /api/agents/:name                 Now includes instanceId, instanceName
DELETE /api/agents/:name                 Removes from instance (not container)
```

### 8.3 File-by-File Change List

#### `packages/api/` (Armada Control API)

| File | Change |
|------|--------|
| `src/db/schema.ts` | Add `instances`, `instance_templates` tables. Add `instance_id` to `agents`. Migration for existing agents. |
| `src/db/repositories.ts` | Add `instancesRepo`, `instanceTemplatesRepo`. Modify `agentsRepo` for instance_id. |
| `src/routes/instances.ts` | **NEW** — Instance CRUD, lifecycle, capacity endpoints. |
| `src/routes/instance-templates.ts` | **NEW** — Instance template CRUD. |
| `src/routes/agents.ts` | Modify spawn to accept `instanceId`. Add transfer endpoint. |
| `src/routes/templates.ts` | Remove container-level fields from agent templates. |
| `src/templates/spawn.ts` | **Major rewrite** — spawn agent within instance instead of creating container. |
| `src/templates/config-generator.ts` | Split into `instance-config-generator.ts` (container config) and `agent-config-generator.ts` (agents.list entry). |
| `src/templates/sync-contacts.ts` | Update to resolve contacts across instances, not containers. |
| `src/node-client.ts` | Keep container management (for instances). Add instance-aware helper methods. |
| `src/node-manager.ts` | Add instance selection and capacity querying. |
| `src/services/health-monitor.ts` | Monitor instances (not individual agent containers). |
| `src/services/maintenance.ts` | Drain instances, not containers. Rolling restart across instances. |
| `src/services/credential-sync.ts` | Target instance + agent ID, not container. |
| `src/services/task-dispatcher.ts` | Route via instance URL + targetAgent field. |
| `src/services/workflow-dispatcher.ts` | Same routing changes as task-dispatcher. |
| `src/services/stuck-detector.ts` | Query agents within instances. |
| `src/services/nudge-resolver.ts` | Route nudge to correct instance + agent. |
| `src/utils/ports.ts` | Allocate ports per instance, not per agent. |

#### `packages/node-agent/` (Node Agent)

| File | Change |
|------|--------|
| `src/routes/containers.ts` | No structural changes — still manages Docker containers. Instances ARE containers. |
| `src/routes/files.ts` | May need per-agent file access within instance volumes. |
| `src/docker/client.ts` | No changes — Docker API stays the same. |

#### `plugins/armada-agent/` (Armada Agent Plugin)

| File | Change |
|------|--------|
| `src/index.ts` | **Major changes**: route tasks to specific agents, agent CRUD endpoints, capacity reporting, export/import. |
| `src/task-handler.ts` | Accept `targetAgent`, route to correct agent session. |
| `src/agent-manager.ts` | **NEW** — Manages agent lifecycle within the instance (create, update, remove, export, import). |
| `src/capacity.ts` | **NEW** — Reports instance capacity (agent count, memory usage). |
| `openclaw.plugin.json` | Add new HTTP route registrations for agent CRUD and capacity. |

#### `plugins/armada-control/` (Armada Control Plugin — Robin's interface)

| File | Change |
|------|--------|
| Tool definitions | Add instance management tools: `armada_spawn_instance`, `armada_instances`, `armada_instance_capacity`. Modify `armada_spawn` to accept `instanceId`. Add `armada_transfer`. |

#### `plugins/shared/` (Shared types)

| File | Change |
|------|--------|
| `src/types.ts` | Add `Instance`, `InstanceTemplate`, `Transfer` types. Modify `Agent` type to include `instanceId`. |

#### `packages/ui/` (Armada Dashboard)

| File | Change |
|------|--------|
| Instance views | **NEW** — Instance list, detail, capacity visualization. |
| Agent views | Show which instance each agent belongs to. Add transfer controls. |
| Node views | Show instances per node instead of agents per node. |
| Topology view | Three-level hierarchy: Node → Instance → Agent. |

### 8.4 Operator Tool Changes (Robin's Interface)

New tools exposed via armada-control plugin:

```
armada_spawn_instance(templateId, name, nodeId?)
  → Create a new instance from an instance template

armada_instances()
  → List all instances with status and capacity

armada_instance_capacity(name)
  → Get detailed capacity info for an instance

armada_spawn(templateId, name, instanceId?)
  → Spawn agent into a specific instance (or auto-place)

armada_transfer(agentName, targetInstanceId?)
  → Move agent to another instance

armada_instance_stop(name)
armada_instance_start(name)
armada_instance_destroy(name)
armada_instance_logs(name, tail?)
```

---

## 9. Migration Path

### Phase 1: Add Instance Layer (Backwards Compatible)

**Goal:** Introduce instances without breaking anything. Every existing agent becomes a 1:1 agent-in-instance.

**Changes:**
1. Add `instances` table to schema
2. Add `instance_id` column to `agents` (nullable)
3. Migration script: for each existing agent, create an instance record pointing to its container
4. Agent spawn creates instance first, then agent within it (but still 1:1)
5. All existing APIs continue to work — `instanceId` is optional everywhere

**Result:** Architecturally identical to v1, but with instance records tracking what used to be implicit.

```
Before Phase 1:                    After Phase 1:
agents: [                          instances: [
  { name: "forge",                   { name: "forge-inst",
    container_id: "abc" }              container_id: "abc" }
]                                  ]
                                   agents: [
                                     { name: "forge",
                                       instance_id: "forge-inst" }
                                   ]
```

**Estimated effort:** 2-3 days  
**Risk:** Low — purely additive

### Phase 2: Multi-Agent Instances

**Goal:** Support multiple agents in a single instance.

**Changes:**
1. Armada-agent plugin gains agent CRUD endpoints (`/hooks/armada/agents`)
2. `armada_spawn` can target an existing instance
3. Auto-placement algorithm implemented
4. Task routing adds `targetAgent` field
5. Instance capacity tracking operational
6. Instance templates introduced

**Result:** Can run 3-4 agents per instance. Memory savings realised.

**Estimated effort:** 1-2 weeks  
**Risk:** Medium — new code paths for agent management within instances

### Phase 3: Transfers & Advanced Placement

**Goal:** Full lifecycle management — move agents between instances, auto-rebalance.

**Changes:**
1. Agent state export/import in armada-agent plugin
2. Transfer API and orchestration in armada-control
3. Advanced auto-placement with project co-location scoring
4. UI for transfer management and capacity visualisation
5. Auto-scaling: create new instances when all existing ones are full

**Result:** Armada can dynamically manage agent placement across nodes and instances.

**Estimated effort:** 1-2 weeks  
**Risk:** Medium — state transfer is the hardest part (workspace files, ensuring consistency)

### Phase 4: Cleanup & Optimisation

**Goal:** Remove legacy 1:1 assumptions, optimise resource usage.

**Changes:**
1. Remove `container_id`, `port` from `agents` table (fully derived from instance)
2. Remove container-level config from agent templates
3. Instance-level plugin deduplication
4. Memory usage benchmarking and ceiling tuning
5. Dashboard shows instance-centric views

---

## 10. OpenClaw Native Features to Leverage

### 10.1 Internal Agents (`agents.list[]`)

OpenClaw's `openclaw.json` already supports multiple agents:

```json
{
  "agents": {
    "list": [
      { "id": "main", "name": "Forge" },
      { "id": "frontend-dev", "name": "Frontend Dev", "model": { "primary": "Claude Haiku 4.5" } },
      { "id": "qa", "name": "QA", "tools": { "profile": "minimal" } }
    ]
  }
}
```

Armada-control generates this config. Each agent in the list gets:
- Independent sessions
- Independent tool access
- Independent model selection
- Shared plugins and extensions

### 10.2 Session Management

OpenClaw manages sessions per agent. The gateway routes requests to the correct agent based on the agent ID in the request path or hooks mapping.

For armada tasks, the armada-agent plugin uses `callGateway('agent', { agentId: 'forge' })` to inject a task into a specific agent's session.

### 10.3 Native Inter-Agent Communication

Agents within the same instance can communicate via OpenClaw's native subagent system (`sessions_spawn`). This is zero-overhead — no HTTP, no serialisation, no network. Armada should prefer co-locating collaborating agents to take advantage of this.

### 10.4 Workspace Isolation

OpenClaw isolates agent workspaces under `~/.openclaw/agents/{agentId}/workspace/`. Each agent has its own:
- `SOUL.md`, `AGENTS.md`, `TOOLS.md`
- `memory/` directory
- Working files

The shared instance workspace (`~/.openclaw/workspace/`) can hold shared resources (project context, shared scripts).

### 10.5 Gateway Reload

When armada-control adds or removes an agent from `agents.list[]`, the instance needs to reload. OpenClaw does **not** support hot-reloading agent config — there is no HTTP CRUD API for agents, only config-file modification (see §11, Q1/Q2).

The reload mechanism is **SIGUSR1**:
- Graceful restart — drains active turns across all agents (~30s max)
- Then reloads `openclaw.json` and picks up new agent configuration
- All agents in the instance are briefly affected during the drain period

Armada spawn flow: armada-agent plugin writes updated `openclaw.json` → sends SIGUSR1 → waits for instance to become healthy → confirms agent is available. For instances with many active agents, armada should send a drain notification before the SIGUSR1 to minimise disruption (see §11.1, point 5).

---

## 11. Answers (Resolved from OpenClaw Config Schema)

These questions were originally open; all have been resolved by examining the OpenClaw configuration schema and runtime behaviour.

| # | Question | Answer |
|---|----------|--------|
| 1 | **Internal Agent API** — Is there an HTTP CRUD API for managing agents, or must we edit config + restart? | **Config-file based only.** `agents.list[]` in `openclaw.json` defines agents. No HTTP CRUD API exists. Armada must: read current config → merge new agent entry → write config → send SIGUSR1. |
| 2 | **Hot-add agents** — Can `agents.list[]` be modified without full restart? | **No.** Requires config change + SIGUSR1 restart. SIGUSR1 is graceful — drains active turns (~30s max). Armada spawn flow: update `openclaw.json` → SIGUSR1 → wait for healthy → confirm. Acceptable for spawn operations. |
| 3 | **Memory overhead per internal agent** | **~50–100 MB per agent** (session state + workspace indexing). Much lighter than a full container (~2 GB). Shared Node.js runtime and shared plugin compilation keep the base overhead at ~200 MB for the instance. |
| 4 | **Per-agent environment variables** | **No.** `env.vars` is instance-global — cannot scope per agent. **Mitigation:** Use file-based secrets providers (file/exec) that resolve per-agent. Keep sensitive tokens in workspace-level files read by the credential helper. The existing armada credential helper already supports this pattern. |
| 5 | **Per-agent tool allow-lists** | **Yes.** Each agent entry supports a full `tools` object with `allow`/`deny`/`profile`. Tool filtering is respected per-agent at runtime. |
| 6 | **Per-agent models** | **Yes.** Each agent has an optional `model` field (string or `{primary, fallbacks}` object). Inherits from `agents.defaults` if not set. |
| 7 | **Workspace isolation** | **Yes.** Each agent has a `workspace` field for its own directory. OpenClaw manages per-agent workspace isolation natively. |
| 8 | **Per-agent skills** | **Yes.** Each agent entry supports a `skills` array for agent-specific skill configuration. |
| 9 | **Per-agent identity** | **Yes.** Each agent has an `identity` object with `name`, `theme`, `emoji`, and `avatar`. |
| 10 | **Credential scoping** | Env vars are global (`env.vars`), so **credential scoping must use file-based helpers**. Each agent's workspace gets its own `.git-credentials` or credential-helper config. The armada credential helper already supports per-workspace credential injection. |
| 11 | **Plugin isolation** | **No — plugins are instance-global.** All agents share the same loaded plugins. This is acceptable for armada: the armada-agent plugin is the same for all agents. Role-based tool filtering is handled by the plugin at runtime, not at the plugin loading level. |

### 11.1 Design Implications

These answers shape the implementation in several important ways:

1. **Armada spawn ≠ Docker create.** Spawning an agent within an instance means: read `openclaw.json` → inject agent entry into `agents.list[]` → write config → send SIGUSR1. The armada-agent plugin's `/hooks/armada/agents` endpoint orchestrates this on the instance side.

2. **Credential scoping must use file-based helpers, not env vars.** Since `env.vars` is instance-global, per-agent credentials must be written to workspace-level files (e.g. `.git-credentials`, credential-helper config) rather than injected as environment variables. The existing armada credential helper already supports this — it writes per-agent credential files into workspace paths.

3. **Instance capacity planning: ~50–100 MB per agent, ~200 MB shared runtime overhead.** A 4 GB instance can comfortably host 6–8 agents. The memory savings estimates in §6.2 can be refined: 3 agents ≈ 350–500 MB agent overhead + 200 MB shared ≈ 550–700 MB total (vs 6 GB for 3 containers).

4. **Plugin armada-agent needs to multiplex.** Since plugins are instance-global, the armada-agent plugin must route incoming tasks to the correct internal agent session. The `targetAgent` field in task payloads (§7.3) maps to `callGateway('agent', { agentId })` internally.

5. **SIGUSR1 restart affects ALL agents in the instance briefly.** When adding or removing an agent, the graceful restart drains all active turns across all agents in that instance (~30s max). Armada should consider an instance-level drain notification before agent add/remove operations, especially for instances with many active agents.

---

## 12. Security Considerations

### 12.1 Agent Isolation Within Instances

Agents in the same instance share a process. This means:
- A malicious tool call in one agent could theoretically access another agent's memory space
- File system isolation depends on OpenClaw's workspace enforcement, not OS-level isolation

**Mitigation:** Only co-locate agents from the same trust domain (same org, same project). Don't mix untrusted agents with sensitive ones.

### 12.2 Credential Isolation

Per-agent credentials must be scoped correctly. Since `env.vars` is instance-global (§11, Q4), credential isolation uses file-based helpers:
- Each agent's workspace gets its own `.git-credentials` and credential-helper config
- The armada-agent plugin manages credential injection into per-agent workspace paths
- Sensitive tokens are never placed in instance-global environment variables

### 12.3 Network Isolation

Instances on the same Docker network can reach each other. The org-level hooks token + contact ACL provide the authorization layer, same as v1.

Cross-instance agent communication goes through HTTP — the armada-agent plugin validates both the token AND the sender's identity against the contact list.

---

## 13. Observability

### 13.1 Logging

Instance-level logs capture all agent activity. Armada-control can filter by agent ID in log lines.

```
armada_logs(target: "dev-team")              → all logs from the instance
armada_logs(target: "dev-team", agent: "forge") → filtered to forge's lines
```

### 13.2 Metrics

New metrics to track:

| Metric | Source | Granularity |
|--------|--------|-------------|
| `instance.agent_count` | armada-agent capacity endpoint | Per-instance |
| `instance.memory_used` | node-agent container stats | Per-instance |
| `instance.memory_per_agent` | Computed (total / count) | Per-agent estimate |
| `agent.session_count` | armada-agent status endpoint | Per-agent |
| `agent.task_latency` | armada-control task tracking | Per-agent |
| `transfer.duration` | armada-control transfer tracking | Per-transfer |
| `placement.auto_count` | armada-control placement logs | Global |

### 13.3 Activity Events

New event types for the activity log:

```
instance.created    — New instance provisioned
instance.started    — Instance container started
instance.stopped    — Instance container stopped
instance.destroyed  — Instance removed
instance.unhealthy  — Health check failures
agent.placed        — Agent placed into instance
agent.removed       — Agent removed from instance
agent.transferred   — Agent moved between instances
transfer.started    — Transfer initiated
transfer.completed  — Transfer successful
transfer.failed     — Transfer failed (rollback)
```

---

## 14. Example Scenarios

### Scenario A: Initial Armada Setup

```
1. Create instance template "standard" (4 GB, 2 CPUs, max 6 agents)
2. Create instance "pm-inst" on node-1 from "standard"
3. Spawn agent "nexus" (PM template) into "pm-inst"
4. Create instance "dev-inst" on node-1 from "standard"
5. Spawn agent "forge" (dev template) into "dev-inst"
6. Spawn agent "qa" (QA template) into "dev-inst"  ← shares with forge!
7. Create instance "research-inst" on node-1 from "standard"
8. Spawn agent "scout" (research template) into "research-inst"

Result: 4 agents in 3 instances (was: 4 agents in 4 containers)
Memory: ~1.2 GB (was: ~8 GB) — ~85% savings
```

### Scenario B: Scaling a Dev Team

```
Current: "dev-inst" has forge + qa (2 agents, ~400 MB)

1. Spawn agent "frontend-dev" into "dev-inst" → now 3 agents, ~500 MB
2. Spawn agent "backend-dev" into "dev-inst" → now 4 agents, ~600 MB
3. Spawn agent "devops" into "dev-inst" → now 5 agents, ~700 MB

All 5 agents share plugins, event loop. Co-located for fast internal communication.
Without instances: 5 × 2 GB = 10 GB. With: ~700 MB. **93% savings.**
```

### Scenario C: Node Maintenance

```
Node-1 needs OS updates. It hosts "dev-inst" with 3 agents.

1. armada_transfer("forge", targetNode: "node-2")
   → Armada creates temp instance on node-2
   → Exports forge's workspace
   → Imports on node-2 instance
   → Verifies health
   → Removes from node-1 instance
2. Repeat for qa, frontend-dev
3. Stop "dev-inst" on node-1
4. Update node-1
5. Recreate "dev-inst" on node-1
6. Transfer agents back (or leave them)
```

---

## Appendix A: Glossary

| Term | Definition |
|------|-----------|
| **Armada Control** | Central API server managing the entire armada |
| **Node Agent** | Process running on each Docker host, managing containers |
| **Instance** | A Docker container running OpenClaw with one or more agents |
| **Lead Agent** | The primary agent (id: `main`) in an instance — receives armada tasks |
| **Internal Agent** | A non-lead agent within an instance |
| **Instance Template** | Blueprint for instance containers (image, resources, plugins) |
| **Agent Template** | Blueprint for agent config (soul, model, tools) — existing concept |
| **Auto-placement** | Armada selecting the best instance for a new agent |
| **Transfer** | Moving an agent from one instance to another |
| **Drain** | Stopping new work intake, waiting for current work to finish |

## Appendix B: Config Examples

### Instance `openclaw.json` (with 3 agents)

```json
{
  "agents": {
    "defaults": {
      "model": { "primary": "Claude Sonnet 4.5" },
      "contextPruning": { "mode": "cache-ttl", "ttl": "1h" },
      "heartbeat": { "every": "30m" }
    },
    "list": [
      {
        "id": "main",
        "name": "Forge",
        "model": { "primary": "Claude Sonnet 4.5" },
        "tools": { "profile": "coding" }
      },
      {
        "id": "frontend-dev",
        "name": "Frontend Dev",
        "model": { "primary": "Claude Haiku 4.5" },
        "tools": { "profile": "coding" }
      },
      {
        "id": "qa",
        "name": "QA",
        "model": { "primary": "Claude Haiku 4.5" },
        "tools": { "profile": "minimal" }
      }
    ]
  },
  "hooks": {
    "enabled": true,
    "token": "org-hooks-token-abc123",
    "mappings": [
      { "match": { "path": "/agent" }, "action": "agent" }
    ]
  },
  "plugins": {
    "allow": ["armada-agent", "openclaw-wake-after"],
    "entries": {
      "armada-agent": {
        "enabled": true,
        "config": {
          "org": "default",
          "instanceName": "dev-team",
          "role": "development",
          "agents": ["forge", "frontend-dev", "qa"],
          "hooksToken": "org-hooks-token-abc123",
          "contacts": [
            { "name": "nexus", "url": "http://armada-pm-inst:18789", "role": "project-manager" }
          ]
        }
      }
    }
  }
}
```
