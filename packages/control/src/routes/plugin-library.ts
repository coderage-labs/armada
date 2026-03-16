import { Router } from 'express';
import { requireScope } from '../middleware/scopes.js';
import { registerToolDef } from '../utils/tool-registry.js';
import { pluginManager } from '../services/plugin-manager.js';
import { mutationService } from '../services/mutation-service.js';

// ── Tool definitions ────────────────────────────────────────────────

registerToolDef({
  name: 'armada_plugin_library_list',
  description: 'List all plugins in the plugin library.',
  method: 'GET', path: '/api/plugins/library',
  parameters: [],
});

registerToolDef({
  name: 'armada_plugin_library_get',
  description: 'Get a single plugin from the library by ID or name.',
  method: 'GET', path: '/api/plugins/library/:id',
  parameters: [
    { name: 'id', type: 'string', description: 'Plugin ID or name', required: true },
  ],
});

registerToolDef({
  name: 'armada_plugin_library_add',
  description: 'Add a plugin to the plugin library.',
  method: 'POST', path: '/api/plugins/library',
  parameters: [
    { name: 'name', type: 'string', description: 'Plugin name', required: true },
    { name: 'source', type: 'string', description: 'Source: github, npm, or workspace', required: false },
    { name: 'url', type: 'string', description: 'URL (for github source)', required: false },
    { name: 'version', type: 'string', description: 'Version', required: false },
    { name: 'description', type: 'string', description: 'Description of the plugin', required: false },
  ],
    scope: 'plugins:write',
});

registerToolDef({
  name: 'armada_plugin_library_update',
  description: 'Update a plugin in the plugin library.',
  method: 'PUT', path: '/api/plugins/library/:id',
  parameters: [
    { name: 'id', type: 'string', description: 'Plugin ID', required: true },
    { name: 'name', type: 'string', description: 'New name', required: false },
    { name: 'source', type: 'string', description: 'Source', required: false },
    { name: 'url', type: 'string', description: 'URL', required: false },
    { name: 'version', type: 'string', description: 'Version', required: false },
    { name: 'description', type: 'string', description: 'Description', required: false },
  ],
    scope: 'plugins:write',
});

registerToolDef({
  name: 'armada_plugin_library_delete',
  description: 'Remove a plugin from the plugin library.',
  method: 'DELETE', path: '/api/plugins/library/:id',
  parameters: [
    { name: 'id', type: 'string', description: 'Plugin ID', required: true },
  ],
    scope: 'plugins:write',
});

registerToolDef({
  name: 'armada_plugin_library_usage',
  description: 'Get which templates use a library plugin.',
  method: 'GET', path: '/api/plugins/library/:id/usage',
  parameters: [
    { name: 'id', type: 'string', description: 'Plugin ID', required: true },
  ],
});

registerToolDef({
  name: 'armada_plugin_library_pull',
  description: 'Pull the latest version of a library plugin.',
  method: 'POST', path: '/api/plugins/library/:id/update',
  parameters: [
    { name: 'id', type: 'string', description: 'Plugin ID', required: true },
  ],
    scope: 'plugins:write',
});

registerToolDef({
  name: 'armada_plugin_library_rollout',
  description: 'Update a plugin and rolling-restart all affected agents. Rolls back on failure.',
  method: 'POST', path: '/api/plugins/library/batch-rollout',
  parameters: [
    { name: 'id', type: 'string', description: 'Plugin ID', required: true },
  ],
    scope: 'plugins:write',
});

// ── Routes ──────────────────────────────────────────────────────────

const router = Router();

// GET /library — list all
router.get('/', (_req, res) => {
  res.json(pluginManager.list());
});

// GET /library/:id — get by ID or name
router.get('/:id', (req, res) => {
  const plugin = pluginManager.get(req.params.id) || pluginManager.getByName(req.params.id);
  if (!plugin) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  res.json(plugin);
});

