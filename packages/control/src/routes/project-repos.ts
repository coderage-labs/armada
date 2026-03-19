// ── Project Repos Routes ─────────────────────────────────────────────
// Manage linked repositories for projects.

import { Router } from 'express';
import { requireScope } from '../middleware/scopes.js';
import { projectsRepo, projectReposRepo } from '../repositories/index.js';
import { integrationsRepo } from '../services/integrations/integrations-repo.js';
import { projectIntegrationsRepo } from '../services/integrations/project-integrations-repo.js';
import { getProvider } from '../services/integrations/registry.js';
import { registerToolDef } from '../utils/tool-registry.js';
import { logActivity } from '../services/activity-service.js';

const router = Router({ mergeParams: true });

/* ── Tool definitions ─────────────────────────────────────────────── */

registerToolDef({
  category: 'projects',
  name: 'armada_project_repos_list',
  description: 'List repositories linked to a project (from project_repos table)',
  method: 'GET',
  path: '/api/projects/:id/repos2',
  parameters: [
    { name: 'id', type: 'string', description: 'Project ID or name', required: true },
  ],
  scope: 'projects:read',
});

registerToolDef({
  category: 'projects',
  name: 'armada_project_repos_add',
  description: 'Link a repository to a project via a source control integration',
  method: 'POST',
  path: '/api/projects/:id/repos2',
  parameters: [
    { name: 'id', type: 'string', description: 'Project ID or name', required: true },
    { name: 'integrationId', type: 'string', description: 'Integration ID to use', required: true },
    { name: 'fullName', type: 'string', description: 'Repository full name (owner/repo)', required: true },
    { name: 'defaultBranch', type: 'string', description: 'Default branch (default: main)' },
    { name: 'provider', type: 'string', description: 'Provider: github | bitbucket | gitlab', required: true },
  ],
  scope: 'projects:write',
});

registerToolDef({
  category: 'projects',
  name: 'armada_project_repos_remove',
  description: 'Unlink a repository from a project',
  method: 'DELETE',
  path: '/api/projects/:id/repos2/:repoId',
  parameters: [
    { name: 'id', type: 'string', description: 'Project ID or name', required: true },
    { name: 'repoId', type: 'string', description: 'Project repo ID to remove', required: true },
  ],
  scope: 'projects:write',
});

registerToolDef({
  category: 'projects',
  name: 'armada_project_repos_search',
  description: 'Search available repositories via the project\'s source control integrations',
  method: 'GET',
  path: '/api/projects/:id/repos2/search',
  parameters: [
    { name: 'id', type: 'string', description: 'Project ID or name', required: true },
    { name: 'q', type: 'string', description: 'Search query to filter repos by name' },
    { name: 'integrationId', type: 'string', description: 'Specific integration ID to search (optional)' },
  ],
  scope: 'projects:read',
});

/* ── Routes ───────────────────────────────────────────────────────── */

// GET /api/projects/:id/repos2 — list linked repos with integration info
router.get('/', (req, res) => {
  const project = projectsRepo.get(((req.params as any).id as string)) || projectsRepo.getByName(((req.params as any).id as string));
  if (!project) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }
  const repos = projectReposRepo.getByProject(project.id);
  const enriched = repos.map(r => {
    const integration = integrationsRepo.getById(r.integrationId);
    return {
      ...r,
      integration: integration
        ? { id: integration.id, name: integration.name, provider: integration.provider }
        : null,
    };
  });
  res.json({ repos: enriched });
});

