/**
 * Draft API — working copy status and lifecycle.
 *
 * Entity CRUD goes through the standard entity routes (which write to
 * the working copy internally). These endpoints handle working-copy-level
 * operations: viewing diffs, checking status, and discarding changes.
 */

import { Router } from 'express';
import { requireScope } from '../middleware/scopes.js';
import { workingCopy } from '../services/working-copy.js';
import { logActivity } from '../services/activity-service.js';

const router = Router();

// ── Get full diff ──

router.get('/diff', (_req, res) => {
  const diffs = workingCopy.allDiffs();
  res.json({
    hasChanges: workingCopy.hasChanges(),
    entityCount: workingCopy.size(),
    diffs,
  });
});

// ── Discard all changes ──

router.post('/discard', requireScope('system:write'), (_req, res) => {
  const count = workingCopy.size();
  workingCopy.discard();

  logActivity({
    eventType: 'draft.discarded',
    detail: `Discarded ${count} pending change(s)`,
  });

  res.json({ ok: true, discarded: count });
});

// ── Status ──

router.get('/status', (_req, res) => {
  res.json({
    hasChanges: workingCopy.hasChanges(),
    entityCount: workingCopy.size(),
    refs: workingCopy.getChangedRefs(),
  });
});

export { router as draftRoutes };
export default router;
