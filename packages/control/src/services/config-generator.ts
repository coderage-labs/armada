/**
 * Config Generator — builds openclaw.json config sections from DB state.
 *
 * Translates armada's model_providers + provider_api_keys + model_registry
 * into the openclaw.json `models.providers` format.
 */

import crypto from 'node:crypto';
import { getDrizzle } from '../db/drizzle.js';
import { modelProviders, providerApiKeys, modelRegistry, templates, agents } from '../db/drizzle-schema.js';
import { instancesRepo, templatesRepo } from '../repositories/index.js';
import { eq } from 'drizzle-orm';
import { resolveTemplateModel } from './model-resolver.js';

// Armada provider type → OpenClaw API type
const PROVIDER_API_MAP: Record<string, string> = {
  anthropic: 'anthropic-messages',
  openai: 'openai-completions',
  openrouter: 'openai-completions',
  google: 'google-generative-ai',
  ollama: 'ollama',
  bedrock: 'bedrock-converse-stream',
  'github-copilot': 'github-copilot',
  'openai-compat': 'openai-completions',
};

// Armada provider type → default base URL (if not custom)
const PROVIDER_BASE_URL: Record<string, string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  google: 'https://generativelanguage.googleapis.com',
  ollama: 'http://localhost:11434',
};

export interface GeneratedConfig {
  gateway?: {
    auth?: {
      mode?: string;
      token?: string;
    };
    controlUi?: {
      dangerouslyAllowHostHeaderOriginFallback?: boolean;
    };
    reload?: {
      mode?: string;
    };
  };
  session?: {
    reset?: {
      mode?: string;
      idleMinutes?: number;
    };
  };
  models: {
    mode: 'merge';
    providers: Record<string, {
      baseUrl?: string;
      apiKey?: string;
      api: string;
      models: Array<{ id: string; name: string }>;
    }>;
    /** Fallback model entries — generated when a provider has fallbackEnabled=true (#303) */
    fallbacks?: Array<{
      provider: string;
      apiKey: string;
      fallbackFor: string;
      behavior?: 'immediate' | 'backoff';
    }>;
  };
  agent?: {
    model?: {
      primary?: string;
    };
  };
  agents?: {
    list?: Array<Record<string, any>>;
  };
  plugins?: {
    load?: {
      paths?: string[];
    };
    allow?: string[];
    entries?: Record<string, { config: Record<string, any> }>;
  };
}

/**
 * Generate the `models` section of openclaw.json from DB.
 */
function generateModelsConfig(): GeneratedConfig {
  const db = getDrizzle();

  // Get all enabled, non-hidden providers
  const providers = db.select().from(modelProviders).all()
    .filter(p => p.enabled === 1 && p.hidden === 0);

  // Get all API keys
  const allKeys = db.select().from(providerApiKeys).all();
  const keysByProvider: Record<string, typeof allKeys> = {};
  for (const key of allKeys) {
    if (!keysByProvider[key.providerId]) keysByProvider[key.providerId] = [];
    keysByProvider[key.providerId].push(key);
  }

  // Get all models
  const models = db.select().from(modelRegistry).all();
  const modelsByProvider: Record<string, typeof models> = {};
  for (const m of models) {
    const pid = m.providerId ?? '';
    if (!modelsByProvider[pid]) modelsByProvider[pid] = [];
    modelsByProvider[pid].push(m);
  }

  const configProviders: GeneratedConfig['models']['providers'] = {};
  const fallbacks: NonNullable<GeneratedConfig['models']['fallbacks']> = [];

  for (const provider of providers) {
    const api = PROVIDER_API_MAP[provider.type] ?? 'openai-completions';
    const baseUrl = provider.baseUrl || PROVIDER_BASE_URL[provider.type];

    // Sort keys by priority (lower number = higher priority)
    const keys = (keysByProvider[provider.id] ?? []).slice().sort((a, b) => a.priority - b.priority);
    // Prefer the explicit default key, otherwise use the lowest-priority number
    const defaultKey = keys.find(k => k.isDefault === 1) ?? keys[0];

    // Get models for this provider
    const providerModels = modelsByProvider[provider.id] ?? [];

    const entry: any = { api };
    if (baseUrl) entry.baseUrl = baseUrl;
    if (defaultKey) entry.apiKey = defaultKey.apiKey;

    // Add model list
    entry.models = providerModels.map(m => ({
      id: m.modelId,
      name: m.name,
    }));

    // Use provider type as the key (matches OpenClaw's expected format)
    // For openai-compat, use the provider name (slugified)
    const configKey = provider.type === 'openai-compat'
      ? provider.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')
      : provider.type;

    configProviders[configKey] = entry;

    // ── Fallback entries (#303) ────────────────────────────────────
    // When fallbackEnabled, register each non-primary key as a fallback
    // so OpenClaw can automatically fail over on rate-limit / billing errors.
    if (provider.fallbackEnabled && keys.length > 1) {
      const primaryKey = defaultKey;
      const fallbackKeys = keys.filter(k => k.id !== primaryKey?.id);
      for (const fbKey of fallbackKeys) {
        fallbacks.push({
          provider: configKey,
          apiKey: fbKey.apiKey,
          fallbackFor: configKey,
          behavior: (provider.fallbackBehavior as 'immediate' | 'backoff') ?? 'immediate',
        });
      }
    }
  }

  const modelsConfig: GeneratedConfig['models'] = {
    mode: 'merge',
    providers: configProviders,
  };
  if (fallbacks.length > 0) {
    modelsConfig.fallbacks = fallbacks;
  }

  return {
    gateway: {
      auth: {
        // Pre-generate a token so OpenClaw doesn't overwrite the entire config
        // on first boot when it sees no gateway.auth.token present.
        mode: 'token',
        token: crypto.randomBytes(24).toString('hex'),
      },
      controlUi: {
        // Armada-managed instances don't serve a Control UI externally
        dangerouslyAllowHostHeaderOriginFallback: true,
      },
      reload: {
        // Armada controls restarts — disable config file watcher auto-restart
        mode: 'off',
      },
    },
    session: {
      reset: {
        mode: 'idle',
        idleMinutes: 480,
      },
    },
    models: modelsConfig,
  };
}

