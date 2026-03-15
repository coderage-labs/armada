# Reverse Tunnel Node Architecture

> RFC — Fleet node agents dial out to the control plane instead of being called inbound.

## Problem

Current architecture requires the control plane to reach node agents via HTTP:

```
Control Plane → HTTP → Node Agent (needs routable address + open port)
```

This breaks when nodes are behind NAT, firewalls, or don't have static IPs. It also makes multi-host deployments painful (#210) — every node needs a routable address that the control plane can reach.

## Proposal

Flip the connection direction. Node agents establish persistent outbound connections to the control plane:

```
Node Agent → WSS → Control Plane (single public endpoint)
```

The control plane becomes the hub. Nodes are spokes that dial in. Zero inbound ports required on nodes.

## How It Works

### Connection Flow

```
1. Operator registers a node in the UI → gets a node token
2. On the target machine:
   $ curl -fsSL https://armada.example.com/install | sh -s -- --token abc123
3. Node agent starts, connects WSS to control plane
4. Control plane authenticates token, node appears as "online"
5. All commands flow over the persistent WebSocket connection
```

### Message Protocol

Typed message envelopes over WebSocket. Every message has a discriminated `type` field. Commands use request IDs for correlation — the sender includes an `id`, the responder echoes it back. This gives us gRPC-style request/response semantics over a raw WebSocket.

#### Envelope Types

```typescript
// ── Base envelope ──
interface BaseMessage {
  type: 'command' | 'response' | 'event' | 'stream';
}

// ── Command: Control → Node ──
// Requests an action. Node MUST respond with a matching `id`.
interface CommandMessage extends BaseMessage {
  type: 'command';
  id: string;              // UUID — correlates with response
  action: string;          // e.g. 'container.create', 'file.write'
  params: Record<string, unknown>;
  timeout?: number;        // ms — control plane cancels if no response (default 30000)
}

// ── Response: Node → Control ──
// Always correlates to a command via `id`.
interface ResponseMessage extends BaseMessage {
  type: 'response';
  id: string;              // Matches the command's id
  status: 'ok' | 'error';
  data?: unknown;          // Present on success
  error?: string;          // Present on error
  code?: string;           // Machine-readable error code (e.g. 'CONTAINER_NOT_FOUND')
}

// ── Event: Node → Control (fire-and-forget) ──
// No response expected. Used for async notifications.
interface EventMessage extends BaseMessage {
  type: 'event';
  event: string;           // e.g. 'container.health', 'node.stats', 'heartbeat'
  data?: Record<string, unknown>;
  timestamp: string;       // ISO 8601
}

// ── Stream: Either direction ──
// For chunked data (logs, file transfers). References a command `id`.
interface StreamMessage extends BaseMessage {
  type: 'stream';
  id: string;              // Matches the originating command's id
  chunk: string;           // Data chunk (utf-8 text or base64 for binary)
  encoding?: 'utf8' | 'base64';
  seq: number;             // Sequence number (0-indexed)
  done: boolean;           // True on final chunk
}
```

#### Correlation & Timeouts

The control plane maintains a `Map<id, { resolve, reject, timer }>` for pending commands. When a response arrives with a matching `id`, the promise resolves. If `timeout` elapses with no response, the promise rejects with `TIMEOUT`.

```typescript
// Control plane dispatcher (simplified)
class CommandDispatcher {
  private pending = new Map<string, PendingCommand>();

  async send(ws: WebSocket, action: string, params: object, timeoutMs = 30000): Promise<unknown> {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Command ${action} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ type: 'command', id, action, params, timeout: timeoutMs }));
    });
  }

  handleResponse(msg: ResponseMessage) {
    const pending = this.pending.get(msg.id);
    if (!pending) return; // Orphaned response, ignore
    clearTimeout(pending.timer);
    this.pending.delete(msg.id);
    if (msg.status === 'ok') pending.resolve(msg.data);
    else pending.reject(new Error(msg.error || 'Unknown error'));
  }
}
```

#### Streaming

For log tailing and large file transfers, the `stream` message type sends data in chunks. The `id` ties back to the originating command, and `done: true` signals completion. The receiver assembles chunks in order using `seq`.

