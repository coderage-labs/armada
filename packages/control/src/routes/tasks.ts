import { Router } from 'express';
import { requireScope } from '../middleware/scopes.js';
import { randomBytes } from 'node:crypto';
import { agentsRepo, commentsRepo, instancesRepo, nodesRepo, tasksRepo } from '../repositories/index.js';
import { getNodeClient } from '../infrastructure/node-client.js';
import { getDrizzle } from '../db/drizzle.js';
import { tasks } from '../db/drizzle-schema.js';
import { eq } from 'drizzle-orm';
import { setupSSE } from '../utils/sse.js';
import { registerToolDef } from '../utils/tool-registry.js';
import { logActivity } from '../services/activity-service.js';
import { logAudit } from '../services/audit.js';
import { isNudgeTask, resolveNudge } from '../services/nudge-resolver.js';
import { dispatchWebhook } from '../services/webhook-dispatcher.js';
import { checkAndDispatch, onTaskCompleted } from '../services/task-dispatcher.js';
import { checkWorkflowStep } from '../services/workflow-dispatcher.js';
import { taskManager } from '../services/task-manager.js';
import { eventBus } from '../infrastructure/event-bus.js';
import type { MeshTask, TaskComment, BoardColumn, TaskType, TaskPayload } from '@coderage-labs/armada-shared';

// ── SSE event bus ────────────────────────────────────────────────────

type TaskEventType = 'task:created' | 'task:updated' | 'task:comment';
type TaskListener = (event: TaskEventType, data: any) => void;

const listeners = new Set<TaskListener>();

export function emitTaskEvent(event: TaskEventType, data: any) {
  for (const listener of listeners) {
    try {
      listener(event, data);
    } catch (err: any) {
      console.warn('[tasks] listener threw:', err.message);
    }
  }
  dispatchWebhook(event, data);
}

// ── Routes ───────────────────────────────────────────────────────────

const router = Router();

// GET /api/tasks — list recent tasks
router.get('/', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit as string, 10) || 50, 200);
  const agent = req.query.agent as string | undefined;
  const status = req.query.status as string | undefined;

  let tasks: MeshTask[];
  if (agent) {
    tasks = tasksRepo.getByAgent(agent, limit);
  } else if (status) {
    tasks = tasksRepo.getByStatus(status, limit);
  } else {
    tasks = tasksRepo.getRecent(limit);
  }

  res.json(tasks);
});

// GET /api/tasks/stream — SSE endpoint
router.get('/stream', (req, res) => {
  const sse = setupSSE(res);

  const listener: TaskListener = (event, task) => {
    sse.send(event, task);
  };
  listeners.add(listener);

  // Send heartbeat every 30s to keep connection alive
  const heartbeat = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch (err: any) {
      console.warn('[tasks] heartbeat write failed:', err.message);
    }
  }, 30_000);

  req.on('close', () => {
    listeners.delete(listener);
    clearInterval(heartbeat);
  });
});

// GET /api/tasks/:id — get task detail
router.get('/:id', (req, res) => {
  const task = tasksRepo.getById(req.params.id);
  if (!task) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }
  res.json(task);
});

const VALID_TASK_TYPES: TaskType[] = ['code_change', 'review', 'research', 'deployment', 'test', 'generic'];

