import { Router } from 'express';
import { requireScope } from '../middleware/scopes.js';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentsRepo, instancesRepo, nodesRepo } from '../repositories/index.js';
import { pluginLibraryRepo, skillLibraryRepo } from '../repositories/index.js';
import { registerToolDef } from '../utils/tool-registry.js';
import { getLatestVersion, isNewerVersion, getArmadaVersionInfo } from '../services/version-checker.js';
import { mutationService } from '../services/mutation-service.js';
import { logActivity } from '../services/activity-service.js';
import type { NodeManager } from '../node-manager.js';
import { CONTROL_VERSION, PROTOCOL_VERSION, MIN_NODE_VERSION, MIN_AGENT_PLUGIN_VERSION } from '../version.js';
import { nodeConnectionManager } from '../ws/node-connections.js';
import { getAllInstanceLoads } from '../services/instance-capacity.js';
import { cleanupStaleData } from '../services/patrol-service.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgPath = resolve(__dirname, '..', '..', '..', '..', 'package.json');
const armadaVersion: string = JSON.parse(readFileSync(pkgPath, 'utf-8')).version;

registerToolDef({
  category: 'system',
  name: 'armada_health',
  scope: 'system:read',
  description: 'Quick health check — agent count and uptime.',
  method: 'GET', path: '/api/health',
  parameters: [],
});

registerToolDef({
  category: 'system',
  name: 'armada_system_status',
  scope: 'system:read',
  description: 'Full armada system status — agent counts, node health, resource usage (CPU, memory, disk).',
  method: 'GET', path: '/api/status',
  parameters: [],
});

registerToolDef({
  category: 'system',
  name: 'armada_system_version',
  scope: 'system:read',
  description: 'Check current Armada version and available updates.',
  method: 'GET', path: '/api/system/version',
  parameters: [],
});

registerToolDef({
  category: 'system',
  name: 'armada_system_resources',
  scope: 'system:read',
  description: 'Resource usage summary across all instances — instance counts, agent counts, capacity utilization, and memory allocation.',
  method: 'GET', path: '/api/system/resources',
  parameters: [],
});

registerToolDef({
  category: 'system',
  name: 'armada_cleanup_stale',
  scope: 'system:write',
  description: 'Trigger stale data cleanup — marks stale tasks as failed, removes orphaned worktree records, and deletes expired patrol records.',
  method: 'POST', path: '/api/system/cleanup',
  parameters: [],
});

