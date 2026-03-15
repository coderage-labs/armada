import { Router } from 'express';
import { requireScope } from '../middleware/scopes.js';
import { settingsRepo } from '../repositories/index.js';
import { roleMetaRepo } from '../repositories/index.js';
import { registerToolDef } from '../utils/tool-registry.js';
import { logActivity } from '../services/activity-service.js';

const router = Router();

registerToolDef({
  name: 'fleet_hierarchy',
  description: 'Get the fleet task routing rules. Shows which roles can assign tasks to which other roles.',
  method: 'GET', path: '/api/hierarchy',
  parameters: [],
});

registerToolDef({
  name: 'fleet_hierarchy_update',
  description: 'Update the fleet task routing rules. Each role maps to an array of roles it can assign tasks to.',
  method: 'PUT', path: '/api/hierarchy',
  parameters: [],
});

registerToolDef({
  name: 'fleet_hierarchy_role_upsert',
  description: 'Create or update role metadata (colour, description, tier, icon).',
  method: 'PUT', path: '/api/hierarchy/roles/:role',
  parameters: [
    { name: 'role', type: 'string', description: 'Role name (path param)', required: true },
    { name: 'color', type: 'string', description: 'Hex colour e.g. #ec4899' },
    { name: 'description', type: 'string', description: 'Human-readable description' },
    { name: 'tier', type: 'number', description: 'Tier: 0=top, 1=middle, 2=leaf' },
    { name: 'icon', type: 'string', description: 'Emoji or icon identifier' },
  ],
});

registerToolDef({
  name: 'fleet_hierarchy_role_delete',
  description: 'Delete role metadata.',
  method: 'DELETE', path: '/api/hierarchy/roles/:role',
  parameters: [
    { name: 'role', type: 'string', description: 'Role name (path param)', required: true },
  ],
});

export interface HierarchyRules {
  rules: Record<string, string[]>;
}

const DEFAULT_HIERARCHY: HierarchyRules = {
  rules: {
    operator: ['project-manager'],
    'project-manager': ['development', 'research'],
    development: ['project-manager'],
    research: ['project-manager'],
  },
};

// GET /api/hierarchy — returns task routing rules + role metadata
router.get('/', (_req, res) => {
  let hierarchy: HierarchyRules;
  const stored = settingsRepo.get('hierarchy');
  if (stored) {
    try {
      hierarchy = JSON.parse(stored) as HierarchyRules;
    } catch (err: any) {
      console.warn('[hierarchy] Failed to parse hierarchy JSON:', err.message);
      hierarchy = DEFAULT_HIERARCHY;
    }
  } else {
    hierarchy = DEFAULT_HIERARCHY;
  }

  const roles = roleMetaRepo.getAll();
  res.json({ ...hierarchy, roles });
});

// PUT /api/hierarchy — update task routing rules
router.put('/', requireScope('system:write'), (req, res, next) => {
  try {
    const { rules } = req.body;

    if (!rules || typeof rules !== 'object') {
      res.status(400).json({ error: 'Invalid hierarchy — must have a "rules" object' });
      return;
    }

    // Validate that all values are arrays of strings
    for (const [role, targets] of Object.entries(rules)) {
      if (!Array.isArray(targets) || !targets.every((t) => typeof t === 'string')) {
        res.status(400).json({ error: `Invalid hierarchy — role "${role}" must map to an array of strings` });
        return;
      }
    }

    const hierarchy: HierarchyRules = { rules };
    settingsRepo.set('hierarchy', JSON.stringify(hierarchy));
    logActivity({ eventType: 'hierarchy.updated', detail: `Task routing rules updated (${Object.keys(rules).length} roles)` });

    const roles = roleMetaRepo.getAll();
    res.json({ ...hierarchy, roles });
  } catch (err) {
    next(err);
  }
});

// PUT /api/hierarchy/roles/:role — upsert role metadata
router.put('/roles/:role', requireScope('system:write'), (req, res, next) => {
  try {
    const { role } = req.params;
    const { color, description, tier, icon } = req.body;

    roleMetaRepo.upsert(role, { color, description, tier, icon });
    logActivity({ eventType: 'role_metadata.updated', detail: `Role metadata updated: ${role}` });

    const meta = roleMetaRepo.get(role);
    res.json(meta);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/hierarchy/roles/:role — delete role metadata
router.delete('/roles/:role', requireScope('system:write'), (req, res, next) => {
  try {
    const { role } = req.params;
    const deleted = roleMetaRepo.delete(role);
    if (!deleted) {
      res.status(404).json({ error: `Role metadata not found: ${role}` });
      return;
    }
    logActivity({ eventType: 'role_metadata.deleted', detail: `Role metadata deleted: ${role}` });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
