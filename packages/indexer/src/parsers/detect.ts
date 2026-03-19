/**
 * Language detection from file extensions.
 */

import type { Language } from '../graph/schema.js';

const EXTENSION_MAP: Record<string, Language> = {
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.jsx': 'jsx',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.tf': 'terraform',
  '.hcl': 'terraform',
  '.sql': 'sql',
  '.css': 'css',
  '.scss': 'css',
  '.html': 'html',
  '.json': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.md': 'markdown',
  '.mdx': 'markdown',
};

const PARSEABLE_LANGUAGES: Set<Language> = new Set([
  'typescript', 'tsx', 'javascript', 'jsx',
  'python', 'go', 'rust', 'java', 'terraform',
]);

const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next',
  '__pycache__', '.pytest_cache', 'venv', '.venv',
  'target', 'vendor', '.terraform',
  'coverage', '.nyc_output', '.cache',
]);

const IGNORE_FILES = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
  '.DS_Store', 'thumbs.db',
]);

export function detectLanguage(filePath: string): Language {
  const ext = filePath.slice(filePath.lastIndexOf('.'));
  return EXTENSION_MAP[ext] || 'unknown';
}

export function isParseable(language: Language): boolean {
  return PARSEABLE_LANGUAGES.has(language);
}

export function shouldIgnorePath(path: string): boolean {
  const parts = path.split('/');
  // Check each directory component
  for (const part of parts.slice(0, -1)) {
    if (IGNORE_DIRS.has(part)) return true;
  }
  // Check filename
  const filename = parts[parts.length - 1];
  if (IGNORE_FILES.has(filename)) return true;
  if (filename.startsWith('.')) return true;
  return false;
}
