/**
 * Auth Service — business logic for all authentication and identity flows.
 *
 * Extracted from the auth route to keep route handlers thin:
 *   validate → call service → format response.
 *
 * Covers: password auth, passkey auth, session management,
 *         first-boot setup, invite flows, and API token lifecycle.
 */

import { randomUUID, randomBytes, createHash } from 'node:crypto';
import bcrypt from 'bcrypt';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { getDrizzle } from '../db/drizzle.js';
import { users } from '../db/drizzle-schema.js';
import { eq } from 'drizzle-orm';
import { authTokenRepo } from '../repositories/auth-token-repo.js';
import { sessionRepo } from '../repositories/session-repo.js';
import { passkeyRepo } from '../repositories/passkey-repo.js';
import { challengeRepo } from '../repositories/challenge-repo.js';
import { inviteRepo } from '../repositories/invite-repo.js';
import { usersRepo } from '../repositories/index.js';
import { settingsRepo } from '../repositories/settings-repo.js';
import { getDefaultAvatarUrl, generateAvatar } from './avatar-generator.js';

// ── Config ───────────────────────────────────────────────────────────

const BCRYPT_COST = 12;

export const rpName = process.env.FLEET_RP_NAME || 'Fleet Control';
export const rpID = process.env.FLEET_RP_ID || 'localhost';
export const origin = process.env.FLEET_ORIGIN || 'http://localhost:3001';

// ── Helpers ──────────────────────────────────────────────────────────

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface SessionData {
  sessionToken: string;
  sessionId: string;
  expiresAt: string;
}

/**
 * Create a new session for a user. Returns the plaintext token (set as cookie by caller).
 */
export function createSession(userId: string): SessionData {
  const sessionToken = randomBytes(32).toString('hex');
  const sessionHash = hashToken(sessionToken);
  const sessionId = randomUUID();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  sessionRepo.create({ id: sessionId, userId, tokenHash: sessionHash, expiresAt });
  return { sessionToken, sessionId, expiresAt };
}

// ── API Token management ─────────────────────────────────────────────

export interface CreateTokenParams {
  userId: string;
  agentName?: string;
  label?: string;
  scopes?: string[];
  expiresIn?: number;
}

export interface CreatedToken {
  id: string;
  token: string;
  userId: string | null;
  agentName: string | null;
  label: string;
  scopes: string[];
  expiresAt: string | null;
  createdAt: string;
}

export function createApiToken(params: CreateTokenParams): CreatedToken {
  const { userId, agentName, label, scopes, expiresIn } = params;
  const plainToken = randomBytes(32).toString('hex');
  const hash = hashToken(plainToken);
  const id = randomUUID();

  let expiresAt: string | null = null;
  if (expiresIn) {
    const ms = typeof expiresIn === 'number' ? expiresIn : parseInt(expiresIn, 10);
    if (!isNaN(ms) && ms > 0) {
      expiresAt = new Date(Date.now() + ms).toISOString();
    }
  }

  authTokenRepo.create({
    id,
    tokenHash: hash,
    userId: userId || null,
    agentName: agentName || null,
    label: label || '',
    scopes: scopes || [],
    expiresAt,
  });

  return {
    id,
    token: plainToken,
    userId: userId || null,
    agentName: agentName || null,
    label: label || '',
    scopes: scopes || [],
    expiresAt,
    createdAt: new Date().toISOString(),
  };
}

// ── Password authentication ───────────────────────────────────────────

export interface LoginResult {
  user: { id: string; name: string; displayName: string; role: string; type: string };
  session: SessionData;
}

export async function loginWithPassword(name: string, password: string): Promise<LoginResult> {
  const user = getDrizzle()
    .select({ id: users.id, name: users.name, displayName: users.displayName, role: users.role, type: users.type, passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.name, name))
    .get();

  if (!user || !user.passwordHash) {
    throw Object.assign(new Error('Invalid username or password'), { statusCode: 401 });
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    throw Object.assign(new Error('Invalid username or password'), { statusCode: 401 });
  }

  const session = createSession(user.id);

  return {
    user: { id: user.id, name: user.name, displayName: user.displayName, role: user.role, type: user.type },
    session,
  };
}

export async function setOrChangePassword(userId: string, newPassword: string, currentPassword?: string): Promise<void> {
  const user = getDrizzle().select({ passwordHash: users.passwordHash }).from(users).where(eq(users.id, userId)).get();
  if (!user) {
    throw Object.assign(new Error('User not found'), { statusCode: 404 });
  }

  // If user already has a password, require currentPassword
  if (user.passwordHash) {
    if (!currentPassword) {
      throw Object.assign(new Error('Current password is required to change password'), { statusCode: 400 });
    }
    const valid = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!valid) {
      throw Object.assign(new Error('Current password is incorrect'), { statusCode: 403 });
    }
  }

  const hash = await bcrypt.hash(newPassword, BCRYPT_COST);
  getDrizzle().update(users).set({ passwordHash: hash }).where(eq(users.id, userId)).run();
}

