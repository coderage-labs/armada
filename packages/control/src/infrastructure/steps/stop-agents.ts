// ── Stop Agents Step — gracefully drain agents on an instance ──
//
// Sends SIGUSR1 to the container (graceful drain signal used by OpenClaw gateway),
// waits up to 30s for agents to become idle, then force-marks them as stopped.

import { eq, sql } from 'drizzle-orm';
import { getDrizzle } from '../../db/drizzle.js';
import { agents } from '../../db/drizzle-schema.js';
import { WsNodeClient } from '../ws-node-client.js';
import type { StepHandler } from '../step-registry.js';

const DRAIN_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 2_000;

export const stopAgentsHandler: StepHandler = {
  name: 'stop_agents',
  async execute(ctx) {
    const { nodeId, containerName, instanceId } = ctx.params;

    ctx.emit(`Stopping agents on instance ${instanceId} (container: ${containerName})`);

    // Send SIGUSR1 for graceful drain
    try {
      const client = new WsNodeClient(nodeId);
      await client.signalContainer(containerName, 'SIGUSR1');
      ctx.emit(`Sent SIGUSR1 to container ${containerName} — waiting for drain`);
    } catch (err: any) {
      ctx.emit(`Could not signal container ${containerName}: ${err?.message} — marking agents as stopped`);
      // If we can't signal, mark agents as stopped and continue
      getDrizzle()
        .update(agents)
        .set({ status: 'stopped' })
        .where(eq(agents.instanceId, instanceId))
        .run();
      return;
    }

    // Poll for up to 30s for agents to go idle/stopped
    const deadline = Date.now() + DRAIN_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const rows = getDrizzle().all(
        sql`SELECT id FROM agents WHERE instance_id = ${instanceId} AND status NOT IN ('stopped', 'error')`,
      ) as Array<{ id: string }>;

      if (rows.length === 0) {
        ctx.emit(`All agents on instance ${instanceId} are stopped/error`);
        break;
      }

      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    // Force-update agent status in DB
    getDrizzle()
      .update(agents)
      .set({ status: 'stopped' })
      .where(eq(agents.instanceId, instanceId))
      .run();

    ctx.emit(`Agents on instance ${instanceId} marked as stopped`);
  },
};
