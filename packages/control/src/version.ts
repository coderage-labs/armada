import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { ARMADA_PROTOCOL_VERSION, ARMADA_MIN_VERSION } from '@coderage-labs/armada-shared';

function findPackageJson(startDir: string): { version: string } {
  let dir = startDir;
  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) {
      const parsed = JSON.parse(readFileSync(candidate, 'utf8'));
      if (parsed.name === '@coderage-labs/armada-control') return parsed;
    }
    dir = dirname(dir);
  }
  return { version: '0.0.0' };
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = findPackageJson(__dirname);

export const CONTROL_VERSION = pkg.version;
export const PROTOCOL_VERSION = ARMADA_PROTOCOL_VERSION;
export const MIN_NODE_VERSION = ARMADA_MIN_VERSION;
export const MIN_AGENT_PLUGIN_VERSION = ARMADA_MIN_VERSION;
export const AGENT_PLUGIN_VERSION = '0.1.1';