export function removeUserPassword(userId: string): void {
  const passkeyCount = passkeyRepo.countByUser(userId);
  if (passkeyCount === 0) {
    throw Object.assign(
      new Error('Cannot remove password — you have no passkeys registered. Add a passkey first.'),
      { statusCode: 400 },
    );
  }
  getDrizzle().update(users).set({ passwordHash: null }).where(eq(users.id, userId)).run();
}

export function getUserPasswordStatus(userId: string): boolean {
  try {
    const row = getDrizzle().select({ passwordHash: users.passwordHash }).from(users).where(eq(users.id, userId)).get();
    return !!(row && row.passwordHash);
  } catch { return false; }
}

export async function resetUserPassword(userId: string, newPassword: string): Promise<void> {
  const hash = await bcrypt.hash(newPassword, BCRYPT_COST);
  getDrizzle().update(users).set({ passwordHash: hash }).where(eq(users.id, userId)).run();
}

// ── Passkey registration ──────────────────────────────────────────────

export interface CallerInfo {
  id: string;
  name: string;
  displayName: string;
  role: string;
}

export async function createPasskeyRegisterOptions(caller: CallerInfo) {
  const existingPasskeys = passkeyRepo.getCredentialIdsByUser(caller.id);

  const options = await generateRegistrationOptions({
    rpName,
    rpID,
    userName: caller.name,
    userDisplayName: caller.displayName,
    excludeCredentials: existingPasskeys.map(pk => ({ id: pk.credentialId })),
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'preferred',
    },
  });

  const challengeId = randomUUID();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  challengeRepo.create({ id: challengeId, challenge: options.challenge, userId: caller.id, type: 'registration', expiresAt });
  challengeRepo.deleteExpired();

  return options;
}

export interface PasskeyRegisterResult {
  id: string;
  label: string;
}

export async function verifyPasskeyRegistration(caller: CallerInfo, body: any, labelOverride?: string): Promise<PasskeyRegisterResult> {
  const challenge = challengeRepo.findLatestForUser(caller.id, 'registration');
  if (!challenge) {
    throw Object.assign(new Error('No valid challenge found — please try again'), { statusCode: 400 });
  }

  const verification = await verifyRegistrationResponse({
    response: body,
    expectedChallenge: challenge.challenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    requireUserVerification: false,
  });

  if (!verification.verified || !verification.registrationInfo) {
    throw Object.assign(new Error('Verification failed'), { statusCode: 400 });
  }

  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;

  const id = randomUUID();
  const label = labelOverride || `Passkey (${credentialDeviceType}${credentialBackedUp ? ', backed up' : ''})`;
  passkeyRepo.create({
    id,
    userId: caller.id,
    credentialId: credential.id,
    publicKey: Buffer.from(credential.publicKey).toString('base64url'),
    counter: credential.counter,
    transports: JSON.stringify(credential.transports || []),
    label,
  });

  challengeRepo.deleteById(challenge.id);

  // Set default avatar on first passkey registration, then try AI upgrade
  const freshUser = usersRepo.getById(caller.id);
  if (freshUser && !freshUser.avatarUrl) {
    usersRepo.update(caller.id, { avatarUrl: getDefaultAvatarUrl(caller.id) });

    // Avatar generation is enabled when a model is configured
    const avatarModelConfigured = !!settingsRepo.get('avatar_model_id');
    if (avatarModelConfigured) {
      generateAvatar({
        name: freshUser.name,
        role: freshUser.role || 'user',
        kind: 'user',
        description: freshUser.type === 'operator' ? 'AI operator agent' : 'human team member',
      }).then(() => {
        const current = usersRepo.getById(freshUser.id);
        const nextVersion = ((current as any)?.avatarVersion ?? 0) + 1;
        usersRepo.update(freshUser.id, { avatarUrl: `/api/users/${freshUser.name}/avatar`, avatarVersion: nextVersion });
      }).catch((err) => {
        console.warn(`[avatar] AI generation failed for ${freshUser.name}:`, err.message);
      });
    }
  }

  return { id, label };
}

// ── Passkey login ─────────────────────────────────────────────────────

export async function createPasskeyLoginOptions() {
  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: 'preferred',
  });

  const challengeId = randomUUID();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  challengeRepo.create({ id: challengeId, challenge: options.challenge, userId: null, type: 'authentication', expiresAt });
  challengeRepo.deleteExpired();

  return options;
}

