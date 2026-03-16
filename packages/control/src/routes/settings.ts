import { Router } from 'express';
import { requireScope } from '../middleware/scopes.js';
import { settingsRepo } from '../repositories/index.js';
import { getLatestVersion } from '../services/version-checker.js';
import { logActivity } from '../services/activity-service.js';
import { registerToolDef } from '../utils/tool-registry.js';

registerToolDef({
  name: 'armada_settings_get',
  description: 'Get all armada settings (version, retention, avatar generation, sync interval).',
  method: 'GET', path: '/api/settings', parameters: [],
    scope: 'system:read',
});

registerToolDef({
  name: 'armada_settings_update',
  description: 'Update a armada setting by key.',
  method: 'PUT', path: '/api/settings',
  parameters: [
    { name: 'key', type: 'string', description: 'Setting key (armada_openclaw_version, workspace_retention_days, ai_avatar_generation, github_sync_interval_minutes, avatar_provider_id, avatar_model_id)', required: true },
    { name: 'value', type: 'string', description: 'Setting value', required: true },
  ],
    scope: 'system:write',
});

const router = Router();

// Allowlist of settings that can be managed via this API
const ALLOWED_SETTINGS = new Set([
  'armada_openclaw_version',
  'github_sync_interval_minutes',
  'workspace_retention_days',
  'ai_avatar_generation', // legacy — kept for backwards compat
  'armada_config_version',
  'avatar_provider_id',
  'avatar_model_id',
  'avatar_prompt',
]);

// GET /api/settings — return all managed settings + latest available version
router.get('/', (_req, res) => {
  const armada_openclaw_version = settingsRepo.get('armada_openclaw_version') ?? null;
  const github_sync_interval_minutes = settingsRepo.get('github_sync_interval_minutes') ?? null;
  const latestVersion = getLatestVersion();
  const workspace_retention_days_raw = settingsRepo.get('workspace_retention_days');
  const workspace_retention_days = workspace_retention_days_raw
    ? parseInt(workspace_retention_days_raw, 10) || 30
    : 30;
  const avatar_model_id = settingsRepo.get('avatar_model_id') ?? null;
  const avatar_prompt = settingsRepo.get('avatar_prompt') ?? null;

  res.json({
    armada_openclaw_version,
    github_sync_interval_minutes,
    latestVersion,
    workspace_retention_days,
    avatar_model_id,
    avatar_prompt,
  });
});

// PUT /api/settings — update a setting by key
router.put('/', requireScope('system:write'), (req, res, next) => {
  try {
    const { key, value } = req.body as { key: string; value: string | null };

    if (!key || typeof key !== 'string') {
      res.status(400).json({ error: 'Missing or invalid "key"' });
      return;
    }

    if (!ALLOWED_SETTINGS.has(key)) {
      res.status(400).json({ error: `Setting "${key}" is not allowed via this endpoint` });
      return;
    }

    if (value === null || value === '' || value === undefined) {
      // Clear the setting
      settingsRepo.remove(key);
      logActivity({ eventType: 'settings.updated', detail: `Setting "${key}" cleared` });
      res.json({ key, value: null });
      return;
    }

    if (typeof value !== 'string') {
      res.status(400).json({ error: '"value" must be a string or null' });
      return;
    }

    settingsRepo.set(key, value);
    logActivity({ eventType: 'settings.updated', detail: `Setting "${key}" updated to "${value}"` });
    res.json({ key, value });
  } catch (err) {
    next(err);
  }
});

export default router;
