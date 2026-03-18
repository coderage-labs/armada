/**
 * logs.ts — Live container log streaming handler.
 *
 * Handles the `logs.stream` action from the control plane.
 * Streams log lines back as ProgressMessages (step='log_line') until the
 * container exits, the WS closes, or an error occurs, then sends a final
 * ResponseMessage to settle the pending command on the control side.
 */

import {
  WsErrorCode,
  type CommandMessage,
  type ResponseMessage,
  type ProgressMessage,
} from '@coderage-labs/armada-shared';
import { docker } from '../docker/index.js';

export interface LogsHandlerContext {
  /** Send a progress update (log line) back over the same WS connection. */
  sendProgress?: (msg: ProgressMessage) => void;
}

export async function handleLogsCommand(
  msg: CommandMessage,
  ctx?: LogsHandlerContext,
): Promise<ResponseMessage> {
  const subAction = msg.action.split('.')[1]; // 'stream'

  if (subAction !== 'stream') {
    return error(msg.id, `Unknown logs action: ${msg.action}`, WsErrorCode.UNKNOWN);
  }

  const { id, tail } = msg.params as { id: string; tail?: number };
  if (!id) return error(msg.id, 'id is required', WsErrorCode.DOCKER_ERROR);

  const sendProgress = ctx?.sendProgress;
  if (!sendProgress) {
    // No progress callback — fall back to returning last N lines in a single response
    try {
      const container = docker.getContainer(id);
      const logBuffer = await container.logs({
        stdout: true,
        stderr: true,
        tail: tail ?? 100,
        follow: false,
      });
      const raw = typeof logBuffer === 'string' ? logBuffer : logBuffer.toString('utf-8');
      const lines = raw
        .split('\n')
        .map((l) => stripDockerPrefix(l).trim())
        .filter((l) => l.length > 0);
      return ok(msg.id, { lines });
    } catch (err: any) {
      return error(msg.id, err.message ?? String(err), WsErrorCode.DOCKER_ERROR);
    }
  }

  // Stream mode: follow=true, emit each line as a ProgressMessage
  return new Promise<ResponseMessage>((resolve) => {
    const container = docker.getContainer(id);

    container.logs({
      stdout: true,
      stderr: true,
      tail: tail ?? 100,
      follow: true,
    }).then((stream: NodeJS.ReadableStream | string) => {
      if (typeof stream === 'string') {
        // Non-streaming response — emit each line and resolve
        const lines = stream
          .split('\n')
          .map((l) => stripDockerPrefix(l).trim())
          .filter((l) => l.length > 0);
        for (const line of lines) {
          sendProgress({ type: 'progress', id: msg.id, data: { step: 'log_line', message: line } });
        }
        resolve(ok(msg.id, { done: true }));
        return;
      }

      // Readable stream — emit lines as they arrive
      let buffer = '';

      stream.on('data', (chunk: Buffer | string) => {
        const raw = typeof chunk === 'string' ? chunk : stripDockerPrefix(chunk.toString('utf-8'));
        buffer += raw;

        // Flush complete lines
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? ''; // keep incomplete trailing line in buffer

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed) {
            sendProgress({ type: 'progress', id: msg.id, data: { step: 'log_line', message: trimmed } });
          }
        }
      });

      stream.on('end', () => {
        // Flush any remaining buffer
        if (buffer.trim()) {
          sendProgress({ type: 'progress', id: msg.id, data: { step: 'log_line', message: buffer.trim() } });
        }
        resolve(ok(msg.id, { done: true }));
      });

      stream.on('error', (err: Error) => {
        resolve(error(msg.id, err.message, WsErrorCode.DOCKER_ERROR));
      });
    }).catch((err: Error) => {
      const isNotFound =
        (err as any)?.statusCode === 404 || err.message?.includes('No such container');
      resolve(error(
        msg.id,
        err.message ?? String(err),
        isNotFound ? WsErrorCode.CONTAINER_NOT_FOUND : WsErrorCode.DOCKER_ERROR,
      ));
    });
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function ok(id: string, data: unknown): ResponseMessage {
  return { type: 'response', id, status: 'ok', data };
}

function error(id: string, message: string, code: WsErrorCode): ResponseMessage {
  return { type: 'response', id, status: 'error', error: message, code };
}

/**
 * Docker multiplexed log streams prepend an 8-byte header per frame.
 * Strip these if present so we forward clean text.
 */
function stripDockerPrefix(raw: string): string {
  if (raw.length > 8 && raw.charCodeAt(0) <= 2 && raw.charCodeAt(0) >= 0) {
    return raw.slice(8);
  }
  return raw;
}
