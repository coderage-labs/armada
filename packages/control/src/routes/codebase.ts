/**
 * Codebase intelligence API routes.
 * Exposes the knowledge graph via Armada tool-compatible endpoints.
 */

import { Router } from 'express';
import { resolve } from 'node:path';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { requireScope } from '../middleware/scopes.js';
import { registerToolDef } from '../utils/tool-registry.js';
import { projectReposRepo } from '../repositories/project-repos-repo.js';
import { integrationsRepo } from '../services/integrations/integrations-repo.js';
import { GraphStore, indexRepository } from '@coderage-labs/armada-indexer';
import { semanticSearch, storeEmbedding } from '../services/embedding-service.js';

// ── Tool definitions (inline to avoid cross-package import issues) ──

const CODEBASE_TOOLS = [
  { category: 'codebase', scope: 'projects:read', name: 'armada_code_search', description: 'Search for files and symbols across indexed repositories.', method: 'POST', path: '/api/codebase/search',
    parameters: [{ name: 'query', type: 'string', description: 'Search query', required: true }, { name: 'repo', type: 'string', description: 'Repository full name (optional)' }, { name: 'kind', type: 'string', description: 'Filter: function, class, interface, type, method' }] },
  { category: 'codebase', scope: 'projects:read', name: 'armada_code_semantic_search', description: 'Semantic search for files by concept/meaning using embeddings. More powerful than text search for finding relevant files by natural language description.', method: 'POST', path: '/api/codebase/semantic-search',
    parameters: [{ name: 'query', type: 'string', description: 'Natural language query (e.g. "authentication middleware", "database models")', required: true }, { name: 'repo', type: 'string', description: 'Repository full name (optional)' }, { name: 'limit', type: 'number', description: 'Max results (default 10)' }] },
  { category: 'codebase', scope: 'projects:read', name: 'armada_code_dependencies', description: 'Get dependency graph for a file — what it imports and what imports it.', method: 'POST', path: '/api/codebase/dependencies',
    parameters: [{ name: 'file', type: 'string', description: 'File path in repo', required: true }, { name: 'repo', type: 'string', description: 'Repository full name', required: true }] },
  { category: 'codebase', scope: 'projects:read', name: 'armada_code_callers', description: 'Find callers of a function/symbol and what it calls.', method: 'POST', path: '/api/codebase/callers',
    parameters: [{ name: 'symbol', type: 'string', description: 'Symbol name', required: true }, { name: 'repo', type: 'string', description: 'Repository full name (optional)' }] },
  { category: 'codebase', scope: 'projects:read', name: 'armada_code_impact', description: 'Impact analysis — direct/transitive dependents, risk level.', method: 'POST', path: '/api/codebase/impact',
    parameters: [{ name: 'file', type: 'string', description: 'File path in repo', required: true }, { name: 'repo', type: 'string', description: 'Repository full name', required: true }] },
  { category: 'codebase', scope: 'projects:read', name: 'armada_code_architecture', description: 'High-level repo architecture — dirs, languages, import hubs.', method: 'POST', path: '/api/codebase/architecture',
    parameters: [{ name: 'repo', type: 'string', description: 'Repository full name', required: true }] },
  { category: 'codebase', scope: 'projects:read', name: 'armada_code_file_context', description: 'Full context for a file — symbols, imports, importers.', method: 'POST', path: '/api/codebase/file-context',
    parameters: [{ name: 'file', type: 'string', description: 'File path in repo', required: true }, { name: 'repo', type: 'string', description: 'Repository full name', required: true }] },
  { category: 'codebase', scope: 'projects:write', name: 'armada_code_index', description: 'Trigger indexing/re-indexing of a repository.', method: 'POST', path: '/api/codebase/index',
    parameters: [{ name: 'repo', type: 'string', description: 'Repository full name', required: true }, { name: 'force', type: 'string', description: 'Set to "true" to force full re-index' }] },
  { category: 'codebase', scope: 'projects:read', name: 'armada_code_index_status', description: 'Check indexing status of a repository.', method: 'POST', path: '/api/codebase/index-status',
    parameters: [{ name: 'repo', type: 'string', description: 'Repository full name', required: true }] },
] as const;

