// ── Cleanup Instance DB Step — remove instance from DB and clean up agent records ──

import { eq } from 'drizzle-orm';
import { getDrizzle } from '../../db/drizzle.js';
import { agents, instances } from '../../db/drizzle-schema.js';
import type { StepHandler } from '../step-registry.js';

export const cleanupInstanceDbHandler: StepHandler = {
  name: 'cleanup_instance_db',
  async execute(ctx) {
    const { instanceId, nodeId, containerName } = ctx.params;
    ctx.emit(`Cleaning up instance ${instanceId} from database`);

    const db = getDrizzle();

    // Delete all agents for this instance
    const agentResult = db.delete(agents).where(eq(agents.instanceId, instanceId)).run();
    ctx.emit(`Deleted ${agentResult.changes} agent(s) for instance ${instanceId}`);

    // Delete the instance record
    const instanceResult = db.delete(instances).where(eq(instances.id, instanceId)).run();

    if (instanceResult.changes === 0) {
      ctx.emit(`Instance ${instanceId} was already removed from database`);
    } else {
      ctx.emit(`Instance ${instanceId} removed from database`);
    }

    // After DB cleanup, try to remove workspace files on node (best-effort)
    if (nodeId) {
      try {
        const node = ctx.services.nodeClient(nodeId);
        await node.deleteFile(`/data/fleet/${containerName}`, true);
        ctx.emit(`Workspace files cleaned up for ${containerName}`);
      } catch (err: any) {
        ctx.emit(`Warning: could not clean workspace files: ${err.message}`);
      }
    }
  },
};
