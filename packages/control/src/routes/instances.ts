import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';
import { requireScope } from '../middleware/scopes.js';
import { requireUnlocked } from '../middleware/lock-guard.js';
import { resolveInstance } from '../middleware/resolve-instance.js';
import { instancesRepo, agentsRepo } from '../repositories/index.js';
import { registerToolDef } from '../utils/tool-registry.js';
import { getNodeClient } from '../infrastructure/node-client.js';
import { instanceManager } from '../services/instance-manager.js';
import { instanceRemovalService } from '../services/instance-removal.js';
import { spawnManager } from '../services/spawn-manager.js';
import { eventBus } from '../infrastructure/event-bus.js';
import { mutationService } from '../services/mutation-service.js';
import { workingCopy } from '../services/working-copy.js';
import { logAudit } from '../services/audit.js';
import { setupSSE } from '../utils/sse.js';

// ── Tool definitions ────────────────────────────────────────────────

registerToolDef({
  name: 'armada_instance_list',
  description: 'List all armada instances. Shows instance name, node, status, and agent count.',
  method: 'GET', path: '/api/instances',
  parameters: [],
    scope: 'instances:read',
});

registerToolDef({
  name: 'armada_instance_get',
  description: 'Get details of a specific armada instance.',
  method: 'GET', path: '/api/instances/:id',
  parameters: [
    { name: 'id', type: 'string', description: 'Instance ID or name', required: true },
  ],
    scope: 'instances:read',
});

registerToolDef({
  name: 'armada_instance_create',
  description: 'Create a new armada instance.',
  method: 'POST', path: '/api/instances',
  parameters: [
    { name: 'name', type: 'string', description: 'Instance name (lowercase, alphanumeric, hyphens)', required: true },
    { name: 'nodeId', type: 'string', description: 'Node ID to host this instance', required: true },
    { name: 'capacity', type: 'number', description: 'Max number of agents (default: 5)' },
    { name: 'config', type: 'string', description: 'JSON config object' },
    { name: 'url', type: 'string', description: 'Instance gateway URL' },
    { name: 'token', type: 'string', description: 'Authentication token' },
    { name: 'memory', type: 'string', description: 'Container memory limit (e.g. 2g, 512m). Default: 2g' },
    { name: 'cpus', type: 'string', description: 'Container CPU limit (e.g. 1, 0.5). Default: 1' },
  ],
    scope: 'instances:write',
});

registerToolDef({
  name: 'armada_instance_update',
  description: 'Update an existing armada instance.',
  method: 'PUT', path: '/api/instances/:id',
  parameters: [
    { name: 'id', type: 'string', description: 'Instance ID', required: true },
    { name: 'name', type: 'string', description: 'Instance name' },
    { name: 'capacity', type: 'number', description: 'Max number of agents' },
    { name: 'config', type: 'string', description: 'JSON config object' },
    { name: 'url', type: 'string', description: 'Instance gateway URL' },
    { name: 'token', type: 'string', description: 'Authentication token' },
    { name: 'status', type: 'string', description: 'Instance status' },
    { name: 'statusMessage', type: 'string', description: 'Status message' },
  ],
    scope: 'instances:write',
});

registerToolDef({
  name: 'armada_instance_destroy',
  description: 'Destroy a armada instance. Fails if agents are still assigned unless force=true.',
  method: 'DELETE', path: '/api/instances/:id',
  parameters: [
    { name: 'id', type: 'string', description: 'Instance ID to destroy', required: true },
  ],
    scope: 'instances:write',
});

registerToolDef({
  name: 'armada_instance_health',
  description: 'Check health of a instance by pinging its gateway URL.',
  method: 'GET', path: '/api/instances/:id/health',
  parameters: [
    { name: 'id', type: 'string', description: 'Instance ID', required: true },
  ],
    scope: 'instances:read',
});

registerToolDef({
  name: 'armada_logs',
  description: 'Tail logs from an agent instance. Returns recent log lines.',
  method: 'GET',
  path: '/api/instances/:id/logs',
  parameters: [
    { name: 'id', type: 'string', description: 'Instance ID', required: true },
    { name: 'lines', type: 'number', description: 'Number of lines (default 100)' },
    { name: 'level', type: 'string', description: 'Filter by log level (error, warn, info)' },
    { name: 'agent', type: 'string', description: 'Filter by agent name' },
  ],
  scope: 'instances:read',
});

