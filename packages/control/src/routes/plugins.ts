import { Router } from 'express';
import { requireScope } from '../middleware/scopes.js';
import fs from 'node:fs';
import path from 'node:path';
import { registerToolDef } from '../utils/tool-registry.js';
import { pluginLibraryRepo } from '../repositories/index.js';
import { mutationService } from '../services/mutation-service.js';
import { logActivity } from '../services/activity-service.js';

const router = Router();

registerToolDef({
  category: 'plugins',
  name: 'armada_plugins',
  description: 'List all plugins available in the armada shared plugins directory.',
  method: 'GET', path: '/api/plugins',
  parameters: [],
});

registerToolDef({
  category: 'plugins',
  name: 'armada_plugin_update',
  description: 'Update a specific plugin in the armada shared plugins directory.',
  method: 'POST', path: '/api/plugins/:id/update',
  parameters: [
    { name: 'id', type: 'string', description: 'Plugin name to update', required: true },
  ],
  scope: 'plugins:write',
});

registerToolDef({
  category: 'plugins',
  name: 'armada_plugins_update_all',
  description: 'Update all plugins in the armada shared plugins directory.',
  method: 'POST', path: '/api/plugins/update-all',
  parameters: [],
  scope: 'plugins:write',
});

const PLUGINS_PATH = process.env.ARMADA_PLUGINS_PATH || '/data/armada/plugins';

interface ScannedPlugin {
  name: string;
  version: string;
  path: string;
  lastUpdated?: string;
}

/**
 * GET /api/plugins — list installed plugins by scanning the plugins directory.
 * For each subdirectory, reads package.json or openclaw.plugin.json.
 */
router.get('/plugins', (_req, res) => {
  const plugins: ScannedPlugin[] = [];

  try {
    if (!fs.existsSync(PLUGINS_PATH)) {
      return res.json(plugins);
    }

    const entries = fs.readdirSync(PLUGINS_PATH, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === 'node_modules') continue; // #255: skip node_modules

      const dirPath = path.join(PLUGINS_PATH, entry.name);
      let name = entry.name;
      let version = 'unknown';
      let lastUpdated: string | undefined;

      // Try openclaw.plugin.json first, then package.json
      for (const filename of ['openclaw.plugin.json', 'package.json']) {
        const filePath = path.join(dirPath, filename);
        if (fs.existsSync(filePath)) {
          try {
            const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            name = content.name || name;
            version = content.version || version;
            // Use file mtime as last updated
            const stat = fs.statSync(filePath);
            lastUpdated = stat.mtime.toISOString();
          } catch (err: any) {
            console.warn('[plugins] Failed to parse plugin package.json:', err.message);
          }
          break;
        }
      }

      plugins.push({ name, version, path: dirPath, lastUpdated });
    }
  } catch (err: any) {
    console.warn('[plugins] Failed to read plugins directory:', err.message);
  }

  res.json(plugins);
});

/**
 * POST /api/plugins/:id/update — stage a plugin update mutation.
 *
 * Plugins are TEMPLATE_ONLY_CONFIG_FIELDS — the config generator reads them from the
 * template at push_config time. Updating a plugin library entry therefore requires a
 * push_config + restart on every instance, so this goes through the changeset pipeline.
 */
router.post('/plugins/:id/update', requireScope('plugins:write'), (req, res) => {
  const { id } = req.params;

  // Look up by ID first, then by name
  let plugin = pluginLibraryRepo.get(id);
  if (!plugin) plugin = pluginLibraryRepo.getByName(id);
  if (!plugin) {
    res.status(404).json({ error: 'Plugin not found in library' });
    return;
  }

  const version: string | undefined = req.body?.version ?? 'latest';

  // Stage a mutation — this goes through the changeset pipeline (install_plugins + push_config + restart)
  const mutation = mutationService.stage('plugin', 'update', { version }, plugin.id);
  logActivity({ eventType: 'plugin.update.staged', detail: `Staged update for plugin "${plugin.name}" → ${version}` });

  res.json({ staged: true, mutationId: mutation.id, plugin: plugin.name, version });
});

/**
 * POST /api/plugins/update-all — stage update mutations for all plugins in the library.
 *
 * Each plugin gets its own pending mutation; the changeset pipeline will install all
 * outdated plugins in a single pass before pushing config and restarting.
 */
router.post('/plugins/update-all', requireScope('plugins:write'), (_req, res) => {
  const plugins = pluginLibraryRepo.getAll();
  if (plugins.length === 0) {
    res.json({ staged: true, count: 0, mutations: [] });
    return;
  }

  const mutations = plugins.map(plugin =>
    mutationService.stage('plugin', 'update', { version: 'latest' }, plugin.id),
  );

  logActivity({ eventType: 'plugin.update_all.staged', detail: `Staged updates for ${plugins.length} plugin(s)` });

  res.json({
    staged: true,
    count: mutations.length,
    mutations: mutations.map(m => ({ id: m.id, entityId: m.entityId })),
  });
});

export default router;
