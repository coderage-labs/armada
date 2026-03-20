/**
 * Main indexer — walks a repo directory, parses files, builds the graph.
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { GraphStore } from './graph/store.js';
import type { FileNode, SymbolNode, ImportEdge, Language, RepoIndex } from './graph/schema.js';
import { detectLanguage, isParseable, shouldIgnorePath } from './parsers/detect.js';
import { treeSitterParse } from './parsers/tree-sitter-parser.js';
import { ensureInit } from './parsers/tree-sitter-init.js';
// Regex parsers kept as fallback
import { parseTypeScript } from './parsers/typescript-parser.js';
import { parsePython } from './parsers/python-parser.js';
import { parseGo } from './parsers/go-parser.js';

interface IndexOptions {
  repoId: string;
  repoFullName: string;
  repoPath: string;        // absolute path to cloned repo
  commitHash?: string;
  store: GraphStore;
  /** Only re-index files whose hash changed (incremental) */
  incremental?: boolean;
  onProgress?: (msg: string) => void;
}

interface IndexResult {
  fileCount: number;
  symbolCount: number;
  importCount: number;
  languages: Record<string, number>;
  durationMs: number;
  errors: string[];
}

/**
 * Index an entire repository.
 */
export async function indexRepository(opts: IndexOptions): Promise<IndexResult> {
  const { repoId, repoFullName, repoPath, commitHash, store, incremental, onProgress } = opts;
  const startTime = Date.now();
  const errors: string[] = [];
  const languages: Record<string, number> = {};
  let fileCount = 0;
  let symbolCount = 0;
  let importCount = 0;

  // Initialise tree-sitter WASM once before parsing
  await ensureInit().catch(err => {
    onProgress?.(`Tree-sitter init failed, falling back to regex: ${err.message}`);
  });

  onProgress?.(`Indexing ${repoFullName} from ${repoPath}`);

  // Walk the directory tree
  const files = walkDirectory(repoPath);
  onProgress?.(`Found ${files.length} files`);

  // Get existing file hashes for incremental indexing
  const existingFiles = incremental ? new Map(
    store.getFilesByRepo(repoId).map(f => [f.path, f.hash])
  ) : new Map();

  // Track which files we've seen (for cleanup of deleted files)
  const seenPaths = new Set<string>();

  for (const absPath of files) {
    const relPath = relative(repoPath, absPath);
    if (shouldIgnorePath(relPath)) continue;

    seenPaths.add(relPath);
    const language = detectLanguage(relPath);
    languages[language] = (languages[language] || 0) + 1;

    try {
      const content = readFileSync(absPath, 'utf-8');
      const hash = createHash('sha256').update(content).digest('hex').slice(0, 16);

      // Skip if unchanged (incremental)
      if (incremental && existingFiles.get(relPath) === hash) continue;

      const result = await indexFile({
        repoId, filePath: relPath, content, language, hash, store,
      });

      fileCount++;
      symbolCount += result.symbols;
      importCount += result.imports;
    } catch (err: any) {
      errors.push(`${relPath}: ${err.message}`);
    }
  }

  // Clean up deleted files
  if (incremental) {
    const storedFiles = store.getFilesByRepo(repoId);
    for (const f of storedFiles) {
      if (!seenPaths.has(f.path)) {
        store.deleteSymbolsByFile(f.id);
        store.deleteImportsByFile(f.id);
        // Delete the file itself
        store.upsertFile({ ...f, size: 0, hash: 'deleted', lineCount: 0, indexedAt: new Date().toISOString() });
      }
    }
  }

  const durationMs = Date.now() - startTime;

  // Update repo index metadata
  store.upsertRepoIndex({
    repoId,
    fullName: repoFullName,
    lastIndexedAt: new Date().toISOString(),
    lastCommitHash: commitHash || '',
    fileCount,
    symbolCount,
    importCount,
    languages: languages as Record<Language, number>,
    indexDurationMs: durationMs,
  });

  onProgress?.(`Indexed ${fileCount} files, ${symbolCount} symbols, ${importCount} imports in ${durationMs}ms`);

  return { fileCount, symbolCount, importCount, languages, durationMs, errors };
}

/**
 * Index a single file — parse and store its symbols + imports.
 */
