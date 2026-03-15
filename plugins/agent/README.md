# @coderage-labs/armada-agent

OpenClaw plugin for Armada-managed agent instances. Installed automatically by the changeset pipeline when agents are deployed.

## What It Does

- **Task execution** — receives work dispatched by workflows and the task system via `/fleet/task`
- **Heartbeat reporting** — sends health status and active task count to the control plane
- **Status endpoint** — `/fleet/status` for idle/busy/draining state
- **Maintenance support** — `/fleet/drain` to gracefully stop accepting work
- **Health endpoint** — `/fleet/health` for control plane health checks
- **Workflow context** — `fleet_workflow_context` tool lets agents fetch workflow state and prior step outputs
- **Rework requests** — `fleet_request_rework` tool lets review agents send work back for revision
- **Progress reporting** — task progress posted back to the control plane in real-time
- **Callback on completion** — results POSTed back when `TASK_COMPLETE` is detected in agent output
- **Subtask coordination** — parent tasks wait for child tasks before finalizing

## Installation

Installed automatically by the Armada changeset pipeline. For manual installation:

```bash
npm install @coderage-labs/armada-agent
```

## Configuration

Added to `openclaw.json` on managed instances:

```json
{
  "plugins": {
    "entries": {
      "armada-agent": {
        "config": {
          "instanceName": "my-instance",
          "role": "development",
          "fleetApiUrl": "http://armada-control:3001",
          "fleetApiToken": "YOUR_TOKEN"
        }
      }
    }
  }
}
```

## Links

- [Armada](https://github.com/coderage-labs/armada) — Control plane and dashboard
- [Plugin Guide](https://github.com/coderage-labs/armada/blob/main/docs/PLUGIN-GUIDE.md) — Building OpenClaw plugins
