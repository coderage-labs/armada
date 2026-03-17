# Armada Documentation Audit Report

> **Generated:** March 2026  
> **Source of truth:** `docs/ARCHITECTURE.md` (newly updated, code-verified)  
> **Audit method:** Each doc compared against actual source files in `plugins/`, `packages/`, and `docs/ARCHITECTURE.md`

---

## Summary

| Document | Status | Severity |
|----------|--------|----------|
| `docs/ARCHITECTURE.md` | ✅ Source of truth — accurate | — |
| `docs/INSTANCE-ARCHITECTURE-SPEC.md` | ⚠️ Needs edits | Medium |
| `docs/REVERSE-TUNNEL-ARCHITECTURE.md` | ✅ Mostly accurate | Low |
| `docs/PLUGIN-GUIDE.md` | ✅ Accurate | None |
| `docs/UNIVERSAL-CHANGESET-SPEC.md` | ⚠️ Needs edits | Low |
| `docs/README.md` | 🔴 Several inaccuracies | High |
| `packages/node/README.md` | ✅ Accurate | None |
| `plugins/agent/README.md` | 🔴 Incorrect config | High |
| `plugins/control/README.md` | ⚠️ Incomplete | Medium |
| `CONTRIBUTING.md` | ✅ Accurate | None |
| `README.md` (root) | ⚠️ Minor inaccuracy | Low |

---

## 1. `docs/ARCHITECTURE.md`

**Status: ✅ Source of truth — accurate**

This document was recently rewritten based on direct code analysis. It accurately describes:
- Star topology via control plane (not peer-to-peer)
- Two dispatch paths (direct from operator plugin, relay via WsNodeClient for control plane)
- `/armada/task`, `/armada/result`, `/armada/status`, `/armada/health`, `/armada/drain`, `/armada/steer`, `/armada/notify`, `/armada/session` route paths
- Actual generated config (`instanceName`, `armadaApiToken`, `proxyUrl`) — not `org`, `role`, or `hooksToken`
- Session key format
- Inbound context lifecycle with timers

**Recommended action:** No changes needed. This is the authoritative reference.

---

## 2. `docs/INSTANCE-ARCHITECTURE-SPEC.md`

**Status: ⚠️ Needs edits — Medium severity**

This is a design spec for the future multi-agent instance architecture. It is mostly well-reasoned but contains several inaccurate route paths and a few config references that don't match the actual implementation.

### Inaccuracies Found

#### 2.1 Route paths use `/hooks/armada/` prefix — WRONG

The spec consistently uses `/hooks/armada/...` paths throughout sections 3.5, 7.3, and 7.4. The actual plugin routes (verified in `plugins/agent/src/index.ts`) are:

```
WRONG (spec):    /hooks/armada/health
WRONG (spec):    /hooks/armada/status
WRONG (spec):    /hooks/armada/capacity
WRONG (spec):    /hooks/armada/task
WRONG (spec):    /hooks/armada/agents

CORRECT (actual): /armada/health
CORRECT (actual): /armada/status
CORRECT (actual): /armada/task
CORRECT (actual): /armada/result
CORRECT (actual): /armada/drain
CORRECT (actual): /armada/steer
CORRECT (actual): /armada/notify
CORRECT (actual): /armada/session
CORRECT (actual): /armada/session/messages
```

The `/hooks/` prefix is not used by the armada-agent plugin. It is used by OpenClaw's native webhooks infrastructure. Confusing the two would lead to broken integrations.

**Specific locations to fix:**
- Section 3.5 "Instance Health Monitoring" table — all three endpoints
- Section 7.3 "Task Routing (Updated)" — `POST http://armada-dev-team:18789/hooks/armada/task`
- Section 7.4 "Updated Armada Agent Plugin API" — all route definitions
- Section 11.1 "Design Implications" — point 1 references `/hooks/armada/agents`

#### 2.2 Generated config includes `contacts` field — WRONG

Section 11, Appendix B shows a generated `openclaw.json` with `contacts` array in the armada-agent plugin config:

```json
"config": {
  "contacts": [
    { "name": "nexus", "url": "http://armada-pm-inst:18789", "role": "project-manager" }
  ]
}
```

The actual `config-generator.ts` generates only three fields:
```json
{
  "instanceName": "dev-team",
  "armadaApiToken": "<generated-token>",
  "proxyUrl": "http://armada-node:3002"
}
```

