import { Router } from 'express';
import { randomBytes } from 'crypto';
import { requireScope } from '../middleware/scopes.js';
import { requireUnlocked } from '../middleware/lock-guard.js';
import { nodesRepo, agentsRepo, instancesRepo } from '../repositories/index.js';
import { registerToolDef } from '../utils/tool-registry.js';
import type { NodeManager } from '../node-manager.js';
import { WsNodeClient } from '../infrastructure/ws-node-client.js';
import type { ArmadaNodeEnriched } from '@coderage-labs/armada-shared';
import { nodeConnectionManager } from '../ws/node-connections.js';
import { nodeRemovalService } from '../services/node-removal.js';
import { getDiscoveredNodes } from '../infrastructure/mdns-scanner.js';

registerToolDef({
  name: 'fleet_nodes',
  description: 'List all fleet nodes (Docker hosts). Shows node name, URL, status, and agent count.',
  method: 'GET', path: '/api/nodes',
  parameters: [],
});

registerToolDef({
  name: 'fleet_node_get',
  description: 'Get details of a specific fleet node.',
  method: 'GET', path: '/api/nodes/:id',
  parameters: [
    { name: 'id', type: 'string', description: 'Node ID', required: true },
  ],
});

registerToolDef({
  name: 'fleet_node_create',
  description: 'Register a new fleet node (Docker host). Nodes connect via WebSocket using an install token.',
  method: 'POST', path: '/api/nodes',
  parameters: [
    { name: 'hostname', type: 'string', description: 'Node hostname label', required: false },
  ],
});

registerToolDef({
  name: 'fleet_node_update',
  description: 'Update an existing fleet node.',
  method: 'PUT', path: '/api/nodes/:id',
  parameters: [
    { name: 'id', type: 'string', description: 'Node ID', required: true },
    { name: 'hostname', type: 'string', description: 'Node hostname label' },
  ],
});

registerToolDef({
  name: 'fleet_node_delete',
  description: 'Remove a fleet node. Fails if agents are still running on it.',
  method: 'DELETE', path: '/api/nodes/:id',
  parameters: [
    { name: 'id', type: 'string', description: 'Node ID to remove', required: true },
  ],
});

registerToolDef({
  name: 'fleet_node_test',
  description: 'Test connectivity to a fleet node.',
  method: 'POST', path: '/api/nodes/:id/test',
  parameters: [
    { name: 'id', type: 'string', description: 'Node ID to test', required: true },
  ],
});

registerToolDef({
  name: 'fleet_node_stats',
  description: 'Get resource stats (CPU, memory, disk) from a fleet node.',
  method: 'GET', path: '/api/nodes/:id/stats',
  parameters: [
    { name: 'id', type: 'string', description: 'Node ID', required: true },
  ],
});

registerToolDef({
  name: 'fleet_node_capacity',
  description: 'Get capacity overview for a fleet node — total resources, used, available, and per-agent breakdown.',
  method: 'GET', path: '/api/nodes/:id/capacity',
  parameters: [
    { name: 'id', type: 'string', description: 'Node ID', required: true },
  ],
});

