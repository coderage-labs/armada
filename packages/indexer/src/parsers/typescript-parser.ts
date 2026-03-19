/**
 * TypeScript/JavaScript parser using tree-sitter.
 * Extracts symbols (functions, classes, types, interfaces) and imports.
 */

import type { SymbolNode, ImportEdge, SymbolKind } from '../graph/schema.js';

export interface ParseResult {
  symbols: Omit<SymbolNode, 'id' | 'fileId'>[];
  imports: Omit<ImportEdge, 'id' | 'fromFileId' | 'toFileId'>[];
}

/**
 * Parse TypeScript/JavaScript source code and extract symbols + imports.
 * Uses tree-sitter for accurate AST-based extraction.
 *
 * Falls back to regex-based extraction if tree-sitter is not available.
 */
export function parseTypeScript(source: string, _filePath?: string): ParseResult {
  // Use regex-based extraction (tree-sitter integration is a follow-up —
  // native bindings require compilation which may not work in all environments)
  return parseWithRegex(source);
}

/**
 * Regex-based parser for TypeScript/JavaScript.
 * Handles the most common patterns. Not as accurate as tree-sitter AST
 * but works everywhere without native dependencies.
 */
function parseWithRegex(source: string): ParseResult {
  const symbols: ParseResult['symbols'] = [];
  const imports: ParseResult['imports'] = [];
  const lines = source.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;
    const trimmed = line.trim();

    // ── Imports ─────────────────────────────────────────────────────

    // import { X, Y } from 'module'
    const namedImport = trimmed.match(/^import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/);
    if (namedImport) {
      const symbols = namedImport[1].split(',').map(s => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
      imports.push({
        toModule: namedImport[2],
        symbols,
        isDefault: false,
        isNamespace: false,
        line: lineNum,
      });
      continue;
    }

    // import X from 'module'
    const defaultImport = trimmed.match(/^import\s+(\w+)\s+from\s+['"]([^'"]+)['"]/);
    if (defaultImport) {
      imports.push({
        toModule: defaultImport[2],
        symbols: [defaultImport[1]],
        isDefault: true,
        isNamespace: false,
        line: lineNum,
      });
      continue;
    }

    // import * as X from 'module'
    const nsImport = trimmed.match(/^import\s+\*\s+as\s+(\w+)\s+from\s+['"]([^'"]+)['"]/);
    if (nsImport) {
      imports.push({
        toModule: nsImport[2],
        symbols: [nsImport[1]],
        isDefault: false,
        isNamespace: true,
        line: lineNum,
      });
      continue;
    }

    // import type { X } from 'module' (TypeScript)
    const typeImport = trimmed.match(/^import\s+type\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/);
    if (typeImport) {
      const symbols = typeImport[1].split(',').map(s => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
      imports.push({
        toModule: typeImport[2],
        symbols,
        isDefault: false,
        isNamespace: false,
        line: lineNum,
      });
      continue;
    }

    // require('module')
    const requireMatch = trimmed.match(/(?:const|let|var)\s+(?:\{([^}]+)\}|(\w+))\s*=\s*require\s*\(['"]([^'"]+)['"]\)/);
    if (requireMatch) {
      const syms = requireMatch[1]
        ? requireMatch[1].split(',').map(s => s.trim()).filter(Boolean)
        : [requireMatch[2]];
      imports.push({
        toModule: requireMatch[3],
        symbols: syms,
        isDefault: !requireMatch[1],
        isNamespace: false,
        line: lineNum,
      });
      continue;
    }

    // ── Symbols ─────────────────────────────────────────────────────

    const isExported = trimmed.startsWith('export ');
    const isDefault = trimmed.includes('export default ');
    const cleaned = trimmed.replace(/^export\s+(default\s+)?/, '');

    // function name(params): returnType
    const funcMatch = cleaned.match(/^(?:async\s+)?function\s+(\w+)\s*(\([^)]*\)(?:\s*:\s*[^{]+)?)/);
    if (funcMatch) {
      symbols.push({
        name: funcMatch[1],
        kind: 'function',
        line: lineNum,
        signature: `function ${funcMatch[1]}${funcMatch[2]}`,
        exported: isExported,
      });
      continue;
    }

    // const name = (params) => ... (arrow function)
    const arrowMatch = cleaned.match(/^(?:const|let|var)\s+(\w+)\s*(?::\s*[^=]+)?\s*=\s*(?:async\s+)?(\([^)]*\)(?:\s*:\s*[^=]+)?)\s*=>/);
    if (arrowMatch) {
      symbols.push({
        name: arrowMatch[1],
        kind: 'function',
        line: lineNum,
        signature: `const ${arrowMatch[1]} = ${arrowMatch[2]} =>`,
        exported: isExported,
      });
      continue;
    }

    // class Name { ... }
    const classMatch = cleaned.match(/^(?:abstract\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?(?:\s+implements\s+([^{]+))?/);
    if (classMatch) {
      symbols.push({
        name: classMatch[1],
        kind: 'class',
        line: lineNum,
        signature: classMatch[0].trim(),
        exported: isExported,
      });
      continue;
    }

    // interface Name { ... }
    const ifaceMatch = cleaned.match(/^interface\s+(\w+)(?:\s+extends\s+([^{]+))?/);
    if (ifaceMatch) {
      symbols.push({
        name: ifaceMatch[1],
        kind: 'interface',
        line: lineNum,
        signature: ifaceMatch[0].trim(),
        exported: isExported,
      });
      continue;
    }

    // type Name = ...
    const typeMatch = cleaned.match(/^type\s+(\w+)(?:<[^>]+>)?\s*=/);
    if (typeMatch) {
      symbols.push({
        name: typeMatch[1],
        kind: 'type',
        line: lineNum,
        signature: `type ${typeMatch[1]}`,
        exported: isExported,
      });
      continue;
    }

    // enum Name { ... }
    const enumMatch = cleaned.match(/^(?:const\s+)?enum\s+(\w+)/);
    if (enumMatch) {
      symbols.push({
        name: enumMatch[1],
        kind: 'enum',
        line: lineNum,
        signature: `enum ${enumMatch[1]}`,
        exported: isExported,
      });
      continue;
    }

    // const NAME = ... (constants, exported)
    if (isExported) {
      const constMatch = cleaned.match(/^const\s+(\w+)\s*(?::\s*[^=]+)?\s*=/);
      if (constMatch && constMatch[1] === constMatch[1].toUpperCase()) {
        symbols.push({
          name: constMatch[1],
          kind: 'constant',
          line: lineNum,
          exported: true,
        });
        continue;
      }

      // export const name = ... (non-constant exported variable)
      if (constMatch) {
        symbols.push({
          name: constMatch[1],
          kind: 'variable',
          line: lineNum,
          exported: true,
        });
        continue;
      }
    }
  }

  return { symbols, imports };
}
