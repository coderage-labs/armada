/**
 * deleted-agent-repo.ts
 *
 * Repository for tracking deleted agents, used by workspace retention
 * to know which agent workspaces should be cleaned up.
 *
 * #299 — Fix workspace retention to target deleted agents
 */

import { v4 as uuidv4 } from 'uuid';
import { getDrizzle } from '../db/drizzle.js';
import { deletedAgents } from '../db/drizzle-schema.js';
import { eq, and, lt, sql } from 'drizzle-orm';

export interface DeletedAgent {
  id: string;
  name: string;
  nodeId: string;
  instanceId: string;
  deletedAt: string;
  workspaceDeleted: boolean;
}

function rowToDeletedAgent(r: typeof deletedAgents.$inferSelect): DeletedAgent {
  return {
    id: r.id,
    name: r.name,
    nodeId: r.nodeId,
    instanceId: r.instanceId,
    deletedAt: r.deletedAt,
    workspaceDeleted: r.workspaceDeleted === 1,
  };
}

export const deletedAgentRepo = {
  /**
   * Record that an agent has been deleted. Called during agent destroy.
   */
  create({ name, nodeId, instanceId }: { name: string; nodeId: string; instanceId: string }): DeletedAgent {
    const db = getDrizzle();
    const id = uuidv4();
    const rows = db.insert(deletedAgents)
      .values({ id, name, nodeId, instanceId })
      .returning()
      .all();
    return rowToDeletedAgent(rows[0]);
  },

  /**
   * Get deleted agents whose workspaces have not yet been cleaned and
   * whose deletion timestamp is older than retentionDays.
   */
  getStaleWorkspaces(retentionDays: number): DeletedAgent[] {
    const db = getDrizzle();
    const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const cutoffIso = new Date(cutoffMs).toISOString().replace('T', ' ').slice(0, 19);

    const rows = db.select()
      .from(deletedAgents)
      .where(
        and(
          eq(deletedAgents.workspaceDeleted, 0),
          lt(deletedAgents.deletedAt, cutoffIso),
        ),
      )
      .all();

    return rows.map(rowToDeletedAgent);
  },

  /**
   * Mark the workspace for a deleted agent as having been cleaned.
   */
  markWorkspaceDeleted(id: string): void {
    const db = getDrizzle();
    db.update(deletedAgents)
      .set({ workspaceDeleted: 1 })
      .where(eq(deletedAgents.id, id))
      .run();
  },
};