export function createNodeRoutes(nodeManager: NodeManager): Router {
  const router = Router();

  // ── Resource monitoring proxy routes ──────────────────────────────

  // GET /api/nodes/:id/stats — returns cached live stats (pushed every 10s via WS),
  // falling back to a live `node.stats` WS command if no cached data is available.
  router.get('/:id/stats', async (req, res, next) => {
    try {
      const node = nodesRepo.getById(req.params.id);
      if (!node) { res.status(404).json({ error: 'Node not found' }); return; }

      // Use cached stats if available (pushed by node agent every 10s)
      const cached = nodeConnectionManager.getLiveStats(node.id);
      if (cached) {
        res.json({ ...cached, cached: true });
        return;
      }

      // Fall back to live WS command query
      const client = nodeManager.getNode(node.id);
      if (!client) { res.status(404).json({ error: 'Node not connected' }); return; }
      const stats = await client.getStats();
      res.json(stats);
    } catch (err) { next(err); }
  });

  // GET /api/nodes/:id/stats/history — proxy to node agent
  router.get('/:id/stats/history', async (req, res, next) => {
    try {
      const node = nodesRepo.getById(req.params.id);
      if (!node) { res.status(404).json({ error: 'Node not found' }); return; }
      const client = nodeManager.getNode(node.id);
      if (!client) { res.status(404).json({ error: 'Node not connected' }); return; }
      const history = await client.getStatsHistory(req.query.period as string | undefined);
      res.json(history);
    } catch (err) { next(err); }
  });

  // GET /api/nodes/:id/logs — fetch node agent ring buffer logs
  router.get('/:id/logs', requireScope('nodes:read'), async (req, res, next) => {
    try {
      const node = nodesRepo.getById(req.params.id);
      if (!node) { res.status(404).json({ error: 'Node not found' }); return; }
      const client = nodeManager.getNode(node.id);
      if (!client) { res.status(503).json({ error: 'Node not connected' }); return; }
      const limit = parseInt(req.query.limit as string) || 100;
      const since = req.query.since as string | undefined;
      try {
        const logs = await client.getNodeLogs(limit, since);
        res.json({ logs });
      } catch (err: any) {
        res.status(502).json({ error: `Failed to fetch node logs: ${err.message}` });
      }
    } catch (err) { next(err); }
  });

  // GET /api/nodes/:id/capacity — proxy to node agent
  router.get('/:id/capacity', async (req, res, next) => {
    try {
      const node = nodesRepo.getById(req.params.id);
      if (!node) { res.status(404).json({ error: 'Node not found' }); return; }
      const client = nodeManager.getNode(node.id);
      if (!client) { res.status(404).json({ error: 'Node not connected' }); return; }
      const memParam = req.query.memory ? parseInt(req.query.memory as string) : undefined;
      const capacity = await client.getCapacity(memParam);
      res.json(capacity);
    } catch (err) { next(err); }
  });

  /**
   * Health check a connected node via WS command dispatcher.
   * Used as a fallback when no streamed stats are available yet, and for
   * connection verification (called at ~60s intervals via the stale checker).
   */
  async function checkNodeHealth(nodeId: string): Promise<any | null> {
    if (!nodeConnectionManager.isOnline(nodeId)) return null;
    try {
      const client = new WsNodeClient(nodeId);
      return await client.healthCheck();
    } catch (err: any) {
      console.warn('[nodes] healthCheck failed:', err.message);
      return null;
    }
  }

  /** Build a normalised liveStats object from a raw stats/health payload */
  function buildLiveStats(raw: Record<string, unknown>, fallbackHostname: string): any {
    if (raw.cpu && typeof raw.cpu === 'object') {
      // New enriched format (from streamed stats or healthCheck)
      const cpu = raw.cpu as any;
      const memory = raw.memory as any;
      const containers = raw.containers as any;
      return {
        cores: cpu.cores ?? 0,
        memory: memory?.total ?? 0,
        hostname: (raw.hostname as string | undefined) ?? fallbackHostname,
        containers: containers?.running ?? 0,
        cpu,
        memoryDetail: memory,
        disk: raw.disk,
        fleet: containers,
        capacity: raw.capacity,
      };
    }
    // Legacy format
    const cpu = raw.cpu as any;
    const memory = raw.memory as any;
    return {
      cores: cpu?.cores ?? 0,
      memory: memory?.total ?? 0,
      hostname: (raw.hostname as string | undefined) ?? fallbackHostname,
      containers: (raw.containers as number | undefined) ?? 0,
    };
  }

  // Helper: enrich a node with live status + agent count
  async function enrichNode(node: ReturnType<typeof nodesRepo.getById> & {}): Promise<ArmadaNodeEnriched> {
    const agents = agentsRepo.getAll().filter(a => a.nodeId === node.id);
    const wsStatus = nodeConnectionManager.getStatus(node.id);

    // Prefer cached live stats (pushed by the node agent every 10s via WS).
    // Fall back to a synchronous healthCheck only when not yet received.
    const cached = nodeConnectionManager.getLiveStats(node.id);
    let liveStats: any = undefined;
    let isOnline = wsStatus === 'online' || wsStatus === 'stale';

    if (cached) {
      liveStats = buildLiveStats(cached, node.hostname);
    } else if (wsStatus === 'online') {
      // No cached stats yet — use healthCheck as initial fallback
      const health = await checkNodeHealth(node.id);
      if (health) {
        liveStats = buildLiveStats(health as Record<string, unknown>, node.hostname);
      }
    }

    return {
      ...node,
      status: isOnline ? 'online' : 'offline',
      wsStatus,
      agentCount: agents.length,
      liveStats,
    };
  }

  // GET /api/nodes/discovered — list mDNS-discovered nodes (not yet registered)
  // Must be registered before /:id to avoid route shadowing.
  router.get('/discovered', (_req, res) => {
    const nodes = getDiscoveredNodes();
    res.json(nodes);
  });

  // GET /api/nodes — list all nodes with live health
  router.get('/', async (_req, res, next) => {
    try {
      const nodes = nodesRepo.getAll();
      const enriched = await Promise.all(nodes.map(n => enrichNode(n)));
      res.json(enriched);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/nodes/:id — single node with live health + agents
  router.get('/:id', async (req, res, next) => {
    try {
      const node = nodesRepo.getById(req.params.id);
      if (!node) {
        res.status(404).json({ error: 'Node not found' });
        return;
      }
      const enriched = await enrichNode(node);
      const agents = agentsRepo.getAll().filter(a => a.nodeId === node.id);
      const details = nodesRepo.getDetails(node.id);
      const conn = nodeConnectionManager.connections.get(node.id);
      res.json({
        ...enriched,
        agents,
        fingerprint: details?.fingerprint ?? null,
        credentialStatus: details?.hasCredential ? 'active' : 'unregistered',
        credentialRotatedAt: details?.credentialRotatedAt ?? null,
        connectedSince: conn?.connectedAt.toISOString() ?? null,
        lastHeartbeat: conn?.lastHeartbeat.toISOString() ?? null,
      });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/nodes — register new node
  // Returns the node with an installToken for WS registration.
  // Nodes connect via WebSocket — no HTTP URL or token required.
  router.post('/', requireScope('nodes:write'), async (req, res, next) => {
    try {
      const { hostname } = req.body;

      // Generate a one-time install token for WS registration
      const installToken = randomBytes(24).toString('hex'); // 48-char hex token

      const node = nodesRepo.create({
        hostname: hostname ?? 'unknown',
        ip: '',
        port: 0,
        url: '',
        token: '',
        cores: 0,
        memory: 0,
        status: 'offline',
        lastSeen: '',
      });

      // Store the install token
      nodesRepo.setInstallToken(node.id, installToken);

      // Register in NodeManager (node will connect via WS when it comes online)
      nodeManager.addNode(node.id);

      res.status(201).json({ ...node, installToken });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/nodes/:id/regenerate-token — issue a new install token for re-registration
  router.post('/:id/regenerate-token', requireScope('nodes:write'), async (req, res, next) => {
    try {
      const node = nodesRepo.getById(req.params.id);
      if (!node) {
        res.status(404).json({ error: 'Node not found' });
        return;
      }
      const installToken = randomBytes(24).toString('hex');
      nodesRepo.setInstallToken(node.id, installToken);
      res.json({ installToken });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/nodes/:id/rotate-credential — rotate the session credential for a connected node
  router.post('/:id/rotate-credential', requireScope('nodes:write'), async (req, res, next) => {
    try {
      const node = nodesRepo.getById(req.params.id);
      if (!node) {
        res.status(404).json({ error: 'Node not found' });
        return;
      }
      const result = await nodeConnectionManager.rotateCredential(node.id);
      res.json({ success: true, message: 'Credential rotated successfully' });
    } catch (err) {
      next(err);
    }
  });

  // PUT /api/nodes/:id — update node config
  router.put('/:id', requireScope('nodes:write'), async (req, res, next) => {
    try {
      const existing = nodesRepo.getById(req.params.id);
      if (!existing) {
        res.status(404).json({ error: 'Node not found' });
        return;
      }

      const { hostname } = req.body;

      const updated = nodesRepo.update(req.params.id, {
        hostname: hostname || existing.hostname,
      });

      // Re-register in NodeManager
      nodeManager.removeNode(req.params.id);
      nodeManager.addNode(req.params.id);

      res.json(updated);
    } catch (err) {
      next(err);
    }
  });

  // DELETE /api/nodes/:id — remove node (cascading, via operations pipeline)
  // Without ?confirm=true, returns an impact assessment (400).
  // With ?confirm=true, queues the removal operation and returns its ID.
  router.delete('/:id', requireScope('nodes:write'), requireUnlocked(req => ({ type: 'node', id: req.params.id })), async (req, res, next) => {
    try {
      const node = nodesRepo.getById(req.params.id);
      if (!node) {
        res.status(404).json({ error: 'Node not found' });
        return;
      }

      // ── Safety guard: block deletion if running/pending instances exist ──────
      const allNodeInstances = instancesRepo.getAll().filter(i => i.nodeId === node.id);
      const runningInstances = allNodeInstances.filter(
        i => i.status === 'running' || i.status === 'pending',
      );

      if (runningInstances.length > 0) {
        res.status(409).json({
          error: `Cannot delete node with ${runningInstances.length} running instance(s). Stop or migrate them first.`,
          instances: runningInstances.map(i => ({ id: i.id, name: i.name, status: i.status })),
        });
        return;
      }
      // ────────────────────────────────────────────────────────────────────────

      const impact = nodeRemovalService.assessImpact(req.params.id);

      if (req.query.confirm !== 'true') {
        res.status(400).json({
          error: 'Node removal requires confirmation',
          impact,
          hint: 'Add ?confirm=true to proceed',
        });
        return;
      }

      const opId = await nodeRemovalService.remove(req.params.id, {
        createdBy: (req as any).user?.id,
      });

      res.json({ operationId: opId, message: 'Node removal started', impact });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/nodes/:id/test — test connection to node agent
  router.post('/:id/test', requireScope('nodes:write'), async (req, res, next) => {
    try {
      const node = nodesRepo.getById(req.params.id);
      if (!node) {
        res.status(404).json({ error: 'Node not found' });
        return;
      }

      // Node connectivity is tested via WS connection manager
      const isOnline = nodeConnectionManager.isOnline(node.id);
      if (!isOnline) {
        res.json({ success: false, error: 'Node is not connected via WebSocket' });
        return;
      }

      const health = await checkNodeHealth(node.id);
      if (health) {
        nodesRepo.update(node.id, {
          status: 'online',
          cores: health.cpu?.cores ?? node.cores,
          memory: health.memory?.total ?? node.memory,
          lastSeen: new Date().toISOString(),
        });
      }

      res.json({ success: true, online: isOnline, health });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

export default createNodeRoutes;