There is no `contacts`, `org`, `role`, or `hooksToken` in the generated config. The `contacts` field exists in the plugin's `configSchema` (in `openclaw.plugin.json`) as an optional field but is never populated by the control plane's config generator.

#### 2.3 `POST /api/agents/spawn` — route doesn't exist

Section 8.2 references `POST /api/agents/spawn`. The actual route in `packages/control/src/routes/agents.ts` is `POST /api/agents` (creates an agent, which triggers spawn). There is no `/spawn` sub-path.

#### 2.4 Section 8.3 references `packages/api/` — doesn't exist

The file-change table mentions `packages/api/`. The actual package is `packages/control/`. Minor naming confusion.

#### 2.5 `sync-contacts.ts` referenced — file doesn't exist

Section 8.3 mentions `src/templates/sync-contacts.ts`. The actual services directory has `credential-sync.ts`, `github-sync.ts`, `template-sync.ts`, but no `sync-contacts.ts`. Contacts synchronisation is not currently implemented as a separate service.

### What's Correct

- The overall multi-agent instance concept is sound and matches the intended direction
- The OpenClaw config schema analysis (Section 11) is accurate — `agents.list[]`, SIGUSR1, etc.
- The migration phases are reasonable design proposals
- Memory savings estimates are reasonable

**Recommended action:** Edit the spec to fix route paths (`/hooks/armada/` → `/armada/`) and update the config examples. This is a design spec so some forward-looking content is acceptable — clearly label what is implemented vs proposed.

---

## 3. `docs/REVERSE-TUNNEL-ARCHITECTURE.md`

**Status: ✅ Mostly accurate — Low severity**

This document describes the WebSocket reverse tunnel architecture. It is largely accurate. The protocol types, connection lifecycle, security model, and node agent architecture all match the implementation in `packages/node/src/ws/` and `packages/node/src/gateway/`.

### Minor Issues Found

#### 3.1 "armada-gateway" hostname is a doc/code mismatch (not wrong, just inconsistent)

The doc uses `http://armada-gateway:3002` as the local proxy address for instances. The actual `config-generator.ts` uses `http://armada-node:3002` (controlled by env var `ARMADA_AGENT_GATEWAY_URL`). The node agent's `gateway/proxy.ts` refers to `armada-gateway` in its header comment but operates on the port defined by `GATEWAY_PORT` (default 3002).

This isn't strictly wrong — the hostname depends on Docker network configuration — but the doc should reflect what the default generated config actually uses (`http://armada-node:3002`).

#### 3.2 Webhook path clarification

Section "OpenClaw Hooks Through the Tunnel" describes hook traffic. The doc says:

> `Instance → http://armada-gateway:3002/hooks → Node Agent → WSS → Control Plane`

The actual path should reference the control plane's webhook receiver at `/hooks/:hookId`, not just `/hooks`. Minor.

### What's Correct

- WebSocket protocol types (CommandMessage, ResponseMessage, EventMessage, StreamMessage, ProgressMessage) match `packages/shared/src/ws-protocol.ts`
- Command actions list matches `packages/node/src/handlers/`
- Security model (one-time tokens, machine fingerprint, session credentials) accurately described
- Connection lifecycle, heartbeats, reconnect backoff — all accurate
- `instance.relay` command exists in `packages/node/src/handlers/relay.ts`

**Recommended action:** Update the `armada-gateway` hostname to `armada-node` (with a note that this is configurable via `ARMADA_AGENT_GATEWAY_URL`). No other changes needed.

---

## 4. `docs/PLUGIN-GUIDE.md`

**Status: ✅ Accurate — No issues**

This is a practical guide written from direct plugin development experience. Everything has been verified against the actual plugin implementations:

- File structure is correct
- Manifest fields and `configSchema` warning are accurate
- `registerTool`, `registerHttpRoute`, `registerHook`, `registerService` signatures are correct
- `callGateway` usage is accurate
- Auth modes (`gateway`, `plugin`, `none`) are correct
- Gotchas (jiti cache, ESM-only, extensions must be writable, `dist/` manifest copy) are all real
- The non-blocking `registerService.start()` pattern is critical and correctly documented

**Recommended action:** No changes needed. This is high-quality, accurate reference material.

---

## 5. `docs/UNIVERSAL-CHANGESET-SPEC.md`

**Status: ⚠️ Needs edits — Low severity**

The spec describes the template sync pipeline. The core design is sound and largely implemented. Minor inaccuracies found.

### Inaccuracies Found

#### 5.1 Route paths use `:id` but actual routes are by agent `:name`