```
Command:  { type: "command", id: "abc", action: "container.logs", params: { name: "forge", tail: 100, follow: true } }
Stream:   { type: "stream", id: "abc", chunk: "2026-03-10 ...\n", seq: 0, done: false }
Stream:   { type: "stream", id: "abc", chunk: "2026-03-10 ...\n", seq: 1, done: false }
...
Stream:   { type: "stream", id: "abc", chunk: "", seq: 42, done: true }
```

For non-streaming commands, a single `response` message is sufficient — no `stream` messages needed.

#### Actions

```
Container lifecycle:
  container.create    → Create and optionally start a container
  container.start     → Start a stopped container
  container.stop      → Stop a running container
  container.restart   → Restart a container
  container.remove    → Remove a container
  container.logs      → Get/stream container logs (supports streaming)
  container.stats     → Get container resource stats
  container.list      → List containers managed by this node
  container.inspect   → Get detailed container info

File operations:
  file.read           → Read file content (supports streaming for large files)
  file.write          → Write file content (supports streaming for large files)
  file.list           → List files in a directory
  file.delete         → Delete a file

Plugin/skill management:
  plugin.install      → Install a plugin package
  plugin.remove       → Remove a plugin
  skill.install       → Install a skill
  skill.remove        → Remove a skill

Instance relay:
  instance.relay      → Proxy HTTP request to a local instance

System:
  node.stats          → Get node resource usage (CPU, memory, disk)
  node.info           → Get node metadata (OS, Docker version, etc.)
```

#### Error Codes

Standardised error codes for machine-readable error handling:

```
CONTAINER_NOT_FOUND   — Target container doesn't exist
CONTAINER_RUNNING     — Container is already running (for start)
CONTAINER_STOPPED     — Container is already stopped (for stop)
FILE_NOT_FOUND        — Target file doesn't exist
PERMISSION_DENIED     — Insufficient filesystem permissions
INSTANCE_UNREACHABLE  — Instance relay target not responding
DOCKER_ERROR          — Docker daemon error (detail in error message)
TIMEOUT               — Command exceeded timeout
UNKNOWN               — Catch-all
```

### Connection Lifecycle

```
Node starts → connect WSS → authenticate (token in header)
  ↓ connected
  ← commands from control plane
  → responses + events to control plane
  ↓ disconnect (network issue)
  → auto-reconnect with exponential backoff (1s, 2s, 4s, ... max 60s)
  ↓ reconnected
  → resume
```

Control plane tracks connection state:
- **online**: WebSocket connected, responding
- **offline**: WebSocket disconnected, reconnecting
- **stale**: No connection for >5 minutes

### Heartbeats

Node sends heartbeat event every 30s. Control plane marks node offline if no heartbeat for 90s. This catches silent connection drops that TCP keepalive might miss.

## Architecture

### Control Plane Changes

```
packages/control/
  src/
    ws/
      node-connections.ts    # WebSocket connection manager
      command-dispatcher.ts  # Send commands, await responses
      protocol.ts            # Message types and validation
    routes/
      node-ws.ts             # GET /api/nodes/ws — WebSocket upgrade endpoint
```

**NodeConnectionManager**: Maintains a `Map<nodeId, WebSocket>`. When a service needs to talk to a node, it calls `dispatcher.send(nodeId, command)` which returns a Promise that resolves when the node responds.

**Replaces**: Direct HTTP calls via `NodeClient`. The `NodeClient` interface stays the same — its implementation changes from HTTP fetch to WebSocket command dispatch. Zero changes needed in services that use NodeClient.

```typescript
// Before (HTTP):
class HttpNodeClient implements NodeClient {
  async createContainer(nodeId, params) {
    return fetch(`${nodeUrl}/containers`, { method: 'POST', body: params });
  }
}

// After (WebSocket):
class WsNodeClient implements NodeClient {
  async createContainer(nodeId, params) {
    return dispatcher.send(nodeId, { action: 'container.create', params });
  }
}
```

### Node Agent Changes

