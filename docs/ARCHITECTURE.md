# Armada Architecture

## Core Concept: Teams, Not Agents

Armada manages **OpenClaw instances**, each of which represents a **team** — not an individual agent.

### The Model

```
Chris (Owner)
  └→ Robin (CTO — controls armada, not part of it)
       └→ Armada Control (provisioning, monitoring, management)
            └→ Nexus (PM instance)
                 ├→ Forge (Dev Team instance)
                 └→ Scout (Research Team instance)
```

Robin sits **above** the armada. Robin is the operator — managing armada-control, deploying teams, running updates. Robin communicates into the armada via hooks tokens (same as any other instance).

Each armada **instance** is a Docker container running OpenClaw. It contains:

- A **lead agent** — the team's representative on the communication network
- Zero or more **internal agents** — managed by OpenClaw's native multi-agent system
- A **workspace** — the team's files, skills, and state
- **Plugins** — armada communication, wake timers, etc.

### Organisational Hierarchy

Communication follows a strict chain of command:

```
Robin → Nexus       ✅  (CTO → PM)
Nexus → Forge       ✅  (PM → Dev Team)
Nexus → Scout       ✅  (PM → Research Team)
Forge → Nexus       ✅  (results flow back up)
Forge → Robin       ❌  (not in contact list)
Forge → Scout       ❌  (not in contact list)
Scout → Forge       ❌  (not in contact list)
```

Each instance only knows about its **allowed contacts**. Forge's config doesn't contain Robin's address — the route doesn't exist. It's need-to-know by design.

Robin can talk to anyone in the armada (operator override), but in normal operation only talks to Nexus.

### Visibility

```
Forge sees:
└── Nexus (my PM — gives me work, I report results)

Nexus sees:
├── Robin (CTO — gives direction)
├── Forge (dev team — I delegate to them)
└── Scout (research team — I delegate to them)

Robin sees:
├── Nexus (PM — I work through them)
└── Armada Control (management interface)
```

### What Armada Manages vs What OpenClaw Manages

| Concern | Armada | OpenClaw |
|---------|-------|----------|
| Instance lifecycle | ✅ Create, start, stop, delete | |
| Container resources | ✅ Memory, CPU, networks | |
| Plugins across armada | ✅ Install, update, deploy | |
| Config generation | ✅ Templates → openclaw.json | |
| Updates & maintenance | ✅ Rolling restarts, version control | |
| Team composition | ✅ Templates define lead + agents | |
| Contact lists / ACL | ✅ Who can talk to whom | |
| Internal agent runtime | | ✅ Native multi-agent |
| Subagent spawning | | ✅ sessions_spawn |
| Session management | | ✅ Gateway |
| Tool access | | ✅ Tool system |

## Communication: Direct Instance-to-Instance via Hooks

### Design

Inter-team communication uses **OpenClaw's existing plugin HTTP route system**. No custom protocol, no A2A, no message bus. The Armada plugin registers HTTP endpoints on the gateway, and instances call each other directly using hooks tokens.

### How It Works

```
Nexus → armada_task("forge", "implement feature X")
  → Armada plugin looks up Forge in contact list
  → POST http://forge:18789/hooks/armada/task
    Headers: Authorization: Bearer <org-hooks-token>
    Body: { from: "nexus", task: "implement feature X", callbackUrl: "http://nexus:18789/hooks/armada/result" }
  → Forge's Armada plugin receives task
  → Forge's lead agent processes it
  → Forge calls back: POST http://nexus:18789/hooks/armada/result
    Body: { taskId: "...", result: "..." }
  → Nexus receives result, injects into coordinator session
```

### Three Layers of Security

1. **Network** — Docker network controls who can even reach who (TCP level)
2. **Auth** — Org-level hooks token proves you belong to the organisation
3. **ACL** — Armada plugin checks contact list, rejects tasks from unknown senders (even with valid token)

### Org-Level Tokens

All instances in the same organisation share one hooks token:

```
Fixli Org: hooks_token = "abc123"
  ├── Nexus: uses "abc123" for auth
  ├── Forge: uses "abc123" for auth
  └── Scout: uses "abc123" for auth
```

The token proves org membership. The Armada plugin enforces who can talk to whom within the org via the contact list.

### What We Keep from Mesh

The mesh plugin's core communication patterns were hard-won and work well. We keep:

- **Async task/result flow** — send task, get callback when done
- **Coordinator sessions** — multi-turn sessions that wait for sub-task results
- **System event injection** — `callGateway('agent')` to inject results into the lead's session
- **Heartbeat keepalives** — workers send periodic heartbeats to confirm they're alive
- **Task timeouts** — configurable timeouts with error callbacks
- **The Armada plugin exposes tools** — `armada_task(target, message)`, `armada_contacts()`

### What We Drop

