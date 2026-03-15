import { Router } from 'express';
import { eventBus } from '../infrastructure/event-bus.js';

const router = Router();

/**
 * POST /api/internal/session-event
 * Receives push notifications from armada-agent plugins when session activity occurs.
 * Emits an SSE event so the UI can react in real-time.
 */
router.post('/', (req, res) => {
  const { instanceName, sessionKey, event, timestamp } = req.body ?? {};

  if (!instanceName || !sessionKey) {
    return res.status(400).json({ error: 'instanceName and sessionKey required' });
  }

  // Emit on the event bus — SSE will pick it up
  eventBus.emit('agent.session.updated', {
    instanceName,
    sessionKey,
    event: event || 'unknown',
    timestamp: timestamp || Date.now(),
  });

  res.json({ ok: true });
});

export default router;
