import { Router } from 'express';
import { requireScope } from '../middleware/scopes.js';
import { usersRepo, userProjectsRepo } from '../repositories/index.js';
import { registerToolDef } from '../utils/tool-registry.js';
import { generateAvatar, avatarExists, deleteAvatar, readAvatar, getDefaultAvatarUrl } from '../services/avatar-generator.js';
import { logActivity } from '../services/activity-service.js';
import { eventBus } from '../infrastructure/event-bus.js';
import { passkeyRepo } from '../repositories/passkey-repo.js';
import { resetUserPassword } from '../services/auth-service.js';

const router = Router();

// ── Tool definitions ─────────────────────────────────────────────────

registerToolDef({
  name: 'armada_users_list',
  description: 'List all users.',
  method: 'GET',
  path: '/api/users',
  parameters: [],
});

registerToolDef({
  name: 'armada_user_get',
  description: 'Get a armada user by ID or name.',
  method: 'GET',
  path: '/api/users/:id',
  parameters: [
    { name: 'id', type: 'string', description: 'User ID or name', required: true },
  ],
});

registerToolDef({
  name: 'armada_user_create',
  description: 'Create a new armada user.',
  method: 'POST',
  path: '/api/users',
  parameters: [
    { name: 'name', type: 'string', description: 'Unique username (lowercase)', required: true },
    { name: 'displayName', type: 'string', description: 'Display name', required: true },
    { name: 'type', type: 'string', description: 'User type: human or operator', required: false },
    { name: 'role', type: 'string', description: 'User role: owner, operator, or viewer', required: false },
    { name: 'linkedAccounts', type: 'string', description: 'Linked accounts JSON (telegram, github, email)', required: false },
    { name: 'notifications', type: 'string', description: 'Notification settings JSON', required: false },
  ],
});

registerToolDef({
  name: 'armada_user_update',
  description: 'Update a armada user.',
  method: 'PUT',
  path: '/api/users/:id',
  parameters: [
    { name: 'id', type: 'string', description: 'User ID', required: true },
    { name: 'name', type: 'string', description: 'Username', required: false },
    { name: 'displayName', type: 'string', description: 'Display name', required: false },
    { name: 'type', type: 'string', description: 'User type', required: false },
    { name: 'role', type: 'string', description: 'User role', required: false },
    { name: 'linkedAccounts', type: 'string', description: 'Linked accounts JSON', required: false },
    { name: 'notifications', type: 'string', description: 'Notification settings JSON', required: false },
  ],
});

registerToolDef({
  name: 'armada_user_delete',
  description: 'Delete a armada user.',
  method: 'DELETE',
  path: '/api/users/:id',
  parameters: [
    { name: 'id', type: 'string', description: 'User ID', required: true },
  ],
});

// ── Routes ───────────────────────────────────────────────────────────

// GET /api/users — list all users
router.get('/', requireScope('users:read'), (_req, res) => {
  const users = usersRepo.getAll();
  res.json(users);
});

// GET /api/users/:id — get user by ID or name
router.get('/:id', requireScope('users:read'), (req, res) => {
  let user = usersRepo.getById(req.params.id);
  if (!user) user = usersRepo.getByName(req.params.id);
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  res.json(user);
});

// POST /api/users — create user
router.post('/', requireScope('users:write'), (req, res) => {
  const { name, displayName, type, role, linkedAccounts, notifications } = req.body;
  if (!name || typeof name !== 'string') {
    res.status(400).json({ error: 'name is required' });
    return;
  }
  if (!displayName || typeof displayName !== 'string') {
    res.status(400).json({ error: 'displayName is required' });
    return;
  }
  if (type && !['human', 'operator'].includes(type)) {
    res.status(400).json({ error: 'type must be human or operator' });
    return;
  }
  if (role && !['owner', 'operator', 'viewer'].includes(role)) {
    res.status(400).json({ error: 'role must be owner, operator, or viewer' });
    return;
  }
  // Check uniqueness
  if (usersRepo.getByName(name)) {
    res.status(409).json({ error: `User with name '${name}' already exists` });
    return;
  }
  try {
    const user = usersRepo.create({ name, displayName, type, role, linkedAccounts, notifications });
    // Always set a default avatar on creation
    if (!user.avatarUrl) {
      usersRepo.update(user.id, { avatarUrl: getDefaultAvatarUrl(user.id) });
      const updated = usersRepo.getById(user.id)!;
      res.status(201).json(updated);
    } else {
      res.status(201).json(user);
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? 'Failed to create user' });
  }
});

