/**
 * armada-agent — Armada communication plugin for managed OpenClaw instances.
 *
 * Event-driven architecture:
 * - Inbound tasks create an InboundContext, fire a dispatchTurn, return immediately
 * - Outbound armada_task calls create OutboundTask entries, return immediately
 * - Results arriving at /armada/result trigger new dispatchTurn calls or inject via agent RPC
 * - Finalization (callback) happens when TASK_COMPLETE + no pending sub-tasks
 *
 * No blocking loops. Each event fires a turn and returns.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { AsyncLocalStorage } from 'node:async_hooks';
import { writeFileSync, readFileSync, renameSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import {
  generateId,
  readBody,
  sendJson,
  getOrCreateGlobalMap,
  decodeAttachments,
  decodeAttachmentsAsMarkers,
  dispatchArmadaTask,
  callGatewayRpc,
  createInboundContext,
  dispatchTurn,
  finalizeInbound,
  maybeFinalize,
  resetInboundIdleTimer,
  resetPingWatchdog,
  serializeTaskMap,
  deserializeTaskMap,
  TASK_STALE_MS,
  ARMADA_OUTBOUND_SYM,
  ARMADA_INBOUND_SYM,
  type OutboundTask,
  type InboundContext,
  type ArmadaLogger,
} from '@coderage-labs/armada-plugin-shared';

// ── Types ───────────────────────────────────────────────────────────

interface ArmadaConfig {
  org: string;
  instanceName: string;
  role: string;
  hooksToken: string;
  /** @deprecated Use progressTimeoutMs */
  idleTimeoutMs?: number;
  progressTimeoutMs?: number;
  pingWatchdogMs?: number;
  hardTimeoutMs?: number;
  /** @deprecated Instances must ONLY communicate via proxyUrl (node agent relay). Direct control plane access is not supported. */
  armadaApiUrl?: string;
  armadaApiToken?: string;
  /** Node agent proxy URL — ALL control plane communication MUST go through this relay */
  proxyUrl?: string;
  projects?: string[];
}

/**
 * Get the base URL for armada API calls.
 * MUST use proxyUrl (node agent gateway proxy) — direct control plane access is not supported.
 * All instance→control communication is routed through the node agent relay.
 */
function getApiBaseUrl(): string {
  return _config?.proxyUrl || '';
}

// ── Usage reporting to control plane ────────────────────────────────

/**
 * Report token usage to the control plane after each agent turn.
 * Fire-and-forget — failures never block the agent.
 */
