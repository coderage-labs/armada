import type { IntegrationProvider } from './types.js';

const providers = new Map<string, IntegrationProvider>();

export function registerProvider(provider: IntegrationProvider): void {
  providers.set(provider.name, provider);
}

export function getProvider(name: string): IntegrationProvider | undefined {
  return providers.get(name);
}

export function listProviders(): string[] {
  return Array.from(providers.keys());
}
