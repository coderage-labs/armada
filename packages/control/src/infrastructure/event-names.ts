/**
 * EVENT_NAMES — canonical string constants for all internal event bus events.
 *
 * Use these instead of raw strings when writing new code to prevent typos
 * and enable IDE autocomplete. Existing emit/on call sites have not been
 * migrated yet — see EVENT_MAP.md for the full reference.
 *
 * Usage:
 *   import { EVENT_NAMES } from './event-names.js';
 *   eventBus.emit(EVENT_NAMES.MUTATION_STAGED, { ... });
 *   eventBus.on(EVENT_NAMES.INSTANCE_ALL, handler);  // wildcard
 */
export const EVENT_NAMES = {
  // ── Mutation / Changeset pipeline ──────────────────────────────────
  MUTATION_STAGED:              'mutation.staged',
  MUTATION_CREATED:             'mutation.created',
  CONFIG_CHANGED:               'config.changed',
  CHANGESET_APPLYING:           'changeset.applying',
  CHANGESET_COMPLETED:          'changeset.completed',
  CHANGESET_FAILED:             'changeset.failed',
  CHANGESET_DISCARDED:          'changeset.discarded',

  // ── Instance lifecycle ─────────────────────────────────────────────
  INSTANCE_RESTARTING:          'instance.restarting',
  INSTANCE_RESTARTED:           'instance.restarted',
  INSTANCE_STOPPED:             'instance.stopped',
  INSTANCE_STARTED:             'instance.started',
  INSTANCE_RELOADED:            'instance.reloaded',
  INSTANCE_UPGRADED:            'instance.upgraded',
  INSTANCE_UPGRADE_FAILED:      'instance.upgrade_failed',
  INSTANCE_MAINTENANCE_COMPLETED: 'instance.maintenance_completed',
  INSTANCE_MAINTENANCE_FAILED:  'instance.maintenance_failed',
  INSTANCE_READY:               'instance.ready',
  /** Wildcard — matches all instance.* events */
  INSTANCE_ALL:                 'instance.*',

  // ── Agent lifecycle ────────────────────────────────────────────────
  AGENT_SPAWNED:                'agent.spawned',
  AGENT_REMOVED:                'agent.removed',
  AGENT_UPDATED:                'agent.updated',
  AGENT_STATUS:                 'agent.status',
  AGENT_HEARTBEAT:              'agent.heartbeat',
  /**
   * Internal health-check colon event — note the non-standard separator.
   * @see infrastructure/steps/health-check.ts
   */
  AGENT_UPDATED_INTERNAL:       'agent:updated',

  // ── Plugin events ──────────────────────────────────────────────────
  PLUGIN_INSTALLED:             'plugin.installed',
  PLUGIN_LIBRARY_ADD:           'plugin.library.add',
  PLUGIN_LIBRARY_UPDATE:        'plugin.library.update',
  PLUGIN_LIBRARY_REMOVE:        'plugin.library.remove',

  // ── Operation lifecycle ────────────────────────────────────────────
  OPERATION_CREATED:            'operation.created',
  OPERATION_RUNNING:            'operation.running',
  OPERATION_PROGRESS:           'operation.progress',
  OPERATION_STEPS_UPDATED:      'operation.steps_updated',
  OPERATION_COMPLETED:          'operation.completed',
  OPERATION_FAILED:             'operation.failed',
  OPERATION_CANCELLED:          'operation.cancelled',
  /** Wildcard — matches all operation.* events */
  OPERATION_ALL:                'operation.*',

  // ── Task events ────────────────────────────────────────────────────
  TASK_CREATED:                 'task.created',
  TASK_STATUS:                  'task.status',
  TASK_COMPLETED:               'task.completed',

  // ── Node connectivity ──────────────────────────────────────────────
  NODE_CONNECTED:               'node.connected',
  NODE_DISCONNECTED:            'node.disconnected',
  NODE_STALE:                   'node.stale',
  NODE_STATS:                   'node.stats',
  NODE_DISCOVERED:              'node.discovered',

  // ── Activity ───────────────────────────────────────────────────────
  ACTIVITY_CREATED:             'activity.created',

  // ── GitHub sync ────────────────────────────────────────────────────
  GITHUB_NEW_ISSUES:            'github.new_issues',

  // ── Template ──────────────────────────────────────────────────────
  TEMPLATE_UPDATED:             'template.updated',

  // ── Webhook inbound ────────────────────────────────────────────────
  WEBHOOK_INBOUND_DELIVERED:    'webhook.inbound.delivered',
  // Note: custom event-action webhooks emit a dynamic name configured in hookActionConfig.eventName

  // ── Config-change triggers (listened by config-version-tracker) ────
  // These are expected to be emitted when provider/model/API-key CRUD
  // occurs. Currently NOT emitted via eventBus (only logActivity is called
  // at those sites) — see EVENT_MAP.md "Dead Listeners" section.
  PROVIDER_CREATED:             'provider.created',
  PROVIDER_UPDATED:             'provider.updated',
  PROVIDER_DELETED:             'provider.deleted',
  PROVIDER_KEY_CREATED:         'provider.key.created',
  PROVIDER_KEY_UPDATED:         'provider.key.updated',
  PROVIDER_KEY_DELETED:         'provider.key.deleted',
  MODEL_CREATED:                'model.created',
  MODEL_UPDATED:                'model.updated',
  MODEL_DELETED:                'model.deleted',
} as const;

export type EventName = typeof EVENT_NAMES[keyof typeof EVENT_NAMES];
