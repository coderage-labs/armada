import { execSync } from 'node:child_process';
import { mkdir, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  WsErrorCode,
  type CommandMessage,
  type ResponseMessage,
} from '@coderage-labs/armada-shared';

const DEFAULT_BIN_DIR = '/data/tools/bin';

export async function handleToolCommand(msg: CommandMessage): Promise<ResponseMessage> {
  const subAction = msg.action.split('.')[1]; // 'ensure', 'list', 'update'

  try {
    switch (subAction) {
      case 'ensure': {
        const { tools, binDir = DEFAULT_BIN_DIR } = msg.params as {
          tools: string[];
          binDir?: string;
        };

        if (!Array.isArray(tools) || tools.length === 0) {
          return error(msg.id, 'tools array is required', WsErrorCode.UNKNOWN);
        }

        await mkdir(binDir, { recursive: true });

        const installed: string[] = [];
        const failed: string[] = [];

        for (const tool of tools) {
          try {
            execSync(
              `eget ${tool} --to ${binDir} --asset tar.gz --asset ^musl 2>&1 || eget ${tool} --to ${binDir} 2>&1`,
              {
                timeout: 120_000,
                stdio: ['pipe', 'pipe', 'pipe'],
                shell: '/bin/sh',
              },
            );
            console.log(`✅ Installed tool: ${tool}`);
            installed.push(tool);
          } catch (err: any) {
            console.error(`❌ Failed to install tool ${tool}:`, err.message);
            failed.push(tool);
          }
        }

        return ok(msg.id, { installed, failed });
      }

      case 'list': {
        const { binDir = DEFAULT_BIN_DIR } = msg.params as { binDir?: string };

        let entries: string[];
        try {
          entries = await readdir(binDir);
        } catch {
          return ok(msg.id, { tools: [] });
        }

        const tools: Array<{ name: string; size: number }> = [];
        for (const name of entries) {
          try {
            const info = await stat(join(binDir, name));
            if (info.isFile()) {
              tools.push({ name, size: info.size });
            }
          } catch {
            // skip unreadable entries
          }
        }

        return ok(msg.id, { tools });
      }

      case 'update': {
        const { tool, binDir = DEFAULT_BIN_DIR } = msg.params as {
          tool: string;
          binDir?: string;
        };

        if (!tool) {
          return error(msg.id, 'tool is required', WsErrorCode.UNKNOWN);
        }

        await mkdir(binDir, { recursive: true });

        try {
          execSync(
            `eget ${tool} --to ${binDir} --asset tar.gz --asset ^musl 2>&1 || eget ${tool} --to ${binDir} 2>&1`,
            {
              timeout: 120_000,
              stdio: ['pipe', 'pipe', 'pipe'],
              shell: '/bin/sh',
            },
          );
          console.log(`✅ Updated tool: ${tool}`);
          return ok(msg.id, { updated: tool });
        } catch (err: any) {
          return error(msg.id, `Failed to update tool ${tool}: ${err.message}`, WsErrorCode.UNKNOWN);
        }
      }

      default:
        return error(msg.id, `Unknown tool action: ${msg.action}`, WsErrorCode.UNKNOWN);
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
