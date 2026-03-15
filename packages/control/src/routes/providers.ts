import crypto from 'node:crypto';
import { Router } from 'express';
import { requireScope } from '../middleware/scopes.js';
import { modelProviderRepo } from '../repositories/model-provider-repo.js';
import { providerApiKeyRepo } from '../repositories/provider-api-key-repo.js';
import { discoverProviderModels, discoverProviderModelsWithKey, syncProviderModels, getProviderCapabilities } from '../services/model-discovery.js';
import { logActivity } from '../services/activity-service.js';
import { registerToolDef } from '../utils/tool-registry.js';
import { workingCopy } from '../services/working-copy.js';
import type { ModelProvider, ProviderApiKey } from '@coderage-labs/armada-shared';

registerToolDef({
  name: 'fleet_providers_list',
  description: 'List all model providers (Anthropic, OpenAI, OpenRouter, Google).',
  method: 'GET', path: '/api/providers', parameters: [],
});

registerToolDef({
  name: 'fleet_provider_get',
  description: 'Get a model provider by ID.',
  method: 'GET', path: '/api/providers/:id',
  parameters: [{ name: 'id', type: 'string', description: 'Provider ID', required: true }],
});

registerToolDef({
  name: 'fleet_provider_update',
  description: 'Update a model provider (base URL, enabled state).',
  method: 'PUT', path: '/api/providers/:id',
  parameters: [
    { name: 'id', type: 'string', description: 'Provider ID', required: true },
    { name: 'baseUrl', type: 'string', description: 'Custom base URL', required: false },
    { name: 'enabled', type: 'boolean', description: 'Enable/disable provider', required: false },
  ],
});

registerToolDef({
  name: 'fleet_provider_discover_models',
  description: 'Discover available models from a provider (requires API key configured).',
  method: 'GET', path: '/api/providers/:id/models',
  parameters: [{ name: 'id', type: 'string', description: 'Provider ID', required: true }],
});

registerToolDef({
  name: 'fleet_provider_sync_models',
  description: 'Sync discovered models into the model registry from a provider.',
  method: 'POST', path: '/api/providers/:id/sync',
  parameters: [{ name: 'id', type: 'string', description: 'Provider ID', required: true }],
});

registerToolDef({
  name: 'fleet_provider_keys_list',
  description: 'List API keys for a provider (masked).',
  method: 'GET', path: '/api/providers/:id/keys',
  parameters: [{ name: 'id', type: 'string', description: 'Provider ID', required: true }],
});

registerToolDef({
  name: 'fleet_provider_key_add',
  description: 'Add a named API key to a provider.',
  method: 'POST', path: '/api/providers/:id/keys',
  parameters: [
    { name: 'id', type: 'string', description: 'Provider ID', required: true },
    { name: 'name', type: 'string', description: 'Key name (e.g. "Personal", "Work")', required: true },
    { name: 'apiKey', type: 'string', description: 'API key value', required: true },
    { name: 'isDefault', type: 'boolean', description: 'Set as default', required: false },
    { name: 'priority', type: 'number', description: 'Priority (lower = preferred)', required: false },
  ],
});

const router = Router();

function maskApiKey(key: string | null): string | null {
  if (!key) return null;
  if (key.length <= 4) return '••••••';
  return '••••••' + key.slice(-4);
}

function maskKey(k: ProviderApiKey): ProviderApiKey {
  return { ...k, apiKey: maskApiKey(k.apiKey) };
}

function sanitizeProvider(p: ModelProvider): ModelProvider & { configured: boolean } {
  const keys = providerApiKeyRepo.getByProvider(p.id);
  const configured = keys.length > 0;
  const maskedKeys = keys.map(maskKey);
  return {
    ...p,
    apiKey: undefined,
    keys: maskedKeys,
    capabilities: getProviderCapabilities(p.type),
    configured,
  } as any;
}

// POST /api/providers — create a custom provider (openai-compat only)
router.post('/', (req, res, next) => {
  try {
    const { name, baseUrl } = req.body;
    if (!name?.trim()) { res.status(400).json({ error: 'Name is required' }); return; }
    if (!baseUrl?.trim()) { res.status(400).json({ error: 'Base URL is required for custom providers' }); return; }

    const payload = {
      name: name.trim(),
      type: 'openai-compat',
      baseUrl: baseUrl.trim(),
      enabled: 1,
    };
    const id = payload.name.toLowerCase().replace(/\s+/g, '-');
    workingCopy.create('provider', id, payload);
    logActivity({ eventType: 'provider.create.staged', detail: `Staged create for provider "${name.trim()}"` });
    res.json({ ok: true, action: 'create', message: 'Staged in working copy' });
  } catch (err: any) {
    next(err);
  }
});

