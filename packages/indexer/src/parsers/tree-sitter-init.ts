/**
 * Tree-sitter initialisation — lazy singleton.
 * Uses web-tree-sitter (WASM) for cross-platform compatibility.
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

let _initPromise: Promise<void> | null = null;
let _Parser: any = null;
const _languages: Map<string, any> = new Map();

/**
 * Resolve the path to a WASM grammar file.
 * Searches node_modules from the indexer package directory.
 */
function findWasmPath(packageName: string, wasmFile: string): string {
  // Try relative to this file first
  const candidates = [
    resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'node_modules', packageName, wasmFile),
    resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'node_modules', packageName, wasmFile),
    resolve(process.cwd(), 'node_modules', packageName, wasmFile),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  throw new Error(`WASM file not found: ${packageName}/${wasmFile}. Searched: ${candidates.join(', ')}`);
}

async function init(): Promise<void> {
  if (_Parser) return;
  // Dynamic import for ESM compatibility
  const mod = await import('web-tree-sitter');
  const TreeSitter = mod.default || mod;
  await TreeSitter.Parser.init();
  _Parser = TreeSitter;
}

export async function ensureInit(): Promise<void> {
  if (!_initPromise) {
    _initPromise = init();
  }
  await _initPromise;
}

export function getParser(): any {
  if (!_Parser) throw new Error('Tree-sitter not initialised. Call ensureInit() first.');
  return _Parser;
}

const GRAMMAR_MAP: Record<string, { package: string; wasm: string }> = {
  typescript: { package: 'tree-sitter-typescript', wasm: 'tree-sitter-typescript.wasm' },
  tsx:        { package: 'tree-sitter-typescript', wasm: 'tree-sitter-tsx.wasm' },
  javascript: { package: 'tree-sitter-typescript', wasm: 'tree-sitter-typescript.wasm' }, // TS parser handles JS
  jsx:        { package: 'tree-sitter-typescript', wasm: 'tree-sitter-tsx.wasm' },
  python:     { package: 'tree-sitter-python', wasm: 'tree-sitter-python.wasm' },
  go:         { package: 'tree-sitter-go', wasm: 'tree-sitter-go.wasm' },
};

export async function getLanguage(lang: string): Promise<any> {
  if (_languages.has(lang)) return _languages.get(lang);
  
  const grammar = GRAMMAR_MAP[lang];
  if (!grammar) return null;
  
  await ensureInit();
  const TreeSitter = getParser();
  const wasmPath = findWasmPath(grammar.package, grammar.wasm);
  const language = await TreeSitter.Language.load(wasmPath);
  _languages.set(lang, language);
  return language;
}

export function getSupportedLanguages(): string[] {
  return Object.keys(GRAMMAR_MAP);
}
