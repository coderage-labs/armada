/**
 * Changeset Impact Analysis (#83)
 *
 * Analyses a list of pending mutations and determines how disruptive the changeset is.
 * Zero-impact changesets are auto-applied; higher-impact ones need review.
 */

import {
  agentsRepo,
  instancesRepo,
  templatesRepo,
  modelRegistryRepo,
} from '../repositories/index.js';
import type { PendingMutation } from '../repositories/pending-mutation-repo.js';

// ── Types ────────────────────────────────────────────────────────────

export type ImpactLevel = 'none' | 'low' | 'medium' | 'high';

export interface AffectedResource {
  type: string;        // 'agent' | 'template' | 'model' | 'instance' | etc.
  name: string;
  reason: string;
}

export interface ChangesetImpact {
  impactLevel: ImpactLevel;
  affectedResources: AffectedResource[];
  requiresRestart: boolean;
}

// ── Helpers ──────────────────────────────────────────────────────────

/** Return the highest of two impact levels */
function maxImpact(a: ImpactLevel, b: ImpactLevel): ImpactLevel {
  const order: ImpactLevel[] = ['none', 'low', 'medium', 'high'];
  return order[Math.max(order.indexOf(a), order.indexOf(b))];
}

/**
 * Find agents that are currently running (status 'running').
 * Returns an array of running agents.
 */
function getRunningAgents() {
  return agentsRepo.getAll().filter(a => a.status === 'running');
}

/**
 * Find instances that are currently running.
 */
function getRunningInstances() {
  return instancesRepo.getAll().filter(i => i.status === 'running');
}

/**
 * Get all templates that reference a model by name.
 */
function templatesUsingModel(modelName: string) {
  return templatesRepo.getAll().filter(t => {
    // Check `model` field (default model for the template)
    if (t.model === modelName) return true;
    // Check `models` list
    if (Array.isArray(t.models)) {
      return t.models.some((m: any) => m.name === modelName || m.model === modelName);
    }
    return false;
  });
}

/**
 * Check if any running agents are assigned to one of the given template IDs.
 */
function runningAgentsForTemplates(templateIds: string[]): ReturnType<typeof agentsRepo.getAll> {
  if (templateIds.length === 0) return [];
  const running = getRunningAgents();
  return running.filter(a => a.templateId && templateIds.includes(a.templateId));
}

/**
 * Check if any running agents are assigned to one of the given instance IDs.
 */
function runningAgentsForInstances(instanceIds: string[]): ReturnType<typeof agentsRepo.getAll> {
  if (instanceIds.length === 0) return [];
  const running = getRunningAgents();
  return running.filter(a => instanceIds.includes(a.instanceId));
}

// ── Core Analysis ────────────────────────────────────────────────────

/**
 * Analyse a set of pending mutations and return an impact assessment.
 *
 * Impact rules:
 * - Add model/template (nothing references it yet)           → none
 * - Update template (no running agents on it)                → none
 * - Update template (running agents on it)                   → medium
 * - Update template (running agents + restart needed)        → high
 * - Delete model (unused by any template)                    → none
 * - Delete model (used by template but no running agents)    → low
 * - Delete model (used by template with running agents)      → high
 * - Update agent config (agent is running)                   → medium
 * - Update agent config (agent is stopped)                   → low
 * - Delete agent (agent is running)                          → high
 * - Delete agent (agent is stopped)                          → low
 * - Any instance-level mutation                              → high
 */
