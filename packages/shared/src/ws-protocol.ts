// ── WebSocket Protocol Types ─────────────────────────────────────────────────
// Shared between control plane and node agents.

// ── Envelope interfaces ──────────────────────────────────────────────────────

export interface BaseMessage {
  type: 'command' | 'response' | 'event' | 'stream' | 'progress';
}

/** Control → Node: requests an action. Node MUST respond with a matching `id`. */
export interface CommandMessage extends BaseMessage {
  type: 'command';
  /** UUID — correlates with the response */
  id: string;
  action: string;
  params: Record<string, unknown>;
  /** Milliseconds — control plane cancels if no response (default 30000) */
  timeout?: number;
}

/** Node → Control: always correlates to a command via `id`. */
export interface ResponseMessage extends BaseMessage {
  type: 'response';
  /** Matches the command's id */
  id: string;
  status: 'ok' | 'error';
  /** Present on success */
  data?: unknown;
  /** Present on error */
  error?: string;
  /** Machine-readable error code */
  code?: string;
}

/** Node → Control: fire-and-forget. No response expected. */
export interface EventMessage extends BaseMessage {
  type: 'event';
  /** e.g. 'container.health', 'node.stats', 'heartbeat' */
  event: string;
  data?: Record<string, unknown>;
  /** ISO 8601 */
  timestamp: string;
}

/** Either direction: chunked data (logs, file transfers). References a command `id`. */
export interface StreamMessage extends BaseMessage {
  type: 'stream';
  /** Matches the originating command's id */
  id: string;
  /** Data chunk (utf-8 text or base64 for binary) */
  chunk: string;
  encoding?: 'utf8' | 'base64';
  /** Sequence number (0-indexed) */
  seq: number;
  /** True on final chunk */
  done: boolean;
}

/**
 * Node → Control: mid-command progress update. References the originating command via `id`.
 * Used for long-running operations (image pull, plugin install) to stream layer-by-layer progress.
 */
export interface ProgressMessage extends BaseMessage {
  type: 'progress';
  /** Matches the originating command's id */
  id: string;
  data: {
    /** Machine-readable step name (e.g. 'pull_image') */
    step?: string;
    /** Human-readable status line */
    message: string;
    /** Optional percentage (0–100) */
    percent?: number;
    /** Optional detail string (e.g. Docker layer progress bar) */
    detail?: string;
  };
}

/** Discriminated union of all WebSocket message types */
export type WsMessage = CommandMessage | ResponseMessage | EventMessage | StreamMessage | ProgressMessage;

// ── Type guards ──────────────────────────────────────────────────────────────

export function isCommand(msg: WsMessage): msg is CommandMessage {
  return msg.type === 'command';
}

export function isResponse(msg: WsMessage): msg is ResponseMessage {
  return msg.type === 'response';
}

export function isEvent(msg: WsMessage): msg is EventMessage {
  return msg.type === 'event';
}

export function isStream(msg: WsMessage): msg is StreamMessage {
  return msg.type === 'stream';
}

export function isProgress(msg: WsMessage): msg is ProgressMessage {
  return msg.type === 'progress';
}

// ── Error codes ──────────────────────────────────────────────────────────────

export enum WsErrorCode {
  CONTAINER_NOT_FOUND = 'CONTAINER_NOT_FOUND',
  TIMEOUT = 'TIMEOUT',
  DOCKER_ERROR = 'DOCKER_ERROR',
  FILE_NOT_FOUND = 'FILE_NOT_FOUND',
  PERMISSION_DENIED = 'PERMISSION_DENIED',
  INSTANCE_UNREACHABLE = 'INSTANCE_UNREACHABLE',
  NOT_IMPLEMENTED = 'NOT_IMPLEMENTED',
  UNKNOWN = 'UNKNOWN',
  NODE_IDENTITY_MISMATCH = 'NODE_IDENTITY_MISMATCH',
  IN_FLIGHT = 'IN_FLIGHT',
}

// ── Action type unions ───────────────────────────────────────────────────────

export type ContainerAction =
  | 'container.create'
  | 'container.start'
  | 'container.stop'
  | 'container.restart'
  | 'container.remove'
  | 'container.logs'
  | 'container.stats'
  | 'container.list'
  | 'container.inspect';

export type FileAction =
  | 'file.read'
  | 'file.write'
  | 'file.list'
  | 'file.delete';

export type PluginAction =
  | 'plugin.install'
  | 'plugin.remove'
  | 'skill.install'
  | 'skill.remove';

export type SystemAction = 'node.stats' | 'node.info';

export type RelayAction = 'instance.relay';

export type GatewayAction = 'gateway.proxy';

/** Credential lifecycle actions — Control ↔ Node */
export type CredentialAction =
  | 'credential.issued'   // Control → Node: new session credential issued after install-token auth
  | 'credential.rotate';  // Control → Node: rotate existing session credential

export type WsAction =
  | ContainerAction
  | FileAction
  | PluginAction
  | SystemAction
  | RelayAction
  | GatewayAction
  | CredentialAction;

// ── Credential error codes ──────────────────────────────────────────────────

export const NODE_IDENTITY_MISMATCH = 'NODE_IDENTITY_MISMATCH';
