# Armada — Developer Documentation

> **Quick links:** [Architecture](#architecture) · [Quick Start](#quick-start) · [Configuration](#configuration) · [API Overview](#api-overview) · [Webhooks](#webhooks)

---

## Architecture

Armada is a three-tier system: a **control plane**, one or more **node agents**, and **agent containers**.

```mermaid
graph TD
    subgraph Machine1["Machine 1"]
        CP["Control Plane :3001"]
        CP --- API["REST API (Fastify)"]
        CP --- DBL["SQLite (Drizzle ORM)"]
        CP --- WS1["WebSocket tunnel"]
        CP --- SSE["SSE event bus"]
        CP --- CSP["Changeset pipeline"]
        CP --- WFE["Workflow engine (DAG)"]
        CP --- TDP["Task dispatcher"]
        CP --- WHD["Webhook dispatcher"]
        NA1["Node Agent"]
        NA1 --- DS1["Docker socket"]
        NA1 --- CR["Container reconciliation"]
        NA1 --- GP["Gateway proxy"]
    end

    subgraph MachineN["Machine N"]
        NA2["Node Agent"]
        NA2 --- DS2["Docker socket"]
        NA2 --- AC["Agent containers"]
    end

    Browser["🖥️ React SPA"] --> CP
    Operator["🤖 Operator Agent\n(armada_* tools)"] --> CP
    CP -- "WebSocket" --> NA1
    CP -- "WebSocket" --> NA2
```

### Control Plane

The control plane (`packages/control`) is a Node.js server that:

- Serves the React dashboard (`packages/ui`) via Vite-built static files
- Exposes the REST API (all endpoints under `/api/`)
- Maintains a SQLite database via Drizzle ORM (auto-migrating, currently v30)
- Manages WebSocket tunnels to each node agent (nodes dial outbound)
- Runs: health monitor, task dispatcher, workflow engine, changeset pipeline, webhook dispatcher

### Node Agent

The node agent (`packages/node`) runs on each host machine. It:

- Manages Docker containers (create, start, stop, remove)
- Connects outbound to the control plane via WebSocket (no inbound ports required)
- Reports container statuses in heartbeats for automatic reconciliation
- Relays API requests from the control plane to containers
- Streams real-time CPU/memory/network stats
- Provisions CLI tools via [eget](https://github.com/zyedidia/eget)

### Agent Containers

Each agent runs in a Docker container with its own tools, skills, and security boundaries. Agents communicate with the control plane via HTTP. The `armada-agent` plugin handles task execution, heartbeats, and result callbacks.

---

## Quick Start

### Prerequisites

- Node.js 20+
- Docker
- (Optional) An OpenClaw instance as the operator agent

### 1. Clone and build

```bash
git clone https://github.com/coderage-labs/armada.git
cd armada
npm install
npm run build
```

### 2. Configure

```bash
cp .env.example .env
# Set ARMADA_API_TOKEN and ARMADA_NODE_TOKEN
```

### 3. Start with Docker Compose

```bash
docker compose up -d
```

This starts:
- `armada-control` on port 3001 (dashboard + API)
- `armada-node` on the same host, connected to the local Docker socket

### 4. Open the dashboard

Visit `http://localhost:3001`. First-boot setup will prompt you to create an admin account.

### 5. Add more nodes (optional)

On a remote machine, use the install script from the Nodes page or:

```bash
curl -fsSL https://raw.githubusercontent.com/coderage-labs/armada/main/install.sh | bash -s -- --node-only --token YOUR_TOKEN
```

---

## Configuration

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `ARMADA_API_TOKEN` | *(required)* | Master API token |
| `ARMADA_NODE_TOKEN` | *(required)* | Node agent authentication token |
| `ARMADA_API_URL` | `http://armada-control:3001` | Internal control plane URL (for agent callbacks) |
| `ARMADA_UI_URL` | — | Public URL of the dashboard (for notification links) |
| `ARMADA_DB_PATH` | `/data/armada.db` | SQLite database path |
| `ARMADA_PLUGINS_PATH` | `/data/plugins` | Plugin storage directory |
| `ARMADA_AVATAR_MODEL` | `openai/dall-e-3` | Model for AI avatar generation |
| `ARMADA_TELEGRAM_BOT_TOKEN` | — | Telegram bot for notifications |
| `ARMADA_TELEGRAM_CHAT_ID` | — | Telegram chat for notifications |

---

## API Overview

All routes under `/api/`. Authenticate with `Authorization: Bearer <token>` or session cookie.

### Core Resources

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/agents` | List agents |
| `POST` | `/api/agents` | Create agent |
| `GET/PATCH/DELETE` | `/api/agents/:id` | Agent CRUD |
| `POST` | `/api/agents/:id/deploy` | Deploy/restart agent |
| `GET` | `/api/instances` | List instances |
| `GET` | `/api/nodes` | List nodes |
| `GET` | `/api/templates` | List templates |
| `POST` | `/api/templates` | Create template |
| `GET` | `/api/tasks` | List tasks |
| `POST` | `/api/tasks` | Create task |
| `POST` | `/api/tasks/:id/result` | Task completion callback |

### Workflows

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/workflows` | List workflows |
| `POST` | `/api/workflows` | Create workflow |
| `POST` | `/api/workflows/:id/run` | Start a run (accepts `variables`) |
| `GET` | `/api/workflows/runs/:runId` | Run status |
| `GET` | `/api/workflows/runs/:runId/steps` | Step statuses |
| `GET` | `/api/workflows/runs/:runId/context` | Full context (steps + outputs + reworks) |
| `POST` | `/api/workflows/runs/:runId/rework` | Request rework on a step |

### Changesets

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/changesets` | List changesets |
| `POST` | `/api/changesets` | Create changeset |
| `POST` | `/api/changesets/:id/apply` | Apply staged changes |
| `POST` | `/api/changesets/:id/discard` | Discard changes |
| `GET` | `/api/changesets/:id/diff` | View staged diffs |
| `POST` | `/api/changesets/:id/retry` | Retry failed changeset |

### Events

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/events/stream` | SSE stream (all state changes) |

### Auth

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/auth/login/password` | Password login |
| `POST` | `/api/auth/passkey/login-options` | WebAuthn challenge |
| `POST` | `/api/auth/passkey/login-verify` | WebAuthn verify |
| `GET` | `/api/auth/me` | Current user profile |
| `PUT` | `/api/auth/me` | Update profile |
| `POST` | `/api/auth/setup` | First-boot admin setup |

---

## Webhooks

### Outbound

Control plane POSTs to external URLs when events occur. Configure via the Webhooks page or API.

### Inbound

External services POST to Armada to trigger actions:

1. Create an inbound webhook (dashboard or `POST /api/webhooks/inbound`)
2. Armada generates a unique URL: `https://your-armada.example.com/hooks/<hookId>`
3. Configure the external service to POST to that URL

**Actions:** `workflow` (start a run), `task` (create a task), `event` (emit to event bus)

**Signature verification:** If a `secret` is configured, Armada verifies HMAC-SHA256 via `X-Hub-Signature-256` or `X-Armada-Signature` headers.

---

## Further Reading

- [Architecture](./ARCHITECTURE.md) — core concepts and team model
- [Changeset pipeline](./UNIVERSAL-CHANGESET-SPEC.md) — how config mutations work
- [Collaboration spec](./COLLABORATION-SPEC.md) — inter-agent workflow collaboration
- [Credential injection](./CREDENTIAL-INJECTION-SPEC.md) — secure key management
- [Plugin guide](./PLUGIN-GUIDE.md) — building OpenClaw plugins for Armada
- [Reverse tunnel architecture](./REVERSE-TUNNEL-ARCHITECTURE.md) — node agent connectivity
- [Service layer](./SERVICE-LAYER-SPEC.md) — backend service architecture
- [UI design system](./UI-DESIGN-SYSTEM.md) — dashboard design principles
