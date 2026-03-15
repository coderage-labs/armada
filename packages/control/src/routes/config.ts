import { Router } from 'express';
import { configDiffService } from '../services/config-diff.js';
import { registerToolDef } from '../utils/tool-registry.js';

registerToolDef({
  name: 'armada_config_status',
  description: 'Get the current config version, stale instances, and pending restarts.',
  method: 'GET', path: '/api/config/status', parameters: [],
});

registerToolDef({
  name: 'armada_config_snapshot',
  description: 'Take a snapshot of the current config state (providers, models, plugins, template models).',
  method: 'GET', path: '/api/config/snapshot', parameters: [],
});

const router = Router();

// GET /api/config/status — config version + stale instances + pending restarts
router.get('/status', (_req, res) => {
  const version = configDiffService.getCurrentVersion();
  const staleInstances = configDiffService.getStaleInstances();
  
  res.json({ version, staleInstances });
});

// GET /api/config/snapshot — take a snapshot of current config
router.get('/snapshot', (_req, res) => {
  const snapshot = configDiffService.snapshot();
  res.json(snapshot);
});

export default router;
