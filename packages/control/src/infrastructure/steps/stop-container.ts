import type { StepHandler } from '../step-registry.js';

export const stopContainerHandler: StepHandler = {
  name: 'stop_container',
  async execute(ctx) {
    const { nodeId, containerName } = ctx.params;
    const node = ctx.services.nodeClient(nodeId);
    ctx.emit(`Stopping container ${containerName}`, { containerName });
    try {
      await node.stopContainer(containerName);
    } catch (err: any) {
      // 304 = already stopped, 404 = doesn't exist — both fine
      if (err?.message?.includes('304') || err?.message?.includes('already stopped') || err?.message?.includes('not running') || err?.message?.includes('404') || err?.message?.includes('no such container') || err?.message?.includes('No such container')) {
        ctx.emit(`Container ${containerName} already stopped or not found`, { containerName });
        return;
      }
      // Node unreachable — can't clean up container, but DB cleanup should proceed
      if (err?.message?.includes('not connected') || err?.message?.includes('WebSocket') || err?.message?.includes('timed out') || err?.code === 'ECONNREFUSED') {
        ctx.emit(`Warning: node unreachable, container ${containerName} may be orphaned`, { containerName });
        return;
      }
      throw err;
    }
    ctx.emit(`Container stopped: ${containerName}`, { containerName });
  },
};