The spec says:
```
POST /api/templates/:id/sync
GET  /api/templates/:id/drift
```

The actual routes in `packages/control/src/routes/templates.ts` are:
```
GET  /api/templates/:id/drift   ← correct
POST /api/templates/:id/sync    ← correct
```

However, the template-sync route file (`packages/control/src/routes/template-sync.ts`) uses `:name` not `:id`:
```
GET  /api/templates/:name/drift
POST /api/templates/:name/sync
```

There are two template-related sync files. Verify which is canonical and update the spec accordingly.

#### 5.2 `contacts` listed as DB-only — misleading given contacts don't exist in generated config

The spec's field classification table includes `contacts` under "DB-only fields":

> `contacts` — Managed automatically by Armada plugin — NOT part of template sync

This is confusing because `contacts` is in the plugin's `configSchema` but is NOT generated by the config generator at all. The note should clarify that `contacts` is a deprecated/unused config field in the current implementation.

### What's Correct

- Step types (`flush_mutations`, `install_plugins`, `push_files`, `push_config`, `restart_gateway`, `health_check`) are accurate
- The "templates are source of truth" design is correctly described
- Phase breakdown (Phase 1: template sync, Phase 2: universal pipeline, Phase 3: auto-drift) is a valid description of the current and planned state

**Recommended action:** Minor edit to clarify route parameter (`:id` vs `:name`), and update the contacts note.

---

## 6. `docs/README.md` (developer docs)

**Status: 🔴 Several inaccuracies — High severity**

This is the primary developer documentation entry point. It contains multiple inaccuracies in the API reference section and framework description.

### Inaccuracies Found

#### 6.1 Control plane uses Express, not Fastify

The Quick Start section and Architecture section describe the control plane correctly, but the `packages/control/README.md` (which is referenced) says "Fastify". The actual framework is **Express** (`express@^4.21.2`), confirmed in `app.ts`. The developer docs themselves don't say "Fastify" directly, but since they link to package READMEs that do, this is noted.

#### 6.2 API Overview — wrong parameter names (:id vs :name)

The API Overview table says:
```
GET/PATCH/DELETE   /api/agents/:id    Agent CRUD
```

The actual routes in `packages/control/src/routes/agents.ts` use **`:name`** not `:id`:
```
GET     /api/agents/:name/logs
POST    /api/agents/:name/redeploy
DELETE  /api/agents/:name
POST    /api/agents/:name/heartbeat
POST    /api/agents/:name/nudge
```

There is no `PATCH /api/agents/:name` or `PATCH /api/agents/:id` route. The update path doesn't exist as a simple PATCH.

#### 6.3 `POST /api/agents/:id/deploy` — wrong path

The table shows:
```
POST   /api/agents/:id/deploy    Deploy/restart agent
```

The actual route is:
```
POST   /api/agents/:name/redeploy
```

#### 6.4 Changesets — `discard` endpoint doesn't exist, it's `cancel`

The table shows:
```
POST   /api/changesets/:id/discard    Discard changes
```

The actual route (in `packages/control/src/routes/changesets.ts`) is:
```
POST   /api/changesets/:id/cancel
```

There is no `/discard` endpoint. Using `/discard` would return 404.

#### 6.5 `GET /api/changesets/:id/diff` — doesn't exist

The table shows a `diff` endpoint:
```
GET    /api/changesets/:id/diff    View staged diffs
```

No such route exists in the actual changesets router. The diff information is returned as part of `GET /api/changesets/:id` (the changeset detail includes steps and mutations).

#### 6.6 Changesets table missing `approve` endpoint

The actual routes include:
```
POST   /api/changesets/:id/approve
POST   /api/changesets/:id/validate
POST   /api/changesets/:id/cancel
POST   /api/changesets/:id/retry
POST   /api/changesets/:id/apply
```

The docs table is missing `approve` and `validate`, which are important workflow steps.

#### 6.7 Workflows table missing several routes

The actual workflow routes include many more paths than documented:
- `GET /api/workflows/:id/runs`
- `GET /api/workflows/runs/active`
- `GET /api/workflows/runs/recent`
- `POST /api/workflows/runs/:runId/approve/:stepId`
- `POST /api/workflows/runs/:runId/reject/:stepId`
- `POST /api/workflows/runs/:runId/retry/:stepId`
- `POST /api/workflows/runs/:runId/cancel`

The docs mention `/rework` but it's actually there. The missing approve/reject/retry/cancel routes are important for workflow management.

