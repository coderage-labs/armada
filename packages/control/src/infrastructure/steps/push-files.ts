// ── Push Files Step — writes workspace files (SOUL.md, AGENTS.md) to instance ──
// params: { nodeId, containerName, files: Array<{ path: string, content: string }> }

import type { StepHandler } from '../step-registry.js';

export const pushFilesHandler: StepHandler = {
  name: 'push_files',
  async execute(ctx) {
    const { nodeId, containerName, files } = ctx.params;

    if (!files || !Array.isArray(files) || files.length === 0) {
      ctx.emit('No files to push', { containerName });
      return;
    }

    const instanceName = containerName.replace('armada-instance-', '');
    const node = ctx.services.nodeClient(nodeId);

    ctx.emit(`Pushing ${files.length} file(s) to ${containerName}`, {
      instanceName,
      containerName,
      fileCount: files.length,
    });

    for (const file of files) {
      const { path, content } = file;
      ctx.emit(`Writing ${path}`, { instanceName, path });
      await node.writeInstanceFile(instanceName, path, content);
    }

    ctx.emit(`Files pushed to ${containerName}`, {
      instanceName,
      containerName,
      filesWritten: files.length,
    });
  },
};
