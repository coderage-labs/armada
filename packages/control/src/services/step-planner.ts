// ── Step Planner — builds OperationStep DAGs for changeset execution ──
//
// Extracted from changeset-service.ts to keep that service focused on
// state machine management (create / list / get / approve / apply / cancel).

import crypto from 'node:crypto';
import { instancesRepo, pendingMutationRepo, settingsRepo, templatesRepo } from '../repositories/index.js';
import { pluginLibraryRepo } from '../repositories/index.js';
import { agentsRepo } from '../repositories/index.js';
import { classifyMutation } from './template-sync.js';
import { AGENT_PLUGIN_VERSION } from '../version.js';
import type { OperationStep } from '@coderage-labs/armada-shared';

// ── DAG Types ────────────────────────────────────────────────────────

export interface StepDAG {
  nodes: Record<string, { step: OperationStep }>;
  deps: [string, string][]; // [prerequisite, dependent]
}

/**
 * Convert a StepDAG to a flat array (for storage/display).
 * Preserves insertion order of nodes.
 */
export function dagToSteps(dag: StepDAG): OperationStep[] {
  return Object.values(dag.nodes).map(n => n.step);
}

// ── Image resolution ─────────────────────────────────────────────────

/**
 * Resolve the container image for an instance.
 * Checks template pinned image → system armada version → fallback default.
 */
export function resolveInstanceImage(instanceId: string): string {
  const instance = instancesRepo.getById(instanceId);
  if (instance?.templateId) {
    const template = templatesRepo.getById(instance.templateId);
    if (template?.image) return template.image;
  }
  const armadaVersion = settingsRepo.get('armada_openclaw_version');
  if (armadaVersion) return `ghcr.io/openclaw/openclaw:${armadaVersion}`;
  return process.env.ARMADA_DEFAULT_IMAGE || 'ghcr.io/openclaw/openclaw:latest';
}

// ── File write resolution ────────────────────────────────────────────

/**
 * Resolve workspace file writes from pending mutations.
 */
export function resolveFileWrites(mutations: any[], instanceId: string): Array<{ path: string; content: string }> {
  const files: Array<{ path: string; content: string }> = [];

  for (const mutation of mutations) {
    if (mutation.entityType !== 'agent') continue;
    const agent = agentsRepo.getById(mutation.entityId);
    if (!agent) continue;

    const payload = mutation.payload;

    if (payload.soul !== undefined) {
      files.push({
        path: `workspace/agents/${agent.name}/SOUL.md`,
        content: payload.soul ?? '',
      });
    }

    if (payload.agentsMd !== undefined || payload.agents_md !== undefined) {
      files.push({
        path: `workspace/agents/${agent.name}/AGENTS.md`,
        content: payload.agentsMd ?? payload.agents_md ?? '',
      });
    }
  }

  return files;
}

// ── Step builder ─────────────────────────────────────────────────────

/**
 * Smart Step Builder — examines pending mutations and builds minimal steps per instance.
 * Returns a DAG definition with explicit dependencies.
 */