// POST /api/tasks — record a new task
router.post('/', requireScope('tasks:write'), (req, res) => {
  const { id, fromAgent, toAgent, taskText, status, projectId, githubIssueUrl, githubIssueNumber, boardColumn, type: taskTypeRaw, payload: taskPayloadRaw } = req.body;
  if (!fromAgent || !taskText) {
    res.status(400).json({ error: 'fromAgent and taskText are required' });
    return;
  }

  // Validate task type
  const taskType: TaskType = VALID_TASK_TYPES.includes(taskTypeRaw) ? taskTypeRaw : 'generic';

  // Validate and build payload
  let taskPayload: TaskPayload | null = null;
  if (taskPayloadRaw && typeof taskPayloadRaw === 'object') {
    taskPayload = { type: taskType, description: taskPayloadRaw.description || taskText, metadata: taskPayloadRaw.metadata };
  }

  // Auto-set board column when task belongs to a project
  const effectiveColumn = boardColumn || (projectId ? 'queued' : undefined);

  const task = tasksRepo.create({
    ...(id ? { id } : {}),
    fromAgent,
    toAgent: toAgent || '',
    taskText,
    result: null,
    status: status || 'pending',
    taskType,
    taskPayload,
    ...(projectId ? { projectId } : {}),
    ...(githubIssueUrl ? { githubIssueUrl } : {}),
    ...(githubIssueNumber != null ? { githubIssueNumber } : {}),
    ...(effectiveColumn ? { boardColumn: effectiveColumn } : {}),
  });

  emitTaskEvent('task:created', task);
  eventBus.emit('task.created', { taskId: task.id, projectId: task.projectId ?? null, agentName: task.toAgent, summary: task.taskText.slice(0, 120) });
  logActivity({ eventType: 'task.created', agentName: toAgent, detail: `Task from ${fromAgent}: ${taskText.slice(0, 120)}` });
  logAudit(req, 'task.create', 'task', task.id, { fromAgent, toAgent });
  res.status(201).json(task);

  // Auto-dispatch if created directly into 'queued' with a project
  if (boardColumn === 'queued' && projectId) {
    checkAndDispatch(projectId).catch(() => {});
  }
});

// PUT /api/tasks/:id — update task status
router.put('/:id', requireScope('tasks:write'), async (req, res) => {
  const { status, result, completedAt } = req.body;
  if (status === 'completed' || status === 'failed') {
    console.log(`📝 PUT /tasks/${req.params.id} status=${status} from=${req.ip} body=${JSON.stringify(req.body).slice(0, 200)}`);
  }

  // For terminal statuses, delegate to TaskManager for consolidated side effects
  if (status === 'completed' || status === 'failed') {
    const task = await taskManager.completeTask(req.params.id, status, result);
    if (!task) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }
    logAudit(req, 'task.update', 'task', req.params.id, { status });
    res.json(task);
    return;
  }

  // Non-terminal status updates — keep inline
  const updates: Partial<MeshTask> = {};
  if (status) updates.status = status;
  if (result !== undefined) updates.result = result;
  if (completedAt) updates.completedAt = completedAt;

  const task = tasksRepo.update(req.params.id, updates);
  if (!task) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }

  emitTaskEvent('task:updated', task);
  if (status) {
    eventBus.emit('task.status', { taskId: task.id, status: task.status, agentName: task.toAgent });
  }
  logAudit(req, 'task.update', 'task', req.params.id, { status });
  res.json(task);
});

// POST /api/tasks/:id/result — callback endpoint for armada-agent task results
router.post('/:id/result', requireScope('tasks:write'), async (req, res) => {
  const { status: taskStatus, result, message: resultMessage, error: resultError, from, progress } = req.body;

  // Process ping — agent alive signal (touch status to prevent stuck detector)
  if (req.body.type === 'ping') {
    // Touch status to itself to update the row (SQLite does not change if same value)
    getDrizzle().update(tasks).set({ status: 'running' }).where(eq(tasks.id, req.params.id)).run();
    res.json({ ok: true, ack: 'ping' });
    return;
  }

  // Heartbeat / progress updates — touch record, don't change status
  if (taskStatus === 'working' || progress) {
    getDrizzle().update(tasks).set({ status: 'running' }).where(eq(tasks.id, req.params.id)).run();
    res.json({ ok: true, ack: 'progress' });
    return;
  }

  const finalStatus = taskStatus === 'error' || resultError ? 'failed' : 'completed';
  console.log(`📬 POST /tasks/${req.params.id}/result status=${taskStatus} finalStatus=${finalStatus} from=${from || req.ip}`);
  const finalResult = result || resultMessage || resultError || '';

  // Delegate to TaskManager for consolidated side effects
  const task = await taskManager.completeTask(req.params.id, finalStatus, finalResult);
  if (!task) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }

  res.json({ ok: true });
});

