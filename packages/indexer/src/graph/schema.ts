/**
 * Knowledge graph schema — language-agnostic codebase representation.
 *
 * Nodes: files, symbols (functions, classes, types, etc.)
 * Edges: imports, calls, type references, exports
 */

// ── Node types ──────────────────────────────────────────────────────

export interface FileNode {
  id: string;             // repo:path
  repoId: string;         // project_repo ID
  path: string;           // relative path within repo
  language: Language;
  size: number;           // bytes
  hash: string;           // content hash for change detection
  lineCount: number;
  indexedAt: string;       // ISO timestamp
}

export interface SymbolNode {
  id: string;             // repo:path:name:line
  fileId: string;         // references FileNode.id
  name: string;
  kind: SymbolKind;
  line: number;
  endLine?: number;
  signature?: string;     // e.g. "function foo(x: number): string"
  exported: boolean;
  documentation?: string; // JSDoc / docstring
}

// ── Edge types ──────────────────────────────────────────────────────

export interface ImportEdge {
  id: string;
  fromFileId: string;     // importing file
  toFileId: string;       // imported file (resolved)
  toModule: string;       // raw import path (e.g. './utils', 'express')
  symbols: string[];      // named imports: ['foo', 'bar']
  isDefault: boolean;
  isNamespace: boolean;   // import * as X
  line: number;
}

export interface ReferenceEdge {
  id: string;
  fromSymbolId: string;   // caller/user
  toSymbolId: string;     // callee/referenced
  kind: ReferenceKind;
  line: number;
}

// ── Enums ───────────────────────────────────────────────────────────

export type Language =
  | 'typescript' | 'javascript' | 'tsx' | 'jsx'
  | 'python' | 'go' | 'rust' | 'java'
  | 'terraform' | 'sql' | 'css' | 'html'
  | 'json' | 'yaml' | 'markdown'
  | 'docker' | 'shell' | 'toml' | 'config' | 'env' | 'makefile' | 'groovy'
  | 'unknown';

export type SymbolKind =
  | 'function' | 'method' | 'class' | 'interface' | 'type'
  | 'enum' | 'variable' | 'constant'
  | 'struct' | 'trait' | 'impl'
  | 'module' | 'namespace'
  | 'resource' | 'data_source' | 'output'  // Terraform
  | 'table' | 'view';                       // SQL

export type ReferenceKind =
  | 'call'        // function/method call
  | 'import'      // import reference
  | 'type_ref'    // type annotation reference
  | 'extends'     // class/interface inheritance
  | 'implements'  // interface implementation
  | 'instantiate' // new ClassName()
  | 'uses';       // general usage

// ── Repo index metadata ─────────────────────────────────────────────

export interface RepoIndex {
  repoId: string;
  fullName: string;       // e.g. "coderage-labs/demo-backend"
  lastIndexedAt: string;
  lastCommitHash: string;
  fileCount: number;
  symbolCount: number;
  importCount: number;
  languages: Record<Language, number>;  // file count per language
  indexDurationMs: number;
}

// ── Query result types ──────────────────────────────────────────────

export interface SearchResult {
  file: FileNode;
  symbols: SymbolNode[];
  relevance: number;
}

export interface DependencyResult {
  file: FileNode;
  imports: Array<{ module: string; symbols: string[]; resolvedFile?: FileNode }>;
  importedBy: Array<{ file: FileNode; symbols: string[] }>;
}

export interface CallerResult {
  symbol: SymbolNode;
  callers: Array<{ symbol: SymbolNode; file: FileNode; line: number }>;
  callees: Array<{ symbol: SymbolNode; file: FileNode; line: number }>;
}

export interface ImpactResult {
  file: FileNode;
  directDependents: FileNode[];
  transitiveDependents: FileNode[];
  affectedSymbols: SymbolNode[];
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
}
