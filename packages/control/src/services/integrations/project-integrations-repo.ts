import { v4 as uuidv4 } from 'uuid';
import { eq, desc, sql } from 'drizzle-orm';
import { getDrizzle } from '../../db/drizzle.js';
import { projectIntegrations } from '../../db/drizzle-schema.js';

export interface ProjectIntegration {
  id: string;
  projectId: string;
  integrationId: string;
  capability: string;
  config: Record<string, any>;
  enabled: boolean;
  syncCursor: string | null;
  lastSyncedAt: string | null;
  createdAt: string;
}

type ProjectIntegrationRow = typeof projectIntegrations.$inferSelect;

function rowToProjectIntegration(r: ProjectIntegrationRow): ProjectIntegration {
  let config: Record<string, any> = {};
  try { config = JSON.parse(r.config); } catch { console.warn('[project-integrations-repo] Failed to parse JSON field'); }
  return {
    id: r.id,
    projectId: r.projectId,
    integrationId: r.integrationId,
    capability: r.capability,
    config,
    enabled: r.enabled === 1,
    syncCursor: r.syncCursor ?? null,
    lastSyncedAt: r.lastSyncedAt ?? null,
    createdAt: r.createdAt ?? '',
  };
}

export const projectIntegrationsRepo = {
  getAll(): ProjectIntegration[] {
    return getDrizzle().select().from(projectIntegrations).orderBy(desc(projectIntegrations.createdAt)).all().map(rowToProjectIntegration);
  },

  getById(id: string): ProjectIntegration | null {
    const row = getDrizzle().select().from(projectIntegrations).where(eq(projectIntegrations.id, id)).get();
    return row ? rowToProjectIntegration(row) : null;
  },

  getByProject(projectId: string): ProjectIntegration[] {
    return getDrizzle().select().from(projectIntegrations).where(eq(projectIntegrations.projectId, projectId)).orderBy(desc(projectIntegrations.createdAt)).all().map(rowToProjectIntegration);
  },

  getByIntegration(integrationId: string): ProjectIntegration[] {
    return getDrizzle().select().from(projectIntegrations).where(eq(projectIntegrations.integrationId, integrationId)).orderBy(desc(projectIntegrations.createdAt)).all().map(rowToProjectIntegration);
  },

  attach(data: {
    projectId: string;
    integrationId: string;
    capability: string;
    config?: Record<string, any>;
    enabled?: boolean;
  }): ProjectIntegration {
    const id = uuidv4();
    getDrizzle().insert(projectIntegrations).values({
      id,
      projectId: data.projectId,
      integrationId: data.integrationId,
      capability: data.capability,
      config: JSON.stringify(data.config ?? {}),
      enabled: (data.enabled ?? true) ? 1 : 0,
    }).run();
    return projectIntegrationsRepo.getById(id)!;
  },

  update(id: string, data: Partial<{
    config: Record<string, any>;
    enabled: boolean;
  }>): ProjectIntegration {
    const existing = projectIntegrationsRepo.getById(id);
    if (!existing) throw new Error(`Project integration not found: ${id}`);

    const updateData: Record<string, any> = {};
    if (data.config !== undefined) updateData.config = JSON.stringify(data.config);
    if (data.enabled !== undefined) updateData.enabled = data.enabled ? 1 : 0;

    if (Object.keys(updateData).length > 0) {
      getDrizzle().update(projectIntegrations).set(updateData).where(eq(projectIntegrations.id, id)).run();
    }

    return projectIntegrationsRepo.getById(id)!;
  },

  updateSyncCursor(id: string, cursor: string | null, syncedAt?: string): void {
    getDrizzle().update(projectIntegrations).set({
      syncCursor: cursor,
      lastSyncedAt: syncedAt ?? new Date().toISOString(),
    }).where(eq(projectIntegrations.id, id)).run();
  },

  detach(id: string): void {
    getDrizzle().delete(projectIntegrations).where(eq(projectIntegrations.id, id)).run();
  },
};