export async function indexFile(opts: {
  repoId: string;
  filePath: string;
  content: string;
  language: Language;
  hash: string;
  store: GraphStore;
}): Promise<{ symbols: number; imports: number }> {
  const { repoId, filePath, content, language, hash, store } = opts;
  const fileId = `${repoId}:${filePath}`;
  const now = new Date().toISOString();
  const lineCount = content.split('\n').length;

  // Store file node
  const fileNode: FileNode = {
    id: fileId,
    repoId,
    path: filePath,
    language,
    size: Buffer.byteLength(content),
    hash,
    lineCount,
    indexedAt: now,
  };
  store.upsertFile(fileNode);

  // Clear existing symbols + imports for this file (re-index)
  store.deleteSymbolsByFile(fileId);
  store.deleteImportsByFile(fileId);

  // Parse if supported language
  if (!isParseable(language)) return { symbols: 0, imports: 0 };

  const parsed = await parseSource(content, language, filePath);
  let symbolCount = 0;
  let importCount = 0;

  // Store symbols
  for (const sym of parsed.symbols) {
    const symbolId = `${fileId}:${sym.name}:${sym.line}`;
    const symbolNode: SymbolNode = {
      id: symbolId,
      fileId,
      ...sym,
    };
    store.insertSymbol(symbolNode);
    symbolCount++;
  }

  // Store imports
  for (const imp of parsed.imports) {
    const importId = `${fileId}:import:${imp.line}`;
    const resolvedFileId = resolveImportPath(repoId, filePath, imp.toModule);
    const importEdge: ImportEdge = {
      id: importId,
      fromFileId: fileId,
      toFileId: resolvedFileId,
      ...imp,
    };
    store.insertImport(importEdge);
    importCount++;
  }

  return { symbols: symbolCount, imports: importCount };
}

// ── Internal helpers ────────────────────────────────────────────────

async function parseSource(
  content: string,
  language: Language,
  filePath: string,
): Promise<{ symbols: Omit<SymbolNode, 'id' | 'fileId'>[]; imports: Omit<ImportEdge, 'id' | 'fromFileId' | 'toFileId'>[] }> {
  // Try tree-sitter first (accurate AST), fall back to regex
  try {
    const result = await treeSitterParse(content, language, filePath);
    if (result.symbols.length > 0 || result.imports.length > 0) return result;
  } catch { /* tree-sitter failed, fall back */ }

  // Regex fallback
  switch (language) {
    case 'typescript':
    case 'javascript':
    case 'tsx':
    case 'jsx':
      return parseTypeScript(content, filePath);
    case 'python':
      return parsePython(content);
    case 'go':
      return parseGo(content);
    default:
      return { symbols: [], imports: [] };
  }
}

/**
 * Resolve a relative import path to a file ID.
 * './utils' from 'src/index.ts' → 'repoId:src/utils.ts' (or .js, .tsx, etc.)
 */
function resolveImportPath(repoId: string, fromPath: string, importPath: string): string {
  // Skip external packages
  if (!importPath.startsWith('.') && !importPath.startsWith('/')) return '';

  const fromDir = fromPath.substring(0, fromPath.lastIndexOf('/'));
  const parts = importPath.split('/');
  let resolved = fromDir;

  for (const part of parts) {
    if (part === '.') continue;
    if (part === '..') {
      resolved = resolved.substring(0, resolved.lastIndexOf('/'));
    } else {
      resolved = resolved ? `${resolved}/${part}` : part;
    }
  }

  // Try common extensions
  const extensions = ['.ts', '.tsx', '.js', '.jsx', '.py', '.go'];
  for (const ext of extensions) {
    const candidate = `${repoId}:${resolved}${ext}`;
    return candidate; // Return first candidate — store will resolve
  }
  return `${repoId}:${resolved}`;
}

/**
 * Walk a directory tree and return all file paths.
 */
function walkDirectory(dir: string): string[] {
  const results: string[] = [];

  function walk(currentDir: string): void {
    try {
      const entries = readdirSync(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(currentDir, entry.name);
        if (entry.isDirectory()) {
          if (!shouldIgnorePath(entry.name + '/')) {
            walk(fullPath);
          }
        } else if (entry.isFile()) {
          results.push(fullPath);
        }
      }
    } catch { /* permission error or similar */ }
  }

  walk(dir);
  return results;
}