// POST /api/tasks/:id/unblock — unblock a blocked task
router.post('/:id/unblock', requireScope('tasks:write'), (req, res) => {
  const task = tasksRepo.getById(req.params.id);
  if (!task) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }
  if (task.status !== 'blocked') {
    res.status(400).json({ error: `Task is not blocked (status: ${task.status})` });
    return;
  }

  // Determine the status to restore: if it had a result in progress, go to running; otherwise pending
  const restoreStatus = task.result ? 'running' : 'pending';
  const updated = tasksRepo.update(req.params.id, {
    status: restoreStatus,
    blockedReason: undefined,
    blockedAt: undefined,
  });

  if (updated) {
    emitTaskEvent('task:updated', updated);
    logActivity({
      eventType: 'task.unblocked',
      agentName: task.toAgent,
      detail: `Task ${task.id} unblocked → ${restoreStatus} (from ${task.fromAgent})`,
    });
  }

  res.json(updated);
});

// POST /api/tasks/:id/steer — send a steer message to a running agent via its node
router.post('/:id/steer', requireScope('tasks:write'), async (req, res) => {
  const task = tasksRepo.getById(req.params.id);
  if (!task) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }

  // Find the agent handling this task
  const agent = agentsRepo.getAll().find(a => a.name === task.toAgent);
  if (!agent) {
    res.status(404).json({ error: `Agent "${task.toAgent}" not found` });
    return;
  }

  // Resolve the instance and node
  const instance = agent.instanceId ? instancesRepo.getById(agent.instanceId) : null;
  if (!instance) {
    res.status(400).json({ error: `No instance found for agent "${task.toAgent}"` });
    return;
  }
  if (!instance.nodeId) {
    res.status(400).json({ error: `Instance for agent "${task.toAgent}" has no node` });
    return;
  }

  const node = getNodeClient(instance.nodeId);
  const containerName = `armada-instance-${instance.name}`;
  const body = {
    taskId: task.id,
    message: req.body.message,
    from: req.body.from || 'operator',
  };

  try {
    const result = await node.relayRequest(containerName, 'POST', '/armada/steer', body);
    logActivity({
      eventType: 'task.steered',
      agentName: task.toAgent,
      detail: `Steer sent to task ${task.id}: ${String(req.body.message).slice(0, 120)}`,
    });
    res.json({ ok: true, result });
  } catch (err: any) {
    res.status(502).json({ error: `Failed to relay steer: ${err.message}` });
  }
});

// PUT /api/tasks/:id/board-column — move a task to a different board column
router.put('/:id/board-column', requireScope('tasks:write'), (req, res) => {
  const { column } = req.body;
  const validColumns: BoardColumn[] = ['backlog', 'queued', 'in-progress', 'review', 'done'];
  if (!column || !validColumns.includes(column)) {
    res.status(400).json({ error: `column must be one of: ${validColumns.join(', ')}` });
    return;
  }
  const task = tasksRepo.updateBoardColumn(req.params.id, column as BoardColumn);
  if (!task) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }
  emitTaskEvent('task:updated', task);
  res.json(task);

  // Auto-dispatch when a card moves to 'queued'
  if (column === 'queued' && task.projectId) {
    checkAndDispatch(task.projectId).catch(() => {});
  }
});

