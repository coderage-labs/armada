// ── Step Planner Tests ────────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestDb, teardownTestDb } from '../../test/helpers.js';
import { getDrizzle } from '../../db/drizzle.js';
import { instances, nodes, pendingMutations, changesets } from '../../db/drizzle-schema.js';
import { buildStepsForInstance, dagToSteps } from '../step-planner.js';

// ── Helpers ───────────────────────────────────────────────────────────

function seedNode(id = 'test-node') {
  getDrizzle().insert(nodes).values({
    id,
    hostname: 'test-host',
    status: 'online',
  }).run();
}

function seedInstance(overrides: {
  id?: string;
  name?: string;
  nodeId?: string;
  url?: string | null;
  token?: string | null;
  status?: string;
} = {}) {
  const {
    id = 'inst-1',
    name = 'instance-1',
    nodeId = 'test-node',
    url = null,
    token = null,
    status = 'stopped',
  } = overrides;

  getDrizzle().insert(instances).values({
    id,
    name,
    nodeId,
    status,
    capacity: 5,
    url: url ?? undefined,
    token: token ?? undefined,
  }).run();
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('buildStepsForInstance', () => {
  beforeEach(() => {
    setupTestDb();
  });

  afterEach(() => {
    teardownTestDb();
  });

  // ── Fresh instance (no url) ─────────────────────────────────────

  it('returns bootstrap DAG starting with pull_image and create_container for a fresh instance (no url)', () => {
    seedNode();
    seedInstance({ id: 'inst-fresh', name: 'fresh-instance', url: null });

    const dag = buildStepsForInstance('inst-fresh', 1);
    const steps = dagToSteps(dag);
    const stepNames = steps.map(s => s.name);

    // Must include the full bootstrap sequence
    expect(stepNames).toContain('pull_image');
    expect(stepNames).toContain('create_container');
    expect(stepNames).toContain('install_plugins');
    expect(stepNames).toContain('push_config');
    expect(stepNames).toContain('start_container');
    expect(stepNames).toContain('health_check');

    // Should NOT include the running-container-only steps
    expect(stepNames).not.toContain('restart_gateway');
    expect(stepNames).not.toContain('stop_container');
    expect(stepNames).not.toContain('destroy_container');
  });

  it('pull_image is a prerequisite for create_container in the fresh instance DAG', () => {
    seedNode();
    seedInstance({ id: 'inst-fresh', name: 'fresh-instance', url: null });

    const dag = buildStepsForInstance('inst-fresh', 1);

    // Find the pull_image and create_container step IDs
    const pullImageEntry = Object.entries(dag.nodes).find(([, v]) => v.step.name === 'pull_image');
    const createContainerEntry = Object.entries(dag.nodes).find(([, v]) => v.step.name === 'create_container');

    expect(pullImageEntry).toBeDefined();
    expect(createContainerEntry).toBeDefined();

    const pullImageId = pullImageEntry![0];
    const createContainerId = createContainerEntry![0];

    // There must be a dep [pullImageId, createContainerId]
    expect(dag.deps).toContainEqual([pullImageId, createContainerId]);
  });

  it('uses the correct DAG ordering: pull_image → create_container → install_plugins → push_config → start_container → health_check', () => {
    seedNode();
    seedInstance({ id: 'inst-fresh', name: 'fresh-instance', url: null });

    const dag = buildStepsForInstance('inst-fresh', 1);

    const byName = (name: string) =>
      Object.entries(dag.nodes).find(([, v]) => v.step.name === name)![0];

    const pullId = byName('pull_image');
    const createId = byName('create_container');
    const installId = byName('install_plugins');
    const pushCfgId = byName('push_config');
    const startId = byName('start_container');
    const healthId = byName('health_check');

    expect(dag.deps).toContainEqual([pullId, createId]);
    expect(dag.deps).toContainEqual([createId, installId]);
    expect(dag.deps).toContainEqual([installId, pushCfgId]);
    expect(dag.deps).toContainEqual([pushCfgId, startId]);
    expect(dag.deps).toContainEqual([startId, healthId]);
  });

  it('carries the correct instanceId and nodeId in step metadata for a fresh instance', () => {
    seedNode('node-x');
    seedInstance({ id: 'inst-fresh', name: 'fresh-instance', nodeId: 'node-x', url: null });

    const dag = buildStepsForInstance('inst-fresh', 42);
    const steps = dagToSteps(dag);

    const pushConfig = steps.find(s => s.name === 'push_config');
    expect(pushConfig?.metadata?.instanceId).toBe('inst-fresh');
    expect(pushConfig?.metadata?.configVersion).toBe(42);
    expect(pushConfig?.metadata?.nodeId).toBe('node-x');

    const healthCheck = steps.find(s => s.name === 'health_check');
    expect(healthCheck?.metadata?.instanceId).toBe('inst-fresh');
    expect(healthCheck?.metadata?.nodeId).toBe('node-x');
  });

  // ── Running instance (has url) should NOT get bootstrap ─────────

  it('does NOT return bootstrap steps for an instance that already has a url', () => {
    seedNode();
    // Seed a running instance with a url — it has a container already
    seedInstance({
      id: 'inst-running',
      name: 'running-instance',
      url: 'http://localhost:3000',
      status: 'running',
    });

    // No pending mutations → no steps needed
    const dag = buildStepsForInstance('inst-running', 1);
    const steps = dagToSteps(dag);
    const stepNames = steps.map(s => s.name);

    expect(stepNames).not.toContain('pull_image');
    expect(stepNames).not.toContain('create_container');
  });

  // ── instance.create mutation still takes precedence ─────────────

  it('uses instance.create mutation path (not fresh-instance path) when create mutation exists', () => {
    seedNode();
    // Even with no url, a create mutation should use the mutation path
    seedInstance({ id: 'inst-create', name: 'create-instance', url: null, status: 'pending' });

    // Seed the create mutation
    getDrizzle().insert(changesets).values({
      id: 'cs-1',
      status: 'draft',
      changesJson: '[]',
      planJson: '{}',
    }).run();
    getDrizzle().insert(pendingMutations).values({
      id: 'mut-create-1',
      changesetId: 'cs-1',
      entityType: 'instance',
      entityId: 'inst-create',
      action: 'create',
      payloadJson: JSON.stringify({ nodeId: 'test-node', name: 'create-instance' }),
    }).run();

    const dag = buildStepsForInstance('inst-create', 1);
    const steps = dagToSteps(dag);
    const stepNames = steps.map(s => s.name);

    // Should still get the bootstrap sequence (via mutation path)
    expect(stepNames).toContain('pull_image');
    expect(stepNames).toContain('create_container');
  });
});
