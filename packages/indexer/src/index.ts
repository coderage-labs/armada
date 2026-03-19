/**
 * Codebase indexer — scans a repository, parses source files,
 * and stores the knowledge graph in SQLite.
 */

export { GraphStore } from './graph/store.js';
export type {
  FileNode, SymbolNode, ImportEdge, ReferenceEdge,
  RepoIndex, Language, SymbolKind, ReferenceKind,
  SearchResult, DependencyResult, CallerResult, ImpactResult,
} from './graph/schema.js';
export { detectLanguage, isParseable, shouldIgnorePath } from './parsers/detect.js';
export { indexRepository, indexFile } from './indexer.js';
