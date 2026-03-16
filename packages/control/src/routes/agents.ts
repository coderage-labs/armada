import { Router } from 'express';
import { instancesRepo } from '../repositories/index.js';
import { mutationService } from '../services/mutation-service.js';
import { workingCopy } from '../services/working-copy.js';
import { setupSSE } from '../utils/sse.js';
import { registerToolDef } from '../utils/tool-registry.js';
import { logActivity } from '../services/activity-service.js';
import { onHealthChange, getAllAgentCapacity } from '../services/health-monitor.js';
import { instanceManager } from '../services/instance-manager.js';
import { serveAvatar, getAvatarStatus, startAvatarGeneration, removeAvatar } from '../services/agent-avatar-service.js';
import { eventBus } from '../infrastructure/event-bus.js';
import { getNodeClient, WsNodeClient } from '../infrastructure/node-client.js';
import { commandDispatcher } from '../ws/command-dispatcher.js';
import { nodeConnectionManager } from '../ws/node-connections.js';
import { agentManager } from '../services/agent-manager.js';
import { spawnManager } from '../services/spawn-manager.js';
import { logAudit } from '../services/audit.js';
import { requireScope } from '../middleware/scopes.js';
import { resolveInstance } from '../middleware/resolve-instance.js';
import type { Agent, HeartbeatMeta } from '@coderage-labs/armada-shared';
import type { NodeManager } from '../node-manager.js';

