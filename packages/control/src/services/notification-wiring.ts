/**
 * Notification Wiring (#512)
 *
 * Subscribes to event bus events and triggers sendNotification
 * so configured channels receive alerts for important lifecycle events.
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

  // ── Triage lifecycle ─────────────────────────────────────────────
  eventBus.on('triage.operator_fallback', ({ data }) => {
    sendNotification({
      event: 'triage.operator_fallback',
      message: `Issue <code>#${data?.issueNumber ?? 'unknown'}</code> in project <b>${data?.projectName ?? 'unknown'}</b> requires manual triage: ${data?.reason ?? 'unknown reason'}`,
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

  // ── Workflow lifecycle ───────────────────────────────────────────
  eventBus.on('workflow.completed', ({ data }) => {
    const issue = data?.issueNumber && data?.issueRepo
      ? ` (${data.issueRepo}#${data.issueNumber})`
      : '';
    sendNotification({
      event: 'workflow.completed',
      message: `Workflow <b>${data?.workflowName ?? 'unknown'}</b> completed successfully${issue}\n${data?.stepsCompleted ?? 0}/${data?.totalSteps ?? 0} steps completed.`,
      data,
    }).catch(() => {});
  });

  eventBus.on('workflow.failed', ({ data }) => {
    const issue = data?.issueNumber && data?.issueRepo
      ? ` (${data.issueRepo}#${data.issueNumber})`
      : '';
    const failedStep = data?.failedStepId ? `\nFailed at step: <code>${data.failedStepId}</code>` : '';
    sendNotification({
      event: 'workflow.failed',
      message: `Workflow <b>${data?.workflowName ?? 'unknown'}</b> failed${issue}${failedStep}\n${data?.stepsCompleted ?? 0}/${data?.totalSteps ?? 0} steps completed.`,
      data,
    }).catch(() => {});
  });

  eventBus.on('workflow.gate_reached', ({ data }) => {
    const issue = data?.issueNumber && data?.issueRepo
      ? ` (${data.issueRepo}#${data.issueNumber})`
      : '';
    const stepName = data?.stepName ? ` "${data.stepName}"` : '';
    const checksStatus = data?.checks
      ? `\nChecks: ${(data.checks as any[]).map((c: any) => `${c.passed ? '✅' : '❌'} ${c.name}`).join(', ')}`
      : '';
    sendNotification({
      event: 'workflow.gate_reached',
      message: `Workflow <b>${data?.workflowName ?? 'unknown'}</b> paused at gate${stepName}${issue}${checksStatus}\nAwaiting approval to continue.`,
      data,
    }).catch(() => {});
  });
}