```
packages/node/
  src/
    ws/
      connection.ts          # WebSocket client, reconnect logic
      command-handler.ts     # Route incoming commands to handlers
    handlers/
      containers.ts          # container.create, start, stop, logs, stats, etc.
      files.ts               # file.read, file.write, file.list
      plugins.ts             # plugin.install, plugin.remove
      system.ts              # node.stats, node.info
      relay.ts               # instance.relay — proxy HTTP to local instances
```

**Replaces**: Fastify HTTP server. The node agent no longer listens on a port — it only dials out.

**Docker socket access**: Unchanged. Node agent still needs `/var/run/docker.sock` mounted.

## Node Agent as Network Gateway

The node agent acts as the sole network gateway for all instances running on that node. Instances don't need to know about the control plane, other nodes, or the wider network topology.

### How It Works

```
┌─────────────────────────────────────────────────┐
│ Node                                             │
│                                                  │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐      │
│  │ Instance │  │ Instance │  │ Instance │      │
│  │ (forge)  │  │ (nexus)  │  │ (scout)  │      │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘      │
│       │              │              │             │
│       └──────────────┼──────────────┘             │
│                      │ HTTP (local network)       │
│              ┌───────┴────────┐                   │
│              │  Node Agent    │                   │
│              │  (gateway)     │                   │
│              └───────┬────────┘                   │
│                      │ WSS (outbound only)        │
└──────────────────────┼──────────────────────────┘
                       │
                       ▼
               ┌───────────────┐
               │ Control Plane │
               └───────────────┘
```

### Instance → Control Plane

Instances need to reach the control plane for:
- Fleet agent plugin hooks (heartbeats, task completion callbacks)
- Nudge responses
- Any future control plane API calls

The node agent exposes a **local HTTP proxy** on the instance's Docker network:

```
Instance → http://fleet-gateway:3002/api/... → Node Agent → WSS → Control Plane
```

The proxy container (or the node agent itself) joins each instance's Docker network and proxies HTTP requests to the control plane over the WebSocket tunnel.

Instance config only needs: `callbackUrl: "http://fleet-gateway:3002"`

### Control Plane → Instance

When the control plane needs to reach an instance (nudge, task dispatch, health probe):

```
Control Plane → WSS → Node Agent → instance.relay command → HTTP → Instance (local)
```

The control plane sends an `instance.relay` command with the target instance ID, HTTP method, path, and body. The node agent resolves the instance's local address and proxies the request.

### Instance → Instance (Cross-Node)

For agents on different nodes to communicate:

```
Instance A → fleet-gateway → Node A → WSS → Control Plane → WSS → Node B → Instance B
```

The control plane acts as a message router. The `instance.relay` command can target any instance on any node. Latency is higher than direct communication but:
- Zero networking config required
- Works across any network topology
- Secure — all traffic encrypted in transit via WSS

### Instance → Instance (Same Node)

For instances on the same node, the node agent can short-circuit:

```
Instance A → fleet-gateway → Node Agent → Instance B (local)
```

No round-trip to the control plane needed. The node agent knows which instances are local.

### OpenClaw Hooks Through the Tunnel

OpenClaw instances use hooks (HTTP callbacks) for fleet integration — heartbeats, task completion, nudge responses. Currently these require direct HTTP connectivity between control plane and instances. With the reverse tunnel, **all hook traffic flows through the WebSocket**:

**Outbound hooks (instance → control):**
```
Instance → http://fleet-gateway:3002/hooks → Node Agent → WSS → Control Plane
```
The armada-agent plugin's `callbackUrl` points to the local gateway. No change needed in instance config.

**Inbound hooks (control → instance):**
```
Control Plane → WSS → Node Agent → instance.relay → http://instance:18789/hooks
```
Health probes, nudges, task dispatch — all via `instance.relay`. The control plane never needs direct network access to instances.

**Result:** Hooks are just another message type on the tunnel. No special networking, no exposed ports, no separate auth tokens per instance.

### Inbound Webhooks on Control Plane (#233)

The control plane itself exposes a webhook endpoint for external services:

```
GitHub/CI/Monitoring → POST /api/webhooks/incoming/:hookId → Control Plane → Trigger Workflow
```

