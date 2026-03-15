/**
 * Template Sync Service — diffs agents against their templates and stages mutations.
 */

import diff from 'microdiff';
import { agentsRepo, templatesRepo, pendingMutationRepo } from '../repositories/index.js';
import { mutationService } from './mutation-service.js';
import { resolveTemplateModel } from './model-resolver.js';
import type { Agent, Template } from '@coderage-labs/armada-shared';

// ── Field Classification ──────────────────────────────────────────────

/**
 * Agent-level fields: stored on both template AND agent records.
 * When a template changes, these fields can drift and need syncing to agents.
 * 
 * Config fields require push_config + restart when synced.
 * Workspace fields require file writes.
 * DB-only fields only need DB update.
 * 
 * Note: `models`, `pluginsList`, `skillsList`, `env`, `toolsAllow` are template-only.
 * The config generator reads them directly from the template at push_config time.
 * They do NOT live on the agent record and cannot drift.
 */

/** Config fields stored on the agent — require push_config + restart */
const CONFIG_FIELDS = ['model'] as const;

/** Workspace fields — require push_files, no restart */
const WORKSPACE_FIELDS = ['soul', 'agents'] as const;

/** DB-only fields — fields that exist on both template and agent but don't require instance action */
const DB_ONLY_FIELDS = ['role', 'skills'] as const;

/** Template-only config fields — read by config generator from template, NOT stored on agent */
const TEMPLATE_ONLY_CONFIG_FIELDS = ['models', 'pluginsList', 'skillsList', 'env', 'toolsAllow'] as const;

/** Template-only metadata fields — not synced to agents at all */
// name, description, image, resources are template metadata and don't propagate to agents

export interface FieldDiff {
  field: string;
  templateValue: any;
  agentValue: any;
  category: 'config' | 'workspace' | 'db-only';
}

export interface AgentDrift {
  agentId: string;
  agentName: string;
  instanceId: string;
  instanceName: string;
  drifted: boolean;
  diffs: FieldDiff[];
}

export interface TemplateSyncResult {
  templateId: string;
  templateName: string;
  agentsAffected: number;
  drift: AgentDrift[];
  mutationsCreated: number;
}

// ── Helpers ───────────────────────────────────────────────────────────

function normalizeValue(val: any): any {
  if (val === null || val === undefined) return null;
  if (Array.isArray(val)) return val.length === 0 ? null : val;
  if (typeof val === 'string') return val.trim() === '' ? null : val;
  return val;
}

function valuesEqual(a: any, b: any): boolean {
  const normA = normalizeValue(a);
  const normB = normalizeValue(b);
  if (normA === normB) return true;
  if (normA === null || normB === null) return false;
  // Primitives — direct comparison (microdiff only works on objects/arrays)
  if (typeof normA !== 'object' || typeof normB !== 'object') return normA === normB;
  // Use microdiff — if there are no differences, values are equal
  return diff(normA, normB).length === 0;
}

