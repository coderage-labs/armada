import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { requireScope } from '../middleware/scopes.js';
import { webhooksRepo } from '../repositories/index.js';
import { webhookDeliveryRepo } from '../repositories/webhook-delivery-repo.js';
import { registerToolDef } from '../utils/tool-registry.js';
import { getEventsByCategory } from '../utils/event-catalog.js';
import { workingCopy } from '../services/working-copy.js';
import { retryDelivery } from '../services/webhook-dispatcher.js';
import type { Webhook } from '@coderage-labs/armada-shared';

const router = Router();

// ── Tool definitions ─────────────────────────────────────────────────

registerToolDef({
  name: 'armada_webhooks_list',
  description: 'List all configured webhooks.',
  method: 'GET',
  path: '/api/webhooks',
  parameters: [],
    scope: 'webhooks:read',
});

registerToolDef({
  name: 'armada_webhooks_create',
  description: 'Create a new webhook that receives POST notifications for armada events.',
  method: 'POST',
  path: '/api/webhooks',
  parameters: [
    { name: 'url', type: 'string', description: 'Webhook URL to receive POST notifications', required: true },
    { name: 'events', type: 'string', description: 'Comma-separated event types to subscribe to, or * for all', required: false },
    { name: 'secret', type: 'string', description: 'Optional shared secret for HMAC-SHA256 signature verification', required: false },
  ],
    scope: 'webhooks:write',
});

registerToolDef({
  name: 'armada_webhooks_update',
  description: 'Update a webhook configuration.',
  method: 'PUT',
  path: '/api/webhooks/:id',
  parameters: [
    { name: 'id', type: 'string', description: 'Webhook ID', required: true },
    { name: 'url', type: 'string', description: 'Webhook URL', required: false },
    { name: 'events', type: 'string', description: 'Comma-separated event types or *', required: false },
    { name: 'secret', type: 'string', description: 'Shared secret for HMAC-SHA256 signatures', required: false },
    { name: 'enabled', type: 'boolean', description: 'Whether the webhook is enabled', required: false },
  ],
    scope: 'webhooks:write',
});

registerToolDef({
  name: 'armada_webhooks_delete',
  description: 'Delete a webhook.',
  method: 'DELETE',
  path: '/api/webhooks/:id',
  parameters: [
    { name: 'id', type: 'string', description: 'Webhook ID', required: true },
  ],
    scope: 'webhooks:write',
});

registerToolDef({
  name: 'armada_webhooks_test',
  description: 'Send a test payload to a webhook to verify it is reachable.',
  method: 'POST',
  path: '/api/webhooks/:id/test',
  parameters: [
    { name: 'id', type: 'string', description: 'Webhook ID', required: true },
  ],
    scope: 'webhooks:write',
});

registerToolDef({
  name: 'armada_webhooks_events',
  description: 'List all available webhook event types, grouped by category.',
  method: 'GET',
  path: '/api/webhooks/events',
  parameters: [],
    scope: 'webhooks:read',
});

// ── Routes ───────────────────────────────────────────────────────────

// GET /api/webhooks/events — list available event types grouped by category
router.get('/events', (_req, res) => {
  res.json(getEventsByCategory());
});

// GET /api/webhooks — list all webhooks
router.get('/', (_req, res) => {
  const webhooks = webhooksRepo.getAll();
  // Strip secrets from response
  const safe = webhooks.map(w => ({ ...w, secret: w.secret ? '••••••' : null }));
  res.json(safe);
});

// POST /api/webhooks — create webhook
router.post('/', requireScope('webhooks:write'), (req, res) => {
  const { url, events, secret } = req.body;
  if (!url || typeof url !== 'string') {
    res.status(400).json({ error: 'url is required' });
    return;
  }
  try {
    new URL(url);
  } catch (err: any) {
    console.warn('[webhooks] Invalid URL:', err.message);
    res.status(400).json({ error: 'Invalid URL' });
    return;
  }
  const id = randomUUID();
  workingCopy.create('webhook', id, { url, events, secret });
  res.status(201).json({ ok: true, action: 'create', message: 'Staged in working copy' });
});

// PUT /api/webhooks/:id — update webhook
router.put('/:id', requireScope('webhooks:write'), (req, res) => {
  const existing = webhooksRepo.get(req.params.id);
  if (!existing) {
    res.status(404).json({ error: 'Webhook not found' });
    return;
  }
  const { url, events, secret, enabled } = req.body;
  if (url !== undefined) {
    try {
      new URL(url);
    } catch (err: any) {
      console.warn('[webhooks] Invalid URL on update:', err.message);
      res.status(400).json({ error: 'Invalid URL' });
      return;
    }
  }
  workingCopy.update('webhook', req.params.id, { url, events, secret, enabled });
  res.json({ ok: true, action: 'update', message: 'Staged in working copy' });
});

// DELETE /api/webhooks/:id — delete webhook
router.delete('/:id', requireScope('webhooks:write'), (req, res) => {
  const existing = webhooksRepo.get(req.params.id);
  if (!existing) {
    res.status(404).json({ error: 'Webhook not found' });
    return;
  }
  workingCopy.delete('webhook', req.params.id);
  res.json({ ok: true, action: 'delete', message: 'Staged in working copy' });
});

// GET /api/webhooks/:id/metrics — delivery metrics
router.get('/:id/metrics', (req, res) => {
  const hook = webhooksRepo.get(req.params.id);
  if (!hook) {
    res.status(404).json({ error: 'Webhook not found' });
    return;
  }
  res.json(webhookDeliveryRepo.getMetrics(req.params.id));
});

// GET /api/webhooks/:id/deliveries — recent deliveries
router.get('/:id/deliveries', (req, res) => {
  const hook = webhooksRepo.get(req.params.id);
  if (!hook) {
    res.status(404).json({ error: 'Webhook not found' });
    return;
  }
  const limit = Math.min(parseInt(String(req.query.limit ?? '20'), 10) || 20, 100);
  res.json(webhookDeliveryRepo.getRecent(req.params.id, limit));
});

// POST /api/webhooks/:id/deliveries/:deliveryId/retry — retry a delivery
router.post('/:id/deliveries/:deliveryId/retry', requireScope('webhooks:write'), async (req, res) => {
  const hook = webhooksRepo.get(req.params.id);
  if (!hook) {
    res.status(404).json({ error: 'Webhook not found' });
    return;
  }
  const delivery = webhookDeliveryRepo.get(req.params.deliveryId);
  if (!delivery || delivery.webhookId !== req.params.id) {
    res.status(404).json({ error: 'Delivery not found' });
    return;
  }

  try {
    await retryDelivery(hook, delivery);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? 'Retry failed' });
  }
});

// POST /api/webhooks/:id/test — send test payload
router.post('/:id/test', requireScope('webhooks:write'), async (req, res) => {
  const hook = webhooksRepo.get(req.params.id);
  if (!hook) {
    res.status(404).json({ error: 'Webhook not found' });
    return;
  }

  const body = JSON.stringify({
    event: 'webhook:test',
    payload: { message: 'This is a test webhook delivery from Armada.' },
    timestamp: new Date().toISOString(),
  });

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (hook.secret) {
    const crypto = await import('node:crypto');
    const signature = crypto.createHmac('sha256', hook.secret).update(body).digest('hex');
    headers['X-Armada-Signature'] = `sha256=${signature}`;
  }

  try {
    const response = await fetch(hook.url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(10_000),
    });
    res.json({ success: true, status: response.status });
  } catch (err: any) {
    res.json({ success: false, error: err.message ?? 'Delivery failed' });
  }
});

export default router;