// ── Graph store singleton ───────────────────────────────────────────

const DB_DIR = process.env.ARMADA_DB_DIR || '/data';
const DB_PATH = resolve(DB_DIR, 'codebase-graph.db');
const REPOS_DIR = resolve(DB_DIR, 'repos');
let _store: GraphStore | null = null;

function getStore(): GraphStore {
  if (!_store) {
    const dir = resolve(DB_PATH, '..');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    _store = new GraphStore(DB_PATH);
  }
  return _store;
}

// ── Helpers ─────────────────────────────────────────────────────────

function resolveTokenForRepo(repoFullName: string): string {
  try {
    const repos = projectReposRepo.getByFullName(repoFullName);
    for (const repo of repos) {
      if (repo.integrationId) {
        const integration = integrationsRepo.getById(repo.integrationId);
        if (integration?.authConfig?.token) return integration.authConfig.token as string;
      }
    }
  } catch { /* ignore */ }
  return process.env.GITHUB_TOKEN || '';
}

function ensureRepoClone(repoFullName: string, token?: string): string {
  const repoDir = resolve(REPOS_DIR, repoFullName.replace('/', '-'));
  if (!existsSync(REPOS_DIR)) mkdirSync(REPOS_DIR, { recursive: true });

  const authUrl = token
    ? `https://x-access-token:${token}@github.com/${repoFullName}.git`
    : `https://github.com/${repoFullName}.git`;

  if (existsSync(resolve(repoDir, '.git'))) {
    try {
      execSync('git fetch origin', { cwd: repoDir, stdio: 'pipe', timeout: 60_000 });
      execSync('git reset --hard origin/HEAD', { cwd: repoDir, stdio: 'pipe', timeout: 30_000 });
    } catch (err: any) {
      console.warn(`[codebase] Git fetch failed for ${repoFullName}: ${err.message}`);
    }
  } else {
    execSync(`git clone --depth 1 ${authUrl} ${repoDir}`, { stdio: 'pipe', timeout: 120_000 });
  }

  return repoDir;
}

// ── Router ──────────────────────────────────────────────────────────

export const codebaseRouter = Router();

/** Trigger indexing from outside the router (e.g. on repo link) */
export async function triggerIndex(repoFullName: string, token?: string): Promise<void> {
  try {
    const repoDir = ensureRepoClone(repoFullName, token || resolveTokenForRepo(repoFullName));
    const store = getStore();
    await indexRepository({
      repoId: repoFullName, repoFullName, repoPath: repoDir, store,
      incremental: false,
      onProgress: (msg: string) => console.log(`[codebase] ${msg}`),
    });
    console.log(`[codebase] Auto-indexed ${repoFullName} on link`);
  } catch (err: any) {
    console.warn(`[codebase] Auto-index failed for ${repoFullName}: ${err.message}`);
  }
}

// Register tool definitions
for (const tool of CODEBASE_TOOLS) {
  registerToolDef(tool as any);
}

// GET /api/codebase/repos — list all indexed repos
codebaseRouter.get('/repos', requireScope('projects:read'), (_req, res) => {
  const store = getStore();
  const repos = store.getAllRepoIndexes();
  res.json(repos);
});