// DELETE /api/providers/:id — delete a custom provider (openai-compat only)
router.delete('/:id', (req, res, next) => {
  try {
    const provider = modelProviderRepo.getById(req.params.id);
    if (!provider) { res.status(404).json({ error: 'Provider not found' }); return; }
    if (provider.type !== 'openai-compat') {
      res.status(400).json({ error: 'Cannot delete built-in providers' });
      return;
    }
    workingCopy.delete('provider', req.params.id);
    logActivity({ eventType: 'provider.delete.staged', detail: `Staged delete for provider "${provider.name}"` });
    res.json({ ok: true, action: 'delete', message: 'Staged in working copy' });
  } catch (err: any) {
    next(err);
  }
});

// GET /api/providers
router.get('/', (req, res) => {
  const showHidden = req.query.showHidden === 'true';
  const all = modelProviderRepo.getAll().map(sanitizeProvider);
  res.json(showHidden ? all : all.filter((p: any) => !p.hidden));
});

// GET /api/providers/:id
router.get('/:id', (req, res) => {
  const provider = modelProviderRepo.getById(req.params.id);
  if (!provider) {
    res.status(404).json({ error: 'Provider not found' });
    return;
  }
  res.json(sanitizeProvider(provider));
});

// PUT /api/providers/:id — baseUrl, enabled, fallbackEnabled, fallbackBehavior
router.put('/:id', requireScope('system:write'), (req, res, next) => {
  try {
    const existing = modelProviderRepo.getById(req.params.id);
    if (!existing) {
      res.status(404).json({ error: 'Provider not found' });
      return;
    }
    const { baseUrl, enabled, fallbackEnabled, fallbackBehavior } = req.body;
    const updateData: any = {};
    if (baseUrl !== undefined) updateData.baseUrl = baseUrl || null;
    if (enabled !== undefined) updateData.enabled = enabled;
    if (fallbackEnabled !== undefined) updateData.fallbackEnabled = fallbackEnabled ? 1 : 0;
    if (fallbackBehavior !== undefined) {
      if (!['immediate', 'backoff'].includes(fallbackBehavior)) {
        res.status(400).json({ error: 'fallbackBehavior must be "immediate" or "backoff"' });
        return;
      }
      updateData.fallbackBehavior = fallbackBehavior;
    }

    workingCopy.update('provider', req.params.id, updateData);

    if (fallbackEnabled !== undefined) {
      logActivity({
        eventType: 'provider.fallback.staged',
        detail: `Staged fallback ${fallbackEnabled ? 'enable' : 'disable'} for provider "${existing.name}"`,
      });
    } else {
      logActivity({ eventType: 'provider.update.staged', detail: `Staged update for provider "${existing.name}"` });
    }
    res.json({ ok: true, action: 'update', message: 'Staged in working copy' });
  } catch (err) {
    next(err);
  }
});

// ── Key management routes ──────────────────────────────────────────

// GET /api/providers/:id/keys
router.get('/:id/keys', (req, res) => {
  const provider = modelProviderRepo.getById(req.params.id);
  if (!provider) {
    res.status(404).json({ error: 'Provider not found' });
    return;
  }
  res.json(providerApiKeyRepo.getByProvider(req.params.id).map(maskKey));
});

// POST /api/providers/:id/keys
router.post('/:id/keys', requireScope('system:write'), (req, res, next) => {
  try {
    const provider = modelProviderRepo.getById(req.params.id);
    if (!provider) {
      res.status(404).json({ error: 'Provider not found' });
      return;
    }
    const { name, apiKey, isDefault, priority } = req.body;
    if (!name || !apiKey) {
      res.status(400).json({ error: 'name and apiKey are required' });
      return;
    }
    // Check for duplicate key name on this provider
    const existingKeys = providerApiKeyRepo.getByProvider(req.params.id);
    if (existingKeys.some(k => k.name.toLowerCase() === name.trim().toLowerCase())) {
      res.status(409).json({ error: `API key "${name}" already exists for provider "${provider.name}"` });
      return;
    }
    const payload = {
      providerId: req.params.id,
      name,
      apiKey,
      isDefault: isDefault ? 1 : 0,
      priority: priority ?? 0,
    };
    const keyId = crypto.randomUUID();
    workingCopy.create('api_key', keyId, { ...payload, id: keyId });
    logActivity({ eventType: 'provider.key.add.staged', detail: `Staged API key "${name}" addition for provider "${provider.name}"` });
    res.json({ ok: true, action: 'create', message: 'Staged in working copy' });
  } catch (err) {
    next(err);
  }
});

