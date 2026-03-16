import WebSocket from 'ws';
import { randomUUID } from 'crypto';
import { unlinkSync, existsSync } from 'node:fs';
import type { EventMessage, CommandMessage, ResponseMessage } from '@coderage-labs/armada-shared';
import { handleCommand } from './command-handler.js';
import { loadCredentials, saveCredentials, CREDENTIALS_PATH } from '../credentials.js';
import { getMachineFingerprint } from '../fingerprint.js';
import { NODE_VERSION, PROTOCOL_VERSION, MIN_CONTROL_VERSION } from '../version.js';

// ── Config ────────────────────────────────────────────────────────────────────

const CONTROL_URL = process.env.ARMADA_CONTROL_URL ?? '';
/** Install token — only used on first connection if no credentials file exists */
const ARMADA_NODE_TOKEN = process.env.ARMADA_NODE_TOKEN ?? '';

const HEARTBEAT_INTERVAL_MS = 30_000;
const PING_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 10_000;
const BACKOFF_STEPS = [1000, 2000, 4000, 8000, 16000, 32000, 60000];

/** Number of consecutive 403 failures before falling back to install token */
const MAX_SESSION_AUTH_FAILURES = 3;

// ── State ─────────────────────────────────────────────────────────────────────

let ws: WebSocket | null = null;
let reconnectAttempt = 0;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;
let pongTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let cachedFingerprint: string | null = null;

/** Track consecutive 403 failures when using session credentials */
let sessionAuthFailureCount = 0;

// Pending commands sent by the node to the control plane (awaiting responses)
interface PendingCommand {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
const pendingCommands: Map<string, PendingCommand> = new Map();

// ── Exports ───────────────────────────────────────────────────────────────────

export function getWsConnection(): WebSocket | null {
  return ws;
}

/**
 * Send a command to the control plane and await the response.
 * Used by the gateway proxy to forward instance requests upstream.
 */
export async function sendCommandToControl(
  action: string,
  params: Record<string, unknown>,
  timeoutMs = 30_000,
): Promise<unknown> {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    throw new Error('Not connected to control plane');
  }

  const id = randomUUID();