// PUT /api/users/:id — update user
router.put('/:id', requireScope('users:write'), (req, res) => {
  const existing = usersRepo.getById(req.params.id);
  if (!existing) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  const { name, displayName, type, role, avatarUrl, linkedAccounts, notifications } = req.body;
  if (type && !['human', 'operator'].includes(type)) {
    res.status(400).json({ error: 'type must be human or operator' });
    return;
  }
  if (role && !['owner', 'operator', 'viewer'].includes(role)) {
    res.status(400).json({ error: 'role must be owner, operator, or viewer' });
    return;
  }
  try {
    const updated = usersRepo.update(req.params.id, { name, displayName, type, role, avatarUrl, linkedAccounts, notifications });
    res.json(updated);
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? 'Failed to update user' });
  }
});

// DELETE /api/users/:id — delete user
router.delete('/:id', requireScope('users:write'), (req, res) => {
  const caller = (req as any).caller;
  const existing = usersRepo.getById(req.params.id);
  if (!existing) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  // Cannot delete yourself
  if (caller?.id === existing.id) {
    res.status(403).json({ error: 'Cannot delete your own account' });
    return;
  }
  // Only owners can delete other owners
  if (existing.role === 'owner' && caller?.role !== 'owner') {
    res.status(403).json({ error: 'Only owners can delete other owners' });
    return;
  }
  usersRepo.delete(req.params.id);
  deleteAvatar(existing.name, 'user').catch(() => {});
  res.status(204).end();
});

// GET /api/users/:id/projects — list projects for user
router.get('/:id/projects', requireScope('users:read'), (req, res) => {
  const user = usersRepo.getById(req.params.id) || usersRepo.getByName(req.params.id);
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  const projectIds = userProjectsRepo.getProjectsForUser(user.id);
  res.json({ projects: projectIds });
});

// ── Avatar routes ────────────────────────────────────────────────────

registerToolDef({
  name: 'armada_user_avatar_generate',
  description: 'Generate an AI avatar for a armada user.',
  method: 'POST', path: '/api/users/:id/avatar/generate',
  parameters: [{ name: 'id', type: 'string', description: 'User ID', required: true }],
});

registerToolDef({
  name: 'armada_user_avatar_delete',
  description: 'Delete the avatar for a armada user.',
  method: 'DELETE', path: '/api/users/:id/avatar',
  parameters: [{ name: 'id', type: 'string', description: 'User ID', required: true }],
});

// GET /api/users/:id/avatar/status — persisted generating flag
router.get('/:id/avatar/status', (req, res) => {
  const user = usersRepo.getById(req.params.id) || usersRepo.getByName(req.params.id);
  if (!user) { res.status(404).json({ error: 'User not found' }); return; }
  res.json({ generating: !!(user as any).avatarGenerating });
});

// POST /api/users/:id/avatar/generate — async with DB flag
router.post('/:id/avatar/generate', requireScope('users:write'), async (req, res) => {
  const user = usersRepo.getById(req.params.id) || usersRepo.getByName(req.params.id);
  if (!user) { res.status(404).json({ error: 'User not found' }); return; }
  if ((user as any).avatarGenerating) { res.status(409).json({ error: 'Avatar generation already in progress' }); return; }

  usersRepo.update(user.id, { avatarGenerating: 1 } as any);
  eventBus.emit('user.avatar.generating', { userId: user.id, userName: user.name });
  res.json({ status: 'generating', name: user.name });

  generateAvatar({
    name: user.name,
    role: user.role || 'user',
    kind: 'user',
    description: user.type === 'operator' ? 'AI operator agent' : 'human team member',
  }).then(() => {
    logActivity({ eventType: 'user.avatar.generated', detail: `Avatar generated for user ${user.name}` });
    const current = usersRepo.getById(user.id);
    const nextVersion = ((current as any)?.avatarVersion ?? 0) + 1;
    usersRepo.update(user.id, { avatarUrl: `/api/users/${user.name}/avatar`, avatarGenerating: 0, avatarVersion: nextVersion } as any);
    const avatarUrl = `/api/users/${user.name}/avatar`;
    eventBus.emit('user.avatar.completed', { userId: user.id, userName: user.name, avatarUrl, avatarVersion: nextVersion });
  }).catch((err) => {
    console.error(`[avatar] Failed to generate for user ${user.name}:`, err.message);
    usersRepo.update(user.id, { avatarGenerating: 0 } as any);
    eventBus.emit('user.avatar.failed', { userId: user.id, userName: user.name, error: err.message });
  });
});

