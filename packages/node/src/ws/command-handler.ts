import WebSocket from 'ws';
import {
  isCommand,
  type WsMessage,
  type CommandMessage,
  type ResponseMessage,
  type ProgressMessage,
} from '@coderage-labs/armada-shared';
import { handleContainerCommand, type ContainerHandlerContext } from '../handlers/containers.js';
import { handleFileCommand } from '../handlers/files.js';
import { handleNetworkCommand } from '../handlers/network.js';
import { handlePluginCommand } from '../handlers/plugins.js';
import { handleSystemCommand } from '../handlers/system.js';
import { handleToolCommand } from '../handlers/tools.js';
import { handleRelayCommand } from '../handlers/relay.js';
import { handleLogsCommand, type LogsHandlerContext } from '../handlers/logs.js';
import { loadCredentials, saveCredentials, CREDENTIALS_PATH } from '../credentials.js';
import { IdempotencyCache } from './idempotency-cache.js';

const idempotencyCache = new IdempotencyCache();

// Prune expired entries every 5 minutes
setInterval(() => idempotencyCache.prune(), 5 * 60 * 1000).unref();

// ── Read-only commands that should NOT be cached ──────────────────────────────
// These always return fresh data and must not be deduplicated.
const NON_IDEMPOTENT_ACTIONS = new Set([
  'node.health',
  'node.stats',
  'node.info',
  'node.statsHistory',
  'node.capacity',
  'node.logs',
  'container.stats',
  'container.logs',
  'container.inspect',
  'container.list',
  'file.read',
  'file.list',
  'plugin.list',
  'logs.stream',
]);

// ── Command router ────────────────────────────────────────────────────────────

export function handleCommand(msg: WsMessage, socket: WebSocket): void {
  if (!isCommand(msg)) return; // ignore non-command messages

  // Skip cache for read-only commands
  if (!NON_IDEMPOTENT_ACTIONS.has(msg.action)) {
    // Check idempotency cache
    const cached = idempotencyCache.get(msg.id);
    if (cached) {
      console.log(`[idempotency] Cache hit for command ${msg.id} (${msg.action})`);
      if (cached.code !== 'IN_FLIGHT' && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(cached));
      }
      return;
    }

    // Mark as in-flight
    idempotencyCache.markInFlight(msg.id);
  }

  const sendProgress = (progressMsg: ProgressMessage): void => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(progressMsg));
    }
  };

  route(msg, { sendProgress }).then((response) => {
    // Cache the response
    if (!NON_IDEMPOTENT_ACTIONS.has(msg.action)) {
      idempotencyCache.set(msg.id, response);
    }
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(response));
    }
  }).catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    const response: ResponseMessage = {
      type: 'response',
      id: msg.id,
      status: 'error',
      error: message,
      code: 'UNKNOWN',
    };
    // Cache error responses too — prevents retry of known failures
    if (!NON_IDEMPOTENT_ACTIONS.has(msg.action)) {
      idempotencyCache.set(msg.id, response);
    }
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(response));
    }
  });
}

async function route(msg: CommandMessage, ctx?: ContainerHandlerContext & LogsHandlerContext): Promise<ResponseMessage> {
  try {
    const { action } = msg;

    if (action === 'credential.issued') return handleCredentialIssued(msg);
    if (action === 'credential.rotate') return handleCredentialRotate(msg);

    if (action.startsWith('container.')) return await handleContainerCommand(msg, ctx);
    if (action.startsWith('image.')) return await handleContainerCommand({ ...msg, action: `container.${action.split('.')[1]}` }, ctx);
    if (action.startsWith('file.')) return await handleFileCommand(msg);
    if (action.startsWith('network.')) return await handleNetworkCommand(msg);
    if (action.startsWith('plugin.') || action.startsWith('skill.')) return await handlePluginCommand(msg);
    if (action.startsWith('node.')) return await handleSystemCommand(msg);
    if (action.startsWith('tool.')) return await handleToolCommand(msg);
    if (action === 'instance.relay') return await handleRelayCommand(msg);
    if (action.startsWith('logs.')) return await handleLogsCommand(msg, ctx);

    return {
      type: 'response',
      id: msg.id,
      status: 'error',
      error: `Unknown action: ${action}`,
      code: 'UNKNOWN',
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      type: 'response',
      id: msg.id,
      status: 'error',
      error: message,
      code: 'UNKNOWN',
    };
  }
}

// ── Credential handlers ───────────────────────────────────────────────────────

/**
 * credential.issued — control plane has issued a new session credential after
 * a successful install-token connection. Save it to disk for future reconnects.
 */
function handleCredentialIssued(msg: CommandMessage): ResponseMessage {
  const { nodeId, sessionCredential } = msg.params as {
    nodeId: string;
    sessionCredential: string;
  };

  if (!nodeId || !sessionCredential) {
    return {
      type: 'response',
      id: msg.id,
      status: 'error',
      error: 'credential.issued: missing nodeId or sessionCredential',
      code: 'UNKNOWN',
    };
  }

  const controlUrl = process.env.ARMADA_CONTROL_URL ?? '';
  saveCredentials({ nodeId, sessionCredential, controlUrl });
  console.log(`[ws] Session credential saved to ${CREDENTIALS_PATH} (nodeId=${nodeId})`);

  return { type: 'response', id: msg.id, status: 'ok', data: { ack: true } };
}

/**
 * credential.rotate — control plane is rotating the session credential.
 * Save the new credential and acknowledge. The next reconnect will use it.
 */
function handleCredentialRotate(msg: CommandMessage): ResponseMessage {
  const { sessionCredential } = msg.params as { sessionCredential: string };

  if (!sessionCredential) {
    return {
      type: 'response',
      id: msg.id,
      status: 'error',
      error: 'credential.rotate: missing sessionCredential',
      code: 'UNKNOWN',
    };
  }

  const existing = loadCredentials();
  if (!existing) {
    return {
      type: 'response',
      id: msg.id,
      status: 'error',
      error: 'credential.rotate: no existing credentials to rotate',
      code: 'UNKNOWN',
    };
  }

  saveCredentials({ ...existing, sessionCredential });
  console.log(`[ws] Session credential rotated (nodeId=${existing.nodeId})`);

  return { type: 'response', id: msg.id, status: 'ok', data: { ack: true } };
}
