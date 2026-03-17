/**
 * Assignment Repository — project responsibility assignments (#77)
 *
 * Manages the three mutex responsibility roles for a project:
 *   triager  — routes new issues to the right workflow
 *   approver — approves PRs / completed tasks
 *   owner    — project owner / final escalation target
 *
 * Each assignment slot can be filled by a 'user', 'agent', or 'role'.
 * Role-based assignments are resolved dynamically at call time.
 */
import { eq, and } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { getDrizzle } from '../db/drizzle.js';
import { projectAssignments, agents, users, userProjects, roleMetadata } from '../db/drizzle-schema.js';
import { sql } from 'drizzle-orm';

export type AssignmentType = 'triager' | 'approver' | 'owner';
export type AssigneeType = 'user' | 'agent' | 'role';

export interface Assignment {
  id: string;
  projectId: string;
  assignmentType: AssignmentType;
  assigneeType: AssigneeType;
  assigneeId: string;
  createdAt: string;
  updatedAt: string;
}

export interface ResolvedAssignee {
  type: 'user' | 'agent';
  id: string;
  name?: string;
  displayName?: string;
}

// ── Helpers ──────────────────────────────────────────────────────────

function rowToAssignment(r: typeof projectAssignments.$inferSelect): Assignment {
  return {
    id: r.id,
    projectId: r.projectId,
    assignmentType: r.assignmentType as AssignmentType,
    assigneeType: r.assigneeType as AssigneeType,
    assigneeId: r.assigneeId,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function isAgentHealthy(agent: typeof agents.$inferSelect): boolean {
  return agent.status === 'running' || agent.healthStatus === 'healthy';
}

// ── Repository ───────────────────────────────────────────────────────

export const assignmentRepo = {
  /**
   * Get a single assignment for a project/type combo.
   */
  getAssignment(projectId: string, assignmentType: AssignmentType): Assignment | null {
    const row = getDrizzle()
      .select()
      .from(projectAssignments)
      .where(and(
        eq(projectAssignments.projectId, projectId),
        eq(projectAssignments.assignmentType, assignmentType),
      ))
      .get();
    return row ? rowToAssignment(row) : null;
  },

  /**
   * Upsert an assignment (mutex via UNIQUE constraint).
   */
  setAssignment(
    projectId: string,
    assignmentType: AssignmentType,
    assigneeType: AssigneeType,
    assigneeId: string,
  ): Assignment {
    const db = getDrizzle();
    const id = uuidv4();
    const now = new Date().toISOString();

    db.insert(projectAssignments).values({
      id,
      projectId,
      assignmentType,
      assigneeType,
      assigneeId,
      createdAt: now,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: [projectAssignments.projectId, projectAssignments.assignmentType],
      set: {
        assigneeType,
        assigneeId,
        updatedAt: now,
      },
    }).run();

    return assignmentRepo.getAssignment(projectId, assignmentType)!;
  },

  /**
   * Remove a specific assignment.
   */
  removeAssignment(projectId: string, assignmentType: AssignmentType): void {
    getDrizzle()
      .delete(projectAssignments)
      .where(and(
        eq(projectAssignments.projectId, projectId),
        eq(projectAssignments.assignmentType, assignmentType),
      ))
      .run();
  },

  /**
   * Get all assignments for a project.
   */
  getAssignmentsForProject(projectId: string): Assignment[] {
    return getDrizzle()
      .select()
      .from(projectAssignments)
      .where(eq(projectAssignments.projectId, projectId))
      .all()
      .map(rowToAssignment);
  },

  /**
   * Remove all assignments for a given assignee (for cleanup on delete).
   */
  removeAssignmentsForAssignee(assigneeType: AssigneeType, assigneeId: string): number {
    const result = getDrizzle()
      .delete(projectAssignments)
      .where(and(
        eq(projectAssignments.assigneeType, assigneeType),
        eq(projectAssignments.assigneeId, assigneeId),
      ))
      .run();
    return result.changes;
  },

  /**
   * Resolve the triager for a project.
   * Priority chain:
   *   1. Explicit assignment → validate exists & healthy
   *   2. Role-based → find healthy agent with that role in the project
   *   3. Owner assignment (fall back to owner)
   *   4. All operator-type users
   */
  resolveTriager(projectId: string): ResolvedAssignee[] {
    return resolveAssignment(projectId, 'triager');
  },

  /**
   * Resolve the approver for a project.
   * Same priority chain as triager.
   */
  resolveApprover(projectId: string): ResolvedAssignee[] {
    return resolveAssignment(projectId, 'approver');
  },
};

// ── Resolution logic ─────────────────────────────────────────────────

function resolveAssignment(projectId: string, assignmentType: AssignmentType): ResolvedAssignee[] {
  const db = getDrizzle();
  const assignment = assignmentRepo.getAssignment(projectId, assignmentType);

  if (assignment) {
    // 1. Explicit user assignment
    if (assignment.assigneeType === 'user') {
      const user = db.select().from(users).where(eq(users.id, assignment.assigneeId)).get();
      if (user) {
        return [{ type: 'user', id: user.id, name: user.name, displayName: user.displayName }];
      }
      console.warn(`[assignments] Stale user assignment for ${projectId}/${assignmentType}: user ${assignment.assigneeId} not found`);
    }

    // 2. Explicit agent assignment
    if (assignment.assigneeType === 'agent') {
      const agent = db.select().from(agents).where(eq(agents.name, assignment.assigneeId)).get();
      if (agent && isAgentHealthy(agent)) {
        return [{ type: 'agent', id: agent.id, name: agent.name }];
      }
      if (agent) {
        console.warn(`[assignments] Agent ${assignment.assigneeId} assigned as ${assignmentType} for ${projectId} is not healthy (status: ${agent.status})`);
      } else {
        console.warn(`[assignments] Stale agent assignment for ${projectId}/${assignmentType}: agent ${assignment.assigneeId} not found`);
      }
    }

    // 3. Role-based assignment — find any healthy agent with this role in the project
    if (assignment.assigneeType === 'role') {
      const roleAgents = findHealthyAgentsWithRole(projectId, assignment.assigneeId);
      if (roleAgents.length > 0) {
        return roleAgents;
      }
      console.warn(`[assignments] No healthy agents with role "${assignment.assigneeId}" found for ${projectId}/${assignmentType}`);
    }
  }

  // 4. Fall back to owner assignment
  const ownerAssignment = assignmentRepo.getAssignment(projectId, 'owner');
  if (ownerAssignment) {
    if (ownerAssignment.assigneeType === 'user') {
      const user = db.select().from(users).where(eq(users.id, ownerAssignment.assigneeId)).get();
      if (user) {
        console.log(`[assignments] Falling back to project owner for ${projectId}/${assignmentType}`);
        return [{ type: 'user', id: user.id, name: user.name, displayName: user.displayName }];
      }
    }
    if (ownerAssignment.assigneeType === 'agent') {
      const agent = db.select().from(agents).where(eq(agents.name, ownerAssignment.assigneeId)).get();
      if (agent && isAgentHealthy(agent)) {
        console.log(`[assignments] Falling back to project owner agent for ${projectId}/${assignmentType}`);
        return [{ type: 'agent', id: agent.id, name: agent.name }];
      }
    }
  }

  // 5. Final fallback: legacy userProjects owner
  const legacyOwner = db
    .select({ id: users.id, name: users.name, displayName: users.displayName })
    .from(users)
    .innerJoin(userProjects, eq(users.id, userProjects.userId))
    .where(and(eq(userProjects.projectId, projectId), eq(userProjects.role, 'owner')))
    .get();
  if (legacyOwner) {
    console.log(`[assignments] Falling back to legacy userProjects owner for ${projectId}/${assignmentType}`);
    return [{ type: 'user', id: legacyOwner.id, name: legacyOwner.name, displayName: legacyOwner.displayName }];
  }

  // 6. All operator-type users as last resort
  const operators = db.select().from(users).where(eq(users.type, 'operator')).all();
  if (operators.length > 0) {
    console.log(`[assignments] Falling back to all operators for ${projectId}/${assignmentType}`);
    return operators.map(u => ({ type: 'user' as const, id: u.id, name: u.name, displayName: u.displayName }));
  }

  return [];
}

/**
 * Find healthy agents assigned to a project that have a given role.
 */
function findHealthyAgentsWithRole(projectId: string, role: string): ResolvedAssignee[] {
  const db = getDrizzle();

  // Get all agents with the target role
  const allAgents = db
    .select()
    .from(agents)
    .where(eq(agents.role, role))
    .all();

  const healthy = allAgents.filter(isAgentHealthy);
  return healthy.map(a => ({ type: 'agent' as const, id: a.id, name: a.name }));
}

// ── Owner migration (#77) ─────────────────────────────────────────────

/**
 * One-time migration: promote legacy userProjects owner rows to project_assignments.
 * Only runs if project_assignments table is empty but userProjects has owners.
 */
export function migrateOwnerAssignments(): void {
  const db = getDrizzle();

  // Check if project_assignments already has any rows
  const existing = db.select({ id: projectAssignments.id }).from(projectAssignments).limit(1).get();
  if (existing) {
    return; // Already seeded, skip
  }

  // Find all userProjects rows with role = 'owner'
  const owners = db
    .select({ userId: userProjects.userId, projectId: userProjects.projectId })
    .from(userProjects)
    .where(eq(userProjects.role, 'owner'))
    .all();

  if (owners.length === 0) {
    return;
  }

  console.log(`[assignments] Migrating ${owners.length} owner(s) from userProjects to project_assignments`);

  const now = new Date().toISOString();
  for (const row of owners) {
    try {
      db.insert(projectAssignments).values({
        id: uuidv4(),
        projectId: row.projectId,
        assignmentType: 'owner',
        assigneeType: 'user',
        assigneeId: row.userId,
        createdAt: now,
        updatedAt: now,
      }).onConflictDoNothing().run();
    } catch (err: any) {
      console.warn(`[assignments] Migration failed for project ${row.projectId}: ${err.message}`);
    }
  }

  console.log(`[assignments] Owner migration complete`);
}
