import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { requireScope } from '../middleware/scopes.js';
import { integrationsRepo, maskAuthConfig } from '../services/integrations/integrations-repo.js';
import { projectIntegrationsRepo } from '../services/integrations/project-integrations-repo.js';
import { getProvider, listProviders } from '../services/integrations/registry.js';
import { registerToolDef } from '../utils/tool-registry.js';
import { logActivity } from '../services/activity-service.js';
import { workingCopy } from '../services/working-copy.js';

const router = Router();

// ── Tool Definitions ────────────────────────────────────────────────

registerToolDef({
  name: 'armada_integrations_list',
  description: 'List all integrations (masked auth)',
  method: 'GET',
  path: '/api/integrations',
  parameters: [],
    scope: 'integrations:read',
});

registerToolDef({
  name: 'armada_integration_create',
  description: 'Create a new integration (validate provider exists)',
  method: 'POST',
  path: '/api/integrations',
  parameters: [
    { name: 'name', type: 'string', description: 'Integration name', required: true },
    { name: 'provider', type: 'string', description: 'Provider name (github, atlassian, jira, bitbucket)', required: true },
    { name: 'authType', type: 'string', description: 'Auth type (api-token, ssh-key, oauth)', required: true },
    { name: 'authConfig', type: 'string', description: 'Auth config JSON', required: true },
    { name: 'capabilities', type: 'string', description: 'JSON array of capabilities (issues, vcs)', required: true },
  ],
    scope: 'integrations:write',
});

registerToolDef({
  name: 'armada_integration_get',
  description: 'Get a single integration (masked auth)',
  method: 'GET',
  path: '/api/integrations/:id',
  parameters: [
    { name: 'id', type: 'string', description: 'Integration ID', required: true },
  ],
    scope: 'integrations:read',
});

registerToolDef({
  name: 'armada_integration_update',
  description: 'Update an integration',
  method: 'PUT',
  path: '/api/integrations/:id',
  parameters: [
    { name: 'id', type: 'string', description: 'Integration ID', required: true },
    { name: 'name', type: 'string', description: 'Integration name' },
    { name: 'authConfig', type: 'string', description: 'Auth config JSON' },
    { name: 'capabilities', type: 'string', description: 'JSON array of capabilities' },
    { name: 'status', type: 'string', description: 'Status (active, error, expired)' },
    { name: 'statusMessage', type: 'string', description: 'Status message' },
  ],
    scope: 'integrations:write',
});

registerToolDef({
  name: 'armada_integration_delete',
  description: 'Delete an integration (cascade removes project integrations)',
  method: 'DELETE',
  path: '/api/integrations/:id',
  parameters: [
    { name: 'id', type: 'string', description: 'Integration ID', required: true },
  ],
    scope: 'integrations:write',
});

registerToolDef({
  name: 'armada_integration_test',
  description: 'Test connection via provider adapter',
  method: 'POST',
  path: '/api/integrations/:id/test',
  parameters: [
    { name: 'id', type: 'string', description: 'Integration ID', required: true },
  ],
    scope: 'integrations:write',
});

registerToolDef({
  name: 'armada_integration_projects',
  description: 'List available external projects',
  method: 'GET',
  path: '/api/integrations/:id/projects',
  parameters: [
    { name: 'id', type: 'string', description: 'Integration ID', required: true },
  ],
    scope: 'integrations:read',
});

registerToolDef({
  name: 'armada_integration_repos',
  description: 'List available repos',
  method: 'GET',
  path: '/api/integrations/:id/repos',
  parameters: [
    { name: 'id', type: 'string', description: 'Integration ID', required: true },
  ],
    scope: 'integrations:read',
});

registerToolDef({
  name: 'armada_project_integrations_list',
  description: 'List project\'s integration configs',
  method: 'GET',
  path: '/api/projects/:id/integrations',
  parameters: [
    { name: 'id', type: 'string', description: 'Project ID', required: true },
  ],
    scope: 'integrations:read',
});

