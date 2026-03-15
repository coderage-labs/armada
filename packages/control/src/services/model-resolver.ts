/**
 * Resolve a template's model to a provider/modelId string via the model registry.
 */

import type { Template } from '@coderage-labs/armada-shared';
import { modelRegistryRepo } from '../repositories/index.js';

/**
 * Resolve the effective model for a template.
 * Priority: template.models[] (registry IDs) → template.model (legacy string) → registry lookup by name → fallback.
 */
export function resolveTemplateModel(template: Template): string | undefined {
  // New registry-based selection
  if (template.models?.length) {
    const defaultEntry = template.models.find(m => m.default) || template.models[0];
    const entry = modelRegistryRepo.getById(defaultEntry.registryId);
    if (entry) return `${entry.provider}/${entry.modelId}`;
  }
  // Legacy string
  if (template.model) {
    if (template.model.includes('/')) return template.model;
    const byName = modelRegistryRepo.getByName(template.model);
    if (byName) return `${byName.provider}/${byName.modelId}`;
    return template.model;
  }
  return undefined;
}

/**
 * Build model alias map from the entire registry.
 */
export function resolveModelAliases(): Record<string, { alias: string }> {
  const aliases: Record<string, { alias: string }> = {};
  for (const entry of modelRegistryRepo.getAll()) {
    aliases[`${entry.provider}/${entry.modelId}`] = { alias: entry.name };
  }
  return aliases;
}
