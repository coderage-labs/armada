import type { StepHandler } from '../step-registry.js';

export const restartGatewayHandler: StepHandler = {
  name: 'restart_gateway',
  async execute(ctx) {
    const { nodeId, containerName } = ctx.params;
    const node = ctx.services.nodeClient(nodeId);
    ctx.emit(`Sending SIGUSR1 to ${containerName}`, { containerName });
    await node.signalContainer(containerName, 'SIGUSR1');
    // Give the gateway a moment to begin its restart cycle
    await new Promise(r => setTimeout(r, 1000));
    ctx.emit(`Gateway reload signal sent: ${containerName}`, { containerName });
  },
};
