/**
 * Inbound Webhooks
 *
 * Two sets of routes:
 *
 * 1. Management API (authenticated): CRUD for webhook configs under /api/webhooks/inbound
 * 2. Receiver (public): POST /hooks/:hookId — external services trigger actions here
 */

import { Router } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { requireScope } from '../middleware/scopes.js';
import { webhooksInboundRepo } from '../repositories/index.js';
import { registerToolDef } from '../utils/tool-registry.js';
import { eventBus } from '../infrastructure/event-bus.js';

// ── Management router (mounted at /api/webhooks/inbound) ──────────────

const mgmtRouter = Router();

registerToolDef({
  category: 'integrations',
  name: 'armada_inbound_webhooks_list',
  scope: 'webhooks:read',
  description: 'List all configured inbound webhooks.',
  method: 'GET',
  path: '/api/webhooks/inbound',
  parameters: [],
});

registerToolDef({
  category: 'integrations',
  name: 'armada_inbound_webhooks_create',
  description: 'Create an inbound webhook that external services can POST to, triggering a workflow, task, or event.',
  method: 'POST',
  path: '/api/webhooks/inbound',
  parameters: [
    { name: 'name', type: 'string', description: 'Display name for this webhook', required: true },
    { name: 'action', type: 'string', description: 'Action to trigger: workflow | task | event', required: true },
    { name: 'actionConfig', type: 'string', description: 'Action configuration JSON string (workflowId, projectId, etc.)', required: false },
    { name: 'secret', type: 'string', description: 'Optional HMAC-SHA256 secret for request verification', required: false },
  ],
    scope: 'webhooks:write',
});

registerToolDef({
  category: 'integrations',
  name: 'armada_inbound_webhooks_update',
  description: 'Update an inbound webhook configuration.',
  method: 'PUT',
  path: '/api/webhooks/inbound/:id',
  parameters: [
    { name: 'id', type: 'string', description: 'Webhook ID', required: true },
    { name: 'name', type: 'string', description: 'Display name', required: false },
    { name: 'action', type: 'string', description: 'Action type', required: false },
    { name: 'actionConfig', type: 'string', description: 'Action config JSON', required: false },
    { name: 'secret', type: 'string', description: 'HMAC secret', required: false },
    { name: 'enabled', type: 'boolean', description: 'Whether the webhook is enabled', required: false },
  ],
    scope: 'webhooks:write',
});

registerToolDef({
  category: 'integrations',
  name: 'armada_inbound_webhooks_delete',
  description: 'Delete an inbound webhook.',
  method: 'DELETE',
  path: '/api/webhooks/inbound/:id',
  parameters: [
    { name: 'id', type: 'string', description: 'Webhook ID', required: true },
  ],
    scope: 'webhooks:write',
});

// GET /api/webhooks/inbound
mgmtRouter.get('/', (_req, res) => {
  const hooks = webhooksInboundRepo.getAll();
  const safe = hooks.map(h => ({ ...h, secret: h.secret ? '••••••' : null }));
  res.json(safe);
});

// POST /api/webhooks/inbound
mgmtRouter.post('/', requireScope('webhooks:write'), (req, res) => {
  const { name, action, actionConfig, secret } = req.body;

  if (!name || typeof name !== 'string') {
    res.status(400).json({ error: 'name is required' });
    return;
  }
  if (!['workflow', 'task', 'event'].includes(action)) {
    res.status(400).json({ error: 'action must be one of: workflow, task, event' });
    return;
  }

  const hookId = crypto.randomUUID().replace(/-/g, '').slice(0, 24);
  const hook = webhooksInboundRepo.create({
    name,
    hookId,
    secret: secret || undefined,
    action,
    actionConfig: actionConfig ?? {},
  });

  res.status(201).json({ ...hook, secret: hook.secret ? '••••••' : null });
});

// PUT /api/webhooks/inbound/:id
mgmtRouter.put('/:id', requireScope('webhooks:write'), (req, res) => {
  const existing = webhooksInboundRepo.get(req.params.id);
  if (!existing) {
    res.status(404).json({ error: 'Webhook not found' });
    return;
  }

  const { name, action, actionConfig, secret, enabled } = req.body;
  if (action !== undefined && !['workflow', 'task', 'event'].includes(action)) {
    res.status(400).json({ error: 'action must be one of: workflow, task, event' });
    return;
  }

  const updated = webhooksInboundRepo.update(req.params.id, {
    ...(name !== undefined ? { name } : {}),
    ...(action !== undefined ? { action } : {}),
    ...(actionConfig !== undefined ? { actionConfig } : {}),
    ...(secret !== undefined ? { secret } : {}),
    ...(enabled !== undefined ? { enabled } : {}),
  });

  res.json({ ...updated, secret: updated.secret ? '••••••' : null });
});