// POST /library — add plugin (staged through changeset pipeline)
router.post('/', requireScope('plugins:write'), (req, res, next) => {
  try {
    const { name, source, url, version, description, npmPkg, system } = req.body;
    if (!name) {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    // Check for duplicates before staging
    const existing = pluginManager.getByName(name);
    if (existing) {
      res.status(409).json({ error: 'Plugin already exists in library', plugin: existing });
      return;
    }
    const mutation = mutationService.stage('plugin', 'create', { name, source, url, version, description, npmPkg, system });
    res.status(202).json({ staged: true, mutation });
  } catch (err: any) {
    next(err);
  }
});

// PUT /library/:id — update (staged through changeset pipeline)
router.put('/:id', requireScope('plugins:write'), (req, res, next) => {
  try {
    const plugin = pluginManager.get(req.params.id);
    if (!plugin) {
      res.status(404).json({ error: 'Plugin not found' });
      return;
    }
    const mutation = mutationService.stage('plugin', 'update', req.body, req.params.id);
    res.status(202).json({ staged: true, mutation });
  } catch (err: any) {
    next(err);
  }
});

// DELETE /library/:id — delete (staged through changeset pipeline)
router.delete('/:id', requireScope('plugins:write'), (req, res, next) => {
  try {
    const plugin = pluginManager.get(req.params.id);
    if (!plugin) {
      res.status(404).json({ error: 'Plugin not found' });
      return;
    }
    if (plugin.system) {
      res.status(403).json({ error: 'Cannot delete system plugins' });
      return;
    }
    const mutation = mutationService.stage('plugin', 'delete', { id: req.params.id }, req.params.id);
    res.status(202).json({ staged: true, mutation });
  } catch (err: any) {
    next(err);
  }
});

// GET /library/:id/usage — templates using this plugin
router.get('/:id/usage', (req, res, next) => {
  try {
    const usage = pluginManager.getUsage(req.params.id);
    res.json(usage);
  } catch (err: any) {
    if (err.status === 404) {
      res.status(404).json({ error: err.message });
      return;
    }
    next(err);
  }
});

// POST /library/:id/install — stage plugin install via changeset pipeline
router.post('/:id/install', requireScope('plugins:write'), (req, res, next) => {
  try {
    const plugin = pluginManager.get(req.params.id) || pluginManager.getByName(req.params.id);
    if (!plugin) {
      res.status(404).json({ error: 'Plugin not found' });
      return;
    }
    // Stage plugin install — affects all instances on the node
    const mutation = mutationService.stage('plugin', 'update', {
      install: true,
      name: plugin.name,
      npmPkg: plugin.npmPkg,
      version: plugin.version,
    });
    res.status(202).json({ staged: true, mutation });
  } catch (err: any) {
    if (err.message?.includes('failed:')) {
      const match = err.message.match(/failed: (\d+)/);
      res.status(match ? parseInt(match[1]) : 502).json({ error: err.message });
      return;
    }
    next(err);
  }
});

// POST /library/:id/update — pull latest version
router.post('/:id/update', requireScope('plugins:write'), async (req, res, next) => {
  try {
    const plugin = pluginManager.get(req.params.id);
    if (!plugin) {
      res.status(404).json({ error: 'Plugin not found' });
      return;
    }
    await pluginManager.install({
      name: plugin.name,
      npmPkg: plugin.npmPkg,
      source: plugin.source,
      url: plugin.url,
      version: req.body.version ?? plugin.version,
    });
    const updated = pluginManager.update(req.params.id, {
      version: req.body.version ?? plugin.version,
    });
    res.json(updated);
  } catch (err) { next(err); }
});

// POST /library/batch-rollout — stage batch plugin install via changeset pipeline
router.post('/batch-rollout', requireScope('plugins:write'), (req, res, next) => {
  try {
    const { pluginIds } = req.body || {};
    if (!Array.isArray(pluginIds) || pluginIds.length === 0) {
      res.status(400).json({ error: 'pluginIds array is required' });
      return;
    }
    // Stage each plugin for install
    const mutations = pluginIds.map(id => {
      const plugin = pluginManager.get(id);
      if (!plugin) throw Object.assign(new Error(`Plugin "${id}" not found`), { status: 404 });
      return mutationService.stage('plugin', 'update', {
        install: true,
        name: plugin.name,
        npmPkg: plugin.npmPkg,
        version: plugin.version,
      });
    });
    res.status(202).json({ staged: true, count: mutations.length, mutations });
  } catch (err: any) {
    if (err.status) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    next(err);
  }
});

// POST /library/cleanup — remove plugins not used by any template
router.post('/cleanup', requireScope('plugins:write'), async (req, res, next) => {
  try {
    const result = await pluginManager.cleanup(req.body.keep || []);
    res.json(result);
  } catch (err) { next(err); }
});

export const pluginLibraryRoutes = router;
export default pluginLibraryRoutes;