registerToolDef({
  name: 'armada_project_integration_attach',
  description: 'Attach integration to project',
  method: 'POST',
  path: '/api/projects/:id/integrations',
  parameters: [
    { name: 'id', type: 'string', description: 'Project ID', required: true },
    { name: 'integrationId', type: 'string', description: 'Integration ID', required: true },
    { name: 'capability', type: 'string', description: 'Capability (issues or vcs)', required: true },
    { name: 'config', type: 'string', description: 'Config JSON (filters, repos, etc.)' },
  ],
    scope: 'integrations:write',
});

registerToolDef({
  name: 'armada_project_integration_update',
  description: 'Update project integration config',
  method: 'PUT',
  path: '/api/projects/:id/integrations/:piId',
  parameters: [
    { name: 'id', type: 'string', description: 'Project ID', required: true },
    { name: 'piId', type: 'string', description: 'Project integration ID', required: true },
    { name: 'config', type: 'string', description: 'Config JSON' },
    { name: 'enabled', type: 'boolean', description: 'Enabled flag' },
  ],
    scope: 'integrations:write',
});

registerToolDef({
  name: 'armada_project_integration_detach',
  description: 'Detach integration from project',
  method: 'DELETE',
  path: '/api/projects/:id/integrations/:piId',
  parameters: [
    { name: 'id', type: 'string', description: 'Project ID', required: true },
    { name: 'piId', type: 'string', description: 'Project integration ID', required: true },
  ],
    scope: 'integrations:write',
});

registerToolDef({
  name: 'armada_project_integration_sync',
  description: 'Trigger manual sync',
  method: 'POST',
  path: '/api/projects/:id/integrations/:piId/sync',
  parameters: [
    { name: 'id', type: 'string', description: 'Project ID', required: true },
    { name: 'piId', type: 'string', description: 'Project integration ID', required: true },
  ],
    scope: 'integrations:write',
});

// ── Routes ──────────────────────────────────────────────────────────

// GET /api/integrations — list all (masked auth)
router.get('/', (_req, res) => {
  const integrations = integrationsRepo.getAll().map(i => ({
    ...i,
    authConfig: maskAuthConfig(i.authConfig),
  }));
  res.json(integrations);
});

// GET /api/integrations/:id — get one (masked auth)
router.get('/:id', (req, res) => {
  const integration = integrationsRepo.getById(req.params.id);
  if (!integration) {
    res.status(404).json({ error: 'Integration not found' });
    return;
  }
  res.json({
    ...integration,
    authConfig: maskAuthConfig(integration.authConfig),
  });
});

// POST /api/integrations — create
router.post('/', requireScope('integrations:write'), (req, res, next) => {
  try {
    const { name, provider, authType, authConfig, capabilities } = req.body;

    if (!name || !provider || !authType || !authConfig) {
      res.status(400).json({ error: 'name, provider, authType, and authConfig are required' });
      return;
    }

    // Validate provider exists in registry
    const providerAdapter = getProvider(provider);
    if (!providerAdapter) {
      res.status(400).json({
        error: `Unknown provider: ${provider}`,
        availableProviders: listProviders(),
      });
      return;
    }

    const parsedAuthConfig = typeof authConfig === 'string' ? JSON.parse(authConfig) : authConfig;
    const parsedCapabilities = typeof capabilities === 'string' ? JSON.parse(capabilities) : capabilities;

    const id = randomUUID();
    workingCopy.create('integration', id, {
      name,
      provider,
      authType,
      authConfig: parsedAuthConfig,
      capabilities: parsedCapabilities ?? [],
    });

    logActivity({ eventType: 'integration.created', detail: `Integration "${name}" staged for creation (${provider})` });
    res.status(201).json({ ok: true, action: 'create', message: 'Staged in working copy' });
  } catch (err) {
    next(err);
  }
});

