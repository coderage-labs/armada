import { Router } from 'express';
import { requireScope } from '../middleware/scopes.js';
import { registerToolDef } from '../utils/tool-registry.js';
import type { NodeManager } from '../node-manager.js';

registerToolDef({
  category: 'tools',
  name: 'armada_tools_ensure',
  description: 'Ensure binary tools are installed on a node for agents. Uses eget to download from GitHub releases.',
  method: 'POST',
  path: '/api/tools/ensure',
  parameters: [
    { name: 'tools', type: 'string', description: 'GitHub repo slugs (e.g. cli/cli, jqlang/jq) — pass as JSON array', required: true },
  ],
    scope: 'system:write',
});

registerToolDef({
  category: 'tools',
  name: 'armada_tools_list',
  description: 'List binary tools installed on the node agent.',
  method: 'GET',
  path: '/api/tools',
  parameters: [],
});

registerToolDef({
  category: 'tools',
  name: 'armada_tools_update',
  description: 'Force re-download the latest version of a specific tool on the node.',
  method: 'POST',
  path: '/api/tools/update',
  parameters: [
    { name: 'tool', type: 'string', description: 'GitHub repo slug (e.g. cli/cli)', required: true },
  ],
    scope: 'system:write',
});

export function createToolRoutes(nodeManager: NodeManager): Router {
  const router = Router();

  // POST /api/tools/ensure — proxy to node agent
  router.post('/ensure', requireScope('system:write'), async (req, res, next) => {
    try {
      const node = nodeManager.getDefaultNode();
      const { tools, binDir } = req.body;
      const result = await node.ensureTools(tools, binDir || '/data/tools/bin');
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/tools — proxy to node agent
  router.get('/', async (req, res, next) => {
    try {
      const node = nodeManager.getDefaultNode();
      const result = await node.listTools(req.query.binDir as string);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // POST /api/tools/update — proxy to node agent
  router.post('/update', requireScope('system:write'), async (req, res, next) => {
    try {
      const node = nodeManager.getDefaultNode();
      const { tool, binDir } = req.body;
      const result = await node.updateTool(tool, binDir);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
