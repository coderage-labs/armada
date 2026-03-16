import { createHash } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { sessionRepo } from '../repositories/session-repo.js';
import { authTokenRepo } from '../repositories/auth-token-repo.js';

export interface Caller {
  id: string;
  name: string;
  displayName: string;
  role: string;
  type: 'human' | 'agent' | 'operator' | 'system';
  agentName?: string;
  tokenId?: string;
  scopes?: string[];
}

declare global {
  namespace Express {
    interface Request {
      caller?: Caller;
    }
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
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
    (req.method === 'POST' && (req.path === '/api/auth/setup' || req.path === '/auth/setup')) ||
    (req.method === 'GET' && (req.path === '/api/auth/detected-url' || req.path === '/auth/detected-url')) ||
    (req.method === 'POST' && (req.path === '/api/auth/confirm-url' || req.path === '/auth/confirm-url'))
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
    const sessionToken = req.cookies?.armada_session;
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

        // Parse scopes from JSON string (handles null, empty string, already-parsed-array)
        let parsedScopes: string[] | undefined;
        if (row.scopes) {
          try {
            if (typeof row.scopes === 'string') {
              parsedScopes = JSON.parse(row.scopes);
            } else if (Array.isArray(row.scopes)) {
              parsedScopes = row.scopes;
            }
          } catch {
            // If parsing fails, leave undefined
          }
        }

        req.caller = {
          id: row.uid || row.tokenId,
          name: row.name || row.agentName || 'unknown',
          displayName: row.displayName || row.name || row.agentName || 'Unknown',
          role: row.role || 'agent',
          type: row.agentName ? 'agent' : ((row.type || 'human') as Caller['type']),
          agentName: row.agentName || undefined,
          tokenId: row.tokenId,
          scopes: parsedScopes,
        };
        next();
        return;
      }
    }
  } catch (err: any) {
    console.warn('[auth] DB not initialized yet or table missing:', err.message);
  }

  res.status(401).json({ error: 'Missing or invalid Authorization header' });
}
