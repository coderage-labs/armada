import { EVENT_NAMES } from './event-names.js';

/**
 * EVENT_REGISTRY — maps every event to its emitters and listeners for static analysis.
 *
 * "emitters" are the call sites that emit the event.
 * "listeners" are the call sites that subscribe to the event.
 *
 * Wildcard entries (INSTANCE_ALL, OPERATION_ALL) document catch-all subscriptions.
 * Dead listener entries (PROVIDER_*, MODEL_*) are retained for completeness but are
 * never emitted — see EVENT_MAP.md "Dead Listeners" section.
 *
 * Keep this file in sync with EVENT_MAP.md and event-names.ts.
 */
export const EVENT_REGISTRY = {

  // ── Mutation / Changeset pipeline ──────────────────────────────────

  [EVENT_NAMES.MUTATION_STAGED]: {
    emitters:  ['services/mutation-service.ts:stage()'],
    listeners: ['infrastructure/config-version-tracker.ts:initConfigVersionTracker()'],
  },

  [EVENT_NAMES.MUTATION_CREATED]: {
    emitters:  ['services/mutation-service.ts:stage()'],
    listeners: ['infrastructure/event-wiring.ts:initEventWiring() → changesetService.rebuildSteps()'],
  },

  [EVENT_NAMES.CONFIG_CHANGED]: {
    emitters:  ['infrastructure/config-version-tracker.ts:initConfigVersionTracker()'],
    listeners: ['routes/events.ts:SSE stream (forwarded to UI clients)'],
  },

  [EVENT_NAMES.CHANGESET_APPLYING]: {
    emitters:  ['services/changeset-service.ts:apply()'],
    listeners: ['routes/events.ts:SSE stream', 'routes/badges.ts:refresh()'],
  },

  [EVENT_NAMES.CHANGESET_COMPLETED]: {
    emitters:  ['services/changeset-service.ts:apply()'],
    listeners: ['routes/events.ts:SSE stream', 'routes/badges.ts:refresh()'],
  },

  [EVENT_NAMES.CHANGESET_FAILED]: {
    emitters:  ['services/changeset-service.ts:apply()'],
    listeners: ['routes/events.ts:SSE stream', 'routes/badges.ts:refresh()'],
  },

  [EVENT_NAMES.CHANGESET_DISCARDED]: {
    emitters:  ['services/changeset-service.ts:discard()'],
    listeners: ['routes/events.ts:SSE stream'],
  },

  // ── Instance lifecycle ─────────────────────────────────────────────

  [EVENT_NAMES.INSTANCE_RESTARTING]: {
    emitters:  ['services/instance-manager.ts:restart()'],
    listeners: ['routes/events.ts:SSE stream', 'routes/badges.ts:refresh() (via instance.*)'],
  },

  [EVENT_NAMES.INSTANCE_RESTARTED]: {
    emitters:  ['services/instance-manager.ts:restart()'],
    listeners: ['routes/events.ts:SSE stream', 'routes/badges.ts:refresh() (via instance.*)'],
  },

  [EVENT_NAMES.INSTANCE_STOPPED]: {
    emitters:  ['services/instance-manager.ts:stop()'],
    listeners: ['routes/events.ts:SSE stream', 'routes/badges.ts:refresh() (via instance.*)'],
  },

  [EVENT_NAMES.INSTANCE_STARTED]: {
    emitters:  ['services/instance-manager.ts:start()'],
    listeners: ['routes/events.ts:SSE stream', 'routes/badges.ts:refresh() (via instance.*)'],
  },

  [EVENT_NAMES.INSTANCE_RELOADED]: {
    emitters:  ['services/instance-manager.ts:reload()'],
    listeners: ['routes/events.ts:SSE stream', 'routes/badges.ts:refresh() (via instance.*)'],
  },

  [EVENT_NAMES.INSTANCE_UPGRADED]: {
    emitters:  ['services/instance-manager.ts:upgrade()'],
    listeners: ['routes/events.ts:SSE stream', 'routes/badges.ts:refresh() (via instance.*)'],
  },

  [EVENT_NAMES.INSTANCE_UPGRADE_FAILED]: {
    emitters:  ['services/instance-manager.ts:upgrade()'],
    listeners: ['routes/events.ts:SSE stream', 'routes/badges.ts:refresh() (via instance.*)'],
  },

  [EVENT_NAMES.INSTANCE_MAINTENANCE_COMPLETED]: {
    emitters:  ['services/instance-manager.ts:runMaintenance()'],
    listeners: ['routes/events.ts:SSE stream', 'routes/badges.ts:refresh() (via instance.*)'],
  },

  [EVENT_NAMES.INSTANCE_MAINTENANCE_FAILED]: {
    emitters:  ['services/instance-manager.ts:runMaintenance()'],
    listeners: ['routes/events.ts:SSE stream', 'routes/badges.ts:refresh() (via instance.*)'],
  },

  [EVENT_NAMES.INSTANCE_READY]: {
    emitters:  ['routes/instances.ts:POST /api/instances/:id/heartbeat'],
    listeners: ['infrastructure/steps/health-check.ts:healthCheckHandler (races HTTP probe)'],
  },

  /** Wildcard — catches all instance.* events */
  [EVENT_NAMES.INSTANCE_ALL]: {
    emitters:  [],
    listeners: ['routes/badges.ts:refresh()', 'routes/events.ts:SSE stream (topic filter)'],
  },

  // ── Agent lifecycle ────────────────────────────────────────────────

  [EVENT_NAMES.AGENT_SPAWNED]: {
    emitters:  ['services/spawn-manager.ts:spawn()'],
    listeners: ['routes/events.ts:SSE stream'],
  },

  [EVENT_NAMES.AGENT_REMOVED]: {
    emitters:  ['services/agent-manager.ts:removeAgent()'],
    listeners: ['routes/events.ts:SSE stream'],
  },

  [EVENT_NAMES.AGENT_UPDATED]: {
    emitters:  [
      'services/agent-manager.ts:generateAvatar() (during + after avatar generation)',
      'infrastructure/steps/health-check.ts:healthCheckHandler (after status update)',
    ],
    listeners: ['routes/events.ts:SSE stream'],
  },

  [EVENT_NAMES.AGENT_STATUS]: {
    emitters:  ['services/agent-manager.ts:processHeartbeat() (status change only)'],
    listeners: ['routes/events.ts:SSE stream'],
  },

  [EVENT_NAMES.AGENT_HEARTBEAT]: {
    emitters:  ['services/agent-manager.ts:processHeartbeat()'],
    listeners: ['routes/events.ts:SSE stream'],
  },

  /**
   * ⚠️ Non-standard colon separator (`agent:updated`). Will NOT match `agent.*` wildcards.
   * No active emitter or listener found — legacy/unused artefact.
   * @see EVENT_MAP.md "agent:updated" section
   */
  [EVENT_NAMES.AGENT_UPDATED_INTERNAL]: {
    emitters:  [],
    listeners: [],
  },

  // ── Plugin events ──────────────────────────────────────────────────

  [EVENT_NAMES.PLUGIN_INSTALLED]: {
    emitters:  ['services/plugin-manager.ts:install()'],
    listeners: ['infrastructure/config-version-tracker.ts:initConfigVersionTracker()'],
  },

  [EVENT_NAMES.PLUGIN_LIBRARY_ADD]: {
    emitters:  ['services/plugin-manager.ts:addToLibrary()'],
    listeners: ['routes/events.ts:SSE stream'],
  },

  [EVENT_NAMES.PLUGIN_LIBRARY_UPDATE]: {
    emitters:  ['services/plugin-manager.ts:updateInLibrary()'],
    listeners: [
      'infrastructure/config-version-tracker.ts:initConfigVersionTracker()',
      'routes/events.ts:SSE stream',
    ],
  },

  [EVENT_NAMES.PLUGIN_LIBRARY_REMOVE]: {
    emitters:  ['services/plugin-manager.ts:removeFromLibrary()'],
    listeners: [
      'infrastructure/config-version-tracker.ts:initConfigVersionTracker()',
      'routes/events.ts:SSE stream',
    ],
  },

  // ── Operation lifecycle ────────────────────────────────────────────

  [EVENT_NAMES.OPERATION_CREATED]: {
    emitters:  ['infrastructure/operations.ts:create()'],
    listeners: ['routes/operations.ts:SSE (via operation.*)', 'routes/badges.ts:refresh() (via operation.*)'],
  },

  [EVENT_NAMES.OPERATION_RUNNING]: {
    emitters:  ['infrastructure/operations.ts (execution start)'],
    listeners: ['routes/operations.ts:SSE (via operation.*)', 'routes/badges.ts:refresh() (via operation.*)'],
  },

  [EVENT_NAMES.OPERATION_PROGRESS]: {
    emitters:  [
      'infrastructure/operations.ts (step progress callback)',
      'routes/node-ws.ts (forwarding node-reported progress)',
    ],
    listeners: ['routes/operations.ts:SSE (via operation.*)', 'routes/badges.ts:refresh() (via operation.*)'],
  },

  [EVENT_NAMES.OPERATION_STEPS_UPDATED]: {
    emitters:  ['infrastructure/operations.ts (step list change)'],
    listeners: ['routes/operations.ts:SSE (via operation.*)', 'routes/badges.ts:refresh() (via operation.*)'],
  },

  [EVENT_NAMES.OPERATION_COMPLETED]: {
    emitters:  ['infrastructure/operations.ts (success)'],
    listeners: ['routes/operations.ts:SSE (via operation.*)', 'routes/badges.ts:refresh() (via operation.*)'],
  },

  [EVENT_NAMES.OPERATION_FAILED]: {
    emitters:  ['infrastructure/operations.ts (error)'],
    listeners: ['routes/operations.ts:SSE (via operation.*)', 'routes/badges.ts:refresh() (via operation.*)'],
  },

  [EVENT_NAMES.OPERATION_CANCELLED]: {
    emitters:  ['infrastructure/operations.ts (cancellation)'],
    listeners: ['routes/operations.ts:SSE (via operation.*)', 'routes/badges.ts:refresh() (via operation.*)'],
  },

  /** Wildcard — catches all operation.* events */
  [EVENT_NAMES.OPERATION_ALL]: {
    emitters:  [],
    listeners: ['routes/operations.ts:SSE stream', 'routes/badges.ts:refresh()'],
  },

  // ── Task events ────────────────────────────────────────────────────

  [EVENT_NAMES.TASK_CREATED]: {
    emitters:  ['routes/tasks.ts:POST /api/tasks'],
    listeners: ['routes/events.ts:SSE stream'],
  },

  [EVENT_NAMES.TASK_STATUS]: {
    emitters:  [
      'services/task-manager.ts:updateStatus()',
      'routes/tasks.ts:PATCH /api/tasks/:id',
    ],
    listeners: ['routes/events.ts:SSE stream'],
  },

  [EVENT_NAMES.TASK_COMPLETED]: {
    emitters:  ['services/task-manager.ts:updateStatus() (terminal status)'],
    listeners: ['routes/events.ts:SSE stream'],
  },

  // ── Node connectivity ──────────────────────────────────────────────

  [EVENT_NAMES.NODE_CONNECTED]: {
    emitters:  ['ws/node-connections.ts:addConnection()'],
    listeners: ['routes/events.ts:SSE stream'],
  },

  [EVENT_NAMES.NODE_DISCONNECTED]: {
    emitters:  ['ws/node-connections.ts (connection close handler)'],
    listeners: ['routes/events.ts:SSE stream'],
  },

  [EVENT_NAMES.NODE_STALE]: {
    emitters:  ['ws/node-connections.ts (heartbeat staleness check)'],
    listeners: ['routes/events.ts:SSE stream'],
  },

  [EVENT_NAMES.NODE_STATS]: {
    emitters:  ['routes/node-ws.ts (stats message handler)'],
    listeners: ['routes/events.ts:SSE stream'],
  },

  // ── Activity ───────────────────────────────────────────────────────

  [EVENT_NAMES.ACTIVITY_CREATED]: {
    emitters:  ['services/activity-service.ts:logActivity()'],
    listeners: ['routes/activity.ts (forwards to SSE activity stream)'],
  },

  // ── GitHub sync ────────────────────────────────────────────────────

  [EVENT_NAMES.GITHUB_NEW_ISSUES]: {
    emitters:  ['services/issue-sync.ts (polling loop, on new untriaged issues)'],
    listeners: ['services/triage.ts (routes issues to PM-tier agents)'],
  },

  // ── Template ──────────────────────────────────────────────────────

  [EVENT_NAMES.TEMPLATE_UPDATED]: {
    emitters:  ['routes/templates.ts:PATCH /api/templates/:id'],
    listeners: ['routes/events.ts:SSE stream'],
  },

  // ── Webhook inbound ────────────────────────────────────────────────

  [EVENT_NAMES.WEBHOOK_INBOUND_DELIVERED]: {
    emitters:  ['routes/webhooks-inbound.ts (after any webhook action completes)'],
    listeners: ['routes/events.ts:SSE stream'],
  },

  // ── Config-change triggers (dead listeners) ────────────────────────
  // These are subscribed to by config-version-tracker but never emitted —
  // provider/model CRUD routes call logActivity() only, not eventBus.emit().
  // Config bumps for those changes go through the mutation.staged path instead.

  [EVENT_NAMES.PROVIDER_CREATED]: {
    emitters:  [],
    listeners: ['infrastructure/config-version-tracker.ts:initConfigVersionTracker() ⚠️ dead listener'],
  },

  [EVENT_NAMES.PROVIDER_UPDATED]: {
    emitters:  [],
    listeners: ['infrastructure/config-version-tracker.ts:initConfigVersionTracker() ⚠️ dead listener'],
  },

  [EVENT_NAMES.PROVIDER_DELETED]: {
    emitters:  [],
    listeners: ['infrastructure/config-version-tracker.ts:initConfigVersionTracker() ⚠️ dead listener'],
  },

  [EVENT_NAMES.PROVIDER_KEY_CREATED]: {
    emitters:  [],
    listeners: ['infrastructure/config-version-tracker.ts:initConfigVersionTracker() ⚠️ dead listener'],
  },

  [EVENT_NAMES.PROVIDER_KEY_UPDATED]: {
    emitters:  [],
    listeners: ['infrastructure/config-version-tracker.ts:initConfigVersionTracker() ⚠️ dead listener'],
  },

  [EVENT_NAMES.PROVIDER_KEY_DELETED]: {
    emitters:  [],
    listeners: ['infrastructure/config-version-tracker.ts:initConfigVersionTracker() ⚠️ dead listener'],
  },

  [EVENT_NAMES.MODEL_CREATED]: {
    emitters:  [],
    listeners: ['infrastructure/config-version-tracker.ts:initConfigVersionTracker() ⚠️ dead listener'],
  },

  [EVENT_NAMES.MODEL_UPDATED]: {
    emitters:  [],
    listeners: ['infrastructure/config-version-tracker.ts:initConfigVersionTracker() ⚠️ dead listener'],
  },

  [EVENT_NAMES.MODEL_DELETED]: {
    emitters:  [],
    listeners: ['infrastructure/config-version-tracker.ts:initConfigVersionTracker() ⚠️ dead listener'],
  },

} as const;

export type EventRegistry = typeof EVENT_REGISTRY;
