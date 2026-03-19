/**
 * armada-shared — Shared utilities for armada plugins.
 *
 * Contains the core task injection engine (injectAndWaitForResponse) used by
 * both armada-control and armada-agent, plus common helpers.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ── Symbol.for key constants ────────────────────────────────────────

export const ARMADA_PENDING_SYM = 'armada-session-pending';
export const ARMADA_COORD_CB_SYM = 'armada-coordinator-callbacks';
export const ARMADA_OUTBOUND_SYM = 'armada-outbound-tasks';
export const ARMADA_INBOUND_SYM = 'armada-inbound-contexts';

// ── Task persistence constants & helpers ────────────────────────────

/** Stale task threshold: 2 hours */
export const TASK_STALE_MS = 2 * 60 * 60 * 1000;

/**
 * Serialize a Map to JSON string with date handling.
 * Converts Date objects and numeric timestamps to ISO strings for safe round-tripping.
 */
export function serializeTaskMap(map: Map<string, any>): string {
  const entries: Array<[string, any]> = [];
  for (const [key, value] of map) {
    const serialized: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v instanceof Date) {
        serialized[k] = { __type: 'Date', value: v.toISOString() };
      } else if (v instanceof Set) {
        serialized[k] = { __type: 'Set', value: [...v] };
      } else if (typeof v === 'function' || typeof v === 'object' && v !== null && ('_idlePrev' in v || '_onTimeout' in v)) {
        // Skip timers and callbacks — can't be serialized
        continue;
      } else {
        serialized[k] = v;
      }
    }
    entries.push([key, serialized]);
  }
  return JSON.stringify(entries, null, 2);
}

/**
 * Deserialize a JSON string back into a Map with date revival.
 * Revives ISO date strings tagged with __type: 'Date' and Sets tagged with __type: 'Set'.
 */
export function deserializeTaskMap(json: string): Map<string, any> {
  const entries: Array<[string, any]> = JSON.parse(json);
  const map = new Map<string, any>();
  for (const [key, value] of entries) {
    const revived: Record<string, any> = {};
    for (const [k, v] of Object.entries(value as Record<string, any>)) {
      if (v && typeof v === 'object' && (v as any).__type === 'Date') {
        revived[k] = new Date((v as any).value);
      } else if (v && typeof v === 'object' && (v as any).__type === 'Set') {
        revived[k] = new Set((v as any).value);
      } else {
        revived[k] = v;
      }
    }
    map.set(key, revived);
  }
  return map;
}

// ── GlobalThis Map helper ───────────────────────────────────────────

/**
 * Get or create a globalThis-persisted Map that survives jiti re-evaluation.
 * Uses Symbol.for(symbolName) as the key on globalThis.
 */
export function getOrCreateGlobalMap<K, V>(symbolName: string): Map<K, V> {
  const sym = Symbol.for(symbolName);
  if (!(globalThis as any)[sym]) {
    (globalThis as any)[sym] = new Map<K, V>();
  }
  return (globalThis as any)[sym] as Map<K, V>;
}

// ── Shared interfaces ───────────────────────────────────────────────

/** Result from a sub-task, used in coordinator callbacks */
export interface SubTaskResult {
  taskId: string;
  targetName?: string;
  from?: string;
  text: string;
  error?: string;
  attachments?: string[];
  _isProgress?: boolean;
}

/** Options for injectAndWaitForResponse */
export interface InjectOpts {
  taskId: string;
  from: string;
  callbackUrl?: string;
  /** Hooks token for heartbeat auth */
  hooksToken?: string;
  /** Instance name for heartbeat sender identification */
  instanceName?: string;
  /** Ping watchdog timeout in ms — agent must ping within this window or task fails (default 60_000) */
  pingWatchdogMs?: number;
  /** Progress timeout in ms — agent must produce tool output/turns within this window or task fails (default 600_000) */
  progressTimeoutMs?: number;
  /** Hard timeout in ms (default 1_800_000) */
  hardTimeoutMs?: number;
  /** Ping interval in ms (default 10_000) */
  pingIntervalMs?: number;
  /** Override the derived session key (e.g. for coordinator sessions) */
  sessionKey?: string;
  /** @deprecated Use progressTimeoutMs instead */
  idleTimeoutMs?: number;
}

/** Logger interface accepted by shared functions */
export interface ArmadaLogger {
  info: (...args: any[]) => void;
  warn: (...args: any[]) => void;
  error: (...args: any[]) => void;
}

// ── HTTP helpers ────────────────────────────────────────────────────

/** Parse JSON body from an incoming HTTP request */
export function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

/** Send a JSON response */
export function sendJson(res: ServerResponse, code: number, data: any): void {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(data));
}

// ── ID generation ───────────────────────────────────────────────────