// PUT /api/providers/:id/keys/:keyId/priority — set key priority order (#303)
router.put('/:id/keys/:keyId/priority', requireScope('system:write'), (req, res, next) => {
  try {
    const provider = modelProviderRepo.getById(req.params.id);
    if (!provider) {
      res.status(404).json({ error: 'Provider not found' });
      return;
    }
    const key = providerApiKeyRepo.getById(req.params.keyId);
    if (!key || key.providerId !== req.params.id) {
      res.status(404).json({ error: 'API key not found' });
      return;
    }
    const { priority } = req.body;
    if (priority === undefined || typeof priority !== 'number') {
      res.status(400).json({ error: 'priority (number) is required' });
      return;
    }
    workingCopy.update('api_key', req.params.keyId, { priority });
    logActivity({
      eventType: 'provider.key.priority.staged',
      detail: `Staged priority ${priority} for key "${key.name}" on provider "${provider.name}"`,
    });
    res.json({ ok: true, action: 'update', message: 'Staged in working copy' });
  } catch (err) {
    next(err);
  }
});

// PUT /api/providers/:id/keys/:keyId
router.put('/:id/keys/:keyId', requireScope('system:write'), (req, res, next) => {
  try {
    const provider = modelProviderRepo.getById(req.params.id);
    if (!provider) {
      res.status(404).json({ error: 'Provider not found' });
      return;
    }
    const { name, apiKey, isDefault, priority } = req.body;
    const updateData: any = {};
    if (name !== undefined) updateData.name = name;
    if (apiKey !== undefined) updateData.apiKey = apiKey;
    if (isDefault !== undefined) updateData.isDefault = isDefault ? 1 : 0;
    if (priority !== undefined) updateData.priority = priority;

    workingCopy.update('api_key', req.params.keyId, updateData);
    logActivity({ eventType: 'provider.key.update.staged', detail: `Staged API key update for provider "${provider.name}"` });
    res.json({ ok: true, action: 'update', message: 'Staged in working copy' });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/providers/:id/keys/:keyId
router.delete('/:id/keys/:keyId', requireScope('system:write'), (req, res, next) => {
  try {
    const provider = modelProviderRepo.getById(req.params.id);
    if (!provider) {
      res.status(404).json({ error: 'Provider not found' });
      return;
    }
    workingCopy.delete('api_key', req.params.keyId);
    logActivity({ eventType: 'provider.key.delete.staged', detail: `Staged API key deletion from provider "${provider.name}"` });
    res.json({ ok: true, action: 'delete', message: 'Staged in working copy' });
  } catch (err) {
    next(err);
  }
});

// Set default handled by the working copy route below

// POST /api/providers/:id/keys/:keyId/test — test a specific API key
router.post('/:id/keys/:keyId/test', requireScope('system:write'), async (req, res, next) => {
  try {
    const provider = modelProviderRepo.getById(req.params.id);
    if (!provider) {
      res.status(404).json({ error: 'Provider not found' });
      return;
    }
    const key = providerApiKeyRepo.getById(req.params.keyId);
    if (!key || key.providerId !== req.params.id) {
      res.status(404).json({ error: 'API key not found' });
      return;
    }
    // Use discoverProviderModels-like logic but with this specific key
    if (!key.apiKey) {
      res.json({ ok: false, message: 'API key value is empty' });
      return;
    }
    const models = await discoverProviderModelsWithKey(provider, key.apiKey);
    res.json({ ok: true, message: `Connected — ${models.length} models available` });
  } catch (err: any) {
    res.json({ ok: false, message: err.message || 'Connection failed' });
  }
});

// GET /api/providers/:id/models?q=search — discover/search models from this provider
router.get('/:id/models', async (req, res, next) => {
  try {
    const provider = modelProviderRepo.getById(req.params.id);
    if (!provider) {
      res.status(404).json({ error: 'Provider not found' });
      return;
    }
    const query = (req.query.q as string) || undefined;
    const models = await discoverProviderModels(req.params.id, query);
    res.json(models);
  } catch (err: any) {
    next(err);
  }
});

// POST /api/providers/:id/sync
router.post('/:id/sync', requireScope('system:write'), async (req, res, next) => {
  try {
    const provider = modelProviderRepo.getById(req.params.id);
    if (!provider) {
      res.status(404).json({ error: 'Provider not found' });
      return;
    }
    const result = await syncProviderModels(req.params.id);
    logActivity({ eventType: 'provider.synced', detail: `Model provider "${provider.name}" synced: ${result.count} models discovered` });
    res.json({ success: true, count: result.count });
  } catch (err) {
    next(err);
  }
});

// ── Set default API key (mutex flag via working copy) ──

router.post('/:id/keys/:keyId/default', requireScope('system:write'), (req, res, next) => {
  try {
    const { id: providerId, keyId } = req.params;
    workingCopy.setMutexFlag('api_key', keyId, 'isDefault', providerId);
    const diff = workingCopy.diff('api_key', keyId);
    res.json({ ok: true, action: diff.action, fields: diff.fields });
  } catch (err) {
    next(err);
  }
});

export default router;
