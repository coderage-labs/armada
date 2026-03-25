import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { requireScope } from '../middleware/scopes.js';
import { templatesRepo } from '../repositories/index.js';
import { isValidName, isValidMemory, isValidCpus } from '../utils/validate.js';
import { registerToolDef } from '../utils/tool-registry.js';
import { logActivity } from '../services/activity-service.js';
import { logAudit } from '../services/audit.js';
import { parseJsonField } from '../utils/parse-json-field.js';
import { eventBus } from '../infrastructure/event-bus.js';
import { computeTemplateDrift, syncTemplateToAgents } from '../services/template-sync.js';
import { changesetService } from '../services/changeset-service.js';
import { workingCopy } from '../services/working-copy.js';
import { mutationService } from '../services/mutation-service.js';

const router = Router();

registerToolDef({
  category: 'workflows',
  name: 'armada_templates',
  description: 'List all armada templates. Shows template ID, name, role, and model.',
  method: 'GET', path: '/api/templates',
  parameters: [],
    scope: 'templates:read',
});

registerToolDef({
  category: 'workflows',
  name: 'armada_template_get',
  description: 'Get a single armada template by ID. Returns full template details including soul, agents, plugins, etc.',
  method: 'GET', path: '/api/templates/:id',
  parameters: [
    { name: 'id', type: 'string', description: 'Template ID', required: true },
  ],
    scope: 'templates:read',
});

registerToolDef({
  category: 'workflows',
  name: 'armada_template_create',
  description: 'Create a new armada template. Defines the blueprint for spawning agents.',
  method: 'POST', path: '/api/templates',
  parameters: [
    { name: 'name', type: 'string', description: 'Template name (lowercase, alphanumeric, hyphens)', required: true },
    { name: 'description', type: 'string', description: 'Human-readable description' },
    { name: 'role', type: 'string', description: 'Agent role (e.g. development, research, project-manager)' },
    { name: 'skills', type: 'string', description: 'Comma-separated skills' },
    { name: 'model', type: 'string', description: 'LLM model identifier' },
    { name: 'soul', type: 'string', description: 'SOUL.md content — the agent personality' },
    { name: 'agents', type: 'string', description: 'AGENTS.md content — agent instructions' },
  ],
    scope: 'templates:write',
});

registerToolDef({
  category: 'workflows',
  name: 'armada_template_update',
  description: 'Update an existing armada template. Only provided fields are changed.',
  method: 'PUT', path: '/api/templates/:id',
  parameters: [
    { name: 'id', type: 'string', description: 'Template ID', required: true },
    { name: 'name', type: 'string', description: 'Template name' },
    { name: 'description', type: 'string', description: 'Description' },
    { name: 'role', type: 'string', description: 'Agent role' },
    { name: 'skills', type: 'string', description: 'Comma-separated skills' },
    { name: 'model', type: 'string', description: 'LLM model identifier' },
    { name: 'soul', type: 'string', description: 'SOUL.md content' },
    { name: 'agents', type: 'string', description: 'AGENTS.md content' },
  ],
    scope: 'templates:write',
});

registerToolDef({
  category: 'workflows',
  name: 'armada_template_delete',
  description: 'Delete a armada template by ID.',
  method: 'DELETE', path: '/api/templates/:id',
  parameters: [
    { name: 'id', type: 'string', description: 'Template ID to delete', required: true },
  ],
    scope: 'templates:write',
});

// GET /api/templates
router.get('/', (_req, res) => {
  res.json(templatesRepo.getAll());
});

// GET /api/templates/:id
router.get('/:id', (req, res) => {
  const template = templatesRepo.getById(req.params.id);
  if (!template) {
    res.status(404).json({ error: 'Template not found' });
    return;
  }
  res.json(template);
});

// POST /api/templates
router.post('/', requireScope('templates:write'), (req, res, next) => {
  try {
    const { name, description, image, role, skills, model, resources, plugins, pluginsList, skillsList, toolsAllow, toolsProfile, soul, agents, env, internalAgents, tools, projects } = req.body;

    if (!name || !isValidName(name)) {
      res.status(400).json({ error: 'Invalid name — must be lowercase alphanumeric with hyphens' });
      return;
    }

    if (resources) {
      if (resources.memory && !isValidMemory(resources.memory)) {
        res.status(400).json({ error: 'Invalid memory — max 16g' });
        return;
      }
      if (resources.cpus && !isValidCpus(resources.cpus)) {
        res.status(400).json({ error: 'Invalid cpus — max 8' });
        return;
      }
    }

    const id = randomUUID();
    workingCopy.create('template', id, {
      name,
      description: description ?? '',
      image: image ?? '',
      role: role ?? '',
      skills: skills ?? '',
      model: model ?? '',
      resources: resources ?? { memory: '2g', cpus: '1' },
      plugins: parseJsonField(plugins) ?? [],
      pluginsList: parseJsonField(pluginsList) ?? [],
      skillsList: parseJsonField(skillsList) ?? [],
      toolsAllow: parseJsonField(toolsAllow) ?? [],
      toolsProfile: toolsProfile ?? '',
      soul: soul ?? '',
      agents: agents ?? '',
      env: parseJsonField(env) ?? [],
      internalAgents: parseJsonField(internalAgents) ?? [],
      tools: parseJsonField(tools) ?? [],
      projects: parseJsonField(projects) ?? [],
    });

    logActivity({ eventType: 'template.created', detail: `Template "${name}" staged for creation` });
    logAudit(req, 'template.create', 'template', id, { name });
    res.status(200).json({ ok: true, action: 'create', message: 'Staged in working copy' });
  } catch (err) {
    next(err);
  }
});

