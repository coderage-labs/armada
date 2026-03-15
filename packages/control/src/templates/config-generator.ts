import { randomBytes } from 'node:crypto';
import type { Template } from '@coderage-labs/armada-shared';
import { resolveDeep } from './resolver.js';
import { settingsRepo, modelRegistryRepo } from '../repositories/index.js';
import { resolveTemplateModel, resolveModelAliases } from '../services/model-resolver.js';

export interface GenerateConfigOptions {
  template: Template;
  agentName: string;
  port: number;
  pluginsPath: string;  // container-internal path for plugins
  gatewayToken?: string;
  orgHooksToken?: string;     // shared org-level hooks token
}

/**
 * Generate a valid openclaw.json configuration from a template.
 * Matches the actual OpenClaw config schema (2026.3.x).
 */
export function generateOpenClawConfig(opts: GenerateConfigOptions): { config: object; gatewayToken: string } {
  const { template, agentName, pluginsPath } = opts;
  const gatewayToken = opts.gatewayToken ?? randomBytes(32).toString('hex');
  const hooksToken = opts.orgHooksToken ?? randomBytes(32).toString('hex');

  const vars: Record<string, string> = {
    agent_name: agentName,
    role: template.role,
    skills: template.skills,
  };

  // Build plugin entries as an object keyed by plugin id
  const pluginEntries: Record<string, unknown> = {};
  const pluginLoadPaths: string[] = [];
  const pluginAllow: string[] = [];

  // Legacy plugins array (manual entries)
  for (const p of template.plugins) {
    pluginAllow.push(p.id);
    pluginLoadPaths.push(`${pluginsPath}/${p.id}`);
    pluginEntries[p.id] = {
      enabled: true,
      ...(p.config ? { config: resolveDeep(p.config, vars) } : {}),
    };
  }

  // Plugin library entries (from pluginsList)
  for (const p of template.pluginsList || []) {
    if (!pluginAllow.includes(p.name)) {
      pluginAllow.push(p.name);
      pluginLoadPaths.push(`${pluginsPath}/${p.name}`);
      pluginEntries[p.name] = { enabled: true };
    }
  }

  // Build plugin install metadata (required for OpenClaw to load plugins)
  const pluginInstalls: Record<string, unknown> = {};
  for (const p of template.plugins) {
    pluginInstalls[p.id] = {
      source: 'path',
      spec: `@coderage-labs/${p.id}@0.15.0`,
      installPath: `${pluginsPath}/${p.id}`,
      version: '0.15.0',
      resolvedName: `@coderage-labs/${p.id}`,
      resolvedVersion: '0.15.0',
      resolvedSpec: `@coderage-labs/${p.id}@0.15.0`,
    };
  }
  for (const p of template.pluginsList || []) {
    if (!pluginInstalls[p.name]) {
      pluginInstalls[p.name] = {
        source: 'path',
        spec: `${p.name}@${p.version || '0.1.0'}`,
        installPath: `${pluginsPath}/${p.name}`,
        version: p.version || '0.1.0',
        resolvedName: p.name,
        resolvedVersion: p.version || '0.1.0',
        resolvedSpec: `${p.name}@${p.version || '0.1.0'}`,
      };
    }
  }

  // Provision armada-agent plugin if we have orgHooksToken (armada is enabled)
  if (opts.orgHooksToken) {
    // Add armada-agent plugin entry
    pluginAllow.push('armada-agent');
    pluginLoadPaths.push(`${pluginsPath}/armada-agent`);
    pluginEntries['armada-agent'] = {
      enabled: true,
      config: {
        org: 'default',
        instanceName: agentName,
        role: template.role || '',
        hooksToken: opts.orgHooksToken || '',
        // Agents reach the control plane via the local gateway proxy (port 3002)
        // The control plane handles task routing to all agents
        armadaApiUrl: process.env.ARMADA_CONTROL_URL || process.env.ARMADA_AGENT_GATEWAY_URL || 'http://armada-gateway:3002',
        armadaApiToken: '',
        // Node agent proxy URL for remote deployments
        proxyUrl: process.env.ARMADA_AGENT_PROXY_URL || '',
      },
    };
    pluginInstalls['armada-agent'] = {
      source: 'path',
      spec: '@coderage-labs/armada-agent@0.1.0',
      installPath: `${pluginsPath}/armada-agent`,
      version: '0.1.0',
      resolvedName: '@coderage-labs/armada-agent',
      resolvedVersion: '0.1.0',
      resolvedSpec: '@coderage-labs/armada-agent@0.1.0',
    };
  }

  const config: Record<string, unknown> = {
    update: {
      channel: 'stable',
      checkOnStart: false,
    },
    browser: {
      headless: true,
      noSandbox: true,
      defaultProfile: 'openclaw',
    },
    secrets: {
      providers: {
        'armada-creds': {
          source: 'file',
          path: '/etc/armada/secrets.json',
          mode: 'json',
        },
      },
    },
    models: {
      mode: 'merge',
      providers: {
        anthropic: {
          apiKey: { source: 'file', provider: 'armada-creds', id: 'ANTHROPIC_API_KEY' },
          baseUrl: 'https://api.anthropic.com',
          models: [],
        },
      },
    },
    agents: {
      defaults: {
        model: {
          primary: resolveTemplateModel(template) || 'anthropic/claude-sonnet-4-5',
        },
        models: resolveModelAliases(),
        contextPruning: {
          mode: 'cache-ttl',
          ttl: '1h',
        },
        compaction: {
          mode: 'safeguard',
        },
        heartbeat: {
          every: '30m',
        },
      },
      list: (() => {
        const agentsList: any[] = [
          { id: 'main', name: 'main' }  // lead agent is always 'main'
        ];

        // Add internal agents from template
        if (template.internalAgents?.length) {
          for (const agent of template.internalAgents) {
            const entry: Record<string, any> = {
              id: agent.name.toLowerCase().replace(/\s+/g, '-'),
              name: agent.name,
            };
            if (agent.model) {
              // Resolve model through registry if it's a name, otherwise use as-is
              let resolvedModel = agent.model;
              if (!agent.model.includes('/')) {
                const byName = modelRegistryRepo.getByName(agent.model);
                if (byName) resolvedModel = `${byName.provider}/${byName.modelId}`;
              }
              entry.model = { primary: resolvedModel };
            }
            if (agent.toolsProfile) {
              entry.tools = { profile: agent.toolsProfile };
            }
            if (agent.toolsAllow?.length) {
              entry.tools = { ...(entry.tools || {}), allow: agent.toolsAllow };
            }
            if (agent.soul) {
              entry.identity = { name: agent.name };
            }
            agentsList.push(entry);
          }
        }

        return agentsList;
      })(),
    },
    commands: {
      native: 'auto',
      nativeSkills: 'auto',
      bash: true,
      restart: true,
      ownerDisplay: 'raw',
    },
    hooks: {
      enabled: true,
      token: hooksToken,
      mappings: [
        { match: { path: '/agent' }, action: 'agent', name: 'Armada agent inbound' },
      ],
    },
    channels: {
      telegram: {
        enabled: true,
        dmPolicy: 'pairing',
        groupPolicy: 'allowlist',
        streaming: 'partial',
      },
    },
    gateway: {
      mode: 'local',
      auth: {
        mode: 'token',
        token: gatewayToken,
      },
      trustedProxies: ['127.0.0.1/32'],
      remote: {
        token: gatewayToken,
      },
    },
    plugins: {
      allow: pluginAllow,
      entries: pluginEntries,
      installs: pluginInstalls,
      load: {
        paths: pluginLoadPaths,
      },
    },
  };

  // Tools configuration — allowlist only (deny lists removed)
  const tools: Record<string, unknown> = {};
  if (template.toolsAllow && template.toolsAllow.length > 0) {
    tools.allow = template.toolsAllow;
  }
  if (template.toolsProfile) {
    tools.profile = template.toolsProfile;
  }
  if (Object.keys(tools).length > 0) {
    config.tools = tools;
  }

  return { config, gatewayToken };
}
