import { Router } from 'express';
import { requireScope } from '../middleware/scopes.js';
import { notificationChannelRepo } from '../repositories/notification-channel-repo.js';
import type { CreateNotificationChannelData, UpdateNotificationChannelData, NotificationChannelType } from '../repositories/notification-channel-repo.js';
import { testChannel } from '../services/notification-service.js';
import { registerToolDef } from '../utils/tool-registry.js';

// ── Tool definitions ─────────────────────────────────────────────────

registerToolDef({
  name: 'armada_notification_channels_list',
  description: 'List all configured notification channels.',
  method: 'GET',
  path: '/api/notification-channels',
  parameters: [],
});

registerToolDef({
  name: 'armada_notification_channels_create',
  description: 'Create a new notification channel (telegram, slack, discord, email).',
  method: 'POST',
  path: '/api/notification-channels',
  parameters: [
    { name: 'type', type: 'string', description: 'Channel type: telegram | slack | discord | email', required: true },
    { name: 'name', type: 'string', description: 'Display name for this channel', required: true },
    { name: 'enabled', type: 'boolean', description: 'Whether the channel is enabled', required: false },
    { name: 'config', type: 'string', description: 'Channel-specific config as JSON (e.g. { "token": "...", "chat_id": "..." } for Telegram, { "webhook_url": "..." } for Slack/Discord)', required: true },
  ],
    scope: 'system:write',
});

registerToolDef({
  name: 'armada_notification_channels_update',
  description: 'Update a notification channel.',
  method: 'PUT',
  path: '/api/notification-channels/:id',
  parameters: [
    { name: 'id', type: 'string', description: 'Channel ID', required: true },
    { name: 'name', type: 'string', description: 'Display name', required: false },
    { name: 'enabled', type: 'boolean', description: 'Enable or disable', required: false },
    { name: 'config', type: 'string', description: 'Channel-specific config as JSON', required: false },
  ],
    scope: 'system:write',
});

registerToolDef({
  name: 'armada_notification_channels_delete',
  description: 'Delete a notification channel.',
  method: 'DELETE',
  path: '/api/notification-channels/:id',
  parameters: [
    { name: 'id', type: 'string', description: 'Channel ID', required: true },
  ],
    scope: 'system:write',
});

registerToolDef({
  name: 'armada_notification_channels_test',
  description: 'Send a test message to a notification channel.',
  method: 'POST',
  path: '/api/notification-channels/:id/test',
  parameters: [
    { name: 'id', type: 'string', description: 'Channel ID', required: true },
  ],
    scope: 'system:write',
});

// ── Router ────────────────────────────────────────────────────────────

const router = Router();

const VALID_TYPES = new Set<NotificationChannelType>(['telegram', 'slack', 'discord', 'email']);

// GET /api/notification-channels
router.get('/', (_req, res) => {
  const channels = notificationChannelRepo.findAll();
  res.json(channels);
});

// POST /api/notification-channels
router.post('/', requireScope('system:write'), (req, res, next) => {
  try {
    const { type, name, enabled, config } = req.body as {
      type?: string;
      name?: string;
      enabled?: boolean;
      config?: Record<string, unknown>;
    };

    if (!type || !VALID_TYPES.has(type as NotificationChannelType)) {
      res.status(400).json({ error: `Invalid type. Must be one of: ${[...VALID_TYPES].join(', ')}` });
      return;
    }
    if (!name || typeof name !== 'string') {
      res.status(400).json({ error: 'Missing required field: name' });
      return;
    }
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      res.status(400).json({ error: 'Missing required field: config (must be an object)' });
      return;
    }

    const data: CreateNotificationChannelData = {
      type: type as NotificationChannelType,
      name,
      enabled: enabled ?? true,
      config,
    };

    const channel = notificationChannelRepo.create(data);
    res.status(201).json(channel);
  } catch (err) {
    next(err);
  }
});

// PUT /api/notification-channels/:id
router.put('/:id', requireScope('system:write'), (req, res, next) => {
  try {
    const { id } = req.params;
    const existing = notificationChannelRepo.findById(id);
    if (!existing) {
      res.status(404).json({ error: 'Notification channel not found' });
      return;
    }

    const { type, name, enabled, config } = req.body as {
      type?: string;
      name?: string;
      enabled?: boolean;
      config?: Record<string, unknown>;
    };

    const patch: UpdateNotificationChannelData = {};
    if (type !== undefined) {
      if (!VALID_TYPES.has(type as NotificationChannelType)) {
        res.status(400).json({ error: `Invalid type. Must be one of: ${[...VALID_TYPES].join(', ')}` });
        return;
      }
      patch.type = type as NotificationChannelType;
    }
    if (name !== undefined) patch.name = name;
    if (enabled !== undefined) patch.enabled = !!enabled;
    if (config !== undefined) patch.config = config;

    const updated = notificationChannelRepo.update(id, patch);
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/notification-channels/:id
router.delete('/:id', requireScope('system:write'), (req, res, next) => {
  try {
    const { id } = req.params;
    const deleted = notificationChannelRepo.delete(id);
    if (!deleted) {
      res.status(404).json({ error: 'Notification channel not found' });
      return;
    }
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/notification-channels/:id/test
router.post('/:id/test', requireScope('system:write'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const channel = notificationChannelRepo.findById(id);
    if (!channel) {
      res.status(404).json({ error: 'Notification channel not found' });
      return;
    }
    await testChannel(id);
    res.json({ success: true, message: 'Test notification sent' });
  } catch (err: any) {
    next(err);
  }
});

export { router as notificationChannelsRoutes };
