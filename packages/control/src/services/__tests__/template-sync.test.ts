import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestDb, teardownTestDb } from '../../test/helpers.js';
import { computeTemplateDrift, classifyMutation } from '../template-sync.js';
import { getDrizzle } from '../../db/drizzle.js';
import { agents, instances, nodes, templates } from '../../db/drizzle-schema.js';
import { v4 as uuidv4 } from 'uuid';

describe('Template Sync Service', () => {
  beforeEach(() => {
    setupTestDb();
  });

  afterEach(() => {
    teardownTestDb();
  });

  function seedNodeAndInstance() {
    const db = getDrizzle();
    const nodeId = uuidv4();
    const instanceId = uuidv4();

    db.insert(nodes).values({
      id: nodeId,
      hostname: 'test-node',
      cores: 4,
      memory: 8192,
      status: 'online',
    }).run();

    db.insert(instances).values({
      id: instanceId,
      name: 'test-instance',
      nodeId,
      status: 'running',
      config: '{}',
    }).run();

    return { nodeId, instanceId };
  }

  it('classifyMutation correctly identifies config changes', () => {
    const mutation = {
      entityType: 'agent', action: 'update',
      payload: { model: 'claude-4', toolsAllow: ['web', 'file'] },
    };

    const result = classifyMutation(mutation);
    expect(result.affectsConfig).toBe(true);
    expect(result.affectsWorkspace).toBe(false);
    expect(result.affectsPlugins).toBe(false);
  });

  it('classifyMutation correctly identifies workspace changes', () => {
    const mutation = {
      entityType: 'agent', action: 'update',
      payload: { soul: 'Updated SOUL.md content', agentsMd: 'Updated AGENTS.md' },
    };

    const result = classifyMutation(mutation);
    expect(result.affectsConfig).toBe(false);
    expect(result.affectsWorkspace).toBe(true);
    expect(result.affectsPlugins).toBe(false);
  });

  it('classifyMutation correctly identifies plugin changes', () => {
    const mutation = {
      entityType: 'agent', action: 'update',
      payload: { pluginsList: [{ name: 'test-plugin', version: '1.0.0' }] },
    };

    const result = classifyMutation(mutation);
    expect(result.affectsConfig).toBe(true); // pluginsList is a config field
    expect(result.affectsWorkspace).toBe(false);
    expect(result.affectsPlugins).toBe(true);
  });

  it('computeTemplateDrift detects model drift', () => {
    const db = getDrizzle();
    const { instanceId } = seedNodeAndInstance();

    const templateId = uuidv4();
    db.insert(templates).values({
      id: templateId,
      name: 'test-template',
      description: '',
      image: '',
      role: 'development',
      skills: '',
      model: 'claude-4',
      resourcesJson: '{"memory":"2g","cpus":"1"}',
      pluginsJson: '[]',
      pluginsListJson: '[]',
      skillsListJson: '[]',
      contactsJson: '[]',
      toolsAllowJson: '[]',
      toolsProfile: '',
      soul: '',
      agentsMd: '',
      envJson: '[]',
      internalAgentsJson: '[]',
      toolsJson: '[]',
      projectsJson: '[]',
    }).run();

    const agentId = uuidv4();
    db.insert(agents).values({
      id: agentId,
      name: 'test-agent',
      nodeId: db.select().from(instances).get()!.nodeId,
      instanceId,
      templateId,
      port: 3000,
      status: 'running',
      model: 'claude-3.5', // Different from template
    }).run();

    const drift = computeTemplateDrift(templateId);
    expect(drift.length).toBe(1);
    expect(drift[0].drifted).toBe(true);
    expect(drift[0].diffs.some(d => d.field === 'model')).toBe(true);
  });

  it('computeTemplateDrift detects no drift when agent matches template', () => {
    const db = getDrizzle();
    const { instanceId } = seedNodeAndInstance();

    const templateId = uuidv4();
    db.insert(templates).values({
      id: templateId,
      name: 'no-drift-template',
      description: '',
      image: '',
      role: 'development',
      skills: '',
      model: 'claude-4',
      resourcesJson: '{"memory":"2g","cpus":"1"}',
      pluginsJson: '[]',
      pluginsListJson: '[]',
      skillsListJson: '[]',
      contactsJson: '[]',
      toolsAllowJson: '[]',
      toolsProfile: '',
      soul: 'Test SOUL',
      agentsMd: 'Test AGENTS',
      envJson: '[]',
      internalAgentsJson: '[]',
      toolsJson: '[]',
      projectsJson: '[]',
    }).run();

    const agentId = uuidv4();
    db.insert(agents).values({
      id: agentId,
      name: 'test-agent-no-drift',
      nodeId: db.select().from(instances).get()!.nodeId,
      instanceId,
      templateId,
      port: 3000,
      status: 'running',
      role: 'development', // Match template
      skills: '', // Match template
      model: 'claude-4', // Same as template
      soul: 'Test SOUL', // Match template
      agentsMd: 'Test AGENTS', // Match template (template.agents maps to agent.agentsMd)
    }).run();

    const drift = computeTemplateDrift(templateId);
    expect(drift.length).toBe(1);
    if (drift[0].drifted) {
      console.log('Unexpected diffs:', JSON.stringify(drift[0].diffs, null, 2));
    }
    expect(drift[0].drifted).toBe(false);
    expect(drift[0].diffs.length).toBe(0);
  });

  it('computeTemplateDrift detects workspace file changes', () => {
    const db = getDrizzle();
    const { instanceId } = seedNodeAndInstance();

    const templateId = uuidv4();
    db.insert(templates).values({
      id: templateId,
      name: 'workspace-template',
      description: '',
      image: '',
      role: 'development',
      skills: '',
      model: 'claude-4',
      resourcesJson: '{"memory":"2g","cpus":"1"}',
      pluginsJson: '[]',
      pluginsListJson: '[]',
      skillsListJson: '[]',
      contactsJson: '[]',
      toolsAllowJson: '[]',
      toolsProfile: '',
      soul: 'Updated SOUL content',
      agentsMd: 'Updated AGENTS content',
      envJson: '[]',
      internalAgentsJson: '[]',
      toolsJson: '[]',
      projectsJson: '[]',
    }).run();

    const agentId = uuidv4();
    db.insert(agents).values({
      id: agentId,
      name: 'test-agent-workspace',
      nodeId: db.select().from(instances).get()!.nodeId,
      instanceId,
      templateId,
      port: 3000,
      status: 'running',
      model: 'claude-4', // Same as template
      soul: 'Old SOUL content', // Different from template
      agentsMd: 'Old AGENTS content', // Different from template
    }).run();

    const drift = computeTemplateDrift(templateId);
    expect(drift.length).toBe(1);
    expect(drift[0].drifted).toBe(true); // Drift due to workspace files
    expect(drift[0].diffs.some(d => d.field === 'soul')).toBe(true);
    expect(drift[0].diffs.some(d => d.field === 'agentsMd')).toBe(true);
  });

  it('computeTemplateDrift detects no drift when workspace files match', () => {
    const db = getDrizzle();
    const { instanceId } = seedNodeAndInstance();

    const templateId = uuidv4();
    db.insert(templates).values({
      id: templateId,
      name: 'workspace-match-template',
      description: '',
      image: '',
      role: 'development',
      skills: '',
      model: 'claude-4',
      resourcesJson: '{"memory":"2g","cpus":"1"}',
      pluginsJson: '[]',
      pluginsListJson: '[]',
      skillsListJson: '[]',
      contactsJson: '[]',
      toolsAllowJson: '[]',
      toolsProfile: '',
      soul: 'Matching SOUL content',
      agentsMd: 'Matching AGENTS content',
      envJson: '[]',
      internalAgentsJson: '[]',
      toolsJson: '[]',
      projectsJson: '[]',
    }).run();

    const agentId = uuidv4();
    db.insert(agents).values({
      id: agentId,
      name: 'test-agent-workspace-match',
      nodeId: db.select().from(instances).get()!.nodeId,
      instanceId,
      templateId,
      port: 3000,
      status: 'running',
      model: 'claude-4',
      role: 'development',
      skills: '',
      soul: 'Matching SOUL content', // Same as template
      agentsMd: 'Matching AGENTS content', // Same as template
    }).run();

    const drift = computeTemplateDrift(templateId);
    expect(drift.length).toBe(1);
    expect(drift[0].drifted).toBe(false); // No drift — workspace files match
    expect(drift[0].diffs.length).toBe(0);
  });
});
