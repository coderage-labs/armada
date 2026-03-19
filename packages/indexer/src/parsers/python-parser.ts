/**
 * Python parser — extracts functions, classes, imports.
 */

import type { SymbolNode, ImportEdge } from '../graph/schema.js';

export interface ParseResult {
  symbols: Omit<SymbolNode, 'id' | 'fileId'>[];
  imports: Omit<ImportEdge, 'id' | 'fromFileId' | 'toFileId'>[];
}

export function parsePython(source: string): ParseResult {
  const symbols: ParseResult['symbols'] = [];
  const imports: ParseResult['imports'] = [];
  const lines = source.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;
    const trimmed = line.trim();

    // import module
    const importMatch = trimmed.match(/^import\s+([\w.]+)(?:\s+as\s+(\w+))?/);
    if (importMatch) {
      imports.push({
        toModule: importMatch[1],
        symbols: [importMatch[2] || importMatch[1].split('.').pop()!],
        isDefault: true,
        isNamespace: false,
        line: lineNum,
      });
      continue;
    }

    // from module import X, Y
    const fromImport = trimmed.match(/^from\s+([\w.]+)\s+import\s+(.+)/);
    if (fromImport) {
      const syms = fromImport[2].split(',').map(s => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
      imports.push({
        toModule: fromImport[1],
        symbols: syms,
        isDefault: false,
        isNamespace: syms.includes('*'),
        line: lineNum,
      });
      continue;
    }

    // def function_name(params):
    const defMatch = trimmed.match(/^(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)(?:\s*->\s*([^:]+))?:/);
    if (defMatch) {
      const indent = line.length - line.trimStart().length;
      symbols.push({
        name: defMatch[1],
        kind: indent > 0 ? 'method' : 'function',
        line: lineNum,
        signature: `def ${defMatch[1]}(${defMatch[2]})${defMatch[3] ? ` -> ${defMatch[3].trim()}` : ''}`,
        exported: !defMatch[1].startsWith('_'),
      });
      continue;
    }

    // class ClassName(Base):
    const classMatch = trimmed.match(/^class\s+(\w+)(?:\(([^)]*)\))?:/);
    if (classMatch) {
      symbols.push({
        name: classMatch[1],
        kind: 'class',
        line: lineNum,
        signature: `class ${classMatch[1]}${classMatch[2] ? `(${classMatch[2]})` : ''}`,
        exported: !classMatch[1].startsWith('_'),
      });
      continue;
    }
  }

  return { symbols, imports };
}
