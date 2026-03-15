import { Router } from 'express';
import { getDrizzle } from '../db/drizzle.js';
import { users } from '../db/drizzle-schema.js';
import { eq } from 'drizzle-orm';
import { logAudit } from '../services/audit.js';
import { requireScope, getScopesForRole } from '../middleware/scopes.js';
import { usersRepo } from '../repositories/user-repo.js';
import { authTokenRepo } from '../repositories/auth-token-repo.js';
import { passkeyRepo } from '../repositories/passkey-repo.js';
import {
  origin,
  hashToken,
  createApiToken,
  loginWithPassword,
  setOrChangePassword,
  removeUserPassword,
  getUserPasswordStatus,
  createSession,
  createPasskeyRegisterOptions,
  verifyPasskeyRegistration,
  createPasskeyLoginOptions,
  verifyPasskeyLogin,
  checkSetupNeeded,
  setupFirstUser,
  createInviteLink,
  validateInviteToken,
  acceptInvite,
} from '../services/auth-service.js';
import { inviteRepo } from '../repositories/invite-repo.js';

const router = Router();

// POST /api/auth/tokens — create a new API token (owner only)
router.post('/tokens', requireScope('users:write'), (req, res) => {
  const caller = req.caller!;
  const { agentName, label, scopes, expiresIn } = req.body;

  const result = createApiToken({ userId: caller.id, agentName, label, scopes, expiresIn });

  logAudit(req, 'token.create', 'auth_token', result.id, { agentName, label });
  res.status(201).json(result);
});

// GET /api/auth/tokens — list tokens (masked)
router.get('/tokens', (req, res) => {
  const caller = req.caller;
  if (!caller) {
    res.status(401).json({ error: 'Auth required' });
    return;
  }

  const tokens = caller.role === 'owner'
    ? authTokenRepo.listAll()
    : authTokenRepo.listByUser(caller.id);

  res.json(tokens);
});

// DELETE /api/auth/tokens/:id — revoke a token (owner only)
router.delete('/tokens/:id', (req, res) => {
  const caller = req.caller;
  if (!caller) { res.status(401).json({ error: 'Auth required' }); return; }

  const changes = caller.role === 'owner'
    ? authTokenRepo.deleteById(req.params.id)
    : authTokenRepo.deleteByIdAndUser(req.params.id, caller.id);

  if (changes === 0) {
    res.status(404).json({ error: 'Token not found' });
    return;
  }
  logAudit(req, 'token.revoke', 'auth_token', req.params.id);
  res.json({ ok: true });
});

// GET /api/auth/me — get current caller info (full user record)
router.get('/me', (req, res) => {
  if (!req.caller) {
    res.status(401).json({ error: 'Auth required' });
    return;
  }
  // Fetch full user record (includes linkedAccounts, notifications, avatarUrl)
  const fullUser = usersRepo.getById(req.caller.id);
  const hasPassword = getUserPasswordStatus(req.caller.id);
  const scopes = getScopesForRole(req.caller.role);
  res.json({ ...(fullUser ?? req.caller), hasPassword, scopes });
});

// PUT /api/auth/me — update own profile (no special scope needed)
router.put('/me', (req, res) => {
  if (!req.caller) {
    res.status(401).json({ error: 'Auth required' });
    return;
  }
  const { displayName, linkedAccounts } = req.body;
  const update: Record<string, any> = {};
  if (displayName !== undefined) update.displayName = displayName;
  if (linkedAccounts !== undefined) update.linkedAccounts = linkedAccounts;
  try {
    const db = getDrizzle();
    if (Object.keys(update).length > 0) {
      const sets: Record<string, any> = {};
      if (update.displayName !== undefined) sets.displayName = update.displayName;
      if (update.linkedAccounts !== undefined) sets.linkedAccounts = JSON.stringify(update.linkedAccounts);
      db.update(users).set(sets).where(eq(users.id, req.caller.id)).run();
    }
    // Re-fetch and return
    const row = db.select().from(users).where(eq(users.id, req.caller.id)).get();
    if (!row) { res.status(404).json({ error: 'User not found' }); return; }
    res.json(row);
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? 'Failed to update profile' });
  }
});

// ── Password Authentication ───────────────────────────────────────────

// POST /api/auth/login/password — PUBLIC (no auth needed)
router.post('/login/password', async (req, res) => {
  try {
    const { name, password } = req.body;
    if (!name || !password) {
      res.status(400).json({ error: 'name and password are required' });
      return;
    }

    const { user, session } = await loginWithPassword(name, password);

    res.cookie('fleet_session', session.sessionToken, {
      httpOnly: true,
      secure: origin.startsWith('https'),
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60 * 1000,
      path: '/',
    });

    logAudit(req, 'password.login', 'session', session.sessionId, { userId: user.id, userName: user.name });
    res.json({ ok: true, user });
  } catch (err: any) {
    const status = err.statusCode || 500;
    res.status(status).json({ error: status === 500 ? 'Login failed' : err.message });
  }
});