// PUT /api/templates/:id
router.put('/:id', requireScope('templates:write'), (req, res, next) => {
  try {
    const existing = templatesRepo.getById(req.params.id);
    if (!existing) {
      res.status(404).json({ error: 'Template not found' });
      return;
    }

    const { name, resources } = req.body;

    if (name !== undefined && !isValidName(name)) {
      res.status(400).json({ error: 'Invalid name — must be lowercase alphanumeric with hyphens' });
      return;
    }

    if (resources) {
      if (resources.memory && !isValidMemory(resources.memory)) {
        res.status(400).json({ error: 'Invalid memory — max 16g' });
        return;
      }
      if (resources.cpus && !isValidCpus(resources.cpus)) {
        res.status(400).json({ error: 'Invalid cpus — max 8' });
        return;
      }
    }

    // Normalise JSON-string fields from tool calls
    const body = { ...req.body };
    for (const key of ['plugins', 'pluginsList', 'skillsList', 'toolsAllow', 'env', 'internalAgents', 'tools', 'projects', 'resources'] as const) {
      if (body[key] !== undefined) body[key] = parseJsonField(body[key]);
    }
    
    // Update working copy for UI diff preview
    workingCopy.update('template', req.params.id, body);
    
    // Stage a mutation so changesets can pick it up
    mutationService.stage('template', 'update', body, req.params.id);
    
    logActivity({ eventType: 'template.updated', detail: `Template "${existing.name}" staged for update` });
    eventBus.emit('template.updated', { templateId: req.params.id });
    logAudit(req, 'template.update', 'template', req.params.id, { name: existing.name });
    res.json({ ok: true, action: 'update', message: 'Staged — create and apply a changeset to commit' });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/templates/:id
router.delete('/:id', requireScope('templates:write'), (req, res) => {
  const template = templatesRepo.getById(req.params.id);
  if (!template) {
    res.status(404).json({ error: 'Template not found' });
    return;
  }
  workingCopy.delete('template', req.params.id);
  logActivity({ eventType: 'template.deleted', detail: `Template "${template.name}" staged for deletion` });
  logAudit(req, 'template.delete', 'template', req.params.id, { name: template.name });
  res.json({ ok: true, action: 'delete', message: 'Staged in working copy' });
});

// GET /api/templates/:id/drift — check which agents have drifted from template
router.get('/:id/drift', (req, res, next) => {
  try {
    const template = templatesRepo.getById(req.params.id);
    if (!template) {
      res.status(404).json({ error: 'Template not found' });
      return;
    }

    const drift = computeTemplateDrift(req.params.id);
    res.json(drift);
  } catch (err) {
    next(err);
  }
});

// POST /api/templates/:id/sync — sync template to agents
router.post('/:id/sync', requireScope('templates:write'), (req, res, next) => {
  try {
    const template = templatesRepo.getById(req.params.id);
    if (!template) {
      res.status(404).json({ error: 'Template not found' });
      return;
    }

    // Sync template to agents (stages mutations)
    const syncResult = syncTemplateToAgents(req.params.id);

    // Get or create draft changeset
    const changeset = changesetService.list(20).find(c => c.status === 'draft');

    const summary = {
      configChanges: [] as string[],
      fileChanges: [] as string[],
      dbOnly: [] as string[],
    };

    // Summarize what changed across all agents
    for (const agent of syncResult.drift.filter(d => d.drifted)) {
      for (const diff of agent.diffs) {
        const field = diff.field;
        if (diff.category === 'config' && !summary.configChanges.includes(field)) {
          summary.configChanges.push(field);
        } else if (diff.category === 'workspace' && !summary.fileChanges.includes(field)) {
          summary.fileChanges.push(field);
        } else if (diff.category === 'db-only' && !summary.dbOnly.includes(field)) {
          summary.dbOnly.push(field);
        }
      }
    }

    logActivity({
      eventType: 'template.synced',
      detail: `Template "${template.name}" synced to ${syncResult.agentsAffected} agent(s)`,
    });

    res.json({
      changesetId: changeset?.id,
      agentsAffected: syncResult.agentsAffected,
      summary,
      instanceOps: changeset?.plan?.instanceOps ?? [],
    });
  } catch (err) {
    next(err);
  }
});

registerToolDef({
  category: 'workflows',
  name: 'armada_template_drift',
  description: 'Check which agents have drifted from their template. Shows field-level differences.',
  method: 'GET', path: '/api/templates/:id/drift',
  parameters: [
    { name: 'id', type: 'string', description: 'Template ID', required: true },
  ],
    scope: 'templates:read',
});

registerToolDef({
  category: 'workflows',
  name: 'armada_template_sync',
  description: 'Sync a template to all agents using it. Stages pending mutations and creates/updates a draft changeset.',
  method: 'POST', path: '/api/templates/:id/sync',
  parameters: [
    { name: 'id', type: 'string', description: 'Template ID', required: true },
  ],
    scope: 'templates:write',
});

export default router;
