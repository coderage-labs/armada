/**
 * Git credential helper management for agents.
 *
 * Embeds the credential helper shell script as a string constant and provides
 * functions to deploy it to the shared location on the host.
 */

import { mkdirSync, writeFileSync, existsSync, copyFileSync, chmodSync } from 'node:fs';
import path from 'node:path';

const SHARED_DIR = '/data/armada-shared';
const HELPER_FILENAME = 'armada-credential-helper';
export const SHARED_HELPER_PATH = `${SHARED_DIR}/${HELPER_FILENAME}`;

/**
 * Ensure the shared credential helper script is deployed to /data/armada-shared/.
 * Called once on node agent startup.
 */
export function ensureCredentialHelper(): void {
  mkdirSync(SHARED_DIR, { recursive: true });

  // Copy from the bundled assets directory
  // At runtime, __dirname is packages/node-agent/dist — assets is at ../assets
  // But since we can't rely on __dirname in ESM, use a path relative to process.cwd() fallback
  const candidates = [
    path.resolve(new URL('.', import.meta.url).pathname, '../../assets', HELPER_FILENAME),
    path.resolve('/data/armada-shared', HELPER_FILENAME), // already deployed
  ];

  let srcPath: string | null = null;
  for (const c of candidates) {
    if (existsSync(c)) {
      srcPath = c;
      break;
    }
  }

  if (srcPath && srcPath !== SHARED_HELPER_PATH) {
    copyFileSync(srcPath, SHARED_HELPER_PATH);
    chmodSync(SHARED_HELPER_PATH, 0o755);
    console.log(`🔑 Credential helper deployed to ${SHARED_HELPER_PATH}`);
    return;
  }
  if (!existsSync(SHARED_HELPER_PATH)) {
    // Fallback: embed the script inline
    const helperScript = `#!/bin/sh
# armada-credential-helper — git credential helper for agents
set -e
CRED_FILE="\${CRED_FILE:-/etc/armada/git-credentials.json}"
if [ "$1" != "get" ]; then exit 0; fi
INPUT_HOST="" INPUT_PROTOCOL="" INPUT_PATH=""
while IFS='=' read -r key value; do
  [ -z "$key" ] && break
  case "$key" in host) INPUT_HOST="$value" ;; protocol) INPUT_PROTOCOL="$value" ;; path) INPUT_PATH="$value" ;; esac
done
[ -z "$INPUT_HOST" ] && exit 0
[ ! -f "$CRED_FILE" ] && exit 0
CLEAN_PATH=$(printf '%s' "$INPUT_PATH" | sed 's/\\.git$//')
RESULT=$(jq -r --arg host "$INPUT_HOST" --arg path "$CLEAN_PATH" '.credentials[] | select(.host == $host) | select((.paths | length == 0) or (.paths | any(. == "*")) or (.paths | any($path | startswith(.)))) | "protocol=\\(.protocol // "https")\\nhost=\\(.host)\\nusername=\\(.username)\\npassword=\\(.password)\\n"' "$CRED_FILE" 2>/dev/null | head -4)
[ -n "$RESULT" ] && printf '%s\\n' "$RESULT"
exit 0
`;
    writeFileSync(SHARED_HELPER_PATH, helperScript, { mode: 0o755 });
    console.log(`🔑 Credential helper written to ${SHARED_HELPER_PATH} (inline fallback)`);
  }
}

/**
 * Ensure per-agent credentials directory within an instance volume.
 *
 * Instance layout (multi-agent per instance):
 *   /data/instances/{instanceName}/credentials/{agentName}/git-credentials.json
 *
 * This is bind-mounted as /etc/armada/ inside the container, so each agent's
 * credentials end up at /etc/armada/{agentName}/git-credentials.json.
 */
export function ensureInstanceAgentCredentialsDir(instanceName: string, agentName: string): void {
  const credDir = `/data/instances/${instanceName}/credentials/${agentName}`;
  mkdirSync(credDir, { recursive: true });

  const credFile = `${credDir}/git-credentials.json`;
  if (!existsSync(credFile)) {
    writeFileSync(credFile, JSON.stringify({ credentials: [] }), { mode: 0o644 });
  }

  // Deploy the credential helper into the per-agent directory.
  // This helper reads from the same directory it lives in.
  const helperDst = `${credDir}/${HELPER_FILENAME}`;
  if (existsSync(SHARED_HELPER_PATH)) {
    copyFileSync(SHARED_HELPER_PATH, helperDst);
    chmodSync(helperDst, 0o755);
  }

  // Also deploy a per-agent wrapper that sets the credential file path
  const wrapperPath = `${credDir}/credential-helper`;
  const wrapperScript = `#!/bin/sh
# Per-agent credential helper wrapper for ${agentName}
# Points to agent-specific credentials within the shared instance volume
CRED_FILE="/etc/armada/${agentName}/git-credentials.json"
export CRED_FILE
exec /etc/armada/${agentName}/${HELPER_FILENAME} "$@"
`;
  writeFileSync(wrapperPath, wrapperScript, { mode: 0o755 });
}

/**
 * Ensure the instance-level credentials directory exists with the shared
 * credential helper deployed at the root level.
 */
export function ensureInstanceCredentialsDir(instanceName: string): void {
  const credDir = `/data/instances/${instanceName}/credentials`;
  mkdirSync(credDir, { recursive: true });

  // Deploy shared credential helper at the root of credentials dir
  const helperDst = `${credDir}/${HELPER_FILENAME}`;
  if (existsSync(SHARED_HELPER_PATH)) {
    copyFileSync(SHARED_HELPER_PATH, helperDst);
    chmodSync(helperDst, 0o755);
  }
}
