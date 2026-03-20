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
  '.tfvars': 'terraform',
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

const FILENAME_MAP: Record<string, Language> = {
  'Dockerfile': 'docker',
  'Makefile': 'makefile',
  'Jenkinsfile': 'groovy',
};

const FILENAME_PREFIX_MAP: Array<[string, Language]> = [
  ['Dockerfile', 'docker'],
  ['.env', 'env'],
];

export function detectLanguage(filePath: string): Language {
  const ext = filePath.slice(filePath.lastIndexOf('.'));
  if (EXTENSION_MAP[ext]) return EXTENSION_MAP[ext];

  // Check exact filename matches
  const filename = filePath.split('/').pop() || '';
  if (FILENAME_MAP[filename]) return FILENAME_MAP[filename];

  // Check filename prefix matches (e.g. Dockerfile.backend, .env.example)
  for (const [prefix, lang] of FILENAME_PREFIX_MAP) {
    if (filename.startsWith(prefix)) return lang;
  }

  // Check if filename contains known patterns
  if (filename.includes('.env')) return 'env' as Language;
  if (filename.endsWith('.example') || filename.endsWith('.sample')) {
    // Try stripping .example/.sample and re-detecting
    const stripped = filename.replace(/\.(example|sample)$/, '');
    const strippedExt = stripped.slice(stripped.lastIndexOf('.'));
    if (EXTENSION_MAP[strippedExt]) return EXTENSION_MAP[strippedExt];
  }

  // Additional extensions
  if (ext === '.sh' || ext === '.bash' || ext === '.zsh') return 'shell' as Language;
  if (ext === '.toml') return 'toml' as Language;
  if (ext === '.cfg' || ext === '.ini' || ext === '.conf') return 'config' as Language;

  return 'unknown';
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
  if (filename.endsWith('.d.ts') || filename.endsWith('.d.mts') || filename.endsWith('.d.cts')) return true;
  if (filename.startsWith('.')) return true;
  return false;
}
