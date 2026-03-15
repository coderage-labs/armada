// ── Activity Service — extracted from routes/activity.ts to break circular deps ──

import { activityRepo } from '../repositories/index.js';
import { eventBus } from '../infrastructure/event-bus.js';
import type { ActivityEvent } from '@coderage-labs/armada-shared';

/** Helper: create + emit an activity event in one call. */
export function logActivity(data: { eventType: string; agentName?: string; detail?: string; metadata?: string }): ActivityEvent {
  const record = activityRepo.create(data);
  eventBus.emit('activity.created', record);
  return record;
}
