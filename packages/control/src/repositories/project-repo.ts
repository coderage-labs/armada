import { eq, sql, and } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { getDrizzle } from '../db/drizzle.js';
import { projects, userProjects, users, templates, agents } from '../db/drizzle-schema.js';
import type { Project, ProjectRepository, ArmadaUser } from '@coderage-labs/armada-shared';
import {
  parseJsonWithSchema,
  projectConfigSchema,
  projectRepositorySchema,
  linkedAccountsSchema,
  notificationsSchema,
  defaultNotifications,
  stringArraySchema,
} from '../utils/json-schemas.js';

// ── Row → domain mappers ────────────────────────────────────────────

function rowToProject(r: typeof projects.$inferSelect): Project {
  const config = parseJsonWithSchema('[project-repo] config', r.configJson || '{}', projectConfigSchema, {});
  const repositories = Array.isArray(config.repositories)
    ? (config.repositories as ProjectRepository[])
    : [];
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    contextMd: r.contextMd,
    color: r.color,
    icon: r.icon,
    archived: r.archived === 1,
    configJson: r.configJson,
    repositories,
    maxConcurrent: r.maxConcurrent ?? 3,
    createdAt: r.createdAt,
  };
}

function rowToUser(r: typeof users.$inferSelect): ArmadaUser {
  const linkedAccounts = parseJsonWithSchema('[project-repo] linkedAccounts', r.linkedAccountsJson, linkedAccountsSchema, {}) as ArmadaUser['linkedAccounts'];
  const notifications = parseJsonWithSchema('[project-repo] notifications', r.notificationsJson, notificationsSchema, defaultNotifications()) as ArmadaUser['notifications'];
  return {
    id: r.id,
    name: r.name,
    displayName: r.displayName,
    type: r.type as ArmadaUser['type'],
    role: r.role as ArmadaUser['role'],
    avatarUrl: r.avatarUrl,
    avatarGenerating: !!r.avatarGenerating,
    avatarVersion: (r as any).avatarVersion ?? 0,
    linkedAccounts,
    notifications,
    createdAt: r.createdAt,
  };
}

// ── Projects Repository ─────────────────────────────────────────────

export const projectsRepo = {
  getAll(includeArchived = false): Project[] {
    const db = getDrizzle();
    const query = includeArchived
      ? db.select().from(projects).orderBy(projects.name)
      : db.select().from(projects).where(eq(projects.archived, 0)).orderBy(projects.name);
    return query.all().map(rowToProject);
  },

  get(id: string): Project | null {
    const row = getDrizzle().select().from(projects).where(eq(projects.id, id)).get();
    return row ? rowToProject(row) : null;
  },

  getByName(name: string): Project | null {
    const row = getDrizzle().select().from(projects).where(eq(projects.name, name)).get();
    return row ? rowToProject(row) : null;
  },

  create(data: { name: string; description?: string; context_md?: string; color?: string; icon?: string; repositories?: ProjectRepository[]; maxConcurrent?: number }): Project {
    const id = uuidv4();
    let configJson = '{}';
    if (data.repositories && data.repositories.length > 0) {
      configJson = JSON.stringify({ repositories: data.repositories });
    }
    getDrizzle().insert(projects).values({
      id,
      name: data.name,
      description: data.description ?? '',
      contextMd: data.context_md ?? '',
      color: data.color ?? '#6b7280',
      icon: data.icon ?? null,
      configJson,
      maxConcurrent: data.maxConcurrent ?? 3,
    }).run();
    return rowToProject(getDrizzle().select().from(projects).where(eq(projects.id, id)).get()!);
  },

  update(id: string, data: Partial<{ name: string; description: string; context_md: string; color: string; icon: string | null; archived: boolean; config_json: string; repositories: ProjectRepository[]; maxConcurrent: number }>): Project {
    const existing = projectsRepo.get(id);
    if (!existing) throw new Error(`Project not found: ${id}`);

    const updates: Partial<typeof projects.$inferInsert> = {};

    if (data.name !== undefined) updates.name = data.name;
    if (data.description !== undefined) updates.description = data.description;
    if (data.context_md !== undefined) updates.contextMd = data.context_md;
    if (data.color !== undefined) updates.color = data.color;
    if (data.icon !== undefined) updates.icon = data.icon;
    if (data.archived !== undefined) updates.archived = data.archived ? 1 : 0;
    if (data.maxConcurrent !== undefined) updates.maxConcurrent = data.maxConcurrent;

    // Handle repositories — merge into config_json
    if (data.repositories !== undefined) {
      const config = JSON.parse(existing.configJson || '{}');
      config.repositories = data.repositories;
      updates.configJson = JSON.stringify(config);
    } else if (data.config_json !== undefined) {
      updates.configJson = data.config_json;
    }

    if (Object.keys(updates).length > 0) {
      getDrizzle().update(projects).set(updates).where(eq(projects.id, id)).run();
    }

    return projectsRepo.get(id)!;
  },

  delete(id: string): void {
    getDrizzle().delete(projects).where(eq(projects.id, id)).run();
  },

  getMembers(id: string): string[] {
    const db = getDrizzle();
    const project = projectsRepo.get(id);
    if (!project) return [];
    const allTemplates = db.select().from(templates).all();
    const allAgents = db.select().from(agents).all();
    const memberNames = new Set<string>();

    // 1. Agents whose template has this project in projects_json
    for (const agent of allAgents) {
      if (!agent.templateId) continue;
      const tmpl = allTemplates.find(t => t.id === agent.templateId);
      if (!tmpl) continue;
      const projectsList = parseJsonWithSchema('[project-repo] projectsJson', tmpl.projectsJson || '[]', stringArraySchema, []);
      if (projectsList.includes(project.name) || projectsList.includes(project.id)) {
        memberNames.add(agent.name);
      }
    }

    // 2. Agents that have run workflow steps for this project
    const workflowAgentRows = db.all<{ agent_name: string }>(
      sql`SELECT DISTINCT wsr.agent_name
          FROM workflow_step_runs wsr
          INNER JOIN workflow_runs wr ON wr.id = wsr.run_id
          WHERE wr.project_id = ${project.id}
            AND wsr.agent_name IS NOT NULL`,
    );
    for (const row of workflowAgentRows) {
      if (row.agent_name) memberNames.add(row.agent_name);
    }

    return Array.from(memberNames);
  },
};

