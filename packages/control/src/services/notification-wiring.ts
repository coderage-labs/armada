/**
 * Notification Wiring (#512)
 *
 * Subscribes to fleet event bus events and triggers sendNotification
 * so configured channels receive alerts for important fleet lifecycle events.
 *
 * Call `wireNotificationEvents()` once at startup.
 */

import { eventBus } from '../infrastructure/event-bus.js';
import { sendNotification } from './notification-service.js';

export function wireNotificationEvents(): void {
  // ── Changeset lifecycle ──────────────────────────────────────────
  eventBus.on('changeset.completed', ({ data }) => {
    sendNotification({
      event: 'changeset.completed',
      message: `Changeset <code>${data?.changesetId ?? 'unknown'}</code> applied successfully.`,
      data,
    }).catch(() => {});
  });

  eventBus.on('changeset.failed', ({ data }) => {
    sendNotification({
      event: 'changeset.failed',
      message: `Changeset <code>${data?.changesetId ?? 'unknown'}</code> failed: ${data?.error ?? 'unknown error'}`,
      data,
    }).catch(() => {});
  });

  // ── Operation lifecycle ──────────────────────────────────────────
  eventBus.on('operation.completed', ({ data }) => {
    sendNotification({
      event: 'operation.completed',
      message: `Operation <code>${data?.type ?? data?.operationId ?? 'unknown'}</code> completed.`,
      data,
    }).catch(() => {});
  });

  eventBus.on('operation.failed', ({ data }) => {
    sendNotification({
      event: 'operation.failed',
      message: `Operation <code>${data?.type ?? data?.operationId ?? 'unknown'}</code> failed: ${data?.error ?? 'unknown error'}`,
      data,
    }).catch(() => {});
  });

  // ── Instance lifecycle ───────────────────────────────────────────
  eventBus.on('instance.upgrade_failed', ({ data }) => {
    sendNotification({
      event: 'instance.upgrade_failed',
      message: `Instance <code>${data?.name ?? data?.instanceId}</code> upgrade to ${data?.targetVersion ?? 'unknown'} failed.`,
      data,
    }).catch(() => {});
  });

  eventBus.on('instance.stopped', ({ data }) => {
    sendNotification({
      event: 'instance.stopped',
      message: `Instance <code>${data?.name ?? data?.instanceId}</code> stopped.`,
      data,
    }).catch(() => {});
  });
}