function pushUsage(context: any): void {
  if (!_config?.armadaApiToken) return;
  const url = `${getApiBaseUrl()}/api/internal/usage`;
  const inputTokens  = context?.inputTokens  ?? context?.usage?.inputTokens  ?? 0;
  const outputTokens = context?.outputTokens ?? context?.usage?.outputTokens ?? 0;
  const totalTokens  = context?.totalTokens  ?? context?.usage?.totalTokens  ?? (inputTokens + outputTokens);
  const costUsd      = context?.costUsd      ?? context?.usage?.costUsd      ?? 0;
  const modelId      = context?.model        ?? context?.modelId             ?? null;
  const sessionKey   = context?.sessionKey   ?? null;
  const agentId      = _config?.instanceName ?? null;

  // Skip if there's nothing to report
  if (!inputTokens && !outputTokens && !totalTokens) return;

  fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${_config!.armadaApiToken}`,
    },
    body: JSON.stringify({
      agentId,
      instanceId: _config?.instanceName ?? null,
      modelId,
      inputTokens,
      outputTokens,
      totalTokens,
      costUsd,
      sessionKey,
    }),
  }).catch((err: any) => {
    _logger.warn(`[armada-agent] Failed to push usage: ${err.message}`);
  });
}

// ── Session event push to control plane ─────────────────────────────

/**
 * Push a session activity event to the control plane.
 * Fire-and-forget — failures are logged at debug level and don't block.
 */
function pushSessionEvent(sessionKey: string, event: 'turn_start' | 'turn_complete' | 'tool_call') {
  if (!_config?.instanceName) return;
  const url = `${getApiBaseUrl()}/api/internal/session-event`;
  fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(_config.armadaApiToken ? { 'Authorization': `Bearer ${_config.armadaApiToken}` } : {}),
    },
    body: JSON.stringify({
      instanceName: _config.instanceName,
      sessionKey,
      event,
      timestamp: Date.now(),
    }),
  }).catch((err: any) => {
    _logger.warn(`[armada-agent] Failed to push session event: ${err.message}`);
  });
}

// ── Task reporting to control plane ─────────────────────────────────

/**
 * Report a task event to the armada control plane API.
 * Fire-and-forget — failures are logged but don't block.
 */
async function reportTask(action: 'create' | 'update', data: Record<string, any>): Promise<void> {
  if (!_config || !getApiBaseUrl()) return;
  try {
    const url = action === 'create'
      ? `${getApiBaseUrl()}/api/tasks`
      : `${getApiBaseUrl()}/api/tasks/${encodeURIComponent(data.id)}`;
    const method = action === 'create' ? 'POST' : 'PUT';
    await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ..._config.armadaApiToken ? { 'Authorization': `Bearer ${_config.armadaApiToken}` } : {},
      },
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(5_000),
    });
  } catch (err: any) {
    _logger.warn(`[armada-agent] Failed to report task: ${err.message}`);
  }
}

// ── State (globalThis to survive jiti re-evaluation) ────────────────

const outboundTasks = getOrCreateGlobalMap<string, OutboundTask>(ARMADA_OUTBOUND_SYM);
const inboundContexts = getOrCreateGlobalMap<string, InboundContext>(ARMADA_INBOUND_SYM);

let _config: ArmadaConfig | null = null;
let _draining = false;
let _activeTasks = 0;
let _api: any = null;
let _logger: ArmadaLogger = console;

// ── Task persistence ────────────────────────────────────────────────

const _dataDir = join(process.env.HOME || '/home/node', '.openclaw');
const _tasksFilePath = join(_dataDir, 'armada-agent-tasks.json');
const _bootTime = Date.now();

/** Serializable subset of InboundContext for persistence */
interface PersistedInboundContext {
  sessionKey: string;
  callbackUrl: string;
  callbackToken: string;
  taskId: string;
  startedAt: number;
}

/** Atomically save outbound tasks and inbound contexts to disk */
function saveAgentTasks(): void {
  try {
    mkdirSync(_dataDir, { recursive: true });

    // Serialize outbound tasks (already simple data)
    const outboundData = new Map<string, any>();
    for (const [id, task] of outboundTasks) {
      outboundData.set(id, {
        taskId: task.taskId,
        target: task.target,
        sessionKey: task.sessionKey,
        sentAt: Date.now(),
      });
    }

    // Serialize inbound contexts (only persistable fields)
    const inboundData = new Map<string, any>();
    for (const [key, ctx] of inboundContexts) {
      inboundData.set(key, {
        sessionKey: ctx.sessionKey,
        callbackUrl: ctx.callbackUrl,
        callbackToken: ctx.hooksToken,
        taskId: ctx.taskId,
        startedAt: Date.now(),
      });
    }

    const data = JSON.stringify({
      outbound: JSON.parse(serializeTaskMap(outboundData)),
      inbound: JSON.parse(serializeTaskMap(inboundData)),
    }, null, 2);

    const tmpPath = _tasksFilePath + '.tmp';
    writeFileSync(tmpPath, data, 'utf-8');
    renameSync(tmpPath, _tasksFilePath);
  } catch (err: any) {
    _logger.warn(`[armada-agent] Failed to save tasks: ${err.message}`);
  }
}

/** Load persisted tasks from disk and send error callbacks for restored inbound contexts */
function loadAgentTasks(): void {
  try {
    if (!existsSync(_tasksFilePath)) return;
    const raw = readFileSync(_tasksFilePath, 'utf-8');
    const data = JSON.parse(raw);

    // Restore outbound tasks
    if (data.outbound) {
      const restored = deserializeTaskMap(JSON.stringify(data.outbound));
      let count = 0;
      for (const [id, task] of restored) {
        outboundTasks.set(id, {
          taskId: task.taskId,
          target: task.target,
          sessionKey: task.sessionKey,
        });
        count++;
      }
      if (count > 0) _logger.info(`[armada-agent] Restored ${count} outbound tasks from disk`);
    }

    // Restore inbound contexts — send error callbacks since we can't resume them
    if (data.inbound) {
      const restored = deserializeTaskMap(JSON.stringify(data.inbound));
      let count = 0;
      for (const [, ctx] of restored) {
        // Skip tasks that arrived after this boot — they're not restart leftovers
        if (ctx.startedAt && ctx.startedAt >= _bootTime) continue;
        if (ctx.callbackUrl) {
          _logger.info(`[armada-agent] Sending restart error callback for inbound task ${ctx.taskId}`);
          fetch(ctx.callbackUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${ctx.callbackToken || ''}`,
            },
            body: JSON.stringify({
              taskId: ctx.taskId,
              from: _config?.instanceName || 'unknown',
              status: 'failed',
              error: 'Task lost due to agent restart. Please retry.',
            }),
          }).catch((err: any) => {
            _logger.warn(`[armada-agent] Failed to send restart callback for ${ctx.taskId}: ${err.message}`);
          });
          count++;
        }
      }
      if (count > 0) _logger.info(`[armada-agent] Sent ${count} restart error callbacks for inbound tasks`);
    }

    // Clear the file after processing to prevent re-firing on next restart
    try {
      unlinkSync(_tasksFilePath);
    } catch {}
  } catch (err: any) {
    _logger.warn(`[armada-agent] Failed to load tasks: ${err.message}`);
  }
}

