import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { ARMADA_PROTOCOL_VERSION } from '@coderage-labs/armada-shared';

function findPackageJson(startDir: string): { version: string } {
  let dir = startDir;
  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) {
      const parsed = JSON.parse(readFileSync(candidate, 'utf8'));
      if (parsed.name === '@coderage-labs/armada-node') return parsed;
    }
    dir = dirname(dir);
  }
  return { version: '0.0.0' };
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = findPackageJson(__dirname);

export const NODE_VERSION = pkg.version;
export const PROTOCOL_VERSION = ARMADA_PROTOCOL_VERSION;
export const MIN_CONTROL_VERSION = '1.3.0';
