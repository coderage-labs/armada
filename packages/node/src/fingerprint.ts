/**
 * fingerprint.ts — stable machine fingerprint for node identity verification.
 *
 * Builds a SHA-256 fingerprint from (in priority order):
 *   1. /etc/machine-id  (Linux systemd)
 *   2. Docker engine ID (from docker.info())
 *   3. CPU model + core count + total memory (fallback, always included)
 *
 * The fingerprint is cached after the first call.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import Docker from 'dockerode';

let _cached: string | null = null;

/**
 * Return the stable SHA-256 machine fingerprint (hex string).
 * Result is cached — safe to call multiple times.
 */
export async function getMachineFingerprint(): Promise<string> {
  if (_cached) return _cached;

  const parts: string[] = [];

  // 1. /etc/machine-id — present on systemd Linux hosts
  try {
    const machineId = readFileSync('/etc/machine-id', 'utf8').trim();
    if (machineId) parts.push(`machine-id:${machineId}`);
  } catch {
    // Not available — container or non-systemd host
  }

  // 2. Docker engine ID — unique per Docker installation
  try {
    const docker = new Docker();
    const info = await docker.info();
    if (info.ID) parts.push(`docker-id:${info.ID}`);
  } catch {
    // Docker not reachable (unlikely on a node agent, but handle gracefully)
  }

  // 3. CPU model + core count + total memory — always included as fallback anchor
  const cpus = os.cpus();
  const cpuModel = cpus[0]?.model ?? 'unknown';
  const coreCount = cpus.length;
  const totalMem = os.totalmem();
  parts.push(`hw:${cpuModel}:${coreCount}:${totalMem}`);

  const fingerprint = createHash('sha256').update(parts.join('|')).digest('hex');
  _cached = fingerprint;
  return fingerprint;
}