function diffAgentVsTemplate(agent: Agent, template: Template): FieldDiff[] {
  const diffs: FieldDiff[] = [];

  // Config fields stored on agent (currently just 'model')
  for (const field of CONFIG_FIELDS) {
    const templateVal = field === 'model' ? resolveTemplateModel(template) : (template as any)[field];
    const agentVal = (agent as any)[field];
    if (!valuesEqual(templateVal, agentVal)) {
      diffs.push({
        field,
        templateValue: templateVal,
        agentValue: agentVal,
        category: 'config',
      });
    }
  }

  // Note: template-only config fields (models, pluginsList, skillsList, env, toolsAllow)
  // are NOT compared — they live only on the template and are read by the config generator
  // directly at push_config time. Changing the template is sufficient.

  // Workspace fields — compare template content vs agent's stored content
  const agentSoul = normalizeValue(agent.soul);
  const templateSoul = normalizeValue(template.soul);
  if (!valuesEqual(templateSoul, agentSoul)) {
    diffs.push({
      field: 'soul',
      templateValue: template.soul,
      agentValue: agent.soul,
      category: 'workspace',
    });
  }

  const agentAgentsMd = normalizeValue(agent.agentsMd);
  const templateAgentsMd = normalizeValue(template.agents);
  if (!valuesEqual(templateAgentsMd, agentAgentsMd)) {
    diffs.push({
      field: 'agentsMd',
      templateValue: template.agents,
      agentValue: agent.agentsMd,
      category: 'workspace',
    });
  }

  // DB-only fields
  for (const field of DB_ONLY_FIELDS) {
    const templateVal = (template as any)[field];
    const agentVal = (agent as any)[field];
    if (!valuesEqual(templateVal, agentVal)) {
      diffs.push({
        field,
        templateValue: templateVal,
        agentValue: agentVal,
        category: 'db-only',
      });
    }
  }

  return diffs;
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Compute drift for all agents using this template (dry-run, no mutations).
 */
export function computeTemplateDrift(templateId: string): AgentDrift[] {
  const template = templatesRepo.getById(templateId);
  if (!template) throw new Error(`Template ${templateId} not found`);

  const allAgents = agentsRepo.getAll();
  const agents = allAgents.filter(a => a.templateId === templateId);

  return agents.map(agent => {
    const diffs = diffAgentVsTemplate(agent, template);
    return {
      agentId: agent.id,
      agentName: agent.name,
      instanceId: agent.instanceId,
      instanceName: agent.instanceName ?? '',
      drifted: diffs.length > 0,
      diffs,
    };
  });
}

/**
 * Sync a template to all agents using it — stages pending mutations for agents that drifted.
 */
export function syncTemplateToAgents(templateId: string): TemplateSyncResult {
  const template = templatesRepo.getById(templateId);
  if (!template) throw new Error(`Template ${templateId} not found`);

  const drift = computeTemplateDrift(templateId);
  const drifted = drift.filter(d => d.drifted);

  let mutationsCreated = 0;

  for (const agentDrift of drifted) {
    const agent = agentsRepo.getById(agentDrift.agentId);
    if (!agent) continue;

    // Build update payload from diffs
    const payload: Record<string, any> = {};
    for (const diff of agentDrift.diffs) {
      payload[diff.field] = diff.templateValue;
    }

    // Stage a single mutation for this agent with all field changes
    mutationService.stage('agent', 'update', payload, agentDrift.agentId);
    mutationsCreated++;
  }

  return {
    templateId,
    templateName: template.name,
    agentsAffected: drifted.length,
    drift,
    mutationsCreated,
  };
}

/**
 * Classify a mutation to determine which actions are needed.
 */
export function classifyMutation(mutation: { entityType: string; action: string; payload: Record<string, any> }): {
  affectsConfig: boolean;
  affectsWorkspace: boolean;
  affectsPlugins: boolean;
  affectsContainer: boolean;
} {
  // Instance delete — handled entirely by destroy steps in buildStepsForInstance;
  // does not affect config on other instances.
  if (mutation.entityType === 'instance' && mutation.action === 'delete') {
    return { affectsConfig: false, affectsWorkspace: false, affectsPlugins: false, affectsContainer: false };
  }

  // Creates and deletes always affect config (agent added/removed from agents.list)
  if (mutation.action === 'create' || mutation.action === 'delete') {
    // Only agent and plugin creates need plugin installation
    const needsPlugins = mutation.action === 'create' && (mutation.entityType === 'agent' || mutation.entityType === 'plugin');
    return { affectsConfig: true, affectsWorkspace: false, affectsPlugins: needsPlugins, affectsContainer: false };
  }

  // Plugin mutations — require plugin install + config push + restart on all instances
  if (mutation.entityType === 'plugin') {
    return { affectsConfig: true, affectsWorkspace: false, affectsPlugins: true, affectsContainer: false };
  }

  // Instance mutations — e.g. targetVersion update → triggers container upgrade step
  if (mutation.entityType === 'instance') {
    return { affectsConfig: false, affectsWorkspace: false, affectsPlugins: false, affectsContainer: true };
  }

  if (mutation.entityType !== 'agent') {
    // Non-agent mutations might affect config (providers, models)
    return { affectsConfig: true, affectsWorkspace: false, affectsPlugins: false, affectsContainer: false };
  }

  const payload = mutation.payload;
  // Config fields stored on agent (model) + template-only fields that need push_config
  const allConfigFields = [...CONFIG_FIELDS, ...TEMPLATE_ONLY_CONFIG_FIELDS];
  const affectsConfig = allConfigFields.some(f => payload[f] !== undefined);
  const affectsWorkspace = WORKSPACE_FIELDS.some(f => payload[f] !== undefined) || payload.agentsMd !== undefined;
  const affectsPlugins = payload.pluginsList !== undefined;

  return { affectsConfig, affectsWorkspace, affectsPlugins, affectsContainer: false };
}
