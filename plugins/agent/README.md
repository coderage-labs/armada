# @coderage-labs/armada-agent

OpenClaw plugin for Armada-managed agent instances. Installed automatically by the changeset pipeline when agents are deployed.

## What It Does

- **Task execution** — receives work dispatched by workflows and the task system via `POST /armada/task`
- **Heartbeat reporting** — sends health status and active task count to the control plane
- **Status endpoint** — `GET/POST /armada/status` for idle/busy/draining state
- **Maintenance support** — `POST /armada/drain` to gracefully stop accepting work
- **Health endpoint** — `GET /armada/health` for control plane health checks
- **Workflow context** — `armada_workflow_context` tool lets agents fetch workflow state and prior step outputs
- **Rework requests** — `armada_request_rework` tool lets review agents send work back for revision
- **Progress reporting** — task progress posted back to the control plane in real-time
- **Callback on completion** — results POSTed back when `TASK_COMPLETE` is detected in agent output
- **Subtask coordination** — parent tasks wait for child tasks before finalizing
- **Mid-task steering** — `POST /armada/steer` allows injecting instructions into active tasks
- **Workflow notifications** — `POST /armada/notify` receives gate/completion events from the control plane
- **Session inspection** — `GET /armada/session` and `GET /armada/session/messages` for session visibility

## Installation

Installed automatically by the Armada changeset pipeline. For manual installation:

```bash
npm install @coderage-labs/armada-agent
```

## Configuration

Added to `openclaw.json` on managed instances by the Armada config generator:

```json
{
  "plugins": {
    "load": {
      "paths": ["/home/node/.openclaw/extensions/armada-agent"]
    },
    "allow": ["armada-agent"],
    "entries": {
      "armada-agent": {
        "config": {
          "instanceName": "my-instance",
          "armadaApiToken": "YOUR_SCOPED_TOKEN",
          "proxyUrl": "http://armada-node:3002"
        }
      }
    }
  }
}
```

### Config Fields

| Field | Required | Description |
|-------|----------|-------------|
| `instanceName` | ✅ | This instance's name (used for identity and heartbeats) |
| `armadaApiToken` | ✅ | Scoped API token (generated per-instance by the control plane) |
| `proxyUrl` | ✅ | Node agent proxy URL — all outbound calls route through here. Default: `http://armada-node:3002` |
| `org` | — | Organisation identifier (optional metadata) |
| `role` | — | Instance role label (optional metadata, e.g. `development`) |
| `progressTimeoutMs` | — | Timeout (ms) without LLM output before task is considered stuck (default: 600000) |
| `hardTimeoutMs` | — | Absolute task ceiling (ms) — always fires (default: 1800000) |
| `pingWatchdogMs` | — | Timeout (ms) without a ping before agent is presumed dead (default: 60000) |
| `projects` | — | Project names this instance belongs to |

> ⚠️ `armadaApiUrl` is deprecated — instances must communicate via `proxyUrl` (node agent relay). Direct control plane access is not supported for remote nodes.

## HTTP Routes

Registered on the OpenClaw gateway at startup:

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/armada/task` | plugin | Receive inbound task — creates InboundContext, fires turn |
| `POST` | `/armada/result` | plugin | Receive subtask result callbacks |
| `GET/POST` | `/armada/status` | plugin | Instance status (activeTasks, role, etc.) |
| `GET` | `/armada/health` | plugin | Health check (`{ healthy, uptime }`) |
| `POST` | `/armada/drain` | plugin | Enter drain mode — stop accepting new tasks |
| `POST` | `/armada/steer` | plugin | Inject mid-task steering message |
| `POST` | `/armada/notify` | plugin | Receive workflow notifications |
| `GET` | `/armada/session` | plugin | List sessions via gateway RPC |
| `GET` | `/armada/session/messages` | plugin | Get session message history |

## Agent Tools

| Tool | Description |
|------|-------------|
| `armada_task` | Dispatch a task to another armada agent (goes via node agent proxy → control plane → target) |
| `armada_workflow_context` | Fetch current workflow state and prior step outputs |
| `armada_request_rework` | Send completed work back for revision (in workflow review loops) |

## Links

- [Armada](https://github.com/coderage-labs/armada) — Control plane and dashboard
- [Architecture](https://github.com/coderage-labs/armada/blob/main/docs/ARCHITECTURE.md) — How task dispatch works
- [Plugin Guide](https://github.com/coderage-labs/armada/blob/main/docs/PLUGIN-GUIDE.md) — Building OpenClaw plugins