- **mDNS discovery** — armada-control knows where everything is, contact list has addresses
- **Peer-to-peer topology** — hierarchy is explicit, not emergent
- **A2A agent cards** — replaced by Armada plugin's HTTP endpoints
- **Health monitor with peer probing** — replaced by armada-control polling `/armada/health`

### Armada-Control's Role

Armada-control does **not** route messages. Instances talk directly to each other. Armada-control's role is:

- **Provisioning** — spawn instances with correct tokens, contact lists, configs
- **Monitoring** — poll `/armada/health` on each instance, detect failures
- **Management** — templates, plugins, updates, maintenance orchestration
- **Registry** — knows the topology, provides it to instances at spawn time

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

### Contacts (ACL)
Templates define who this team can communicate with:

```yaml
contacts:
  - name: nexus
    url: http://nexus:18789
    role: project-manager
```

Armada resolves these at spawn time — filling in URLs and injecting the org hooks token.

### Infrastructure
- **Image** — which OpenClaw version to run
- **Resources** — memory, CPU limits
- **Plugins** — armada-agent, wake-after, etc.
- **Environment** — API keys, tokens
- **Org** — which organisation this team belongs to (determines hooks token)

## Maintenance & Updates

### The Approach

1. **Signal** — armada-control sends system event: "Finish current work, maintenance in 60s"
2. **Drain** — armada-control calls `POST /armada/drain` on the instance
3. **Poll** — armada-control polls `GET /armada/status` every 5s until idle (max 60s)
4. **Restart** — SIGUSR1 for graceful restart (OpenClaw drains active turns, max 30s)
5. **Verify** — armada-control polls `/armada/health` until instance is back

### Rolling Updates

1. Update leaf nodes first (Forge, Scout) — they have no dependants
2. Then coordinators (Nexus) — once downstream is stable
3. One at a time, verify health between each
4. Automatic rollback if health check fails

## Org Structure (Future)

```
Armada
├── Fixli Org (hooks_token: "abc...")
│   ├── Nexus (PM)
│   ├── Forge (Dev)
│   └── Scout (Research)
├── Client Org (hooks_token: "def...")
│   ├── PM instance
│   └── Dev instance
└── Internal Org (hooks_token: "ghi...")
    └── Ops instance
```

Orgs provide:
- Token isolation — instances in different orgs can't authenticate with each other
- Billing boundaries — usage tracking per org
- Template scoping — org-specific templates

## Armada Plugin Specification

```typescript
// armada-agent — installed on every managed instance

// === HTTP Routes (registered via registerHttpRoute) ===

// Receive task from another instance
POST /hooks/armada/task
  Auth: Bearer <org-hooks-token>
  Body: { from: string, taskId: string, message: string, callbackUrl: string }
  → Validates sender is in contact list
  → Injects task into lead agent's session via callGateway('agent')

// Receive task result (callback)
POST /hooks/armada/result
  Auth: Bearer <org-hooks-token>
  Body: { taskId: string, from: string, result: string }
  → Injects result into coordinator session

// Status endpoint for armada-control
GET /hooks/armada/status
  Auth: Bearer <org-hooks-token>
  → { status: 'idle'|'busy'|'draining', activeSessions, activeSubagents, pendingTurns }

// Health check
GET /hooks/armada/health
  Auth: Bearer <org-hooks-token>
  → { healthy: boolean, uptime, version }

// Drain mode
POST /hooks/armada/drain
  Auth: Bearer <org-hooks-token>
  → Stops accepting new tasks, waits for current work to complete

// === Tools (registered via registerTool) ===

armada_task(target: string, message: string)
  → Look up target in contacts
  → POST target's /hooks/armada/task
  → Set up callback listener
  → Return taskId

armada_contacts()
  → Return list of known contacts with name, role, status
```

### Config

```json
{
  "armada": {
    "org": "default",
    "instanceName": "forge",
    "role": "development",
    "hooksToken": "${ARMADA_HOOKS_TOKEN}",
    "contacts": [
      { "name": "nexus", "url": "http://nexus:18789", "role": "project-manager" }
    ]
  }
}
```

Injected via `plugins.entries.armada-agent` in `openclaw.json`, resolved from template at spawn time.

### Context via Workspace Files (No Prompt Injection)

The Armada plugin does **not** inject per-message context into prompts. Instead, armada-control writes contact information directly to the instance's workspace files:

```markdown
# TOOLS.md (managed by armada-control)

## Armada Contacts
- **nexus** (project-manager) — my PM, gives me work, I report results
```

OpenClaw auto-injects workspace `.md` files into every prompt. The agent naturally knows its contacts without any plugin hooks.

When the topology changes (new team added, team removed, role changed), armada-control updates the workspace file on the instance's volume. The agent picks it up on the next turn — no restart, no config reload, no plugin update needed.
