import type { StepHandler } from '../step-registry.js';

export const startContainerHandler: StepHandler = {
  name: 'start_container',
  async execute(ctx) {
    const { nodeId, containerName } = ctx.params;
    const node = ctx.services.nodeClient(nodeId);
    ctx.emit(`Starting container ${containerName}`, { containerName });
    try {
      await node.startContainer(containerName);
    } catch (err: any) {
      // 304 = already started — that's fine
      if (err?.message?.includes('304') || err?.message?.includes('already started')) {
        ctx.emit(`Container ${containerName} already running`, { containerName });
        return;
      }
      throw err;
    }
    ctx.emit(`Container started: ${containerName}`, { containerName });
  },
};