export function analyseChangesetImpact(mutations: PendingMutation[]): ChangesetImpact {
  let impactLevel: ImpactLevel = 'none';
  const affectedResources: AffectedResource[] = [];
  let requiresRestart = false;

  for (const m of mutations) {
    const { entityType, action, entityId, payload } = m;
    const entityName = payload?.name ?? entityId ?? '(unknown)';

    // ── Model mutations ──────────────────────────────────────────────
    if (entityType === 'model') {
      if (action === 'create') {
        // Adding a new model — nothing references it yet
        affectedResources.push({ type: 'model', name: entityName, reason: 'New model added (no dependencies)' });
        // impactLevel stays 'none'
      } else if (action === 'update' || action === 'delete') {
        const modelName = payload?.name ?? entityId ?? '';
        const usingTemplates = templatesUsingModel(modelName);

        if (usingTemplates.length === 0) {
          // Model exists but no templates reference it
          affectedResources.push({ type: 'model', name: entityName, reason: `Model ${action}d (no templates reference it)` });
          impactLevel = maxImpact(impactLevel, 'none');
        } else {
          const templateIds = usingTemplates.map(t => t.id);
          const runningAgents = runningAgentsForTemplates(templateIds);

          if (runningAgents.length === 0) {
            affectedResources.push({
              type: 'model',
              name: entityName,
              reason: `Model ${action}d — referenced by ${usingTemplates.length} template(s) but no running agents`,
            });
            impactLevel = maxImpact(impactLevel, 'low');
          } else {
            // Running agents depend on this model
            for (const agent of runningAgents) {
              affectedResources.push({
                type: 'agent',
                name: agent.name,
                reason: `Running agent uses model "${entityName}" via template`,
              });
            }
            affectedResources.push({ type: 'model', name: entityName, reason: `Model ${action}d with ${runningAgents.length} dependent running agent(s)` });
            impactLevel = maxImpact(impactLevel, 'high');
            requiresRestart = true;
          }
        }
      }
    }

    // ── Template mutations ───────────────────────────────────────────
    else if (entityType === 'template') {
      if (action === 'create') {
        affectedResources.push({ type: 'template', name: entityName, reason: 'New template added (no running agents yet)' });
        // impactLevel stays 'none'
      } else if (action === 'update' || action === 'delete') {
        const templateId = entityId ?? '';
        const runningAgents = runningAgentsForTemplates([templateId]);

        if (runningAgents.length === 0) {
          affectedResources.push({ type: 'template', name: entityName, reason: `Template ${action}d (no running agents)` });
          impactLevel = maxImpact(impactLevel, 'none');
        } else {
          for (const agent of runningAgents) {
            affectedResources.push({
              type: 'agent',
              name: agent.name,
              reason: `Running agent uses template "${entityName}"`,
            });
          }
          affectedResources.push({
            type: 'template',
            name: entityName,
            reason: `Template ${action}d — ${runningAgents.length} running agent(s) affected`,
          });
          // Deletion of a template with running agents is high; update is medium
          const level: ImpactLevel = action === 'delete' ? 'high' : 'medium';
          impactLevel = maxImpact(impactLevel, level);
          if (action === 'delete') requiresRestart = true;
        }
      }
    }

    // ── Agent mutations ──────────────────────────────────────────────
    else if (entityType === 'agent') {
      if (action === 'create') {
        affectedResources.push({ type: 'agent', name: entityName, reason: 'New agent added' });
        impactLevel = maxImpact(impactLevel, 'low');
      } else if (action === 'update') {
        const agent = entityId ? agentsRepo.getById(entityId) : null;
        if (agent?.status === 'running') {
          affectedResources.push({ type: 'agent', name: agent.name, reason: 'Running agent config updated' });
          impactLevel = maxImpact(impactLevel, 'medium');
        } else {
          affectedResources.push({ type: 'agent', name: agent?.name ?? entityName, reason: 'Stopped agent config updated' });
          impactLevel = maxImpact(impactLevel, 'low');
        }
      } else if (action === 'delete') {
        const agent = entityId ? agentsRepo.getById(entityId) : null;
        if (agent?.status === 'running') {
          affectedResources.push({ type: 'agent', name: agent.name, reason: 'Running agent will be deleted' });
          impactLevel = maxImpact(impactLevel, 'high');
          requiresRestart = true;
        } else {
          affectedResources.push({ type: 'agent', name: agent?.name ?? entityName, reason: 'Stopped agent will be deleted' });
          impactLevel = maxImpact(impactLevel, 'low');
        }
      }
    }

    // ── Instance mutations ───────────────────────────────────────────
    else if (entityType === 'instance') {
      const instance = entityId ? instancesRepo.getById(entityId) : null;
      const name = instance?.name ?? payload?.name ?? entityId ?? '(unknown)';
      if (action === 'create') {
        affectedResources.push({ type: 'instance', name, reason: 'New instance will be provisioned' });
        impactLevel = maxImpact(impactLevel, 'medium');
      } else if (action === 'update') {
        if (instance?.status === 'running') {
          affectedResources.push({ type: 'instance', name, reason: 'Running instance config updated' });
          impactLevel = maxImpact(impactLevel, 'high');
          requiresRestart = true;
        } else {
          affectedResources.push({ type: 'instance', name, reason: 'Stopped instance config updated' });
          impactLevel = maxImpact(impactLevel, 'medium');
        }
      } else if (action === 'delete') {
        affectedResources.push({ type: 'instance', name, reason: 'Instance will be destroyed' });
        impactLevel = maxImpact(impactLevel, 'high');
        requiresRestart = true;
      }
    }

    // ── Provider / API key mutations ─────────────────────────────────
    else if (entityType === 'provider' || entityType === 'api_key') {
      const runningInstances = getRunningInstances();
      if (runningInstances.length === 0) {
        affectedResources.push({ type: entityType, name: entityName, reason: `Provider ${action}d (no running instances)` });
        impactLevel = maxImpact(impactLevel, 'low');
      } else {
        affectedResources.push({
          type: entityType,
          name: entityName,
          reason: `Provider ${action}d — ${runningInstances.length} running instance(s) will need config push`,
        });
        impactLevel = maxImpact(impactLevel, 'medium');
      }
    }

    // ── Plugin mutations ─────────────────────────────────────────────
    else if (entityType === 'plugin') {
      if (action === 'create') {
        affectedResources.push({ type: 'plugin', name: entityName, reason: 'New plugin added to library' });
        // impactLevel stays 'none'
      } else {
        const runningInstances = getRunningInstances();
        if (runningInstances.length === 0) {
          affectedResources.push({ type: 'plugin', name: entityName, reason: `Plugin ${action}d (no running instances)` });
          impactLevel = maxImpact(impactLevel, 'low');
        } else {
          affectedResources.push({
            type: 'plugin',
            name: entityName,
            reason: `Plugin ${action}d — ${runningInstances.length} running instance(s) affected`,
          });
          impactLevel = maxImpact(impactLevel, 'medium');
        }
      }
    }

    // ── Catch-all for other entity types ────────────────────────────
    else {
      affectedResources.push({ type: entityType, name: entityName, reason: `${entityType} ${action}d` });
      impactLevel = maxImpact(impactLevel, 'low');
    }
  }

  return { impactLevel, affectedResources, requiresRestart };
}

