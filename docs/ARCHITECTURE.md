# Armada Architecture (Accurate)

> **Note:** This document replaces `ARCHITECTURE.md` which contains several incorrect claims. See [Out-of-Sync Docs](#out-of-sync-docs) at the bottom for a full list of what was wrong.

---

## Core Concept: Teams, Not Agents

Armada manages **OpenClaw instances**, each of which represents a **team** — not an individual agent. Each instance is a Docker container running OpenClaw with a lead agent, zero or more internal agents, a shared workspace, and communication plugins.

### Organisational Hierarchy

Communication follows a strict chain of command:

```
Robin (operator, not a managed instance)
  └→ Nexus (PM instance — managed by armada)
       ├→ Forge (Dev Team instance — managed by armada)
       └→ Scout (Research Team instance — managed by armada)
```

Robin sits **above** the armada. Robin is the operator — managing armada-control, deploying teams, running updates. Each instance only knows about its **allowed contacts** by design.

---

## System Components

### Packages

| Component | Location | Role |
|-----------|----------|------|
| `armada-control` | `packages/control` | Central HTTP API + control plane |
| `armada-node` | `packages/node` | Node agent — runs on each Docker host |
| `armada-shared` | `packages/shared` | WS protocol types shared between control and node |
| `armada-ui` | `packages/ui` | React dashboard |

### Plugins (installed into OpenClaw instances)

| Plugin | Location | Role |
|--------|----------|------|
| `armada-agent` | `plugins/agent` | Installed on managed instances — receives tasks |
| `armada-control` | `plugins/control` | Installed on the operator instance (Robin) — sends tasks |
| `armada-plugin-shared` | `plugins/shared` | Shared task injection engine used by both plugins |

---

## Communication Architecture: Star Topology via Control Plane

> **Critical correction from old docs:** The old ARCHITECTURE.md described direct instance-to-instance communication via Docker DNS (`POST http://forge:18789/hooks/armada/task`). **This is not how it works.** All communication is mediated through the control plane.

### Actual Communication Flow

```
┌─────────────────────────────────────────────────────────┐
│                    armada-control                       │
│                  (central hub/star)                     │
│                   HTTP API :3001                        │
└────────┬──────────────┬──────────────┬─────────────────┘
         │  WS          │  WS          │  WS
    (persistent)   (persistent)   (persistent)
         │              │              │
    ┌────▼───┐      ┌───▼────┐    ┌───▼────┐
    │ node-1 │      │ node-2 │    │ node-3 │
    │ agent  │      │ agent  │    │ agent  │
    └────┬───┘      └───┬────┘    └───┬────┘
         │              │              │
    ┌────▼──────┐   ┌───▼──────┐  ┌───▼──────┐
    │ armada-   │   │ armada-  │  │ armada-  │
    │ instance- │   │ instance │  │ instance │
    │  nexus    │   │  forge   │  │  scout   │
    └───────────┘   └──────────┘  └──────────┘
```

**Instances never talk to each other directly.** All task dispatch flows through the control plane.

---

## How Tasks Flow: Step-by-Step

### 1. Agent-Initiated Task (`armada_task` tool)

When Robin uses `armada_task("nexus", "plan the sprint")`:

```
Robin's OpenClaw instance
  └─ plugins/control/src/index.ts (armada-control plugin)
       └─ armada_task tool executes:
            1. Looks up "nexus" agent via GET /api/agents (armada-control HTTP API)
            2. Creates taskId = "ft-1234-abcd"
            3. Calls dispatchArmadaTask() from armada-plugin-shared
               → POST http://armada-instance-nexus:18789/armada/task  [DIRECT? NO!]

Wait — Robin's plugin has the agent's containerName but needs to reach it.
Robin is NOT on the same Docker network.
```

Actually, the operator-side `armada-control` plugin (`plugins/control`) calls the instance **directly** using `dispatchArmadaTask()` to the agent's `proxyUrl`. The proxyUrl is the **node agent's HTTP proxy** for that instance. Let's trace carefully:

From `plugins/control/src/index.ts`:
```typescript
const url = agentToUrl(agent);  // → "http://armada-instance-{name}:18789"
await dispatchArmadaTask({ targetUrl: url, taskId, ... })
  // → POST http://armada-instance-nexus:18789/armada/task
```

This is the **direct** path from the operator instance. The operator instance runs on the same Docker network as the managed instances, so Docker DNS resolves directly.

### 2. Control Plane Task Dispatch (Project Board / Task Dispatcher)

When the control plane's task dispatcher dispatches queued project tasks:

```
armada-control (task-dispatcher.ts)
  └─ checkAndDispatch(projectName)
       └─ resolveProjectManager() → finds PM agent (e.g., "nexus")
       └─ resolveAgentRelay(agentName) → { containerName, nodeId, targetAgent }
            └─ Gets instance from instancesRepo
            └─ Gets nodeId from instance
       └─ getNodeClient(nodeId) → WsNodeClient
       └─ node.relayRequest(containerName, 'POST', '/armada/task', body)
            │
            ▼
       WsNodeClient.relayRequest()
            └─ commandDispatcher.send(nodeId, 'instance.relay', params)
                 │
                 ▼ [WebSocket to node agent]
            Node Agent (packages/node/src/handlers/relay.ts)
                 └─ handleRelayCommand()
                      └─ Resolves container hostname via Docker inspect
                      └─ fetch("http://armada-instance-nexus:18789/armada/task", ...)
                           │
                           ▼
                      armada-agent plugin (plugins/agent) running in container
                           └─ /armada/task handler
```

### The Two Paths

There are TWO task dispatch paths in the codebase:

| Path | Used By | How |
|------|---------|-----|
| **Direct HTTP** | `plugins/control` (operator plugin on Robin) | Calls instance URL directly (`http://armada-instance-{name}:18789`) via `dispatchArmadaTask()` |
| **Control plane relay** | `packages/control` task-dispatcher, agent-message-service, tasks route | Goes via WsNodeClient → WebSocket → node agent → HTTP into container |

**Why two paths?** The operator instance (Robin) is on the same Docker network and can reach managed containers directly. The control plane API server needs to relay through node agents because it may be managing instances on remote hosts (different physical nodes).

---

## Control Plane → Node Agent: WebSocket Protocol

Node agents maintain a **persistent WebSocket connection** to the control plane:

```
Node Agent                    armada-control
    │                              │
    │──── [connect] ─────────────→│  (node registers)
    │◄─── [command: container.*]──│  (control sends commands)
    │──── [response: ok/error] ──→│
    │──── [event: heartbeat] ────→│  (every 30s)
    │──── [event: node.stats] ───→│  (live stats push)
```

**Protocol (`packages/shared/src/ws-protocol.ts`):**
- `CommandMessage` — Control → Node: `{ type: 'command', id, action, params }`
- `ResponseMessage` — Node → Control: `{ type: 'response', id, status, data }`
- `EventMessage` — Node → Control: fire-and-forget (heartbeats, stats)
- `StreamMessage` — Either direction: chunked data (logs, file transfers)
- `ProgressMessage` — Node → Control: mid-operation progress (image pulls)

**Key node actions:**
- `container.*` — Docker container lifecycle
- `file.read/write` — Filesystem operations on instances
- `instance.relay` — Relay HTTP request into a named container
- `node.stats/info` — Node health data
- `plugin.install` — Install OpenClaw plugins

---

## armada-agent Plugin: Task Injection Engine

When a task arrives at `/armada/task` on the agent container:

```
POST /armada/task
  { taskId, from, fromRole, message, callbackUrl, attachments, targetAgent }
        │
        ▼
plugins/agent/src/index.ts → /armada/task handler
  1. Validates required fields
  2. Increments _activeTasks counter
  3. sendJson(res, 200, { status: 'accepted' })  ← returns immediately!
  4. createInboundContext(_api, { taskId, from, targetAgent, ... })
       │
       ▼
  plugins/shared/src/index.ts → createInboundContext()
     - Builds a session key:
       targetAgent ? `agent:{targetAgent}:armada:{from}:{short}`
                   : `armada:{from}:{short}`
     - Calls runtime.channel.session.resolveStorePath()
     - Calls runtime.channel.reply.finalizeInboundContext(ctxInput)
     - Calls runtime.channel.session.recordInboundSession()
     - Returns InboundContext with timers and callback info

  5. Stores inbound in inboundContexts Map (globalThis-keyed)
  6. Fetches project context if project specified
  7. dispatchTurn(_api, inbound, taskMessage, _logger)
       │
       ▼
  plugins/shared/src/index.ts → dispatchTurn()
     - Queues via inbound.turnQueue (serialised)
     - Calls runtime.channel.reply.dispatchReplyFromConfig({ ctx, cfg, dispatcher })
       ← This is the OpenClaw LLM pipeline
     - Captures output via createReplyDispatcherWithTyping deliver callback
     - Detects "TASK_COMPLETE" signal in output
     - Returns boolean (taskComplete)

  8. maybeFinalize() → if complete and no pending sub-tasks, fires callback
  9. finalizeInbound() → POST callbackUrl with result
```

**Key insight:** The task injection engine creates an isolated **session** keyed to `armada:{from}:{short}` (or scoped to `targetAgent` for multi-agent instances). It uses the same OpenClaw LLM pipeline as normal chat sessions — there's no special agent invocation. The "armada session" is just a synthetic context that drives the agent's existing turn machinery.

---

## Agent-to-Agent: Always Via Control Plane

When a managed agent (e.g., Nexus) wants to delegate to another agent (e.g., Forge):

```
Nexus instance running in Docker container
  └─ LLM turn calls armada_task("forge", "implement feature X")
       │
       ▼
  plugins/agent/src/index.ts → armada_task tool execute()
       └─ POST {proxyUrl}/api/tasks   [proxyUrl = node agent relay URL]
            │
            ▼ [via node agent HTTP proxy — armada-agent config.proxyUrl]
       armada-control HTTP API: POST /api/tasks
            └─ Creates task record in DB
            └─ Fires eventBus.emit('task.created', ...)
            └─ checkAndDispatch(projectId) if board column is 'queued'
                 │
                 ▼
            task-dispatcher.ts → dispatchTaskToPM()
                 └─ resolveAgentRelay("forge") → { containerName, nodeId }
                 └─ getNodeClient(nodeId).relayRequest(containerName, 'POST', '/armada/task', body)
                      │
                      ▼ [WebSocket → node agent → HTTP]
                 armada-agent running in forge container
                      └─ Processes task, eventually calls back
                      └─ POST callbackUrl (control plane /api/tasks/{id}/result)
```

**The crucial detail:** The agent's `proxyUrl` config points to the node agent's HTTP proxy (`http://armada-node:3002`). ALL outbound calls from managed instances go through this proxy. Instances have **no direct access** to the control plane.

---

## Task Result Callbacks

Results flow back to the control plane via HTTP callback:

```
armada-agent (in container) — task completes
  └─ finalizeInbound()
       └─ POST callbackUrl  (e.g., http://armada-control:3001/api/tasks/{id}/result)
            │
            ▼ [through node agent proxy for managed instances]
       armada-control: POST /api/tasks/:id/result
            └─ taskManager.completeTask(id, status, result)
                 └─ tasksRepo.update()
                 └─ emitTaskEvent('task:updated', task)
                 └─ onTaskCompleted() → checkAndDispatch() for next queued task
                 └─ checkWorkflowStep() if task is part of a workflow
                 └─ webhooks dispatched
```

For the **operator plugin** (on Robin), results arrive at `/armada/result` on Robin's OpenClaw gateway:

```
armada-agent (in managed container) — finalizeInbound()
  └─ POST {inbound.callbackUrl}
       Where callbackUrl was set by armada-control plugin to:
       "{config.callbackUrl}/armada/result"
       ↓
  armada-control plugin on Robin: /armada/result handler
       └─ Finds the pending task
       └─ Determines if it's a sub-task (parent coordinator) or top-level
       └─ injectIntoCoordinatorSession() — feeds result back to Robin's LLM
```

---

## armada_task in armada-control Plugin (Operator Side)

When Robin calls `armada_task("nexus", "plan the sprint")`:

```
plugins/control/src/index.ts → armada_task tool
  1. fetchAgents() — GET {armadaApiUrl}/api/agents (armada-control HTTP API)
  2. agentToUrl(agent) → "http://armada-instance-{instanceName}:18789"
  3. Creates coordinatorSessionKey = "armada:{target}:{taskShort}"
  4. Stores PendingTask in _pendingTasks Map
  5. dispatchArmadaTask({ targetUrl, taskId, callbackUrl: "{callbackUrl}/armada/result", ... })
     → POST http://armada-instance-nexus:18789/armada/task
  6. Returns { taskId, status: 'sent' } immediately
  7. Result arrives later at /armada/result
     → injectIntoCoordinatorSession() feeds it back to Robin
```

**Coordinator sessions** prevent blocking Robin's main session. Results arrive in an isolated session keyed to the target agent, then Robin's LLM processes the result and delivers it to the user's channel.

---

## Heartbeats and Health

```
armada-agent (in container) — every 30 seconds
  └─ sendHeartbeats()
       └─ POST {proxyUrl}/api/instances/heartbeat
            ▼
       armada-control: instance heartbeat endpoint
            └─ Updates instance status, plugin/skill versions
            └─ Stores loaded agents list

Node agent — every ~30 seconds
  └─ [event: heartbeat] over WebSocket to control plane
       └─ nodeConnectionManager.handleHeartbeat()
            └─ Reconciles instance status from actual container states
            └─ Updates lastHeartbeat timestamp
```

---

## Session Key Architecture (Task Injection)

The task injection engine creates synthetic sessions that drive the OpenClaw LLM:

| Context | Session Key Format | Use Case |
|---------|-------------------|----------|
| Inbound task (single-agent) | `armada:{from}:{taskShort}` | Task received by armada-agent |
| Inbound task (multi-agent) | `agent:{targetAgent}:armada:{from}:{taskShort}` | Routes to specific agent in instance |
| Coordinator (control plugin) | `armada:{target}:{taskShort}` | Processes result in isolated session |
| Legacy coordinator | `armada:{from}:{taskShort}` | injectAndWaitForResponse |

---

## Inbound Context Lifecycle (armada-agent)

```
/armada/task received
       │
       ▼
createInboundContext()
  ├─ pingWatchdogTimer (60s) ─→ fires if no ping: "agent presumed dead"
  ├─ progressTimer (600s) ────→ fires if no LLM output: "agent stuck"
  ├─ hardTimer (1800s) ────────→ absolute ceiling: always fires
  └─ pingTimer (10s interval) → sends heartbeat pings to callbackUrl

dispatchTurn() ──────────────→ LLM turn runs
  ├─ Any turn output resets both watchdog + progress timers
  ├─ "TASK_COMPLETE" in output triggers finalization
  └─ Sub-task calls add to pendingSubTasks set

maybeFinalize()
  └─ if TASK_COMPLETE AND pendingSubTasks.size === 0
       └─ finalizeInbound()
            └─ Clears all timers
            └─ POST callbackUrl with accumulated result
            └─ Removes from inboundContexts Map
```

---

## Topology Summary

```
┌──────────────────────────────────────────────────────────────┐
│ Operator Machine (Robin's Docker host)                       │
│  ┌──────────────────┐                                        │
│  │ Robin container  │                                        │
│  │  - armada-control│──────────────────────────────┐        │
│  │    plugin        │  HTTP (direct Docker DNS)     │        │
│  │  - armada_task   │  to managed containers        │        │
│  │    tool          │                               │        │
│  └──────────────────┘                               │        │
│          │                                          │        │
│          │ HTTP (armadaApiUrl)                      │        │
│          ▼                                          │        │
│  ┌───────────────────────────────────────────┐     │        │
│  │         armada-control (port 3001)        │     │        │
│  │                                           │     │        │
│  │  - REST API (agents, tasks, instances)    │     │        │
│  │  - WebSocket server for node agents       │     │        │
│  │  - Task dispatcher (project queue)        │     │        │
│  │  - Workflow engine                        │     │        │
│  │  - Config generator / changeset apply     │     │        │
│  └────────────────┬──────────────────────────┘     │        │
│                   │ WebSocket (persistent)          │        │
│                   ▼                                 │        │
│  ┌────────────────────────────────────────────────┐│        │
│  │  armada-node (node agent)                      ││        │
│  │  - WS command handler                          ││        │
│  │  - Docker client (container lifecycle)         ││        │
│  │  - relay handler (HTTP → container)            ││        │
│  │  - HTTP proxy (port 3002, for instance egress) ││        │
│  └───────────────────┬────────────────────────────┘│        │
│                      │ Docker network               │        │
│                      │                              │        │
│  ┌───────────────────▼──────────────────────────┐  │        │
│  │  Docker network (armada)                     │◄─┘        │
│  │                                              │           │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐   │           │
│  │  │  nexus   │  │  forge   │  │  scout   │   │           │
│  │  │container │  │container │  │container │   │           │
│  │  │:18789    │  │:18789    │  │:18789    │   │           │
│  │  │          │  │          │  │          │   │           │
│  │  │armada-   │  │armada-   │  │armada-   │   │           │
│  │  │agent     │  │agent     │  │agent     │   │           │
│  │  │plugin    │  │plugin    │  │plugin    │   │           │
│  │  └──────────┘  └──────────┘  └──────────┘   │           │
│  └──────────────────────────────────────────────┘           │
└──────────────────────────────────────────────────────────────┘
```

---

## What Armada Manages vs What OpenClaw Manages

| Concern | Armada | OpenClaw |
|---------|--------|---------|
| Instance lifecycle | ✅ Create, start, stop, delete | |
| Container resources | ✅ Memory, CPU, networks | |
| Plugins across armada | ✅ Install, update, deploy | |
| Config generation | ✅ Templates → openclaw.json | |
| Updates & maintenance | ✅ Rolling restarts, version control | |
| Team composition | ✅ Templates define lead + agents | |
| Contact lists / ACL | ✅ Who can talk to whom | |
| Task board & project queue | ✅ Kanban, dispatch, capacity | |
| Workflow engine | ✅ Multi-step, gates, retries | |
| Internal agent runtime | | ✅ Native multi-agent |
| Subagent spawning | | ✅ sessions_spawn |
| Session management | | ✅ Gateway |
| Tool access | | ✅ Tool system |
| LLM turn pipeline | | ✅ dispatchReplyFromConfig |

---

## Templates = Team Blueprints

A armada template defines a **team**, not just a lead agent.

### Lead Agent
- **Name & role** — what this team does (development, research, coordination)
- **Model** — which LLM the lead uses
- **SOUL.md** — personality and instructions
- **AGENTS.md** — workspace rules
- **Tools** — allow list, profile (minimal/coding/messaging/full)

### Internal Agents (Multi-Agent)
Templates define the full team composition:

```yaml
template: forge
  lead:
    name: Forge
    role: development
    model: claude-sonnet-4-5
    tools_profile: coding
  agents:
    - name: frontend-dev
      model: claude-sonnet-4-5
      tools_profile: coding
      soul: "Frontend specialist — React, CSS, accessibility"
    - name: backend-dev
      model: claude-sonnet-4-5
      tools_profile: coding
      soul: "Backend specialist — APIs, databases, infrastructure"
    - name: qa
      model: claude-haiku-4-5
      tools_profile: minimal
      soul: "QA engineer — testing, validation, edge cases"
```

Armada generates the `agents.list[]` section in `openclaw.json`. The lead is the default agent; internal agents are available for subagent spawning.

### Instance Plugin Config

Generated by `config-generator.ts`, the `armada-agent` plugin config in `openclaw.json` looks like:

```json
{
  "plugins": {
    "entries": {
      "armada-agent": {
        "config": {
          "org": "default",
          "instanceName": "nexus",
          "role": "project-manager",
          "hooksToken": "${ARMADA_HOOKS_TOKEN}",
          "armadaApiToken": "${ARMADA_API_TOKEN}",
          "proxyUrl": "http://armada-node:3002"
        }
      }
    }
  }
}
```

The `proxyUrl` is critical — ALL outbound HTTP from managed instances routes through the node agent proxy. Instances never contact the control plane directly.

---

## Maintenance & Updates

### The Approach

1. **Signal** — armada-control sends system event: "Finish current work, maintenance in 60s"
2. **Drain** — armada-control calls `POST /armada/drain` on the instance via node relay
3. **Poll** — armada-control polls `GET /armada/status` every 5s until idle (max 60s)
4. **Restart** — SIGUSR1 via node agent WebSocket command for graceful restart
5. **Verify** — armada-control polls `/armada/health` until instance is back

### Rolling Updates

1. Update leaf nodes first (Forge, Scout) — they have no dependants
2. Then coordinators (Nexus) — once downstream is stable
3. One at a time, verify health between each
4. Automatic rollback if health check fails

---

## HTTP Routes: armada-agent Plugin

Registered via `api.registerHttpRoute()` at startup:

| Method | Path | Description |
|--------|------|-------------|
| POST | `/armada/task` | Receive inbound task — creates InboundContext, fires first turn |
| POST | `/armada/result` | Receive task result callback (from sub-agents) |
| GET/POST | `/armada/status` | Status info (activeTasks, role, etc.) |
| GET | `/armada/health` | Health check (healthy, uptime) |
| POST | `/armada/drain` | Enter drain mode |
| POST | `/armada/steer` | Inject mid-task steering message |
| POST | `/armada/notify` | Receive workflow notifications from control plane |
| GET | `/armada/session` | List sessions via gateway RPC |
| GET | `/armada/session/messages` | Get session message history |

Authentication: `auth: 'plugin'` — uses OpenClaw's hooks token verification.

---

## HTTP Routes: armada-control Plugin (Operator Side)

Registered on Robin's OpenClaw instance:

| Method | Path | Description |
|--------|------|-------------|
| POST | `/armada/result` | Receive task results from managed instances |
| POST | `/armada/notify` | Receive workflow gate/completion events |

The plugin also registers tools: `armada_task`, `armada_status`, plus all auto-generated tools from the control plane's `/api/meta/tools` endpoint.

---

## Out-of-Sync Docs

The following documents contain inaccuracies relative to the actual implementation:

### `docs/ARCHITECTURE.md` — **Major inaccuracies**

1. **"Communication: Direct Instance-to-Instance via Hooks"** — FALSE for control plane dispatch. The control plane (`task-dispatcher.ts`, `agent-message-service.ts`, `/api/tasks/send`) routes everything through the WebSocket → node agent relay. Only the operator-side `plugins/control` plugin goes direct (Docker DNS, same network).

2. **"Armada-Control's role is NOT to route messages"** — Partially false. The control plane's `task-dispatcher.ts` actively dispatches tasks to agents, routing through node agents. It is the central message broker for the project queue.

3. **Plugin routes use `/hooks/armada/task`** — The actual routes are `/armada/task`, `/armada/result`, etc. The `/hooks/` prefix is not used.

4. **Contact list ACL in armada-agent plugin** — There is no `contacts` config or contact list enforcement in the current `plugins/agent/src/index.ts`. ACL is handled at the control plane level (which agents receive tasks).

5. **`armada_contacts()` tool** — Does not exist in the current implementation.

6. **Config format** — The ARCHITECTURE.md shows `"armada": { contacts: [...] }`. The actual config has no contacts array; it has `proxyUrl` for node agent routing.

7. **"Drop mDNS, keep peer-to-peer topology"** — Peer-to-peer is claimed to be dropped but the doc still describes it as the communication mechanism. The implementation is a star topology through the control plane.

### `docs/INSTANCE-ARCHITECTURE-SPEC.md` — Likely out of sync
- Likely describes direct instance-to-instance routing. Should be verified against the relay mechanism.

### `docs/REVERSE-TUNNEL-ARCHITECTURE.md` — Check for node agent proxy details
- May describe the HTTP proxy architecture correctly or incorrectly.

### `docs/PLUGIN-GUIDE.md` — Check route paths
- Should use `/armada/task` not `/hooks/armada/task`.

### `packages/node/README.md` and `plugins/agent/README.md`
- May describe outdated communication patterns. The node agent relay (`instance.relay` command) is the critical piece that should be documented clearly.

---

*This document was written from direct code analysis of the actual implementation (March 2026).*