  return new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingCommands.delete(id);
      reject(new Error(`Command ${action} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    pendingCommands.set(id, { resolve, reject, timer });

    const msg: CommandMessage = {
      type: 'command',
      id,
      action,
      params,
      timeout: timeoutMs,
    };

    ws!.send(JSON.stringify(msg), (err) => {
      if (err) {
        clearTimeout(timer);
        pendingCommands.delete(id);
        reject(err);
      }
    });
  });
}

export function connectToControlPlane(): void {
  if (!CONTROL_URL) {
    console.warn('[ws] ARMADA_CONTROL_URL not set — WebSocket client disabled');
    return;
  }
  // Warm up fingerprint cache before first connect
  getMachineFingerprint()
    .then((fp) => {
      cachedFingerprint = fp;
      connect();
    })
    .catch(() => {
      connect();
    });
}

// ── Internal ──────────────────────────────────────────────────────────────────

/**
 * Determine the auth token for the current connection attempt.
 * - If a credentials file exists: use the session credential
 * - Otherwise: use the install token from env
 */
function getAuthToken(): { token: string; nodeId: string | null } {
  const creds = loadCredentials();
  if (creds?.sessionCredential) {
    return { token: creds.sessionCredential, nodeId: creds.nodeId };
  }
  return { token: ARMADA_NODE_TOKEN, nodeId: null };
}

function connect(): void {
  if (ws) {
    ws.removeAllListeners();
    ws.terminate();
    ws = null;
  }

  const { token, nodeId } = getAuthToken();

  console.log(`[ws] Connecting to ${CONTROL_URL} (attempt ${reconnectAttempt + 1}, mode: ${nodeId ? 'session' : 'install-token'})`);

  const headers: Record<string, string> = {};
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  if (cachedFingerprint) {
    headers['X-Node-Fingerprint'] = cachedFingerprint;
  }

  ws = new WebSocket(CONTROL_URL, { headers });

  ws.on('open', onOpen);
  ws.on('message', onMessage);
  ws.on('pong', onPong);
  ws.on('close', onClose);
  ws.on('error', onError);
  ws.on('unexpected-response', (req, res) => onUnexpectedResponse(req, res, nodeId));
}

function onOpen(): void {
  console.log('[ws] Connected to control plane ✓');
  reconnectAttempt = 0;
  // Reset session auth failure count on successful connection
  sessionAuthFailureCount = 0;
  startHeartbeat();
  startPing();

  // Send version info on connect
  const hello: EventMessage = {
    type: 'event',
    event: 'node.hello',
    data: {
      nodeVersion: NODE_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      minControlVersion: MIN_CONTROL_VERSION,
    },
    timestamp: new Date().toISOString(),
  };
  ws?.send(JSON.stringify(hello));
}

function onMessage(raw: WebSocket.RawData): void {
  const text = raw.toString();
  try {
    const parsed = JSON.parse(text) as unknown as ResponseMessage;

    // Handle responses to commands we sent upstream (e.g. gateway.proxy responses)
    if (parsed?.type === 'response') {
      const msg = parsed;
      const pending = pendingCommands.get(msg.id);
      if (pending) {
        clearTimeout(pending.timer);
        pendingCommands.delete(msg.id);
        if (msg.status === 'ok') {
          pending.resolve(msg.data);
        } else {
          pending.reject(new Error(msg.error ?? 'Command failed'));
        }
        return;
      }
      // No pending command — fall through (shouldn't happen but handle gracefully)
    }

    // Handle commands from the control plane (including credential.issued / credential.rotate)
    handleCommand(parsed as unknown as import('@coderage-labs/armada-shared').WsMessage, ws!);
  } catch (err) {
    console.error('[ws] Failed to parse incoming message:', err);
  }
}

function onPong(): void {
  // Pong received — connection is alive, cancel the timeout
  if (pongTimeoutTimer !== null) {
    clearTimeout(pongTimeoutTimer);
    pongTimeoutTimer = null;
  }
}

function onClose(code: number, reason: Buffer): void {
  console.warn(`[ws] Disconnected (code=${code} reason=${reason.toString() || 'none'})`);
  stopHeartbeat();
  stopPing();
  scheduleReconnect();
}

function onError(err: Error): void {
  console.warn('[ws] Connection error:', err.message);
  // close event fires after error — reconnect handled there
}

function onUnexpectedResponse(
  _req: import('http').ClientRequest,
  res: import('http').IncomingMessage,
  nodeId: string | null,
): void {
  console.warn(`[ws] Unexpected HTTP response: ${res.statusCode} ${res.statusMessage}`);

  // If we got a 403 and we were using session credentials, track it
  if (res.statusCode === 403 && nodeId !== null) {
    sessionAuthFailureCount++;
    console.warn(`[ws] Session credential rejected (${sessionAuthFailureCount}/${MAX_SESSION_AUTH_FAILURES} failures)`);

    if (sessionAuthFailureCount >= MAX_SESSION_AUTH_FAILURES) {
      console.warn(
        `[ws] Max session auth failures reached — credentials may be stale (e.g., control DB wiped). ` +
        `Falling back to install token mode.`
      );

      // Delete the stale credentials file to trigger fallback to install token
      try {
        if (existsSync(CREDENTIALS_PATH)) {
          unlinkSync(CREDENTIALS_PATH);
          console.log(`[ws] Deleted stale credentials file: ${CREDENTIALS_PATH}`);
        }
        // Reset counter so we don't immediately fall back again if install token also fails
        sessionAuthFailureCount = 0;
      } catch (err) {
        console.error(`[ws] Failed to delete credentials file: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // Drain the response body to avoid hanging
  res.resume();
}

// ── Heartbeat ─────────────────────────────────────────────────────────────────

function startHeartbeat(): void {
  stopHeartbeat();
  // nodeId from credentials (may be null on install-token connect until credential.issued is handled)
  const creds = loadCredentials();
  const nodeId = creds?.nodeId ?? randomUUID();

  heartbeatTimer = setInterval(async () => {
    if (ws?.readyState !== WebSocket.OPEN) return;
    // Collect armada container statuses
    let containers: Array<{ name: string; state: string; status: string }> = [];
    try {
      const { docker } = await import('../docker/client.js');
      const list = await docker.listContainers({ all: true, filters: { name: ['armada-instance-'] } });
      containers = list.map(c => ({
        name: (c.Names?.[0] || '').replace(/^\//, ''),
        state: c.State || 'unknown',
        status: c.Status || '',
      }));
    } catch { /* Docker not available — fine, just skip */ }

    const msg: EventMessage = {
      type: 'event',
      event: 'heartbeat',
      data: { nodeId, containers },
      timestamp: new Date().toISOString(),
    };
    ws.send(JSON.stringify(msg));
  }, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat(): void {
  if (heartbeatTimer !== null) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

// ── Ping/Pong keepalive ───────────────────────────────────────────────────────

/**
 * Send a WebSocket-protocol-level ping every PING_INTERVAL_MS.
 * If no pong is received within PONG_TIMEOUT_MS, the connection is considered
 * stale (silently dropped TCP) and we terminate to trigger reconnect.
 */
function startPing(): void {
  stopPing();
  pingTimer = setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    // Start pong timeout — cancelled in onPong if pong arrives
    pongTimeoutTimer = setTimeout(() => {
      console.warn('[ws] Pong timeout — connection appears stale, terminating');
      pongTimeoutTimer = null;
      ws?.terminate();
    }, PONG_TIMEOUT_MS);

    ws.ping();
  }, PING_INTERVAL_MS);
}

function stopPing(): void {
  if (pingTimer !== null) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
  if (pongTimeoutTimer !== null) {
    clearTimeout(pongTimeoutTimer);
    pongTimeoutTimer = null;
  }
}

// ── Reconnect ─────────────────────────────────────────────────────────────────

function scheduleReconnect(): void {
  if (reconnectTimer !== null) return;
  const delay = BACKOFF_STEPS[Math.min(reconnectAttempt, BACKOFF_STEPS.length - 1)];
  console.log(`[ws] Reconnecting in ${delay / 1000}s...`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectAttempt++;
    connect();
  }, delay);
}
