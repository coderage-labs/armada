import { Router } from 'express';
import { activityRepo } from '../repositories/index.js';
import { eventBus } from '../infrastructure/event-bus.js';
import { setupSSE } from '../utils/sse.js';
import { registerToolDef } from '../utils/tool-registry.js';
import type { ActivityEvent } from '@coderage-labs/armada-shared';

// ── SSE event bus ────────────────────────────────────────────────────

type ActivityListener = (event: ActivityEvent) => void;

const listeners = new Set<ActivityListener>();

/** Emit an activity event to all SSE listeners. Called from other routes too. */
export function emitActivityEvent(activity: ActivityEvent) {
  for (const listener of listeners) {
    try {
      listener(activity);
    } catch (err: any) {
      console.warn('[activity] listener threw:', err.message);
    }
  }
}

// Bridge: forward eventBus 'activity.created' events to SSE listeners
eventBus.on('activity.created', (evt) => {
  emitActivityEvent(evt.data as ActivityEvent);
});

// Re-export from activity-service for backwards compatibility
export { logActivity } from '../services/activity-service.js';

// ── Routes ───────────────────────────────────────────────────────────

const router = Router();

// GET /api/activity — list with optional filters
router.get('/', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit as string, 10) || 50, 200);
  const agent = req.query.agent as string | undefined;
  const type = req.query.type as string | undefined;

  let events: ActivityEvent[];
  if (agent) {
    events = activityRepo.getByAgent(agent, limit);
  } else if (type) {
    events = activityRepo.getByType(type, limit);
  } else {
    events = activityRepo.getRecent(limit);
  }

  res.json(events);
});

// GET /api/activity/stream — SSE endpoint
router.get('/stream', (req, res) => {
  const sse = setupSSE(res);

  const listener: ActivityListener = (activity) => {
    sse.send('activity.new', activity);
  };
  listeners.add(listener);

  const heartbeat = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch (err: any) {
      console.warn('[activity] heartbeat write failed:', err.message);
    }
  }, 30_000);

  req.on('close', () => {
    listeners.delete(listener);
    clearInterval(heartbeat);
  });
});

// ── Tool definitions ─────────────────────────────────────────────────

registerToolDef({
  category: 'tasks',
  name: 'armada_activity_list',
  description: 'List recent armada activity events with optional filtering by agent or event type',
  method: 'GET',
  path: '/api/activity',
  parameters: [
    { name: 'limit', type: 'number', description: 'Max events to return (default 50, max 200)' },
    { name: 'agent', type: 'string', description: 'Filter by agent name' },
    { name: 'type', type: 'string', description: 'Filter by event type prefix (e.g. "agent", "task")' },
  ],
});

export default router;
