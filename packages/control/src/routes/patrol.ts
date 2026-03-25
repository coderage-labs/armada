/**
 * Patrol API routes — list patrol records, trigger manual patrol, resolve issues (#194).
 */

import { Router } from 'express';
import { getDrizzle } from '../db/drizzle.js';
import { patrolRecords } from '../db/drizzle-schema.js';
import { eq, desc } from 'drizzle-orm';
import { runPatrol } from '../services/patrol-service.js';
import { requireScope } from '../middleware/scopes.js';
import { registerToolDef } from '../utils/tool-registry.js';

const router = Router();

// GET /api/patrol/records — list recent patrol records
router.get('/records', requireScope('system:read'), (req, res) => {
  const db = getDrizzle();
  const limit = Math.min(parseInt(req.query.limit as string, 10) || 50, 200);
  const statusFilter = req.query.status as string | undefined;

  let query = db.select().from(patrolRecords).orderBy(desc(patrolRecords.createdAt)).limit(limit);

  if (statusFilter) {
    query = query.where(eq(patrolRecords.status, statusFilter)) as any;
  }

  const records = query.all();
  res.json(records);
});

// POST /api/patrol/run — trigger manual patrol
router.post('/run', requireScope('system:write'), (_req, res) => {
  const records = runPatrol();
  res.json({ ok: true, recordsCreated: records.length, records });
});

// POST /api/patrol/records/:id/resolve — mark a patrol record as resolved
router.post('/records/:id/resolve', requireScope('system:write'), (req, res) => {
  const db = getDrizzle();
  const { id } = req.params;

  const record = db.select().from(patrolRecords).where(eq(patrolRecords.id, id)).get();
  if (!record) {
    return res.status(404).json({ error: 'Patrol record not found' });
  }

  db.update(patrolRecords)
    .set({
      status: 'resolved',
      resolvedAt: new Date().toISOString(),
    })
    .where(eq(patrolRecords.id, id))
    .run();

  res.json({ ok: true });
});

// ── Tool definitions ─────────────────────────────────────────────────

registerToolDef({
  category: 'system',
  name: 'armada_patrol_records_list',
  scope: 'system:read',
  description: 'List recent patrol records from autonomous health monitoring',
  method: 'GET',
  path: '/api/patrol/records',
  parameters: [
    { name: 'limit', type: 'number', description: 'Max records to return (default 50, max 200)' },
    { name: 'status', type: 'string', description: 'Filter by status: open or resolved' },
  ],
});

registerToolDef({
  category: 'system',
  name: 'armada_patrol_run',
  scope: 'system:write',
  description: 'Trigger a manual patrol check',
  method: 'POST',
  path: '/api/patrol/run',
  parameters: [],
});

registerToolDef({
  category: 'system',
  name: 'armada_patrol_record_resolve',
  scope: 'system:write',
  description: 'Mark a patrol record as resolved',
  method: 'POST',
  path: '/api/patrol/records/:id/resolve',
  parameters: [
    { name: 'id', type: 'string', required: true, description: 'Patrol record ID' },
  ],
});

export default router;
