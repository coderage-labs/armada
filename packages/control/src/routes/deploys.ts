import { Router } from 'express';
import { deploysRepo } from '../repositories/index.js';
import { registerToolDef } from '../utils/tool-registry.js';

const router = Router();

registerToolDef({
  name: 'armada_deploys',
  description: 'List recent deployment history for agents.',
  method: 'GET', path: '/api/deploys',
  parameters: [],
});

/**
 * GET /api/deploys — list recent deployments, ordered by started_at DESC, limit 50.
 * Maps DB snake_case to the camelCase format the UI expects.
 */
router.get('/deploys', (_req, res) => {
  try {
    const all = deploysRepo.getAll();
    // Sort by startedAt DESC, limit 50
    const deploys = all
      .sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''))
      .slice(0, 50)
      .map((r) => ({
        id: r.id,
        type: r.type,
        target: r.target ?? '',
        status: r.status,
        log: r.log ?? undefined,
        started: r.startedAt,
        completed: r.completedAt ?? undefined,
      }));

    res.json(deploys);
  } catch (err) {
    console.error('Error fetching deploys:', err);
    res.status(500).json({ error: 'Failed to fetch deployments' });
  }
});

export default router;