/** Generate a armada task ID */
export function generateId(): string {
  return `ft-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── Delivery context parsing ────────────────────────────────────────

/** Parse delivery context from OpenClaw session key.
 *  Format: agent:main:telegram:group:-1003704453875:topic:26 */
export function parseDeliveryFromSessionKey(sessionKey: string): { channel?: string; to?: string; threadId?: string } {
  const parts = sessionKey.split(':');
  const channels = ['telegram', 'discord', 'whatsapp', 'slack', 'signal', 'imessage'];
  const chIdx = parts.findIndex(p => channels.includes(p));
  if (chIdx === -1) return {};

  const channel = parts[chIdx];
  let to: string | undefined;
  if (parts[chIdx + 1] === 'group' && parts[chIdx + 2]) {
    to = `${channel}:${parts[chIdx + 2]}`;
  } else if (parts[chIdx + 1]) {
    to = `${channel}:${parts[chIdx + 1]}`;
  }

  let threadId: string | undefined;
  const topicIdx = parts.indexOf('topic');
  const threadIdx = parts.indexOf('thread');
  if (topicIdx !== -1 && parts[topicIdx + 1]) threadId = parts[topicIdx + 1];
  else if (threadIdx !== -1 && parts[threadIdx + 1]) threadId = parts[threadIdx + 1];

  return { channel, to, threadId };
}

// ── Attachment decoding ─────────────────────────────────────────────

/** Resolve the default download directory under the agent's workspace */
function getDefaultDownloadDir(): string {
  const home = process.env.HOME || process.env.USERPROFILE || '/tmp';
  return `${home}/.openclaw/workspace/armada-downloads`;
}

/** Decode base64 attachments to local files, return descriptive text + file paths */
export function decodeAttachments(attachments: any[], logger?: ArmadaLogger, downloadDir?: string): string {
  if (!attachments?.length) return '';
  const dlDir = downloadDir || getDefaultDownloadDir();
  mkdirSync(dlDir, { recursive: true });
  const paths: string[] = [];
  const mimeToExt: Record<string, string> = {
    'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif',
    'image/webp': '.webp', 'audio/mpeg': '.mp3',
    'audio/ogg': '.ogg', 'video/mp4': '.mp4', 'application/pdf': '.pdf',
  };
  for (const att of attachments) {
    const ext = mimeToExt[att.mimeType] || '';
    const fname = att.filename || `${randomUUID()}${ext}`;
    const p = `${dlDir}/${fname}`;
    writeFileSync(p, Buffer.from(att.bytes, 'base64'));
    paths.push(p);
    logger?.info(`[armada-shared] Decoded attachment → ${p} (${att.mimeType})`);
  }
  return `\nAttachments: ${paths.join(', ')}`;
}

/** Decode attachments and return as {{file:...}} markers for re-encoding in forwarding */
export function decodeAttachmentsAsMarkers(attachments: any[], logger?: ArmadaLogger, downloadDir?: string): string {
  if (!attachments?.length) return '';
  const dlDir = downloadDir || getDefaultDownloadDir();
  mkdirSync(dlDir, { recursive: true });
  const markers: string[] = [];
  const mimeToExt: Record<string, string> = {
    'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif',
    'image/webp': '.webp', 'audio/mpeg': '.mp3',
    'audio/ogg': '.ogg', 'video/mp4': '.mp4', 'application/pdf': '.pdf',
  };
  for (const att of attachments) {
    const ext = mimeToExt[att.mimeType] || '';
    const fname = att.filename || `${randomUUID()}${ext}`;
    const p = `${dlDir}/${fname}`;
    writeFileSync(p, Buffer.from(att.bytes, 'base64'));
    markers.push(`{{file:${p}}}`);
    logger?.info(`[armada-shared] Decoded attachment for forwarding → ${p} (${att.mimeType})`);
  }
  return markers.join('\n');
}

// ── Attachment encoding (outbound: files → base64) ──────────────────

const MAX_INLINE_BYTES = 10 * 1024 * 1024; // 10MB max per file

/** Guess MIME type from file extension */
function guessMimeType(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  const map: Record<string, string> = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
    webp: 'image/webp', svg: 'image/svg+xml', pdf: 'application/pdf',
    mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav',
    mp4: 'video/mp4', webm: 'video/webm',
    json: 'application/json', txt: 'text/plain', csv: 'text/csv',
  };
  return map[ext] || 'application/octet-stream';
}

/** Pattern for explicit file attachment markers: {{file:/path/to/file}} */
const FILE_MARKER_RE = /\{\{file:(.+?)\}\}/gi;

interface EncodedAttachment {
  mimeType: string;
  bytes: string;
  filename?: string;
}

/**
 * Scan text for {{file:/path/to/file}} markers, read files, encode as base64.
 * Returns cleaned text + extracted attachments.
 */
export function extractFileMarkers(text: string, logger?: ArmadaLogger): {
  cleanedText: string;
  attachments: EncodedAttachment[];
} {
  const attachments: EncodedAttachment[] = [];
  const matches = [...text.matchAll(FILE_MARKER_RE)];

  if (matches.length === 0) return { cleanedText: text, attachments };

  let cleanedText = text;
  for (const match of matches) {
    const filePath = match[1].trim();
    const filename = filePath.split('/').pop() || 'file';
    try {
      const { statSync } = require('node:fs');
      const stat = statSync(filePath);
      if (stat.size === 0) {
        cleanedText = cleanedText.replace(match[0], `[empty file: ${filename}]`);
        continue;
      }
      if (stat.size > MAX_INLINE_BYTES) {
        logger?.warn(`[armada-shared] File too large for inline (${stat.size} bytes): ${filePath}`);
        cleanedText = cleanedText.replace(match[0], `[file too large: ${filename} (${Math.round(stat.size / 1024)}KB)]`);
        continue;
      }
      const bytes = readFileSync(filePath).toString('base64');
      const mimeType = guessMimeType(filePath);
      attachments.push({ mimeType, bytes, filename });
      cleanedText = cleanedText.replace(match[0], `[attached: ${filename}]`);
      logger?.info(`[armada-shared] Encoded attachment: ${filePath} (${stat.size} bytes, ${mimeType})`);
    } catch (err: any) {
      cleanedText = cleanedText.replace(match[0], `[file not found: ${filename}]`);
      logger?.warn(`[armada-shared] Failed to read file ${filePath}: ${err.message}`);
    }
  }

  return { cleanedText: cleanedText.trim(), attachments };
}

// ── Shared armada_task dispatch ───────────────────────────────────────

export interface DispatchTaskOpts {
  targetUrl: string;
  taskId: string;
  from: string;
  fromRole: string;
  message: string;
  callbackUrl: string;
  hooksToken: string;
  timeoutMs?: number;
  project?: string;
  /** Target agent name for multi-agent instance routing */
  targetAgent?: string;
}

export interface DispatchTaskResult {
  taskId: string;
  target: string;
  status: 'sent';
  message: string;
}

/**
 * Core task dispatch — extracts file markers, encodes attachments,
 * POSTs to the target's /armada/task endpoint.
 * Used by both armada-control and armada-agent.
 */
export async function dispatchArmadaTask(
  opts: DispatchTaskOpts,
  logger?: ArmadaLogger,
): Promise<{ ok: true; taskId: string } | { ok: false; error: string }> {
  const { cleanedText: taskMessage, attachments } = extractFileMarkers(opts.message, logger);

  try {
    const resp = await fetch(`${opts.targetUrl}/armada/task`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${opts.hooksToken}`,
      },
      body: JSON.stringify({
        taskId: opts.taskId,
        from: opts.from,
        fromRole: opts.fromRole,
        message: taskMessage,
        callbackUrl: opts.callbackUrl,
        ...(attachments.length > 0 && { attachments }),
        ...(opts.project && { project: opts.project }),
        ...(opts.targetAgent && { targetAgent: opts.targetAgent }),
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
    });

    if (!resp.ok) {
      return { ok: false, error: `${resp.status} ${resp.statusText}` };
    }
    return { ok: true, taskId: opts.taskId };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

