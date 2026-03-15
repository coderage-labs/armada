// ── SSE event stream — unified event bus endpoint ──

import { Router } from 'express';
import { setupSSE } from '../utils/sse.js';
import { eventBus } from '../infrastructure/event-bus.js';

const router = Router();

// GET /api/events/stream — SSE stream with topic filtering and Last-Event-ID replay
router.get('/stream', (req, res) => {
  const sse = setupSSE(res);
  const topics = (req.query.topics as string)?.split(',').filter(Boolean) || [];

  // Replay missed events if client sends Last-Event-ID
  const lastId = parseInt(req.headers['last-event-id'] as string) || 0;
  if (lastId > 0) {
    if (topics.length) {
      for (const topic of topics) {
        const pattern = topic.includes('*') ? topic : `${topic}.*`;
        for (const event of eventBus.replay(lastId, pattern)) {
          sse.send(event.event, event.data, event.id);
        }
      }
    } else {
      for (const event of eventBus.replay(lastId, '*')) {
        sse.send(event.event, event.data, event.id);
      }
    }
  }

  // Live subscription
  const unsubs = topics.length
    ? topics.map(t => eventBus.on(
        t.includes('*') ? t : `${t}.*`,
        (e) => sse.send(e.event, e.data, e.id),
      ))
    : [eventBus.on('*', (e) => sse.send(e.event, e.data, e.id))];

  res.on('close', () => unsubs.forEach(u => u()));
});

export { router as eventsRoutes };
export default router;
