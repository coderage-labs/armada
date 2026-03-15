import type { WsMessage } from '@coderage-labs/armada-shared';

/**
 * Parse and validate an incoming WebSocket message.
 * Returns null if the data is not a valid WsMessage.
 */
export function parseMessage(data: string): WsMessage | null {
  try {
    const parsed = JSON.parse(data);
    if (!parsed || typeof parsed !== 'object') return null;
    const type = parsed.type;
    if (!['command', 'response', 'event', 'stream', 'progress'].includes(type)) return null;

    switch (type) {
      case 'command':
        if (typeof parsed.id !== 'string') return null;
        if (typeof parsed.action !== 'string') return null;
        if (!parsed.params || typeof parsed.params !== 'object') return null;
        break;
      case 'response':
        if (typeof parsed.id !== 'string') return null;
        if (!['ok', 'error'].includes(parsed.status)) return null;
        break;
      case 'event':
        if (typeof parsed.event !== 'string') return null;
        if (typeof parsed.timestamp !== 'string') return null;
        break;
      case 'stream':
        if (typeof parsed.id !== 'string') return null;
        if (typeof parsed.chunk !== 'string') return null;
        if (typeof parsed.seq !== 'number') return null;
        if (typeof parsed.done !== 'boolean') return null;
        break;
      case 'progress':
        if (typeof parsed.id !== 'string') return null;
        if (!parsed.data || typeof parsed.data !== 'object') return null;
        break;
      default:
        return null;
    }

    return parsed as WsMessage;
  } catch (err: any) {
    console.warn('[ws/protocol] Failed to parse WS message:', err.message);
    return null;
  }
}

/**
 * Serialize a WsMessage to a JSON string for transmission.
 */
export function serializeMessage(msg: WsMessage): string {
  return JSON.stringify(msg);
}