registerToolDef({
  name: 'armada_logs_stream',
  description: 'Stream live logs from an agent instance via SSE.',
  method: 'GET',
  path: '/api/instances/:id/logs/stream',
  parameters: [
    { name: 'id', type: 'string', description: 'Instance ID', required: true },
    { name: 'lines', type: 'number', description: 'Number of initial lines (default 100)' },
    { name: 'level', type: 'string', description: 'Filter by log level (error, warn, info)' },
    { name: 'agent', type: 'string', description: 'Filter by agent name' },
  ],
  scope: 'instances:read',
});

registerToolDef({
  name: 'armada_instance_events',
  description: 'Stream real-time events from an agent instance via SSE. Events include session activity, tool calls, agent status changes, and heartbeats.',
  method: 'GET',
  path: '/api/instances/:id/events/stream',
  parameters: [
    { name: 'id', type: 'string', description: 'Instance ID or name', required: true },
  ],
  scope: 'instances:read',
});

// ── Routes ──────────────────────────────────────────────────────────

const router = Router();

// GET /api/instances — list all instances
router.get('/', (_req, res, next) => {
  try {
    const instances = instancesRepo.getAll();
    res.json(instances);
  } catch (err) { next(err); }
});

// POST /api/instances — create instance
router.post('/', requireScope('instances:write'), async (req, res, next) => {
  try {
    const { name, nodeId, capacity, config, url, token, memory, cpus, templateId, image } = req.body;

    if (!name || typeof name !== 'string') {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    if (!nodeId || typeof nodeId !== 'string') {
      res.status(400).json({ error: 'nodeId is required' });
      return;
    }

    const id = randomUUID();
    workingCopy.create('instance', id, { name, nodeId, capacity, config, url, token, memory, cpus, templateId, image });
    logAudit(req, 'instance.create', 'instance', id, { name, nodeId });
    res.status(200).json({ ok: true, action: 'create', message: 'Staged in working copy' });
  } catch (err: any) {
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    next(err);
  }
});

// GET /api/instances/:id — get instance detail
router.get('/:id', (req, res, next) => {
  try {
    const instance = resolveInstance(req.params.id);
    if (!instance) {
      res.status(404).json({ error: 'Instance not found' });
      return;
    }
    res.json(instance);
  } catch (err) { next(err); }
});

// PUT /api/instances/:id — update instance
//
// Fields are split into two categories:
//   DB-only (applied immediately, no container changes):
//     capacity, drainMode, name, url, token, status, statusMessage
//   Container-affecting (staged via changeset pipeline, require container recreation):
//     cpus, memory, config
router.put('/:id', requireScope('instances:write'), requireUnlocked(req => ({ type: 'instance', id: req.params.id })), (req, res, next) => {
  try {
    const instance = resolveInstance(req.params.id);
    if (!instance) {
      res.status(404).json({ error: 'Instance not found' });
      return;
    }

    const { name, capacity, config, url, token, status, statusMessage, cpus, memory } = req.body;

    if (name && name !== instance.name) {
      const nameConflict = instancesRepo.getByName(name);
      if (nameConflict) {
        res.status(409).json({ error: `Instance with name "${name}" already exists` });
        return;
      }
    }

    // Build the update payload, normalising config if needed
    const updatePayload: Record<string, any> = {};
    if (name !== undefined) updatePayload.name = name;
    if (capacity !== undefined) updatePayload.capacity = capacity;
    if (url !== undefined) updatePayload.url = url;
    if (token !== undefined) updatePayload.token = token;
    if (status !== undefined) updatePayload.status = status;
    if (statusMessage !== undefined) updatePayload.statusMessage = statusMessage;
    if (cpus !== undefined) updatePayload.cpus = cpus;
    if (memory !== undefined) updatePayload.memory = memory;
    if (config !== undefined) {
      updatePayload.config = typeof config === 'string' ? JSON.parse(config) : config;
    }

    workingCopy.update('instance', instance.id, updatePayload);
    logAudit(req, 'instance.update', 'instance', instance.id, { fields: Object.keys(updatePayload) });
    res.json({ ok: true, action: 'update', message: 'Staged in working copy' });
  } catch (err) { next(err); }
});

// DELETE /api/instances/:id — destroy instance (cascading, via operations pipeline)
// Without ?confirm=true, returns an impact assessment (400).
// With ?confirm=true, queues the destruction operation and returns its ID.
router.delete('/:id', requireScope('instances:write'), requireUnlocked(req => ({ type: 'instance', id: req.params.id })), async (req, res, next) => {
  try {
    const instance = resolveInstance(req.params.id);
    if (!instance) {
      res.status(404).json({ error: 'Instance not found' });
      return;
    }

    const impact = instanceRemovalService.assessImpact(instance.id);

    if (req.query.confirm !== 'true') {
      res.status(400).json({
        error: 'Instance destruction requires confirmation',
        impact,
        hint: 'Add ?confirm=true to proceed',
      });
      return;
    }

    // Don't allow duplicate delete staging
    if (instance.status === 'pending_delete') {
      res.json({ ok: true, action: 'delete', message: 'Instance already pending deletion' });
      return;
    }

    workingCopy.delete('instance', instance.id);
    logAudit(req, 'instance.destroy.staged', 'instance', instance.id, { name: instance.name });
    res.json({ ok: true, action: 'delete', message: 'Staged in working copy' });
  } catch (err) { next(err); }
});

// GET /api/instances/:id/health — health check instance gateway
router.get('/:id/health', async (req, res, next) => {
  try {
    const instance = resolveInstance(req.params.id);
    if (!instance) {
      res.status(404).json({ error: 'Instance not found' });
      return;
    }

    if (!instance.nodeId) {
      res.json({ status: 'unknown', message: 'Instance has no nodeId' });
      return;
    }

    try {
      const node = getNodeClient(instance.nodeId);
      const containerName = `armada-instance-${instance.name}`;
      const resp = await node.relayRequest(containerName, 'GET', '/api/health') as any;
      const status = resp?.statusCode ?? resp?.status ?? 200;

      if (status < 400) {
        res.json({ status: 'healthy', data: resp });
      } else {
        res.json({ status: 'unhealthy', error: `HTTP ${status}` });
      }
    } catch (err: any) {
      res.json({ status: 'unhealthy', error: err.message ?? 'Connection failed' });
    }
  } catch (err) { next(err); }
});

// GET /api/instances/:id/agents — list agents in instance
router.get('/:id/agents', (req, res, next) => {
  try {
    const instance = resolveInstance(req.params.id);
    if (!instance) {
      res.status(404).json({ error: 'Instance not found' });
      return;
    }

    const full = instancesRepo.getById(instance.id);
    res.json(full?.agents ?? []);
  } catch (err) { next(err); }
});

// POST /api/instances/:id/agents — spawn agent into specific instance
router.post('/:id/agents', requireScope('instances:write'), async (req, res, next) => {
  try {
    const instance = resolveInstance(req.params.id);
    if (!instance) return res.status(404).json({ error: 'Instance not found' });
    const { templateId, name } = req.body;
    if (!templateId || !name) return res.status(400).json({ error: 'templateId and name required' });
    const { mutation } = await spawnManager.spawn(templateId, name, { instanceId: instance.id });
    res.status(202).json({ staged: true, mutation });
  } catch (err: any) {
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    next(err);
  }
});

// POST /api/instances/:id/upgrade — stage rolling upgrade via changeset pipeline
router.post('/:id/upgrade', requireScope('instances:write'), (req, res, next) => {
  try {
    const instance = resolveInstance(req.params.id);
    if (!instance) {
      res.status(404).json({ error: 'Instance not found' });
      return;
    }

    const { version } = req.body;
    if (!version || typeof version !== 'string') {
      res.status(400).json({ error: 'version is required' });
      return;
    }

    const mutation = mutationService.stage('instance', 'update', { targetVersion: version }, instance.id);
    logAudit(req, 'instance.upgrade.staged', 'instance', instance.id, { version });
    res.status(202).json({ staged: true, mutation });
  } catch (err) { next(err); }
});

// ── Instance lifecycle actions (proxy to node agent) ────────────────

router.post('/:id/restart', requireScope('instances:write'), requireUnlocked(req => ({ type: 'instance', id: req.params.id })), (req, res, next) => {
  try {
    const instance = resolveInstance(req.params.id);
    if (!instance) return res.status(404).json({ error: 'Instance not found' });
    const mutation = mutationService.stage('instance', 'update', { restart: true }, instance.id);
    logAudit(req, 'instance.restart.staged', 'instance', instance.id, { name: instance.name });
    res.status(202).json({ staged: true, mutation });
  } catch (err) { next(err); }
});

router.post('/:id/stop', requireScope('instances:write'), requireUnlocked(req => ({ type: 'instance', id: req.params.id })), async (req, res, next) => {
  try {
    const instance = resolveInstance(req.params.id);
    if (!instance) return res.status(404).json({ error: 'Instance not found' });
    await instanceManager.stop(instance.id);
    logAudit(req, 'instance.stop', 'instance', instance.id, { name: instance.name });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.post('/:id/start', requireScope('instances:write'), requireUnlocked(req => ({ type: 'instance', id: req.params.id })), async (req, res, next) => {
  try {
    const instance = resolveInstance(req.params.id);
    if (!instance) return res.status(404).json({ error: 'Instance not found' });
    await instanceManager.start(instance.id);
    logAudit(req, 'instance.start', 'instance', instance.id, { name: instance.name });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.post('/:id/retry', requireScope('instances:write'), async (req, res, next) => {
  try {
    const instance = resolveInstance(req.params.id);
    if (!instance) return res.status(404).json({ error: 'Instance not found' });
    if (instance.status !== 'error') {
      return res.status(400).json({ error: `Cannot retry instance in "${instance.status}" status` });
    }
    // Reset status and re-stage instance creation through changeset pipeline
    instancesRepo.update(instance.id, { status: 'pending', statusMessage: 'Retrying provisioning' });
    mutationService.stage(
      'instance',
      'create',
      { nodeId: instance.nodeId, templateId: (instance as any).templateId ?? null },
      instance.id,
    );
    logAudit(req, 'instance.retry', 'instance', instance.id, { name: instance.name });
    res.json({ staged: true, message: 'Instance retry staged — approve changeset to apply' });
  } catch (err) { next(err); }
});

router.post('/:id/maintain', requireScope('instances:write'), async (req, res, next) => {
  try {
    const instance = resolveInstance(req.params.id);
    if (!instance) return res.status(404).json({ error: 'Instance not found' });
    const { reason, timeoutMs } = req.body || {};
    const operationId = await instanceManager.maintain(instance.id, { reason, timeoutMs });
    logAudit(req, 'instance.maintain', 'instance', instance.id, { name: instance.name, reason });
    res.json({ operationId });
  } catch (err) { next(err); }
});

// ── Instance logs (proxy to node agent container logs) ──────────────

router.get('/:id/logs', async (req, res, next) => {
  try {
    const instance = resolveInstance(req.params.id);
    if (!instance) return res.status(404).json({ error: 'Instance not found' });

    const lines = parseInt(req.query.lines as string, 10) || 100;
    const level = req.query.level as string | undefined;
    const agent = req.query.agent as string | undefined;

    const containerName = `armada-instance-${instance.name}`;
    const node = getNodeClient(instance.nodeId);
    const raw = await node.getContainerLogs(containerName, lines);

    // Split into lines and filter control characters from Docker multiplexed streams
    let logLines = raw
      .split('\n')
      .map((l) => stripDockerPrefix(l).trim())
      .filter((l) => l.length > 0);

    // Filter by log level if requested
    if (level) {
      const lvl = level.toLowerCase();
      logLines = logLines.filter((l) => l.toLowerCase().includes(lvl));
    }

    // Filter by agent name if requested
    if (agent) {
      logLines = logLines.filter((l) => l.toLowerCase().includes(agent.toLowerCase()));
    }

    res.json({ logs: logLines });
  } catch (err: any) {
    if (err.message?.includes('failed:') || err.message?.includes('not connected')) {
      return res.status(502).json({ error: err.message });
    }
    next(err);
  }
});

// GET /api/instances/:id/logs/stream — SSE live log stream from container
router.get('/:id/logs/stream', async (req, res, next) => {
  try {
    const instance = resolveInstance(req.params.id);
    if (!instance) return res.status(404).json({ error: 'Instance not found' });

    const lines = parseInt(req.query.lines as string, 10) || 100;
    const level = req.query.level as string | undefined;
    const agent = req.query.agent as string | undefined;

    const containerName = `armada-instance-${instance.name}`;
    const node = getNodeClient(instance.nodeId);
    const sse = setupSSE(res);

    // Helper: filter and send a raw log line via SSE
    const sendLine = (raw: string) => {
      const line = stripDockerPrefix(raw).trim();
      if (!line) return;
      if (level && !line.toLowerCase().includes(level.toLowerCase())) return;
      if (agent && !line.toLowerCase().includes(agent.toLowerCase())) return;
      sse.send('log', { line });
    };

    // Fetch initial batch of logs synchronously before starting the stream
    try {
      const initialLogs = await node.getContainerLogs(containerName, lines);
      for (const l of initialLogs.split('\n')) sendLine(l);
    } catch (err: any) {
      console.warn('[instances] Failed to fetch initial logs:', err.message);
    }

    // Stream live logs via progress events from node (logs.stream action)
    // The node sends each log line as a ProgressMessage with step='log_line'.
    // Fall back to polling if the node doesn't support the streaming action.
    let cleanup: (() => void) | null = null;

    try {
      cleanup = await node.streamContainerLogs(containerName, (line) => sendLine(line));
    } catch (_streamErr) {
      // Node doesn't support logs.stream — fall back to 2s polling
      let lastSince = Math.floor(Date.now() / 1000);
      const pollInterval = setInterval(async () => {
        try {
          const now = Math.floor(Date.now() / 1000);
          const newLogs = await node.getContainerLogs(containerName, 50, lastSince);
          lastSince = now;
          for (const l of newLogs.split('\n')) sendLine(l);
        } catch (pollErr: any) {
          console.warn('[instances] Log poll failed:', pollErr.message);
        }
      }, 2000);
      cleanup = () => clearInterval(pollInterval);
    }

    res.on('close', () => cleanup?.());
  } catch (err) { next(err); }
});

// ── Instance stats (proxy to node agent container stats) ────────────

router.get('/:id/stats', async (req, res, next) => {
  try {
    const instance = resolveInstance(req.params.id);
    if (!instance) return res.status(404).json({ error: 'Instance not found' });

    const containerName = `armada-instance-${instance.name}`;
    const node = getNodeClient();
    const stats = await node.getContainerStats(containerName);
    res.json(stats);
  } catch (err: any) {
    if (err.message?.includes('failed:')) {
      return res.status(502).json({ error: err.message });
    }
    next(err);
  }
});

// ── Instance heartbeat (push-based from armada-agent plugin) ─────────

router.post('/heartbeat', requireScope('instances:write'), (req, res) => {
  const result = instanceManager.processHeartbeat(req.body);
  if ('error' in result) {
    return res.status(result.status).json({ error: result.error });
  }
  res.json(result);
});

// ── Instance event stream ─────────────────────────────────────────────

/**
 * GET /api/instances/:id/events/stream
 *
 * SSE stream of real-time events for a specific instance.
 * Events arrive via the node→control WS relay and are emitted on the eventBus
 * under the key `instance.<instanceName>.<eventType>`.
 *
 * The endpoint also sends a `events.subscribe` command to the node agent so
 * it starts (or confirms) the SSE relay for this instance.
 */
router.get('/:id/events/stream', async (req, res, next) => {
  try {
    const instance = resolveInstance(req.params.id);
    if (!instance) return res.status(404).json({ error: 'Instance not found' });

    const sse = setupSSE(res);

    // Request the node agent to start relaying events for this instance
    const containerName = `armada-instance-${instance.name}`;
    try {
      const node = getNodeClient(instance.nodeId);
      await node.subscribeInstanceEvents(instance.id, instance.name, containerName);
    } catch (err: any) {
      // Non-fatal — if the node doesn't support events yet, we just get no events
      console.warn(`[instances] events.subscribe failed for ${instance.name}: ${err.message}`);
    }

    // Subscribe to all event types for this instance from the eventBus
    const pattern = `instance.${instance.name}.*`;
    const unsubscribe = eventBus.on(pattern, (armadaEvent) => {
      sse.send(armadaEvent.event, armadaEvent.data, armadaEvent.id);
    });

    // Replay recent events from the ring buffer
    const replayEvents = eventBus.replay(0, pattern);
    for (const evt of replayEvents) {
      sse.send(evt.event, evt.data, evt.id);
    }

    res.on('close', () => {
      unsubscribe();
      // Unsubscribe the node agent when no more SSE clients remain for this instance
      // (simple heuristic: unsubscribe on last client close)
      const node = getNodeClient(instance.nodeId);
      node.unsubscribeInstanceEvents(instance.id).catch(() => {
        // Best-effort — ignore if node is offline
      });
    });
  } catch (err) { next(err); }
});

export default router;

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Docker multiplexed log streams prepend an 8-byte header to each frame:
 *   [stream_type (1)] [padding (3)] [size (4 big-endian)]
 * Strip these non-printable control bytes so callers receive clean text lines.
 */
function stripDockerPrefix(line: string): string {
  // If the line starts with a non-printable byte in the Docker header range, strip first 8 chars
  if (line.length > 8 && line.charCodeAt(0) <= 2 && line.charCodeAt(0) >= 0) {
    return line.slice(8);
  }
  return line;
}