/**
 * Build the agents.list config section for an instance from DB.
 */
function generateAgentsList(instanceId: string): Array<Record<string, any>> {
  const db = getDrizzle();

  // Get all agents assigned to this instance
  const instanceAgents = db.select().from(agents).where(eq(agents.instanceId, instanceId)).all();
  if (!instanceAgents.length) return [];

  // Get templates for model/tools/skills resolution (via repo for parsed JSON fields)
  const allTemplates = templatesRepo.getAll();
  const templateMap = new Map(allTemplates.map(t => [t.id, t]));

  return instanceAgents.map(agent => {
    const template = agent.templateId ? templateMap.get(agent.templateId) : undefined;

    const entry: Record<string, any> = {
      id: agent.name,
      name: agent.name,
      workspace: `agents/${agent.name}`,
    };

    // Model: agent override → template → omit
    const model = agent.model || (template ? resolveTemplateModel(template) : null);
    if (model) entry.model = model;

    // Tools from template (toolsAllow is already parsed by template repo)
    if (template?.toolsAllow?.length) {
      entry.tools = { allow: template.toolsAllow };
    }

    // Identity
    entry.identity = {
      name: agent.name,
      emoji: '🤖',
    };

    return entry;
  });
}

/**
 * Generate the full config for an instance, including template-specific settings.
 */
export function generateInstanceConfig(instanceId: string): GeneratedConfig {
  const base = generateModelsConfig();
  const config: GeneratedConfig = { ...base };

  // Check if the instance has a template with a model assignment
  const db = getDrizzle();
  const instance = instancesRepo.getById(instanceId);

  if (instance?.templateId) {
    const template = db.select().from(templates).where(eq(templates.id, instance.templateId)).get();
    if (template?.model) {
      config.agent = {
        model: {
          primary: template.model,
        },
      };
    }
  }

  // Build agents list from DB
  const agentsList = generateAgentsList(instanceId);
  if (agentsList.length > 0) {
    config.agents = { list: agentsList };
  }

  // Configure armada-agent plugin for health reporting
  const controlPlaneUrl = process.env.ARMADA_API_URL || 'http://armada-control:3001';
  const armadaApiToken = '';
  config.plugins = {
    load: {
      // Individual plugin paths inside the instance container — extensions/ is bind-mounted from the node's shared plugins dir
      paths: ['/home/node/.openclaw/extensions/armada-agent'],
    },
    allow: ['armada-agent'],
    entries: {
      'armada-agent': {
        config: {
          instanceName: instance?.name ?? instanceId,
          armadaApiUrl: controlPlaneUrl,
          armadaApiToken,
          // Route plugin→control comms through the node agent gateway proxy.
          // Instances on remote nodes can't reach the control plane directly,
          // but the node agent (armada-node-agent:3002) bridges them via its WS tunnel.
          proxyUrl: process.env.ARMADA_AGENT_GATEWAY_URL || 'http://armada-node-agent:3002',
        },
      },
    },
  };

  return config;
}
