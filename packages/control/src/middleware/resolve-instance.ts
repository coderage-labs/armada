// Shared utility: resolve a fleet instance by ID or name.
// Checks by ID first, then falls back to name lookup.

import { instancesRepo } from '../repositories/index.js';
import type { ArmadaInstance, Agent } from '@coderage-labs/armada-shared';

/**
 * Resolve a fleet instance by ID or name.
 * Returns the instance (with agents array when found by ID), or null if not found.
 */
export function resolveInstance(idOrName: string): (ArmadaInstance & { agents?: Agent[] }) | null {
  return instancesRepo.getById(idOrName) ?? instancesRepo.getByName(idOrName) ?? null;
}
