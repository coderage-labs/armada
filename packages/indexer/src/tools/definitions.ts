/**
 * Tool definitions for codebase intelligence.
 * These are registered as Armada tools via registerToolDef.
 */

export const CODEBASE_TOOLS = [
  {
    name: 'armada_code_search',
    description: 'Search for files and symbols across indexed repositories. Returns matching files and function/class/type definitions.',
    category: 'codebase',
    scope: 'projects:read',
    method: 'POST' as const,
    path: '/api/codebase/search',
    parameters: [
      { name: 'query', type: 'string', description: 'Search query — matches file paths and symbol names', required: true },
      { name: 'repo', type: 'string', description: 'Repository full name to search in (e.g. coderage-labs/demo-backend). Omit to search all repos.' },
      { name: 'kind', type: 'string', description: 'Filter by symbol kind: function, class, interface, type, method, struct, enum' },
    ],
  },
  {
    name: 'armada_code_dependencies',
    description: 'Get the dependency graph for a file — what it imports and what imports it.',
    category: 'codebase',
    scope: 'projects:read',
    method: 'POST' as const,
    path: '/api/codebase/dependencies',
    parameters: [
      { name: 'file', type: 'string', description: 'File path within the repo (e.g. src/routes/auth.ts)', required: true },
      { name: 'repo', type: 'string', description: 'Repository full name', required: true },
    ],
  },
  {
    name: 'armada_code_callers',
    description: 'Find all callers of a function/symbol and what it calls.',
    category: 'codebase',
    scope: 'projects:read',
    method: 'POST' as const,
    path: '/api/codebase/callers',
    parameters: [
      { name: 'symbol', type: 'string', description: 'Symbol name to look up (function, class, etc.)', required: true },
      { name: 'repo', type: 'string', description: 'Repository full name. Omit to search all repos.' },
    ],
  },
  {
    name: 'armada_code_impact',
    description: 'Analyse the impact of changing a file — direct and transitive dependents, affected exports, risk level.',
    category: 'codebase',
    scope: 'projects:read',
    method: 'POST' as const,
    path: '/api/codebase/impact',
    parameters: [
      { name: 'file', type: 'string', description: 'File path within the repo', required: true },
      { name: 'repo', type: 'string', description: 'Repository full name', required: true },
    ],
  },
  {
    name: 'armada_code_architecture',
    description: 'Get a high-level architectural overview of a repository — directory structure, languages, most-imported files, export hubs.',
    category: 'codebase',
    scope: 'projects:read',
    method: 'POST' as const,
    path: '/api/codebase/architecture',
    parameters: [
      { name: 'repo', type: 'string', description: 'Repository full name', required: true },
    ],
  },
  {
    name: 'armada_code_file_context',
    description: 'Get full context for a file — its symbols, imports, who imports it, and related files.',
    category: 'codebase',
    scope: 'projects:read',
    method: 'POST' as const,
    path: '/api/codebase/file-context',
    parameters: [
      { name: 'file', type: 'string', description: 'File path within the repo', required: true },
      { name: 'repo', type: 'string', description: 'Repository full name', required: true },
    ],
  },
  {
    name: 'armada_code_index',
    description: 'Trigger indexing (or re-indexing) of a repository. Returns index stats.',
    category: 'codebase',
    scope: 'projects:write',
    method: 'POST' as const,
    path: '/api/codebase/index',
    parameters: [
      { name: 'repo', type: 'string', description: 'Repository full name', required: true },
      { name: 'force', type: 'boolean', description: 'Force full re-index (ignore incremental cache)' },
    ],
  },
  {
    name: 'armada_code_index_status',
    description: 'Check the indexing status of a repository — when it was last indexed, file/symbol counts, languages.',
    category: 'codebase',
    scope: 'projects:read',
    method: 'POST' as const,
    path: '/api/codebase/index-status',
    parameters: [
      { name: 'repo', type: 'string', description: 'Repository full name', required: true },
    ],
  },
];
