import { eq } from 'drizzle-orm';
import { getDrizzle } from '../db/drizzle.js';
import { pluginLibrary } from '../db/drizzle-schema.js';
import type { LibraryPlugin, TemplatePlugin } from '@coderage-labs/armada-shared';
import { templatesRepo } from './template-repo.js';

function rowToLibraryPlugin(r: typeof pluginLibrary.$inferSelect): LibraryPlugin {
  return {
    id: r.id,
    name: r.name,
    npmPkg: r.npmPkg,
    source: r.source as LibraryPlugin['source'],
    url: r.url,
    version: r.version,
    description: r.description,
    system: r.system === 1,
    createdAt: r.createdAt,
  };
}

export const pluginLibraryRepo = {
  getAll(): LibraryPlugin[] {
    return getDrizzle().select().from(pluginLibrary).orderBy(pluginLibrary.name).all().map(rowToLibraryPlugin);
  },

  get(id: string): LibraryPlugin | null {
    const row = getDrizzle().select().from(pluginLibrary).where(eq(pluginLibrary.id, id)).get();
    return row ? rowToLibraryPlugin(row) : null;
  },

  getByName(name: string): LibraryPlugin | null {
    const row = getDrizzle().select().from(pluginLibrary).where(eq(pluginLibrary.name, name)).get();
    return row ? rowToLibraryPlugin(row) : null;
  },

  create(data: { name: string; npmPkg?: string; source?: string; url?: string; version?: string; description?: string; system?: boolean }): LibraryPlugin {
    const id = crypto.randomUUID();
    getDrizzle().insert(pluginLibrary).values({
      id,
      name: data.name,
      npmPkg: data.npmPkg ?? null,
      source: data.source ?? 'github',
      url: data.url ?? null,
      version: data.version ?? null,
      description: data.description ?? '',
      system: data.system ? 1 : 0,
    }).run();
    return rowToLibraryPlugin(getDrizzle().select().from(pluginLibrary).where(eq(pluginLibrary.id, id)).get()!);
  },

  update(id: string, data: Partial<{ name: string; npmPkg: string | null; source: string; url: string | null; version: string | null; description: string; system: boolean }>): LibraryPlugin {
    const existing = pluginLibraryRepo.get(id);
    if (!existing) throw new Error(`Plugin not found: ${id}`);

    const updates: Partial<typeof pluginLibrary.$inferInsert> = {};
    if (data.name !== undefined) updates.name = data.name;
    if (data.npmPkg !== undefined) updates.npmPkg = data.npmPkg;
    if (data.source !== undefined) updates.source = data.source;
    if (data.url !== undefined) updates.url = data.url;
    if (data.version !== undefined) updates.version = data.version;
    if (data.description !== undefined) updates.description = data.description;
    if (data.system !== undefined) updates.system = data.system ? 1 : 0;

    if (Object.keys(updates).length > 0) {
      getDrizzle().update(pluginLibrary).set(updates).where(eq(pluginLibrary.id, id)).run();
    }

    return pluginLibraryRepo.get(id)!;
  },

  delete(id: string): void {
    getDrizzle().delete(pluginLibrary).where(eq(pluginLibrary.id, id)).run();
  },

  getUsage(id: string): string[] {
    const plugin = pluginLibraryRepo.get(id);
    if (!plugin) return [];
    // templatesRepo imported at top level
    const templates = templatesRepo.getAll();
    return templates
      .filter((t: any) => {
        const plugins: TemplatePlugin[] = t.pluginsList || [];
        return plugins.some(p => p.name === plugin.name);
      })
      .map((t: any) => t.name);
  },
};
