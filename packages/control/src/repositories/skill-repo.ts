import { eq } from 'drizzle-orm';
import { getDrizzle } from '../db/drizzle.js';
import { skillLibrary } from '../db/drizzle-schema.js';
import type { LibrarySkill, TemplateSkill } from '@coderage-labs/armada-shared';
import { templatesRepo } from './template-repo.js';

function rowToLibrarySkill(r: typeof skillLibrary.$inferSelect): LibrarySkill {
  return {
    id: r.id,
    name: r.name,
    source: r.source as LibrarySkill['source'],
    url: r.url,
    version: r.version,
    description: r.description ?? '',
    installedVersion: r.installedVersion,
    createdAt: r.createdAt,
  };
}

export const skillLibraryRepo = {
  getAll(): LibrarySkill[] {
    return getDrizzle().select().from(skillLibrary).orderBy(skillLibrary.name).all().map(rowToLibrarySkill);
  },

  get(id: string): LibrarySkill | null {
    const row = getDrizzle().select().from(skillLibrary).where(eq(skillLibrary.id, id)).get();
    return row ? rowToLibrarySkill(row) : null;
  },

  getByName(name: string): LibrarySkill | null {
    const row = getDrizzle().select().from(skillLibrary).where(eq(skillLibrary.name, name)).get();
    return row ? rowToLibrarySkill(row) : null;
  },

  create(data: { name: string; source?: string; url?: string; version?: string; description?: string }): LibrarySkill {
    const id = crypto.randomUUID();
    getDrizzle().insert(skillLibrary).values({
      id,
      name: data.name,
      source: data.source ?? 'clawhub',
      url: data.url ?? null,
      version: data.version ?? null,
      description: data.description ?? '',
    }).run();
    return rowToLibrarySkill(getDrizzle().select().from(skillLibrary).where(eq(skillLibrary.id, id)).get()!);
  },

  update(id: string, data: Partial<{ name: string; source: string; url: string | null; version: string | null; description: string; installedVersion: string | null }>): LibrarySkill {
    const existing = skillLibraryRepo.get(id);
    if (!existing) throw new Error(`Skill not found: ${id}`);

    const updates: Partial<typeof skillLibrary.$inferInsert> = {};
    if (data.name !== undefined) updates.name = data.name;
    if (data.source !== undefined) updates.source = data.source;
    if (data.url !== undefined) updates.url = data.url;
    if (data.version !== undefined) updates.version = data.version;
    if (data.description !== undefined) updates.description = data.description;
    if (data.installedVersion !== undefined) updates.installedVersion = data.installedVersion;

    if (Object.keys(updates).length > 0) {
      getDrizzle().update(skillLibrary).set(updates).where(eq(skillLibrary.id, id)).run();
    }

    return skillLibraryRepo.get(id)!;
  },

  delete(id: string): void {
    getDrizzle().delete(skillLibrary).where(eq(skillLibrary.id, id)).run();
  },

  getUsage(id: string): string[] {
    const skill = skillLibraryRepo.get(id);
    if (!skill) return [];
    // templatesRepo imported at top level
    const templates = templatesRepo.getAll();
    return templates
      .filter((t: any) => {
        const skills: TemplateSkill[] = t.skillsList || [];
        return skills.some(s => s.name === skill.name);
      })
      .map((t: any) => t.name);
  },
};
