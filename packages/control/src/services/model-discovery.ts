/**
 * Model discovery service — fetches available models from each provider's API.
 */

import { modelProviderRepo } from '../repositories/model-provider-repo.js';
import { providerApiKeyRepo } from '../repositories/provider-api-key-repo.js';
import { modelRegistryRepo } from '../repositories/model-repo.js';

export interface DiscoveredModel {
  modelId: string;
  name: string;
  description?: string;
  maxTokens?: number;
  capabilities?: string[];
}

async function discoverAnthropic(apiKey: string, baseUrl?: string | null): Promise<DiscoveredModel[]> {
  const base = baseUrl || 'https://api.anthropic.com';
  const isOAuth = apiKey.includes('sk-ant-oat');
  const headers: Record<string, string> = {
    'anthropic-version': '2023-06-01',
    'accept': 'application/json',
  };
  if (isOAuth) {
    // OAuth tokens require Bearer auth + Claude Code identity headers
    headers['Authorization'] = `Bearer ${apiKey}`;
    headers['anthropic-beta'] = 'claude-code-20250219,oauth-2025-04-20';
    headers['user-agent'] = 'claude-cli/2.1.62';
    headers['x-app'] = 'cli';
  } else {
    headers['x-api-key'] = apiKey;
  }
  const res = await fetch(`${base}/v1/models`, { headers });
  if (!res.ok) throw new Error(`Anthropic API error: ${res.status} ${await res.text()}`);
  const json = await res.json() as any;
  const models: any[] = json.data || [];
  return models
    .filter((m: any) => m.id && (m.id.includes('claude') || m.type === 'model'))
    .map((m: any) => ({
      modelId: m.id,
      name: m.display_name || m.id,
      description: m.description,
      maxTokens: m.context_window,
      capabilities: inferAnthropicCapabilities(m.id),
    }));
}

function inferAnthropicCapabilities(modelId: string): string[] {
  const caps: string[] = ['tools'];
  if (modelId.includes('sonnet') || modelId.includes('opus') || modelId.includes('haiku')) {
    caps.push('thinking');
  }
  if (modelId.includes('claude-3')) caps.push('vision');
  return caps;
}

async function discoverOpenAI(apiKey: string, baseUrl?: string | null): Promise<DiscoveredModel[]> {
  const base = baseUrl || 'https://api.openai.com';
  const res = await fetch(`${base}/v1/models`, {
    headers: {
      'Authorization': `Bearer ${apiKey}`,
    },
  });
  if (!res.ok) throw new Error(`OpenAI API error: ${res.status} ${await res.text()}`);
  const json = await res.json() as any;
  const models: any[] = json.data || [];
  // Filter to chat/completion models
  const chatModels = models.filter((m: any) =>
    m.id && (m.id.startsWith('gpt-') || m.id.startsWith('o1') || m.id.startsWith('o3') || m.id.startsWith('chatgpt'))
  );
  return chatModels.map((m: any) => ({
    modelId: m.id,
    name: m.id,
    capabilities: inferOpenAICapabilities(m.id),
  }));
}

function inferOpenAICapabilities(modelId: string): string[] {
  const caps: string[] = ['tools'];
  if (modelId.includes('vision') || modelId.includes('4o') || modelId.includes('4-turbo')) caps.push('vision');
  if (modelId.startsWith('o1') || modelId.startsWith('o3')) caps.push('thinking');
  if (modelId.includes('dall-e') || modelId.includes('gpt-image')) caps.push('image-generation');
  return caps;
}

async function discoverOpenRouter(apiKey?: string | null, _baseUrl?: string | null): Promise<DiscoveredModel[]> {
  const headers: Record<string, string> = {};
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  const res = await fetch('https://openrouter.ai/api/v1/models', { headers });
  if (!res.ok) throw new Error(`OpenRouter API error: ${res.status} ${await res.text()}`);
  const json = await res.json() as any;
  const models: any[] = json.data || [];
  return models
    .filter((m: any) => m.id && (m.context_length || m.top_provider))
    .map((m: any) => ({
      modelId: m.id,
      name: m.name || m.id,
      description: m.description,
      maxTokens: m.context_length,
      capabilities: inferOpenRouterCapabilities(m),
    }));
}

function inferOpenRouterCapabilities(m: any): string[] {
  const caps: string[] = ['tools'];
  const arch = m.architecture;
  if (arch?.modality?.includes('image') && arch?.modality?.includes('text')) caps.push('vision');
  // OpenRouter exposes image generation via modality or model ID patterns
  const modality = arch?.modality || '';
  const outputModality = modality.split('->')[1] || '';
  if (m.id?.includes('dall-e') || m.id?.includes('stable-diffusion') || m.id?.includes('flux') ||
      m.id?.includes('midjourney') || m.id?.includes('imagen') || m.id?.includes('gpt-image') ||
      m.id?.includes('-image') ||
      (arch?.output_modality === 'image') || outputModality.includes('image')) {
    caps.push('image-generation');
  }
  return [...new Set(caps)]; // dedupe
}