export function createSystemRoutes(nodeManager: NodeManager): Router {
  const router = Router();

  // GET /api/health — public, no auth
  // #259: always query DB directly (no cache) to avoid stale agent count
  router.get('/health', (_req, res) => {
    const agents = agentsRepo.getAll(); // live DB query, not cached
    res.json({
      status: 'ok',
      version: armadaVersion,
      agents: agents.length,
      uptime: process.uptime(),
    });
  });

  // GET /api/status — armada summary with resource data
  router.get('/status', async (_req, res, next) => {
    try {
      const agents = agentsRepo.getAll();
      let running = 0;
      let stopped = 0;

      // Resource aggregation
      let totalCores = 0;
      let totalMemory = 0;
      let usedMemory = 0;
      let totalDisk = 0;
      let usedDisk = 0;
      let totalCpuUsage = 0;
      let nodeCount = 0;
      let nodesOnline = 0;

      const allNodes = nodeManager.getAllNodes();
      nodeCount = allNodes.length;

      // Gather container state + resource data from all nodes
      for (const node of allNodes) {
        try {
          const health = await node.healthCheck() as any;
          if (health) {
            nodesOnline++;
            // New-format health has cpu/memory objects
            if (health.cpu && typeof health.cpu === 'object') {
              totalCores += health.cpu.cores || 0;
              totalCpuUsage += health.cpu.usage || 0;
              totalMemory += health.memory?.total || 0;
              usedMemory += health.memory?.used || 0;
              totalDisk += health.disk?.total || 0;
              usedDisk += health.disk?.used || 0;
            } else {
              totalCores += health.cores || 0;
              totalMemory += health.memory || 0;
            }
          }

          const containers = await node.listContainers() as any[];
          const containerMap = new Map(
            containers.flatMap((c: any) => {
              const label = c.Labels?.['armada.agent'] ?? '';
              const state = c.State;
              const stripped = label.startsWith('armada-') ? label.slice(6) : label;
              return [[label, state], [stripped, state]] as [string, string][];
            }),
          );
          for (const agent of agents) {
            const state = containerMap.get(agent.name);
            if (state === 'running') running++;
            else if (state) stopped++;
          }
        } catch (err: any) {
          console.warn('[system] Node unavailable for container stats:', err.message);
        }
      }

      // Count agents not matched to any node
      const matched = running + stopped;
      if (matched < agents.length) {
        stopped += agents.length - matched;
      }

      res.json({
        totalAgents: agents.length,
        running,
        stopped,
        nodes: nodeCount,
        nodesOnline,
        resources: {
          cpu: { cores: totalCores, usage: nodeCount > 0 ? Math.round(totalCpuUsage / Math.max(nodesOnline, 1) * 10) / 10 : 0 },
          memory: { total: totalMemory, used: usedMemory, available: totalMemory - usedMemory },
          disk: { total: totalDisk, used: usedDisk, available: totalDisk - usedDisk },
        },
      });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/system/versions — latest release + per-instance version info + node version matrix
  router.get('/system/versions', (_req, res) => {
    const latest = getLatestVersion();
    const instances = instancesRepo.getAll();

    const instanceVersions = instances.map((inst) => ({
      name: inst.name,
      running: inst.version ?? null,
      target: inst.targetVersion ?? null,
      outdated: !!(latest && inst.version && isNewerVersion(latest, inst.version)),
    }));

    // Enrich with node version info
    const nodes = nodesRepo.getAll();
    const nodeVersions = nodes.map((node: any) => {
      const versionInfo = nodeConnectionManager.getNodeVersion(node.id);
      return {
        hostname: node.hostname,
        version: versionInfo?.version ?? 'unknown',
        protocolVersion: versionInfo?.protocolVersion ?? null,
        compatible: versionInfo?.compatible ?? null,
      };
    });

    res.json({
      control: {
        version: CONTROL_VERSION,
        protocolVersion: PROTOCOL_VERSION,
      },
      minimums: {
        nodeVersion: MIN_NODE_VERSION,
        agentPluginVersion: MIN_AGENT_PLUGIN_VERSION,
      },
      latest,
      instances: instanceVersions,
      nodes: nodeVersions,
    });
  });

  // GET /api/system/version — current Armada version and available updates
  router.get('/system/version', async (_req, res) => {
    try {
      const versionInfo = await getArmadaVersionInfo();
      res.json(versionInfo);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/system/resources — resource usage summary across all instances
  router.get('/system/resources', (_req, res) => {
    try {
      const instances = instancesRepo.getAll();
      const agents = agentsRepo.getAll();
      const loads = getAllInstanceLoads();

      // Count instances by status
      const runningInstances = instances.filter(i => i.status === 'running').length;
      const stoppedInstances = instances.filter(i => i.status === 'stopped').length;

      // Count agents by status
      const runningAgents = agents.filter(a => a.status === 'running').length;
      const offlineAgents = agents.filter(a => a.healthStatus === 'offline').length;

      // Calculate capacity utilization
      const totalCapacity = loads.reduce((sum, l) => sum + l.max, 0);
      const usedCapacity = loads.reduce((sum, l) => sum + l.current, 0);
      const utilizationPercent = totalCapacity > 0 ? Math.round((usedCapacity / totalCapacity) * 100) : 0;

      // Calculate memory allocation per instance
      const memoryPerInstance: Record<string, string> = {};
      for (const instance of instances) {
        if (instance.memory) {
          memoryPerInstance[instance.name] = instance.memory;
        }
      }

      // Sum total allocated memory (parse values like "2g", "512m")
      let totalMemoryMb = 0;
      for (const instance of instances) {
        if (instance.memory) {
          const match = instance.memory.match(/^(\d+(?:\.\d+)?)(g|m)?$/i);
          if (match) {
            const value = parseFloat(match[1]);
            const unit = (match[2] || 'g').toLowerCase();
            if (unit === 'g') totalMemoryMb += value * 1024;
            else if (unit === 'm') totalMemoryMb += value;
          }
        }
      }
      const totalMemoryGb = (totalMemoryMb / 1024).toFixed(1);

      res.json({
        instances: {
          total: instances.length,
          running: runningInstances,
          stopped: stoppedInstances,
        },
        agents: {
          total: agents.length,
          running: runningAgents,
          offline: offlineAgents,
        },
        capacity: {
          used: usedCapacity,
          total: totalCapacity,
          utilizationPercent,
        },
        memory: {
          allocated: `${totalMemoryGb}g`,
          perInstance: memoryPerInstance,
        },
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/system/plugin-versions — plugin drift: library vs installed versions
  router.get('/system/plugin-versions', (_req, res) => {
    try {
      const libraryPlugins = pluginLibraryRepo.getAll();
      const agents = agentsRepo.getAll();

      // Build a map of plugin name → library version
      const libraryVersionMap = new Map<string, string>();
      for (const plugin of libraryPlugins) {
        if (plugin.version) libraryVersionMap.set(plugin.name, plugin.version);
      }

      // Collect all plugin names from library + agents
      const allPluginNames = new Set<string>(libraryVersionMap.keys());
      for (const agent of agents) {
        const meta = agent.heartbeatMeta as any;
        if (meta?.pluginVersions) {
          for (const name of Object.keys(meta.pluginVersions)) {
            allPluginNames.add(name);
          }
        }
      }

      const plugins = Array.from(allPluginNames).sort().map(pluginName => {
        const libraryVersion = libraryVersionMap.get(pluginName) ?? null;
        const instances: Array<{ name: string; installedVersion: string; outdated: boolean }> = [];

        for (const agent of agents) {
          const meta = agent.heartbeatMeta as any;
          const installedVersion = meta?.pluginVersions?.[pluginName];
          if (installedVersion) {
            const outdated = !!(libraryVersion && installedVersion !== libraryVersion && isNewerVersion(libraryVersion, installedVersion));
            instances.push({ name: agent.name, installedVersion, outdated });
          }
        }

        return { name: pluginName, libraryVersion, instances };
      }).filter(p => p.instances.length > 0); // Only show plugins with at least one installed instance

      res.json({ plugins });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/system/skill-versions — skill drift: library vs installed versions
  router.get('/system/skill-versions', (_req, res) => {
    try {
      const librarySkills = skillLibraryRepo.getAll();
      const agents = agentsRepo.getAll();

      const libraryVersionMap = new Map<string, string>();
      for (const skill of librarySkills) {
        if (skill.version) libraryVersionMap.set(skill.name, skill.version);
      }

      const allSkillNames = new Set<string>(libraryVersionMap.keys());
      for (const agent of agents) {
        const meta = agent.heartbeatMeta as any;
        if (meta?.skillVersions) {
          for (const name of Object.keys(meta.skillVersions)) {
            allSkillNames.add(name);
          }
        }
      }

      const skills = Array.from(allSkillNames).sort().map(skillName => {
        const libraryVersion = libraryVersionMap.get(skillName) ?? null;
        const agents_list: Array<{ name: string; installedVersion: string; outdated: boolean }> = [];

        for (const agent of agents) {
          const meta = agent.heartbeatMeta as any;
          const installedVersion = meta?.skillVersions?.[skillName];
          if (installedVersion) {
            const outdated = !!(libraryVersion && installedVersion !== 'installed' && installedVersion !== libraryVersion && isNewerVersion(libraryVersion, installedVersion));
            agents_list.push({ name: agent.name, installedVersion, outdated });
          }
        }

        return { name: skillName, libraryVersion, agents: agents_list };
      }).filter(s => s.agents.length > 0);

      res.json({ skills });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/deploy/update-plugins — stage plugin update mutations for all instances.
  //
  // Every plugin in the library gets a pending mutation. The changeset pipeline will
  // install updated plugins on each instance, push config, and restart. This is the
  // armada-wide equivalent of POST /api/plugins/update-all.
  router.post('/deploy/update-plugins', requireScope('system:write'), (_req, res) => {
    const plugins = pluginLibraryRepo.getAll();
    if (plugins.length === 0) {
      res.json({ staged: true, count: 0, mutations: [] });
      return;
    }

    const mutations = plugins.map(plugin =>
      mutationService.stage('plugin', 'update', { version: 'latest' }, plugin.id),
    );

    logActivity({ eventType: 'deploy.update_plugins.staged', detail: `Staged plugin updates for ${plugins.length} plugin(s) across all instances` });

    res.json({
      staged: true,
      count: mutations.length,
      mutations: mutations.map(m => ({ id: m.id, entityId: m.entityId })),
    });
  });

  // POST /api/deploy/update-image — stage a container upgrade mutation for every running instance.
  //
  // Body: { tag: string }  (the target image tag, e.g. "v1.2.0" or "latest")
  //
  // Each instance gets a pending mutation of type 'instance' / 'update' with { targetVersion }.
  // The changeset pipeline recognises this via classifyMutation → affectsContainer and adds a
  // container_upgrade step followed by a health_check for each instance.
  router.post('/deploy/update-image', requireScope('system:write'), (req, res) => {
    const tag: string = req.body?.tag ?? 'latest';
    const allInstances = instancesRepo.getAll().filter((i) => i.status === 'running');

    if (allInstances.length === 0) {
      res.json({ staged: true, count: 0, mutations: [] });
      return;
    }

    const mutations = allInstances.map((inst) =>
      mutationService.stage('instance', 'update', { targetVersion: tag }, inst.id),
    );

    logActivity({ eventType: 'deploy.update_image.staged', detail: `Staged container upgrade to "${tag}" for ${allInstances.length} instance(s)` });

    res.json({
      staged: true,
      tag,
      count: mutations.length,
      mutations: mutations.map(m => ({ id: m.id, entityId: m.entityId })),
    });
  });

  // POST /api/system/cleanup — trigger stale data cleanup
  router.post('/system/cleanup', requireScope('system:write'), (_req, res) => {
    try {
      const result = cleanupStaleData();
      
      logActivity({
        eventType: 'system.cleanup',
        detail: `Cleanup complete: ${result.staleTasksCleaned} stale tasks, ${result.orphanedWorktreesCleaned} orphaned worktrees, ${result.expiredPatrolRecordsCleaned} expired patrol records`,
      });

      res.json({
        success: true,
        ...result,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

export default createSystemRoutes;
