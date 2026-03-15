// ── Cleanup Node DB Step — remove node from DB and clean up references ──

import { eq } from 'drizzle-orm';
import { getDrizzle } from '../../db/drizzle.js';
import { agents, instances, nodes } from '../../db/drizzle-schema.js';
import type { StepHandler } from '../step-registry.js';

export const cleanupNodeDbHandler: StepHandler = {
  name: 'cleanup_node_db',
  async execute(ctx) {
    const { nodeId } = ctx.params;
    ctx.emit(`Cleaning up node ${nodeId} from database`);

    const db = getDrizzle();

    // Delete all agents on this node
    const agentResult = db.delete(agents).where(eq(agents.nodeId, nodeId)).run();
    ctx.emit(`Deleted ${agentResult.changes} agent(s) for node ${nodeId}`);

    // Delete all instances on this node
    const instanceResult = db.delete(instances).where(eq(instances.nodeId, nodeId)).run();
    ctx.emit(`Deleted ${instanceResult.changes} instance(s) for node ${nodeId}`);

    // Delete the node itself
    const nodeResult = db.delete(nodes).where(eq(nodes.id, nodeId)).run();
    ctx.emit(`Node ${nodeId} removed from database (deleted: ${nodeResult.changes})`);
  },
};
