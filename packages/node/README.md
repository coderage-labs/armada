# @coderage-labs/armada-node

The Armada node agent — runs on each host machine to manage Docker containers.

## What It Does

- **Container lifecycle** — create, start, stop, remove Docker containers for agent instances
- **WebSocket tunnel** — connects outbound to the control plane (no inbound ports needed)
- **Heartbeat reporting** — sends node health + container statuses every 30s
- **Relay proxy** — forwards API requests from the control plane to containers on the node
- **Stats streaming** — real-time CPU/memory/network stats per container
- **Tool provisioning** — installs CLI tools via [eget](https://github.com/zyedidia/eget), shared read-only mount to containers
- **Gateway proxy** — proxies OpenClaw gateway API calls from instances to the control plane
- **Credential rotation** — secure credential management with fingerprint verification

## Running

```bash
# Development
npm run dev

# Production
npm run build && npm start
```

## Environment Variables

| Variable | Description |
|---|---|
| `NODE_AGENT_TOKEN` | Authentication token for the control plane |
| `CONTROL_PLANE_URL` | WebSocket URL of the control plane |

## Docker Socket

The node agent requires access to the Docker socket (`/var/run/docker.sock`). It creates containers on the `armada-net` Docker network.

## Container Naming

All managed containers use the prefix `armada-instance-`. The node agent filters by this prefix when reporting container status.