// POST /api/auth/password — set or change password (authenticated)
router.post('/password', async (req, res) => {
  const caller = req.caller;
  if (!caller) { res.status(401).json({ error: 'Auth required' }); return; }

  try {
    const { password, currentPassword } = req.body;
    if (!password || typeof password !== 'string' || password.length < 8) {
      res.status(400).json({ error: 'Password must be at least 8 characters' });
      return;
    }

    // Check if this is a change (has existing password) for audit event selection
    const hadPassword = getUserPasswordStatus(caller.id);
    await setOrChangePassword(caller.id, password, currentPassword);

    logAudit(req, hadPassword ? 'password.change' : 'password.set', 'user', caller.id);
    res.json({ ok: true });
  } catch (err: any) {
    const status = err.statusCode || 500;
    res.status(status).json({ error: status === 500 ? 'Failed to update password' : err.message });
  }
});

// DELETE /api/auth/password — remove password (authenticated, requires passkey)
router.delete('/password', (req, res) => {
  const caller = req.caller;
  if (!caller) { res.status(401).json({ error: 'Auth required' }); return; }

  try {
    removeUserPassword(caller.id);
    logAudit(req, 'password.remove', 'user', caller.id);
    res.json({ ok: true });
  } catch (err: any) {
    const status = err.statusCode || 500;
    res.status(status).json({ error: err.message });
  }
});

// ── Passkey Registration ──────────────────────────────────────────────

// POST /api/auth/passkey/register-options — any authenticated user
router.post('/passkey/register-options', async (req, res) => {
  try {
    const caller = req.caller;
    if (!caller) { res.status(401).json({ error: 'Authentication required' }); return; }

    const options = await createPasskeyRegisterOptions(caller);
    res.json(options);
  } catch (err: any) {
    console.error('passkey register-options error:', err);
    res.status(500).json({ error: err.message || 'Failed to generate registration options' });
  }
});

// POST /api/auth/passkey/register-verify — any authenticated user
router.post('/passkey/register-verify', async (req, res) => {
  try {
    const caller = req.caller;
    if (!caller) { res.status(401).json({ error: 'Auth required' }); return; }

    const result = await verifyPasskeyRegistration(caller, req.body, req.body.label);
    logAudit(req, 'passkey.register', 'passkey', result.id, { userId: caller.id, label: result.label });
    res.json({ ok: true, ...result });
  } catch (err: any) {
    console.error('passkey register-verify error:', err);
    const status = err.statusCode || 500;
    res.status(status).json({ error: err.message || 'Verification failed' });
  }
});

// ── Passkey Login ─────────────────────────────────────────────────────

// POST /api/auth/passkey/login-options — PUBLIC (no auth needed)
router.post('/passkey/login-options', async (_req, res) => {
  try {
    const options = await createPasskeyLoginOptions();
    res.json(options);
  } catch (err: any) {
    console.error('passkey login-options error:', err);
    res.status(500).json({ error: err.message || 'Failed to generate authentication options' });
  }
});

// POST /api/auth/passkey/login-verify — PUBLIC (no auth needed)
router.post('/passkey/login-verify', async (req, res) => {
  try {
    const { user, session } = await verifyPasskeyLogin(req.body);

    res.cookie('fleet_session', session.sessionToken, {
      httpOnly: true,
      secure: origin.startsWith('https'),
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60 * 1000,
      path: '/',
    });

    logAudit(req, 'passkey.login', 'session', session.sessionId, { userId: user.id, userName: user.name });
    res.json({ ok: true, user });
  } catch (err: any) {
    console.error('passkey login-verify error:', err);
    const status = err.statusCode || 500;
    res.status(status).json({ error: err.message || 'Authentication failed' });
  }
});

// GET /api/auth/passkeys — list current user's passkeys
router.get('/passkeys', (req, res) => {
  const caller = req.caller;
  if (!caller) { res.status(401).json({ error: 'Auth required' }); return; }
  res.json(passkeyRepo.listByUser(caller.id));
});

