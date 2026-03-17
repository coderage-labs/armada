// ── Changesets routes — declarative state management ──

import { Router } from 'express';
import { changesetService } from '../services/changeset-service.js';
import { changesetValidator } from '../services/changeset-validator.js';

const router = Router();

// POST /api/changesets/preview — dry run, returns changes + plan without persisting
router.post('/preview', (req, res) => {
  try {
    const preview = changesetService.preview();
    res.json(preview);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/changesets — create a new changeset
router.post('/', (req, res) => {
  try {
    const { createdBy } = req.body ?? {};
    const changeset = changesetService.create({ createdBy });
    res.status(201).json(changeset);
  } catch (err: any) {
    if (err.message === 'No pending changes') {
      return res.status(422).json({ error: err.message });
    }
    res.status(500).json({ error: err.message });
  }
});

// GET /api/changesets — list changesets (most recent first)
router.get('/', (req, res) => {
  const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 20;
  res.json(changesetService.list(limit));
});

// GET /api/changesets/:id — get changeset detail
router.get('/:id', (req, res) => {
  const changeset = changesetService.get(req.params.id);
  if (!changeset) return res.status(404).json({ error: 'Changeset not found' });
  res.json(changeset);
});

// POST /api/changesets/:id/approve — approve a draft changeset
router.post('/:id/approve', (req, res) => {
  try {
    const { approvedBy } = req.body ?? {};
    const changeset = changesetService.approve(req.params.id, approvedBy);
    res.json(changeset);
  } catch (err: any) {
    if (err.message?.includes('not found')) {
      return res.status(404).json({ error: err.message });
    }
    res.status(422).json({ error: err.message });
  }
});

// POST /api/changesets/:id/validate — manual validation endpoint
router.post('/:id/validate', (req, res) => {
  try {
    const changeset = changesetService.get(req.params.id);
    if (!changeset) return res.status(404).json({ error: 'Changeset not found' });

    const validation = changesetValidator.validate(changeset);
    res.json({ changeset, validation });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/changesets/:id/apply — execute an approved changeset
// ?force=true skips staleness check (conflicts still block)
router.post('/:id/apply', async (req, res) => {
  try {
    const force = req.query.force === 'true';
    const result = await changesetService.apply(req.params.id, { force });

    // If validation blocked apply, return 409 with details
    if (result.validation && !result.validation.canApply && !(force && !result.validation.conflicts.some(c => c.type === 'error'))) {
      return res.status(409).json({
        error: 'Changeset has conflicts or is stale',
        changeset: result,
        validation: result.validation,
      });
    }

    res.json(result);
  } catch (err: any) {
    if (err.message?.includes('not found')) {
      return res.status(404).json({ error: err.message });
    }
    res.status(422).json({ error: err.message });
  }
});

// POST /api/changesets/:id/retry — retry failed instances of a failed changeset
router.post('/:id/retry', async (req, res) => {
  try {
    const result = await changesetService.retry(req.params.id);
    res.json(result);
  } catch (err: any) {
    if (err.message?.includes('not found')) {
      return res.status(404).json({ error: err.message });
    }
    res.status(422).json({ error: err.message });
  }
});

// POST /api/changesets/:id/cancel — cancel a draft or approved changeset
router.post('/:id/cancel', (req, res) => {
  try {
    const changeset = changesetService.cancel(req.params.id);
    res.json(changeset);
  } catch (err: any) {
    if (err.message?.includes('not found')) {
      return res.status(404).json({ error: err.message });
    }
    res.status(422).json({ error: err.message });
  }
});

// DELETE /api/changesets/:id — delete a failed or cancelled changeset
router.delete('/:id', (req, res) => {
  try {
    changesetService.remove(req.params.id);
    res.status(204).send();
  } catch (err: any) {
    if (err.message?.includes('not found')) {
      return res.status(404).json({ error: err.message });
    }
    if (err.message?.includes('cannot be removed')) {
      return res.status(422).json({ error: err.message });
    }
    res.status(500).json({ error: err.message });
  }
});

export { router as changesetsRoutes };
