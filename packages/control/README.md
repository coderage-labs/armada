# @coderage-labs/armada-control

The Armada control plane — API server, dashboard, and orchestration engine.

## What It Does

- **REST API** — full CRUD for agents, instances, templates, workflows, tasks, projects, users, and more
- **Dashboard** — React SPA served from the same process (Vite-built, shadcn/ui)
- **Changeset pipeline** — all config mutations staged, diffed, and applied atomically across nodes
- **Workflow engine** — DAG-based multi-step execution with role dispatch, template variables, and review loops
- **Health monitoring** — heartbeat-based agent health with auto-degradation
- **Container reconciliation** — node heartbeats report container state, control plane auto-corrects stale statuses
- **Task dispatcher** — routes tasks to agents by role with capacity-based load balancing
- **SSE streaming** — real-time event bus for all state changes (no polling)
- **WebSocket tunnel** — nodes connect outbound to the control plane (no inbound ports required)
- **GitHub integration** — issue sync, PR linking, project management
- **Webhook dispatcher** — configurable event-driven notifications with retry and delivery tracking
- **Telegram notifications** — optional bot for alerts and escalations

## Running

```bash
# Development
npm run dev

# Production
npm run build && npm start
```

## Environment Variables

See [`.env.example`](../../.env.example) for the full list. Key variables:

| Variable | Description |
|---|---|
| `ARMADA_API_TOKEN` | Master API token (required) |
| `ARMADA_DB_PATH` | SQLite database path (default: `/data/armada.db`) |
| `ARMADA_API_URL` | Internal URL for agent callbacks (default: `http://armada-control:3001`) |

## Database

SQLite via Drizzle ORM. Migrations run automatically on startup (currently at v30).

## API Authentication

All endpoints require `Authorization: Bearer <token>`. Cookie-based sessions also supported (passkey + password auth).
