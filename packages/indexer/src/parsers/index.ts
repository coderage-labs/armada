export { detectLanguage, isParseable, shouldIgnorePath } from './detect.js';
export { treeSitterParse } from './tree-sitter-parser.js';
export { ensureInit, getLanguage, getSupportedLanguages } from './tree-sitter-init.js';
// Regex fallbacks
export { parseTypeScript } from './typescript-parser.js';
export { parsePython } from './python-parser.js';
export { parseGo } from './go-parser.js';