// PUT /api/integrations/:id — update
router.put('/:id', requireScope('integrations:write'), (req, res, next) => {
  try {
    const existing = integrationsRepo.getById(req.params.id);
    if (!existing) {
      res.status(404).json({ error: 'Integration not found' });
      return;
    }

    const { authConfig, capabilities, ...rest } = req.body;
    const updateData: any = { ...rest };

    if (authConfig !== undefined) {
      updateData.authConfig = typeof authConfig === 'string' ? JSON.parse(authConfig) : authConfig;
    }
    if (capabilities !== undefined) {
      updateData.capabilities = typeof capabilities === 'string' ? JSON.parse(capabilities) : capabilities;
    }

    workingCopy.update('integration', req.params.id, updateData);
    logActivity({ eventType: 'integration.updated', detail: `Integration "${existing.name}" staged for update` });
    res.json({ ok: true, action: 'update', message: 'Staged in working copy' });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/integrations/:id — delete
router.delete('/:id', requireScope('integrations:write'), (req, res) => {
  const integration = integrationsRepo.getById(req.params.id);
  if (!integration) {
    res.status(404).json({ error: 'Integration not found' });
    return;
  }

  // Check if used by projects
  const usages = projectIntegrationsRepo.getByIntegration(req.params.id);
  if (usages.length > 0) {
    res.status(400).json({
      error: 'Integration is in use by projects',
      projectIntegrations: usages.map(pi => pi.projectId),
    });
    return;
  }

  workingCopy.delete('integration', req.params.id);
  logActivity({ eventType: 'integration.deleted', detail: `Integration "${integration.name}" staged for deletion` });
  res.json({ ok: true, action: 'delete', message: 'Staged in working copy' });
});

// POST /api/integrations/:id/test — test connection
router.post('/:id/test', requireScope('integrations:write'), async (req, res, next) => {
  try {
    const integration = integrationsRepo.getById(req.params.id);
    if (!integration) {
      res.status(404).json({ error: 'Integration not found' });
      return;
    }

    const provider = getProvider(integration.provider);
    if (!provider) {
      res.status(400).json({ error: `Provider not found: ${integration.provider}` });
      return;
    }

    const result = await provider.testConnection(integration.authConfig);

    // Update status based on test result
    if (result.ok) {
      integrationsRepo.update(req.params.id, { status: 'active', statusMessage: null });
    } else {
      integrationsRepo.update(req.params.id, { status: 'error', statusMessage: result.error || 'Connection test failed' });
    }

    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/integrations/:id/projects — list available external projects
router.get('/:id/projects', async (req, res, next) => {
  try {
    const integration = integrationsRepo.getById(req.params.id);
    if (!integration) {
      res.status(404).json({ error: 'Integration not found' });
      return;
    }

    const provider = getProvider(integration.provider);
    if (!provider || !provider.listProjects) {
      res.status(400).json({ error: 'Provider does not support listing projects' });
      return;
    }

    const projects = await provider.listProjects(integration.authConfig);
    res.json(projects);
  } catch (err) {
    next(err);
  }
});

// GET /api/integrations/:id/repos — list available repos
router.get('/:id/repos', async (req, res, next) => {
  try {
    const integration = integrationsRepo.getById(req.params.id);
    if (!integration) {
      res.status(404).json({ error: 'Integration not found' });
      return;
    }

    const provider = getProvider(integration.provider);
    if (!provider || !provider.listRepos) {
      res.status(400).json({ error: 'Provider does not support listing repos' });
      return;
    }

    const repos = await provider.listRepos(integration.authConfig);
    res.json(repos);
  } catch (err) {
    next(err);
  }
});

// ── Project Integration Routes ──────────────────────────────────────

// Mount under /api/projects/:id/integrations (parent router handles /api/projects)
export const projectIntegrationsRouter = Router({ mergeParams: true });

// GET /api/projects/:id/integrations — list project's integration configs
projectIntegrationsRouter.get('/', (req: any, res) => {
  const projectId = req.params.id as string;
  const configs = projectIntegrationsRepo.getByProject(projectId);
  res.json(configs);
});

// POST /api/projects/:id/integrations — attach integration to project
projectIntegrationsRouter.post('/', (req: any, res, next) => {
  try {
    const projectId = req.params.id as string;
    const { integrationId, capability, config } = req.body;

    if (!integrationId || !capability) {
      res.status(400).json({ error: 'integrationId and capability are required' });
      return;
    }

    // Validate integration exists
    const integration = integrationsRepo.getById(integrationId);
    if (!integration) {
      res.status(404).json({ error: 'Integration not found' });
      return;
    }

    // Validate capability is supported
    if (!integration.capabilities.includes(capability)) {
      res.status(400).json({
        error: `Integration does not support capability: ${capability}`,
        supportedCapabilities: integration.capabilities,
      });
      return;
    }

    const parsedConfig = typeof config === 'string' ? JSON.parse(config) : (config ?? {});

    const projectIntegration = projectIntegrationsRepo.attach({
      projectId,
      integrationId,
      capability,
      config: parsedConfig,
    });

    logActivity({
      eventType: 'project.integration.attached',
      detail: `Integration "${integration.name}" attached to project (${capability})`,
      metadata: JSON.stringify({ projectId, integrationId, capability }),
    });

    res.status(201).json(projectIntegration);
  } catch (err) {
    next(err);
  }
});

// PUT /api/projects/:id/integrations/:piId — update config
projectIntegrationsRouter.put('/:piId', (req, res, next) => {
  try {
    const piId = req.params.piId as string;
    const existing = projectIntegrationsRepo.getById(piId);
    if (!existing) {
      res.status(404).json({ error: 'Project integration not found' });
      return;
    }

    const { config, enabled } = req.body;
    const updateData: any = {};

    if (config !== undefined) {
      updateData.config = typeof config === 'string' ? JSON.parse(config) : config;
    }
    if (enabled !== undefined) {
      updateData.enabled = enabled;
    }

    const updated = projectIntegrationsRepo.update(piId, updateData);
    logActivity({
      eventType: 'project.integration.updated',
      detail: `Project integration config updated`,
      metadata: JSON.stringify({ projectIntegrationId: piId }),
    });
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/projects/:id/integrations/:piId — detach
projectIntegrationsRouter.delete('/:piId', (req, res) => {
  const piId = req.params.piId as string;
  const existing = projectIntegrationsRepo.getById(piId);
  if (!existing) {
    res.status(404).json({ error: 'Project integration not found' });
    return;
  }

  projectIntegrationsRepo.detach(piId);
  logActivity({
    eventType: 'project.integration.detached',
    detail: `Integration detached from project`,
    metadata: JSON.stringify({ projectIntegrationId: piId }),
  });
  res.status(204).end();
});

// POST /api/projects/:id/integrations/:piId/sync — trigger manual sync
projectIntegrationsRouter.post('/:piId/sync', async (req, res, next) => {
  try {
    const piId = req.params.piId as string;
    const projectIntegration = projectIntegrationsRepo.getById(piId);
    if (!projectIntegration) {
      res.status(404).json({ error: 'Project integration not found' });
      return;
    }

    const integration = integrationsRepo.getById(projectIntegration.integrationId);
    if (!integration) {
      res.status(404).json({ error: 'Integration not found' });
      return;
    }

    const provider = getProvider(integration.provider);
    if (!provider) {
      res.status(400).json({ error: `Provider not found: ${integration.provider}` });
      return;
    }

    // For now, just acknowledge the sync request
    // Actual sync logic will be implemented in separate sync service
    logActivity({
      eventType: 'project.integration.sync.triggered',
      detail: `Manual sync triggered for project integration`,
      metadata: JSON.stringify({ projectIntegrationId: piId }),
    });

    res.json({ message: 'Sync triggered', projectIntegrationId: piId });
  } catch (err) {
    next(err);
  }
});

export default router;
