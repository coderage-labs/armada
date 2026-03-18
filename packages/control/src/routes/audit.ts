import { Router } from 'express';
import { requireScope } from '../middleware/scopes.js';
import { queryAudit } from '../services/audit.js';
import { registerToolDef } from '../utils/tool-registry.js';

registerToolDef({
  category: 'admin',
  name: 'armada_audit_list',
  description: 'Query the audit log. Returns recent audit entries with optional filters.',
  method: 'GET',
  path: '/api/audit',
  parameters: [
    { name: 'caller', type: 'string', description: 'Filter by caller ID or name' },
    { name: 'action', type: 'string', description: 'Filter by action (supports partial match)' },
    { name: 'resourceType', type: 'string', description: 'Filter by resource type' },
    { name: 'from', type: 'string', description: 'Start timestamp (ISO 8601)' },
    { name: 'to', type: 'string', description: 'End timestamp (ISO 8601)' },
    { name: 'limit', type: 'number', description: 'Max entries to return (default 50, max 200)' },
    { name: 'offset', type: 'number', description: 'Offset for pagination' },
  ],
  scope: 'audit:read',
});

const router = Router();

// GET /api/audit — query audit log (owner/operator only)
router.get('/', requireScope('audit:read'), (req, res) => {
  const { caller, action, resourceType, from, to, limit, offset } = req.query;

  const result = queryAudit({
    caller: caller as string | undefined,
    action: action as string | undefined,
    resourceType: resourceType as string | undefined,
    from: from as string | undefined,
    to: to as string | undefined,
    limit: limit ? parseInt(limit as string, 10) : undefined,
    offset: offset ? parseInt(offset as string, 10) : undefined,
  });

  res.json(result);
});

export default router;
