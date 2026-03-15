import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { requireScope } from '../middleware/scopes.js';
import { modelRegistryRepo, modelProviderRepo } from '../repositories/index.js';
import { usageRepo, type UsagePeriod } from '../repositories/usage-repo.js';
import { registerToolDef } from '../utils/tool-registry.js';
import { logActivity } from '../services/activity-service.js';
import { workingCopy } from '../services/working-copy.js';

const VALID_PERIODS = new Set<string>(['day', 'week', 'month', 'all']);
function parsePeriod(raw: unknown): UsagePeriod {
  if (typeof raw === 'string' && VALID_PERIODS.has(raw)) return raw as UsagePeriod;
  return 'all';
}

const router = Router();

registerToolDef({
  name: 'armada_models_list',
  description: 'List all models in the armada model registry.',
  method: 'GET', path: '/api/models',
  parameters: [],
});

registerToolDef({
  name: 'armada_model_get',
  description: 'Get a single model from the registry by ID.',
  method: 'GET', path: '/api/models/:id',
  parameters: [
    { name: 'id', type: 'string', description: 'Model ID', required: true },
  ],
});

registerToolDef({
  name: 'armada_model_create',
  description: 'Add a new model to the registry.',
  method: 'POST', path: '/api/models',
  parameters: [
    { name: 'name', type: 'string', description: 'Human-readable name (unique)', required: true },
    { name: 'provider', type: 'string', description: 'Provider (anthropic, openai, google, etc.)', required: true },
    { name: 'modelId', type: 'string', description: 'Model identifier (e.g. claude-sonnet-4-5)', required: true },
    { name: 'description', type: 'string', description: 'Description' },
    { name: 'apiKeyEnvVar', type: 'string', description: 'Environment variable for API key' },
    { name: 'capabilities', type: 'string', description: 'JSON array of capabilities (tools, thinking, vision)' },
    { name: 'maxTokens', type: 'number', description: 'Max tokens' },
    { name: 'costTier', type: 'string', description: 'Cost tier: cheap, standard, premium' },
  ],
});

registerToolDef({
  name: 'armada_model_update',
  description: 'Update a model in the registry.',
  method: 'PUT', path: '/api/models/:id',
  parameters: [
    { name: 'id', type: 'string', description: 'Model ID', required: true },
    { name: 'name', type: 'string', description: 'Human-readable name' },
    { name: 'provider', type: 'string', description: 'Provider' },
    { name: 'modelId', type: 'string', description: 'Model identifier' },
    { name: 'description', type: 'string', description: 'Description' },
    { name: 'apiKeyEnvVar', type: 'string', description: 'Environment variable for API key' },
    { name: 'capabilities', type: 'string', description: 'JSON array of capabilities' },
    { name: 'maxTokens', type: 'number', description: 'Max tokens' },
    { name: 'costTier', type: 'string', description: 'Cost tier' },
  ],
});

registerToolDef({
  name: 'armada_model_delete',
  description: 'Delete a model from the registry.',
  method: 'DELETE', path: '/api/models/:id',
  parameters: [
    { name: 'id', type: 'string', description: 'Model ID to delete', required: true },
  ],
});

// GET /api/models
router.get('/', (req, res) => {
  const period = parsePeriod(req.query.period);
  const models = modelRegistryRepo.getAll();
  const usageMap = usageRepo.getAllModelsSummary(period);
  const result = models.map(m => ({
    ...m,
    usage: usageMap.get(m.id) ?? { totalTokens: 0, requestCount: 0, lastUsed: null },
  }));
  res.json(result);
});

// GET /api/models/:id/usage
router.get('/:id/usage', (req, res) => {
  const model = modelRegistryRepo.getById(req.params.id);
  if (!model) {
    res.status(404).json({ error: 'Model not found' });
    return;
  }
  const period = parsePeriod(req.query.period);
  const usage = usageRepo.getByModel(model.id, period);
  res.json({ period, modelId: model.id, ...usage });
});

// GET /api/models/:id
router.get('/:id', (req, res) => {
  const model = modelRegistryRepo.getById(req.params.id);
  if (!model) {
    res.status(404).json({ error: 'Model not found' });
    return;
  }
  res.json(model);
});

// POST /api/models
router.post('/', requireScope('models:write'), (req, res, next) => {
  try {
    const { name, provider, modelId, description, apiKeyEnvVar, capabilities, maxTokens, costTier, providerId } = req.body;

    if (!name || !provider || !modelId) {
      res.status(400).json({ error: 'name, provider, and modelId are required' });
      return;
    }

    if (providerId) {
      const providerExists = modelProviderRepo.getById(providerId);
      if (!providerExists) {
        res.status(400).json({ error: `Provider "${providerId}" not found` });
        return;
      }
    }

    const parsedCapabilities = typeof capabilities === 'string' ? JSON.parse(capabilities) : capabilities;

    const id = randomUUID();
    workingCopy.create('model', id, {
      name,
      provider,
      modelId,
      description,
      apiKeyEnvVar: apiKeyEnvVar ?? null,
      capabilities: parsedCapabilities ?? [],
      maxTokens: maxTokens ?? null,
      costTier: costTier ?? 'standard',
      providerId: providerId ?? null,
    });

    logActivity({ eventType: 'model.created', detail: `Model "${name}" staged for creation` });
    res.status(201).json({ ok: true, action: 'create', message: 'Staged in working copy' });
  } catch (err) {
    next(err);
  }
});

// PUT /api/models/:id
router.put('/:id', requireScope('models:write'), (req, res, next) => {
  try {
    const existing = modelRegistryRepo.getById(req.params.id);
    if (!existing) {
      res.status(404).json({ error: 'Model not found' });
      return;
    }

    const { capabilities, providerId, ...rest } = req.body;
    const updateData: Record<string, any> = { ...rest };
    if (capabilities !== undefined) {
      updateData.capabilities = typeof capabilities === 'string' ? JSON.parse(capabilities) : capabilities;
    }
    if (providerId !== undefined) updateData.providerId = providerId ?? null;

    workingCopy.update('model', req.params.id, updateData);
    logActivity({ eventType: 'model.updated', detail: `Model "${existing.name}" staged for update` });
    res.json({ ok: true, action: 'update', message: 'Staged in working copy' });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/models/:id
router.delete('/:id', requireScope('models:write'), (req, res) => {
  const model = modelRegistryRepo.getById(req.params.id);
  if (!model) {
    res.status(404).json({ error: 'Model not found' });
    return;
  }
  workingCopy.delete('model', req.params.id);
  logActivity({ eventType: 'model.deleted', detail: `Model "${model.name}" staged for deletion` });
  res.json({ ok: true, action: 'delete', message: 'Staged in working copy' });
});

export default router;
