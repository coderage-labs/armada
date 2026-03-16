// ── Operations routes — list, get, and stream long-running operations ──

import { Router } from 'express';
import { setupSSE } from '../utils/sse.js';
import { eventBus } from '../infrastructure/event-bus.js';
import { operationManager } from '../infrastructure/operations.js';
import { lockManager } from '../infrastructure/lock-manager.js';
import { registerToolDef } from '../utils/tool-registry.js';
import { requireScope } from '../middleware/scopes.js';

const router = Router();

// GET /api/operations — list operations with optional status filter
router.get('/', (req, res) => {
  const status = req.query.status as string | undefined;
  if (status) {
    const ops = operationManager.getRecent(100).filter(op => op.status === status);
    return res.json(ops);
  }
  res.json(operationManager.getRecent());
});

// ── Locks API (must be before /:id to avoid matching) ────────────────

// GET /api/operations/locks — list all active locks
router.get('/locks', (_req, res) => {
  const locks = lockManager.getAll();
  res.json(locks);
});

// DELETE /api/operations/locks/:targetType/:targetId — force release (admin only)
router.delete('/locks/:targetType/:targetId', requireScope('system:write'), (req, res) => {
  const { targetType, targetId } = req.params;
  const lock = lockManager.check(targetType, targetId);
  if (!lock) {
    return res.status(404).json({ error: 'Lock not found' });
  }
  lockManager.release(targetType, targetId, lock.operationId);
  res.json({ ok: true, released: { targetType, targetId, operationId: lock.operationId } });
});

// GET /api/operations/:id — get single operation with all events
router.get('/:id', (req, res) => {
  const op = operationManager.get(req.params.id);
  if (!op) return res.status(404).json({ error: 'Operation not found' });
  res.json(op);
});

// GET /api/operations/:id/stream — SSE stream for a specific operation
router.get('/:id/stream', (req, res) => {
  const op = operationManager.get(req.params.id);
  if (!op) return res.status(404).json({ error: 'Operation not found' });

  const sse = setupSSE(res);

  // Send buffered events
  for (const event of op.events) {
    sse.send('progress', event);
  }

  // If already done, send final status and close
  if (op.status !== 'running' && op.status !== 'pending') {
    sse.send(op.status, op.result || {});
    sse.close();
    return;
  }

  // Subscribe to live events for this operation
  const unsub = eventBus.on('operation.*', (e) => {
    if (e.data.operationId === req.params.id) {
      if (e.event === 'operation.progress') {
        sse.send('progress', e.data);
      } else if (e.event === 'operation.steps_updated') {
        sse.send('steps', e.data);
      } else if (
        e.event === 'operation.completed' ||
        e.event === 'operation.failed' ||
        e.event === 'operation.cancelled'
      ) {
        sse.send(e.event.split('.')[1], e.data);
        sse.close();
        unsub();
      }
    }
  });

  res.on('close', unsub);
});

// ── Tool definitions ─────────────────────────────────────────────────

registerToolDef({
  name: 'armada_operations_list',
  description: 'List armada operations with optional status filter',
  method: 'GET',
  path: '/api/operations',
  parameters: [
    { name: 'status', type: 'string', description: 'Filter by status: running, completed, failed' },
  ],
    scope: 'system:read',
});

registerToolDef({
  name: 'armada_operation_get',
  description: 'Get details of a specific armada operation',
  method: 'GET',
  path: '/api/operations/:id',
  parameters: [
    { name: 'id', type: 'string', required: true, description: 'Operation ID' },
  ],
    scope: 'system:read',
});

export { router as operationsRoutes };
export default router;
