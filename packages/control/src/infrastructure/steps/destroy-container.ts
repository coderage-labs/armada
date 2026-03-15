import type { StepHandler } from '../step-registry.js';

export const destroyContainerHandler: StepHandler = {
  name: 'destroy_container',
  async execute(ctx) {
    const { nodeId, containerName } = ctx.params;
    const node = ctx.services.nodeClient(nodeId);
    ctx.emit(`Destroying container ${containerName}`, { containerName });
    try {
      await node.removeContainer(containerName);
    } catch (err: any) {
      // 404 = already gone — that's fine
      if (err?.message?.includes('404') || err?.message?.includes('no such container') || err?.message?.includes('No such container')) {
        ctx.emit(`Container ${containerName} already removed`, { containerName });
        return;
      }
      // Node unreachable — can't clean up container, but DB cleanup should proceed
      if (err?.message?.includes('not connected') || err?.message?.includes('WebSocket') || err?.message?.includes('timed out') || err?.code === 'ECONNREFUSED') {
        ctx.emit(`Warning: node unreachable, container ${containerName} may be orphaned`, { containerName });
        return;
      }
      throw err;
    }
    ctx.emit(`Container destroyed: ${containerName}`, { containerName });
  },
};