export async function verifyPasskeyLogin(body: any): Promise<LoginResult> {
  const { id: credentialId } = body;

  if (!credentialId) {
    throw Object.assign(new Error('Missing credential id in response'), { statusCode: 400 });
  }

  const passkey = passkeyRepo.findByCredentialId(credentialId);
  if (!passkey) {
    throw Object.assign(new Error('Unknown credential'), { statusCode: 400 });
  }

  const challenge = challengeRepo.findLatestByType('authentication');
  if (!challenge) {
    throw Object.assign(new Error('No valid challenge found — please try again'), { statusCode: 400 });
  }

  const verification = await verifyAuthenticationResponse({
    response: body,
    expectedChallenge: challenge.challenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    requireUserVerification: false,
    credential: {
      id: passkey.credentialId,
      publicKey: Buffer.from(passkey.publicKey, 'base64url'),
      counter: passkey.counter,
      transports: passkey.transports ? JSON.parse(passkey.transports) : undefined,
    },
  });

  if (!verification.verified) {
    throw Object.assign(new Error('Authentication failed'), { statusCode: 400 });
  }

  passkeyRepo.updateCounter(passkey.id, verification.authenticationInfo.newCounter);
  challengeRepo.deleteById(challenge.id);

  const user = getDrizzle()
    .select({ id: users.id, name: users.name, displayName: users.displayName, role: users.role, type: users.type })
    .from(users)
    .where(eq(users.id, passkey.userId))
    .get();

  if (!user) {
    throw Object.assign(new Error('User not found'), { statusCode: 400 });
  }

  const session = createSession(user.id);

  return {
    user: { id: user.id, name: user.name, displayName: user.displayName, role: user.role, type: user.type },
    session,
  };
}

// ── First-boot setup ──────────────────────────────────────────────────

export function checkSetupNeeded(): boolean {
  const humanUser = getDrizzle()
    .select({ id: users.id })
    .from(users)
    .where(eq(users.type, 'human'))
    .limit(1)
    .get();
  return !humanUser;
}

export interface SetupResult {
  user: { id: string; name: string; displayName: string; role: string; type: string };
  session: SessionData;
}

export function setupFirstUser(name: string, displayName: string): SetupResult {
  const userId = randomUUID();
  getDrizzle().insert(users).values({
    id: userId,
    name,
    displayName,
    type: 'human',
    role: 'owner',
    linkedAccountsJson: '{}',
    notificationsJson: '{}',
  }).run();

  const session = createSession(userId);

  return {
    user: { id: userId, name, displayName, role: 'owner', type: 'human' },
    session,
  };
}

// ── Invite flows ──────────────────────────────────────────────────────

export interface CreateInviteResult {
  id: string;
  inviteUrl: string;
  expiresAt: string;
}

export function createInviteLink(
  creatorId: string,
  role: 'operator' | 'viewer',
  opts: { displayName?: string; expiresInHours?: number } = {},
): CreateInviteResult {
  const id = randomUUID();
  const token = randomBytes(32).toString('hex');
  const tokenHash = hashToken(token);
  const hours = typeof opts.expiresInHours === 'number' && opts.expiresInHours > 0 ? opts.expiresInHours : 24;
  const expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();

  inviteRepo.create({ id, tokenHash, createdBy: creatorId, role, displayName: opts.displayName || null, expiresAt });

  const inviteUrl = `${origin}/invite/${token}`;
  return { id, inviteUrl, expiresAt };
}

export interface InviteValidation {
  valid: boolean;
  error?: string;
  role?: string;
  displayName?: string | null;
}

export function validateInviteToken(token: string): InviteValidation {
  const tokenHash = hashToken(token);
  const invite = inviteRepo.findByTokenHash(tokenHash);

  if (!invite) return { valid: false, error: 'Invite not found' };
  if (invite.usedAt) return { valid: false, error: 'Invite already used' };
  if (new Date(invite.expiresAt) < new Date()) return { valid: false, error: 'Invite expired' };

  return { valid: true, role: invite.role, displayName: invite.displayName };
}

export interface AcceptInviteResult {
  user: { id: string; name: string; displayName: string; role: string; type: string };
  session: SessionData;
}

export function acceptInvite(token: string, name: string, displayName?: string): AcceptInviteResult {
  const tokenHash = hashToken(token);
  const invite = inviteRepo.findByTokenHash(tokenHash);

  if (!invite) throw Object.assign(new Error('Invite not found'), { statusCode: 404 });
  if (invite.usedAt) throw Object.assign(new Error('Invite already used'), { statusCode: 400 });
  if (new Date(invite.expiresAt) < new Date()) throw Object.assign(new Error('Invite expired'), { statusCode: 400 });

  const existing = getDrizzle().select({ id: users.id }).from(users).where(eq(users.name, name)).get();
  if (existing) throw Object.assign(new Error('Username already taken'), { statusCode: 409 });

  const userId = randomUUID();
  const finalDisplayName = displayName || invite.displayName || name;
  const avatarUrl = getDefaultAvatarUrl(userId);

  getDrizzle().insert(users).values({
    id: userId,
    name,
    displayName: finalDisplayName,
    type: 'human',
    role: invite.role,
    avatarUrl,
  }).run();

  inviteRepo.markUsed(invite.id, userId);

  const session = createSession(userId);

  return {
    user: { id: userId, name, displayName: finalDisplayName, role: invite.role, type: 'human' },
    session,
  };
}
