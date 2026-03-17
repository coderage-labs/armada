# @coderage-labs/armada-control-plugin

OpenClaw plugin for the armada operator agent. Provides tools to dispatch tasks, check armada status, and manage workflows — without being a managed instance.

## What It Does

- **Task dispatch** — send work to any agent in the armada by name (`armada_task`)
- **Armada status** — query health and status of all instances and agents (`armada_status`)
- **Auto-generated tools** — all control plane API endpoints exposed as tools dynamically via `/api/meta/tools`
- **Result ingestion** — receives async task results at `/armada/result` and feeds them back to the operator's LLM session
- **Workflow events** — receives workflow gate/completion notifications at `/armada/notify`

## Tools

### Manual tools

| Tool | Description |
|------|-------------|
| `armada_task(target, message)` | Send an async task to an armada agent by name. Returns immediately; result arrives later. |
| `armada_status()` | Get health and status of all armada instances and agents. |

### Auto-generated tools

Any `registerToolDef()` call on the control plane automatically becomes an available tool on the operator. This includes (but is not limited to):

- `armada_template_drift` / `armada_template_sync` — check and fix config drift
- `armada_inbound_webhooks_*` — manage inbound webhooks
- Workflow management tools
- Any other tools registered via the control plane's tool registry

## Configuration

```json
{
  "plugins": {
    "entries": {
      "armada-control-plugin": {
        "config": {
          "armadaApiUrl": "http://armada-control:3001",
          "armadaApiToken": "YOUR_TOKEN",
          "callbackUrl": "http://your-operator-instance:18789",
          "hooksToken": "SHARED_ORG_HOOKS_TOKEN"
        }
      }
    }
  }
}
```

### Config Fields

| Field | Required | Description |
|-------|----------|-------------|
| `armadaApiUrl` | ✅ | Armada control API URL (e.g. `http://armada-control:3001`) |
| `armadaApiToken` | ✅ | API Bearer token for authenticating to the control plane |
| `callbackUrl` | ✅ | The operator instance's gateway URL. Task results from managed agents are POSTed to `{callbackUrl}/armada/result`. Without this, `armada_task` calls won't receive responses. |
| `hooksToken` | — | Shared org-level hooks token for instance authentication |

> ⚠️ `callbackUrl` is required for async task dispatch to work. Set it to the operator instance's OpenClaw gateway URL (e.g. `http://robin:18789` or whatever hostname the managed instances can reach the operator at).

## HTTP Routes

Registered on the operator's OpenClaw gateway:

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/armada/result` | Receive task results from managed instances. Feeds result back into operator's coordinator session. |
| `POST` | `/armada/notify` | Receive workflow gate/completion events. |

## Links

- [Armada](https://github.com/coderage-labs/armada) — Control plane and dashboard
- [Architecture](https://github.com/coderage-labs/armada/blob/main/docs/ARCHITECTURE.md) — How the operator plugin fits into the communication flow
- [Plugin Guide](https://github.com/coderage-labs/armada/blob/main/docs/PLUGIN-GUIDE.md) — Building OpenClaw plugins
