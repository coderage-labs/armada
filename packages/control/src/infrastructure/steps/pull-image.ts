import type { StepHandler } from '../step-registry.js';
import { withRetry } from './retry.js';

export const pullImageHandler: StepHandler = {
  name: 'pull_image',
  async execute(ctx) {
    const { nodeId, image } = ctx.params;
    const node = ctx.services.nodeClient(nodeId);
    ctx.emit(`Pulling image ${image}`, { image, nodeId });
    try {
      await withRetry(() => node.pullImage(image), {
        onRetry: (attempt, err) =>
          ctx.emit(`Pull retry ${attempt}: ${err.message}`, { image, attempt, warning: err.message }),
      });
      ctx.emit(`Image pulled: ${image}`, { image });
    } catch (err: any) {
      // Pull failure is non-fatal if image exists locally; warn and continue
      ctx.emit(`Pull warning: ${err.message}`, { image, warning: err.message });
    }
  },
};
