/**
 * AgentMessageService — encapsulates message dispatch and polling logic
 * for sending messages (and nudges) to fleet agents.
 *
 * Extracted from agent-manager.ts so that AgentManager stays focused on
 * lifecycle concerns and the route handler stays a thin wrapper.
 */

import { randomBytes } from 'node:crypto';
import { agentsRepo, instancesRepo, tasksRepo } from '../repositories/index.js';
import { logActivity } from './activity-service.js';
import { waitForNudge } from './nudge-resolver.js';
import { getNodeClient } from '../infrastructure/node-client.js';
import type { Agent } from '@coderage-labs/armada-shared';

// ── Types ──────────────────────────────────────────────────────────

export interface SendMessageOptions {
  timeoutMs?: number;
  callerName?: string;
  callerRole?: string;
}

export interface SendMessageResult {
  response: string | null;
  error: string | null;
  duration: number;
}

export interface NudgeResult {
  status: 'ok' | 'error' | 'timeout';
  response?: string | null;
  error?: string;
  duration: number;
}

// ── Helpers ─────────────────────────────────────────────────────────

function resolveAgentRelay(agent: Agent): { containerName: string; nodeId: string } {
  if (!agent.instanceId) {
    throw Object.assign(new Error(`Agent ${agent.name} has no instanceId`), { statusCode: 400 });
  }
  const instance = instancesRepo.getById(agent.instanceId);
  if (!instance?.nodeId) {
    throw Object.assign(new Error(`Instance for agent ${agent.name} has no nodeId`), { statusCode: 400 });
  }
  return { containerName: `armada-instance-${instance.name}`, nodeId: instance.nodeId };
}

function requireRunningAgent(agentName: string): Agent {
  const agent = agentsRepo.getAll().find((a) => a.name === agentName);
  if (!agent) throw Object.assign(new Error('Agent not found'), { statusCode: 404 });
  if (agent.status !== 'running') {
    throw Object.assign(
      new Error(`Agent "${agent.name}" is not running (status: ${agent.status})`),
      { statusCode: 400 },
    );
  }
  return agent;
}

// ── sendMessage ─────────────────────────────────────────────────────

/**
 * Send a message to a running agent via its `/fleet/task` endpoint and
 * poll the tasks DB for a response. Returns the response or an error.
 */
export async function sendMessage(
  agentName: string,
  message: string,
  opts: SendMessageOptions = {},
): Promise<SendMessageResult> {
  const agent = requireRunningAgent(agentName);

  const timeoutMs = Math.min(Math.max(opts.timeoutMs ?? 30_000, 5_000), 120_000);
  const taskId = `msg-${Date.now()}-${randomBytes(3).toString('hex')}`;
  const operatorName = opts.callerName || process.env.FLEET_OPERATOR_NAME || 'system';
  const controlPlaneUrl = process.env.FLEET_API_URL || 'http://armada-control:3001';
  const { containerName, nodeId } = resolveAgentRelay(agent);

  tasksRepo.create({
    id: taskId,
    fromAgent: operatorName,
    toAgent: agent.name,
    taskText: message,
    result: null,
    status: 'pending',
  });

  const startTime = Date.now();

  // Dispatch via node relay (routes through node agent → container)
  try {
    const node = getNodeClient(nodeId);
    const body = JSON.stringify({
      taskId,
      from: operatorName,
      fromRole: opts.callerRole ?? 'operator',
      message,
      callbackUrl: `${controlPlaneUrl}/api/tasks/${taskId}/result`,
    });

    const resp = await node.relayRequest(containerName, 'POST', '/fleet/task', body) as any;
    const status = resp?.statusCode ?? resp?.status ?? 200;

    if (status >= 400) {
      const errText = typeof resp === 'string' ? resp : JSON.stringify(resp);
      tasksRepo.update(taskId, { status: 'failed', result: `Dispatch failed: ${status} ${errText}` });
      logActivity({ eventType: 'agent.message', agentName: agent.name, detail: `Message dispatch failed: ${status}` });
      return { response: null, error: `Agent returned ${status}`, duration: Date.now() - startTime };
    }
  } catch (err: any) {
    tasksRepo.update(taskId, { status: 'failed', result: `Dispatch error: ${err.message}` });
    logActivity({ eventType: 'agent.message', agentName: agent.name, detail: `Message dispatch failed: ${err.message}` });
    return { response: null, error: `Failed to reach agent: ${err.message}`, duration: Date.now() - startTime };
  }

  // Poll DB for task completion
  const pollInterval = 500;
  const deadline = startTime + timeoutMs;
  const result = await new Promise<string | null>((resolve) => {
    const check = () => {
      const task = tasksRepo.getById(taskId);
      if (task && (task.status === 'completed' || task.status === 'failed')) {
        resolve(task.result || null);
        return;
      }
      if (Date.now() >= deadline) { resolve(null); return; }
      setTimeout(check, pollInterval);
    };
    check();
  });

  const duration = Date.now() - startTime;
  if (result === null) {
    logActivity({ eventType: 'agent.message', agentName: agent.name, detail: 'Message timed out' });
    return { response: null, error: 'timeout', duration };
  }

  logActivity({ eventType: 'agent.message', agentName: agent.name, detail: `Message response (${duration}ms)` });
  return { response: result, error: null, duration };
}