This enables event-driven automation:
- GitHub push → trigger deploy workflow
- CI completion → trigger QA workflow
- Monitoring alert → trigger incident response
- Custom scripts → create tasks, trigger any workflow

Webhook payloads are mapped to workflow triggers with template interpolation. Combined with the reverse tunnel, this gives a complete event-driven architecture: external events flow in via webhooks, internal commands flow out via the tunnel.

### What Instances See

From an instance's perspective, the network is simple:
- **One endpoint**: `http://fleet-gateway:3002` — their gateway to everything
- **No control plane URL** — they don't know or care where it is
- **No other instance URLs** — routing is handled for them
- **No tokens for external services** — the gateway handles auth

This is the sidecar gateway pattern. Instances are fully isolated network-wise.

## Distribution

### Docker Image (primary)

Since every target machine has Docker (the node agent manages containers), Docker is the primary distribution:

```bash
curl -fsSL https://armada.example.com/install | sh -s -- --token abc123
```

The install script:
1. Pulls the node agent Docker image
2. Creates a container with Docker socket mounted
3. Configures the control plane URL and token
4. Sets up as a systemd service (or just `--restart unless-stopped`)

```bash
docker run -d \
  --name armada-node \
  --restart unless-stopped \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -e FLEET_CONTROL_URL=wss://armada.example.com/api/nodes/ws \
  -e FLEET_NODE_TOKEN=abc123 \
  ghcr.io/coderage-labs/armada-node:latest
```

### Native Binary (future)

For edge cases (Mac/Windows dev machines, environments where running Docker-in-Docker is undesirable):
- Single binary compiled with `bun build --compile`
- Cross-platform: Linux/macOS/Windows, ARM64/x64
- Download from GitHub releases or `armada.example.com/download`

Not needed initially — Docker covers all current use cases.

## Deployment Topologies

### Single Host (current setup, simplified)
```
┌─────────────────────────────────┐
│ VPS                              │
│  ┌─────────────┐                │
│  │ Control      │◄── Cloudflare │◄── Browser
│  │ Plane        │    Tunnel     │
│  └──────┬───────┘               │
│         │ WSS (localhost)        │
│  ┌──────┴───────┐               │
│  │ Node Agent   │               │
│  │ ┌──────────┐ │               │
│  │ │ Instances│ │               │
│  │ └──────────┘ │               │
│  └──────────────┘               │
└─────────────────────────────────┘
```

### Multi-host
```
┌──────────────┐         ┌──────────────┐
│ VPS          │         │ Mac Mini     │
│ Control Plane│◄─WSS────│ Node Agent   │
│ + Node Agent │         │ (home lab)   │
└──────────────┘         └──────────────┘
        ▲
        │ WSS
┌───────┴──────┐
│ Office PC    │
│ Node Agent   │
└──────────────┘
```

### Air-gapped control plane (via Cloudflare Tunnel)
```
                     ┌──────────────────┐
Browser ──HTTPS──►   │ Cloudflare Edge  │
                     └────────┬─────────┘
                              │ Tunnel
                     ┌────────┴─────────┐
                     │ Home Server      │
                     │ Control Plane    │
                     │ cloudflared      │
                     └────────┬─────────┘
                              │ WSS (outbound from nodes)
               ┌──────────────┼──────────────┐
               ▼              ▼              ▼
          Node (VPS)    Node (Pi)    Node (Cloud VM)
```

## Security

### Transport
- **WSS (WebSocket over TLS)** when control plane is behind HTTPS — encrypts all traffic, prevents tampering, verifies server identity
- For local development: WS is fine (localhost)
- No sensitive data in WebSocket URL parameters
- TLS prevents replay attacks at the transport layer

### Authentication — One-Time Registration Token

Node tokens use a **one-time registration** pattern. The token shown in the UI is only valid for the first connection:

```
1. Operator creates node in UI → gets a one-time install token
2. Node agent starts, connects WSS with install token
3. Control plane validates token, generates:
   - A long-lived session credential (random 256-bit key)
   - Stores hash of session credential in DB
4. Control plane sends session credential to node over the WSS connection
5. Node agent stores session credential locally (e.g. /etc/armada-node/credentials.json)
6. Install token is marked as used — cannot be reused
7. All subsequent connections use the session credential
```