/** Remove stale outbound tasks (>2h old) on startup */
function cleanupStaleAgentTasks(): void {
  const now = Date.now();
  let removed = 0;
  for (const [id, task] of outboundTasks) {
    const sentAt = (task as any).sentAt;
    if (sentAt && now - sentAt > TASK_STALE_MS) {
      outboundTasks.delete(id);
      removed++;
    }
  }
  if (removed > 0) {
    _logger.info(`[armada-agent] Cleaned up ${removed} stale outbound tasks (>2h old)`);
    saveAgentTasks();
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

// ── Dynamic Armada Tool Loading ──────────────────────────────────────

// Tool names that are already registered natively (skip if returned by API)
const NATIVE_TOOLS = new Set(['armada_task', 'armada_status']);

interface ArmadaToolDef {
  name: string;
  description: string;
  method: string;
  path: string;
  parameters: Array<{ name: string; type: string; description: string; required?: boolean }>;
}

/**
 * Build Authorization headers for tool-related API calls.
 * All communication is routed via the node agent relay (proxyUrl).
 * The proxy handles control-plane auth; instances authenticate using armadaApiToken.
 */
function getToolAuthHeaders(): Record<string, string> {
  if (!_config) return {};
  const token = _config.armadaApiToken || _config.hooksToken;
  return token ? { 'Authorization': `Bearer ${token}` } : {};
}

async function loadarmadaTools(api: any) {
  // Require proxyUrl — all control plane communication must go through the node agent relay
  if (!_config || !getApiBaseUrl()) return;

  try {
    const resp = await fetch(`${getApiBaseUrl()}/api/meta/tools`, {
      headers: {
        ...getToolAuthHeaders(),
        'X-Agent-Name': _config.instanceName,
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) {
      _logger.warn(`[armada-agent] Failed to fetch armada tools: ${resp.status}`);
      return;
    }

    const tools = (await resp.json()) as ArmadaToolDef[];
    let registered = 0;

    for (const def of tools) {
      if (NATIVE_TOOLS.has(def.name)) continue; // Already registered natively

      // Convert tool def parameters to JSON Schema for registerTool
      const properties: Record<string, any> = {};
      const required: string[] = [];
      for (const p of def.parameters) {
        properties[p.name] = { type: p.type, description: p.description };
        if (p.required) required.push(p.name);
      }

      api.registerTool({
        name: def.name,
        description: def.description,
        parameters: { type: 'object', properties, ...(required.length > 0 ? { required } : {}) },
        execute: async (_id: string, args: Record<string, any>) => {
          return executearmadaTool(def, args);
        },
      });
      registered++;
    }

    _logger.info(`[armada-agent] Loaded ${registered} armada tools from control plane`);
  } catch (err: any) {
    _logger.warn(`[armada-agent] Error loading armada tools: ${err.message}`);
  }
}

async function executearmadaTool(def: ArmadaToolDef, args: Record<string, any>): Promise<any> {
  // Require proxyUrl — all control plane communication must go through the node agent relay
  if (!_config || !getApiBaseUrl()) {
    return { error: 'Armada proxy not configured — instances must communicate via node agent relay (proxyUrl)' };
  }

  // Resolve path params
  let resolvedPath = def.path;
  const pathParams = new Set<string>();
  const pathParamRegex = /:(\w+)/g;
  let match;
  while ((match = pathParamRegex.exec(def.path)) !== null) {
    const paramName = match[1];
    const value = args[paramName] ?? args.target;
    if (!value) return { error: `Missing parameter: ${paramName}` };
    resolvedPath = resolvedPath.replace(`:${paramName}`, encodeURIComponent(value));
    pathParams.add(paramName);
  }
  pathParams.add('target');

  const url = `${getApiBaseUrl()}${resolvedPath}`;
  const headers: Record<string, string> = {
    ...getToolAuthHeaders(),
    'X-Agent-Name': _config.instanceName,
  };

  try {
    if (def.method === 'GET') {
      const queryParams: string[] = [];
      for (const p of def.parameters) {
        if (args[p.name] !== undefined && !pathParams.has(p.name)) {
          queryParams.push(`${p.name}=${encodeURIComponent(args[p.name])}`);
        }
      }
      const queryStr = queryParams.length > 0 ? `?${queryParams.join('&')}` : '';
      const resp = await fetch(`${url}${queryStr}`, { headers, signal: AbortSignal.timeout(30_000) });
      if (!resp.ok) return { error: `Armada API ${resp.status}: ${await resp.text().catch(() => '')}` };
      return resp.json().catch(() => ({ status: 'ok' }));
    }

    // POST/PUT/DELETE
    const body: Record<string, any> = {};
    for (const p of def.parameters) {
      if (args[p.name] !== undefined && !pathParams.has(p.name)) {
        body[p.name] = args[p.name];
      }
    }

    const resp = await fetch(url, {
      method: def.method,
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: Object.keys(body).length > 0 ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60_000),
    });

    if (!resp.ok) return { error: `Armada API ${resp.status}: ${await resp.text().catch(() => '')}` };
    const text = await resp.text();
    try { return JSON.parse(text); } catch { return { status: 'ok' }; }
  } catch (err: any) {
    return { error: `Armada API request failed: ${err.message}` };
  }
}

// ── Plugin Entry ────────────────────────────────────────────────────

export default function register(api: any) {
  _api = api;
  _logger = api.logger ?? console;

  const pluginConfig = api.pluginConfig || api.config?.plugins?.entries?.['armada-agent']?.config || {};
  _config = {
    org: pluginConfig.org || 'default',
    instanceName: pluginConfig.instanceName || 'unknown',
    role: pluginConfig.role || 'general',
    hooksToken: pluginConfig.hooksToken || pluginConfig.armadaApiToken || '',
    progressTimeoutMs: pluginConfig.progressTimeoutMs ?? pluginConfig.idleTimeoutMs ?? 600_000,
    pingWatchdogMs: pluginConfig.pingWatchdogMs ?? 60_000,
    hardTimeoutMs: pluginConfig.hardTimeoutMs ?? 1_800_000,
    armadaApiUrl: pluginConfig.armadaApiUrl || '',
    armadaApiToken: pluginConfig.armadaApiToken || '',
    proxyUrl: pluginConfig.proxyUrl || '',
    projects: pluginConfig.projects || [],
  };

  _logger.info(`[armada-agent] ${_config.instanceName} (${_config.role}) — control-plane routing enabled`);

  // ── AsyncLocalStorage for session key propagation ───────────────
  // Solves the concurrent inbound task problem: when multiple sessions
  // are active simultaneously, tool handlers need to know which session
  // invoked them. ALS propagates the session key through the async chain
  // from beforeAgentTurn → tool execution without global state races.
  const turnSessionStore = new AsyncLocalStorage<string>();

  if (typeof api.registerHook === 'function') {
    api.registerHook('beforeAgentTurn', (context: any) => {
      pushSessionEvent(context?.sessionKey ?? 'unknown', 'turn_start');
      if (context?.sessionKey) {
        turnSessionStore.enterWith(context.sessionKey);
      }
      // Reset idle timer — agent is taking a turn
      for (const inbound of inboundContexts.values()) {
        if (!inbound.finalized) resetInboundIdleTimer(inbound, _logger);
      }
    }, { name: 'armada-agent-session-tracker' });

    api.registerHook('beforeToolCall', (context: any) => {
      pushSessionEvent(context?.sessionKey ?? 'unknown', 'tool_call');
      // Reset idle timer — agent is calling a tool (may be long-running like npm install)
      for (const inbound of inboundContexts.values()) {
        if (!inbound.finalized) resetInboundIdleTimer(inbound, _logger);
      }
    }, { name: 'armada-agent-tool-progress' });

    api.registerHook('afterAgentTurn', (context: any) => {
      pushUsage(context);
    }, { name: 'armada-agent-usage-tracker' });

    _logger.info('[armada-agent] Registered beforeAgentTurn + beforeToolCall + afterAgentTurn hooks');
  } else {
    _logger.warn('[armada-agent] registerHook not available — session key propagation disabled');
  }

  // ── Tool: armada_task ────────────────────────────────────────────

  api.registerTool({
    name: 'armada_task',
    description: 'Send an async task to a agent. Results are delivered automatically when complete. Use this to delegate work to other agents in your armada.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Agent name to send the task to' },
        message: { type: 'string', description: 'Task message/instructions' },
        project: { type: 'string', description: 'Project name for context injection (optional)' },
      },
      required: ['target', 'message'],
    },
    execute: async (_id: string, args: { target: string; message: string; project?: string }, context: any) => {
      if (_draining) return { error: 'Instance is draining — not accepting new outbound tasks' };
      if (!getApiBaseUrl() || !_config?.hooksToken) {
        return { error: 'Armada API not configured' };
      }

      const taskId = generateId();

      // Resolve session key: prefer context, then ALS (from beforeAgentTurn hook), then fallback
      let sessionKey = context?.sessionKey || turnSessionStore.getStore();
      if (!sessionKey) {
        // Final fallback: if there's exactly one inbound context, use it
        if (inboundContexts.size === 1) {
          sessionKey = [...inboundContexts.keys()][0];
        } else if (inboundContexts.size > 1) {
          _logger.warn(`[armada-agent] armada_task called without context.sessionKey or ALS, and ${inboundContexts.size} active inbound contexts — picking first`);
          sessionKey = [...inboundContexts.keys()][0]; // best effort
        } else {
          sessionKey = 'unknown';
        }
      }

      // Track outbound
      outboundTasks.set(taskId, { taskId, sessionKey, target: args.target });
      saveAgentTasks();

      // If there's an inbound context for this session, add to its pending sub-tasks
      const inbound = inboundContexts.get(sessionKey);
      if (inbound) {
        inbound.pendingSubTasks.add(taskId);
        _logger.info(`[armada-agent] Outbound ${taskId} to ${args.target} tracked as sub-task of inbound ${inbound.taskId}`);
      }

      // Send via control plane API
      try {
        const res = await fetch(`${getApiBaseUrl()}/api/tasks`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${_config!.hooksToken}`,
          },
          body: JSON.stringify({
            id: taskId,
            fromAgent: _config!.instanceName,
            toAgent: args.target,
            taskText: args.message,
            status: 'pending',
            ...(args.project ? { projectId: args.project } : {}),
          }),
          signal: AbortSignal.timeout(10_000),
        });

        if (!res.ok) {
          const errorText = await res.text().catch(() => 'unknown error');
          outboundTasks.delete(taskId);
          saveAgentTasks();
          if (inbound) inbound.pendingSubTasks.delete(taskId);
          return { error: `Failed to send task to ${args.target}: ${res.status} ${errorText}` };
        }

        _logger.info(`[armada-agent] Task ${taskId} sent to ${args.target} (session: ${sessionKey})`);
        return { taskId, target: args.target, status: 'sent', message: `Task sent to ${args.target}. Result will be delivered when complete.` };
      } catch (err: any) {
        outboundTasks.delete(taskId);
        saveAgentTasks();
        if (inbound) inbound.pendingSubTasks.delete(taskId);
        return { error: `Failed to send task to ${args.target}: ${err.message}` };
      }
    },
  });

  // ── Tool: armada_status ──────────────────────────────────────────

  api.registerTool({
    name: 'armada_status',
    description: 'Check the status of armada instances.',
    parameters: { type: 'object', properties: {} },
    execute: async () => ({
      instanceName: _config!.instanceName,
      role: _config!.role,
      status: _draining ? 'draining' : (_activeTasks > 0 ? 'busy' : 'idle'),
      activeTasks: _activeTasks,
      inboundContexts: inboundContexts.size,
      outboundPending: outboundTasks.size,
      armadaApiUrl: getApiBaseUrl(),
    }),
  });

  // ── Dynamic tool loading from armada control ────────────────────
  // Fetch tool definitions from /api/meta/tools, filtered by role.
  // These are proxy tools (issue tracker, etc.) that agents use
  // without seeing credentials.
  //
  // All calls are routed through the node agent relay (proxyUrl).

  if (getApiBaseUrl()) {
    loadarmadaTools(api).catch(err => {
      _logger.warn(`[armada-agent] Failed to load armada tools: ${err.message}`);
    });
  }

  // ── HTTP Routes ─────────────────────────────────────────────────

  if (typeof api.registerHttpRoute !== 'function') {
    _logger.warn('[armada-agent] registerHttpRoute not available — HTTP endpoints disabled');
    return;
  }

  // ── HTTP: Receive task ──────────────────────────────────────────

  api.registerHttpRoute({
    auth: 'plugin',
    path: '/armada/task',
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      const body = await readBody(req);
      const { taskId, from, fromRole, message, callbackUrl, attachments, project, targetAgent } = body;

      if (!taskId || !from || !message || !callbackUrl) {
        return sendJson(res, 400, { error: 'Missing required fields: taskId, from, message, callbackUrl' });
      }

      if (_draining) return sendJson(res, 503, { error: 'Instance is draining' });

      _activeTasks++;
      _logger.info(`[armada-agent] Received task ${taskId} from ${from}${targetAgent ? ` (targetAgent: ${targetAgent})` : ''}: ${message.slice(0, 100)}`);

      // Report task received to control plane
      reportTask('create', {
        id: taskId,
        fromAgent: from,
        toAgent: targetAgent || _config!.instanceName,
        taskText: message.slice(0, 5000),
        status: 'running',
        ...(project ? { projectId: project } : {}),
      });

      // Decode any attached files to local filesystem
      const attachmentNote = decodeAttachments(attachments, _logger);

      // Acknowledge receipt immediately
      sendJson(res, 200, { status: 'accepted', taskId });

      // Create inbound context (non-blocking)
      // When targetAgent is specified, the context is scoped to that agent's session
      try {
        const inbound = await createInboundContext(_api, {
          taskId,
          from,
          callbackUrl,
          hooksToken: _config!.hooksToken,
          instanceName: _config!.instanceName,
          targetAgent,
          progressTimeoutMs: _config!.progressTimeoutMs,
          pingWatchdogMs: _config!.pingWatchdogMs,
          hardTimeoutMs: _config!.hardTimeoutMs,
        }, _logger);

        // Report status changes back to control plane
        inbound.onFinalize = (taskId, status, result) => {
          reportTask('update', { id: taskId, status, result });
        };

        inboundContexts.set(inbound.sessionKey, inbound);
        saveAgentTasks();

        // Fetch project context if a project is specified
        let projectContext = '';
        const projectName = project || body.group;
        if (projectName && getApiBaseUrl()) {
          try {
            const projResp = await fetch(
              `${getApiBaseUrl()}/api/projects/${encodeURIComponent(projectName)}/context`,
              {
                headers: {
                  ..._config?.armadaApiToken ? { 'Authorization': `Bearer ${_config.armadaApiToken}` } : {},
                },
                signal: AbortSignal.timeout(5_000),
              },
            );
            if (projResp.ok) {
              const contextMd = await projResp.text();
              if (contextMd.trim()) {
                projectContext = `## Project: ${projectName}\n${contextMd}\n\n---\n\n`;
              }
            }
          } catch (err: any) {
            _logger.warn(`[armada-agent] Failed to fetch project context for "${projectName}": ${err.message}`);
          }
        }

        // Report running status to control plane
        reportTask('update', { id: taskId, status: 'running' });

        // Resolve {{shared:ref:filename}} markers — download files to workspace
        let resolvedMessage = message;
        const sharedPattern = /\{\{shared:([^:}]+):([^}]+)\}\}/g;
        let sharedMatch;
        while ((sharedMatch = sharedPattern.exec(message)) !== null) {
          const [fullMatch, ref, filename] = sharedMatch;
          if (getApiBaseUrl()) {
            try {
              const deliverResp = await fetch(`${getApiBaseUrl()}/api/files/deliver`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  ...(_config?.armadaApiToken ? { 'Authorization': `Bearer ${_config.armadaApiToken}` } : {}),
                },
                body: JSON.stringify({ ref, toAgent: _config?.instanceName }),
                signal: AbortSignal.timeout(15_000),
              });
              const deliverData = await deliverResp.json();
              if (deliverResp.ok && deliverData.containerPath) {
                resolvedMessage = resolvedMessage.replace(fullMatch, `${filename} (downloaded to ${deliverData.containerPath})`);
                _logger.info(`[armada-agent] Resolved shared file ${ref} → ${deliverData.containerPath}`);
              } else {
                _logger.warn(`[armada-agent] Failed to deliver shared file ${ref}: ${deliverData.error || 'unknown'}`);
              }
            } catch (err: any) {
              _logger.warn(`[armada-agent] Failed to resolve shared file ${ref}: ${err.message}`);
            }
          }
        }

        // Fire first turn — non-blocking
        const taskMessage = `${projectContext}[Armada Task from ${from}] ${resolvedMessage}${attachmentNote}\n\n[To attach files in your reply, use {{file:/path/to/file}} markers. They will be transferred automatically.]`;
        const taskComplete = await dispatchTurn(_api, inbound, taskMessage, _logger);
        pushSessionEvent(inbound.sessionKey, 'turn_complete');

        // Check if done (simple task, no delegation)
        if (maybeFinalize(inbound, taskComplete, _logger)) {
          _activeTasks--;
          reportTask('update', { id: taskId, status: 'completed', result: inbound.accumulator.join('\n').slice(0, 5000) });
          saveAgentTasks();
        }
        // If not finalized, we return and wait for events (result callbacks, timeouts)
      } catch (err: any) {
        _logger.error(`[armada-agent] Task ${taskId} failed during setup: ${err.message}`);
        _activeTasks--;
        // Send error callback
        try {
          await fetch(callbackUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${_config!.hooksToken}` },
            body: JSON.stringify({ taskId, from: _config!.instanceName, status: 'failed', error: err.message }),
          });
        } catch { /* best effort */ }
      }
    },
  });

  // ── HTTP: Receive result (callback from remote agent) ───────────

  api.registerHttpRoute({
    auth: 'plugin',
    path: '/armada/result',
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      const body = await readBody(req);
      const { taskId, from, result, status, error, progress } = body;

      if (!taskId || !from) return sendJson(res, 400, { error: 'Missing required fields: taskId, from' });
      sendJson(res, 200, { status: 'received' });

      // Find the outbound task
      const outbound = outboundTasks.get(taskId);

      // ── Process ping (agent alive but no LLM progress) ──
      if (body.type === 'ping') {
        if (outbound) {
          const inbound = inboundContexts.get(outbound.sessionKey);
          if (inbound) resetPingWatchdog(inbound, _logger);  // alive, but don't reset progress timer
        }
        return;
      }

      // ── Progress update (tool output, working status) ──
      if (status === 'working' || progress) {
        if (outbound) {
          const inbound = inboundContexts.get(outbound.sessionKey);
          if (inbound) resetInboundIdleTimer(inbound, _logger);  // real progress — reset both timers
        }
        return;
      }

      // ── Final result ──
      if (!outbound) {
        _logger.warn(`[armada-agent] Received result for unknown task ${taskId}`);
        return;
      }

      outboundTasks.delete(taskId);
      saveAgentTasks();
      _logger.info(`[armada-agent] Result for ${taskId} from ${from}: ${status}`);

      // Report result to control plane
      reportTask('update', {
        id: taskId,
        status: status === 'failed' ? 'failed' : 'completed',
        result: (result || '').slice(0, 5000),
      });

      // Decode attachments as {{file:...}} markers — when this context finalizes,
      // extractFileMarkers will re-encode them for forwarding up the chain
      const attachmentMarkers = decodeAttachmentsAsMarkers(body.attachments, _logger);
      const resultText = status === 'failed'
        ? `Error: ${error || 'Unknown error'}`
        : (result || '') + (attachmentMarkers ? '\n' + attachmentMarkers : '');

      // Find inbound context for the session that sent this task
      const inbound = inboundContexts.get(outbound.sessionKey);

      if (inbound) {
        // Reset idle timer — result arrived, agent is processing
        resetInboundIdleTimer(inbound, _logger);
        // Part of an inbound task — inject result as a new turn
        inbound.pendingSubTasks.delete(taskId);

        const resultMessage = [
          `## Armada Task Result from ${from}`,
          `Task ID: ${taskId}`,
          status === 'failed' ? `Error: ${error || 'Unknown error'}` : `Result:\n${resultText}`,
          `\nContinue your work. Use armada_task for the next step, or provide your final answer with TASK_COMPLETE.`,
        ].join('\n');

        try {
          const turnComplete = await dispatchTurn(_api, inbound, resultMessage, _logger);
          pushSessionEvent(inbound.sessionKey, 'turn_complete');
          if (maybeFinalize(inbound, turnComplete, _logger)) {
            _activeTasks--;
            reportTask('update', { id: inbound.taskId, status: 'completed', result: inbound.accumulator.join('\n').slice(0, 5000) });
            saveAgentTasks();
          }
        } catch (err: any) {
          _logger.error(`[armada-agent] Failed to dispatch result turn: ${err.message}`);
          finalizeInbound(inbound, `Failed to process result: ${err.message}`, 'failed', _logger);
          _activeTasks--;
          reportTask('update', { id: inbound.taskId, status: 'failed', result: err.message });
          saveAgentTasks();
        }
      } else {
        // Organic — no inbound context, inject into originating session
        _logger.info(`[armada-agent] Organic result for session ${outbound.sessionKey} — injecting via agent RPC`);
        const injectionText = status === 'failed'
          ? `## Armada Task Failed — ${from}\n\nTask ID: ${taskId}\nError: ${error || 'Unknown error'}`
          : `## Armada Task Complete — ${from}\n\nTask ID: ${taskId}\n\n${resultText}`;

        callGatewayRpc(_api, 'agent', {
          sessionKey: outbound.sessionKey,
          message: injectionText,
          deliver: true,
          bestEffortDeliver: true,
          idempotencyKey: `armada-result-${taskId}`,
        }, 120_000).catch((err: any) => {
          _logger.error(`[armada-agent] Failed to inject organic result: ${err.message}`);
        });
      }
    },
  });

  // ── HTTP: Status / Health / Drain ───────────────────────────────

  api.registerHttpRoute({
    auth: 'plugin', path: '/armada/status',
    handler: async (_req: IncomingMessage, res: ServerResponse) => {
      sendJson(res, 200, {
        instanceName: _config!.instanceName, org: _config!.org, role: _config!.role,
        status: _draining ? 'draining' : (_activeTasks > 0 ? 'busy' : 'idle'),
        activeTasks: _activeTasks, inboundContexts: inboundContexts.size,
        outboundPending: outboundTasks.size,
        uptime: process.uptime(),
      });
    },
  });

  api.registerHttpRoute({
    auth: 'plugin', path: '/armada/health',
    handler: async (_req: IncomingMessage, res: ServerResponse) => {
      sendJson(res, 200, { healthy: !_draining, instanceName: _config!.instanceName, uptime: process.uptime() });
    },
  });

  // ── HTTP: Steer — inject a message into an active task ─────────

  api.registerHttpRoute({
    auth: 'plugin',
    path: '/armada/steer',
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      const body = await readBody(req);
      const { taskId, message } = body;

      if (!taskId || !message) return sendJson(res, 400, { error: 'Missing required fields: taskId, message' });

      // Find the inbound context for this task
      let inbound: InboundContext | undefined;
      for (const [, ctx] of inboundContexts) {
        if (ctx.taskId === taskId) { inbound = ctx; break; }
      }

      if (!inbound) {
        return sendJson(res, 404, { error: `No active inbound context for task ${taskId}` });
      }

      if (inbound.finalized) {
        return sendJson(res, 409, { error: `Task ${taskId} is already finalized` });
      }

      sendJson(res, 200, { status: 'steered', taskId });

      _logger.info(`[armada-agent] Steer message injected into task ${taskId}`);

      try {
        resetInboundIdleTimer(inbound, _logger);
        const steerText = `## Operator Steer Message\n\n${message}\n\nAct on this instruction and continue your work.`;
        const turnComplete = await dispatchTurn(_api, inbound, steerText, _logger);
        pushSessionEvent(inbound.sessionKey, 'turn_complete');
        if (maybeFinalize(inbound, turnComplete, _logger)) {
          _activeTasks--;
          reportTask('update', { id: taskId, status: 'completed', result: inbound.accumulator.join('\n').slice(0, 5000) });
          saveAgentTasks();
        }
      } catch (err: any) {
        _logger.error(`[armada-agent] Failed to dispatch steer turn: ${err.message}`);
      }
    },
  });

  api.registerHttpRoute({
    auth: 'plugin', path: '/armada/drain',
    handler: async (_req: IncomingMessage, res: ServerResponse) => {
      _draining = true;
      _logger.info(`[armada-agent] Drain mode activated`);
      sendJson(res, 200, { status: 'draining', activeTasks: _activeTasks });
    },
  });

  // ── HTTP: Notify — receive notifications from armada control ────────

  api.registerHttpRoute({
    auth: 'plugin',
    path: '/armada/notify',
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      const body = await readBody(req);
      const { type, message, workflowName, runId, stepId } = body;
      _logger.info(`[armada-agent] Notification received: ${type} — ${message || workflowName || ''}`);
      if (runId || stepId) {
        _logger.info(`[armada-agent] Notification context: runId=${runId ?? 'n/a'} stepId=${stepId ?? 'n/a'}`);
      }
      sendJson(res, 200, { ok: true });
    },
  });

  // ── HTTP: List sessions ─────────────────────────────────────────

  api.registerHttpRoute({
    auth: 'plugin',
    path: '/armada/session',
    handler: async (_req: IncomingMessage, res: ServerResponse) => {
      try {
        // Use gateway RPC to list sessions — the canonical API
        const result = await callGatewayRpc(_api, 'sessions.list', {
          includeLastMessage: false,
          includeDerivedTitles: true,
        }, 10_000);

        // Transform gateway response to armada format
        const sessions = (Array.isArray(result) ? result : result?.sessions ?? []).map((s: any) => ({
          sessionKey: s.key,
          sessionId: s.sessionId,
          kind: s.kind,
          label: s.label,
          displayName: s.displayName,
          model: s.model,
          modelProvider: s.modelProvider,
          updatedAt: s.updatedAt,
          chatType: s.chatType,
          inputTokens: s.inputTokens || 0,
          outputTokens: s.outputTokens || 0,
          totalTokens: s.totalTokens || 0,
          contextTokens: s.contextTokens || 0,
          thinkingLevel: s.thinkingLevel,
          channel: s.channel,
        }));

        sendJson(res, 200, { sessions });
      } catch (err: any) {
        _logger.error(`[armada-agent] sessions.list RPC failed: ${err.message}`);
        sendJson(res, 500, { error: err.message });
      }
    },
  });

  // ── HTTP: Session messages via gateway RPC ──────────────────────

  api.registerHttpRoute({
    auth: 'plugin',
    path: '/armada/session/messages',
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      try {
        const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
        const sessionKey = url.searchParams.get('sessionKey');
        const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 1000);

        if (!sessionKey) {
          return sendJson(res, 400, { error: 'sessionKey query parameter required' });
        }

        // Use gateway RPC chat.history — the canonical API for session messages.
        // sessions.list returns canonical keys (e.g. "agent:forge:armada:operator:nudge-123")
        // but the session store may use a shorter key (e.g. "armada:operator:nudge-123").
        // chat.history resolves via the store, so try canonical first, then strip agent prefix.
        let result = await callGatewayRpc(_api, 'chat.history', {
          sessionKey,
          limit,
        }, 15_000);

        // If no messages found and key has agent prefix, try without it
        if ((!result?.messages || result.messages.length === 0) && sessionKey.startsWith('agent:')) {
          const shortKey = sessionKey.replace(/^agent:[^:]+:/, '');
          if (shortKey !== sessionKey) {
            result = await callGatewayRpc(_api, 'chat.history', {
              sessionKey: shortKey,
              limit,
            }, 15_000);
          }
        }

        // Messages come back as standard OpenClaw message format:
        // { role: string, content: string | ContentBlock[], timestamp?: number }
        const rawMessages: any[] = result?.messages ?? [];

        // Normalize content blocks for the armada UI
        const messages = rawMessages.map((msg: any, idx: number) => {
          let contentBlocks: any[] = [];

          if (typeof msg.content === 'string') {
            contentBlocks = [{ type: 'text', text: msg.content }];
          } else if (Array.isArray(msg.content)) {
            contentBlocks = msg.content.map((block: any) => {
              if (block.type === 'text') {
                return { type: 'text', text: block.text };
              } else if (block.type === 'tool_use') {
                return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
              } else if (block.type === 'tool_result') {
                // Truncate large tool results for transport
                let resultContent = block.content;
                if (typeof resultContent === 'string' && resultContent.length > 2000) {
                  resultContent = resultContent.slice(0, 2000) + '... (truncated)';
                } else if (Array.isArray(resultContent)) {
                  resultContent = resultContent.map((r: any) => {
                    if (r.type === 'text' && typeof r.text === 'string' && r.text.length > 2000) {
                      return { ...r, text: r.text.slice(0, 2000) + '... (truncated)' };
                    }
                    return r;
                  });
                }
                return { type: 'tool_result', tool_use_id: block.tool_use_id, content: resultContent, is_error: block.is_error };
              } else if (block.type === 'thinking') {
                return { type: 'thinking', text: block.thinking || block.text || '' };
              }
              return { type: block.type || 'unknown' };
            });
          }

          return {
            id: `msg-${idx}`,
            role: msg.role,
            content: contentBlocks,
            timestamp: typeof msg.timestamp === 'number' ? new Date(msg.timestamp).toISOString()
              : typeof msg.timestamp === 'string' ? msg.timestamp : null,
            model: msg.model,
            provider: msg.provider,
          };
        });

        sendJson(res, 200, {
          sessionKey: result?.sessionKey,
          sessionId: result?.sessionId,
          messages,
          thinkingLevel: result?.thinkingLevel,
          total: messages.length,
        });
      } catch (err: any) {
        _logger.error(`[armada-agent] chat.history RPC failed: ${err.message}`);
        sendJson(res, 500, { error: err.message });
      }
    },
  });

  // Load persisted tasks on startup
  loadAgentTasks();
  cleanupStaleAgentTasks();

  // ── Service lifecycle ─────────────────────────────────────────────

  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let _openclawVersion: string | undefined;
  let _pluginVersions: Record<string, string> | undefined;
  let _skillVersions: Record<string, string> | undefined;

  function readOpenClawVersion(): string | undefined {
    try {
      const fs = require('fs');
      const pkg = JSON.parse(fs.readFileSync('/app/package.json', 'utf8'));
      return pkg.version;
    } catch {
      return undefined;
    }
  }

  function readPluginVersions(): Record<string, string> {
    const versions: Record<string, string> = {};
    try {
      const fs = require('fs');
      const path = require('path');
      const extDir = '/home/node/.openclaw/extensions';
      if (!fs.existsSync(extDir)) return versions;
      for (const entry of fs.readdirSync(extDir)) {
        const pkgPath = path.join(extDir, entry, 'package.json');
        if (fs.existsSync(pkgPath)) {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
          versions[entry] = pkg.version || 'unknown';
        }
      }
    } catch {}
    return versions;
  }

  function readSkillVersions(): Record<string, string> {
    const versions: Record<string, string> = {};
    try {
      const fs = require('fs');
      const path = require('path');
      const skillsDir = '/home/node/.openclaw/workspace/skills';
      if (!fs.existsSync(skillsDir)) return versions;
      for (const entry of fs.readdirSync(skillsDir)) {
        const pkgPath = path.join(skillsDir, entry, 'package.json');
        if (fs.existsSync(pkgPath)) {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
          versions[entry] = pkg.version || 'installed';
        } else if (fs.existsSync(path.join(skillsDir, entry, 'SKILL.md'))) {
          versions[entry] = 'installed';
        }
      }
    } catch {}
    return versions;
  }

  async function sendHeartbeats() {
    if (!getApiBaseUrl() || !_config?.armadaApiToken) return;
    if (!_openclawVersion) _openclawVersion = readOpenClawVersion();
    // Re-read versions each heartbeat so updates are detected promptly
    _pluginVersions = readPluginVersions();
    _skillVersions = readSkillVersions();

    // Discover loaded agents from the gateway config
    const loadedAgents: Array<{ id: string; name: string; model?: string; status: string }> = [];
    try {
      const agentsList = _api?.config?.agents?.list;
      if (Array.isArray(agentsList)) {
        for (const a of agentsList) {
          loadedAgents.push({
            id: a.id || a.name || 'unknown',
            name: a.name || a.id || 'unknown',
            model: a.model || undefined,
            status: 'active',
          });
        }
      }
    } catch { /* config not available */ }

    try {
      const resp = await fetch(`${getApiBaseUrl()}/api/instances/heartbeat`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${_config.armadaApiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          instanceName: _config.instanceName,
          activeTasks: inboundContexts.size,
          activeTaskIds: [...inboundContexts.values()].map(ctx => ctx.taskId).filter(Boolean),
          version: _openclawVersion,
          pluginVersions: _pluginVersions,
          skillVersions: _skillVersions,
          agents: loadedAgents,
          status: 'ready',
        }),
      });
      if (!resp.ok) {
        // Maybe instance heartbeat endpoint doesn't exist yet — fall back to per-agent
        const agentsResp = await fetch(`${getApiBaseUrl()}/api/agents`, {
          headers: { 'Authorization': `Bearer ${_config.armadaApiToken}` },
        });
        if (agentsResp.ok) {
          const allAgents = await agentsResp.json() as any[];
          const myAgents = allAgents.filter((a: any) => a.instanceName === _config!.instanceName);
          for (const agent of myAgents) {
            await fetch(`${getApiBaseUrl()}/api/agents/${encodeURIComponent(agent.name)}/heartbeat`, {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${_config.armadaApiToken}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                status: 'idle',
                activeTasks: inboundContexts.size,
                instance: _config.instanceName,
              }),
            }).catch(() => {});
          }
        }
      }
    } catch {
      // Control plane unreachable — will retry next cycle
    }
  }

  api.registerService({
    id: 'armada-agent',
    start: async () => {
      _logger.info(`[armada-agent] Started — ${_config!.instanceName} (${_config!.role}) in org ${_config!.org}`);
      _logger.info(`[armada-agent] Control plane URL: ${getApiBaseUrl()}`);
      // Start periodic heartbeats to control plane (every 30s)
      sendHeartbeats();
      heartbeatTimer = setInterval(sendHeartbeats, 30_000);
    },
    stop: async () => {
      _draining = true;
      if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
      // Finalize any active inbound contexts
      for (const [, inbound] of inboundContexts) {
        finalizeInbound(inbound, 'Instance shutting down', 'failed', _logger);
      }
      outboundTasks.clear();
      _logger.info(`[armada-agent] Stopped`);
    },
  });
}
