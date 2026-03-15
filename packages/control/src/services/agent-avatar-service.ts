/**
 * AgentAvatarService — encapsulates avatar generation, serving, status
 * checking, and deletion for agents.
 *
 * Extracted from routes/agents.ts and agent-manager.ts so the route
 * handler is a thin wrapper and all avatar logic lives here.
 */

import { agentsRepo } from '../repositories/index.js';
import { logActivity } from './activity-service.js';
import { eventBus } from '../infrastructure/event-bus.js';
import {
  avatarExists,
  readAvatar,
  generateAvatar,
  deleteAvatar,
} from './avatar-generator.js';

// ── Types ──────────────────────────────────────────────────────────

export type ServeAvatarResult =
  | { found: false }
  | { found: true; buffer: Buffer; contentType: 'image/png'; cacheControl: string };

export interface AvatarStatusResult {
  generating: boolean;
}

export interface AvatarGenerateResult {
  status: 'generating';
}

export interface AvatarDeleteResult {
  status: 'ok';
}

// ── serveAvatar ────────────────────────────────────────────────────

/**
 * Resolve and return the avatar PNG buffer for an agent at a given size.
 * Returns `found: false` when no avatar exists.
 */
export async function serveAvatar(
  agentName: string,
  sizeParam: string = 'lg',
): Promise<ServeAvatarResult> {
  const size = (['sm', 'md', 'lg'] as const).includes(sizeParam as any)
    ? (sizeParam as 'sm' | 'md' | 'lg')
    : 'lg';

  const exists = await avatarExists(agentName, size);
  if (!exists) return { found: false };

  const buffer = await readAvatar(agentName, size);
  if (!buffer) return { found: false };

  return {
    found: true,
    buffer,
    contentType: 'image/png',
    cacheControl: 'public, max-age=60',
  };
}

// ── getAvatarStatus ────────────────────────────────────────────────

/**
 * Check whether an avatar is currently being generated for an agent.
 */
export function getAvatarStatus(agentName: string): AvatarStatusResult {
  const agent = agentsRepo.getAll().find((a) => a.name === agentName);
  if (!agent) throw Object.assign(new Error('Agent not found'), { statusCode: 404 });
  return { generating: !!(agent as any).avatarGenerating };
}

// ── startAvatarGeneration ──────────────────────────────────────────

/**
 * Kick off background avatar generation for an agent.
 * Sets the `avatarGenerating` flag in the DB, fires off the async
 * generation job, and returns `{ status: 'generating' }` immediately.
 *
 * Emits SSE events:
 *   agent.avatar.generating — when generation starts
 *   agent.avatar.completed  — when generation finishes successfully
 *   agent.avatar.failed     — when generation fails
 */
export function startAvatarGeneration(agentName: string): AvatarGenerateResult {
  const agent = agentsRepo.getAll().find((a) => a.name === agentName);
  if (!agent) throw Object.assign(new Error('Agent not found'), { statusCode: 404 });

  if ((agent as any).avatarGenerating) {
    throw Object.assign(new Error('Avatar generation already in progress'), { statusCode: 409 });
  }

  // Set flag in DB and notify clients
  agentsRepo.update(agent.id, { avatarGenerating: 1 } as any);
  eventBus.emit('agent.updated', { ...agent, avatarGenerating: 1 });
  eventBus.emit('agent.avatar.generating', { agentId: agent.id, agentName: agent.name });

  // Fire-and-forget — generation runs in background
  generateAvatar(agent.name, agent.role || 'general')
    .then((_buffer) => {
      logActivity({ eventType: 'agent.avatar', agentName: agent.name, detail: 'Avatar generated' });
      const currentAgent = agentsRepo.getAll().find((a) => a.id === agent.id);
      const nextVersion = ((currentAgent as any)?.avatarVersion ?? 0) + 1;
      agentsRepo.update(agent.id, { avatarGenerating: 0, avatarVersion: nextVersion } as any);
      const updated = agentsRepo.getAll().find((a) => a.name === agent.name);
      if (updated) eventBus.emit('agent.updated', updated);
      const avatarUrl = `/api/agents/${agent.name}/avatar`;
      eventBus.emit('agent.avatar.completed', { agentId: agent.id, agentName: agent.name, avatarUrl, avatarVersion: nextVersion });
    })
    .catch((err: any) => {
      console.error(`[agent-avatar-service] Failed to generate avatar for ${agent.name}:`, err.message);
      logActivity({ eventType: 'agent.avatar', agentName: agent.name, detail: `Avatar generation failed: ${err.message}` });
      agentsRepo.update(agent.id, { avatarGenerating: 0 } as any);
      const updated = agentsRepo.getAll().find((a) => a.name === agent.name);
      if (updated) eventBus.emit('agent.updated', updated);
      eventBus.emit('agent.avatar.failed', { agentId: agent.id, agentName: agent.name, error: err.message });
    });

  return { status: 'generating' };
}

// ── removeAvatar ───────────────────────────────────────────────────

/**
 * Delete all size variants of an agent's avatar from disk.
 */
export async function removeAvatar(agentName: string): Promise<AvatarDeleteResult> {
  const agent = agentsRepo.getAll().find((a) => a.name === agentName);
  if (!agent) throw Object.assign(new Error('Agent not found'), { statusCode: 404 });

  const deleted = await deleteAvatar(agent.name);
  if (!deleted) throw Object.assign(new Error('No avatar found'), { statusCode: 404 });

  logActivity({ eventType: 'agent.avatar', agentName: agent.name, detail: 'Avatar deleted' });
  return { status: 'ok' };
}
