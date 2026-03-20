/**
 * SQLite-backed graph store for the codebase knowledge graph.
 * Stores files, symbols, imports, references, and repo metadata.
 */

import Database from 'better-sqlite3';
import type {
  FileNode, SymbolNode, ImportEdge, ReferenceEdge,
  RepoIndex, Language, SearchResult, DependencyResult,
  CallerResult, ImpactResult,
} from './schema.js';

export class GraphStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS repo_index (
        repo_id TEXT PRIMARY KEY,
        full_name TEXT NOT NULL,
        last_indexed_at TEXT,
        last_commit_hash TEXT,
        file_count INTEGER DEFAULT 0,
        symbol_count INTEGER DEFAULT 0,
        import_count INTEGER DEFAULT 0,
        languages_json TEXT DEFAULT '{}',
        index_duration_ms INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS files (
        id TEXT PRIMARY KEY,
        repo_id TEXT NOT NULL,
        path TEXT NOT NULL,
        language TEXT NOT NULL,
        size INTEGER NOT NULL,
        hash TEXT NOT NULL,
        line_count INTEGER NOT NULL,
        indexed_at TEXT NOT NULL,
        UNIQUE(repo_id, path)
      );

      CREATE TABLE IF NOT EXISTS symbols (
        id TEXT PRIMARY KEY,
        file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        line INTEGER NOT NULL,
        end_line INTEGER,
        signature TEXT,
        exported INTEGER NOT NULL DEFAULT 0,
        documentation TEXT
      );

      CREATE TABLE IF NOT EXISTS imports (
        id TEXT PRIMARY KEY,
        from_file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        to_file_id TEXT,
        to_module TEXT NOT NULL,
        symbols_json TEXT DEFAULT '[]',
        is_default INTEGER NOT NULL DEFAULT 0,
        is_namespace INTEGER NOT NULL DEFAULT 0,
        line INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS references_ (
        id TEXT PRIMARY KEY,
        from_symbol_id TEXT NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
        to_symbol_id TEXT NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        line INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_files_repo ON files(repo_id);
      CREATE INDEX IF NOT EXISTS idx_files_path ON files(repo_id, path);
      CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_id);
      CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
      CREATE INDEX IF NOT EXISTS idx_symbols_kind ON symbols(kind);
      CREATE INDEX IF NOT EXISTS idx_imports_from ON imports(from_file_id);
      CREATE INDEX IF NOT EXISTS idx_imports_to ON imports(to_file_id);
      CREATE INDEX IF NOT EXISTS idx_imports_module ON imports(to_module);
      CREATE INDEX IF NOT EXISTS idx_refs_from ON references_(from_symbol_id);
      CREATE INDEX IF NOT EXISTS idx_refs_to ON references_(to_symbol_id);
    `);
  }

  // ── Repo index ──────────────────────────────────────────────────────

  upsertRepoIndex(index: RepoIndex): void {
    this.db.prepare(`
      INSERT INTO repo_index (repo_id, full_name, last_indexed_at, last_commit_hash, file_count, symbol_count, import_count, languages_json, index_duration_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(repo_id) DO UPDATE SET
        full_name = excluded.full_name,
        last_indexed_at = excluded.last_indexed_at,
        last_commit_hash = excluded.last_commit_hash,
        file_count = excluded.file_count,
        symbol_count = excluded.symbol_count,
        import_count = excluded.import_count,
        languages_json = excluded.languages_json,
        index_duration_ms = excluded.index_duration_ms
    `).run(
      index.repoId, index.fullName, index.lastIndexedAt, index.lastCommitHash,
      index.fileCount, index.symbolCount, index.importCount,
      JSON.stringify(index.languages), index.indexDurationMs,
    );
  }

  getAllRepoIndexes(): RepoIndex[] {
    const rows = this.db.prepare('SELECT * FROM repo_index ORDER BY full_name').all() as any[];
    return rows.map(row => ({
      repoId: row.repo_id,
      fullName: row.full_name,
      lastIndexedAt: row.last_indexed_at,
      lastCommitHash: row.last_commit_hash,
      fileCount: row.file_count,
      symbolCount: row.symbol_count,
      importCount: row.import_count,
      languages: JSON.parse(row.languages_json || '{}'),
      indexDurationMs: row.index_duration_ms,
    }));
  }

  getRepoIndex(repoId: string): RepoIndex | null {
    const row = this.db.prepare('SELECT * FROM repo_index WHERE repo_id = ?').get(repoId) as any;
    if (!row) return null;
    return {
      repoId: row.repo_id,
      fullName: row.full_name,
      lastIndexedAt: row.last_indexed_at,
      lastCommitHash: row.last_commit_hash,
      fileCount: row.file_count,
      symbolCount: row.symbol_count,
      importCount: row.import_count,
      languages: JSON.parse(row.languages_json || '{}'),
      indexDurationMs: row.index_duration_ms,
    };
  }

  // ── Files ─────────────────────────────────────────────────────────

  upsertFile(file: FileNode): void {
    this.db.prepare(`
      INSERT INTO files (id, repo_id, path, language, size, hash, line_count, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        language = excluded.language, size = excluded.size, hash = excluded.hash,
        line_count = excluded.line_count, indexed_at = excluded.indexed_at
    `).run(file.id, file.repoId, file.path, file.language, file.size, file.hash, file.lineCount, file.indexedAt);
  }

  getFile(id: string): FileNode | null {
    const row = this.db.prepare('SELECT * FROM files WHERE id = ?').get(id) as any;
    return row ? this.rowToFile(row) : null;
  }

  getFilesByRepo(repoId: string): FileNode[] {
    return (this.db.prepare('SELECT * FROM files WHERE repo_id = ? ORDER BY path').all(repoId) as any[]).map(r => this.rowToFile(r));
  }

  getImportsByRepo(repoId: string): ImportEdge[] {
    return (this.db.prepare(`
      SELECT i.* FROM imports i
      JOIN files f ON i.from_file_id = f.id
      WHERE f.repo_id = ?
    `).all(repoId) as any[]).map(r => ({
      id: r.id,
      fromFileId: r.from_file_id,
      toFileId: r.to_file_id,
      toModule: r.to_module,
      symbols: JSON.parse(r.symbols_json || '[]'),
      isDefault: !!r.is_default,
      isNamespace: !!r.is_namespace,
      line: r.line,
    }));
  }

  deleteFilesByRepo(repoId: string): void {
    this.db.prepare('DELETE FROM files WHERE repo_id = ?').run(repoId);
  }

  private rowToFile(row: any): FileNode {
    return {
      id: row.id, repoId: row.repo_id, path: row.path,
      language: row.language as Language, size: row.size,
      hash: row.hash, lineCount: row.line_count, indexedAt: row.indexed_at,
    };
  }

  // ── Symbols ───────────────────────────────────────────────────────

  insertSymbol(symbol: SymbolNode): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO symbols (id, file_id, name, kind, line, end_line, signature, exported, documentation)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(symbol.id, symbol.fileId, symbol.name, symbol.kind, symbol.line,
      symbol.endLine ?? null, symbol.signature ?? null, symbol.exported ? 1 : 0,
      symbol.documentation ?? null);
  }

  getSymbolsByFile(fileId: string): SymbolNode[] {
    return (this.db.prepare('SELECT * FROM symbols WHERE file_id = ?').all(fileId) as any[]).map(r => this.rowToSymbol(r));
  }

  searchSymbols(query: string, repoId?: string): SymbolNode[] {
    const pattern = `%${query}%`;
    if (repoId) {
      return (this.db.prepare(`
        SELECT s.* FROM symbols s
        JOIN files f ON f.id = s.file_id
        WHERE s.name LIKE ? AND f.repo_id = ?
        ORDER BY s.exported DESC, s.name
        LIMIT 50
      `).all(pattern, repoId) as any[]).map(r => this.rowToSymbol(r));
    }
    return (this.db.prepare(`
      SELECT * FROM symbols WHERE name LIKE ? ORDER BY exported DESC, name LIMIT 50
    `).all(pattern) as any[]).map(r => this.rowToSymbol(r));
  }

  deleteSymbolsByFile(fileId: string): void {
    this.db.prepare('DELETE FROM symbols WHERE file_id = ?').run(fileId);
  }

  private rowToSymbol(row: any): SymbolNode {
    return {
      id: row.id, fileId: row.file_id, name: row.name,
      kind: row.kind, line: row.line, endLine: row.end_line ?? undefined,
      signature: row.signature ?? undefined, exported: !!row.exported,
      documentation: row.documentation ?? undefined,
    };
  }

  // ── Imports ───────────────────────────────────────────────────────

  insertImport(edge: ImportEdge): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO imports (id, from_file_id, to_file_id, to_module, symbols_json, is_default, is_namespace, line)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(edge.id, edge.fromFileId, edge.toFileId ?? null, edge.toModule,
      JSON.stringify(edge.symbols), edge.isDefault ? 1 : 0, edge.isNamespace ? 1 : 0, edge.line);
  }

  getImportsByFile(fileId: string): ImportEdge[] {
    return (this.db.prepare('SELECT * FROM imports WHERE from_file_id = ?').all(fileId) as any[]).map(r => this.rowToImport(r));
  }

  getImportersOf(fileId: string): ImportEdge[] {
    return (this.db.prepare('SELECT * FROM imports WHERE to_file_id = ?').all(fileId) as any[]).map(r => this.rowToImport(r));
  }

  deleteImportsByFile(fileId: string): void {
    this.db.prepare('DELETE FROM imports WHERE from_file_id = ?').run(fileId);
  }

  private rowToImport(row: any): ImportEdge {
    return {
      id: row.id, fromFileId: row.from_file_id, toFileId: row.to_file_id,
      toModule: row.to_module, symbols: JSON.parse(row.symbols_json || '[]'),
      isDefault: !!row.is_default, isNamespace: !!row.is_namespace, line: row.line,
    };
  }

  // ── References ────────────────────────────────────────────────────

  insertReference(edge: ReferenceEdge): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO references_ (id, from_symbol_id, to_symbol_id, kind, line)
      VALUES (?, ?, ?, ?, ?)
    `).run(edge.id, edge.fromSymbolId, edge.toSymbolId, edge.kind, edge.line);
  }

  // ── Queries ───────────────────────────────────────────────────────

  searchFiles(query: string, repoId?: string): FileNode[] {
    const pattern = `%${query}%`;
    if (repoId) {
      return (this.db.prepare('SELECT * FROM files WHERE path LIKE ? AND repo_id = ? ORDER BY path LIMIT 50').all(pattern, repoId) as any[]).map(r => this.rowToFile(r));
    }
    return (this.db.prepare('SELECT * FROM files WHERE path LIKE ? ORDER BY path LIMIT 50').all(pattern) as any[]).map(r => this.rowToFile(r));
  }

  getDependencies(fileId: string): DependencyResult | null {
    const file = this.getFile(fileId);
    if (!file) return null;
    const imports = this.getImportsByFile(fileId);
    const importedBy = this.getImportersOf(fileId);

    return {
      file,
      imports: imports.map(i => ({
        module: i.toModule,
        symbols: i.symbols,
        resolvedFile: i.toFileId ? this.getFile(i.toFileId) ?? undefined : undefined,
      })),
      importedBy: importedBy.map(i => ({
        file: this.getFile(i.fromFileId)!,
        symbols: i.symbols,
      })).filter(i => i.file),
    };
  }

  getCallers(symbolName: string, repoId?: string): CallerResult | null {
    const symbols = this.searchSymbols(symbolName, repoId);
    if (symbols.length === 0) return null;
    const symbol = symbols[0]; // Best match

    const callers = (this.db.prepare(`
      SELECT r.*, s.*, f.* FROM references_ r
      JOIN symbols s ON s.id = r.from_symbol_id
      JOIN files f ON f.id = s.file_id
      WHERE r.to_symbol_id = ?
    `).all(symbol.id) as any[]).map(r => ({
      symbol: this.rowToSymbol(r),
      file: this.rowToFile(r),
      line: r.line,
    }));

    const callees = (this.db.prepare(`
      SELECT r.*, s.*, f.* FROM references_ r
      JOIN symbols s ON s.id = r.to_symbol_id
      JOIN files f ON f.id = s.file_id
      WHERE r.from_symbol_id = ?
    `).all(symbol.id) as any[]).map(r => ({
      symbol: this.rowToSymbol(r),
      file: this.rowToFile(r),
      line: r.line,
    }));

    return { symbol, callers, callees };
  }

  getImpact(fileId: string): ImpactResult | null {
    const file = this.getFile(fileId);
    if (!file) return null;

    // Direct dependents — files that import this file
    const directImporters = this.getImportersOf(fileId);
    const directDependents = directImporters
      .map(i => this.getFile(i.fromFileId))
      .filter((f): f is FileNode => f !== null);

    // Transitive dependents — BFS through import graph
    const visited = new Set<string>([fileId]);
    const queue = directDependents.map(f => f.id);
    const transitiveDependents: FileNode[] = [];

    while (queue.length > 0) {
      const currentId = queue.shift()!;
      if (visited.has(currentId)) continue;
      visited.add(currentId);

      const current = this.getFile(currentId);
      if (current) transitiveDependents.push(current);

      const importers = this.getImportersOf(currentId);
      for (const imp of importers) {
        if (!visited.has(imp.fromFileId)) queue.push(imp.fromFileId);
      }
    }

    // Affected symbols in this file
    const affectedSymbols = this.getSymbolsByFile(fileId).filter(s => s.exported);

    // Risk level based on dependent count
    const totalDeps = directDependents.length + transitiveDependents.length;
    const riskLevel = totalDeps === 0 ? 'low'
      : totalDeps <= 3 ? 'medium'
      : totalDeps <= 10 ? 'high'
      : 'critical';

    return { file, directDependents, transitiveDependents, affectedSymbols, riskLevel };
  }

  getArchitecture(repoId: string): {
    files: number;
    symbols: number;
    imports: number;
    languages: Record<string, number>;
    topLevelDirs: Array<{ dir: string; fileCount: number; languages: string[] }>;
    mostImported: Array<{ path: string; importerCount: number }>;
    mostExported: Array<{ path: string; exportCount: number }>;
  } {
    const index = this.getRepoIndex(repoId);
    const files = this.getFilesByRepo(repoId);

    // Top-level directory structure
    const dirMap = new Map<string, { files: number; langs: Set<string> }>();
    for (const f of files) {
      const topDir = f.path.split('/')[0] || '.';
      const entry = dirMap.get(topDir) || { files: 0, langs: new Set<string>() };
      entry.files++;
      entry.langs.add(f.language);
      dirMap.set(topDir, entry);
    }
    const topLevelDirs = [...dirMap.entries()]
      .map(([dir, data]) => ({ dir, fileCount: data.files, languages: [...data.langs] }))
      .sort((a, b) => b.fileCount - a.fileCount);

    // Most imported files
    const importCounts = (this.db.prepare(`
      SELECT to_file_id, COUNT(*) as cnt FROM imports
      WHERE to_file_id IN (SELECT id FROM files WHERE repo_id = ?)
      GROUP BY to_file_id ORDER BY cnt DESC LIMIT 50
    `).all(repoId) as any[]);
    const mostImported = importCounts.map(r => {
      const file = this.getFile(r.to_file_id);
      return { path: file?.path || r.to_file_id, importerCount: r.cnt };
    });

    // Most exported files
    const exportCounts = (this.db.prepare(`
      SELECT file_id, COUNT(*) as cnt FROM symbols
      WHERE exported = 1 AND file_id IN (SELECT id FROM files WHERE repo_id = ?)
      GROUP BY file_id ORDER BY cnt DESC LIMIT 50
    `).all(repoId) as any[]);
    const mostExported = exportCounts.map(r => {
      const file = this.getFile(r.file_id);
      return { path: file?.path || r.file_id, exportCount: r.cnt };
    });

    return {
      files: index?.fileCount || files.length,
      symbols: index?.symbolCount || 0,
      imports: index?.importCount || 0,
      languages: index?.languages || {},
      topLevelDirs,
      mostImported,
      mostExported,
    };
  }

  close(): void {
    this.db.close();
  }
}
