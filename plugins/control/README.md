# @coderage-labs/armada-control-plugin

OpenClaw plugin for the armada operator agent. Provides tools to dispatch tasks, check armada status, and manage workflows — without being a managed instance.

## What It Does

- **Task dispatch** — send work to any agent in the armada by name or role
- **Armada status** — query health and status of all instances and agents
- **Workflow triggers** — start workflow runs with variables
- **Operator-level access** — can reach any instance in any org

## Tools

| Tool | Description |
|------|-------------|
| `armada_task(target, message)` | Send an async task to a armada agent |
| `armada_status()` | Get health and status of all armada agents |

## Configuration

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

## Links

- [Armada](https://github.com/coderage-labs/armada) — Control plane and dashboard
- [Plugin Guide](https://github.com/coderage-labs/armada/blob/main/docs/PLUGIN-GUIDE.md) — Building OpenClaw plugins
