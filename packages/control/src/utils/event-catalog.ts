/**
 * Event Catalog — defines all available webhook event types.
 *
 * Used by:
 * - GET /api/webhooks/events endpoint (returns catalog grouped by category)
 * - UI webhook event selector (fetches from API)
 * - Documentation / discoverability
 */

export interface EventDef {
  event: string;
  description: string;
  category: string;
}

export const EVENT_CATALOG: EventDef[] = [
  // Tasks
  { event: 'task.created', description: 'A new task was dispatched to an agent', category: 'tasks' },
  { event: 'task.completed', description: 'A task completed successfully', category: 'tasks' },
  { event: 'task.failed', description: 'A task failed', category: 'tasks' },
  { event: 'task.blocked', description: 'A task was marked as blocked', category: 'tasks' },
  { event: 'task.unblocked', description: 'A blocked task was restored', category: 'tasks' },
  { event: 'task.steered', description: 'Mid-task course correction sent', category: 'tasks' },

  // Workflows
  { event: 'workflow.run.started', description: 'A workflow run was initiated', category: 'workflows' },
  { event: 'workflow.run.completed', description: 'All workflow steps completed', category: 'workflows' },
  { event: 'workflow.run.failed', description: 'A workflow run failed', category: 'workflows' },
  { event: 'workflow.run.cancelled', description: 'A workflow run was cancelled', category: 'workflows' },
  { event: 'workflow.step.started', description: 'A workflow step was dispatched', category: 'workflows' },
  { event: 'workflow.step.completed', description: 'A workflow step completed', category: 'workflows' },
  { event: 'workflow.step.failed', description: 'A workflow step failed', category: 'workflows' },
  { event: 'workflow.gate.waiting', description: 'Manual approval gate reached', category: 'workflows' },
  { event: 'workflow.gate.approved', description: 'Manual gate approved', category: 'workflows' },

  // Triage
  { event: 'triage.started', description: 'Issue sent to PM for triage', category: 'triage' },
  { event: 'triage.completed', description: 'PM returned workflow selection', category: 'triage' },
  { event: 'triage.skipped', description: 'No PM available, returned to operator', category: 'triage' },

  // Agents
  { event: 'agent.spawned', description: 'New agent container created', category: 'agents' },
  { event: 'agent.destroyed', description: 'Agent container removed', category: 'agents' },
  { event: 'agent.health.degraded', description: 'Agent stopped responding', category: 'agents' },
  { event: 'agent.health.recovered', description: 'Agent came back online', category: 'agents' },
  { event: 'agent.redeploy', description: 'Agent config regenerated and restarted', category: 'agents' },

  // Operations
  { event: 'deploy.started', description: 'Redeploy initiated', category: 'operations' },
  { event: 'deploy.completed', description: 'Redeploy finished', category: 'operations' },
  { event: 'maintenance.started', description: 'Graceful maintenance began', category: 'operations' },
  { event: 'maintenance.completed', description: 'Maintenance finished', category: 'operations' },
  { event: 'plugin.rollout.started', description: 'Plugin rollout initiated', category: 'operations' },
  { event: 'plugin.rollout.completed', description: 'Plugin rollout finished', category: 'operations' },
  { event: 'plugin.rollout.failed', description: 'Plugin rollout failed with rollback', category: 'operations' },

  // GitHub
  { event: 'github.sync.completed', description: 'GitHub issue sync finished', category: 'github' },

  // Projects
  { event: 'project.created', description: 'New project created', category: 'projects' },
  { event: 'project.updated', description: 'Project settings changed', category: 'projects' },
  { event: 'project.deleted', description: 'Project removed', category: 'projects' },
];

/**
 * Get events grouped by category.
 */
export function getEventsByCategory(): Record<string, EventDef[]> {
  const grouped: Record<string, EventDef[]> = {};
  for (const def of EVENT_CATALOG) {
    if (!grouped[def.category]) grouped[def.category] = [];
    grouped[def.category].push(def);
  }
  return grouped;
}
