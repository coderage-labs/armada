/**
 * Go parser — extracts functions, types, structs, imports.
 */

import type { SymbolNode, ImportEdge } from '../graph/schema.js';

export interface ParseResult {
  symbols: Omit<SymbolNode, 'id' | 'fileId'>[];
  imports: Omit<ImportEdge, 'id' | 'fromFileId' | 'toFileId'>[];
}

export function parseGo(source: string): ParseResult {
  const symbols: ParseResult['symbols'] = [];
  const imports: ParseResult['imports'] = [];
  const lines = source.split('\n');
  let inImportBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;
    const trimmed = line.trim();

    // import block
    if (trimmed === 'import (') { inImportBlock = true; continue; }
    if (inImportBlock && trimmed === ')') { inImportBlock = false; continue; }
    if (inImportBlock) {
      const pkg = trimmed.replace(/^"/, '').replace(/"$/, '').replace(/^\w+\s+"/, '').replace(/"$/, '');
      if (pkg) {
        imports.push({
          toModule: pkg,
          symbols: [pkg.split('/').pop()!],
          isDefault: true,
          isNamespace: false,
          line: lineNum,
        });
      }
      continue;
    }

    // Single import
    const singleImport = trimmed.match(/^import\s+(?:(\w+)\s+)?"([^"]+)"/);
    if (singleImport) {
      imports.push({
        toModule: singleImport[2],
        symbols: [singleImport[1] || singleImport[2].split('/').pop()!],
        isDefault: true,
        isNamespace: false,
        line: lineNum,
      });
      continue;
    }

    // func Name(params) returnType
    const funcMatch = trimmed.match(/^func\s+(?:\((\w+)\s+\*?(\w+)\)\s+)?(\w+)\s*\(([^)]*)\)(?:\s*(?:\(([^)]+)\)|(\w+)))?/);
    if (funcMatch) {
      const isMethod = !!funcMatch[1];
      const name = funcMatch[3];
      const exported = name[0] === name[0].toUpperCase();
      symbols.push({
        name,
        kind: isMethod ? 'method' : 'function',
        line: lineNum,
        signature: trimmed.replace(/\s*\{.*$/, ''),
        exported,
      });
      continue;
    }

    // type Name struct { ... }
    const structMatch = trimmed.match(/^type\s+(\w+)\s+struct\b/);
    if (structMatch) {
      symbols.push({
        name: structMatch[1],
        kind: 'struct',
        line: lineNum,
        signature: `type ${structMatch[1]} struct`,
        exported: structMatch[1][0] === structMatch[1][0].toUpperCase(),
      });
      continue;
    }

    // type Name interface { ... }
    const ifaceMatch = trimmed.match(/^type\s+(\w+)\s+interface\b/);
    if (ifaceMatch) {
      symbols.push({
        name: ifaceMatch[1],
        kind: 'interface',
        line: lineNum,
        signature: `type ${ifaceMatch[1]} interface`,
        exported: ifaceMatch[1][0] === ifaceMatch[1][0].toUpperCase(),
      });
      continue;
    }

    // type Name = ... (type alias)
    const typeMatch = trimmed.match(/^type\s+(\w+)\s+(?!struct|interface)\w/);
    if (typeMatch) {
      symbols.push({
        name: typeMatch[1],
        kind: 'type',
        line: lineNum,
        exported: typeMatch[1][0] === typeMatch[1][0].toUpperCase(),
      });
      continue;
    }
  }

  return { symbols, imports };
}
