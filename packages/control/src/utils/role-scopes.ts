/**
 * Maps agent roles to the tool scopes they can access.
 * Tools without a scope are accessible to all roles.
 * 'general' role gets everything (backwards compat).
 */
export const ROLE_SCOPES: Record<string, string[]> = {
  'research': [
    'workflows:read', 'projects:read', 'tasks:read',
    'agents:read', 'instances:read',
  ],
  'development': [
    'workflows:read', 'workflows:write', 'projects:read', 'tasks:read',
    'agents:read', 'instances:read',
  ],
  'project-management': [
    'workflows:read', 'workflows:write',
    'projects:read', 'projects:write',
    'tasks:read', 'tasks:write',
    'agents:read', 'agents:write',
    'instances:read',
  ],
  'general': ['*'],  // backwards compat — all tools
};

export function getScopesForAgentRole(role: string): string[] {
  return ROLE_SCOPES[role] ?? ROLE_SCOPES['general'] ?? ['*'];
}
