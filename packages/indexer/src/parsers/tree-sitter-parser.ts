/**
 * Universal tree-sitter parser — extracts symbols and imports from AST.
 * Handles TypeScript, JavaScript, Python, Go via language-specific extractors.
 */

import type { SymbolNode, ImportEdge, SymbolKind } from '../graph/schema.js';
import { ensureInit, getParser, getLanguage } from './tree-sitter-init.js';

export interface ParseResult {
  symbols: Omit<SymbolNode, 'id' | 'fileId'>[];
  imports: Omit<ImportEdge, 'id' | 'fromFileId' | 'toFileId'>[];
}

/**
 * Parse source code using tree-sitter AST.
 */
export async function treeSitterParse(source: string, language: string, filePath?: string): Promise<ParseResult> {
  await ensureInit();
  const TreeSitter = getParser();
  const lang = await getLanguage(language);
  if (!lang) return { symbols: [], imports: [] };

  const parser = new TreeSitter.Parser();
  parser.setLanguage(lang);
  const tree = parser.parse(source);
  const root = tree.rootNode;

  switch (language) {
    case 'typescript':
    case 'javascript':
    case 'tsx':
    case 'jsx':
      return extractTypeScript(root);
    case 'python':
      return extractPython(root);
    case 'go':
      return extractGo(root);
    default:
      return { symbols: [], imports: [] };
  }
}

// ── TypeScript / JavaScript ─────────────────────────────────────────

