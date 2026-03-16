import { Router } from 'express';
import { requireScope } from '../middleware/scopes.js';
import { skillLibraryRepo } from '../repositories/index.js';
import { registerToolDef } from '../utils/tool-registry.js';
import { logActivity } from '../services/activity-service.js';

// ── Tool definitions ────────────────────────────────────────────────

registerToolDef({
  name: 'armada_skill_library_list',
  description: 'List all skills in the armada skill library.',
  method: 'GET', path: '/api/skills/library',
  parameters: [],
});

registerToolDef({
  name: 'armada_skill_library_get',
  description: 'Get a single skill from the library by ID or name.',
  method: 'GET', path: '/api/skills/library/:id',
  parameters: [
    { name: 'id', type: 'string', description: 'Skill ID or name', required: true },
  ],
});

registerToolDef({
  name: 'armada_skill_library_add',
  description: 'Add a skill to the armada skill library.',
  method: 'POST', path: '/api/skills/library',
  parameters: [
    { name: 'name', type: 'string', description: 'Skill name', required: true },
    { name: 'source', type: 'string', description: 'Source: clawhub, github, or workspace', required: false },
    { name: 'url', type: 'string', description: 'URL (for github source)', required: false },
    { name: 'version', type: 'string', description: 'Version', required: false },
    { name: 'description', type: 'string', description: 'Description of the skill', required: false },
  ],
    scope: 'skills:write',
});

registerToolDef({
  name: 'armada_skill_library_update',
  description: 'Update a skill in the armada skill library.',
  method: 'PUT', path: '/api/skills/library/:id',
  parameters: [
    { name: 'id', type: 'string', description: 'Skill ID', required: true },
    { name: 'name', type: 'string', description: 'New name', required: false },
    { name: 'source', type: 'string', description: 'Source', required: false },
    { name: 'url', type: 'string', description: 'URL', required: false },
    { name: 'version', type: 'string', description: 'Version', required: false },
    { name: 'description', type: 'string', description: 'Description', required: false },
  ],
    scope: 'skills:write',
});

registerToolDef({
  name: 'armada_skill_library_delete',
  description: 'Remove a skill from the armada skill library.',
  method: 'DELETE', path: '/api/skills/library/:id',
  parameters: [
    { name: 'id', type: 'string', description: 'Skill ID', required: true },
  ],
    scope: 'skills:write',
});

registerToolDef({
  name: 'armada_skill_library_usage',
  description: 'Get which templates use a library skill.',
  method: 'GET', path: '/api/skills/library/:id/usage',
  parameters: [
    { name: 'id', type: 'string', description: 'Skill ID', required: true },
  ],
});

registerToolDef({
  name: 'armada_skill_library_pull',
  description: 'Pull the latest version of a library skill.',
  method: 'POST', path: '/api/skills/library/:id/update',
  parameters: [
    { name: 'id', type: 'string', description: 'Skill ID', required: true },
  ],
    scope: 'skills:write',
});

// ── Routes ──────────────────────────────────────────────────────────

const router = Router();

// GET /library — list all
router.get('/', (_req, res, next) => {
  try {
    const skills = skillLibraryRepo.getAll();
    res.json(skills);
  } catch (err) { next(err); }
});

// GET /library/:id — get by ID or name
router.get('/:id', (req, res, next) => {
  try {
    let skill = skillLibraryRepo.get(req.params.id);
    if (!skill) {
      skill = skillLibraryRepo.getByName(req.params.id);
    }
    if (!skill) {
      res.status(404).json({ error: 'Skill not found' });
      return;
    }
    res.json(skill);
  } catch (err) { next(err); }
});

// POST /library — add skill
router.post('/', requireScope('skills:write'), (req, res, next) => {
  try {
    const { name, source, url, version, description } = req.body;
    if (!name) {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    const existing = skillLibraryRepo.getByName(name);
    if (existing) {
      res.status(409).json({ error: 'Skill already exists in library', skill: existing });
      return;
    }
    const skill = skillLibraryRepo.create({ name, source, url, version, description });
    logActivity({ eventType: 'skill.library.add', detail: `Added skill "${name}" to library` });
    res.status(201).json(skill);
  } catch (err) { next(err); }
});

// PUT /library/:id — update
router.put('/:id', requireScope('skills:write'), (req, res, next) => {
  try {
    const { name, source, url, version, description } = req.body;
    const skill = skillLibraryRepo.update(req.params.id, { name, source, url, version, description });
    res.json(skill);
  } catch (err: any) {
    if (err.message?.includes('not found')) {
      res.status(404).json({ error: err.message });
      return;
    }
    next(err);
  }
});

// DELETE /library/:id — delete
router.delete('/:id', requireScope('skills:write'), (req, res, next) => {
  try {
    const skill = skillLibraryRepo.get(req.params.id);
    if (!skill) {
      res.status(404).json({ error: 'Skill not found' });
      return;
    }
    skillLibraryRepo.delete(req.params.id);
    logActivity({ eventType: 'skill.library.remove', detail: `Removed skill "${skill.name}" from library` });
    res.status(204).end();
  } catch (err) { next(err); }
});

// GET /library/:id/usage — templates using this skill
router.get('/:id/usage', (req, res, next) => {
  try {
    let skill = skillLibraryRepo.get(req.params.id);
    if (!skill) {
      skill = skillLibraryRepo.getByName(req.params.id);
    }
    if (!skill) {
      res.status(404).json({ error: 'Skill not found' });
      return;
    }
    const templates = skillLibraryRepo.getUsage(skill.id);
    res.json({ templates });
  } catch (err) { next(err); }
});

// POST /library/:id/update — update skill registry entry.
//
// Skills are hot-loaded by agents and do NOT require a gateway restart or changeset.
// This endpoint updates the registry metadata (version, url, etc.) so the armada knows
// the canonical version. Agents will pick up the new version on their next skill sync.
//
// TODO: integrate ClawHub download — fetch the actual skill files from clawhub.com
//       and push them into the shared skills directory.
router.post('/:id/update', requireScope('skills:write'), (req, res, next) => {
  try {
    const skill = skillLibraryRepo.get(req.params.id);
    if (!skill) {
      res.status(404).json({ error: 'Skill not found' });
      return;
    }
    const version = req.body.version ?? skill.version;
    const updated = skillLibraryRepo.update(req.params.id, { version });
    logActivity({ eventType: 'skill.library.update', detail: `Updated skill "${skill.name}" registry entry${version ? ` → ${version}` : ''}` });
    res.json({
      updated: true,
      registryUpdated: true,
      // Skills are hot-loaded — no changeset or restart needed
      changesetRequired: false,
      skill: updated,
    });
  } catch (err) { next(err); }
});

export const skillLibraryRoutes = router;
export default skillLibraryRoutes;
