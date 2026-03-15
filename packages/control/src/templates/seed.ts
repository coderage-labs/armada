import { templatesRepo } from '../repositories/index.js';
import { DEFAULT_TEMPLATES } from './defaults.js';

const FLEET_IMAGE = 'ghcr.io/openclaw/openclaw:latest';

/**
 * Seed default templates into the database on first run.
 * Only inserts if the templates table is empty.
 */
export function seedDefaultTemplates(): void {
  const existing = templatesRepo.getAll();
  if (existing.length > 0) return;

  for (const t of DEFAULT_TEMPLATES) {
    templatesRepo.create({
      name: t.name,
      description: t.description,
      image: FLEET_IMAGE,
      role: t.role,
      skills: t.skills,
      model: t.model,
      resources: t.resources,
      plugins: t.plugins,
      skillsList: t.skillsList ?? [],
      pluginsList: t.pluginsList ?? [],
      toolsAllow: t.toolsAllow ?? [],
      toolsProfile: t.toolsProfile ?? '',
      soul: t.soul,
      agents: t.agents,
      env: t.env,
      internalAgents: t.internalAgents,
      projects: t.projects || [],
    });
  }
}
