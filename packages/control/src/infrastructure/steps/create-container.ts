import type { StepHandler } from '../step-registry.js';
import { withRetry } from './retry.js';

export const createContainerHandler: StepHandler = {
  name: 'create_container',
  async execute(ctx) {
    const { nodeId, containerName, image, env, volumes, network, resources, labels, instanceId } = ctx.params;
    const node = ctx.services.nodeClient(nodeId);
    ctx.emit(`Creating container ${containerName}`, { containerName, image });
    await withRetry(
      () => node.createInstance(containerName, {
        image,
        env: env ?? [],
        volumes: volumes ?? {},
        resources: resources ?? { memory: '2g', cpus: '1' },
        network: network ?? 'armada-net',
        labels: labels ?? {},
      }),
      {
        onRetry: (attempt, err) =>
          ctx.emit(`Container create retry ${attempt}: ${err.message}`, { containerName, attempt }),
      },
    );
    ctx.emit(`Container created: ${containerName}`, { containerName });
  },
};
