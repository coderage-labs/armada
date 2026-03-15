/**
 * openclaw-armada-control — Armada operator plugin for OpenClaw.
 *
 * Installed on the operator's instance (e.g., Robin). Provides tools to
 * send tasks to Armada instances and monitor their status.
 *
 * Uses coordinator sessions for result handling — results are injected into
 * isolated sessions (armada:target:taskShort) via the shared injectAndWaitForResponse
 * engine (dispatchReplyFromConfig pipeline), preventing lane blocking.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import { writeFileSync, readFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  generateId,
  readBody,
  sendJson,
  getOrCreateGlobalMap,
  parseDeliveryFromSessionKey,
  decodeAttachments,
  dispatchArmadaTask,
  injectAndWaitForResponse,
  callGatewayRpc,
  serializeTaskMap,
  deserializeTaskMap,
  TASK_STALE_MS,
  ARMADA_PENDING_SYM,
  ARMADA_COORD_CB_SYM,
  type SubTaskResult,
} from '@coderage-labs/armada-plugin-shared';

// ── Types ───────────────────────────────────────────────────────────

interface armadaAgent {
  id: string;
  name: string;
  status: string;
  role?: string;
  containerId?: string;
  containerState?: string;
  port?: number;
}

interface armadaControlConfig {
  armadaApiUrl: string;
  armadaApiToken: string;
  callbackUrl: string;
  hooksToken: string;
  operatorName: string;
  idleTimeoutMs: number;
  hardTimeoutMs: number;
}

interface PendingTask {
  id: string;
  target: string;
  message: string;
  originSessionKey: string;
  coordinatorSessionKey: string;
  channel?: string;
  to?: string;
  threadId?: string;
  createdAt: number;
  idleTimer?: ReturnType<typeof setTimeout>;
  hardTimer?: ReturnType<typeof setTimeout>;
}

// ── GlobalThis-persisted Maps ───────────────────────────────────────

const sessionPendingTasks = getOrCreateGlobalMap<string, Set<string>>(ARMADA_PENDING_SYM);
const coordinatorCallbacks = getOrCreateGlobalMap<string, (result: SubTaskResult) => void>(ARMADA_COORD_CB_SYM);

// ── State ───────────────────────────────────────────────────────────

let _config: armadaControlConfig | null = null;
let _api: any = null;
const _pendingTasks = new Map<string, PendingTask>();
let _logger: { info: (...args: any[]) => void; warn: (...args: any[]) => void; error: (...args: any[]) => void } = console;

// ── Task persistence ────────────────────────────────────────────────

const _dataDir = join(process.env.HOME || '/home/node', '.openclaw');
const _tasksFilePath = join(_dataDir, 'armada-control-tasks.json');

/** Atomically save pending tasks to disk */
function savePendingTasks(): void {
  try {
    mkdirSync(_dataDir, { recursive: true });
    // Only serialize the data fields, not timers
    const serializable = new Map<string, any>();
    for (const [id, task] of _pendingTasks) {
      serializable.set(id, {
        id: task.id,
        target: task.target,
        message: task.message,
        originSessionKey: task.originSessionKey,
        coordinatorSessionKey: task.coordinatorSessionKey,
        channel: task.channel,
        to: task.to,
        threadId: task.threadId,
        createdAt: task.createdAt,
      });
    }
    const tmpPath = _tasksFilePath + '.tmp';
    writeFileSync(tmpPath, serializeTaskMap(serializable), 'utf-8');
    renameSync(tmpPath, _tasksFilePath);
  } catch (err: any) {
    _logger.warn(`[armada-control] Failed to save pending tasks: ${err.message}`);
  }
}

/** Load pending tasks from disk on startup */
function loadPendingTasks(): void {
  try {
    if (!existsSync(_tasksFilePath)) return;
    const json = readFileSync(_tasksFilePath, 'utf-8');
    const restored = deserializeTaskMap(json);
    let count = 0;
    for (const [id, data] of restored) {
      const task: PendingTask = {
        id: data.id,
        target: data.target,
        message: data.message || '',
        originSessionKey: data.originSessionKey || '',
        coordinatorSessionKey: data.coordinatorSessionKey || '',
        channel: data.channel,
        to: data.to,
        threadId: data.threadId,
        createdAt: data.createdAt || 0,
        // No timers — restored tasks just sit and wait for results
      };
      _pendingTasks.set(id, task);
      count++;
    }
    if (count > 0) _logger.info(`[armada-control] Restored ${count} pending tasks from disk`);
  } catch (err: any) {
    _logger.warn(`[armada-control] Failed to load pending tasks: ${err.message}`);
  }
}

