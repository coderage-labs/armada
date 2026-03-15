import { eq } from 'drizzle-orm';
import { getDrizzle } from '../db/drizzle.js';
import { modelProviders } from '../db/drizzle-schema.js';
import type { ModelProvider } from '@coderage-labs/armada-shared';

type ProviderRow = typeof modelProviders.$inferSelect;

function rowToProvider(r: ProviderRow): ModelProvider {
  return {
    id: r.id,
    name: r.name,
    type: r.type,
    apiKey: r.apiKey ?? null,
    baseUrl: r.baseUrl ?? null,
    enabled: r.enabled,
    hidden: r.hidden,
    fallbackEnabled: r.fallbackEnabled,
    fallbackBehavior: (r.fallbackBehavior as 'immediate' | 'backoff') ?? 'immediate',
    lastSyncAt: r.lastSyncAt ?? null,
    modelCount: r.modelCount,
    createdAt: r.createdAt,
  };
}

export const modelProviderRepo = {
  getAll(): ModelProvider[] {
    return getDrizzle().select().from(modelProviders).orderBy(modelProviders.name).all().map(rowToProvider);
  },

  getById(id: string): ModelProvider | null {
    const row = getDrizzle().select().from(modelProviders).where(eq(modelProviders.id, id)).get();
    return row ? rowToProvider(row) : null;
  },

  getByType(type: string): ModelProvider[] {
    return getDrizzle().select().from(modelProviders).where(eq(modelProviders.type, type)).all().map(rowToProvider);
  },

  create(data: { name: string; type: string; apiKey?: string | null; baseUrl?: string | null; enabled?: number }): ModelProvider {
    const id = crypto.randomUUID();
    getDrizzle().insert(modelProviders).values({
      id,
      name: data.name,
      type: data.type,
      apiKey: data.apiKey ?? null,
      baseUrl: data.baseUrl ?? null,
      enabled: data.enabled ?? 1,
    }).run();
    return modelProviderRepo.getById(id)!;
  },

  update(id: string, data: Partial<{ name: string; type: string; apiKey: string | null; baseUrl: string | null; enabled: number; fallbackEnabled: number; fallbackBehavior: string }>): ModelProvider {
    const existing = modelProviderRepo.getById(id);
    if (!existing) throw new Error(`Provider not found: ${id}`);

    const updateData: Record<string, any> = {};
    if (data.name !== undefined) updateData.name = data.name;
    if (data.type !== undefined) updateData.type = data.type;
    if (data.apiKey !== undefined) updateData.apiKey = data.apiKey;
    if (data.baseUrl !== undefined) updateData.baseUrl = data.baseUrl;
    if (data.enabled !== undefined) updateData.enabled = data.enabled;
    if (data.fallbackEnabled !== undefined) updateData.fallbackEnabled = data.fallbackEnabled;
    if (data.fallbackBehavior !== undefined) updateData.fallbackBehavior = data.fallbackBehavior;

    if (Object.keys(updateData).length > 0) {
      getDrizzle().update(modelProviders).set(updateData).where(eq(modelProviders.id, id)).run();
    }

    return modelProviderRepo.getById(id)!;
  },

  delete(id: string): void {
    getDrizzle().delete(modelProviders).where(eq(modelProviders.id, id)).run();
  },

  updateSyncStatus(id: string, modelCount: number): void {
    getDrizzle().update(modelProviders).set({
      lastSyncAt: new Date().toISOString(),
      modelCount,
    }).where(eq(modelProviders.id, id)).run();
  },
};
