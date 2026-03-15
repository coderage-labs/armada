/**
 * stats-streamer.ts — push node + container stats to the control plane via WS.
 *
 * Instead of waiting for the control plane to poll `node.stats`, the node agent
 * proactively streams a stats snapshot every DEFAULT_INTERVAL_MS.
 * The control plane caches and forwards these to the SSE bus for UI updates.
 */

import os from 'node:os';
import { execSync } from 'node:child_process';
import type { EventMessage } from '@coderage-labs/armada-shared';
import { getWsConnection } from '../ws/connection.js';
import { loadCredentials } from '../credentials.js';
import { docker } from '../docker/index.js';

export const DEFAULT_STATS_INTERVAL_MS = 10_000; // 10 seconds

// ── Stats history ring buffer ─────────────────────────────────────────────────

const HISTORY_MAX = 60; // ~10 min at 10s intervals
const statsHistory: Array<Record<string, unknown> & { timestamp: string }> = [];

/** Return a copy of the current stats history ring buffer. */
export function getStatsHistory(): Array<Record<string, unknown> & { timestamp: string }> {
  return [...statsHistory];
}

/** Collect the same stats payload as `node.stats` command handler */
async function collectStats(): Promise<Record<string, unknown>> {
  const cpus = os.cpus();
  const loadAvg = os.loadavg() as [number, number, number];
  const cpuUsage = Math.min(100, (loadAvg[0] / cpus.length) * 100);

  const totalMem = os.totalmem();
  const freeMem = os.freemem();

  let disk = { total: 0, used: 0, available: 0 };
  try {
    const df = execSync('df -B1 / | tail -1').toString().trim().split(/\s+/);
    disk = {
      total: parseInt(df[1], 10),
      used: parseInt(df[2], 10),
      available: parseInt(df[3], 10),
    };
  } catch {
    // Disk stats unavailable in this environment
  }

  let containers = { running: 0, total: 0 };
  try {
    const list = await docker.listContainers({ all: true });
    containers = {
      running: list.filter((c: any) => c.State === 'running').length,
      total: list.length,
    };
  } catch {
    // Docker may be unavailable
  }

  return {
    cpu: {
      cores: cpus.length,
      usage: Math.round(cpuUsage * 10) / 10,
      loadAvg,
    },
    memory: {
      total: totalMem,
      used: totalMem - freeMem,
      free: freeMem,
    },
    disk,
    containers,
  };
}

/**
 * Start streaming node stats to the control plane at the given interval.
 * Should be called once after the WS connection is established.
 */
export function startStatsStreamer(intervalMs = DEFAULT_STATS_INTERVAL_MS): void {
  console.log(`[stats-streamer] Starting (interval=${intervalMs / 1000}s)`);

  setInterval(async () => {
    try {
      const ws = getWsConnection();
      if (!ws || ws.readyState !== 1 /* OPEN */) return;

      const creds = loadCredentials();
      if (!creds?.nodeId) return; // not yet credentialed

      const stats = await collectStats();

      // Store in history ring buffer
      const entry = { ...stats, timestamp: new Date().toISOString() };
      statsHistory.push(entry);
      if (statsHistory.length > HISTORY_MAX) statsHistory.shift();

      const msg: EventMessage = {
        type: 'event',
        event: 'node.stats',
        data: { nodeId: creds.nodeId, ...stats } as Record<string, unknown>,
        timestamp: new Date().toISOString(),
      };

      ws.send(JSON.stringify(msg));
    } catch (err) {
      console.warn('[stats-streamer] Failed to collect/send stats:', err);
    }
  }, intervalMs);
}
