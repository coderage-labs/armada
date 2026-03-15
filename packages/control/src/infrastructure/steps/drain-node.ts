// ── Drain Node Step — marks all instances on a node as draining ──

import { eq } from 'drizzle-orm';
import { getDrizzle } from '../../db/drizzle.js';
import { instances } from '../../db/drizzle-schema.js';
import type { StepHandler } from '../step-registry.js';

export const drainNodeHandler: StepHandler = {
  name: 'drain_node',
  async execute(ctx) {
    const { nodeId } = ctx.params;
    ctx.emit(`Draining node ${nodeId} — stopping new task dispatch`);

    // Set drain_mode = 1 on all instances of this node
    const result = getDrizzle()
      .update(instances)
      .set({ drainMode: 1 })
      .where(eq(instances.nodeId, nodeId))
      .run();

    ctx.emit(`Node ${nodeId} drained — ${result.changes} instance(s) marked as draining`);
  },
};