// POST /api/codebase/graph — full dependency graph for visualisation
codebaseRouter.post('/graph', requireScope('projects:read'), (req, res) => {
  const { repo } = req.body;
  if (!repo) return res.status(400).json({ error: 'repo is required' });
  const store = getStore();
  const files = store.getFilesByRepo(repo);
  const allImports = store.getImportsByRepo(repo);

  // Build nodes from source files — skip non-parseable, tests, and pure type files
  const sourceFiles = files.filter(f => {
    if (!['typescript', 'javascript', 'tsx', 'jsx', 'python', 'go', 'rust', 'java'].includes(f.language)) return false;
    const name = f.path.split('/').pop() || '';
    // Exclude test files
    if (name.includes('.test.') || name.includes('.spec.') || name.includes('__test__')) return false;
    // Exclude pure type definition files (not .d.ts — those are already filtered by indexer)
    if (name.endsWith('.types.ts') || name.endsWith('.type.ts')) return false;
    // Exclude test directories
    if (f.path.includes('/__tests__/') || f.path.includes('/test/') || f.path.includes('/tests/')) return false;
    return true;
  });

  const nodes = sourceFiles.map(f => ({
    id: f.path,
    language: f.language,
    size: f.size,
    lineCount: f.lineCount,
    symbolCount: store.getSymbolsByFile(f.id).length,
  }));

  // Build edges from resolved imports (only internal, both files must exist)
  const fileIdSet = new Set(files.map(f => f.id));
  const edges = allImports
    .filter(imp => imp.toFileId && fileIdSet.has(imp.toFileId))
    .map(imp => {
      const fromFile = files.find(f => f.id === imp.fromFileId);
      const toFile = files.find(f => f.id === imp.toFileId);
      return fromFile && toFile ? {
        source: fromFile.path,
        target: toFile.path,
        symbols: imp.symbols,
      } : null;
    })
    .filter(Boolean);

  // Deduplicate edges
  const edgeMap = new Map<string, any>();
  for (const e of edges) {
    if (!e) continue;
    const key = `${e.source}→${e.target}`;
    if (!edgeMap.has(key)) edgeMap.set(key, e);
  }

  res.json({ nodes, edges: [...edgeMap.values()] });
});

codebaseRouter.post('/search', requireScope('projects:read'), (req, res) => {
  const { query, repo, kind } = req.body;
  if (!query) return res.status(400).json({ error: 'query is required' });
  const store = getStore();
  const files = store.searchFiles(query, repo);
  let symbols = store.searchSymbols(query, repo);
  if (kind) symbols = symbols.filter((s: any) => s.kind === kind);
  res.json({ files: files.slice(0, 20), symbols: symbols.slice(0, 30) });
});

codebaseRouter.post('/semantic-search', requireScope('projects:read'), async (req, res) => {
  const { query, repo, limit } = req.body;
  if (!query) return res.status(400).json({ error: 'query is required' });
  
  try {
    const searchResults = await semanticSearch(query, 'file', limit || 10);
    const store = getStore();
    
    // Filter by repo if specified, and load full file metadata
    const results = searchResults
      .map(result => {
        const file = store.getFile(result.entityId);
        if (!file) return null;
        if (repo && file.repoId !== repo) return null;
        return {
          file,
          score: result.score,
          description: result.text,
        };
      })
      .filter(Boolean);
    
    res.json({ results });
  } catch (err: any) {
    console.error('[codebase] Semantic search error:', err);
    res.status(500).json({ error: err.message });
  }
});

codebaseRouter.post('/dependencies', requireScope('projects:read'), (req, res) => {
  const { file, repo } = req.body;
  if (!file || !repo) return res.status(400).json({ error: 'file and repo required' });
  const store = getStore();
  const result = store.getDependencies(`${repo}:${file}`);
  if (!result) return res.status(404).json({ error: 'File not found in index' });
  res.json(result);
});

codebaseRouter.post('/callers', requireScope('projects:read'), (req, res) => {
  const { symbol, repo } = req.body;
  if (!symbol) return res.status(400).json({ error: 'symbol is required' });
  const store = getStore();
  const result = store.getCallers(symbol, repo);
  if (!result) return res.status(404).json({ error: 'Symbol not found' });
  res.json(result);
});

codebaseRouter.post('/impact', requireScope('projects:read'), (req, res) => {
  const { file, repo } = req.body;
  if (!file || !repo) return res.status(400).json({ error: 'file and repo required' });
  const store = getStore();
  const result = store.getImpact(`${repo}:${file}`);
  if (!result) return res.status(404).json({ error: 'File not found in index' });
  res.json(result);
});

codebaseRouter.post('/architecture', requireScope('projects:read'), (req, res) => {
  const { repo } = req.body;
  if (!repo) return res.status(400).json({ error: 'repo is required' });
  const store = getStore();
  res.json(store.getArchitecture(repo));
});