#### 6.8 Auth table — `POST /api/auth/setup` is partially wrong

The table shows:
```
POST   /api/auth/setup    First-boot admin setup
```

The actual routes include `POST /api/auth/setup` (correct) but also:
- `GET /api/auth/setup-status` (public, checks setup state)
- `POST /api/auth/confirm-url` (setup wizard step)
- `POST /api/auth/setup-provider` (setup wizard AI provider step)

#### 6.9 Architecture description — "Agents communicate with the control plane via HTTP"

Under "Agent Containers":
> Agents communicate with the control plane via HTTP.

This is misleading. Agents (instances running armada-agent) communicate with the control plane **via the node agent proxy** (`http://armada-node:3002`), not directly to the control plane. Direct access is explicitly deprecated and unsupported for remote nodes.

**Recommended action:** Rewrite needed (see `docs/README-REWRITE.md`).

---

## 7. `packages/node/README.md`

**Status: ✅ Accurate — No issues**

All described features match the implementation in `packages/node/src/`:
- Container lifecycle via Docker socket — correct
- WebSocket tunnel connecting outbound — correct  
- Heartbeat reporting — correct
- Relay proxy (the `instance.relay` handler) — correct
- Stats streaming — correct
- Tool provisioning via eget — correct
- Gateway proxy (port 3002) — correct
- Credential rotation with fingerprint — correct
- Container naming prefix `armada-instance-` — verified correct

Environment variables `ARMADA_NODE_TOKEN` and `CONTROL_PLANE_URL` are correct.

**Recommended action:** No changes needed.

---

## 8. `plugins/agent/README.md`

**Status: 🔴 Incorrect config — High severity**

The README shows an incorrect plugin configuration example.

### Inaccuracy Found

#### 8.1 Config example is wrong — outdated fields

The README shows:
```json
{
  "plugins": {
    "entries": {
      "armada-agent": {
        "config": {
          "instanceName": "my-instance",
          "role": "development",
          "armadaApiUrl": "http://armada-control:3001",
          "armadaApiToken": "YOUR_TOKEN"
        }
      }
    }
  }
}
```

**Problems:**
1. `role` — this is in the plugin's `configSchema` as optional but is **not set** by the control plane's config generator. It's an unused/legacy field.
2. `armadaApiUrl` — this field is **explicitly deprecated** in the plugin source code (`plugins/agent/src/index.ts` line 55): `/** @deprecated Instances must ONLY communicate via proxyUrl (node agent relay). Direct control plane access is not supported. */`
3. **Missing `proxyUrl`** — the critical field. The actual generated config sets `proxyUrl: "http://armada-node:3002"`. This is how instances communicate with the control plane.

The correct config (as generated by `config-generator.ts`) is:
```json
{
  "plugins": {
    "entries": {
      "armada-agent": {
        "config": {
          "instanceName": "my-instance",
          "armadaApiToken": "YOUR_TOKEN",
          "proxyUrl": "http://armada-node:3002"
        }
      }
    }
  }
}
```

#### 8.2 Features list incomplete

The README does not mention:
- `armada_workflow_context` tool (fetch workflow state and prior step outputs)
- `armada_request_rework` tool (send work back for revision)
- `/armada/steer` endpoint (inject mid-task steering)
- `/armada/notify` endpoint (workflow notifications)
- `/armada/session` and `/armada/session/messages` endpoints

**Recommended action:** Update the config example. Add missing features to the list. (See `plugins/agent/README-REWRITE.md`.)

---

## 9. `plugins/control/README.md`

**Status: ⚠️ Incomplete — Medium severity**

### Issues Found

#### 9.1 Config example is incomplete

The README shows:
```json
{
  "plugins": {
    "entries": {
      "armada-control-plugin": {
        "config": {
          "armadaApiUrl": "http://armada-control:3001",
          "armadaApiToken": "YOUR_TOKEN"
        }
      }
    }
  }
}
```

The actual plugin config schema (`openclaw.plugin.json`) includes two additional important fields:
- `callbackUrl` — **required** for task results to be returned to the operator. Without this, `armada_task` calls won't get responses. Set to the operator instance's gateway URL (e.g. `http://robin:18789`).
- `hooksToken` — shared org-level hooks token for instance auth.

The config example is missing the most important field (`callbackUrl`) that makes async task dispatch work.

#### 9.2 Tools table is incomplete

The README lists only two tools:
```
armada_task(target, message)   Send an async task
armada_status()                Get health and status
```

