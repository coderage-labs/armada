import { Router } from 'express';
import { pendingMutationRepo } from '../repositories/index.js';
import { mutationService, cleanupEmptyChangesets } from '../services/mutation-service.js';
import { changesetService } from '../services/changeset-service.js';
import { computeMutationDiffs } from '../services/diff-computer.js';
import type { EntityType } from '../services/mutation-service.js';

const SENSITIVE_PAYLOAD_FIELDS = new Set(['apiKey', 'api_key', 'secret', 'password', 'token']);

function maskMutationPayload(mutation: any): any {
  if (!mutation?.payload) return mutation;
  const masked = { ...mutation, payload: { ...mutation.payload } };
  for (const field of SENSITIVE_PAYLOAD_FIELDS) {
    if (typeof masked.payload[field] === 'string' && masked.payload[field].length > 4) {
      masked.payload[field] = '••••' + masked.payload[field].slice(-4);
    }
  }
  return masked;
}

function maskMutations(mutations: any[]): any[] {
  return mutations.map(maskMutationPayload);
}

const router = Router();

// GET /api/pending-mutations — list all pending mutations
router.get('/', (req, res) => {
  const entityType = req.query.entityType as string | undefined;
  if (entityType) {
    res.json(maskMutations(pendingMutationRepo.getByEntity(entityType)));
  } else {
    res.json(maskMutations(pendingMutationRepo.getAll()));
  }
});

// GET /api/pending-mutations/changeset/:changesetId — mutations for a specific changeset
router.get('/changeset/:changesetId', (req, res) => {
  res.json(maskMutations(pendingMutationRepo.getByChangeset(req.params.changesetId)));
});

// GET /api/pending-mutations/changeset/:changesetId/diff — field-level diff for changeset
router.get('/changeset/:changesetId/diff', (req, res) => {
  const mutations = pendingMutationRepo.getByChangeset(req.params.changesetId);
  
  if (mutations.length > 0) {
    // Live mutations exist — compute fresh
    const diffs = computeMutationDiffs(req.params.changesetId);
    res.json(diffs);
  } else {
    // Mutations already flushed — fall back to stored snapshot
    const changeset = changesetService.get(req.params.changesetId);
    if (changeset?.plan?.diffs) {
      res.json(changeset.plan.diffs);
    } else {
      res.json([]);
    }
  }
});

// POST /api/pending-mutations — stage a new mutation
router.post('/', (req, res) => {
  const { entityType, action, payload, entityId } = req.body;
  if (!entityType || !action || !payload) {
    return res.status(400).json({ error: 'entityType, action, and payload are required' });
  }
  const mutation = mutationService.stage(entityType as EntityType, action, payload, entityId);
  res.status(201).json(mutation);
});

// PATCH /api/pending-mutations/:id — update a mutation's payload
router.patch('/:id', (req, res) => {
  const { payload } = req.body;
  if (!payload || typeof payload !== 'object') {
    return res.status(400).json({ error: 'payload is required' });
  }
  const existing = pendingMutationRepo.getAll().find(m => m.id === req.params.id);
  if (!existing) return res.status(404).json({ error: 'Mutation not found' });

  const updated = pendingMutationRepo.update(req.params.id, { ...existing.payload, ...payload });
  res.json(updated);
});

// DELETE /api/pending-mutations/:id — remove a single pending mutation (undo)
router.delete('/:id', (req, res) => {
  const removed = pendingMutationRepo.removeById(req.params.id);
  if (!removed) return res.status(404).json({ error: 'Mutation not found' });
  // If changeset is now empty, auto-discard it
  cleanupEmptyChangesets();
  res.json({ ok: true });
});

export { router as pendingMutationsRoutes };
