/**
 * Worktrees API — list active Git worktrees for debugging.
 *
 * GET /api/worktrees — returns all active per-step worktrees managed by
 * the worktree service. Useful for diagnosing stuck/leaked worktrees.
 */

import { Router } from 'express';
import { requireScope } from '../middleware/scopes.js';
import { registerToolDef } from '../utils/tool-registry.js';
import { getActiveWorktrees } from '../services/worktree-service.js';

const router = Router();

// ── Tool definition ─────────────────────────────────────────────────

registerToolDef({
  category: 'git',
  name: 'armada_worktrees',
  description: 'List active Git worktrees created for workflow step isolation. Shows step ID, branch, path, and creation time.',
  method: 'GET',
  path: '/api/worktrees',
  parameters: [],
  scope: 'workflows:read',
});

// ── GET /api/worktrees ───────────────────────────────────────────────

router.get('/', requireScope('workflows:read'), (_req, res) => {
  const worktrees = getActiveWorktrees();
  res.json(worktrees);
});

export default router;
