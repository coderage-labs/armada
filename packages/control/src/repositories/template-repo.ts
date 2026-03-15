import { eq } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { getDrizzle } from '../db/drizzle.js';
import { templates } from '../db/drizzle-schema.js';
import type { Template, PluginEntry, TemplatePlugin, TemplateSkill, TemplateAgent, TemplateModel } from '@coderage-labs/armada-shared';
import {
  parseJsonWithSchema,
  resourcesSchema,
  pluginEntrySchema,
  templatePluginSchema,
  templateSkillSchema,
  templateAgentSchema,
  templateModelSchema,
  stringArraySchema,
} from '../utils/json-schemas.js';
import { z } from 'zod';

type TemplateRow = typeof templates.$inferSelect;

function rowToTemplate(r: TemplateRow): Template {
  return {
    id: r.id,
    name: r.name,
    description: r.description ?? '',
    image: r.image,
    role: r.role ?? '',
    skills: r.skills ?? '',
    model: r.model ?? '',
    resources: parseJsonWithSchema('[template-repo] resources', r.resourcesJson, resourcesSchema, { memory: '2g', cpus: '1' }),
    plugins: parseJsonWithSchema('[template-repo] plugins', r.pluginsJson, z.array(pluginEntrySchema), []) as PluginEntry[],
    pluginsList: parseJsonWithSchema('[template-repo] pluginsList', r.pluginsListJson || '[]', z.array(templatePluginSchema), []) as TemplatePlugin[],
    skillsList: parseJsonWithSchema('[template-repo] skillsList', r.skillsListJson || '[]', z.array(templateSkillSchema), []) as TemplateSkill[],
    toolsAllow: parseJsonWithSchema('[template-repo] toolsAllow', r.toolsAllowJson || '[]', stringArraySchema, []),
    toolsProfile: r.toolsProfile ?? '',
    soul: r.soul ?? '',
    agents: r.agentsMd ?? '',
    env: parseJsonWithSchema('[template-repo] env', r.envJson, stringArraySchema, []),
    internalAgents: parseJsonWithSchema('[template-repo] internalAgents', r.internalAgentsJson || '[]', z.array(templateAgentSchema), []) as TemplateAgent[],
    tools: parseJsonWithSchema('[template-repo] tools', r.toolsJson || '[]', stringArraySchema, []),
    projects: parseJsonWithSchema('[template-repo] projects', r.projectsJson || '[]', stringArraySchema, []),
    models: parseJsonWithSchema('[template-repo] models', r.modelsJson || '[]', z.array(templateModelSchema), []) as TemplateModel[],
    createdAt: r.createdAt,
  };
}

export const templatesRepo = {
  getAll(): Template[] {
    return getDrizzle().select().from(templates).all().map(rowToTemplate);
  },

  getById(id: string): Template | undefined {
    const row = getDrizzle().select().from(templates).where(eq(templates.id, id)).get();
    return row ? rowToTemplate(row) : undefined;
  },

  create(data: Omit<Template, 'id' | 'createdAt'>): Template {
    const id = uuidv4();
    getDrizzle().insert(templates).values({
      id,
      name: data.name,
      description: data.description || null,
      image: data.image,
      role: data.role || null,
      skills: data.skills || null,
      model: data.model || null,
      resourcesJson: JSON.stringify(data.resources),
      pluginsJson: JSON.stringify(data.plugins),
      pluginsListJson: JSON.stringify(data.pluginsList || []),
      skillsListJson: JSON.stringify(data.skillsList || []),
      toolsDenyJson: '[]',
      toolsAllowJson: JSON.stringify(data.toolsAllow || []),
      toolsProfile: data.toolsProfile || '',
      soul: data.soul || null,
      agentsMd: data.agents || null,
      envJson: JSON.stringify(data.env),
      internalAgentsJson: JSON.stringify(data.internalAgents || []),
      contactsJson: '[]',  // deprecated, kept for schema compatibility
      toolsJson: JSON.stringify(data.tools || []),
      projectsJson: JSON.stringify(data.projects || []),
      modelsJson: JSON.stringify(data.models || []),
    }).run();
    const row = getDrizzle().select().from(templates).where(eq(templates.id, id)).get()!;
    return rowToTemplate(row);
  },

  update(id: string, data: Partial<Template>): Template | undefined {
    const existing = templatesRepo.getById(id);
    if (!existing) return undefined;
    const merged = { ...existing, ...data, id };
    getDrizzle().update(templates).set({
      name: merged.name,
      description: merged.description || null,
      image: merged.image,
      role: merged.role || null,
      skills: merged.skills || null,
      model: merged.model || null,
      resourcesJson: JSON.stringify(merged.resources),
      pluginsJson: JSON.stringify(merged.plugins),
      pluginsListJson: JSON.stringify(merged.pluginsList || []),
      skillsListJson: JSON.stringify(merged.skillsList || []),
      toolsDenyJson: '[]',
      toolsAllowJson: JSON.stringify(merged.toolsAllow || []),
      toolsProfile: merged.toolsProfile || '',
      soul: merged.soul || null,
      agentsMd: merged.agents || null,
      envJson: JSON.stringify(merged.env),
      internalAgentsJson: JSON.stringify(merged.internalAgents || []),
      contactsJson: '[]',  // deprecated, kept for schema compatibility
      toolsJson: JSON.stringify(merged.tools || []),
      projectsJson: JSON.stringify(merged.projects || []),
      modelsJson: JSON.stringify(merged.models || []),
    }).where(eq(templates.id, id)).run();
    return merged;
  },

  remove(id: string): boolean {
    const result = getDrizzle().delete(templates).where(eq(templates.id, id)).run();
    return result.changes > 0;
  },
};
