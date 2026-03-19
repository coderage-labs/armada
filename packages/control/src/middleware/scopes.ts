import type { RequestHandler } from 'express';

// All available scopes
export const ALL_SCOPES = [
  'users:read', 'users:write',
  'agents:read', 'agents:write',
  'instances:read', 'instances:write',
  'workflows:read', 'workflows:write',
  'tasks:read', 'tasks:write',
  'templates:read', 'templates:write',
  'integrations:read', 'integrations:write',
  'issues:read', 'issues:write',
  'prs:read', 'prs:write',
  'projects:read', 'projects:write',
  'models:read', 'models:write',
  'nodes:read', 'nodes:write',
  'plugins:read', 'plugins:write',
  'skills:read', 'skills:write',
  'webhooks:read', 'webhooks:write',
  'audit:read',
  'system:read', 'system:write',
] as const;

export type Scope = (typeof ALL_SCOPES)[number];

// Role → scopes mapping
const READ_SCOPES = ALL_SCOPES.filter((s): s is Scope => s.endsWith(':read'));
const ALL_EXCEPT_ADMIN = ALL_SCOPES.filter(
  (s): s is Scope => s !== 'users:write' && s !== 'system:write',
);

export function getScopesForRole(role: string): Scope[] {
  switch (role) {
    case 'owner':
      return [...ALL_SCOPES];
    case 'operator':
      return [...ALL_EXCEPT_ADMIN];
    case 'viewer':
      return [...READ_SCOPES];
    default:
      return [...READ_SCOPES];
  }
}

// Middleware: require one or more scopes
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function requireScope(...scopes: Scope[]): any {
  const handler: RequestHandler = (req, res, next) => {
    const caller = (req as any).caller;
    if (!caller) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    
    // Use token-specific scopes if present, otherwise fall back to role-based scopes
    const userScopes = caller.scopes && Array.isArray(caller.scopes) && caller.scopes.length > 0
      ? caller.scopes
      : getScopesForRole(caller.role);
    
    const missing = userScopes.includes('*' as any) ? [] : scopes.filter(s => !userScopes.includes(s));
    if (missing.length > 0) {
      res.status(403).json({ error: 'Insufficient permissions', required: scopes, missing });
      return;
    }
    next();
  };
  return handler;
}
