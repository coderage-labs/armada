/**
 * node-client.ts — WebSocket-based node client (WP7).
 *
 * Re-exports WsNodeClient as the canonical NodeClient interface.
 * The HTTP-based NodeClient has been removed; all node communication
 * now goes through the WebSocket command dispatcher.
 *
 * Factory function uses the first connected node (single-node default)
 * or a specified nodeId.
 */

export { WsNodeClient as NodeClient } from './ws-node-client.js';
export { WsNodeClient } from './ws-node-client.js';
import { WsNodeClient } from './ws-node-client.js';
import { nodeConnectionManager } from '../ws/node-connections.js';

/** Get a WsNodeClient for a specific node ID. */
export function getNodeClient(nodeId?: string): WsNodeClient {
  if (nodeId) {
    return new WsNodeClient(nodeId);
  }

  // Default: use the first connected node
  const firstId = nodeConnectionManager.connections.keys().next().value as string | undefined;
  if (firstId) {
    return new WsNodeClient(firstId);
  }

  // Fallback: if no live connections yet, try to get from env/DB
  const fallbackId = process.env.ARMADA_DEFAULT_NODE_ID || 'default';
  return new WsNodeClient(fallbackId);
}

/** Reset singleton state (no-op now, kept for test compatibility). */
export function resetNodeClient(): void {
  // No-op: WsNodeClient instances are stateless (rely on commandDispatcher)
}