// ── User-Project Assignments Repository ─────────────────────────────

export const userProjectsRepo = {
  getProjectsForUser(userId: string): string[] {
    return getDrizzle()
      .select({ projectId: userProjects.projectId })
      .from(userProjects)
      .where(eq(userProjects.userId, userId))
      .all()
      .map(r => r.projectId);
  },

  getUsersForProject(projectId: string): ArmadaUser[] {
    const rows = getDrizzle()
      .select({
        id: users.id,
        name: users.name,
        displayName: users.displayName,
        type: users.type,
        role: userProjects.role,
        avatarUrl: users.avatarUrl,
        avatarGenerating: users.avatarGenerating,
        avatarVersion: users.avatarVersion,
        linkedAccountsJson: users.linkedAccountsJson,
        notificationsJson: users.notificationsJson,
        channelsJson: users.channelsJson,
        createdAt: users.createdAt,
        passwordHash: users.passwordHash,
      })
      .from(users)
      .innerJoin(userProjects, eq(users.id, userProjects.userId))
      .where(eq(userProjects.projectId, projectId))
      .all();
    return rows.map(rowToUser);
  },

  assign(userId: string, projectId: string, role: string = 'member'): void {
    getDrizzle().insert(userProjects).values({
      userId,
      projectId,
      role,
    }).onConflictDoUpdate({
      target: [userProjects.userId, userProjects.projectId],
      set: { role },
    }).run();
  },

  remove(userId: string, projectId: string): void {
    getDrizzle()
      .delete(userProjects)
      .where(sql`${userProjects.userId} = ${userId} AND ${userProjects.projectId} = ${projectId}`)
      .run();
  },

  isAssigned(userId: string, projectId: string): boolean {
    const row = getDrizzle()
      .select({ userId: userProjects.userId })
      .from(userProjects)
      .where(sql`${userProjects.userId} = ${userId} AND ${userProjects.projectId} = ${projectId}`)
      .get();
    return !!row;
  },

  getOwner(projectId: string): ArmadaUser | null {
    const row = getDrizzle()
      .select({
        id: users.id,
        name: users.name,
        displayName: users.displayName,
        type: users.type,
        role: userProjects.role,
        avatarUrl: users.avatarUrl,
        avatarGenerating: users.avatarGenerating,
        avatarVersion: users.avatarVersion,
        linkedAccountsJson: users.linkedAccountsJson,
        notificationsJson: users.notificationsJson,
        channelsJson: users.channelsJson,
        createdAt: users.createdAt,
        passwordHash: users.passwordHash,
      })
      .from(users)
      .innerJoin(userProjects, eq(users.id, userProjects.userId))
      .where(and(eq(userProjects.projectId, projectId), eq(userProjects.role, 'owner')))
      .get();
    return row ? rowToUser(row) : null;
  },

  setOwner(userId: string, projectId: string): void {
    // Mutex: clear any existing owner first
    getDrizzle()
      .update(userProjects)
      .set({ role: 'member' })
      .where(and(eq(userProjects.projectId, projectId), eq(userProjects.role, 'owner')))
      .run();
    // Set new owner
    this.assign(userId, projectId, 'owner');
  },

  unsetOwner(projectId: string): void {
    getDrizzle()
      .update(userProjects)
      .set({ role: 'member' })
      .where(and(eq(userProjects.projectId, projectId), eq(userProjects.role, 'owner')))
      .run();
  },
};
