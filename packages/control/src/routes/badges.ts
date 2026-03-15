// ── Badge counts — actionable item counts for nav indicators ──

import { Router } from 'express';
import { registerToolDef } from '../utils/tool-registry.js';

registerToolDef({
  name: 'fleet_badges',
  description: 'Get badge counts for nav items (pending gates, active operations, error instances).',
  method: 'GET', path: '/api/badges', parameters: [],
});
import { getDrizzle } from '../db/drizzle.js';
import { workflowStepRuns, workflowRuns } from '../db/drizzle-schema.js';
import { eq, sql, count } from 'drizzle-orm';
import { instancesRepo } from '../repositories/index.js';
import { operationManager } from '../infrastructure/operations.js';
import { setupSSE } from '../utils/sse.js';
import { eventBus } from '../infrastructure/event-bus.js';

const router = Router();

function computeBadges() {
  const db = getDrizzle();

  // Pending gates: step runs waiting for manual approval
  const pendingGatesRow = db
    .select({ count: count() })
    .from(workflowStepRuns)
    .where(eq(workflowStepRuns.status, 'waiting_gate'))
    .get();
  const pendingGates = pendingGatesRow?.count ?? 0;

  // Active operations: operations with status = 'running'
  const activeOperations = operationManager.getActive().length;

  // Error instances: instances with status = 'error'
  const allInstances = instancesRepo.getAll();
  const errorInstances = allInstances.filter((i) => i.status === 'error').length;

  return { pendingGates, activeOperations, errorInstances };
}

// GET /api/badges — snapshot of current badge counts
router.get('/', (_req, res) => {
  try {
    res.json(computeBadges());
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? 'Failed to compute badges' });
  }
});

// GET /api/badges/stream — SSE stream for live badge updates
router.get('/stream', (req, res) => {
  const sse = setupSSE(res);

  // Send initial values
  try {
    sse.send('badges', computeBadges());
  } catch (err: any) {
    console.warn('[badges] Failed to send initial badge values:', err.message);
  }

  // Re-emit on relevant events
  const refresh = () => {
    try {
      sse.send('badges', computeBadges());
    } catch (err: any) {
      console.warn('[badges] Failed to send badge refresh:', err.message);
    }
  };

  const unsubs = [
    eventBus.on('operation.*', refresh),
    eventBus.on('workflow.*', refresh),
    eventBus.on('instance.*', refresh),
  ];

  res.on('close', () => unsubs.forEach((u) => u()));
});

export { router as badgesRoutes };
export default router;