// POST /api/tasks/send — send a task to a running agent
router.post('/send', requireScope('tasks:write'), async (req, res) => {
  const { target, message } = req.body;
  if (!target || !message) {
    res.status(400).json({ error: 'target and message are required' });
    return;
  }

  // Find the agent
  const allAgents = agentsRepo.getAll();
  const agent = allAgents.find(a => a.name === target);
  if (!agent) {
    res.status(404).json({ error: `Agent "${target}" not found` });
    return;
  }
  if (agent.status !== 'running') {
    res.status(400).json({ error: `Agent "${target}" is not running (status: ${agent.status})` });
    return;
  }

  // Resolve relay path for agent
  if (!agent.instanceId) {
    res.status(400).json({ error: `Agent "${target}" has no instanceId` });
    return;
  }
  const instance = instancesRepo.getById(agent.instanceId);
  if (!instance?.nodeId) {
    res.status(400).json({ error: `Instance for agent "${target}" has no nodeId` });
    return;
  }
  const containerName = `armada-instance-${instance.name}`;
  const taskId = `ft-${Date.now()}-${randomBytes(4).toString('hex')}`;
  const controlPlaneUrl = process.env.ARMADA_API_URL || `http://armada-control:3001`;

  // Record task in DB immediately
  const callerName = req.caller?.name || process.env.ARMADA_OPERATOR_NAME || 'system';
  const sendTaskType: TaskType = VALID_TASK_TYPES.includes(req.body.type) ? req.body.type : 'generic';
  const task = tasksRepo.create({
    id: taskId,
    fromAgent: callerName,
    toAgent: target,
    taskText: message,
    result: null,
    status: 'pending',
    taskType: sendTaskType,
  });
  emitTaskEvent('task:created', task);

  // Dispatch via node relay
  try {
    const node = getNodeClient(instance.nodeId);
    const body = JSON.stringify({
      taskId,
      from: callerName,
      fromRole: req.caller?.role || 'operator',
      message,
      callbackUrl: `${controlPlaneUrl}/api/tasks/${taskId}/result`,
    });

    const resp = await node.relayRequest(containerName, 'POST', '/armada/task', body) as any;
    const status = resp?.statusCode ?? resp?.status ?? 200;

    if (status >= 400) {
      tasksRepo.update(taskId, { status: 'failed', result: `Dispatch failed: ${status}` });
      const updated = tasksRepo.getById(taskId);
      if (updated) emitTaskEvent('task:updated', updated);
      res.status(502).json({ error: `Agent returned ${status}`, taskId });
      return;
    }

    logAudit(req, 'task.send', 'task', taskId, { target });
    res.status(201).json({ taskId, status: 'pending' });
  } catch (err: any) {
    tasksRepo.update(taskId, { status: 'failed', result: `Dispatch error: ${err.message}` });
    const updated = tasksRepo.getById(taskId);
    if (updated) emitTaskEvent('task:updated', updated);
    res.status(502).json({ error: `Failed to reach agent: ${err.message}`, taskId });
  }
});

// DELETE /api/tasks/:id — delete a task (e.g. moving back to backlog)
router.delete('/:id', requireScope('tasks:write'), (req, res) => {
  const task = tasksRepo.getById(req.params.id);
  if (!task) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }
  tasksRepo.remove(req.params.id);
  emitTaskEvent('task:updated', { ...task, _deleted: true });
  logActivity({
    eventType: 'task.deleted',
    agentName: task.toAgent || task.fromAgent,
    detail: `Task ${task.id} deleted (moved back to backlog)`,
  });
  res.status(204).send();
});

// ── Comment routes ───────────────────────────────────────────────────

// GET /api/tasks/:id/comments — list comments for a task
router.get('/:id/comments', (req, res) => {
  const task = tasksRepo.getById(req.params.id);
  if (!task) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }
  res.json(commentsRepo.getByTask(req.params.id));
});

// POST /api/tasks/:id/comments — add a comment
router.post('/:id/comments', requireScope('tasks:write'), (req, res) => {
  const task = tasksRepo.getById(req.params.id);
  if (!task) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }
  const { author, content } = req.body;
  if (!author || !content) {
    res.status(400).json({ error: 'author and content are required' });
    return;
  }
  const comment = commentsRepo.create({ taskId: req.params.id, author, content });
  emitTaskEvent('task:comment', { taskId: req.params.id, comment });
  res.status(201).json(comment);
});