// DELETE /api/webhooks/inbound/:id
mgmtRouter.delete('/:id', requireScope('webhooks:write'), (req, res) => {
  const existing = webhooksInboundRepo.get(req.params.id);
  if (!existing) {
    res.status(404).json({ error: 'Webhook not found' });
    return;
  }
  webhooksInboundRepo.delete(req.params.id);
  res.status(204).end();
});

export { mgmtRouter as webhooksInboundMgmtRouter };

// ── Public receiver router (mounted at /hooks) ────────────────────────

const receiverRouter = Router();

/**
 * POST /hooks/:hookId — public endpoint for external services.
 *
 * Supports HMAC-SHA256 verification via X-Hub-Signature-256 or X-Armada-Signature header.
 */
receiverRouter.post('/:hookId', async (req, res) => {
  const { hookId } = req.params;

  // 1. Look up webhook config
  const hook = webhooksInboundRepo.getByHookId(hookId);
  if (!hook) {
    res.status(404).json({ error: 'Webhook not found' });
    return;
  }
  if (!hook.enabled) {
    res.status(410).json({ error: 'Webhook is disabled' });
    return;
  }

  // 2. Verify HMAC signature if a secret is configured
  if (hook.secret) {
    const rawBody = JSON.stringify(req.body);
    const sigHeader =
      (req.headers['x-hub-signature-256'] as string | undefined) ||
      (req.headers['x-armada-signature'] as string | undefined);

    if (!sigHeader) {
      res.status(401).json({ error: 'Missing signature header (X-Hub-Signature-256 or X-Armada-Signature)' });
      return;
    }

    const sig = sigHeader.startsWith('sha256=') ? sigHeader.slice(7) : sigHeader;
    const expected = createHmac('sha256', hook.secret).update(rawBody).digest('hex');

    let sigValid = false;
    try {
      sigValid = timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
    } catch (err: any) {
      console.warn('[webhooks-inbound] Signature comparison failed:', err.message);
    }

    if (!sigValid) {
      res.status(401).json({ error: 'Invalid signature' });
      return;
    }
  }

  // 3. Parse payload
  const payload = req.body ?? {};

  // 4. Trigger configured action
  try {
    switch (hook.action) {
      case 'workflow': {
        const { workflowId, projectId, vars } = hook.actionConfig as any;
        if (!workflowId) {
          res.status(500).json({ error: 'actionConfig.workflowId is required for workflow action' });
          return;
        }

        // Dynamically import to avoid circular deps
        const { getWorkflowById, startRun } = await import('../services/workflow-engine.js');
        const wf = getWorkflowById(workflowId);

        if (!wf) {
          res.status(500).json({ error: `Workflow ${workflowId} not found` });
          return;
        }
        if (!wf.enabled) {
          res.status(400).json({ error: 'Workflow is disabled' });
          return;
        }

        const mergedVars = { ...((vars as Record<string, any>) ?? {}), payload };
        const run = await startRun(wf, 'api', hookId, mergedVars, projectId ?? undefined);

        // 5. Log the delivery
        webhooksInboundRepo.recordDelivery(hook.id);
        eventBus.emit('webhook.inbound.delivered', { hookId, hookName: hook.name, action: hook.action, runId: run.id });

        res.status(202).json({ ok: true, action: 'workflow', runId: run.id });
        break;
      }

      case 'task': {
        const { fromAgent, toAgent, taskText, projectId } = hook.actionConfig as any;

        const { tasksRepo } = await import('../repositories/index.js');
        const task = tasksRepo.create({
          fromAgent: fromAgent ?? 'webhook',
          toAgent: toAgent ?? '',
          taskText: taskText ?? `Webhook triggered: ${hook.name}\n\nPayload:\n${JSON.stringify(payload, null, 2)}`,
          result: null,
          status: 'pending',
          ...(projectId ? { projectId } : {}),
        });

        // 5. Log the delivery
        webhooksInboundRepo.recordDelivery(hook.id);
        eventBus.emit('webhook.inbound.delivered', { hookId, hookName: hook.name, action: hook.action, taskId: task.id });

        res.status(202).json({ ok: true, action: 'task', taskId: task.id });
        break;
      }

      case 'event': {
        const { eventName } = hook.actionConfig as any;
        const name = eventName ?? `webhook.inbound.${hookId}`;

        eventBus.emit(name, { hookId, hookName: hook.name, payload });

        // 5. Log the delivery
        webhooksInboundRepo.recordDelivery(hook.id);
        eventBus.emit('webhook.inbound.delivered', { hookId, hookName: hook.name, action: hook.action, eventName: name });

        res.status(202).json({ ok: true, action: 'event', eventName: name });
        break;
      }

      default:
        res.status(500).json({ error: `Unknown action: ${hook.action}` });
    }
  } catch (err: any) {
    console.error('[inbound-webhook] Error processing delivery:', err);
    res.status(500).json({ error: err.message ?? 'Internal error' });
  }
});

export { receiverRouter as webhooksInboundReceiverRouter };
