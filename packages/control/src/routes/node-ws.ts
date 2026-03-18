/**
 * node-ws.ts — WebSocket upgrade endpoint for node agent connections.
 *
 * GET /api/nodes/ws
 *
 * Node agents connect here to establish a persistent WSS connection.
 *
 * Authentication supports two modes (tried in order):
 *   1. Install token  — one-time bootstrap, issues a session credential
 *   2. Session credential — subsequent connections (bcrypt compare)
 *
 * The node must send:
 *   Authorization: Bearer <token-or-credential>
 *   X-Node-Fingerprint: <sha256-hex>   (required for session-credential mode)
 */

import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import { randomBytes } from 'crypto';
import bcrypt from 'bcrypt';
import { WebSocketServer, type WebSocket } from 'ws';
import { getDb } from '../db/index.js';
import { nodesRepo } from '../repositories/node-repo.js';
import { nodeConnectionManager } from '../ws/node-connections.js';
import { commandDispatcher } from '../ws/command-dispatcher.js';
import { eventBus } from '../infrastructure/event-bus.js';
import { parseMessage, serializeMessage } from '../ws/protocol.js';
import { isResponse, isEvent, isStream, isCommand, isProgress, WsErrorCode, isVersionCompatible } from '@coderage-labs/armada-shared';
import { handleGatewayProxyCommand } from '../ws/gateway-handler.js';
import { CONTROL_VERSION, PROTOCOL_VERSION, MIN_NODE_VERSION } from '../version.js';

const BCRYPT_COST = 10;

/** Singleton WSS instance (no HTTP server attached — we do the upgrade manually). */
const wss = new WebSocketServer({ noServer: true });

// ── Auth modes ────────────────────────────────────────────────────────────────

type AuthResult =
  | { ok: true; nodeId: string; hostname: string; mode: 'install' | 'session'; sessionCredential?: string }
  | { ok: false; statusCode: 401 | 403; reason: string };

/**
 * Authenticate a node connection attempt.
 * Returns auth result including the mode and — for install token auth — the
 * plain session credential to issue to the node.
 */
async function authenticateNode(token: string, fingerprint: string): Promise<AuthResult> {
  // ── Mode 1: install token ────────────────────────────────────────
  const byInstall = nodesRepo.findByInstallToken(token);
  if (byInstall) {
    // Generate a 32-byte random session credential (hex-encoded = 64 chars)
    const sessionCredential = randomBytes(32).toString('hex');
    const credentialHash = await bcrypt.hash(sessionCredential, BCRYPT_COST);

    // Store hash, burn the install token, record fingerprint
    nodesRepo.issueSessionCredential(byInstall.id, credentialHash, fingerprint);

    console.log(`[node-ws] Install token used for node ${byInstall.id} (${byInstall.hostname}), session credential issued`);
    return {
      ok: true,
      nodeId: byInstall.id,
      hostname: byInstall.hostname,
      mode: 'install',
      sessionCredential,
    };
  }

  // ── Mode 2: session credential (bcrypt compare) ──────────────────
  if (token.length === 64) {
    // Only try bcrypt if it looks like a hex credential (64 chars)
    const candidates = nodesRepo.getAllWithCredentials();
    for (const candidate of candidates) {
      if (!candidate.sessionCredentialHash) continue;
      const matches = await bcrypt.compare(token, candidate.sessionCredentialHash);
      if (matches) {
        // Verify fingerprint
        if (candidate.fingerprint && fingerprint && candidate.fingerprint !== fingerprint) {
          // Log audit entry for identity mismatch
          try {
            const db = getDb();
            db.prepare(`
              INSERT INTO audit_log (id, caller_type, action, resource_type, resource_id, detail)
              VALUES (?, 'system', 'node.identity_mismatch', 'node', ?, ?)
            `).run(
              crypto.randomUUID(),
              candidate.id,
              `Fingerprint mismatch: expected ${candidate.fingerprint}, got ${fingerprint}`,
            );
          } catch (err: any) { console.warn('[node-ws] Failed to log fingerprint mismatch event:', err.message); }
          return { ok: false, statusCode: 403, reason: WsErrorCode.NODE_IDENTITY_MISMATCH };
        }
        return { ok: true, nodeId: candidate.id, hostname: candidate.hostname, mode: 'session' };
      }
    }
  }

  return { ok: false, statusCode: 403, reason: 'Invalid token' };
}

/**
 * Update node status in the DB.
 */
function setNodeStatus(nodeId: string, status: 'online' | 'offline'): void {
  const db = getDb();
  db.prepare(
    "UPDATE nodes SET status = ?, last_seen = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
  ).run(status, nodeId);
}

/**
 * Handle an incoming HTTP upgrade request for the WebSocket endpoint.
 * Call this from the HTTP server's `upgrade` event.
 */
export function handleNodeWsUpgrade(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): void {
  // Only handle the node WS path
  const url = request.url ?? '';
  if (!url.startsWith('/api/nodes/ws')) {
    socket.destroy();
    return;
  }

  // Extract Bearer token from Authorization header
  const authHeader = request.headers['authorization'] ?? '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  const token = match[1].trim();
  const fingerprint = (request.headers['x-node-fingerprint'] as string | undefined) ?? '';

  // Auth is async — handle upgrade inside the promise
  authenticateNode(token, fingerprint)
    .then((result) => {
      if (!result.ok) {
        socket.write(`HTTP/1.1 ${result.statusCode} ${result.reason}\r\n\r\n`);
        socket.destroy();
        return;
      }

      wss.handleUpgrade(request, socket, head, (ws: WebSocket) => {
        wss.emit('connection', ws, request, result);
      });
    })
    .catch((err) => {
      console.error('[node-ws] Auth error:', err);
      socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
      socket.destroy();
    });
}