// ── nudge ────────────────────────────────────────────────────────────

/**
 * Send a lightweight health-check nudge to a running agent and wait for
 * a response. Returns status, response text, and elapsed time.
 */
export async function nudgeAgent(
  agentName: string,
  message?: string,
  timeoutMs?: number,
  callerName?: string,
): Promise<NudgeResult> {
  const agent = requireRunningAgent(agentName);

  const nudgeMessage = message ||
    'Report your current status briefly: what are you working on, any issues, how much memory are you using?';
  const taskId = `nudge-${Date.now()}-${randomBytes(3).toString('hex')}`;
  const resolvedCaller = callerName || process.env.FLEET_OPERATOR_NAME || 'system';
  const controlPlaneUrl = process.env.FLEET_API_URL || 'http://armada-control:3001';
  const { containerName, nodeId } = resolveAgentRelay(agent);

  // Record task in DB
  tasksRepo.create({
    id: taskId,
    fromAgent: resolvedCaller,
    toAgent: agent.name,
    taskText: nudgeMessage,
    result: null,
    status: 'pending',
  });

  const startTime = Date.now();

  // Dispatch via node relay (routes through node agent → container)
  try {
    const node = getNodeClient(nodeId);
    const body = JSON.stringify({
      taskId,
      from: resolvedCaller,
      fromRole: 'operator',
      message: nudgeMessage,
      callbackUrl: `${controlPlaneUrl}/api/tasks/${taskId}/result`,
    });

    const resp = await node.relayRequest(containerName, 'POST', '/fleet/task', body) as any;
    const status = resp?.statusCode ?? resp?.status ?? 200;

    if (status >= 400) {
      const errText = typeof resp === 'string' ? resp : JSON.stringify(resp);
      tasksRepo.update(taskId, { status: 'failed', result: `Dispatch failed: ${status} ${errText}` });
      logActivity({ eventType: 'agent.nudge', agentName: agent.name, detail: `Nudge failed: dispatch error ${status}` });
      return { status: 'error', error: `Agent returned ${status}`, duration: Date.now() - startTime };
    }
  } catch (err: any) {
    tasksRepo.update(taskId, { status: 'failed', result: `Dispatch error: ${err.message}` });
    logActivity({ eventType: 'agent.nudge', agentName: agent.name, detail: `Nudge failed: ${err.message}` });
    return { status: 'error', error: `Failed to reach agent: ${err.message}`, duration: Date.now() - startTime };
  }

  // Wait for the callback to resolve the nudge
  const effectiveTimeout = timeoutMs ?? 30_000;
  const result = await waitForNudge(taskId, effectiveTimeout);
  const duration = Date.now() - startTime;

  if (result === null) {
    tasksRepo.update(taskId, { status: 'completed', result: 'Nudge timed out (no response within 30s)' });
    logActivity({ eventType: 'agent.nudge', agentName: agent.name, detail: 'Nudge timed out' });
    return { status: 'timeout', response: null, duration };
  }

  logActivity({ eventType: 'agent.nudge', agentName: agent.name, detail: `Nudge response: ${result.slice(0, 120)}` });
  return { status: 'ok', response: result, duration };
}