export function buildStepsForInstance(instanceId: string, configVersion: number): StepDAG {
  const instance = instancesRepo.getById(instanceId);
  // For new instances not yet committed, resolve name from pending create mutation
  const instanceName = instance?.name ?? (() => {
    const createMut = pendingMutationRepo.getAll().find(
      m => m.entityType === 'instance' && m.entityId === instanceId && m.action === 'create'
    );
    return createMut?.payload?.name ?? undefined;
  })();
  const nodeId = instance?.nodeId ?? undefined;
  const containerName = instanceName ? `armada-instance-${instanceName}` : undefined;

  // Get all pending mutations relevant to this instance:
  // 1. Agent-level mutations for agents on this instance
  // 2. Global plugin mutations (affect all instances)
  // 3. Instance-specific mutations (e.g. targetVersion for container upgrade)
  const agentMutations = pendingMutationRepo.getByInstance(instanceId);
  const allMutations = pendingMutationRepo.getAll();
  const pluginMutations = allMutations.filter(m => m.entityType === 'plugin');
  const modelMutations = allMutations.filter(m => m.entityType === 'model');
  const providerMutations = allMutations.filter(m => m.entityType === 'provider');
  const apiKeyMutations = allMutations.filter(m => m.entityType === 'api_key');
  const instanceMutations = allMutations.filter(m => m.entityType === 'instance' && m.entityId === instanceId);
  const mutations = [...agentMutations, ...pluginMutations, ...modelMutations, ...providerMutations, ...apiKeyMutations, ...instanceMutations];

  // ── Instance deletion: short-circuit with destroy steps ──────────
  const deleteMutation = instanceMutations.find(m => m.action === 'delete');
  if (deleteMutation) {
    const instanceAgents = agentsRepo.getAll().filter((a: any) => a.instanceId === instanceId);
    const nodes: StepDAG['nodes'] = {};
    const deps: StepDAG['deps'] = [];

    if (instanceAgents.length > 0) {
      const stopAgentsId = crypto.randomUUID();
      nodes[stopAgentsId] = {
        step: {
          id: stopAgentsId,
          name: 'stop_agents',
          status: 'pending',
          metadata: { nodeId, containerName, instanceId },
        },
      };

      const stopContainerId = crypto.randomUUID();
      nodes[stopContainerId] = {
        step: {
          id: stopContainerId,
          name: 'stop_container',
          status: 'pending',
          metadata: { nodeId, containerName },
        },
      };
      deps.push([stopAgentsId, stopContainerId]); // stop_agents before stop_container

      const destroyContainerId = crypto.randomUUID();
      nodes[destroyContainerId] = {
        step: {
          id: destroyContainerId,
          name: 'destroy_container',
          status: 'pending',
          metadata: { nodeId, containerName },
        },
      };
      deps.push([stopContainerId, destroyContainerId]); // stop_container before destroy_container

      const cleanupId = crypto.randomUUID();
      nodes[cleanupId] = {
        step: {
          id: cleanupId,
          name: 'cleanup_instance_db',
          status: 'pending',
          metadata: { instanceId, nodeId, containerName },
        },
      };
      deps.push([destroyContainerId, cleanupId]); // destroy_container before cleanup_instance_db
    } else {
      // No agents, so stop_container is first
      const stopContainerId = crypto.randomUUID();
      nodes[stopContainerId] = {
        step: {
          id: stopContainerId,
          name: 'stop_container',
          status: 'pending',
          metadata: { nodeId, containerName },
        },
      };

      const destroyContainerId = crypto.randomUUID();
      nodes[destroyContainerId] = {
        step: {
          id: destroyContainerId,
          name: 'destroy_container',
          status: 'pending',
          metadata: { nodeId, containerName },
        },
      };
      deps.push([stopContainerId, destroyContainerId]);

      const cleanupId = crypto.randomUUID();
      nodes[cleanupId] = {
        step: {
          id: cleanupId,
          name: 'cleanup_instance_db',
          status: 'pending',
          metadata: { instanceId, nodeId, containerName },
        },
      };
      deps.push([destroyContainerId, cleanupId]);
    }

    return { nodes, deps };
  }
  // ────────────────────────────────────────────────────────────────

  // Check if this is a fresh instance creation
  const instanceCreateMutation = instanceMutations.find(m => m.action === 'create');
  if (instanceCreateMutation) {
    // Full bootstrap sequence for a new instance
    const { nodeId: mutNodeId, image, templateId } = instanceCreateMutation.payload;
    const resolvedNodeId = mutNodeId ?? nodeId;
    const defaultImage = process.env.ARMADA_DEFAULT_IMAGE || 'ghcr.io/openclaw/openclaw:latest';
    const resolvedImage = image || (templateId ? (() => {
      const tmpl = templatesRepo.getById(templateId);
      return tmpl?.image || defaultImage;
    })() : defaultImage);


    const nodes: StepDAG['nodes'] = {};
    const deps: StepDAG['deps'] = [];

    const pullImageId = crypto.randomUUID();
    nodes[pullImageId] = {
      step: {
        id: pullImageId,
        name: 'pull_image',
        status: 'pending',
        metadata: { nodeId: resolvedNodeId, image: resolvedImage ?? 'latest' },
      },
    };

    const createContainerId = crypto.randomUUID();
    nodes[createContainerId] = {
      step: {
        id: createContainerId,
        name: 'create_container',
        status: 'pending',
        metadata: {
          nodeId: resolvedNodeId,
          containerName,
          image: resolvedImage,
          instanceId,
          templateId,
          env: [
            `OPENCLAW_INSTANCE_ID=${instanceId}`,
            `OPENCLAW_INSTANCE_NAME=${instanceName ?? ''}`,
          ],
          volumes: {
            data: `/data/armada/instances/${instanceName ?? instanceId}`,
            plugins: `/data/armada/instances/${instanceName ?? instanceId}/plugins`,
          },
          resources: {
            memory: instance?.memory || '2g',
            cpus: instance?.cpus || '1',
          },
          network: 'armada-net',
          labels: {
            'armada.instance': instanceId,
            'armada.instance.name': instanceName ?? '',
          },
        },
      },
    };
    deps.push([pullImageId, createContainerId]); // pull_image before create_container

    const installPluginsId = crypto.randomUUID();
    nodes[installPluginsId] = {
      step: {
        id: installPluginsId,
        name: 'install_plugins',
        status: 'pending',
        metadata: {
          nodeId: resolvedNodeId,
          containerName,
          pluginsDir: `/data/armada/instances/${instance?.name ?? instanceId}/plugins`,
          plugins: [{ name: '@coderage-labs/armada-agent-plugin', version: AGENT_PLUGIN_VERSION }],
        },
      },
    };
    deps.push([createContainerId, installPluginsId]); // create_container before install_plugins

    const pushConfigId = crypto.randomUUID();
    nodes[pushConfigId] = {
      step: {
        id: pushConfigId,
        name: 'push_config',
        status: 'pending',
        metadata: { instanceId, configVersion, nodeId: resolvedNodeId, containerName },
      },
    };
    deps.push([installPluginsId, pushConfigId]); // install_plugins before push_config

    const startContainerId = crypto.randomUUID();
    nodes[startContainerId] = {
      step: {
        id: startContainerId,
        name: 'start_container',
        status: 'pending',
        metadata: { nodeId: resolvedNodeId, containerName },
      },
    };
    deps.push([pushConfigId, startContainerId]); // push_config before start_container

    const healthCheckId = crypto.randomUUID();
    nodes[healthCheckId] = {
      step: {
        id: healthCheckId,
        name: 'health_check',
        status: 'pending',
        metadata: { instanceId, nodeId: resolvedNodeId, containerName, timeoutMs: 120_000 },
      },
    };
    deps.push([startContainerId, healthCheckId]); // start_container before health_check

    return { nodes, deps };
  }

  // ── Fresh instance without a running container ────────────────────
  // Instance exists in DB but has never been provisioned (no url set).
  // Generate the full bootstrap sequence just like the create path.
  if (!instance?.url) {
    const resolvedImage = resolveInstanceImage(instanceId);

    const nodes: StepDAG['nodes'] = {};
    const deps: StepDAG['deps'] = [];

    const pullImageId = crypto.randomUUID();
    nodes[pullImageId] = {
      step: {
        id: pullImageId,
        name: 'pull_image',
        status: 'pending',
        metadata: { nodeId, image: resolvedImage },
      },
    };

    const createContainerId = crypto.randomUUID();
    nodes[createContainerId] = {
      step: {
        id: createContainerId,
        name: 'create_container',
        status: 'pending',
        metadata: {
          nodeId,
          containerName,
          image: resolvedImage,
          instanceId,
          env: [
            `OPENCLAW_INSTANCE_ID=${instanceId}`,
            `OPENCLAW_INSTANCE_NAME=${instance?.name ?? ''}`,
          ],
          volumes: {
            data: `/data/armada/instances/${instance?.name ?? instanceId}`,
            plugins: `/data/armada/instances/${instance?.name ?? instanceId}/plugins`,
          },
          resources: {
            memory: instance?.memory || '2g',
            cpus: instance?.cpus || '1',
          },
          network: 'armada-net',
          labels: {
            'armada.instance': instanceId,
            'armada.instance.name': instance?.name ?? '',
          },
        },
      },
    };
    deps.push([pullImageId, createContainerId]); // pull_image before create_container

    const installPluginsId = crypto.randomUUID();
    nodes[installPluginsId] = {
      step: {
        id: installPluginsId,
        name: 'install_plugins',
        status: 'pending',
        metadata: {
          nodeId,
          containerName,
          pluginsDir: `/data/armada/instances/${instance?.name ?? instanceId}/plugins`,
          plugins: [{ name: '@coderage-labs/armada-agent-plugin', version: AGENT_PLUGIN_VERSION }],
        },
      },
    };
    deps.push([createContainerId, installPluginsId]); // create_container before install_plugins

    const pushConfigId = crypto.randomUUID();
    nodes[pushConfigId] = {
      step: {
        id: pushConfigId,
        name: 'push_config',
        status: 'pending',
        metadata: { instanceId, configVersion, nodeId, containerName },
      },
    };
    deps.push([installPluginsId, pushConfigId]); // install_plugins before push_config

    const startContainerId = crypto.randomUUID();
    nodes[startContainerId] = {
      step: {
        id: startContainerId,
        name: 'start_container',
        status: 'pending',
        metadata: { nodeId, containerName },
      },
    };
    deps.push([pushConfigId, startContainerId]); // push_config before start_container

    const healthCheckId = crypto.randomUUID();
    nodes[healthCheckId] = {
      step: {
        id: healthCheckId,
        name: 'health_check',
        status: 'pending',
        metadata: { instanceId, nodeId, containerName, timeoutMs: 120_000 },
      },
    };
    deps.push([startContainerId, healthCheckId]); // start_container before health_check

    return { nodes, deps };
  }
  // ─────────────────────────────────────────────────────────────────

  // Classify mutations to determine which actions are needed
  let needsPluginInstall = false;
  let needsConfigPush = false;
  let needsFileWrite = false;
  let needsContainerUpgrade = false;
  let containerUpgradeTag: string | undefined;
  // Resource recreate: cpus/memory change requires stop → destroy → recreate with new limits
  let needsResourceRecreate = false;
  let newResourceCpus: string | undefined;
  let newResourceMemory: string | undefined;

  for (const mutation of mutations) {
    const classification = classifyMutation(mutation);
    if (classification.affectsPlugins) needsPluginInstall = true;
    if (classification.affectsConfig) needsConfigPush = true;
    if (classification.affectsWorkspace) needsFileWrite = true;
    if (classification.affectsContainer) {
      // Distinguish resource changes (cpus/memory) from version upgrades (targetVersion)
      if (
        mutation.entityType === 'instance' &&
        (mutation.payload.cpus !== undefined || mutation.payload.memory !== undefined)
      ) {
        needsResourceRecreate = true;
        newResourceCpus = mutation.payload.cpus ?? newResourceCpus;
        newResourceMemory = mutation.payload.memory ?? newResourceMemory;
        // config change alongside resource change needs push_config after recreation
        if (mutation.payload.config !== undefined) needsConfigPush = true;
      } else {
        needsContainerUpgrade = true;
        containerUpgradeTag = mutation.payload.targetVersion ?? containerUpgradeTag;
      }
    }
  }

  const needsRestart = needsConfigPush;

  // Resource recreate: stop → destroy → create with new limits → push_config → start → health_check
  if (needsResourceRecreate) {
    const image = resolveInstanceImage(instanceId);
    const resolvedCpus = newResourceCpus ?? instance?.cpus ?? '1';
    const resolvedMemory = newResourceMemory ?? instance?.memory ?? '2g';

    const nodes: StepDAG['nodes'] = {};
    const deps: StepDAG['deps'] = [];

    const stopContainerId = crypto.randomUUID();
    nodes[stopContainerId] = {
      step: {
        id: stopContainerId,
        name: 'stop_container',
        status: 'pending',
        metadata: { nodeId, containerName },
      },
    };

    const destroyContainerId = crypto.randomUUID();
    nodes[destroyContainerId] = {
      step: {
        id: destroyContainerId,
        name: 'destroy_container',
        status: 'pending',
        metadata: { nodeId, containerName },
      },
    };
    deps.push([stopContainerId, destroyContainerId]);

    const createContainerId = crypto.randomUUID();
    nodes[createContainerId] = {
      step: {
        id: createContainerId,
        name: 'create_container',
        status: 'pending',
        metadata: {
          nodeId,
          containerName,
          image,
          env: instance ? [
            `OPENCLAW_INSTANCE_ID=${instance.id}`,
            `OPENCLAW_INSTANCE_NAME=${instance.name}`,
          ] : [],
          volumes: instance ? {
            data: `/data/armada/instances/${instance.name}`,
            plugins: `/data/armada/instances/${instance.name}/plugins`,
          } : {},
          resources: { memory: resolvedMemory, cpus: resolvedCpus },
          network: 'armada-net',
          labels: instance ? {
            'armada.instance': instance.id,
            'armada.instance.name': instance.name,
          } : {},
        },
      },
    };
    deps.push([destroyContainerId, createContainerId]);

    const pushConfigId = crypto.randomUUID();
    nodes[pushConfigId] = {
      step: {
        id: pushConfigId,
        name: 'push_config',
        status: 'pending',
        metadata: { instanceId, configVersion, nodeId, containerName },
      },
    };
    deps.push([createContainerId, pushConfigId]);

    const startContainerId = crypto.randomUUID();
    nodes[startContainerId] = {
      step: {
        id: startContainerId,
        name: 'start_container',
        status: 'pending',
        metadata: { nodeId, containerName },
      },
    };
    deps.push([pushConfigId, startContainerId]);

    const healthCheckId = crypto.randomUUID();
    nodes[healthCheckId] = {
      step: {
        id: healthCheckId,
        name: 'health_check',
        status: 'pending',
        metadata: { instanceId, nodeId, containerName, timeoutMs: 120_000 },
      },
    };
    deps.push([startContainerId, healthCheckId]);

    return { nodes, deps };
  }

  // Container upgrade goes first (replaces the running container with a new image)
  if (needsContainerUpgrade) {
    const nodes: StepDAG['nodes'] = {};
    const deps: StepDAG['deps'] = [];

    const upgradeId = crypto.randomUUID();
    nodes[upgradeId] = {
      step: {
        id: upgradeId,
        name: 'container_upgrade',
        status: 'pending',
        metadata: {
          nodeId,
          containerName,
          tag: containerUpgradeTag ?? 'latest',
        },
      },
    };

    const healthCheckId = crypto.randomUUID();
    nodes[healthCheckId] = {
      step: {
        id: healthCheckId,
        name: 'health_check',
        status: 'pending',
        metadata: { instanceId, nodeId, containerName, timeoutMs: 120_000 },
      },
    };
    deps.push([upgradeId, healthCheckId]); // container_upgrade before health_check

    return { nodes, deps };
  }

  // Build minimal step DAG based on what changed
  const nodes: StepDAG['nodes'] = {};
  const deps: StepDAG['deps'] = [];

  let installPluginsId: string | undefined;
  let pushFilesId: string | undefined;

  if (needsPluginInstall) {
    // Resolve plugin details from pending plugin mutations (or fall back to library lookup)
    const pluginsToInstall: Array<{ name: string; npmPkg?: string; source?: string; url?: string; version?: string }> = [];
    const seenPluginIds = new Set<string>();

    for (const mutation of pluginMutations) {
      if (!mutation.entityId || seenPluginIds.has(mutation.entityId)) continue;
      seenPluginIds.add(mutation.entityId);
      const entry = pluginLibraryRepo.get(mutation.entityId);
      if (entry) {
        pluginsToInstall.push({
          name: entry.name,
          npmPkg: entry.npmPkg ?? undefined,
          source: entry.source ?? 'github',
          url: entry.url ?? undefined,
          version: mutation.payload.version ?? entry.version ?? undefined,
        });
      }
    }

    // If no explicit plugins found in mutations, fall back to the armada agent plugin
    if (pluginsToInstall.length === 0) {
      pluginsToInstall.push({ name: '@coderage-labs/armada-agent-plugin', version: AGENT_PLUGIN_VERSION });
    }

    installPluginsId = crypto.randomUUID();
    nodes[installPluginsId] = {
      step: {
        id: installPluginsId,
        name: 'install_plugins',
        status: 'pending',
        metadata: {
          nodeId,
          containerName,
          pluginsDir: instance ? `/data/armada/instances/${instance.name}/plugins` : undefined,
          plugins: pluginsToInstall,
        },
      },
    };
  }

  if (needsFileWrite) {
    // Resolve workspace files from mutations
    const files = resolveFileWrites(mutations, instanceId);
    pushFilesId = crypto.randomUUID();
    nodes[pushFilesId] = {
      step: {
        id: pushFilesId,
        name: 'push_files',
        status: 'pending',
        metadata: { nodeId, containerName, files },
      },
    };
  }

  if (needsConfigPush) {
    const pushConfigId = crypto.randomUUID();
    nodes[pushConfigId] = {
      step: {
        id: pushConfigId,
        name: 'push_config',
        status: 'pending',
        metadata: { instanceId, configVersion, nodeId, containerName },
      },
    };

    // push_config depends on BOTH install_plugins and push_files (if they exist)
    if (installPluginsId) {
      deps.push([installPluginsId, pushConfigId]);
    }
    if (pushFilesId) {
      deps.push([pushFilesId, pushConfigId]);
    }

    if (needsRestart) {
      const restartId = crypto.randomUUID();
      nodes[restartId] = {
        step: {
          id: restartId,
          name: 'restart_gateway',
          status: 'pending',
          metadata: { nodeId, containerName },
        },
      };
      deps.push([pushConfigId, restartId]); // push_config before restart_gateway

      const healthCheckId = crypto.randomUUID();
      nodes[healthCheckId] = {
        step: {
          id: healthCheckId,
          name: 'health_check',
          status: 'pending',
          metadata: { instanceId, nodeId, containerName, timeoutMs: 60_000 },
        },
      };
      deps.push([restartId, healthCheckId]); // restart_gateway before health_check
    }
  }

  return { nodes, deps };
}
