import { eq, sql, and } from 'drizzle-orm';
import { getDrizzle } from '../db/drizzle.js';
import { modelRegistry } from '../db/drizzle-schema.js';
import type { ModelRegistryEntry } from '@coderage-labs/armada-shared';

type ModelRow = typeof modelRegistry.$inferSelect;

function rowToModelRegistry(r: ModelRow): ModelRegistryEntry {
  let capabilities: string[] = [];
  try { capabilities = JSON.parse(r.capabilities); } catch { console.warn('[model-repo] Failed to parse JSON field'); }
  return {
    id: r.id,
    name: r.name,
    provider: r.provider,
    modelId: r.modelId,
    description: r.description,
    apiKeyEnvVar: r.apiKeyEnvVar,
    capabilities,
    maxTokens: r.maxTokens,
    costTier: (r.costTier as ModelRegistryEntry['costTier']) || 'standard',
    providerId: r.providerId ?? null,
    source: r.source ?? 'manual',
    createdAt: r.createdAt,
  };
}

export const modelRegistryRepo = {
  getAll(): ModelRegistryEntry[] {
    return getDrizzle().select().from(modelRegistry).orderBy(modelRegistry.name).all().map(rowToModelRegistry);
  },

  getById(id: string): ModelRegistryEntry | null {
    const row = getDrizzle().select().from(modelRegistry).where(eq(modelRegistry.id, id)).get();
    return row ? rowToModelRegistry(row) : null;
  },

  getByName(name: string): ModelRegistryEntry | null {
    const row = getDrizzle().select().from(modelRegistry).where(eq(modelRegistry.name, name)).get();
    return row ? rowToModelRegistry(row) : null;
  },

  getByModelId(modelId: string): ModelRegistryEntry | null {
    const row = getDrizzle().select().from(modelRegistry).where(eq(modelRegistry.modelId, modelId)).get();
    return row ? rowToModelRegistry(row) : null;
  },

  create(data: { name: string; provider: string; modelId: string; description?: string; apiKeyEnvVar?: string | null; capabilities?: string[]; maxTokens?: number | null; costTier?: string; providerId?: string | null }): ModelRegistryEntry {
    const id = crypto.randomUUID();
    getDrizzle().insert(modelRegistry).values({
      id,
      name: data.name,
      provider: data.provider,
      modelId: data.modelId,
      description: data.description ?? '',
      apiKeyEnvVar: data.apiKeyEnvVar ?? null,
      capabilities: JSON.stringify(data.capabilities ?? []),
      maxTokens: data.maxTokens ?? null,
      costTier: data.costTier ?? 'standard',
      providerId: data.providerId ?? null,
    }).run();
    return modelRegistryRepo.getById(id)!;
  },

  update(id: string, data: Partial<{ name: string; provider: string; modelId: string; description: string; apiKeyEnvVar: string | null; capabilities: string[]; maxTokens: number | null; costTier: string; providerId: string | null }>): ModelRegistryEntry {
    const existing = modelRegistryRepo.getById(id);
    if (!existing) throw new Error(`Model not found: ${id}`);

    const updateData: Record<string, any> = {};
    if (data.name !== undefined) updateData.name = data.name;
    if (data.provider !== undefined) updateData.provider = data.provider;
    if (data.modelId !== undefined) updateData.modelId = data.modelId;
    if (data.description !== undefined) updateData.description = data.description;
    if (data.apiKeyEnvVar !== undefined) updateData.apiKeyEnvVar = data.apiKeyEnvVar;
    if (data.capabilities !== undefined) updateData.capabilities = JSON.stringify(data.capabilities);
    if (data.maxTokens !== undefined) updateData.maxTokens = data.maxTokens;
    if (data.costTier !== undefined) updateData.costTier = data.costTier;
    if (data.providerId !== undefined) updateData.providerId = data.providerId;

    if (Object.keys(updateData).length > 0) {
      getDrizzle().update(modelRegistry).set(updateData).where(eq(modelRegistry.id, id)).run();
    }

    return modelRegistryRepo.getById(id)!;
  },

  delete(id: string): void {
    getDrizzle().delete(modelRegistry).where(eq(modelRegistry.id, id)).run();
  },

  deleteByProviderId(providerId: string): void {
    getDrizzle().delete(modelRegistry).where(eq(modelRegistry.providerId, providerId)).run();
  },

  getByProviderIdAndModelId(providerId: string, modelId: string): ModelRegistryEntry | null {
    const row = getDrizzle().select().from(modelRegistry)
      .where(and(eq(modelRegistry.providerId, providerId), eq(modelRegistry.modelId, modelId)))
      .get();
    return row ? rowToModelRegistry(row) : null;
  },

  upsertDiscovered(data: {
    name: string;
    provider: string;
    modelId: string;
    description?: string;
    capabilities?: string[];
    maxTokens?: number | null;
    providerId: string;
  }): ModelRegistryEntry {
    const existing = modelRegistryRepo.getByProviderIdAndModelId(data.providerId, data.modelId);
    if (existing) {
      return modelRegistryRepo.update(existing.id, {
        name: data.name,
        description: data.description ?? existing.description,
        capabilities: data.capabilities ?? existing.capabilities,
        maxTokens: data.maxTokens ?? existing.maxTokens,
      });
    }
    const id = crypto.randomUUID();
    getDrizzle().insert(modelRegistry).values({
      id,
      name: data.name,
      provider: data.provider,
      modelId: data.modelId,
      description: data.description ?? '',
      capabilities: JSON.stringify(data.capabilities ?? []),
      maxTokens: data.maxTokens ?? null,
      providerId: data.providerId,
      source: 'discovered',
    }).run();
    return modelRegistryRepo.getById(id)!;
  },
};
