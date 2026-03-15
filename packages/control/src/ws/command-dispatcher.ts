import { randomUUID } from 'crypto';
import { WsErrorCode, type ResponseMessage, type StreamMessage } from '@coderage-labs/armada-shared';
import { serializeMessage } from './protocol.js';
import { nodeConnectionManager } from './node-connections.js';

const DEFAULT_TIMEOUT_MS = 30_000;

interface PendingCommand {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  /** Accumulated stream chunks keyed by seq, only populated for streaming responses */
  streamChunks?: Map<number, string>;
}

/**
 * Dispatches commands to node agents over WebSocket and awaits responses.
 *
 * Uses a Map<id, PendingCommand> to correlate responses with outstanding commands.
 * Streaming responses are buffered and resolved when `done: true` is received.
 */
export class CommandDispatcher {
  readonly pending: Map<string, PendingCommand> = new Map();

  /**
   * Send a command to a node agent and return a Promise that resolves
   * when the node responds (or rejects on timeout/error).
   */
  async send(
    nodeId: string,
    action: string,
    params: object,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ): Promise<unknown> {
    const ws = nodeConnectionManager.getConnection(nodeId);
    if (!ws) {
      throw Object.assign(
        new Error(`Node ${nodeId} is not connected`),
        { code: WsErrorCode.INSTANCE_UNREACHABLE },
      );
    }

    const id = randomUUID();

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          Object.assign(
            new Error(`Command ${action} on node ${nodeId} timed out after ${timeoutMs}ms`),
            { code: WsErrorCode.TIMEOUT },
          ),
        );
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });

      const message = serializeMessage({
        type: 'command',
        id,
        action,
        params: params as Record<string, unknown>,
        timeout: timeoutMs,
      });

      ws.send(message, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  /**
   * Handle an incoming ResponseMessage from a node agent.
   * Resolves or rejects the matching pending command.
   */
  handleResponse(msg: ResponseMessage): void {
    const pending = this.pending.get(msg.id);
    if (!pending) return; // Orphaned response — ignore

    clearTimeout(pending.timer);
    this.pending.delete(msg.id);

    if (msg.status === 'ok') {
      pending.resolve(msg.data);
    } else {
      const err = Object.assign(
        new Error(msg.error || 'Command failed'),
        { code: msg.code ?? WsErrorCode.UNKNOWN },
      );
      pending.reject(err);
    }
  }

  /**
   * Handle an incoming StreamMessage from a node agent.
   * Buffers chunks in sequence order and resolves when `done: true`.
   */
  handleStream(msg: StreamMessage): void {
    const pending = this.pending.get(msg.id);
    if (!pending) return; // Orphaned stream — ignore

    // Lazily initialise the chunk buffer
    if (!pending.streamChunks) {
      pending.streamChunks = new Map();
    }

    pending.streamChunks.set(msg.seq, msg.chunk);

    if (msg.done) {
      clearTimeout(pending.timer);
      this.pending.delete(msg.id);

      // Reassemble chunks in sequence order
      const chunks = pending.streamChunks;
      const maxSeq = Math.max(...chunks.keys());
      const assembled: string[] = [];
      for (let i = 0; i <= maxSeq; i++) {
        assembled.push(chunks.get(i) ?? '');
      }

      pending.resolve(assembled.join(''));
    }
    // If not done, keep waiting for more chunks
  }
}

/** Singleton CommandDispatcher instance */
export const commandDispatcher = new CommandDispatcher();
