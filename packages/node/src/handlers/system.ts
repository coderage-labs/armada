import os from 'node:os';
import { execSync } from 'node:child_process';
import {
  WsErrorCode,
  type CommandMessage,
  type ResponseMessage,
} from '@coderage-labs/armada-shared';
import { docker } from '../docker/index.js';
import { getStatsHistory } from '../services/stats-streamer.js';

export async function handleSystemCommand(msg: CommandMessage): Promise<ResponseMessage> {
  const subAction = msg.action.split('.')[1]; // 'stats', 'info'

  try {
    switch (subAction) {
      case 'stats': {
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

        // #256: collect container counts
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

        return ok(msg.id, {
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
        });
      }

      case 'info': {
        let dockerVersion: string | undefined;
        let dockerApiVersion: string | undefined;
        try {
          const info = await docker.version();
          dockerVersion = info.Version;
          dockerApiVersion = info.ApiVersion;
        } catch {
          // Docker may be unavailable
        }

        return ok(msg.id, {
          hostname: os.hostname(),
          os: {
            platform: os.platform(),
            release: os.release(),
            type: os.type(),
          },
          arch: os.arch(),
          uptime: os.uptime(),
          docker: {
            version: dockerVersion,
            apiVersion: dockerApiVersion,
          },
        });
      }

      case 'statsHistory': {
        const history = getStatsHistory();
        return ok(msg.id, { history });
      }

      case 'capacity': {
        const cpus = os.cpus();
        const totalMem = os.totalmem();
        const freeMem = os.freemem();

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

        return ok(msg.id, {
          containers,
          resources: {
            cpuCores: cpus.length,
            memoryTotal: totalMem,
            memoryUsed: totalMem - freeMem,
            memoryFree: freeMem,
          },
        });
      }

      case 'logs': {
        const { limit, since } = msg.params as { limit?: number; since?: string };
        const { getLogs } = await import('../log-buffer.js');
        return ok(msg.id, { logs: getLogs(limit, since) });
      }

      default:
        return error(msg.id, `Unknown system action: ${msg.action}`, WsErrorCode.UNKNOWN);
    }
  } catch (err: any) {
    return {
      type: 'response',
      id: msg.id,
      status: 'error',
      error: err?.message ?? String(err),
      code: WsErrorCode.UNKNOWN,
    };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function ok(id: string, data: unknown): ResponseMessage {
  return { type: 'response', id, status: 'ok', data };
}

function error(id: string, message: string, code: WsErrorCode): ResponseMessage {
  return { type: 'response', id, status: 'error', error: message, code };
}
