// ── Disconnect Node Step — close WS connection to node agent ──

import { nodeConnectionManager } from '../../ws/node-connections.js';
import type { StepHandler } from '../step-registry.js';

export const disconnectNodeHandler: StepHandler = {
  name: 'disconnect_node',
  async execute(ctx) {
    const { nodeId } = ctx.params;
    ctx.emit(`Disconnecting node ${nodeId} WS connection`);

    const conn = nodeConnectionManager.connections.get(nodeId);
    if (conn) {
      try {
        conn.ws.close(1000, 'Node removed');
      } catch (err: any) {
        console.warn('[disconnect-node] ws.close failed:', err.message);
      }
      nodeConnectionManager.unregister(nodeId);
      ctx.emit(`Node ${nodeId} disconnected`);
    } else {
      ctx.emit(`Node ${nodeId} was not connected — skipping disconnect`);
    }
  },
};
