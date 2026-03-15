import type { StepHandler } from '../step-registry.js';

/**
 * container_upgrade step — pulls a new image tag and recreates the container.
 * Used by the changeset pipeline for deploy/update-image.
 */
export const containerUpgradeHandler: StepHandler = {
  name: 'container_upgrade',
  async execute(ctx) {
    const { nodeId, containerName, tag = 'latest' } = ctx.params as {
      nodeId: string;
      containerName: string;
      tag?: string;
    };
    const node = ctx.services.nodeClient(nodeId);
    ctx.emit(`Upgrading container ${containerName} to tag ${tag}`, { containerName, tag });
    await node.upgradeInstance(containerName, { tag });
    ctx.emit(`Container upgraded: ${containerName} → ${tag}`, { containerName, tag });
  },
};
