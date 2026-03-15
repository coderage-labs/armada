/**
 * credentials.ts — persistent storage for node session credentials.
 *
 * On first connection the node uses a one-time install token (FLEET_NODE_TOKEN).
 * The control plane issues a long-lived session credential via `credential.issued`.
 * Subsequent connections use the saved session credential.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const CREDENTIALS_PATH =
  process.env.CREDENTIALS_PATH ?? '/etc/fleet-node/credentials.json';

export interface NodeCredentials {
  nodeId: string;
  sessionCredential: string;
  controlUrl: string;
}

/**
 * Load credentials from disk.
 * Returns null if the file doesn't exist or is unparseable.
 */
export function loadCredentials(): NodeCredentials | null {
  try {
    if (!existsSync(CREDENTIALS_PATH)) return null;
    const raw = readFileSync(CREDENTIALS_PATH, 'utf8');
    const parsed = JSON.parse(raw) as NodeCredentials;
    if (!parsed.nodeId || !parsed.sessionCredential || !parsed.controlUrl) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Persist credentials to disk (mode 0600 — owner-read-only).
 */
export function saveCredentials(creds: NodeCredentials): void {
  const dir = dirname(CREDENTIALS_PATH);
  mkdirSync(dir, { recursive: true });
  writeFileSync(CREDENTIALS_PATH, JSON.stringify(creds, null, 2), { mode: 0o600 });
}