export function createAgentRoutes(nodeManager: NodeManager): Router {
  const router = Router();

  // Inject NodeManager into service singletons
  agentManager.setNodeManager(nodeManager);
  spawnManager.setNodeManager(nodeManager);

  // ── Tool definitions (auto-discovered by armada-control plugin) ────

  registerToolDef({
    name: 'armada_status',
    description: 'Check the status of all armada instances. Shows which agents are running and available for armada_task.',
    method: 'GET', path: '/api/agents',
    parameters: [],
  });

  registerToolDef({
    name: 'armada_spawn',
    description: 'Spawn a new agent from a template. Contact sync runs automatically after spawn.',
    method: 'POST', path: '/api/agents',
    parameters: [
      { name: 'templateId', type: 'string', description: 'Template ID to spawn from', required: true },
      { name: 'name', type: 'string', description: 'Agent name (lowercase, alphanumeric, hyphens)', required: true },
    ],
  });

  registerToolDef({
    name: 'armada_redeploy',
    description: 'Regenerate an agent\'s config, SOUL.md, and AGENTS.md from its template, then restart. Use after template changes. Pass "all" to redeploy every agent.',
    method: 'POST', path: '/api/agents/:name/redeploy',
    parameters: [
      { name: 'target', type: 'string', description: 'Agent name to redeploy, or "all" for every agent', required: true },
    ],
    supportsAll: true,
  });

  registerToolDef({
    name: 'armada_destroy',
    description: 'Destroy a agent — stops and removes its container, deletes the agent record. Contact sync runs automatically after deletion.',
    method: 'DELETE', path: '/api/agents/:name',
    parameters: [
      { name: 'target', type: 'string', description: 'Agent name to destroy', required: true },
    ],
  });

  registerToolDef({
    name: 'armada_logs',
    description: 'Get recent logs from a agent\'s instance container.',
    method: 'GET', path: '/api/agents/:name/logs',
    parameters: [
      { name: 'target', type: 'string', description: 'Agent name', required: true },
      { name: 'tail', type: 'number', description: 'Number of lines (default 50)' },
    ],
    responseFormat: 'text',
  });

  registerToolDef({
    name: 'armada_heartbeat',
    description: 'Send a heartbeat for an agent to indicate it is alive. Optionally include metadata (taskCount, memoryMb, uptimeMs).',
    method: 'POST', path: '/api/agents/:name/heartbeat',
    parameters: [
      { name: 'name', type: 'string', description: 'Agent name', required: true },
      { name: 'taskCount', type: 'number', description: 'Number of active tasks' },
      { name: 'memoryMb', type: 'number', description: 'Memory usage in MB' },
      { name: 'uptimeMs', type: 'number', description: 'Agent uptime in milliseconds' },
    ],
  });

  registerToolDef({
    name: 'armada_nudge',
    description: 'Send a quick health-check nudge to an agent and wait for a response (up to 30s). Returns the agent\'s status reply.',
    method: 'POST', path: '/api/agents/:name/nudge',
    parameters: [
      { name: 'name', type: 'string', description: 'Agent name to nudge', required: true },
      { name: 'message', type: 'string', description: 'Custom nudge message (optional)' },
    ],
  });

  registerToolDef({
    name: 'armada_avatar_generate',
    description: 'Generate an AI avatar image for a agent based on its name and role.',
    method: 'POST', path: '/api/agents/:name/avatar/generate',
    parameters: [
      { name: 'name', type: 'string', description: 'Agent name', required: true },
    ],
  });

  registerToolDef({
    name: 'armada_avatar_delete',
    description: 'Delete the avatar image for a agent.',
    method: 'DELETE', path: '/api/agents/:name/avatar',
    parameters: [
      { name: 'name', type: 'string', description: 'Agent name', required: true },
    ],
  });

  registerToolDef({
    name: 'armada_maintain',
    description: 'Perform graceful maintenance on a agent — drains active tasks, signals graceful restart (SIGUSR1), and waits for the agent to come back healthy. Long-running operation (up to ~2.5 minutes).',
    method: 'POST', path: '/api/agents/:name/maintain',
    parameters: [
      { name: 'target', type: 'string', description: 'Agent name to maintain', required: true },
      { name: 'timeoutMs', type: 'number', description: 'Drain timeout in ms (default 60000)' },
      { name: 'reason', type: 'string', description: 'Maintenance reason (logged in activity)' },
    ],
  });

  registerToolDef({
    name: 'armada_agent_capacity',
    description: 'Get capacity info for all agents — task count, response latency, and health status. Useful for checking agent load.',
    method: 'GET', path: '/api/agents/capacity',
    parameters: [],
  });

  registerToolDef({
    name: 'armada_agent_sessions',
    description: 'Get agent session list',
    method: 'GET', path: '/api/agents/:name/session',
    parameters: [
      { name: 'target', type: 'string', description: 'Agent name', required: true },
    ],
  });

  registerToolDef({
    name: 'armada_agent_session_messages',
    description: 'Get session messages',
    method: 'GET', path: '/api/agents/:name/session/messages',
    parameters: [
      { name: 'target', type: 'string', description: 'Agent name', required: true },
      { name: 'sessionKey', type: 'string', description: 'Session key', required: true },
      { name: 'after', type: 'string', description: 'ISO timestamp cursor — only return messages after this' },
      { name: 'limit', type: 'number', description: 'Max messages to return (default 50, max 200)' },
    ],
  });

  // ── Capacity endpoint ─────────────────────────────────────────────

  router.get('/capacity', (_req, res) => {
    res.json(getAllAgentCapacity());
  });

  // ── Avatar endpoints ─────────────────────────────────────────────

  // GET /api/agents/:name/avatar — serve avatar PNG (no auth required, handled in middleware)
  router.get('/:name/avatar', async (req, res) => {
    try {
      const result = await serveAvatar(req.params.name, (req.query.size as string) || 'lg');
      if (!result.found) { res.status(404).json({ error: 'No avatar found' }); return; }
      res.set('Content-Type', result.contentType);
      res.set('Cache-Control', result.cacheControl);
      res.send(result.buffer);
    } catch (err: any) {
      console.warn('[agents] Failed to read avatar:', err.message);
      res.status(500).json({ error: 'Failed to read avatar' });
    }
  });

  // GET /api/agents/:name/avatar/status — check if avatar is generating
  router.get('/:name/avatar/status', (req, res) => {
    try {
      res.json(getAvatarStatus(req.params.name));
    } catch (err: any) {
      if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
      res.status(500).json({ error: 'Failed to get avatar status' });
    }
  });

  // POST /api/agents/:name/avatar/generate
  router.post('/:name/avatar/generate', requireScope('agents:write'), (req, res, next) => {
    try {
      res.json(startAvatarGeneration(req.params.name));
    } catch (err: any) {
      if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
      next(err);
    }
  });

  // DELETE /api/agents/:name/avatar
  router.delete('/:name/avatar', requireScope('agents:write'), async (req, res, next) => {
    try {
      res.json(await removeAvatar(req.params.name));
    } catch (err: any) {
      if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
      next(err);
    }
  });

  // ── Agent health SSE stream ──────────────────────────────────────

  router.get('/health/stream', (req, res) => {
    const sse = setupSSE(res);
    const unsubscribe = onHealthChange((agentName, oldStatus, newStatus) => {
      sse.send('health:change', { agent: agentName, oldStatus, newStatus, timestamp: new Date().toISOString() });
    });
    req.on('close', () => unsubscribe());
  });

  // ── Agent events SSE stream ──────────────────────────────────────

  router.get('/stream', (req, res) => {
    const sse = setupSSE(res);
    const unsubscribe = eventBus.on('agent.*', (armadaEvent) => {
      sse.send(armadaEvent.event, armadaEvent.data, armadaEvent.id);
    });
    req.on('close', () => unsubscribe());
  });

  // POST /api/agents/:name/heartbeat → agentManager.heartbeat()
  router.post('/:name/heartbeat', requireScope('agents:write'), (req, res, next) => {
    try {
      const { taskCount, memoryMb, uptimeMs, activeTasks } = req.body as Partial<HeartbeatMeta> & { activeTasks?: number };
      agentManager.heartbeat(req.params.name, { taskCount: taskCount ?? activeTasks, memoryMb, uptimeMs });
      res.json({ status: 'ok' });
    } catch (err: any) {
      if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
      next(err);
    }
  });

  // POST /api/agents/:name/nudge → agentManager.nudge()
  router.post('/:name/nudge', requireScope('agents:write'), async (req, res, next) => {
    try {
      const result = await agentManager.nudge(
        req.params.name,
        req.body?.message,
        req.body?.timeoutMs,
        req.caller?.name,
      );
      logAudit(req, 'agent.nudge', 'agent', req.params.name);
      res.json(result);
    } catch (err: any) {
      if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
      next(err);
    }
  });

  // POST /api/agents/:name/message — send a message to an agent and wait for response
  router.post('/:name/message', requireScope('agents:write'), async (req, res, next) => {
    try {
      const { message, timeoutMs } = req.body as { message?: string; timeoutMs?: number };
      if (!message || typeof message !== 'string' || !message.trim()) {
        res.status(400).json({ error: 'message is required' });
        return;
      }
      const result = await agentManager.sendMessage(
        req.params.name,
        message,
        { timeoutMs, callerName: req.caller?.name, callerRole: req.caller?.role },
      );
      res.json(result);
    } catch (err: any) {
      if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
      next(err);
    }
  });

  // POST /api/agents/:name/maintain — graceful maintenance via InstanceManager
  router.post('/:name/maintain', requireScope('agents:write'), async (req, res, next) => {
    try {
      const agent = agentManager.getByName(req.params.name);
      if (!agent) {
        res.status(404).json({ error: 'Agent not found' });
        return;
      }
      if (!agent.instanceId) {
        res.status(400).json({ error: 'Agent has no instance' });
        return;
      }

      const { timeoutMs, reason } = (req.body || {}) as { timeoutMs?: number; reason?: string };

      const operationId = await instanceManager.maintain(agent.instanceId, { reason, timeoutMs });
      logAudit(req, 'agent.maintain', 'agent', req.params.name, { reason });
      res.json({ operationId, instance: agent.instanceId });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/agents — list all agents
  router.get('/', async (_req, res, next) => {
    try {
      res.json(agentManager.getAll());
    } catch (err) {
      next(err);
    }
  });

  // GET /api/agents/:name
  router.get('/:name', async (req, res, next) => {
    try {
      const agent = agentManager.getByName(req.params.name);
      if (!agent) {
        res.status(404).json({ error: 'Agent not found' });
        return;
      }
      res.json(agent);
    } catch (err) {
      next(err);
    }
  });

  // POST /api/agents — stage agent creation via working copy pipeline
  router.post('/', requireScope('agents:write'), async (req, res, next) => {
    try {
      const { templateId, name, projects, instanceId } = req.body;
      if (!templateId || !name) {
        res.status(400).json({ error: 'templateId and name are required' });
        return;
      }
      workingCopy.create('agent', name, { templateId, name, instanceId, projects });
      logAudit(req, 'agent.spawn', 'agent', name, { templateId });
      res.status(201).json({ ok: true, action: 'create', message: 'Staged in working copy' });
    } catch (err: any) {
      if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
      next(err);
    }
  });

  // POST /api/agents/:name/redeploy — stage redeploy via changeset pipeline
  router.post('/:name/redeploy', requireScope('agents:write'), (req, res, next) => {
    try {
      const name = req.params.name;

      if (name === 'all') {
        // Stage redeploy for all agents
        const agents = agentManager.getAll().filter(a => a.status === 'running');
        const mutations = agents.map(a =>
          mutationService.stage('agent', 'update', { redeploy: true }, a.instanceId)
        );
        logAudit(req, 'agent.redeploy_all.staged', 'agent', 'all');
        res.status(202).json({ staged: true, count: agents.length, mutations });
        return;
      }

      const agent = agentManager.getByName(name);
      if (!agent) {
        res.status(404).json({ error: `Agent "${name}" not found` });
        return;
      }
      const mutation = mutationService.stage('agent', 'update', { redeploy: true }, agent.instanceId);
      logAudit(req, 'agent.redeploy.staged', 'agent', name);
      res.status(202).json({ staged: true, mutation });
    } catch (err: any) {
      if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
      next(err);
    }
  });

  // DELETE /api/agents/:name — stage agent deletion via working copy pipeline
  // Query param: ?deleteWorkspace=true — immediately removes workspace data on the node
  router.delete('/:name', requireScope('agents:write'), async (req, res, next) => {
    try {
      const agentName = req.params.name;
      // Capture agent info before staging deletion (needed for immediate workspace deletion)
      const agentBefore = agentManager.getByName(agentName);
      if (!agentBefore) {
        res.status(404).json({ error: `Agent "${agentName}" not found` });
        return;
      }
      workingCopy.delete('agent', agentName);
      logAudit(req, 'agent.destroy', 'agent', agentName);

      // If caller requested immediate workspace deletion, send file.delete now
      if (req.query.deleteWorkspace === 'true') {
        const workspacePath = `workspace/agents/${agentBefore.name}`;
        if (nodeConnectionManager.isOnline(agentBefore.nodeId)) {
          commandDispatcher.send(agentBefore.nodeId, 'file.delete', {
            instance: agentBefore.instanceId,
            path: workspacePath,
            recursive: true,
          }, 30_000).then(() => {
            logActivity({
              eventType: 'workspace.cleaned',
              detail: `Immediately removed workspace for deleted agent "${agentBefore.name}" (user-requested)`,
            });
          }).catch((err: any) => {
            console.warn(`[agents] Failed to immediately delete workspace for ${agentBefore.name}: ${err.message}`);
          });
        }
      }

      res.json({ ok: true, action: 'delete', message: 'Staged in working copy' });
    } catch (err: any) {
      if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
      next(err);
    }
  });

  // GET /api/agents/:name/turns — fetch agent session turns from its OpenClaw gateway
  router.get('/:name/turns', async (req, res, next) => {
    try {
      const agent = agentManager.getByName(req.params.name);
      if (!agent) {
        res.status(404).json({ error: 'Agent not found' });
        return;
      }

      if (!agent.instanceId) {
        res.json({ turns: [], error: 'Agent has no instanceId' });
        return;
      }
      const inst = resolveInstance(agent.instanceId);
      if (!inst?.nodeId) {
        res.json({ turns: [], error: 'Instance has no nodeId' });
        return;
      }
      const containerName = `armada-instance-${inst.name}`;

      try {
        const node = getNodeClient(inst.nodeId);
        const sessionResp = await node.relayRequest(containerName, 'GET', '/api/sessions') as any;
        const status = sessionResp?.statusCode ?? sessionResp?.status ?? 200;

        if (status >= 400) {
          res.json({ turns: [], error: `Agent returned ${status}` });
          return;
        }

        // relayRequest returns parsed JSON body
        const sessions: Array<{ id: string; turns?: Array<{ role: string; content: string; timestamp?: string }> }> =
          Array.isArray(sessionResp) ? sessionResp : (sessionResp?.body ?? []);

        // Flatten all turns from all sessions, newest sessions first
        const turns: Array<{ sessionId: string; role: string; content: string; timestamp?: string }> = [];
        for (const session of sessions) {
          if (Array.isArray(session.turns)) {
            for (const turn of session.turns) {
              turns.push({ sessionId: session.id, ...turn });
            }
          }
        }

        res.json({ turns });
      } catch (fetchErr: any) {
        res.json({ turns: [], error: 'Agent offline' });
      }
    } catch (err) {
      next(err);
    }
  });

  // GET /api/agents/:name/session — list sessions for this agent instance
  router.get('/:name/session', async (req, res, next) => {
    try {
      const agent = agentManager.getByName(req.params.name);
      if (!agent) return res.status(404).json({ error: 'Agent not found' });
      if (!agent.instanceId) return res.json({ sessions: [], error: 'Agent has no instance' });

      const inst = resolveInstance(agent.instanceId);
      if (!inst?.nodeId) return res.json({ sessions: [], error: 'Instance has no node' });

      const containerName = `armada-instance-${inst.name}`;
      const node = getNodeClient(inst.nodeId);

      try {
        const resp = await node.relayRequest(containerName, 'GET', '/armada/session') as any;
        const body = resp?.body ?? resp;
        res.json(body);
      } catch (err: any) {
        res.json({ sessions: [], error: 'Agent offline' });
      }
    } catch (err) { next(err); }
  });

  // GET /api/agents/:name/session/messages — get messages for a specific session
  router.get('/:name/session/messages', async (req, res, next) => {
    try {
      const agent = agentManager.getByName(req.params.name);
      if (!agent) return res.status(404).json({ error: 'Agent not found' });
      if (!agent.instanceId) return res.json({ messages: [], error: 'Agent has no instance' });

      const inst = resolveInstance(agent.instanceId);
      if (!inst?.nodeId) return res.json({ messages: [], error: 'Instance has no node' });

      const containerName = `armada-instance-${inst.name}`;
      const node = getNodeClient(inst.nodeId);

      // Forward query params
      const qs = new URLSearchParams();
      if (req.query.sessionKey) qs.set('sessionKey', req.query.sessionKey as string);
      if (req.query.after) qs.set('after', req.query.after as string);
      if (req.query.limit) qs.set('limit', req.query.limit as string);
      const path = `/armada/session/messages?${qs.toString()}`;

      try {
        const resp = await node.relayRequest(containerName, 'GET', path) as any;
        const body = resp?.body ?? resp;
        res.json(body);
      } catch (err: any) {
        res.json({ messages: [], error: 'Agent offline' });
      }
    } catch (err) { next(err); }
  });

  // GET /api/agents/:name/logs — proxy to instance container logs
  router.get('/:name/logs', async (req, res, next) => {
    try {
      const agent = agentManager.getByName(req.params.name);
      if (!agent) {
        res.status(404).json({ error: 'Agent not found' });
        return;
      }

      if (!agent.instanceId) {
        res.status(400).json({ error: 'Agent has no instance' });
        return;
      }

      const instance = resolveInstance(agent.instanceId);
      if (!instance) {
        res.status(400).json({ error: 'Instance not found' });
        return;
      }

      const tail = parseInt(req.query.tail as string, 10) || 100;
      const containerName = `armada-instance-${instance.name}`;
      const node = instance.nodeId
        ? new WsNodeClient(instance.nodeId)
        : getNodeClient();
      const logs = await node.getContainerLogs(containerName, tail);
      res.type('text/plain').send(logs);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

export default createAgentRoutes;
