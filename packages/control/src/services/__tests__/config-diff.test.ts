import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestDb, teardownTestDb } from '../../test/helpers.js';
import { configDiffService, type ConfigSnapshot } from '../config-diff.js';
import { getDrizzle } from '../../db/drizzle.js';
import { instances, nodes, modelProviders, modelRegistry, plugins } from '../../db/drizzle-schema.js';

function makeSnapshot(overrides: Partial<ConfigSnapshot> = {}): ConfigSnapshot {
  return {
    version: 0,
    providers: [],
    models: [],
    plugins: [],
    templateModels: {},
    ...overrides,
  };
}

describe('ConfigDiffService', () => {
  beforeEach(() => {
    setupTestDb();
  });

  afterEach(() => {
    teardownTestDb();
  });

  // 1. getCurrentVersion returns 0 initially
  it('getCurrentVersion returns 0 initially', () => {
    expect(configDiffService.getCurrentVersion()).toBe(0);
  });

  // 2. bumpVersion increments and returns new version
  it('bumpVersion increments and returns new version', () => {
    expect(configDiffService.bumpVersion()).toBe(1);
    expect(configDiffService.bumpVersion()).toBe(2);
    expect(configDiffService.getCurrentVersion()).toBe(2);
  });

  // 3. snapshot returns valid structure with providers, models, plugins
  it('snapshot returns valid structure with providers, models, plugins', () => {
    const db = getDrizzle();

    // Seed a provider
    db.insert(modelProviders).values({
      id: 'test-provider',
      name: 'Test Provider',
      type: 'openai-compat',
      enabled: 1,
      hidden: 0,
      modelCount: 0,
    }).run();

    // Seed a model
    db.insert(modelRegistry).values({
      id: 'test-model-id',
      name: 'Test Model',
      provider: 'openai-compat',
      modelId: 'test-model-v1',
      description: '',
      capabilities: '[]',
    }).run();

    // Seed a plugin
    db.insert(plugins).values({
      id: 'test-plugin',
      name: 'my-plugin',
      version: '1.0.0',
      path: '/plugins/my-plugin',
    }).run();

    const snap = configDiffService.snapshot();

    expect(snap.version).toBe(0);
    expect(snap.providers.length).toBeGreaterThanOrEqual(1);
    const tp = snap.providers.find(p => p.id === 'test-provider');
    expect(tp).toBeDefined();
    expect(tp!.type).toBe('openai-compat');
    expect(snap.models.length).toBeGreaterThanOrEqual(1);
    const tm = snap.models.find(m => m.id === 'test-model-id');
    expect(tm).toBeDefined();
    expect(tm!.modelId).toBe('test-model-v1');
    expect(snap.plugins.length).toBeGreaterThanOrEqual(1);
    const tp2 = snap.plugins.find(p => p.name === 'my-plugin');
    expect(tp2).toBeDefined();
    expect(tp2!.version).toBe('1.0.0');
    expect(typeof snap.templateModels).toBe('object');
  });

  // 4. diff detects added model
  it('diff detects added model', () => {
    const current = makeSnapshot({ models: [] });
    const desired = makeSnapshot({
      models: [{ id: 'new-model', name: 'New Model', modelId: 'new-v1', providerId: 'anthropic' }],
    });

    const changes = configDiffService.diff(current, desired);
    expect(changes.length).toBe(1);
    expect(changes[0].field).toBe('model.new-model');
    expect(changes[0].current).toBeNull();
    expect(changes[0].desired).not.toBeNull();
    expect(changes[0].requiresRestart).toBe(true);
    expect(changes[0].type).toBe('model');
  });

  // 5. diff detects removed provider key
  it('diff detects removed provider key', () => {
    const current = makeSnapshot({
      providers: [{ id: 'p1', type: 'anthropic', keys: [{ name: 'Key A', isDefault: true }, { name: 'Key B', isDefault: false }] }],
    });
    const desired = makeSnapshot({
      providers: [{ id: 'p1', type: 'anthropic', keys: [{ name: 'Key A', isDefault: true }] }],
    });

    const changes = configDiffService.diff(current, desired);
    expect(changes.length).toBe(1);
    expect(changes[0].field).toBe('provider.p1.keys');
    expect(changes[0].requiresRestart).toBe(true);
  });

  // 6. diff detects changed template model
  it('diff detects changed template model', () => {
    const current = makeSnapshot({ templateModels: { 'template-1': 'model-a' } });
    const desired = makeSnapshot({ templateModels: { 'template-1': 'model-b' } });

    const changes = configDiffService.diff(current, desired);
    expect(changes.length).toBe(1);
    expect(changes[0].field).toBe('template.template-1.model');
    expect(changes[0].current).toBe('model-a');
    expect(changes[0].desired).toBe('model-b');
    expect(changes[0].requiresRestart).toBe(true);
  });

  // 7. diff returns empty when snapshots match
  it('diff returns empty when snapshots match', () => {
    const snap = makeSnapshot({
      providers: [{ id: 'p1', type: 'anthropic', keys: [{ name: 'Key A', isDefault: true }] }],
      models: [{ id: 'm1', name: 'Model 1', modelId: 'v1', providerId: 'p1' }],
      plugins: [{ name: 'plugin-a', version: '1.0.0' }],
      templateModels: { 't1': 'model-a' },
    });

    const changes = configDiffService.diff(snap, snap);
    expect(changes.length).toBe(0);
  });

  // 8. getStaleInstances returns instances behind current version
  it('getStaleInstances returns instances behind current version', () => {
    const db = getDrizzle();

    // Create a node first (instances reference nodes)
    db.insert(nodes).values({
      id: 'test-node-stale',
      hostname: 'test-host',
      status: 'online',
    }).run();

    // Create an instance with appliedConfigVersion = 0
    db.insert(instances).values({
      id: 'inst-1',
      name: 'instance-1',
      nodeId: 'test-node-stale',
      status: 'running',
      capacity: 5,
      appliedConfigVersion: 0,
    }).run();

    // Bump version to 2
    configDiffService.bumpVersion();
    configDiffService.bumpVersion();

    const stale = configDiffService.getStaleInstances();
    expect(stale.length).toBeGreaterThanOrEqual(1);
    const s = stale.find(i => i.instanceId === 'inst-1');
    expect(s).toBeDefined();
    expect(s!.appliedVersion).toBe(0);
    expect(s!.currentVersion).toBe(2);
  });

  // 9. markApplied updates instance version
  it('markApplied updates instance version', () => {
    const db = getDrizzle();

    db.insert(nodes).values({
      id: 'test-node-apply',
      hostname: 'test-host-apply',
      status: 'online',
    }).run();

    db.insert(instances).values({
      id: 'inst-apply',
      name: 'instance-apply',
      nodeId: 'test-node-apply',
      status: 'running',
      capacity: 5,
      appliedConfigVersion: 0,
    }).run();

    configDiffService.bumpVersion();
    configDiffService.markApplied('inst-apply', 1);

    const stale = configDiffService.getStaleInstances();
    const s = stale.find(i => i.instanceId === 'inst-apply');
    expect(s).toBeUndefined(); // should no longer be stale
  });

});