// GET /api/users/:id/avatar — serve avatar (no auth for embedding in UI)
router.get('/:id/avatar', async (req, res) => {
  const user = usersRepo.getById(req.params.id) || usersRepo.getByName(req.params.id);
  if (!user) { res.status(404).json({ error: 'User not found' }); return; }

  const size = (['sm', 'md', 'lg'].includes(req.query.size as string) ? req.query.size : 'md') as 'sm' | 'md' | 'lg';
  const exists = await avatarExists(user.name, size, 'user');
  if (!exists) {
    // Fall back to avatarUrl if it's an external URL (e.g. DiceBear)
    if (user.avatarUrl && user.avatarUrl.startsWith('https://')) {
      res.redirect(302, user.avatarUrl);
      return;
    }
    res.status(404).json({ error: 'No avatar generated yet' });
    return;
  }

  const buf = await readAvatar(user.name, size, 'user');
  if (!buf) { res.status(404).json({ error: 'Avatar read failed' }); return; }
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'public, max-age=60');
  res.send(buf);
});

// DELETE /api/users/:id/avatar
router.delete('/:id/avatar', requireScope('users:write'), async (req, res) => {
  const user = usersRepo.getById(req.params.id) || usersRepo.getByName(req.params.id);
  if (!user) { res.status(404).json({ error: 'User not found' }); return; }
  await deleteAvatar(user.name, 'user');
  usersRepo.update(user.id, { avatarUrl: null as any });
  res.json({ status: 'deleted' });
});

// ── Credential management (owner only) ──────────────────────────────

// GET /api/users/:id/passkeys — list passkeys for a user (owner only)
router.get('/:id/passkeys', requireScope('users:write'), (req, res) => {
  const user = usersRepo.getById(req.params.id) || usersRepo.getByName(req.params.id);
  if (!user) { res.status(404).json({ error: 'User not found' }); return; }
  const passkeys = passkeyRepo.listByUser(user.id);
  res.json(passkeys);
});

// DELETE /api/users/:id/passkeys/:credentialId — remove a passkey (owner only)
router.delete('/:id/passkeys/:credentialId', requireScope('users:write'), (req, res) => {
  const user = usersRepo.getById(req.params.id) || usersRepo.getByName(req.params.id);
  if (!user) { res.status(404).json({ error: 'User not found' }); return; }
  const changes = passkeyRepo.deleteByIdAndUser(req.params.credentialId, user.id);
  if (changes === 0) {
    res.status(404).json({ error: 'Passkey not found' });
    return;
  }
  logActivity({ eventType: 'user.passkey_removed', detail: `Owner removed passkey ${req.params.credentialId} for user ${user.name}` });
  res.json({ ok: true });
});

// PUT /api/users/:id/password — reset another user's password (owner only)
router.put('/:id/password', requireScope('users:write'), async (req, res) => {
  const user = usersRepo.getById(req.params.id) || usersRepo.getByName(req.params.id);
  if (!user) { res.status(404).json({ error: 'User not found' }); return; }

  const { password } = req.body;
  if (!password || typeof password !== 'string' || password.length < 8) {
    res.status(400).json({ error: 'Password must be at least 8 characters' });
    return;
  }

  try {
    await resetUserPassword(user.id, password);
    logActivity({ eventType: 'user.password_reset', detail: `Owner reset password for user ${user.name}` });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? 'Failed to reset password' });
  }
});

export default router;