/**
 * Get the set of instance IDs that are affected by the given mutations.
 * Used for scoped config-push — only push to instances that need it.
 */
export function getAffectedInstanceIds(mutations: PendingMutation[]): string[] {
  const affected = new Set<string>();

  for (const m of mutations) {
    const { entityType, entityId, payload } = m;

    if (entityType === 'agent') {
      // Agent mutation: affect the agent's instance
      if (entityId) {
        const agent = agentsRepo.getById(entityId);
        if (agent?.instanceId) affected.add(agent.instanceId);
      } else if (payload?.instanceId) {
        affected.add(payload.instanceId);
      }
    } else if (entityType === 'instance') {
      if (entityId) affected.add(entityId);
    } else if (entityType === 'template') {
      // Template mutation: affect instances running agents on this template
      const templateId = entityId ?? '';
      const runningAgents = runningAgentsForTemplates([templateId]);
      for (const a of runningAgents) {
        if (a.instanceId) affected.add(a.instanceId);
      }
    } else if (entityType === 'model') {
      const modelName = payload?.name ?? entityId ?? '';
      const usingTemplates = templatesUsingModel(modelName);
      const runningAgents = runningAgentsForTemplates(usingTemplates.map(t => t.id));
      for (const a of runningAgents) {
        if (a.instanceId) affected.add(a.instanceId);
      }
    } else if (entityType === 'provider' || entityType === 'api_key' || entityType === 'plugin') {
      // These affect all running instances
      const runningInstances = getRunningInstances();
      for (const i of runningInstances) affected.add(i.id);
    }
  }

  return Array.from(affected);
}

/**
 * Get the set of agent IDs that are actually affected by the given mutations.
 * Used for scoped restarts — only restart agents that need it.
 */
export function getAffectedAgentIds(mutations: PendingMutation[]): string[] {
  const affected = new Set<string>();

  for (const m of mutations) {
    const { entityType, action, entityId, payload } = m;

    if (entityType === 'agent') {
      if (entityId) affected.add(entityId);
    } else if (entityType === 'template') {
      const templateId = entityId ?? '';
      const runningAgents = runningAgentsForTemplates([templateId]);
      for (const a of runningAgents) affected.add(a.id);
    } else if (entityType === 'model') {
      const modelName = payload?.name ?? entityId ?? '';
      const usingTemplates = templatesUsingModel(modelName);
      const runningAgents = runningAgentsForTemplates(usingTemplates.map(t => t.id));
      for (const a of runningAgents) affected.add(a.id);
    } else if (entityType === 'instance') {
      if (entityId) {
        const instanceAgents = agentsRepo.getAll().filter(a => a.instanceId === entityId);
        for (const a of instanceAgents) affected.add(a.id);
      }
    }
  }

  return Array.from(affected);
}