// GET /api/projects/:id/repos2/search — search available repos via integrations
router.get('/search', async (req, res) => {
  const project = projectsRepo.get(((req.params as any).id as string)) || projectsRepo.getByName(((req.params as any).id as string));
  if (!project) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }

  const q = (req.query.q as string || '').toLowerCase();
  const filterIntegrationId = req.query.integrationId as string | undefined;

  // Get the project's source control integrations
  const projectIntegrations = projectIntegrationsRepo.getByProject(project.id);
  const scmProjectIntegrations = projectIntegrations.filter(pi => {
    if (!pi.enabled) return false;
    if (filterIntegrationId && pi.integrationId !== filterIntegrationId) return false;
    const integration = integrationsRepo.getById(pi.integrationId);
    return integration && ['github', 'bitbucket'].includes(integration.provider);
  });

  if (scmProjectIntegrations.length === 0) {
    // Also try all active GitHub integrations if no project-level ones
    const allIntegrations = integrationsRepo.getAll().filter(i =>
      ['github', 'bitbucket'].includes(i.provider) &&
      i.status === 'active' &&
      (!filterIntegrationId || i.id === filterIntegrationId),
    );
    if (allIntegrations.length === 0) {
      res.json({ repos: [], integrations: [] });
      return;
    }

    const allRepos: any[] = [];
    const usedIntegrations: any[] = [];
    for (const integration of allIntegrations) {
      const provider = getProvider(integration.provider);
      if (!provider?.listRepos) continue;
      try {
        const repos = await provider.listRepos(integration.authConfig);
        const filtered = q ? repos.filter(r => r.fullName.toLowerCase().includes(q)) : repos;
        allRepos.push(...filtered.map(r => ({ ...r, integrationId: integration.id })));
        usedIntegrations.push({ id: integration.id, name: integration.name, provider: integration.provider });
      } catch (err: any) {
        console.warn(`[project-repos] listRepos failed for integration ${integration.id}:`, err.message);
      }
    }
    res.json({ repos: allRepos, integrations: usedIntegrations });
    return;
  }

  const allRepos: any[] = [];
  const usedIntegrations: any[] = [];
  for (const pi of scmProjectIntegrations) {
    const integration = integrationsRepo.getById(pi.integrationId);
    if (!integration) continue;
    const provider = getProvider(integration.provider);
    if (!provider?.listRepos) continue;
    try {
      const repos = await provider.listRepos(integration.authConfig);
      const filtered = q ? repos.filter(r => r.fullName.toLowerCase().includes(q)) : repos;
      allRepos.push(...filtered.map(r => ({ ...r, integrationId: integration.id })));
      if (!usedIntegrations.find(i => i.id === integration.id)) {
        usedIntegrations.push({ id: integration.id, name: integration.name, provider: integration.provider });
      }
    } catch (err: any) {
      console.warn(`[project-repos] listRepos failed for integration ${pi.integrationId}:`, err.message);
    }
  }

  res.json({ repos: allRepos, integrations: usedIntegrations });
});

// POST /api/projects/:id/repos2 — link a repo
router.post('/', requireScope('projects:write'), (req, res) => {
  const project = projectsRepo.get(((req.params as any).id as string)) || projectsRepo.getByName(((req.params as any).id as string));
  if (!project) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }

  const { integrationId, fullName, defaultBranch, provider, cloneUrl, isPrivate } = req.body;
  if (!integrationId || !fullName || !provider) {
    res.status(400).json({ error: 'integrationId, fullName, and provider are required' });
    return;
  }

  const integration = integrationsRepo.getById(integrationId);
  if (!integration) {
    res.status(404).json({ error: `Integration not found: ${integrationId}` });
    return;
  }

  // Check for duplicate
  const existing = projectReposRepo.getByProjectAndName(project.id, fullName);
  if (existing) {
    res.status(409).json({ error: `Repo ${fullName} is already linked to this project` });
    return;
  }

  const repo = projectReposRepo.add({
    projectId: project.id,
    integrationId,
    fullName,
    defaultBranch: defaultBranch || 'main',
    cloneUrl: cloneUrl || null,
    provider,
    isPrivate: !!isPrivate,
  });

  logActivity({
    eventType: 'project.repo.linked',
    detail: `Repo ${fullName} linked to project "${project.name}" via ${integration.name}`,
  });

  res.status(201).json(repo);
});

// DELETE /api/projects/:id/repos2/:repoId — unlink a repo
router.delete('/:repoId', requireScope('projects:write'), (req, res) => {
  const project = projectsRepo.get(((req.params as any).id as string)) || projectsRepo.getByName(((req.params as any).id as string));
  if (!project) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }

  const repo = projectReposRepo.getById(((req.params as any).repoId as string));
  if (!repo) {
    res.status(404).json({ error: 'Repo not found' });
    return;
  }
  if (repo.projectId !== project.id) {
    res.status(403).json({ error: 'Repo does not belong to this project' });
    return;
  }

  projectReposRepo.remove(((req.params as any).repoId as string));
  logActivity({
    eventType: 'project.repo.unlinked',
    detail: `Repo ${repo.fullName} unlinked from project "${project.name}"`,
  });

  res.status(204).send();
});

export default router;
