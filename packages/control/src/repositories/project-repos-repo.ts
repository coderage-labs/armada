import { v4 as uuidv4 } from 'uuid';
import { eq, and } from 'drizzle-orm';
import { getDrizzle } from '../db/drizzle.js';
import { projectRepos } from '../db/drizzle-schema.js';

export interface ProjectRepo {
  id: string;
  projectId: string;
  integrationId: string;
  fullName: string;
  defaultBranch: string;
  cloneUrl: string | null;
  provider: string;
  isPrivate: boolean;
  createdAt: string;
}

type ProjectRepoRow = typeof projectRepos.$inferSelect;

function rowToProjectRepo(r: ProjectRepoRow): ProjectRepo {
  return {
    id: r.id,
    projectId: r.projectId,
    integrationId: r.integrationId,
    fullName: r.fullName,
    defaultBranch: r.defaultBranch ?? 'main',
    cloneUrl: r.cloneUrl ?? null,
    provider: r.provider,
    isPrivate: r.isPrivate === 1,
    createdAt: r.createdAt,
  };
}

export const projectReposRepo = {
  getByProject(projectId: string): ProjectRepo[] {
    return getDrizzle()
      .select()
      .from(projectRepos)
      .where(eq(projectRepos.projectId, projectId))
      .all()
      .map(rowToProjectRepo);
  },

  getByIntegration(integrationId: string): ProjectRepo[] {
    return getDrizzle()
      .select()
      .from(projectRepos)
      .where(eq(projectRepos.integrationId, integrationId))
      .all()
      .map(rowToProjectRepo);
  },

  getById(id: string): ProjectRepo | null {
    const row = getDrizzle().select().from(projectRepos).where(eq(projectRepos.id, id)).get();
    return row ? rowToProjectRepo(row) : null;
  },

  getByProjectAndName(projectId: string, fullName: string): ProjectRepo | null {
    const row = getDrizzle()
      .select()
      .from(projectRepos)
      .where(and(eq(projectRepos.projectId, projectId), eq(projectRepos.fullName, fullName)))
      .get();
    return row ? rowToProjectRepo(row) : null;
  },

  add(data: {
    projectId: string;
    integrationId: string;
    fullName: string;
    defaultBranch?: string;
    cloneUrl?: string;
    provider: string;
    isPrivate?: boolean;
  }): ProjectRepo {
    const id = uuidv4();
    getDrizzle().insert(projectRepos).values({
      id,
      projectId: data.projectId,
      integrationId: data.integrationId,
      fullName: data.fullName,
      defaultBranch: data.defaultBranch ?? 'main',
      cloneUrl: data.cloneUrl ?? null,
      provider: data.provider,
      isPrivate: data.isPrivate ? 1 : 0,
    }).run();
    return projectReposRepo.getById(id)!;
  },

  remove(id: string): void {
    getDrizzle().delete(projectRepos).where(eq(projectRepos.id, id)).run();
  },
};