// ── Gateway RPC (channel-agnostic delivery) ─────────────────────────

let _callGateway: Function | null = null;

/**
 * Call the OpenClaw gateway RPC. Used for channel-agnostic delivery —
 * callGatewayRpc('agent', { deliver: true, channel, to, ... }) injects
 * into a session and delivers the response to the appropriate channel.
 */
export async function callGatewayRpc(
  api: any,
  method: string,
  params: Record<string, unknown>,
  timeoutMs = 30_000,
): Promise<any> {
  if (!_callGateway) {
    let distDir: string;
    try {
      distDir = join(require.resolve('openclaw/package.json').replace('/package.json', ''), 'dist');
    } catch {
      const candidates = [
        '/data/.npm-global/lib/node_modules/openclaw/dist',
        '/app/dist',
        join(homedir(), '.npm-global/lib/node_modules/openclaw/dist'),
      ];
      const found = candidates.find(d => { try { readdirSync(d); return true; } catch { return false; } });
      if (!found) throw new Error('Cannot find OpenClaw dist directory');
      distDir = found;
    }
    // Search strategy: the bundled callGateway function name is preserved across versions,
    // but the file prefix and export key change (v2026.3.2: call-*.js/export n, v2026.3.12: reply-*.js/export Us).
    // Strategy: check known file prefixes, then try all exports for a function named callGateway.
    const filePrefixes = ['call-', 'reply-', 'gateway-rpc-', 'auth-profiles-'];
    const candidateFiles = readdirSync(distDir)
      .filter(f => f.endsWith('.js') && filePrefixes.some(p => f.startsWith(p)));

    for (const cf of candidateFiles) {
      try {
        const mod = await import(join(distDir, cf));
        // Try known export names first (fast path)
        for (const key of ['n', 'Us', 'cc']) {
          if (typeof mod[key] === 'function' && mod[key].name === 'callGateway') {
            _callGateway = mod[key]; break;
          }
        }
        if (_callGateway) break;
        // Fallback: scan all exports for a function named callGateway
        for (const key of Object.keys(mod)) {
          if (typeof mod[key] === 'function' && mod[key].name === 'callGateway') {
            _callGateway = mod[key]; break;
          }
        }
        if (_callGateway) break;
      } catch {}
    }
    if (!_callGateway) throw new Error('callGateway function not found in OpenClaw dist');
  }

  // Get token from api.config
  let token: string | undefined;
  try {
    token = (api?.config as any)?.gateway?.auth?.token?.trim();
  } catch {}
  if (!token) {
    try {
      const cfgPath = join(process.env.OPENCLAW_DIR || join(homedir(), '.openclaw'), 'openclaw.json');
      const raw = readFileSync(cfgPath, 'utf-8');
      const clean = raw.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/,(\s*[}\]])/g, '$1');
      token = JSON.parse(clean)?.gateway?.auth?.token?.trim();
    } catch {}
  }

  return _callGateway!({ method, params, token, timeoutMs });
}

// ── Event-driven task engine ────────────────────────────────────────

/** Tracks an outbound task (something I sent downstream, waiting for result) */
export interface OutboundTask {
  taskId: string;
  /** Session that called armada_task */
  sessionKey: string;
  target: string;
}

/** Tracks an inbound task context (something I'm doing for someone with a callback) */
export interface InboundContext {
  taskId: string;
  from: string;
  callbackUrl: string;
  hooksToken: string;
  instanceName: string;
  sessionKey: string;
  accumulator: string[];
  pendingSubTasks: Set<string>;
  /** @deprecated Use pingWatchdogMs/progressTimeoutMs */
  idleTimeoutMs: number;
  hardTimeoutMs: number;
  pingWatchdogMs: number;
  progressTimeoutMs: number;
  pingIntervalMs: number;
  // Runtime state (not persistable)
  ctx: any;
  cfg: any;
  storePath: string;
  /** Fires if no ping received within pingWatchdogMs — agent process is dead */
  pingWatchdogTimer?: ReturnType<typeof setTimeout>;
  /** Fires if no progress (tool calls / turn output) within progressTimeoutMs — agent is stuck */
  progressTimer?: ReturnType<typeof setTimeout>;
  hardTimer?: ReturnType<typeof setTimeout>;
  /** Process-level ping interval (independent of LLM) */
  pingTimer?: ReturnType<typeof setInterval>;
  /** Mutex queue for sequencing dispatchTurn calls */
  turnQueue: Promise<void>;
  finalized: boolean;
  /** Optional callback fired when inbound is finalized (for reporting to control plane) */
  onFinalize?: (taskId: string, status: string, result: string) => void;
}