// DELETE /api/tasks/:id/comments/:commentId — delete a comment
router.delete('/:id/comments/:commentId', requireScope('tasks:write'), (req, res) => {
  commentsRepo.delete(req.params.commentId);
  res.json({ ok: true });
});

// ── Tool definitions ─────────────────────────────────────────────────

registerToolDef({
  name: 'armada_tasks_list',
  description: 'List recent armada tasks with optional filtering by agent or status',
  method: 'GET',
  path: '/api/tasks',
  parameters: [
    { name: 'limit', type: 'number', description: 'Max tasks to return (default 50, max 200)' },
    { name: 'agent', type: 'string', description: 'Filter tasks by agent name (from or to)' },
    { name: 'status', type: 'string', description: 'Filter by status', enum: ['pending', 'running', 'completed', 'failed', 'blocked'] },
  ],
});

registerToolDef({
  name: 'armada_task_detail',
  description: 'Get details of a specific armada task',
  method: 'GET',
  path: '/api/tasks/:id',
  parameters: [
    { name: 'id', type: 'string', description: 'Task ID', required: true },
  ],
});

registerToolDef({
  name: 'armada_task_create',
  description: 'Record a new armada task',
  method: 'POST',
  path: '/api/tasks',
  parameters: [
    { name: 'fromAgent', type: 'string', description: 'Sending agent name', required: true },
    { name: 'toAgent', type: 'string', description: 'Receiving agent name', required: true },
    { name: 'taskText', type: 'string', description: 'Task description', required: true },
    { name: 'status', type: 'string', description: 'Initial status (default: pending)', enum: ['pending', 'running'] },
    { name: 'type', type: 'string', description: 'Task type for routing and display', enum: ['code_change', 'review', 'research', 'deployment', 'test', 'generic'] },
    { name: 'payload', type: 'string', description: 'Structured task payload as JSON (type-specific metadata)' },
  ],
});

registerToolDef({
  name: 'armada_task_update',
  description: 'Update a armada task status',
  method: 'PUT',
  path: '/api/tasks/:id',
  parameters: [
    { name: 'id', type: 'string', description: 'Task ID', required: true },
    { name: 'status', type: 'string', description: 'New status', enum: ['pending', 'running', 'completed', 'failed', 'blocked'] },
    { name: 'result', type: 'string', description: 'Task result text' },
  ],
});

registerToolDef({
  name: 'armada_task_unblock',
  description: 'Unblock a blocked task, restoring it to pending or running',
  method: 'POST',
  path: '/api/tasks/:id/unblock',
  parameters: [
    { name: 'id', type: 'string', description: 'Task ID', required: true },
  ],
});

registerToolDef({
  name: 'armada_task_comments_list',
  description: 'List comments/annotations on a armada task',
  method: 'GET',
  path: '/api/tasks/:id/comments',
  parameters: [
    { name: 'id', type: 'string', description: 'Task ID', required: true },
  ],
});

registerToolDef({
  name: 'armada_task_comment_add',
  description: 'Add a comment/annotation to a armada task',
  method: 'POST',
  path: '/api/tasks/:id/comments',
  parameters: [
    { name: 'id', type: 'string', description: 'Task ID', required: true },
    { name: 'author', type: 'string', description: 'Author name (user or agent)', required: true },
    { name: 'content', type: 'string', description: 'Comment text', required: true },
  ],
});

registerToolDef({
  name: 'armada_task_comment_delete',
  description: 'Delete a comment from a armada task',
  method: 'DELETE',
  path: '/api/tasks/:id/comments/:commentId',
  parameters: [
    { name: 'id', type: 'string', description: 'Task ID', required: true },
    { name: 'commentId', type: 'string', description: 'Comment ID to delete', required: true },
  ],
});

export default router;