If someone intercepts or leaks the install command after the node has registered, the token is already burned. Useless.

If the session credential is compromised, the operator can revoke it from the UI and the node re-registers with a new install token.

### Node Identity — Machine Fingerprint

On first registration, the node agent generates a **machine fingerprint** from stable hardware/system identifiers:

```typescript
// Fingerprint sources (combine what's available):
// - /etc/machine-id (Linux)
// - IOPlatformUUID (macOS)
// - Docker system info (engine ID)
// - CPU model + core count + total memory (fallback)

function generateFingerprint(): string {
  const sources: string[] = [];
  // Read /etc/machine-id if available
  try { sources.push(readFileSync('/etc/machine-id', 'utf8').trim()); } catch {}
  // Docker engine ID
  try { sources.push(dockerInfo.ID); } catch {}
  // Fallback hardware identifiers
  sources.push(`${os.cpus()[0]?.model}:${os.cpus().length}:${os.totalmem()}`);
  return createHash('sha256').update(sources.join('|')).digest('hex');
}
```

The fingerprint is sent during registration and stored in the DB. On reconnection, the control plane checks that the fingerprint matches. If a different machine tries to connect with a stolen session credential, the fingerprint won't match → connection rejected.

**Fingerprint mismatch handling:**
- Log a security event in the audit log
- Reject the connection with `NODE_IDENTITY_MISMATCH`
- Optionally notify the operator (Telegram alert)
- Operator must manually re-register the node if the hardware legitimately changed

### Token Rotation

Session credentials can be rotated without downtime:

```
1. Operator triggers "Rotate Credential" from UI (or automated schedule)
2. Control plane generates new session credential
3. Sends `credential.rotate` command to node over existing WSS
4. Node agent stores new credential, acknowledges
5. Control plane marks old credential as revoked
6. Next reconnection uses new credential
```

If the node is offline when rotation is triggered, the old credential stays valid until the node connects, receives the rotation command, and acknowledges.

### Authorisation
- Nodes can only execute commands from the control plane
- Nodes cannot send arbitrary commands to other nodes
- Control plane validates all commands before dispatching
- Instance-to-instance relay is authenticated — node agent verifies the source instance

### Instance Isolation
- Instances cannot bypass the gateway — no direct routes to control plane or other nodes
- Gateway authenticates instance identity before relaying
- Cross-node relay is authorised by the control plane (checks project membership, hierarchy rules)

### Threat Model Summary

| Threat | Mitigation |
|--------|-----------|
| Leaked install token | One-time use — burned after first registration |
| Stolen session credential | Machine fingerprint check rejects different hardware |
| Man-in-the-middle | WSS/TLS — encrypted, integrity-verified |
| Replay attack | TLS prevents at transport layer |
| Compromised node | Operator revokes credential, node goes offline immediately |
| Rogue control plane | Out of scope — if control plane is compromised, game over |
| Fingerprint spoofing | Attacker needs root on the exact same hardware — unlikely |

## Open Questions

1. **Non-Docker nodes**: Should node agents support running agents as processes (not containers)? Useful for Mac/Windows dev machines where Docker Desktop overhead is unwanted.
2. **Streaming**: Container logs and build output need streaming. WebSocket naturally supports this — just send chunks as they arrive.
3. **File transfers**: Plugin installs, skill installs, and credential files need to be pushed to nodes. Options: chunked binary over WebSocket, or have node agent pull from a URL provided by the control plane.
4. **Max message size**: WebSocket messages have practical limits (~16MB default in most implementations). Large file transfers may need chunking.
5. **Gateway protocol**: Should the local gateway proxy raw HTTP, or use a higher-level protocol? Raw HTTP is simplest — instances don't need any changes.

## Effort Estimate

~3-4 days:
- WebSocket server on control plane + connection manager
- WebSocket client on node agent + command handlers
- WsNodeClient implementing existing NodeClient interface
- Local HTTP gateway proxy on node agent
- Instance relay command + routing
- Install script (Docker-based)
- Remove HTTP server from node agent
- Update instance config generation to use gateway URL