// Handle authenticated connections
wss.on('connection', (ws: WebSocket, _request: IncomingMessage, auth: Extract<AuthResult, { ok: true }>) => {
  const { nodeId, hostname, mode, sessionCredential } = auth;

  // Register with connection manager
  nodeConnectionManager.register(nodeId, ws);

  // Update DB status
  setNodeStatus(nodeId, 'online');

  console.log(`[node-ws] Node ${nodeId} (${hostname}) connected via ${mode} auth`);

  // If install token was used, issue the session credential immediately
  if (mode === 'install' && sessionCredential) {
    const issuedMsg = {
      type: 'command' as const,
      id: crypto.randomUUID(),
      action: 'credential.issued',
      params: {
        nodeId,
        sessionCredential,
      },
      timeout: 10_000,
    };
    ws.send(JSON.stringify(issuedMsg));
  }

  ws.on('message', (data: Buffer | string) => {
    const raw = typeof data === 'string' ? data : data.toString('utf8');
    const msg = parseMessage(raw);
    if (!msg) {
      console.warn(`[node-ws] Received invalid message from node ${nodeId}`);
      return;
    }

    if (isResponse(msg)) {
      commandDispatcher.handleResponse(msg);
      return;
    }

    if (isStream(msg)) {
      commandDispatcher.handleStream(msg);
      return;
    }

    if (isProgress(msg)) {
      // Dispatch to any pending command's progress callback (e.g. logs.stream)
      commandDispatcher.handleProgress(msg);

      // Forward progress events to the SSE event bus so UI clients receive live updates.
      // The commandId links this progress to the originating operation command.
      eventBus.emit('operation.progress', {
        nodeId,
        commandId: msg.id,
        ...msg.data,
      });
      return;
    }

    if (isEvent(msg)) {
      if (msg.event === 'heartbeat') {
        nodeConnectionManager.handleHeartbeat(nodeId, msg.data as any);
        return;
      }

      if (msg.event === 'node.hello' && msg.data) {
        const { nodeVersion, protocolVersion, minControlVersion } = msg.data as {
          nodeVersion?: string;
          protocolVersion?: number;
          minControlVersion?: string;
        };

        // Store version info on the connection manager
        nodeConnectionManager.setNodeVersion(nodeId, {
          version: nodeVersion ?? 'unknown',
          protocolVersion: protocolVersion ?? 0,
          compatible: nodeVersion ? isVersionCompatible(nodeVersion, MIN_NODE_VERSION) : false,
        });

        // Check if this node requires a newer control plane
        if (minControlVersion && !isVersionCompatible(CONTROL_VERSION, minControlVersion)) {
          console.warn(`[node-ws] Node ${nodeId} requires control plane >= ${minControlVersion} (running ${CONTROL_VERSION})`);
        }

        // Check protocol version match
        if (protocolVersion !== undefined && protocolVersion !== PROTOCOL_VERSION) {
          console.warn(`[node-ws] Node ${nodeId} protocol version ${protocolVersion} differs from control ${PROTOCOL_VERSION}`);
        }

        console.log(`[node-ws] Node ${nodeId} version: ${nodeVersion} (protocol v${protocolVersion})`);
        return;
      }

      if (msg.event === 'node.stats' && msg.data) {
        // Cache the stats snapshot on the connection manager
        const { nodeId: _nid, ...stats } = msg.data as Record<string, unknown>;
        nodeConnectionManager.updateLiveStats(nodeId, stats);

        // Forward to the SSE event bus so UI clients receive live updates
        eventBus.emit('node.stats', { nodeId, ...stats });
        return;
      }

      if (msg.event === 'instance.event' && msg.data) {
        // An OpenClaw instance event forwarded by the node agent.
        // Re-emit on the event bus with a namespaced key so SSE clients can filter.
        const instanceEvent = msg.data as {
          instanceId?: string;
          instanceName?: string;
          eventType?: string;
          [key: string]: unknown;
        };
        const instanceName = instanceEvent.instanceName ?? instanceEvent.instanceId ?? 'unknown';
        const eventType = instanceEvent.eventType ?? 'unknown';
        const busKey = `instance.${instanceName}.${eventType}`;
        eventBus.emit(busKey, { nodeId, ...instanceEvent });
        return;
      }

      // Other events can be handled here or emitted onto the event bus in future
      return;
    }

    // Handle commands sent FROM the node TO the control plane (e.g. gateway.proxy)
    if (isCommand(msg)) {
      if (msg.action === 'gateway.proxy') {
        handleGatewayProxyCommand(msg).then((response) => {
          if (ws.readyState === ws.OPEN) {
            ws.send(serializeMessage(response));
          }
        }).catch((err) => {
          const errorResponse = {
            type: 'response' as const,
            id: msg.id,
            status: 'error' as const,
            error: err instanceof Error ? err.message : String(err),
            code: 'UNKNOWN',
          };
          if (ws.readyState === ws.OPEN) {
            ws.send(serializeMessage(errorResponse));
          }
        });
        return;
      }
      console.warn(`[node-ws] Unhandled command '${msg.action}' from node ${nodeId}`);
      return;
    }

    console.warn(`[node-ws] Unexpected message type from node ${nodeId}`);
  });

  ws.on('close', () => {
    nodeConnectionManager.unregister(nodeId);
    setNodeStatus(nodeId, 'offline');
  });

  ws.on('error', (err: Error) => {
    console.error(`[node-ws] WebSocket error for node ${nodeId}:`, err.message);
  });
});