The plugin also registers **auto-generated tools** from the control plane's `/api/meta/tools` endpoint. Any `registerToolDef()` call in `packages/control` becomes an available tool (workflow management, template sync, agent management, etc.). The README implies only two tools exist, which is misleading.

**Recommended action:** Add `callbackUrl` and `hooksToken` to the config example. Add a note about auto-generated tools.

---

## 10. `CONTRIBUTING.md`

**Status: ✅ Accurate — No issues**

The contributing guide is accurate:
- Correct build commands
- Correct dev commands
- Project structure is correct (`packages/shared`, `packages/control`, `packages/node`, `packages/ui`, `plugins/shared`, `plugins/agent`, `plugins/control`)
- PR guidance is sound

**Recommended action:** No changes needed.

---

## 11. `README.md` (root)

**Status: ⚠️ Minor inaccuracy — Low severity**

### Issue Found

#### 11.1 Packages table says "Fastify" for control plane

The packages table says:
```
packages/control   Control plane (Fastify + SQLite + Drizzle)
```

The actual framework is **Express** (v4), not Fastify. Confirmed in `packages/control/src/app.ts` and `packages/control/package.json`.

### What's Correct

- Architecture diagram is accurate
- Feature list is accurate and complete
- Docker Compose and install script instructions are accurate
- Roadmap items are accurate future plans
- Package descriptions (other than the Fastify error) are correct

**Recommended action:** Change `Fastify` to `Express` in the packages table.

---

## Rewrite Candidates

The following documents need more than minor edits. Rewritten versions have been written to `*-REWRITE.md` files alongside the originals.

| Original | Rewrite | Reason |
|----------|---------|--------|
| `docs/README.md` | `docs/README-REWRITE.md` | Multiple API route inaccuracies, missing routes, wrong parameter names |
| `plugins/agent/README.md` | `plugins/agent/README-REWRITE.md` | Incorrect/deprecated config example |

---

## Summary of Specific Corrections

### Route Path Corrections (`/hooks/armada/` → `/armada/`)

Every document that mentions these paths must be updated:

| Wrong | Correct |
|-------|---------|
| `POST /hooks/armada/task` | `POST /armada/task` |
| `GET /hooks/armada/health` | `GET /armada/health` |
| `GET /hooks/armada/status` | `GET/POST /armada/status` |
| `POST /hooks/armada/drain` | `POST /armada/drain` |
| `POST /hooks/armada/agents` | _(not yet implemented — future spec)_ |
| `GET /hooks/armada/capacity` | _(not yet implemented — future spec)_ |

### API Route Corrections (docs/README.md)

| Wrong | Correct |
|-------|---------|
| `GET/PATCH/DELETE /api/agents/:id` | `DELETE /api/agents/:name` (no PATCH) |
| `POST /api/agents/:id/deploy` | `POST /api/agents/:name/redeploy` |
| `POST /api/changesets/:id/discard` | `POST /api/changesets/:id/cancel` |
| `GET /api/changesets/:id/diff` | _(doesn't exist — remove)_ |

### Plugin Config Corrections

| Plugin | Wrong | Correct |
|--------|-------|---------|
| armada-agent | `armadaApiUrl: "http://armada-control:3001"` | `proxyUrl: "http://armada-node:3002"` |
| armada-agent | `role: "development"` | _(not set in generated config — remove from example)_ |
| armada-control-plugin | _(missing)_ | Add `callbackUrl: "http://your-operator:18789"` |

### Framework Correction

| Document | Wrong | Correct |
|----------|-------|---------|
| `README.md` packages table | `Fastify + SQLite + Drizzle` | `Express + SQLite + Drizzle` |
| `packages/control/README.md` | _(says Fastify in title context)_ | Express |

---

## Files NOT Audited (out of scope)

The following spec files were not audited as they are forward-looking design documents rather than implementation docs. They may contain aspirational content that doesn't match the current codebase — that's expected for specs.

- `docs/COLLABORATION-SPEC.md`
- `docs/CREDENTIAL-INJECTION-SPEC.md`  
- `docs/INSTALLATION-SIMPLIFICATION.md`
- `docs/INSTANCE-PROVISIONING-SPEC.md`
- `docs/OPERATIONS-ENGINE-SPEC.md`
- `docs/SERVICE-LAYER-SPEC.md`
- `docs/UI-DESIGN-SYSTEM.md`
- `TASK-INSTALL-SIMPLIFY.md`
- `packages/control/src/infrastructure/EVENT_MAP.md`