function extractTypeScript(root: any): ParseResult {
  const symbols: ParseResult['symbols'] = [];
  const imports: ParseResult['imports'] = [];

  function walk(node: any, depth: number = 0): void {
    const line = node.startPosition.row + 1;

    switch (node.type) {
      case 'import_statement': {
        const source = node.childForFieldName('source')?.text?.replace(/['"]/g, '') || '';
        const importClause = node.children.find((c: any) => c.type === 'import_clause');
        const namedImports = node.descendantsOfType('import_specifier');
        const namespaceImport = node.descendantsOfType('namespace_import');
        const isTypeOnly = node.text.includes('import type');
        
        const syms: string[] = [];
        for (const spec of namedImports) {
          syms.push(spec.childForFieldName('name')?.text || spec.text);
        }
        // Default import
        const defaultImport = importClause?.children?.find(
          (c: any) => c.type === 'identifier'
        );
        if (defaultImport) syms.push(defaultImport.text);
        // Namespace import
        if (namespaceImport.length > 0) syms.push('*');

        if (source) {
          imports.push({
            toModule: source,
            symbols: syms.length > 0 ? syms : [source.split('/').pop()!],
            isDefault: !!defaultImport && syms.length <= 1,
            isNamespace: namespaceImport.length > 0,
            line,
          });
        }
        break;
      }

      case 'export_statement': {
        const declaration = node.childForFieldName('declaration') ||
          node.children.find((c: any) =>
            ['function_declaration', 'class_declaration', 'interface_declaration',
             'type_alias_declaration', 'enum_declaration', 'lexical_declaration',
             'abstract_class_declaration'].includes(c.type)
          );
        if (declaration) {
          extractDeclaration(declaration, true, symbols, line, depth);
        }
        // export default
        if (node.text.startsWith('export default')) {
          const value = node.children.find((c: any) => c.type === 'identifier');
          if (value) {
            symbols.push({
              name: value.text,
              kind: 'variable',
              line,
              exported: true,
            });
          }
        }
        break;
      }

      case 'function_declaration':
      case 'class_declaration':
      case 'interface_declaration':
      case 'type_alias_declaration':
      case 'enum_declaration':
      case 'lexical_declaration':
      case 'abstract_class_declaration':
        if (depth === 0) {
          extractDeclaration(node, false, symbols, line, depth);
        }
        break;
    }

    // Recurse into top-level children only
    if (depth === 0) {
      for (let i = 0; i < node.childCount; i++) {
        walk(node.child(i), depth + 1);
      }
    }
  }

  walk(root);
  return { symbols, imports };
}

function extractDeclaration(
  node: any,
  exported: boolean,
  symbols: ParseResult['symbols'],
  line: number,
  depth: number,
): void {
  const kindMap: Record<string, SymbolKind> = {
    function_declaration: 'function',
    class_declaration: 'class',
    abstract_class_declaration: 'class',
    interface_declaration: 'interface',
    type_alias_declaration: 'type',
    enum_declaration: 'enum',
  };

  const kind = kindMap[node.type];
  if (kind) {
    const name = node.childForFieldName('name')?.text;
    if (name) {
      // Build signature from first line
      const sig = node.text.split('\n')[0].replace(/\{.*$/, '').trim();
      symbols.push({ name, kind, line: node.startPosition.row + 1, signature: sig, exported });

      // Extract methods from classes
      if (kind === 'class') {
        const body = node.childForFieldName('body');
        if (body) {
          for (let i = 0; i < body.childCount; i++) {
            const member = body.child(i);
            if (member.type === 'method_definition' || member.type === 'public_field_definition') {
              const mName = member.childForFieldName('name')?.text;
              if (mName) {
                const mSig = member.text.split('\n')[0].replace(/\{.*$/, '').trim();
                symbols.push({
                  name: mName,
                  kind: 'method',
                  line: member.startPosition.row + 1,
                  signature: mSig,
                  exported,
                });
              }
            }
          }
        }
      }
    }
    return;
  }

  // lexical_declaration (const/let/var)
  if (node.type === 'lexical_declaration') {
    const declarators = node.descendantsOfType('variable_declarator');
    for (const decl of declarators) {
      const name = decl.childForFieldName('name')?.text;
      if (name) {
        symbols.push({ name, kind: 'variable', line: node.startPosition.row + 1, exported });
      }
    }
  }
}

// ── Python ──────────────────────────────────────────────────────────

function extractPython(root: any): ParseResult {
  const symbols: ParseResult['symbols'] = [];
  const imports: ParseResult['imports'] = [];

  for (let i = 0; i < root.childCount; i++) {
    const node = root.child(i);
    const line = node.startPosition.row + 1;

    switch (node.type) {
      case 'import_statement': {
        // import module
        const names = node.descendantsOfType('dotted_name');
        for (const n of names) {
          imports.push({
            toModule: n.text,
            symbols: [n.text.split('.').pop()!],
            isDefault: true,
            isNamespace: false,
            line,
          });
        }
        break;
      }

      case 'import_from_statement': {
        // from module import X, Y
        const moduleName = node.childForFieldName('module_name')?.text || 
          node.children.find((c: any) => c.type === 'dotted_name')?.text || '';
        const importedNames = node.descendantsOfType('dotted_name')
          .filter((n: any) => n.text !== moduleName)
          .map((n: any) => n.text);
        // Also get aliased imports
        const aliases = node.descendantsOfType('aliased_import');
        for (const a of aliases) {
          const name = a.childForFieldName('name')?.text;
          if (name) importedNames.push(name);
        }
        const wildcard = node.children.find((c: any) => c.type === 'wildcard_import');
        
        imports.push({
          toModule: moduleName,
          symbols: wildcard ? ['*'] : importedNames,
          isDefault: false,
          isNamespace: !!wildcard,
          line,
        });
        break;
      }

      case 'function_definition': {
        const name = node.childForFieldName('name')?.text;
        const params = node.childForFieldName('parameters')?.text || '()';
        const returnType = node.childForFieldName('return_type')?.text;
        if (name) {
          symbols.push({
            name,
            kind: 'function',
            line,
            signature: `def ${name}${params}${returnType ? ` -> ${returnType}` : ''}`,
            exported: !name.startsWith('_'),
          });
        }
        break;
      }

      case 'class_definition': {
        const name = node.childForFieldName('name')?.text;
        const superclasses = node.childForFieldName('superclasses')?.text || '';
        if (name) {
          symbols.push({
            name,
            kind: 'class',
            line,
            signature: `class ${name}${superclasses}`,
            exported: !name.startsWith('_'),
          });
          // Extract methods
          const body = node.childForFieldName('body');
          if (body) {
            for (let j = 0; j < body.childCount; j++) {
              const member = body.child(j);
              if (member.type === 'function_definition') {
                const mName = member.childForFieldName('name')?.text;
                const mParams = member.childForFieldName('parameters')?.text || '()';
                if (mName) {
                  symbols.push({
                    name: mName,
                    kind: 'method',
                    line: member.startPosition.row + 1,
                    signature: `def ${mName}${mParams}`,
                    exported: !mName.startsWith('_'),
                  });
                }
              }
            }
          }
        }
        break;
      }

      case 'decorated_definition': {
        // Handle @decorator\ndef/class
        const inner = node.children.find((c: any) =>
          ['function_definition', 'class_definition'].includes(c.type)
        );
        if (inner) {
          // Re-process as if it were top-level
          const fakeParsed = extractPython({ childCount: 1, child: () => inner } as any);
          symbols.push(...fakeParsed.symbols);
        }
        break;
      }
    }
  }

  return { symbols, imports };
}

// ── Go ──────────────────────────────────────────────────────────────

function extractGo(root: any): ParseResult {
  const symbols: ParseResult['symbols'] = [];
  const imports: ParseResult['imports'] = [];

  for (let i = 0; i < root.childCount; i++) {
    const node = root.child(i);
    const line = node.startPosition.row + 1;

    switch (node.type) {
      case 'import_declaration': {
        const specs = node.descendantsOfType('import_spec');
        for (const spec of specs) {
          const path = spec.childForFieldName('path')?.text?.replace(/"/g, '') || '';
          const alias = spec.childForFieldName('name')?.text;
          if (path) {
            imports.push({
              toModule: path,
              symbols: [alias || path.split('/').pop()!],
              isDefault: true,
              isNamespace: alias === '.',
              line: spec.startPosition.row + 1,
            });
          }
        }
        // Single import (no parens)
        const singlePath = node.childForFieldName('path')?.text?.replace(/"/g, '');
        if (singlePath) {
          imports.push({
            toModule: singlePath,
            symbols: [singlePath.split('/').pop()!],
            isDefault: true,
            isNamespace: false,
            line,
          });
        }
        break;
      }

      case 'function_declaration': {
        const name = node.childForFieldName('name')?.text;
        if (name) {
          const sig = node.text.split('\n')[0].replace(/\{.*$/, '').trim();
          symbols.push({
            name,
            kind: 'function',
            line,
            signature: sig,
            exported: name[0] === name[0].toUpperCase(),
          });
        }
        break;
      }

      case 'method_declaration': {
        const name = node.childForFieldName('name')?.text;
        if (name) {
          const sig = node.text.split('\n')[0].replace(/\{.*$/, '').trim();
          symbols.push({
            name,
            kind: 'method',
            line,
            signature: sig,
            exported: name[0] === name[0].toUpperCase(),
          });
        }
        break;
      }

      case 'type_declaration': {
        const specs = node.descendantsOfType('type_spec');
        for (const spec of specs) {
          const name = spec.childForFieldName('name')?.text;
          const typeNode = spec.childForFieldName('type');
          if (name) {
            let kind: SymbolKind = 'type';
            if (typeNode?.type === 'struct_type') kind = 'struct';
            else if (typeNode?.type === 'interface_type') kind = 'interface';
            
            const sig = spec.text.split('\n')[0].replace(/\{.*$/, '').trim();
            symbols.push({
              name,
              kind,
              line: spec.startPosition.row + 1,
              signature: `type ${sig}`,
              exported: name[0] === name[0].toUpperCase(),
            });
          }
        }
        break;
      }
    }
  }

  return { symbols, imports };
}