// DELETE /api/auth/passkeys/:id — remove own passkey
router.delete('/passkeys/:id', (req, res) => {
  const caller = req.caller;
  if (!caller) { res.status(401).json({ error: 'Auth required' }); return; }

  // Ensure user won't lock themselves out
  const pkCount = passkeyRepo.countByUser(caller.id);
  const userRow = getDrizzle().select({ passwordHash: users.passwordHash }).from(users).where(eq(users.id, caller.id)).get();
  const hasPassword = !!(userRow && userRow.passwordHash);

  if (pkCount <= 1 && !hasPassword) {
    res.status(400).json({ error: 'Cannot delete your only passkey without a password set. Add a password first.' });
    return;
  }

  const changes = passkeyRepo.deleteByIdAndUser(req.params.id, caller.id);
  if (changes === 0) { res.status(404).json({ error: 'Passkey not found' }); return; }

  logAudit(req, 'passkey.delete', 'passkey', req.params.id);
  res.json({ ok: true });
});

// ── First-boot Setup ──────────────────────────────────────────────────

// GET /api/auth/setup-status — PUBLIC (no auth needed)
router.get('/setup-status', (_req, res) => {
  res.json({ needsSetup: checkSetupNeeded() });
});

// POST /api/auth/setup — PUBLIC (no auth needed, only works when no human users exist)
router.post('/setup', (req, res) => {
  if (!checkSetupNeeded()) {
    res.status(403).json({ error: 'Setup already completed — a human user already exists' });
    return;
  }

  const { name, displayName } = req.body;
  if (!name || !displayName) {
    res.status(400).json({ error: 'name and displayName are required' });
    return;
  }
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    res.status(400).json({ error: 'Name must be lowercase alphanumeric (start with letter, hyphens allowed)' });
    return;
  }

  // Check name uniqueness
  const existing = getDrizzle().select({ id: users.id }).from(users).where(eq(users.name, name)).get();
  if (existing) {
    res.status(409).json({ error: 'A user with that name already exists' });
    return;
  }

  const { user, session } = setupFirstUser(name, displayName);

  res.cookie('fleet_session', session.sessionToken, {
    httpOnly: true,
    secure: origin.startsWith('https'),
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000,
    path: '/',
  });

  logAudit(req, 'setup.create-owner', 'user', user.id, { name, displayName });
  res.status(201).json({ ok: true, user });
});

// ── Invite Flow ───────────────────────────────────────────────────────

// POST /api/auth/invites — create an invite (owner only)
router.post('/invites', requireScope('users:write'), (req, res) => {
  const caller = req.caller!;
  const { role, displayName, expiresInHours } = req.body;

  if (!role || !['operator', 'viewer'].includes(role)) {
    res.status(400).json({ error: 'role must be "operator" or "viewer"' });
    return;
  }

  const result = createInviteLink(caller.id, role as 'operator' | 'viewer', { displayName, expiresInHours });
  logAudit(req, 'invite.create', 'invite', result.id, { role, displayName });
  res.status(201).json(result);
});

// GET /api/auth/invites — list all invites (owner only)
router.get('/invites', requireScope('users:write'), (_req, res) => {
  res.json(inviteRepo.listAll());
});

// GET /api/auth/invites/:token/validate — PUBLIC
router.get('/invites/:token/validate', (req, res) => {
  const validation = validateInviteToken(req.params.token);
  if (!validation.valid) {
    const status = validation.error === 'Invite not found' ? 404 : 200;
    res.status(status).json(validation);
    return;
  }
  res.json(validation);
});

// POST /api/auth/invites/:token/accept — PUBLIC
router.post('/invites/:token/accept', (req, res) => {
  const { name, displayName } = req.body;
  if (!name || typeof name !== 'string' || !/^[a-z0-9-]+$/.test(name)) {
    res.status(400).json({ error: 'name is required (lowercase alphanumeric + hyphens)' });
    return;
  }

  try {
    const { user, session } = acceptInvite(req.params.token, name, displayName);

    res.cookie('fleet_session', session.sessionToken, {
      httpOnly: true,
      secure: origin.startsWith('https'),
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60 * 1000,
      path: '/',
    });

    logAudit(req, 'invite.accept', 'invite', req.params.token, { userId: user.id, name });
    res.status(201).json({ user });
  } catch (err: any) {
    const status = err.statusCode || 500;
    res.status(status).json({ error: err.message });
  }
});

// DELETE /api/auth/invites/:id — revoke a pending invite (owner only)
router.delete('/invites/:id', requireScope('users:write'), (req, res) => {
  const invite = inviteRepo.findById(req.params.id);
  if (!invite) { res.status(404).json({ error: 'Invite not found' }); return; }
  if (invite.usedAt) { res.status(400).json({ error: 'Cannot revoke a used invite' }); return; }

  inviteRepo.deleteById(req.params.id);
  logAudit(req, 'invite.revoke', 'invite', req.params.id);
  res.json({ ok: true });
});

export default router;
