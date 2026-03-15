import { randomBytes, createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { Request, Response, NextFunction } from 'express';
import { sessionRepo } from '../repositories/session-repo.js';
import { authTokenRepo } from '../repositories/auth-token-repo.js';
import { usersRepo } from '../repositories/user-repo.js';

export interface Caller {
  id: string;
  name: string;
  displayName: string;
  role: string;
  type: 'human' | 'agent' | 'operator' | 'system';
  agentName?: string;
  tokenId?: string;
}

declare global {
  namespace Express {
    interface Request {
      caller?: Caller;
    }
  }
}

let apiToken: string | null = null;

function getToken(): string {
  if (apiToken) return apiToken;

  // Check env first
  if (process.env.FLEET_API_TOKEN) {
    apiToken = process.env.FLEET_API_TOKEN;
    return apiToken;
  }

  // Check token file
  const tokenPath = './fleet-token.txt';
  if (existsSync(tokenPath)) {
    apiToken = readFileSync(tokenPath, 'utf-8').trim();
    return apiToken;
  }

  // Generate a new token
  apiToken = randomBytes(32).toString('hex');
  writeFileSync(tokenPath, apiToken + '\n', { mode: 0o600 });
  console.log(`🔑 Generated API token → ${tokenPath}`);
  return apiToken;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Returns the API token used to authenticate against this control plane. */
export function getApiToken(): string {
  return getToken();
}

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Skip auth for public health endpoint
  if (req.method === 'GET' && (req.path === '/health' || req.path === '/api/health')) {
    next();
    return;
  }

  // Skip auth for passkey login endpoints (public — unauthenticated users need these)
  if (req.method === 'POST' && (
    req.path === '/api/auth/passkey/login-options' ||
    req.path === '/api/auth/passkey/login-verify' ||
    req.path === '/auth/passkey/login-options' ||
    req.path === '/auth/passkey/login-verify' ||
    req.path === '/api/auth/login/password' ||
    req.path === '/auth/login/password'
  )) {
    next();
    return;
  }

  // Skip auth for invite validate (GET) and accept (POST) endpoints — public
  if (
    req.path.match(/^\/api\/auth\/invites\/[a-f0-9]+\/validate$/) ||
    req.path.match(/^\/auth\/invites\/[a-f0-9]+\/validate$/) ||
    req.path.match(/^\/api\/auth\/invites\/[a-f0-9]+\/accept$/) ||
    req.path.match(/^\/auth\/invites\/[a-f0-9]+\/accept$/)
  ) {
    next();
    return;
  }

  // Skip auth for first-boot setup endpoints (public)
  if (
    (req.method === 'GET' && (req.path === '/api/auth/setup-status' || req.path === '/auth/setup-status')) ||
    (req.method === 'POST' && (req.path === '/api/auth/setup' || req.path === '/auth/setup'))
  ) {
    next();
    return;
  }

  // Skip auth for avatar GET (so <img src> works without token headers)
  if (req.method === 'GET' && (
    req.path.match(/^\/agents\/[\w-]+\/avatar$/) ||
    req.path.match(/^\/users\/[\w-]+\/avatar$/)
  )) {
    next();
    return;
  }

  // Extract token from header or query param (SSE)
  const header = req.headers.authorization;
  const queryToken = req.query.token as string | undefined;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : queryToken;

  try {
    // 1. Check session cookie (works even without Bearer token)
    const sessionToken = req.cookies?.fleet_session;
    if (sessionToken) {
      const sessionHash = hashToken(sessionToken);
      const session = sessionRepo.findByHash(sessionHash);

      if (session && (!session.expiresAt || new Date(session.expiresAt) > new Date())) {
        req.caller = {
          id: session.userId,
          name: session.name,
          displayName: session.displayName || session.name,
          role: session.role || 'viewer',
          type: (session.type || 'human') as Caller['type'],
        };
        next();
        return;
      }
    }

    // 2. Check per-user/agent tokens in the database
    if (token) {
      const hash = hashToken(token);
      const row = authTokenRepo.findByHash(hash);

      if (row) {
        // Check expiry
        if (row.expiresAt && new Date(row.expiresAt) < new Date()) {
          res.status(401).json({ error: 'Token expired' });
          return;
        }
        // Update last_used_at
        authTokenRepo.updateLastUsed(row.tokenId);

        req.caller = {
          id: row.uid || row.tokenId,
          name: row.name || row.agentName || 'unknown',
          displayName: row.displayName || row.name || row.agentName || 'Unknown',
          role: row.role || 'agent',
          type: row.agentName ? 'agent' : ((row.type || 'human') as Caller['type']),
          agentName: row.agentName || undefined,
          tokenId: row.tokenId,
        };
        next();
        return;
      }
    }
  } catch (err: any) {
    console.warn('[auth] DB not initialized yet or table missing:', err.message);
  }

  if (!token) {
    res.status(401).json({ error: 'Missing or invalid Authorization header' });
    return;
  }

  // 3. Fallback: legacy FLEET_API_TOKEN / FLEET_HOOKS_TOKEN (backward compat)
  const hooksToken = process.env.FLEET_HOOKS_TOKEN || '';
  if (token === getToken() || (hooksToken && token === hooksToken)) {
    const operatorName = process.env.FLEET_OPERATOR_NAME || 'operator';
    // Try to resolve to a real user record
    let resolvedUser: any = null;
    try {
      // usersRepo imported at top level
      resolvedUser = usersRepo.getByName(operatorName);
    } catch (err: any) { console.warn('[auth] Failed to resolve operator user:', err.message); }
    req.caller = resolvedUser ? {
      id: resolvedUser.id,
      name: resolvedUser.name,
      displayName: resolvedUser.displayName || resolvedUser.name,
      role: resolvedUser.role || 'owner',
      type: resolvedUser.type || 'operator',
    } : {
      id: 'admin',
      name: operatorName,
      displayName: operatorName,
      role: 'owner',
      type: 'operator',
    };
    next();
    return;
  }

  res.status(401).json({ error: 'Invalid API token' });
}
