/**
 * events.ts — Instance event relay handler.
 *
 * Connects to a running OpenClaw instance's SSE event stream and forwards
 * relevant events to the control plane as `EventMessage` payloads over the
 * existing WS tunnel.
 *
 * Architecture:
 *   Instance (OpenClaw SSE) → Node Agent → EventMessage (WS) → Control Plane
 *
 * Subscriptions are lazy: the control plane requests them via `events.subscribe`.
 * The node only opens an SSE connection when asked to.
 */

import WebSocket from 'ws';
import type { EventMessage, InstanceEvent } from '@coderage-labs/armada-shared';

// ── Config ────────────────────────────────────────────────────────────────────

const INSTANCE_PORT = parseInt(process.env.INSTANCE_PORT ?? '18789', 10);
const SSE_RECONNECT_DELAY_MS = 5_000;
const SSE_PATH = '/api/events';

/** Event types from instance SSE that we forward to the control plane. */
const RELAY_EVENTS = new Set([
  'session.message',
  'session.tool_call',
  'agent.status',
  'heartbeat',
]);

// ── State ─────────────────────────────────────────────────────────────────────

interface InstanceSubscription {
  instanceId: string;
  instanceName: string;
  containerHostname: string;
  /** AbortController used to cancel the current SSE fetch */
  abortController: AbortController | null;
  /** Reconnect timer handle */
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  /** Whether this subscription is still wanted (false = unsubscribed) */
  active: boolean;
}

/** Map of instanceId → subscription state */
const subscriptions = new Map<string, InstanceSubscription>();

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Subscribe to instance events. Opens an SSE connection to the instance and
 * forwards events through the WS `socket`. Reconnects automatically on drop.
 *
 * @param instanceId     Control-plane instance ID (used as event key)
 * @param instanceName   Human-readable instance name
 * @param containerHostname  Docker hostname of the container
 * @param socket         The WS connection to the control plane
 */
export function subscribeToInstanceEvents(
  instanceId: string,
  instanceName: string,
  containerHostname: string,
  socket: WebSocket,
): void {
  // Unsubscribe any existing subscription for this instance first
  unsubscribeFromInstanceEvents(instanceId);

  const sub: InstanceSubscription = {
    instanceId,
    instanceName,
    containerHostname,
    abortController: null,
    reconnectTimer: null,
    active: true,
  };

  subscriptions.set(instanceId, sub);
  console.log(`[events] Subscribing to instance ${instanceName} (${instanceId})`);
  connectSSE(sub, socket);
}

/**
 * Unsubscribe from instance events. Closes the SSE connection and cancels any
 * pending reconnect.
 */
export function unsubscribeFromInstanceEvents(instanceId: string): void {
  const sub = subscriptions.get(instanceId);
  if (!sub) return;

  sub.active = false;
  sub.abortController?.abort();
  if (sub.reconnectTimer !== null) {
    clearTimeout(sub.reconnectTimer);
    sub.reconnectTimer = null;
  }

  subscriptions.delete(instanceId);
  console.log(`[events] Unsubscribed from instance ${sub.instanceName} (${instanceId})`);
}

/**
 * Unsubscribe from ALL instance event streams. Called on WS disconnect so we
 * don't accumulate dangling SSE connections.
 */
export function unsubscribeAll(): void {
  for (const instanceId of subscriptions.keys()) {
    unsubscribeFromInstanceEvents(instanceId);
  }
}

// ── SSE connection logic ──────────────────────────────────────────────────────

function connectSSE(sub: InstanceSubscription, socket: WebSocket): void {
  if (!sub.active) return;

  const url = `http://${sub.containerHostname}:${INSTANCE_PORT}${SSE_PATH}`;
  const ac = new AbortController();
  sub.abortController = ac;

  // We use the native fetch API (Node 18+) which supports SSE over streaming body
  fetch(url, {
    signal: ac.signal,
    headers: { Accept: 'text/event-stream' },
  })
    .then(async (response) => {
      if (!response.ok || !response.body) {
        throw new Error(`SSE connect failed: ${response.status} ${response.statusText}`);
      }

      console.log(`[events] SSE connected to ${sub.instanceName} at ${url}`);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (sub.active) {
        let result: ReadableStreamReadResult<Uint8Array>;
        try {
          result = await reader.read();
        } catch (readErr: any) {
          if (!sub.active || ac.signal.aborted) return; // intentional close
          throw readErr;
        }

        if (result.done) break;

        buffer += decoder.decode(result.value, { stream: true });

        // SSE messages are separated by double newlines
        const parts = buffer.split('\n\n');
        buffer = parts.pop() ?? '';

        for (const part of parts) {
          const event = parseSSEEvent(part);
          if (event) {
            maybeForwardEvent(sub, event, socket);
          }
        }
      }
    })
    .catch((err: Error) => {
      if (!sub.active || ac.signal.aborted) return; // intentional — don't reconnect
      console.warn(`[events] SSE stream error for ${sub.instanceName}: ${err.message}`);
      scheduleReconnect(sub, socket);
    });
}

function scheduleReconnect(sub: InstanceSubscription, socket: WebSocket): void {
  if (!sub.active) return;
  console.log(`[events] Reconnecting to ${sub.instanceName} in ${SSE_RECONNECT_DELAY_MS}ms`);
  sub.reconnectTimer = setTimeout(() => {
    sub.reconnectTimer = null;
    if (sub.active) connectSSE(sub, socket);
  }, SSE_RECONNECT_DELAY_MS);
}

// ── SSE parsing ───────────────────────────────────────────────────────────────

interface ParsedSSEEvent {
  event?: string;
  data?: string;
  id?: string;
}

function parseSSEEvent(raw: string): ParsedSSEEvent | null {
  const lines = raw.split('\n');
  const result: ParsedSSEEvent = {};

  for (const line of lines) {
    if (line.startsWith(':')) continue; // comment
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const field = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trimStart();
    if (field === 'event') result.event = value;
    else if (field === 'data') result.data = value;
    else if (field === 'id') result.id = value;
  }

  // An SSE block must have at least a data line to be meaningful
  return result.data !== undefined ? result : null;
}

// ── Event forwarding ──────────────────────────────────────────────────────────

function maybeForwardEvent(
  sub: InstanceSubscription,
  sseEvent: ParsedSSEEvent,
  socket: WebSocket,
): void {
  const eventType = sseEvent.event ?? 'message';

  // Filter: only forward relevant event types
  if (!RELAY_EVENTS.has(eventType)) return;

  // Parse the JSON data payload
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(sseEvent.data ?? '{}') as Record<string, unknown>;
  } catch {
    data = { raw: sseEvent.data };
  }

  const instanceEvent: InstanceEvent = {
    instanceId: sub.instanceId,
    instanceName: sub.instanceName,
    agentName: (data.agentName as string | undefined) ?? (data.agent as string | undefined),
    eventType,
    data,
    timestamp: new Date().toISOString(),
  };

  const msg: EventMessage = {
    type: 'event',
    event: 'instance.event',
    data: instanceEvent as unknown as Record<string, unknown>,
    timestamp: instanceEvent.timestamp,
  };

  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(msg));
  }
}