async function discoverGoogle(apiKey: string, baseUrl?: string | null): Promise<DiscoveredModel[]> {
  const base = baseUrl || 'https://generativelanguage.googleapis.com';
  const res = await fetch(`${base}/v1/models?key=${encodeURIComponent(apiKey)}`);
  if (!res.ok) throw new Error(`Google API error: ${res.status} ${await res.text()}`);
  const json = await res.json() as any;
  const models: any[] = json.models || [];
  // Filter to generative models
  return models
    .filter((m: any) => m.supportedGenerationMethods?.includes('generateContent'))
    .map((m: any) => {
      const modelId = (m.name as string).replace('models/', '');
      return {
        modelId,
        name: m.displayName || modelId,
        description: m.description,
        maxTokens: m.outputTokenLimit,
        capabilities: inferGoogleCapabilities(modelId),
      };
    });
}

function inferGoogleCapabilities(modelId: string): string[] {
  const caps: string[] = ['tools'];
  if (modelId.includes('vision') || modelId.includes('flash') || modelId.includes('pro')) caps.push('vision');
  return caps;
}

type Discoverer = (apiKey: string, baseUrl?: string | null) => Promise<DiscoveredModel[]>;

async function discoverOllama(_key: string, baseUrl?: string | null): Promise<DiscoveredModel[]> {
  const url = baseUrl || 'http://localhost:11434';
  const res = await fetch(`${url}/api/tags`);
  if (!res.ok) throw new Error(`Ollama API error: ${res.status}`);
  const data = await res.json() as { models?: Array<{ name: string; modified_at?: string }> };
  return (data.models || []).map(m => ({
    modelId: m.name,
    name: m.name,
    description: 'Local model',
  }));
}

const discoverers: Record<string, Discoverer> = {
  anthropic: discoverAnthropic,
  openai: discoverOpenAI,
  openrouter: (key, url) => discoverOpenRouter(key, url),
  google: discoverGoogle,
  ollama: discoverOllama,
};

/**
 * Discover models for a given provider without syncing to registry.
 * Used by the Models CRUD dialog to let users pick a model.
 */
// In-memory cache: providerId → { models, fetchedAt }
const modelCache = new Map<string, { models: DiscoveredModel[]; fetchedAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export async function discoverProviderModelsWithKey(provider: { type: string; baseUrl?: string | null }, apiKey: string): Promise<DiscoveredModel[]> {
  const discoverer = discoverers[provider.type];
  if (!discoverer) throw new Error(`Unknown provider type: ${provider.type}`);
  return discoverer(apiKey, provider.baseUrl);
}

export async function discoverProviderModels(providerId: string, query?: string): Promise<DiscoveredModel[]> {
  const provider = modelProviderRepo.getById(providerId);
  if (!provider) throw new Error(`Provider not found: ${providerId}`);

  const discoverer = discoverers[provider.type];
  if (!discoverer) return [];

  // Get API key from provider_api_keys table (default key), fall back to legacy provider.apiKey
  const defaultKeyEntry = providerApiKeyRepo.getDefault(providerId);
  const apiKey = defaultKeyEntry?.apiKey ?? provider.apiKey ?? null;

  if (!apiKey && !['openrouter', 'ollama'].includes(provider.type)) {
    throw new Error(`Provider "${provider.name}" has no API key configured`);
  }

  // Use cache if fresh
  const cached = modelCache.get(providerId);
  let models: DiscoveredModel[];
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    models = cached.models;
  } else {
    models = await discoverer(apiKey || '', provider.baseUrl);
    modelCache.set(providerId, { models, fetchedAt: Date.now() });
  }

  // Filter by query if provided
  if (query) {
    const q = query.toLowerCase();
    return models.filter(m =>
      m.modelId.toLowerCase().includes(q) ||
      m.name.toLowerCase().includes(q)
    );
  }

  return models;
}

/** Provider capabilities based on type */
export function getProviderCapabilities(type: string): { canList: boolean; canSearch: boolean } {
  // All providers support listing; none have native search (we filter server-side)
  const listable = ['anthropic', 'openai', 'openrouter', 'google', 'ollama'];
  return { canList: listable.includes(type), canSearch: false };
}

/**
 * Sync models for a given provider: discover from API and upsert into model registry.
 */
export async function syncProviderModels(providerId: string): Promise<{ count: number }> {
  const provider = modelProviderRepo.getById(providerId);
  if (!provider) throw new Error(`Provider not found: ${providerId}`);

  const discoverer = discoverers[provider.type];
  if (!discoverer) throw new Error(`No discoverer for provider type: ${provider.type}`);

  // Get API key from provider_api_keys table (default key), fall back to legacy provider.apiKey
  const defaultKeyEntry = providerApiKeyRepo.getDefault(providerId);
  const apiKey = defaultKeyEntry?.apiKey ?? provider.apiKey ?? null;

  if (!apiKey && !['openrouter', 'ollama'].includes(provider.type)) {
    throw new Error(`Provider "${provider.name}" has no API key configured`);
  }

  const discovered = await discoverer(apiKey || '', provider.baseUrl);

  let count = 0;
  for (const model of discovered) {
    try {
      modelRegistryRepo.upsertDiscovered({
        name: model.name,
        provider: provider.type,
        modelId: model.modelId,
        description: model.description,
        capabilities: model.capabilities,
        maxTokens: model.maxTokens,
        providerId,
      });
      count++;
    } catch (err) {
      // Skip individual model errors (e.g. name conflicts)
      console.warn(`Skipping model ${model.modelId}:`, err);
    }
  }

  modelProviderRepo.updateSyncStatus(providerId, count);
  return { count };
}