/** Remove tasks older than TASK_STALE_MS on startup */
function cleanupStaleTasks(): void {
  const now = Date.now();
  let removed = 0;
  for (const [id, task] of _pendingTasks) {
    if (now - task.createdAt > TASK_STALE_MS) {
      _pendingTasks.delete(id);
      removed++;
    }
  }
  if (removed > 0) {
    _logger.info(`[armada-control] Cleaned up ${removed} stale tasks (>2h old)`);
    savePendingTasks();
  }
}

// ── Armada API ───────────────────────────────────────────────────────

async function fetchAgents(): Promise<armadaAgent[]> {
  if (!_config?.armadaApiUrl) return [];
  try {
    const resp = await fetch(`${_config.armadaApiUrl}/api/agents`, {
      headers: { 'Authorization': `Bearer ${_config.armadaApiToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) return [];
    return await resp.json() as armadaAgent[];
  } catch { return []; }
}

function agentToUrl(agent: armadaAgent): string {
  return `http://armada-${agent.name}:18789`;
}

async function armadaApiGet(path: string, format: 'json' | 'text' = 'json'): Promise<any> {
  if (!_config?.armadaApiUrl) return { error: 'Armada API URL not configured' };
  try {
    const resp = await fetch(`${_config.armadaApiUrl}${path}`, {
      headers: {
        'Authorization': `Bearer ${_config.armadaApiToken}`,
        'X-Agent-Name': _config.operatorName || 'unknown',
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!resp.ok) return { error: `Armada API returned ${resp.status}` };
    return format === 'text' ? { logs: await resp.text() } : await resp.json();
  } catch (err: any) {
    return { error: `Armada API request failed: ${err.message}` };
  }
}

async function armadaApiPost(path: string, body?: any): Promise<any> {
  if (!_config?.armadaApiUrl) return { error: 'Armada API URL not configured' };
  try {
    const resp = await fetch(`${_config.armadaApiUrl}${path}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${_config.armadaApiToken}`,
        'Content-Type': 'application/json',
        'X-Agent-Name': _config.operatorName || 'unknown',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60_000),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      return { error: `Armada API returned ${resp.status}: ${text}` };
    }
    const text = await resp.text();
    try { return JSON.parse(text); } catch { return { status: 'ok' }; }
  } catch (err: any) {
    return { error: `Armada API request failed: ${err.message}` };
  }
}

async function armadaApiDelete(path: string): Promise<any> {
  if (!_config?.armadaApiUrl) return { error: 'Armada API URL not configured' };
  try {
    const resp = await fetch(`${_config.armadaApiUrl}${path}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${_config.armadaApiToken}`,
        'X-Agent-Name': _config.operatorName || 'unknown',
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!resp.ok) return { error: `Armada API returned ${resp.status}` };
    return { status: 'destroyed' };
  } catch (err: any) {
    return { error: `Armada API request failed: ${err.message}` };
  }
}

async function armadaApiPut(path: string, body?: any): Promise<any> {
  if (!_config?.armadaApiUrl) return { error: 'Armada API URL not configured' };
  try {
    const resp = await fetch(`${_config.armadaApiUrl}${path}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${_config.armadaApiToken}`,
        'X-Agent-Name': _config.operatorName || 'unknown',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      return { error: `Armada API returned ${resp.status}: ${text}` };
    }
    const text = await resp.text();
    try { return JSON.parse(text); } catch { return { status: 'ok', body: text }; }
  } catch (err: any) {
    return { error: `Armada API request failed: ${err.message}` };
  }
}

// ── Task Reporting ──────────────────────────────────────────────

function reportTaskToControlPlane(action: 'create' | 'update', data: Record<string, any>): void {
  if (!_config?.armadaApiUrl) return;
  const url = action === 'create'
    ? `${_config.armadaApiUrl}/api/tasks`
    : `${_config.armadaApiUrl}/api/tasks/${encodeURIComponent(data.id)}`;
  const method = action === 'create' ? 'POST' : 'PUT';
  fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ..._config.armadaApiToken ? { 'Authorization': `Bearer ${_config.armadaApiToken}` } : {},
    },
    body: JSON.stringify(data),
    signal: AbortSignal.timeout(5_000),
  }).catch((err: any) => _logger.warn(`[armada-control] Failed to report task: ${err.message}`));
}

// ── API Tool Definitions ────────────────────────────────────────

interface ToolDef {
  name: string;
  description: string;
  method: 'GET' | 'POST' | 'DELETE' | 'PUT' | 'PATCH';
  path: string;
  parameters: Array<{
    name: string;
    type: string;
    description: string;
    required?: boolean;
    enum?: string[];
  }>;
  responseFormat?: 'json' | 'text';
  supportsAll?: boolean;
}

/**
 * Fetch tool definitions from the armada API and register them as OpenClaw tools.
 * Each API endpoint that calls registerToolDef() becomes an auto-generated tool.
 */
async function loadApiTools(): Promise<void> {
  const defs = await armadaApiGet('/api/meta/tools') as ToolDef[];
  if (!Array.isArray(defs) || defs.length === 0) {
    _logger.warn('[armada-control] No tool definitions found from API');
    return;
  }

  // Skip armada_task, armada_status, armada_contacts — registered manually with special logic
  const MANUAL_TOOLS = new Set(['armada_task', 'armada_status', 'armada_contacts']);

  for (const def of defs) {
    if (MANUAL_TOOLS.has(def.name)) continue;

    const properties: Record<string, any> = {};
    const required: string[] = [];

    for (const p of def.parameters) {
      properties[p.name] = {
        type: p.type,
        description: p.description,
        ...(p.enum && { enum: p.enum }),
      };
      if (p.required) required.push(p.name);
    }

    _api.registerTool({
      name: def.name,
      description: def.description,
      parameters: {
        type: 'object',
        properties,
        ...(required.length > 0 && { required }),
      },
      execute: async (_id: string, args: Record<string, any>) => {
        return executeApiTool(def, args);
      },
    });

    _logger.info(`[armada-control] Registered tool: ${def.name} (${def.method} ${def.path})`);
  }

  _logger.info(`[armada-control] Loaded ${defs.length - MANUAL_TOOLS.size} tools from API`);
}

/**
 * Execute an API tool by mapping args to the HTTP request.
 */
async function executeApiTool(def: ToolDef, args: Record<string, any>): Promise<any> {
  // Handle "all" for tools that support it
  if (def.supportsAll && args.target?.toLowerCase() === 'all') {
    const agents = await fetchAgents();
    const results: Record<string, string> = {};
    for (const agent of agents) {
      const r = await executeApiTool({ ...def, supportsAll: false }, { ...args, target: agent.name });
      results[agent.name] = (r as any).status || (r as any).error || 'unknown';
    }
    return { results };
  }

  // Resolve path params (:name, :id, :skill, etc.)
  let resolvedPath = def.path;
  const pathParamRegex = /:(\w+)/g;
  let match;
  while ((match = pathParamRegex.exec(def.path)) !== null) {
    const paramName = match[1];
    // Try the exact param name first, then 'target' as fallback for :name/:id
    const value = args[paramName] ?? (paramName === 'name' || paramName === 'id' ? args.target : undefined);
    if (!value) return { error: `Missing parameter: ${paramName}` };
    resolvedPath = resolvedPath.replace(`:${paramName}`, encodeURIComponent(value));
  }

  // Collect path param names to exclude from query/body
  const pathParams = new Set<string>();
  const ppRegex = /:(\w+)/g;
  let pp;
  while ((pp = ppRegex.exec(def.path)) !== null) pathParams.add(pp[1]);
  // 'target' is a UI alias for :name/:id, always exclude from body
  pathParams.add('target');

  // Build query params for GET requests
  if (def.method === 'GET') {
    const queryParams: string[] = [];
    for (const p of def.parameters) {
      if (args[p.name] !== undefined && !pathParams.has(p.name)) {
        queryParams.push(`${p.name}=${encodeURIComponent(args[p.name])}`);
      }
    }
    if (queryParams.length > 0) resolvedPath += '?' + queryParams.join('&');
    return armadaApiGet(resolvedPath, def.responseFormat === 'text' ? 'text' : 'json');
  }

  if (def.method === 'DELETE') {
    return armadaApiDelete(resolvedPath);
  }

  // POST/PUT/PATCH — send non-path args as body
  const body: Record<string, any> = {};
  for (const p of def.parameters) {
    if (args[p.name] !== undefined && !pathParams.has(p.name)) {
      body[p.name] = args[p.name];
    }
  }

  if (def.method === 'PUT') {
    return armadaApiPut(resolvedPath, Object.keys(body).length > 0 ? body : undefined);
  }

  return armadaApiPost(resolvedPath, Object.keys(body).length > 0 ? body : undefined);
}

// ── Helpers ─────────────────────────────────────────────────────────

function cleanupTask(taskId: string): PendingTask | undefined {
  const pending = _pendingTasks.get(taskId);
  if (!pending) return undefined;

  if (pending.idleTimer) clearTimeout(pending.idleTimer);
  if (pending.hardTimer) clearTimeout(pending.hardTimer);
  _pendingTasks.delete(taskId);
  savePendingTasks();

  const sessionTasks = sessionPendingTasks.get(pending.coordinatorSessionKey);
  if (sessionTasks) {
    sessionTasks.delete(taskId);
    if (sessionTasks.size === 0) sessionPendingTasks.delete(pending.coordinatorSessionKey);
  }

  return pending;
}

function resetIdleTimer(taskId: string): void {
  const pending = _pendingTasks.get(taskId);
  if (!pending || !_config) return;

  if (pending.idleTimer) clearTimeout(pending.idleTimer);
  pending.idleTimer = setTimeout(() => {
    _logger.warn(`[armada-control] Task ${taskId} to ${pending.target} idle timeout`);
    cleanupTask(taskId);
  }, _config.idleTimeoutMs);
  if (pending.idleTimer && typeof pending.idleTimer === 'object' && 'unref' in pending.idleTimer) {
    (pending.idleTimer as NodeJS.Timeout).unref();
  }
}

// ── Coordinator Session Logic ───────────────────────────────────────

/**
 * Inject a armada result into an isolated coordinator session.
 *
 * For group sessions (has delivery context): uses injectAndWaitForResponse
 * with an isolated coordinator session key, preventing lane blocking.
 * The coordinator LLM processes the result and delivers to the user's channel
 * via the message tool (delivery instructions in the injected text).
 *
 * For main sessions (no delivery context): injects directly into the origin
 * session via 'agent' RPC with deliver:true — safe because main sessions
 * have no group lane contention.
 */
async function injectIntoCoordinatorSession(taskId: string, pending: PendingTask, resultBody: string, from: string, attachmentPaths: string[] = []): Promise<void> {
  const { coordinatorSessionKey, originSessionKey, channel, to, threadId, message: originalMessage } = pending;

  const contextLines: string[] = [];
  if (originalMessage) {
    const preview = originalMessage.length > 500 ? originalMessage.slice(0, 500) + '...' : originalMessage;
    contextLines.push(`Original task sent to ${from}:\n${preview}\n`);
  }

  const deliveryParts: string[] = [];
  if (channel) deliveryParts.push(`channel=${channel}`);
  if (to) deliveryParts.push(`to=${to}`);
  if (threadId) deliveryParts.push(`threadId=${threadId}`);

  // No delivery context — inject directly into origin session (safe for main/DM sessions)
  if (deliveryParts.length === 0) {
    _logger.info(`[armada-control] No delivery context — injecting directly into origin session ${originSessionKey}`);

    const attachmentInstruction = attachmentPaths.length > 0
      ? `\n\nAttachment files are saved locally at: ${attachmentPaths.join(', ')}. Send them to the user using the message tool with filePath.`
      : '';

    await callGatewayRpc(_api, 'agent', {
      sessionKey: originSessionKey,
      message: [
        `[armada RESULT] "${from}" completed a task.`,
        `Task ID: ${taskId}`,
        ...contextLines,
        `Result:\n${resultBody}`,
        attachmentInstruction,
        `\nProcess this result and relay it to the user. Act on it if needed.`,
      ].join('\n'),
      deliver: true,
      bestEffortDeliver: true,
      idempotencyKey: `armada-result-${taskId}`,
    }, 120_000);
    _logger.info(`[armada-control] Result for ${taskId} delivered to origin session`);
    return;
  }

  // Has delivery context — use isolated coordinator session to prevent lane blocking
  const deliveryInstruction = `Deliver your summary to ${deliveryParts.join(' ')} using the message tool.`;

  const text = [
    `[armada RESULT] "${from}" completed a task.`,
    `Task ID: ${taskId}`,
    ...contextLines,
    `Result:\n${resultBody}`,
    '',
    deliveryInstruction,
  ].join('\n');

  _logger.info(`[armada-control] Injecting result into coordinator session ${coordinatorSessionKey}`);

  await injectAndWaitForResponse(_api, text, {
    taskId,
    from,
    sessionKey: coordinatorSessionKey,
    idleTimeoutMs: _config!.idleTimeoutMs,
    hardTimeoutMs: _config!.hardTimeoutMs,
  }, _logger);

  _logger.info(`[armada-control] Coordinator ${coordinatorSessionKey} completed`);
}

// ── Plugin Entry ────────────────────────────────────────────────────

export default function register(api: any) {
  _api = api;
  _logger = api.logger ?? console;

  const pluginConfig = api.pluginConfig || api.config?.plugins?.entries?.['openclaw-armada-control']?.config || {};
  _config = {
    armadaApiUrl: pluginConfig.armadaApiUrl || '',
    armadaApiToken: pluginConfig.armadaApiToken || '',
    callbackUrl: pluginConfig.callbackUrl || '',
    hooksToken: pluginConfig.hooksToken || '',
    operatorName: pluginConfig.operatorName || 'robin',
    idleTimeoutMs: pluginConfig.idleTimeoutMs ?? 180_000,
    hardTimeoutMs: pluginConfig.hardTimeoutMs ?? 1_800_000,
  };

  _logger.info(`[armada-control] Operator plugin loaded — armada API: ${_config.armadaApiUrl}`);

  // ── Tool: armada_task (factory-style for session key capture) ────

  (api.registerTool as any)((ctx: any) => {
    const factorySessionKey = ctx?.sessionKey;

    return {
      name: 'armada_task',
      description: 'Send an async task to a Armada instance. Results are delivered automatically when complete. Use this instead of subagents/sessions_spawn when you need persistent agents with their own memory, workspace, and plugins. Armada agents retain context across tasks.',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', description: 'Instance name to send the task to' },
          message: { type: 'string', description: 'Task message/instructions' },
          project: { type: 'string', description: 'Project name for context injection (optional)' },
        },
        required: ['target', 'message'],
      },
      execute: async (_id: string, args: { target: string; message: string; project?: string }, context: any) => {
        if (!args?.target) return { error: 'Missing target' };

        const agents = await fetchAgents();
        const agent = agents.find(a => a.name.toLowerCase() === args.target.toLowerCase());
        if (!agent) {
          const available = agents.map(a => `${a.name} (${a.status})`).join(', ');
          return { error: `Unknown instance: ${args.target}. Available: ${available || 'none'}` };
        }
        if (agent.containerState !== 'running') {
          return { error: `${args.target} is not running (state: ${agent.containerState})` };
        }

        const taskId = generateId();
        const url = agentToUrl(agent);
        const sessionKey = context?.sessionKey || factorySessionKey || '';
        const delivery = parseDeliveryFromSessionKey(sessionKey);

        const taskShort = taskId.split('-').slice(1).join('-').slice(0, 8) || taskId.slice(3, 11);
        const coordinatorSessionKey = `armada:${args.target.toLowerCase()}:${taskShort}`;

        _logger.info(`[armada-control] Task ${taskId}: origin=${sessionKey}, coordinator=${coordinatorSessionKey}`);

        const pending: PendingTask = {
          id: taskId,
          target: args.target,
          message: args.message,
          originSessionKey: sessionKey,
          coordinatorSessionKey,
          ...delivery,
          createdAt: Date.now(),
        };

        _pendingTasks.set(taskId, pending);
        savePendingTasks();

        if (!sessionPendingTasks.has(sessionKey)) sessionPendingTasks.set(sessionKey, new Set());
        sessionPendingTasks.get(sessionKey)!.add(taskId);

        resetIdleTimer(taskId);

        pending.hardTimer = setTimeout(() => {
          _logger.warn(`[armada-control] Task ${taskId} to ${args.target} hard timeout`);
          cleanupTask(taskId);
        }, _config!.hardTimeoutMs);
        if (pending.hardTimer && typeof pending.hardTimer === 'object' && 'unref' in pending.hardTimer) {
          (pending.hardTimer as NodeJS.Timeout).unref();
        }

        const result = await dispatchArmadaTask({
          targetUrl: url,
          taskId,
          from: _config!.operatorName || 'robin',
          fromRole: 'operator',
          message: args.message,
          callbackUrl: _config!.callbackUrl ? `${_config!.callbackUrl}/armada/result` : '',
          hooksToken: _config!.hooksToken,
          ...(args.project ? { project: args.project } : {}),
        }, _logger);

        if (!result.ok) {
          cleanupTask(taskId);
          return { error: `Failed to send task to ${args.target}: ${result.error}` };
        }

        _logger.info(`[armada-control] Task ${taskId} sent to ${args.target}`);
        reportTaskToControlPlane('create', {
          id: taskId,
          fromAgent: _config!.operatorName || 'robin',
          toAgent: args.target,
          taskText: args.message.slice(0, 5000),
          status: 'pending',
        });
        return { taskId, target: args.target, status: 'sent', message: `Task sent to ${args.target}. Result will be delivered when complete.` };
      },
    };
  });

  // ── Tool: armada_status ──────────────────────────────────────────

  api.registerTool({
    name: 'armada_status',
    description: 'Check the status of all Armada instances. Shows which agents are running and available for armada_task.',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      const agents = await fetchAgents();
      if (agents.length === 0) return { error: 'No agents found — is armada-control running?' };
      return { instances: agents.map(a => ({ name: a.name, status: a.containerState || a.status, role: a.role })) };
    },
  });

  // ── Tool: armada_contacts ────────────────────────────────────────

  api.registerTool({
    name: 'armada_contacts',
    description: 'List all running Armada instances you can send tasks to via armada_task.',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      const agents = await fetchAgents();
      return { instances: agents.filter(a => a.containerState === 'running').map(a => ({ name: a.name, role: a.role, url: agentToUrl(a) })) };
    },
  });

  // ── Tool: armada_steer ────────────────────────────────────────────

  api.registerTool({
    name: 'armada_steer',
    description: 'Inject a message into an agent\'s active task. Use this to course-correct, provide additional info, or tell the agent to retry something mid-task.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Agent name (e.g. nexus, forge)' },
        taskId: { type: 'string', description: 'Task ID to steer' },
        message: { type: 'string', description: 'Message to inject into the task' },
      },
      required: ['target', 'message'],
    },
    execute: async (_id: string, args: { target: string; taskId?: string; message: string }) => {
      if (!args?.target || !args?.message) return { error: 'Missing target or message' };

      const agents = await fetchAgents();
      const agent = agents.find(a => a.name.toLowerCase() === args.target.toLowerCase());
      if (!agent) return { error: `Unknown agent: ${args.target}` };
      if (agent.containerState !== 'running') return { error: `${args.target} is not running` };

      // Find taskId — use provided or find the most recent active task for this agent
      let taskId = args.taskId;
      if (!taskId) {
        for (const [id, pending] of _pendingTasks) {
          if (pending.target.toLowerCase() === args.target.toLowerCase()) {
            taskId = id;
            break;
          }
        }
      }
      if (!taskId) return { error: `No active task found for ${args.target}. Provide a taskId.` };

      const url = agentToUrl(agent);
      try {
        const res = await fetch(`${url}/armada/steer`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${_config!.hooksToken}`,
          },
          body: JSON.stringify({ taskId, message: args.message }),
          signal: AbortSignal.timeout(10_000),
        });
        const data = await res.json();
        if (!res.ok) return { error: data.error || `Steer failed (${res.status})` };
        return { status: 'steered', taskId, target: args.target, message: `Message injected into ${args.target}'s task ${taskId}` };
      } catch (err: any) {
        return { error: `Failed to steer ${args.target}: ${err.message}` };
      }
    },
  });

  // ── Tool: armada_transfer ─────────────────────────────────────────

  api.registerTool({
    name: 'armada_transfer',
    description: 'Transfer a file from one agent\'s workspace to another. The file is copied via the node agent — works across machines.',
    parameters: {
      type: 'object',
      properties: {
        fromAgent: { type: 'string', description: 'Source agent name' },
        path: { type: 'string', description: 'File path in source agent workspace' },
        toAgent: { type: 'string', description: 'Destination agent name' },
        destPath: { type: 'string', description: 'Destination path in target workspace (optional, defaults to shared-files/)' },
      },
      required: ['fromAgent', 'path', 'toAgent'],
    },
    execute: async (_id: string, args: { fromAgent: string; path: string; toAgent: string; destPath?: string }) => {
      if (!args?.fromAgent || !args?.path || !args?.toAgent) return { error: 'Missing required fields' };
      try {
        const res = await fetch(`${_config!.armadaApiUrl}/api/files/transfer`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${_config!.armadaApiToken || ''}`,
          },
          body: JSON.stringify(args),
          signal: AbortSignal.timeout(30_000),
        });
        const data = await res.json();
        if (!res.ok) return { error: data.error || `Transfer failed (${res.status})` };
        return data;
      } catch (err: any) {
        return { error: `Transfer failed: ${err.message}` };
      }
    },
  });

  // ── Tool: armada_triage ──────────────────────────────────────────

  api.registerTool({
    name: 'armada_triage',
    description: 'Triage GitHub issues for a project. If a PM-tier agent is assigned, it handles triage. Otherwise returns to operator. Use action="scan" to scan all projects, or action="issue" to triage a specific issue.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['scan', 'issue', 'mark'], description: 'scan=check all projects, issue=triage one issue, mark=mark as handled' },
        projectId: { type: 'string', description: 'Project ID (required for issue/mark)' },
        issueNumber: { type: 'number', description: 'Issue number (required for issue/mark)' },
      },
      required: ['action'],
    },
    execute: async (_id: string, args: { action: string; projectId?: string; issueNumber?: number }) => {
      if (!args?.action) return { error: 'Missing action' };
      const endpoint = args.action === 'scan' ? '/api/triage/scan'
        : args.action === 'mark' ? '/api/triage/mark'
        : '/api/triage/issue';

      try {
        const res = await fetch(`${_config!.armadaApiUrl}${endpoint}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${_config!.armadaApiToken || ''}`,
          },
          body: JSON.stringify({
            projectId: args.projectId,
            issueNumber: args.issueNumber,
          }),
          signal: AbortSignal.timeout(30_000),
        });
        return await res.json();
      } catch (err: any) {
        return { error: `Triage failed: ${err.message}` };
      }
    },
  });

  // ── Tool: armada_workflow ─────────────────────────────────────────

  api.registerTool({
    name: 'armada_workflow',
    description: 'Trigger a project workflow run. Workflows are deterministic multi-agent pipelines — no LLM coordination. Steps dispatch to agents by role with defined dependencies.',
    parameters: {
      type: 'object',
      properties: {
        workflowId: { type: 'string', description: 'Workflow ID to run' },
        triggerRef: { type: 'string', description: 'Optional trigger reference (e.g. issue URL)' },
        vars: { type: 'object', description: 'Template variables to pass to step prompts' },
      },
      required: ['workflowId'],
    },
    execute: async (_id: string, args: { workflowId: string; triggerRef?: string; vars?: Record<string, any> }) => {
      if (!args?.workflowId) return { error: 'Missing workflowId' };
      try {
        const res = await fetch(`${_config!.armadaApiUrl}/api/workflows/${args.workflowId}/run`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${_config!.armadaApiToken || ''}`,
          },
          body: JSON.stringify({
            triggerType: args.triggerRef ? 'issue' : 'manual',
            triggerRef: args.triggerRef,
            vars: args.vars,
          }),
          signal: AbortSignal.timeout(15_000),
        });
        const data = await res.json();
        if (!res.ok) return { error: data.error || `Workflow start failed (${res.status})` };
        return { status: 'started', runId: data.id, workflowId: args.workflowId };
      } catch (err: any) {
        return { error: `Failed to start workflow: ${err.message}` };
      }
    },
  });

  // ── Auto-generated tools from API metadata ───────────────────────

  // Fetch tool definitions from armada API and register them dynamically.
  // This keeps the plugin in sync with the API — adding a new endpoint
  // with a registerToolDef() call makes it instantly available as a tool.
  loadApiTools().catch(err => _logger.warn(`[armada-control] Failed to load API tools: ${err.message}`));

  // ── HTTP: Receive results ───────────────────────────────────────

  if (typeof api.registerHttpRoute === 'function') {
    api.registerHttpRoute({
      auth: 'plugin',
      path: '/armada/result',
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        const body = await readBody(req);
        const { taskId, from, result, status, error, progress } = body;

        if (!taskId || !from) return sendJson(res, 400, { error: 'Missing taskId or from' });

        const pending = _pendingTasks.get(taskId);

        // ── Process ping (agent alive, no status change) ──
        if (body.type === 'ping') {
          if (pending) {
            resetIdleTimer(taskId);
            // Touch control plane to prevent stuck detector
            reportTaskToControlPlane('update', { id: taskId, status: 'running' });
          }
          return sendJson(res, 200, { status: 'ping-ack' });
        }

        // ── Progress ──
        if (status === 'working' || progress) {
          if (pending) {
            resetIdleTimer(taskId);
            // Update to running on first progress/heartbeat
            reportTaskToControlPlane('update', { id: taskId, status: 'running' });
          }
          if (progress?.message === '_heartbeat') return sendJson(res, 200, { status: 'heartbeat-ack' });

          if (pending) {
            const cb = coordinatorCallbacks.get(pending.coordinatorSessionKey);
            if (cb) cb({ taskId, targetName: from, text: progress?.message || result || '', _isProgress: true });
          }
          return sendJson(res, 200, { status: 'progress-ack' });
        }

        // ── Final result ──
        const cleaned = cleanupTask(taskId);
        _logger.info(`[armada-control] Result for ${taskId} from ${from}: ${status}`);
        reportTaskToControlPlane('update', {
          id: taskId,
          status: status === 'failed' ? 'failed' : 'completed',
          result: (result || error || '').slice(0, 1000),
        });
        sendJson(res, 200, { status: 'received' });

        if (!cleaned) {
          _logger.warn(`[armada-control] No pending task found for ${taskId} — result dropped`);
          return;
        }

        // Decode attachments to workspace armada-downloads dir (allowed by message tool)
        const attachmentPaths: string[] = [];
        if (body.attachments?.length) {
          const { mkdirSync, writeFileSync } = require('node:fs');
          const workspaceDir = process.env.WORKSPACE_DIR || `${process.env.HOME || '/home/node'}/.openclaw/workspace`;
          const dlDir = `${workspaceDir}/armada-downloads`;
          mkdirSync(dlDir, { recursive: true });
          const mimeToExt: Record<string, string> = {
            'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif',
            'image/webp': '.webp', 'audio/mpeg': '.mp3', 'audio/ogg': '.ogg',
            'video/mp4': '.mp4', 'application/pdf': '.pdf',
          };
          for (const att of body.attachments) {
            const ext = mimeToExt[att.mimeType] || '';
            const fname = att.filename || `${Date.now()}${ext}`;
            const p = `${dlDir}/${fname}`;
            writeFileSync(p, Buffer.from(att.bytes, 'base64'));
            attachmentPaths.push(p);
            _logger.info(`[armada-control] Decoded attachment → ${p} (${att.mimeType})`);
          }
        }

        const resultBody = status === 'failed'
          ? `⚠️ Task failed: ${error || 'Unknown error'}`
          : (result || '(no result)');
        const attachmentInfo = attachmentPaths.length > 0
          ? `\n\nAttachments saved: ${attachmentPaths.join(', ')}`
          : '';

        // Check for parent coordinator callback (sub-task result)
        const parentCb = coordinatorCallbacks.get(cleaned.originSessionKey);
        if (parentCb) {
          _logger.info(`[armada-control] Delivering sub-task ${taskId} result to parent coordinator ${cleaned.originSessionKey}`);
          parentCb({ taskId, targetName: from, text: resultBody + attachmentInfo, error: status === 'failed' ? (error || 'Unknown error') : undefined });
          return;
        }

        // Top-level task — inject into coordinator session
        try {
          await injectIntoCoordinatorSession(taskId, cleaned, resultBody + attachmentInfo, from, attachmentPaths);
        } catch (err: any) {
          _logger.error(`[armada-control] Coordinator session failed: ${err.message}`);
          // Fallback: send result directly to user's channel
          if (cleaned.channel && cleaned.to) {
            try {
              const fallbackMsg = status === 'failed'
                ? `⚠️ Task failed on ${from}: ${error || 'Unknown error'}`
                : `✅ **${from}** completed:\n${result || '(no result)'}`;
              await callGatewayRpc(_api, 'send', {
                message: fallbackMsg,
                channel: cleaned.channel,
                to: cleaned.to,
                threadId: cleaned.threadId,
                idempotencyKey: `armada-result-fallback-${taskId}`,
              });
              _logger.info(`[armada-control] Result for ${taskId} sent via fallback 'send'`);
            } catch (fallbackErr: any) {
              _logger.error(`[armada-control] Fallback send also failed: ${fallbackErr.message}`);
            }
          }
        }
      },
    });
  }

  // ── Armada notification endpoint (gate notifications, completions, failures) ──
  if (typeof api.registerHttpRoute === 'function') {
    api.registerHttpRoute({
      auth: 'plugin',
      path: '/armada/notify',
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        const body = await readBody(req);
        const { event, workflowName, runId, stepId, previousOutput } = body;

        if (!event || !runId) return sendJson(res, 400, { error: 'Missing event or runId' });

        let message: string;
        if (event === 'workflow.gate') {
          const preview = previousOutput && previousOutput.length > 500
            ? previousOutput.slice(0, 500) + '...'
            : previousOutput || '';
          message = [
            `[armada NOTIFICATION] Workflow gate reached.`,
            `⏸️ Workflow "${workflowName || 'unknown'}" paused at gate "${stepId || 'unknown'}"`,
            `Run ID: ${runId}`,
            preview ? `\nPrevious step output:\n${preview}` : '',
            `\nReview the output and approve with: armada_workflow_run_approve(runId="${runId}", stepId="${stepId}")`,
            `Or ask Chris if you're unsure.`,
          ].filter(Boolean).join('\n');
        } else if (event === 'workflow.completed') {
          message = `[armada NOTIFICATION] ✅ Workflow "${workflowName || 'unknown'}" completed. Run ID: ${runId}`;
        } else if (event === 'workflow.failed') {
          message = `[armada NOTIFICATION] ❌ Workflow "${workflowName || 'unknown'}" failed. Run ID: ${runId}. Check the run for details.`;
        } else {
          message = `[armada NOTIFICATION] Event: ${event}. ${JSON.stringify(body)}`;
        }

        try {
          await callGatewayRpc(_api, 'agent', {
            sessionKey: 'agent:main:main',
            message,
            deliver: true,
            bestEffortDeliver: true,
            idempotencyKey: `armada-notify-${runId}-${stepId || event}`,
          }, 30_000);
          _logger.info(`[armada-control] Notification delivered: ${event} for run ${runId}`);
          sendJson(res, 200, { status: 'delivered' });
        } catch (err: any) {
          _logger.error(`[armada-control] Notification delivery failed: ${err.message}`);
          sendJson(res, 500, { error: `Delivery failed: ${err.message}` });
        }
      },
    });
  }

  // ── Service lifecycle ─────────────────────────────────────────────

  // Load persisted tasks on startup
  loadPendingTasks();
  cleanupStaleTasks();

  api.registerService({
    id: 'armada-control',
    start: async () => {
      _logger.info(`[armada-control] Started — armada API: ${_config!.armadaApiUrl}`);
    },
    stop: async () => {
      for (const [taskId] of _pendingTasks) cleanupTask(taskId);
      _pendingTasks.clear();
      coordinatorCallbacks.clear();
      sessionPendingTasks.clear();
      _logger.info(`[armada-control] Stopped`);
    },
  });
}
