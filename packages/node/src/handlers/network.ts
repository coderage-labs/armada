import {
  WsErrorCode,
  type CommandMessage,
  type ResponseMessage,
} from '@coderage-labs/armada-shared';
import { ensureNetwork } from '../docker/network.js';

export async function handleNetworkCommand(msg: CommandMessage): Promise<ResponseMessage> {
  const subAction = msg.action.split('.')[1]; // 'ensure'

  try {
    switch (subAction) {
      case 'ensure': {
        const { name } = msg.params as { name: string };

        if (!name) {
          return error(msg.id, 'name is required', WsErrorCode.UNKNOWN);
        }

        const networkId = await ensureNetwork(name);
        return ok(msg.id, { networkId, name });
      }

      default:
        return error(msg.id, `Unknown network action: ${msg.action}`, WsErrorCode.UNKNOWN);
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