codebaseRouter.post('/file-context', requireScope('projects:read'), (req, res) => {
  const { file, repo } = req.body;
  if (!file || !repo) return res.status(400).json({ error: 'file and repo required' });
  const store = getStore();
  const fileId = `${repo}:${file}`;
  const fileNode = store.getFile(fileId);
  if (!fileNode) return res.status(404).json({ error: 'File not found in index' });
  const symbols = store.getSymbolsByFile(fileId);
  const deps = store.getDependencies(fileId);
  res.json({ file: fileNode, symbols, imports: deps?.imports || [], importedBy: deps?.importedBy || [] });
});

codebaseRouter.post('/index', requireScope('projects:write'), async (req, res) => {
  const { repo, force } = req.body;
  if (!repo) return res.status(400).json({ error: 'repo is required' });
  try {
    const token = resolveTokenForRepo(repo);
    const repoDir = ensureRepoClone(repo, token);
    const store = getStore();
    const result = await indexRepository({
      repoId: repo, repoFullName: repo, repoPath: repoDir, store,
      incremental: force !== 'true' && force !== true,
      onProgress: (msg: string) => console.log(`[codebase] ${msg}`),
    });
    
    // Fire-and-forget: embed file descriptions in the background
    embedRepoFiles(repo, store).catch(err => {
      console.error(`[codebase] Embedding failed for ${repo}:`, err.message);
    });
    
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Background task: embed all file descriptions for a repo.
 */
async function embedRepoFiles(repoId: string, store: GraphStore): Promise<void> {
  console.log(`[codebase] Embedding descriptions for ${repoId}...`);
  const files = store.getFilesByRepo(repoId);
  
  // Filter files with descriptions
  const filesToEmbed = files.filter(f => f.description && f.description.length > 10);
  
  if (filesToEmbed.length === 0) {
    console.log(`[codebase] No files with descriptions to embed for ${repoId}`);
    return;
  }
  
  // Batch embed (50 at a time to avoid overwhelming the API)
  const BATCH_SIZE = 50;
  for (let i = 0; i < filesToEmbed.length; i += BATCH_SIZE) {
    const batch = filesToEmbed.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map(file =>
        storeEmbedding('file', file.id, file.description!)
          .catch(err => console.error(`[codebase] Failed to embed ${file.path}:`, err.message))
      )
    );
    console.log(`[codebase] Embedded ${Math.min(i + BATCH_SIZE, filesToEmbed.length)}/${filesToEmbed.length} files`);
  }
  
  console.log(`[codebase] Embedding complete for ${repoId}`);
}

codebaseRouter.post('/index-status', requireScope('projects:read'), (req, res) => {
  const { repo } = req.body;
  if (!repo) return res.status(400).json({ error: 'repo is required' });
  const store = getStore();
  const index = store.getRepoIndex(repo);
  if (!index) return res.json({ indexed: false });
  res.json({ indexed: true, ...index });
});

codebaseRouter.post('/actions', requireScope('projects:read'), (req, res) => {
  const { repo } = req.body;
  if (!repo) return res.status(400).json({ error: 'repo is required' });
  
  try {
    const token = resolveTokenForRepo(repo);
    const repoDir = ensureRepoClone(repo, token);
    const armadaJsonPath = resolve(repoDir, 'armada.json');
    
    if (!existsSync(armadaJsonPath)) {
      return res.json({ actions: [] });
    }
    
    const armadaJson = JSON.parse(readFileSync(armadaJsonPath, 'utf-8'));
    const actions: Array<{ name: string; command: string; description?: string }> = [];
    
    // Check new actions object first
    if (armadaJson.actions && typeof armadaJson.actions === 'object') {
      for (const [name, entry] of Object.entries(armadaJson.actions)) {
        if (typeof entry === 'string') {
          actions.push({ name, command: entry });
        } else if (typeof entry === 'object' && entry !== null && 'command' in entry) {
          const cmd = (entry as any).command;
          const desc = (entry as any).description;
          actions.push({ name, command: cmd, description: desc });
        }
      }
    }
    
    // Add legacy top-level fields
    const legacyFields = ['install', 'verify', 'test', 'build', 'lint'];
    for (const field of legacyFields) {
      if (armadaJson[field] && typeof armadaJson[field] === 'string') {
        // Don't duplicate if already in actions object
        if (!actions.find(a => a.name === field)) {
          actions.push({ name: field, command: armadaJson[field] });
        }
      }
    }
    
    res.json({ actions });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