/**
 * Set up a armada session for injecting agent turns.
 * Creates the inbound context, session, and initial ctx object.
 * Returns an InboundContext ready for dispatchTurn calls.
 */
export async function createInboundContext(
  api: any,
  opts: {
    taskId: string;
    from: string;
    callbackUrl: string;
    hooksToken: string;
    instanceName: string;
    sessionKey?: string;
    /** Target agent name for multi-agent instance routing */
    targetAgent?: string;
    /** @deprecated Use progressTimeoutMs */
    idleTimeoutMs?: number;
    pingWatchdogMs?: number;
    progressTimeoutMs?: number;
    hardTimeoutMs?: number;
    pingIntervalMs?: number;
  },
  logger: ArmadaLogger = console,
): Promise<InboundContext> {
  const runtime = api?.runtime;
  const cfg = api?.config;

  if (!runtime?.channel?.reply?.finalizeInboundContext || !runtime?.channel?.session?.resolveStorePath) {
    throw new Error('Runtime missing channel API');
  }

  const { finalizeInboundContext } = runtime.channel.reply;
  const { resolveStorePath, recordInboundSession } = runtime.channel.session;

  // Use full taskId for session key — each workflow step gets its own session/lane.
  // Previously used only first 2 dash-parts, which grouped all steps of a run on one lane.
  const short = opts.taskId;
  // When targetAgent is specified, scope the session to that agent
  const agentId = opts.targetAgent || 'main';
  // Include targetAgent in session key for multi-agent instance isolation
  const sessionKey = opts.sessionKey || (
    opts.targetAgent
      ? `agent:${opts.targetAgent}:armada:${opts.from}:${short}`
      : `armada:${opts.from}:${short}`
  );
  const chatId = opts.targetAgent ? `armada:${opts.targetAgent}:${opts.from}` : `armada:${opts.from}`;
  const storePath = resolveStorePath(cfg?.session?.store, { agentId });

  const ctxInput = {
    Body: '',
    BodyForAgent: '',
    From: chatId,
    To: chatId,
    SessionKey: sessionKey,
    ChatType: 'direct' as const,
    SenderName: opts.from,
    SenderId: opts.from,
    Provider: 'armada',
    Surface: 'armada',
    MessageSid: opts.taskId,
    OriginatingChannel: 'armada',
    OriginatingTo: chatId,
    AccountId: 'armada',
  };

  const ctx = finalizeInboundContext(ctxInput);

  await recordInboundSession({
    storePath,
    sessionKey,
    ctx,
    updateLastRoute: { sessionKey, channel: 'armada', to: chatId, accountId: 'armada' },
    onRecordError: (err: unknown) => logger.warn(`[armada-shared] Session meta error: ${String(err)}`),
  });

  const PING_WATCHDOG_MS = opts.pingWatchdogMs ?? 60_000;
  const PROGRESS_MS = opts.progressTimeoutMs ?? opts.idleTimeoutMs ?? 600_000;
  const HARD_MS = opts.hardTimeoutMs ?? 1_800_000;
  const PING_INTERVAL_MS = opts.pingIntervalMs ?? 10_000;

  const inbound: InboundContext = {
    taskId: opts.taskId,
    from: opts.from,
    callbackUrl: opts.callbackUrl,
    hooksToken: opts.hooksToken,
    instanceName: opts.instanceName,
    sessionKey,
    accumulator: [],
    pendingSubTasks: new Set(),
    idleTimeoutMs: PROGRESS_MS,
    hardTimeoutMs: HARD_MS,
    pingWatchdogMs: PING_WATCHDOG_MS,
    progressTimeoutMs: PROGRESS_MS,
    pingIntervalMs: PING_INTERVAL_MS,
    ctx,
    cfg,
    storePath,
    turnQueue: Promise.resolve(),
    finalized: false,
  };

  // Set hard timeout (absolute ceiling)
  inbound.hardTimer = setTimeout(() => {
    logger.warn(`[armada-shared] Inbound task ${opts.taskId} hard timeout (${HARD_MS}ms)`);
    finalizeInbound(inbound, `Task timed out (hard limit ${HARD_MS}ms)`, 'failed', logger);
  }, HARD_MS);
  if (inbound.hardTimer && typeof inbound.hardTimer === 'object' && 'unref' in inbound.hardTimer) {
    (inbound.hardTimer as NodeJS.Timeout).unref();
  }

  // Start process-level pings (every 10s — independent of LLM)
  // Each successful ping proves this process is alive, so reset OWN watchdog too
  if (opts.callbackUrl && opts.hooksToken && opts.instanceName) {
    inbound.pingTimer = setInterval(() => {
      resetPingWatchdog(inbound, logger);  // we're alive — reset our own watchdog
      fetch(opts.callbackUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${opts.hooksToken}` },
        body: JSON.stringify({
          type: 'ping',
          taskId: opts.taskId,
          from: opts.instanceName,
          ...(opts.targetAgent && { targetAgent: opts.targetAgent }),
          ts: Date.now(),
        }),
      }).catch(() => {});
    }, PING_INTERVAL_MS);
    if (inbound.pingTimer && typeof inbound.pingTimer === 'object' && 'unref' in inbound.pingTimer) {
      (inbound.pingTimer as NodeJS.Timeout).unref();
    }
  }

  // Start both watchdog timers
  resetPingWatchdog(inbound, logger);
  resetProgressTimer(inbound, logger);

  return inbound;
}

/** @deprecated Use resetPingWatchdog + resetProgressTimer instead */
export function resetInboundIdleTimer(inbound: InboundContext, logger: ArmadaLogger = console): void {
  // Backward compat: resets both timers (equivalent to "agent made progress")
  resetPingWatchdog(inbound, logger);
  resetProgressTimer(inbound, logger);
}

/** Reset ping watchdog — called when ANY signal arrives (ping, progress, turn output).
 *  If this timer fires, the agent process is dead/unreachable. */
export function resetPingWatchdog(inbound: InboundContext, logger: ArmadaLogger = console): void {
  if (inbound.pingWatchdogTimer) clearTimeout(inbound.pingWatchdogTimer);
  inbound.pingWatchdogTimer = setTimeout(() => {
    logger.warn(`[armada-shared] Inbound task ${inbound.taskId} ping watchdog fired — no ping for ${inbound.pingWatchdogMs}ms, agent presumed dead`);
    finalizeInbound(inbound, `Agent unresponsive (no ping for ${inbound.pingWatchdogMs / 1000}s)`, 'failed', logger);
  }, inbound.pingWatchdogMs);
  if (inbound.pingWatchdogTimer && typeof inbound.pingWatchdogTimer === 'object' && 'unref' in inbound.pingWatchdogTimer) {
    (inbound.pingWatchdogTimer as NodeJS.Timeout).unref();
  }
}

/** Reset progress timer — called when the agent produces actual work (turn output, tool calls).
 *  NOT reset by pings alone. If this timer fires, the agent is alive but stuck. */
export function resetProgressTimer(inbound: InboundContext, logger: ArmadaLogger = console): void {
  if (inbound.progressTimer) clearTimeout(inbound.progressTimer);
  inbound.progressTimer = setTimeout(() => {
    logger.warn(`[armada-shared] Inbound task ${inbound.taskId} progress timeout — no progress for ${inbound.progressTimeoutMs}ms`);
    finalizeInbound(inbound, `Agent stuck (no progress for ${inbound.progressTimeoutMs / 1000}s)`, 'failed', logger);
  }, inbound.progressTimeoutMs);
  if (inbound.progressTimer && typeof inbound.progressTimer === 'object' && 'unref' in inbound.progressTimer) {
    (inbound.progressTimer as NodeJS.Timeout).unref();
  }
}

/**
 * Fire a single agent turn in an inbound context's armada session.
 * Non-blocking — returns after the turn completes.
 * Sequenced per-context via turnQueue to prevent concurrent dispatchReplyFromConfig.
 *
 * Returns whether TASK_COMPLETE was detected in this turn's output.
 */
export function dispatchTurn(
  api: any,
  inbound: InboundContext,
  text: string,
  logger: ArmadaLogger = console,
): Promise<boolean> {
  // Chain onto turn queue for sequencing
  const turnPromise = inbound.turnQueue.then(async () => {
    if (inbound.finalized) return false;

    const runtime = api?.runtime;
    const { dispatchReplyFromConfig, createReplyDispatcherWithTyping } = runtime.channel.reply;

    let turnComplete = false;

    const { dispatcher, replyOptions, markDispatchIdle } = createReplyDispatcherWithTyping({
      deliver: async (payload: any, info: any) => {
        if (payload.isReasoning) return;
        resetInboundIdleTimer(inbound, logger);
        if (info.kind === 'final') {
          const t = payload.text?.trim();
          if (t) {
            if (t.includes('TASK_COMPLETE')) {
              const cleaned = t.replace(/\n?TASK_COMPLETE\n?/g, '').trim();
              if (cleaned) inbound.accumulator.push(cleaned);
              turnComplete = true;
              logger.info(`[armada-shared] TASK_COMPLETE in turn (${inbound.accumulator.length} msgs accumulated)`);
              // Eagerly try to finalize — don't wait for dispatchTurn to return
              if (inbound.pendingSubTasks.size === 0) {
                logger.info(`[armada-shared] Eager finalization — no pending sub-tasks`);
                finalizeInbound(inbound, undefined, undefined, logger);
              }
            } else {
              inbound.accumulator.push(t);
              logger.info(`[armada-shared] Turn output ${inbound.accumulator.length}: ${t.slice(0, 100)}`);
            }
          }
        }
      },
      typingCallbacks: {
        onReplyStart: () => resetInboundIdleTimer(inbound, logger),
        onIdle: () => {},
        onCleanup: () => {},
      },
    });

    inbound.ctx.body = text;
    inbound.ctx.Body = text;
    inbound.ctx.BodyForAgent = text + '\n\n[INSTRUCTIONS: Execute this task fully using your available tools. Do NOT narrate what you plan to do — just do it. Do NOT say TASK_COMPLETE until you have actually performed all the work and have a concrete deliverable (e.g. a PR URL, a file, a result). Planning what you will do is NOT completion. When you have genuinely finished, end your response with TASK_COMPLETE on its own line.]';
    inbound.ctx.MessageSid = generateId();

    try {
      await dispatchReplyFromConfig({ ctx: inbound.ctx, cfg: inbound.cfg, dispatcher, replyOptions });
    } finally {
      markDispatchIdle();
    }

    return turnComplete;
  });

  // Update queue
  inbound.turnQueue = turnPromise.then(() => {}).catch(() => {});
  return turnPromise;
}

/**
 * Finalize an inbound context — send callback and clean up.
 * Called when TASK_COMPLETE + no pending sub-tasks, or on timeout.
 */
export function finalizeInbound(
  inbound: InboundContext,
  resultOverride?: string,
  statusOverride?: string,
  logger: ArmadaLogger = console,
): void {
  if (inbound.finalized) return;
  inbound.finalized = true;

  // Clear timers
  if (inbound.pingWatchdogTimer) clearTimeout(inbound.pingWatchdogTimer);
  if (inbound.progressTimer) clearTimeout(inbound.progressTimer);
  if (inbound.hardTimer) clearTimeout(inbound.hardTimer);
  if (inbound.pingTimer) clearInterval(inbound.pingTimer);

  const status = statusOverride || 'completed';
  // Use only the final turn's output — earlier turns contain narration, tool calls,
  // and intermediate thinking that clutters downstream step context.
  // The final turn (where TASK_COMPLETE was emitted) contains the actual deliverable.
  const rawText = resultOverride || (
    inbound.accumulator.length === 0
      ? '(no response)'
      : inbound.accumulator[inbound.accumulator.length - 1]
  );

  // Extract {{file:...}} markers and encode as base64 attachments
  const { cleanedText: fullText, attachments } = extractFileMarkers(rawText, logger);

  logger.info(`[armada-shared] Finalizing inbound ${inbound.taskId}: ${status}, ${fullText.length} chars, ${attachments.length} attachments`);

  // Send callback
  fetch(inbound.callbackUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${inbound.hooksToken}` },
    body: JSON.stringify({
      taskId: inbound.taskId,
      from: inbound.instanceName,
      status,
      result: status === 'completed' ? fullText : undefined,
      error: status === 'failed' ? fullText : undefined,
      ...(attachments.length > 0 && { attachments }),
    }),
  }).catch((err) => logger.error(`[armada-shared] Callback failed: ${err.message}`));

  // Notify control plane (if callback registered)
  if (inbound.onFinalize) {
    try { inbound.onFinalize(inbound.taskId, status, fullText.slice(0, 1000)); } catch {}
  }

  // Remove from inbound contexts map
  const inboundContexts = getOrCreateGlobalMap<string, InboundContext>(ARMADA_INBOUND_SYM);
  inboundContexts.delete(inbound.sessionKey);
}

/**
 * Check if an inbound context should be finalized.
 * Finalizes when TASK_COMPLETE was detected in the latest turn AND no pending sub-tasks.
 */
export function maybeFinalize(inbound: InboundContext, turnComplete: boolean, logger: ArmadaLogger = console): boolean {
  // If already finalized (by eager path in deliver callback), still return true
  // so the caller knows to decrement _activeTasks
  if (inbound.finalized) return true;
  if (!turnComplete) return false;
  if (inbound.pendingSubTasks.size > 0) {
    logger.info(`[armada-shared] TASK_COMPLETE but ${inbound.pendingSubTasks.size} sub-tasks pending — deferring`);
    return false;
  }
  finalizeInbound(inbound, undefined, undefined, logger);
  return true;
}

// ── Task injection engine (used by armada-control) ───────────────────

/**
 * Inject a message into an LLM session using the OpenClaw runtime pipeline.
 * Ported from openclaw-agent-mesh's dispatchInboundTask — proven reliable.
 *
 * Used by both armada-control (coordinator sessions) and armada-agent (inbound tasks).
 *
 * Features:
 * - Session pipeline injection via dispatchReplyFromConfig
 * - Delivery accumulator captures full response
 * - Coordinator loop: if agent calls armada_task, waits for sub-task results
 * - Idle + hard timeouts with TASK_COMPLETE signal
 * - Heartbeat keepalives to callback URL during long tasks
 *
 * @param api - The OpenClaw plugin API object (needs api.runtime and api.config)
 * @param text - The message text to inject
 * @param opts - Task options (taskId, from, callbackUrl, timeouts)
 * @param logger - Logger instance
 * @returns The accumulated response text
 */
export async function injectAndWaitForResponse(
  api: any,
  text: string,
  opts: InjectOpts,
  logger: ArmadaLogger = console,
): Promise<string> {
  const runtime = api?.runtime;
  const cfg = api?.config;

  if (!runtime?.channel?.reply || !runtime?.channel?.session) {
    throw new Error('Runtime missing channel API — plugin not properly initialized');
  }

  const { finalizeInboundContext, dispatchReplyFromConfig, createReplyDispatcherWithTyping } = runtime.channel.reply;
  const { resolveStorePath, recordInboundSession } = runtime.channel.session;

  if (!finalizeInboundContext || !dispatchReplyFromConfig || !createReplyDispatcherWithTyping ||
      !resolveStorePath || !recordInboundSession) {
    throw new Error('Runtime missing required session/reply methods');
  }

  const sessionPendingTasks = getOrCreateGlobalMap<string, Set<string>>(ARMADA_PENDING_SYM);
  const coordinatorCallbacks = getOrCreateGlobalMap<string, (result: SubTaskResult) => void>(ARMADA_COORD_CB_SYM);

  // Use full taskId — each step gets its own session lane
  const short = opts.taskId;
  const sessionKey = opts.sessionKey || `armada:${opts.from}:${short}`;
  const chatId = `armada:${opts.from}`;

  const storePath = resolveStorePath(cfg?.session?.store, { agentId: 'main' });

  const ctxInput = {
    Body: text,
    BodyForAgent: text + '\n\n[INSTRUCTIONS: Execute this task fully using your available tools. Do NOT narrate what you plan to do — just do it. When you have completed the task and have the final result, end your response with TASK_COMPLETE on its own line. To attach files, use {{file:/path/to/file}} markers.]',
    From: chatId,
    To: chatId,
    SessionKey: sessionKey,
    ChatType: 'direct' as const,
    SenderName: opts.from,
    SenderId: opts.from,
    Provider: 'armada',
    Surface: 'armada',
    MessageSid: opts.taskId,
    OriginatingChannel: 'armada',
    OriginatingTo: chatId,
    AccountId: 'armada',
  };

  const ctx = finalizeInboundContext(ctxInput);

  await recordInboundSession({
    storePath,
    sessionKey,
    ctx,
    updateLastRoute: { sessionKey, channel: 'armada', to: chatId, accountId: 'armada' },
    onRecordError: (err: unknown) => logger.warn(`[armada-shared] Session meta error: ${String(err)}`),
  });

  // ── Accumulator ──────────────────────────────────────────────────

  const accumulatedTexts: string[] = [];
  let taskComplete = false;
  let resolveTaskComplete: (() => void) | null = null;
  const taskCompletePromise = new Promise<void>(resolve => { resolveTaskComplete = resolve; });

  // ── Timeouts (two-tier: ping watchdog + progress) ─────────────────

  const PING_WATCHDOG_MS = opts.pingWatchdogMs ?? 60_000;
  const PROGRESS_TIMEOUT_MS = opts.progressTimeoutMs ?? opts.idleTimeoutMs ?? 600_000;
  const HARD_TIMEOUT_MS = opts.hardTimeoutMs ?? 1_800_000;
  const PING_INTERVAL_MS = opts.pingIntervalMs ?? 10_000;
  let pingWatchdogTimer: ReturnType<typeof setTimeout> | null = null;
  let progressTimer: ReturnType<typeof setTimeout> | null = null;
  let hardTimer: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;
  let timeoutReason = '';
  let rejectTimeout: ((err: Error) => void) | null = null;

  function resetPingWatchdogLocal() {
    if (pingWatchdogTimer) clearTimeout(pingWatchdogTimer);
    pingWatchdogTimer = setTimeout(() => {
      timedOut = true;
      timeoutReason = `no ping for ${PING_WATCHDOG_MS}ms — agent presumed dead`;
      rejectTimeout?.(new Error(`Agent unresponsive: no ping for ${PING_WATCHDOG_MS}ms`));
    }, PING_WATCHDOG_MS);
    if (pingWatchdogTimer && typeof pingWatchdogTimer === 'object' && 'unref' in pingWatchdogTimer) {
      (pingWatchdogTimer as NodeJS.Timeout).unref();
    }
  }

  function resetProgressTimerLocal() {
    if (progressTimer) clearTimeout(progressTimer);
    progressTimer = setTimeout(() => {
      timedOut = true;
      timeoutReason = `no progress for ${PROGRESS_TIMEOUT_MS}ms`;
      rejectTimeout?.(new Error(`Agent stuck: no progress for ${PROGRESS_TIMEOUT_MS}ms`));
    }, PROGRESS_TIMEOUT_MS);
    if (progressTimer && typeof progressTimer === 'object' && 'unref' in progressTimer) {
      (progressTimer as NodeJS.Timeout).unref();
    }
  }

  /** Reset both timers — called on actual progress (turn output) */
  function resetIdleTimer() {
    resetPingWatchdogLocal();
    resetProgressTimerLocal();
  }

  function clearTimers() {
    if (pingWatchdogTimer) { clearTimeout(pingWatchdogTimer); pingWatchdogTimer = null; }
    if (progressTimer) { clearTimeout(progressTimer); progressTimer = null; }
    if (hardTimer) { clearTimeout(hardTimer); hardTimer = null; }
  }

  resetPingWatchdogLocal();
  resetProgressTimerLocal();
  hardTimer = setTimeout(() => {
    timedOut = true;
    timeoutReason = `hard limit ${HARD_TIMEOUT_MS}ms`;
    rejectTimeout?.(new Error(`Task hard timeout after ${HARD_TIMEOUT_MS}ms`));
  }, HARD_TIMEOUT_MS);
  if (hardTimer && typeof hardTimer === 'object' && 'unref' in hardTimer) {
    (hardTimer as NodeJS.Timeout).unref();
  }

  // ── Dispatcher (captures agent output) ───────────────────────────

  const { dispatcher, replyOptions, markDispatchIdle } = createReplyDispatcherWithTyping({
    deliver: async (payload: any, info: any) => {
      if (payload.isReasoning) return;
      resetIdleTimer();
      if (info.kind === 'final') {
        const t = payload.text?.trim();
        if (t) {
          if (t.includes('TASK_COMPLETE')) {
            const cleaned = t.replace(/\n?TASK_COMPLETE\n?/g, '').trim();
            if (cleaned) accumulatedTexts.push(cleaned);
            taskComplete = true;
            logger.info(`[armada-shared] TASK_COMPLETE signal received (${accumulatedTexts.length} messages)`);
            resolveTaskComplete?.();
          } else {
            accumulatedTexts.push(t);
            logger.info(`[armada-shared] Accumulated message ${accumulatedTexts.length}: ${t.slice(0, 100)}`);
          }
        }
      }
    },
    typingCallbacks: {
      onReplyStart: () => { resetIdleTimer(); },
      onIdle: () => {},
      onCleanup: () => {},
    },
  });

  // ── Process-level pings (10s — independent of LLM) ────────────────

  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  if (opts.callbackUrl && opts.hooksToken && opts.instanceName) {
    heartbeatTimer = setInterval(() => {
      resetPingWatchdogLocal();  // we're alive — reset our own watchdog
      fetch(opts.callbackUrl!, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${opts.hooksToken}`,
        },
        body: JSON.stringify({
          type: 'ping',
          taskId: opts.taskId,
          from: opts.instanceName,
          ts: Date.now(),
        }),
      }).catch(() => {}); // fire and forget
    }, PING_INTERVAL_MS);
    if (heartbeatTimer && typeof heartbeatTimer === 'object' && 'unref' in heartbeatTimer) {
      (heartbeatTimer as NodeJS.Timeout).unref();
    }
  }

  // ── Run agent turn + coordinator loop ────────────────────────────

  try {
    // Phase 1: Initial agent turn
    await Promise.race([
      dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyOptions }),
      new Promise<never>((_, reject) => { rejectTimeout = reject; }),
    ]);

    // Check for pending sub-tasks BEFORE waiting for TASK_COMPLETE.
    // If the agent called armada_task during its turn and responded without
    // TASK_COMPLETE, we need to enter coordinator mode immediately — otherwise
    // sub-task results arrive and hit "No coordinator" because we're still
    // blocked waiting for TASK_COMPLETE.
    let pendingCount = sessionPendingTasks.get(sessionKey)?.size ?? 0;

    if (!taskComplete && pendingCount === 0) {
      // No sub-tasks — wait for TASK_COMPLETE normally
      logger.info(`[armada-shared] Waiting for TASK_COMPLETE signal...`);
      await Promise.race([
        taskCompletePromise,
        new Promise<void>(resolve => setTimeout(resolve, PROGRESS_TIMEOUT_MS)),
        new Promise<never>((_, reject) => { rejectTimeout = reject; }),
      ]);
    } else if (!taskComplete && pendingCount > 0) {
      logger.info(`[armada-shared] Skipping TASK_COMPLETE wait — ${pendingCount} sub-tasks pending`);
    }

    if (pendingCount > 0) {
      logger.info(`[armada-shared] Session ${sessionKey} has ${pendingCount} pending sub-tasks — entering coordinator mode`);
      // Cancel hard timeout for coordinators — idle timer is the safety net
      if (hardTimer) { clearTimeout(hardTimer); hardTimer = null; }
    }

    // Queue for results that arrive while the agent turn is running.
    // The callback stays registered the entire time — results are buffered
    // so nothing gets dropped between dispatchReplyFromConfig iterations.
    const resultQueue: SubTaskResult[] = [];
    let resolveWait: ((result: SubTaskResult | null) => void) | null = null;

    coordinatorCallbacks.set(sessionKey, (result) => {
      if (resolveWait) {
        const r = resolveWait;
        resolveWait = null;
        r(result);
      } else {
        resultQueue.push(result);
      }
    });

    while (pendingCount > 0 && !timedOut) {
      // Drain queue first, then wait for new results
      const subResult = resultQueue.length > 0
        ? resultQueue.shift()!
        : await new Promise<SubTaskResult | null>((resolve) => {
            resolveWait = resolve;

            const interval = setInterval(() => {
              if (timedOut) {
                resolveWait = null;
                clearInterval(interval);
                resolve(null);
              }
            }, 500);

            const origResolve = resolve;
            resolve = (val) => { clearInterval(interval); origResolve(val); };
          });

      if (!subResult || timedOut) break;

      resetIdleTimer();

      if (subResult._isProgress) {
        logger.info(`[armada-shared] Coordinator ${sessionKey}: progress ping from ${subResult.from}`);
        continue;
      }

      logger.info(`[armada-shared] Coordinator ${sessionKey}: injecting result from ${subResult.from} (task ${subResult.taskId})`);

      const resultMessage = [
        `## Task Result from ${subResult.from}`,
        `Task ID: ${subResult.taskId}`,
        subResult.error ? `Error: ${subResult.error}` : `Result:\n${subResult.text}`,
        `\n[INSTRUCTIONS: Before returning this result or delegating the next task, VERIFY the deliverable matches the original request. Use \`image\` to check images, \`Read\` to check files. If the result is wrong (e.g. wrong image, broken output), re-delegate with clearer instructions. If verified or not applicable, continue — use armada_task for the next step, or provide your final answer with TASK_COMPLETE if all steps are complete.]`,
      ].join('\n');

      ctx.body = resultMessage;
      ctx.Body = resultMessage;
      ctx.BodyForAgent = resultMessage;
      ctx.MessageSid = subResult.taskId;

      await Promise.race([
        dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyOptions }),
        new Promise<never>((_, reject) => { rejectTimeout = reject; }),
      ]);

      pendingCount = sessionPendingTasks.get(sessionKey)?.size ?? 0;
      logger.info(`[armada-shared] Coordinator ${sessionKey}: ${pendingCount} sub-tasks remaining`);
    }
  } catch (err: any) {
    if (timedOut) {
      logger.warn(`[armada-shared] Task ${opts.taskId} timed out (${timeoutReason})`);
      return `Task timed out (${timeoutReason})`;
    }
    throw err;
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    coordinatorCallbacks.delete(sessionKey);
    clearTimers();
    markDispatchIdle();
  }

  // ── Return accumulated response ──────────────────────────────────

  const fullText = accumulatedTexts.length <= 1
    ? (accumulatedTexts[0] || '')
    : accumulatedTexts.join('\n\n---\n\n');

  logger.info(`[armada-shared] Task ${opts.taskId} complete: ${accumulatedTexts.length} messages, ${fullText.length} chars`);
  return fullText;
}
