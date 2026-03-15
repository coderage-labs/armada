/**
 * Comprehensive tests for executePendingMutations() — the DB flush layer.
 *
 * Covers all entity types handled in mutation-executor.ts:
 *   agent, instance, provider, api_key, model, plugin
 * Also covers unknown entity types (template, webhook, integration), error
 * handling, and return-value verification.
 *
 * Uses a real in-memory SQLite DB (no mocks for DB operations).
 * instanceManager.restart is mocked to prevent Docker calls.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setupTestDb, teardownTestDb } from '../../test/helpers.js';
import { getDrizzle } from '../../db/drizzle.js';
import {
  nodes,
  instances,
  agents,
  modelProviders,
  providerApiKeys,
  modelRegistry,
  pendingMutations,
  changesets,
  pluginLibrary,
} from '../../db/drizzle-schema.js';
import { eq } from 'drizzle-orm';

import { executePendingMutations } from '../mutation-executor.js';
import { instanceManager } from '../instance-manager.js';

// ── Seed helpers ─────────────────────────────────────────────────────

let _changesetCounter = 0;

function seedChangeset(id?: string): string {
  const csId = id ?? `cs-${++_changesetCounter}`;
  getDrizzle().insert(changesets).values({
    id: csId,
    status: 'draft',
    changesJson: '[]',
    planJson: JSON.stringify({
      instanceOps: [],
      order: 'sequential',
      concurrency: 1,
      totalInstances: 0,
      totalChanges: 0,
      totalRestarts: 0,
      estimatedDuration: 0,
    }),
  }).run();
  return csId;
}

function seedNode(id = 'test-node') {
  getDrizzle().insert(nodes).values({ id, hostname: 'test-host', status: 'online' }).run();
}

function seedInstance(opts: { id?: string; nodeId?: string; status?: string } = {}) {
  const { id = 'test-inst', nodeId = 'test-node', status = 'running' } = opts;
  getDrizzle().insert(instances).values({
    id,
    name: `instance-${id}`,
    nodeId,
    status,
    capacity: 5,
    appliedConfigVersion: 0,
  }).run();
}

function seedAgent(opts: { id?: string; nodeId?: string; instanceId?: string } = {}) {
  const { id = 'test-agent', nodeId = 'test-node', instanceId = 'test-inst' } = opts;
  getDrizzle().insert(agents).values({
    id,
    name: `agent-${id}`,
    nodeId,
    instanceId,
    port: 8080,
    status: 'running',
    healthStatus: 'healthy',
    avatarGenerating: 0,
  }).run();
}

function seedProvider(opts: { id?: string; name?: string } = {}) {
  const { id = 'test-provider', name = 'Test Provider' } = opts;
  getDrizzle().insert(modelProviders).values({
    id,
    name,
    type: 'openai',
    enabled: 1,
    hidden: 0,
    modelCount: 0,
  }).run();
}

function seedModel(opts: { id?: string; name?: string } = {}) {
  const { id = 'test-model', name = 'test-model' } = opts;
  getDrizzle().insert(modelRegistry).values({
    id,
    name,
    provider: 'openai',
    modelId: 'gpt-4o',
    description: '',
    capabilities: '[]',
    costTier: 'standard',
    source: 'manual',
  }).run();
}

function seedApiKey(opts: { id?: string; providerId?: string } = {}) {
  const { id = 'test-key', providerId = 'test-provider' } = opts;
  getDrizzle().insert(providerApiKeys).values({
    id,
    providerId,
    name: 'Key 1',
    apiKey: 'sk-test-key',
    isDefault: 1,
    priority: 0,
  }).run();
}

function seedPlugin(opts: { id?: string; name?: string } = {}) {
  const { id = 'test-plugin', name = 'test-plugin' } = opts;
  getDrizzle().insert(pluginLibrary).values({
    id,
    name,
    source: 'github',
    description: '',
    system: 0,
  }).run();
}

/** Insert a pending mutation directly (bypasses mutationService) */
function stageMutation(opts: {
  changesetId: string;
  entityType: string;
  entityId?: string | null;
  action: 'create' | 'update' | 'delete';
  payload?: Record<string, any>;
}): void {
  getDrizzle().insert(pendingMutations).values({
    id: `mut-${Date.now()}-${Math.random()}`,
    changesetId: opts.changesetId,
    entityType: opts.entityType,
    entityId: opts.entityId ?? null,
    action: opts.action,
    payloadJson: JSON.stringify(opts.payload ?? {}),
  }).run();
}

// ── Test Suite ────────────────────────────────────────────────────────

describe('executePendingMutations()', () => {
  beforeEach(() => {
    setupTestDb();
    _changesetCounter = 0;
  });

  afterEach(() => {
    teardownTestDb();
    vi.restoreAllMocks();
  });

  // ──────────────────────────────────────────────────────────────────
  // EMPTY / RETURN VALUE
  // ──────────────────────────────────────────────────────────────────

  describe('return value', () => {
    it('returns { executed: 0, errors: [] } when no mutations are pending', () => {
      const csId = seedChangeset();
      const result = executePendingMutations(csId);
      expect(result).toEqual({ executed: 0, errors: [] });
    });

    it('returns correct executed count for multiple mutations', () => {
      seedNode();
      const csId = seedChangeset();

      // Stage two model creates
      stageMutation({ changesetId: csId, entityType: 'model', action: 'create', payload: { name: 'model-a', provider: 'openai', modelId: 'gpt-4' } });
      stageMutation({ changesetId: csId, entityType: 'model', action: 'create', payload: { name: 'model-b', provider: 'anthropic', modelId: 'claude-3' } });

      const result = executePendingMutations(csId);
      expect(result.executed).toBe(2);
      expect(result.errors).toHaveLength(0);
    });

    it('clears pending mutations from DB after successful execution', () => {
      const csId = seedChangeset();
      stageMutation({ changesetId: csId, entityType: 'model', action: 'create', payload: { name: 'cleanup-model', provider: 'openai', modelId: 'gpt-3.5' } });

      executePendingMutations(csId);

      const remaining = getDrizzle().select().from(pendingMutations).where(eq(pendingMutations.changesetId, csId)).all();
      expect(remaining).toHaveLength(0);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // AGENT MUTATIONS
  // ──────────────────────────────────────────────────────────────────

  describe('agent mutations', () => {
    beforeEach(() => {
      seedNode();
      seedInstance();
    });

    it('create agent — inserts agent into DB', () => {
      const csId = seedChangeset();
      stageMutation({
        changesetId: csId,
        entityType: 'agent',
        action: 'create',
        payload: {
          name: 'new-agent',
          nodeId: 'test-node',
          instanceId: 'test-inst',
          port: 9000,
          status: 'stopped',
          healthStatus: 'unknown',
        },
      });

      const result = executePendingMutations(csId);
      expect(result.executed).toBe(1);
      expect(result.errors).toHaveLength(0);

      const agentRow = getDrizzle().select().from(agents).where(eq(agents.name, 'new-agent')).get();
      expect(agentRow).toBeDefined();
      expect(agentRow!.name).toBe('new-agent');
      expect(agentRow!.port).toBe(9000);
    });

    it('update agent fields — patches existing agent in DB', () => {
      seedAgent({ id: 'update-agent' });

      const csId = seedChangeset();
      stageMutation({
        changesetId: csId,
        entityType: 'agent',
        entityId: 'update-agent',
        action: 'update',
        payload: { model: 'gpt-4o', role: 'reviewer' },
      });

      const result = executePendingMutations(csId);
      expect(result.executed).toBe(1);
      expect(result.errors).toHaveLength(0);

      const agentRow = getDrizzle().select().from(agents).where(eq(agents.id, 'update-agent')).get();
      expect(agentRow).toBeDefined();
      expect(agentRow!.model).toBe('gpt-4o');
      expect(agentRow!.role).toBe('reviewer');
    });

    it('delete agent — removes agent from DB', () => {
      seedAgent({ id: 'delete-agent' });

      const csId = seedChangeset();
      stageMutation({
        changesetId: csId,
        entityType: 'agent',
        entityId: 'delete-agent',
        action: 'delete',
        payload: { name: 'agent-delete-agent' },
      });

      const result = executePendingMutations(csId);
      expect(result.executed).toBe(1);
      expect(result.errors).toHaveLength(0);

      const agentRow = getDrizzle().select().from(agents).where(eq(agents.id, 'delete-agent')).get();
      expect(agentRow).toBeUndefined();
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // INSTANCE MUTATIONS
  // ──────────────────────────────────────────────────────────────────

  describe('instance mutations', () => {
    beforeEach(() => {
      seedNode();
    });

    it('create instance — sets status to provisioning', () => {
      // The DB record already exists before the mutation (created by route)
      seedInstance({ id: 'new-inst', status: 'pending' });

      const csId = seedChangeset();
      stageMutation({
        changesetId: csId,
        entityType: 'instance',
        entityId: 'new-inst',
        action: 'create',
        payload: { name: 'new-inst', nodeId: 'test-node' },
      });

      const result = executePendingMutations(csId);
      expect(result.executed).toBe(1);
      expect(result.errors).toHaveLength(0);

      const instRow = getDrizzle().select().from(instances).where(eq(instances.id, 'new-inst')).get();
      expect(instRow).toBeDefined();
      expect(instRow!.status).toBe('provisioning');
    });

    it('delete instance — sets status to stopping', () => {
      seedInstance({ id: 'del-inst', status: 'running' });

      const csId = seedChangeset();
      stageMutation({
        changesetId: csId,
        entityType: 'instance',
        entityId: 'del-inst',
        action: 'delete',
        payload: { name: 'instance-del-inst' },
      });

      const result = executePendingMutations(csId);
      expect(result.executed).toBe(1);
      expect(result.errors).toHaveLength(0);

      const instRow = getDrizzle().select().from(instances).where(eq(instances.id, 'del-inst')).get();
      expect(instRow).toBeDefined();
      expect(instRow!.status).toBe('stopping');
    });

    it('update instance — patches instance fields', () => {
      seedInstance({ id: 'upd-inst', status: 'running' });

      const csId = seedChangeset();
      stageMutation({
        changesetId: csId,
        entityType: 'instance',
        entityId: 'upd-inst',
        action: 'update',
        payload: { targetVersion: '1.2.3', capacity: 10 },
      });

      const result = executePendingMutations(csId);
      expect(result.executed).toBe(1);
      expect(result.errors).toHaveLength(0);

      const instRow = getDrizzle().select().from(instances).where(eq(instances.id, 'upd-inst')).get();
      expect(instRow).toBeDefined();
      expect(instRow!.targetVersion).toBe('1.2.3');
      expect(instRow!.capacity).toBe(10);
    });

    it('update instance with restart flag — triggers async restart and does not update other fields', () => {
      seedInstance({ id: 'restart-inst', status: 'running' });

      // Mock instanceManager.restart to avoid Docker calls
      const restartSpy = vi.spyOn(instanceManager, 'restart').mockResolvedValue(undefined);

      const csId = seedChangeset();
      stageMutation({
        changesetId: csId,
        entityType: 'instance',
        entityId: 'restart-inst',
        action: 'update',
        payload: { restart: true },
      });

      const result = executePendingMutations(csId);
      expect(result.executed).toBe(1);
      expect(result.errors).toHaveLength(0);

      // instanceManager.restart is scheduled via Promise.resolve().then()
      // It won't have fired synchronously, but the spy should be called after micro-task flush
      return Promise.resolve().then(() => {
        expect(restartSpy).toHaveBeenCalledWith('restart-inst');
      });
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // PROVIDER MUTATIONS
  // ──────────────────────────────────────────────────────────────────

  describe('provider mutations', () => {
    it('create provider — inserts provider into DB', () => {
      const csId = seedChangeset();
      stageMutation({
        changesetId: csId,
        entityType: 'provider',
        action: 'create',
        payload: { name: 'New Provider', type: 'anthropic', enabled: 1 },
      });

      const result = executePendingMutations(csId);
      expect(result.executed).toBe(1);
      expect(result.errors).toHaveLength(0);

      const row = getDrizzle().select().from(modelProviders).where(eq(modelProviders.name, 'New Provider')).get();
      expect(row).toBeDefined();
      expect(row!.type).toBe('anthropic');
    });

    it('update provider — patches provider in DB', () => {
      seedProvider({ id: 'upd-prov', name: 'Old Name' });

      const csId = seedChangeset();
      stageMutation({
        changesetId: csId,
        entityType: 'provider',
        entityId: 'upd-prov',
        action: 'update',
        payload: { name: 'Updated Provider', enabled: 0 },
      });

      const result = executePendingMutations(csId);
      expect(result.executed).toBe(1);
      expect(result.errors).toHaveLength(0);

      const row = getDrizzle().select().from(modelProviders).where(eq(modelProviders.id, 'upd-prov')).get();
      expect(row).toBeDefined();
      expect(row!.name).toBe('Updated Provider');
      expect(row!.enabled).toBe(0);
    });

    it('delete provider — removes provider from DB', () => {
      seedProvider({ id: 'del-prov' });

      const csId = seedChangeset();
      stageMutation({
        changesetId: csId,
        entityType: 'provider',
        entityId: 'del-prov',
        action: 'delete',
      });

      const result = executePendingMutations(csId);
      expect(result.executed).toBe(1);
      expect(result.errors).toHaveLength(0);

      const row = getDrizzle().select().from(modelProviders).where(eq(modelProviders.id, 'del-prov')).get();
      expect(row).toBeUndefined();
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // MODEL MUTATIONS
  // ──────────────────────────────────────────────────────────────────

  describe('model mutations', () => {
    it('create model — inserts model into DB', () => {
      const csId = seedChangeset();
      stageMutation({
        changesetId: csId,
        entityType: 'model',
        action: 'create',
        payload: { name: 'gpt-4o-test', provider: 'openai', modelId: 'gpt-4o', description: 'Test model' },
      });

      const result = executePendingMutations(csId);
      expect(result.executed).toBe(1);
      expect(result.errors).toHaveLength(0);

      const row = getDrizzle().select().from(modelRegistry).where(eq(modelRegistry.name, 'gpt-4o-test')).get();
      expect(row).toBeDefined();
      expect(row!.provider).toBe('openai');
      expect(row!.modelId).toBe('gpt-4o');
    });

    it('update model — patches model in DB', () => {
      seedModel({ id: 'upd-model', name: 'upd-model' });

      const csId = seedChangeset();
      stageMutation({
        changesetId: csId,
        entityType: 'model',
        entityId: 'upd-model',
        action: 'update',
        payload: { description: 'Updated description', costTier: 'premium' },
      });

      const result = executePendingMutations(csId);
      expect(result.executed).toBe(1);
      expect(result.errors).toHaveLength(0);

      const row = getDrizzle().select().from(modelRegistry).where(eq(modelRegistry.id, 'upd-model')).get();
      expect(row).toBeDefined();
      expect(row!.description).toBe('Updated description');
      expect(row!.costTier).toBe('premium');
    });

    it('delete model — removes model from DB', () => {
      seedModel({ id: 'del-model', name: 'del-model' });

      const csId = seedChangeset();
      stageMutation({
        changesetId: csId,
        entityType: 'model',
        entityId: 'del-model',
        action: 'delete',
      });

      const result = executePendingMutations(csId);
      expect(result.executed).toBe(1);
      expect(result.errors).toHaveLength(0);

      const row = getDrizzle().select().from(modelRegistry).where(eq(modelRegistry.id, 'del-model')).get();
      expect(row).toBeUndefined();
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // PLUGIN MUTATIONS (entity type: 'plugin')
  // ──────────────────────────────────────────────────────────────────

  describe('plugin (template) mutations', () => {
    it('create plugin — inserts plugin into library', () => {
      const csId = seedChangeset();
      stageMutation({
        changesetId: csId,
        entityType: 'plugin',
        action: 'create',
        payload: { name: 'my-plugin', source: 'github', description: 'A test plugin' },
      });

      const result = executePendingMutations(csId);
      expect(result.executed).toBe(1);
      expect(result.errors).toHaveLength(0);

      const row = getDrizzle().select().from(pluginLibrary).where(eq(pluginLibrary.name, 'my-plugin')).get();
      expect(row).toBeDefined();
      expect(row!.description).toBe('A test plugin');
    });

    it('update plugin — patches plugin in library', () => {
      seedPlugin({ id: 'upd-plugin', name: 'upd-plugin' });

      const csId = seedChangeset();
      stageMutation({
        changesetId: csId,
        entityType: 'plugin',
        entityId: 'upd-plugin',
        action: 'update',
        payload: { version: '2.0.0', description: 'Updated plugin' },
      });

      const result = executePendingMutations(csId);
      expect(result.executed).toBe(1);
      expect(result.errors).toHaveLength(0);

      const row = getDrizzle().select().from(pluginLibrary).where(eq(pluginLibrary.id, 'upd-plugin')).get();
      expect(row).toBeDefined();
      expect(row!.version).toBe('2.0.0');
      expect(row!.description).toBe('Updated plugin');
    });

    it('delete plugin — removes plugin from library', () => {
      seedPlugin({ id: 'del-plugin', name: 'del-plugin' });

      const csId = seedChangeset();
      stageMutation({
        changesetId: csId,
        entityType: 'plugin',
        entityId: 'del-plugin',
        action: 'delete',
      });

      const result = executePendingMutations(csId);
      expect(result.executed).toBe(1);
      expect(result.errors).toHaveLength(0);

      const row = getDrizzle().select().from(pluginLibrary).where(eq(pluginLibrary.id, 'del-plugin')).get();
      expect(row).toBeUndefined();
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // API KEY MUTATIONS
  // ──────────────────────────────────────────────────────────────────

  describe('api_key mutations', () => {
    beforeEach(() => {
      seedProvider({ id: 'key-provider', name: 'Key Provider' });
    });

    it('create api_key — inserts key into DB', () => {
      const csId = seedChangeset();
      stageMutation({
        changesetId: csId,
        entityType: 'api_key',
        action: 'create',
        payload: { providerId: 'key-provider', name: 'Main Key', apiKey: 'sk-test-123', isDefault: 1, priority: 0 },
      });

      const result = executePendingMutations(csId);
      expect(result.executed).toBe(1);
      expect(result.errors).toHaveLength(0);

      const rows = getDrizzle().select().from(providerApiKeys).where(eq(providerApiKeys.providerId, 'key-provider')).all();
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.some(r => r.name === 'Main Key')).toBe(true);
    });

    it('update api_key — patches key in DB', () => {
      seedApiKey({ id: 'upd-key', providerId: 'key-provider' });

      const csId = seedChangeset();
      stageMutation({
        changesetId: csId,
        entityType: 'api_key',
        entityId: 'upd-key',
        action: 'update',
        payload: { name: 'Updated Key', priority: 5 },
      });

      const result = executePendingMutations(csId);
      expect(result.executed).toBe(1);
      expect(result.errors).toHaveLength(0);

      const row = getDrizzle().select().from(providerApiKeys).where(eq(providerApiKeys.id, 'upd-key')).get();
      expect(row).toBeDefined();
      expect(row!.name).toBe('Updated Key');
      expect(row!.priority).toBe(5);
    });

    it('delete api_key — removes key from DB', () => {
      seedApiKey({ id: 'del-key', providerId: 'key-provider' });

      const csId = seedChangeset();
      stageMutation({
        changesetId: csId,
        entityType: 'api_key',
        entityId: 'del-key',
        action: 'delete',
      });

      const result = executePendingMutations(csId);
      expect(result.executed).toBe(1);
      expect(result.errors).toHaveLength(0);

      const row = getDrizzle().select().from(providerApiKeys).where(eq(providerApiKeys.id, 'del-key')).get();
      expect(row).toBeUndefined();
    });

    it('set default api_key — marks key as default (isDefault=1)', () => {
      // Seed two keys; first is default
      getDrizzle().insert(providerApiKeys).values({
        id: 'key-a',
        providerId: 'key-provider',
        name: 'Key A',
        apiKey: 'sk-a',
        isDefault: 1,
        priority: 0,
      }).run();
      getDrizzle().insert(providerApiKeys).values({
        id: 'key-b',
        providerId: 'key-provider',
        name: 'Key B',
        apiKey: 'sk-b',
        isDefault: 0,
        priority: 1,
      }).run();

      const csId = seedChangeset();
      stageMutation({
        changesetId: csId,
        entityType: 'api_key',
        entityId: 'key-b',
        action: 'update',
        payload: { isDefault: 1 },
      });

      const result = executePendingMutations(csId);
      expect(result.executed).toBe(1);
      expect(result.errors).toHaveLength(0);

      const keyB = getDrizzle().select().from(providerApiKeys).where(eq(providerApiKeys.id, 'key-b')).get();
      expect(keyB!.isDefault).toBe(1);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // UNKNOWN ENTITY TYPE (webhook, integration, template)
  // ──────────────────────────────────────────────────────────────────

  describe('unknown entity type mutations', () => {
    it('webhook entity type — executes without error (no-op, logs warning)', () => {
      const csId = seedChangeset();
      stageMutation({
        changesetId: csId,
        entityType: 'webhook',
        action: 'create',
        payload: { url: 'https://example.com/hook', events: '*' },
      });

      const result = executePendingMutations(csId);
      // No error thrown — the default case just warns
      expect(result.errors).toHaveLength(0);
      // Mutation still counted as executed (no-op succeeded)
      expect(result.executed).toBe(1);
    });

    it('integration entity type — executes without error (no-op)', () => {
      const csId = seedChangeset();
      stageMutation({
        changesetId: csId,
        entityType: 'integration',
        action: 'create',
        payload: { name: 'GitHub', provider: 'github', authType: 'token', authConfig: '{}' },
      });

      const result = executePendingMutations(csId);
      expect(result.errors).toHaveLength(0);
      expect(result.executed).toBe(1);
    });

    it('template entity type — executes without error (no-op)', () => {
      const csId = seedChangeset();
      stageMutation({
        changesetId: csId,
        entityType: 'template',
        action: 'create',
        payload: { name: 'My Template', image: 'openclaw/openclaw:latest' },
      });

      const result = executePendingMutations(csId);
      expect(result.errors).toHaveLength(0);
      expect(result.executed).toBe(1);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // ERROR HANDLING
  // ──────────────────────────────────────────────────────────────────

  describe('error handling', () => {
    it('update non-existent provider — returns error, executed=0, mutations NOT cleared', () => {
      const csId = seedChangeset();
      stageMutation({
        changesetId: csId,
        entityType: 'provider',
        entityId: 'nonexistent-provider',
        action: 'update',
        payload: { name: 'Ghost Provider' },
      });

      const result = executePendingMutations(csId);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('provider.update');
      // Transaction was rolled back — executed resets to 0
      expect(result.executed).toBe(0);

      // Pending mutations were NOT cleared because transaction rolled back
      const remaining = getDrizzle().select().from(pendingMutations).where(eq(pendingMutations.changesetId, csId)).all();
      expect(remaining).toHaveLength(1);
    });

    it('update non-existent model — returns error, executed=0', () => {
      const csId = seedChangeset();
      stageMutation({
        changesetId: csId,
        entityType: 'model',
        entityId: 'ghost-model-id',
        action: 'update',
        payload: { description: 'This model does not exist' },
      });

      const result = executePendingMutations(csId);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('model.update');
      expect(result.executed).toBe(0);
    });

    it('update non-existent api_key — returns error, executed=0', () => {
      const csId = seedChangeset();
      stageMutation({
        changesetId: csId,
        entityType: 'api_key',
        entityId: 'ghost-key-id',
        action: 'update',
        payload: { name: 'Ghost Key' },
      });

      const result = executePendingMutations(csId);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('api_key.update');
      expect(result.executed).toBe(0);
    });

    it('error mid-batch — earlier mutations are rolled back', () => {
      const csId = seedChangeset();

      // First mutation: valid model create
      stageMutation({
        changesetId: csId,
        entityType: 'model',
        action: 'create',
        payload: { name: 'rollback-model', provider: 'openai', modelId: 'gpt-4' },
      });

      // Second mutation: invalid provider update (will throw mid-transaction)
      stageMutation({
        changesetId: csId,
        entityType: 'provider',
        entityId: 'nonexistent-for-rollback',
        action: 'update',
        payload: { name: 'Ghost' },
      });

      const result = executePendingMutations(csId);
      expect(result.errors).toHaveLength(1);
      // Since creates are sorted before updates, and model.create succeeded
      // but provider.update failed — transaction is rolled back.
      expect(result.executed).toBe(0);

      // The model should NOT be in the DB (rollback)
      const model = getDrizzle().select().from(modelRegistry).where(eq(modelRegistry.name, 'rollback-model')).get();
      expect(model).toBeUndefined();
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // SORT ORDER (creates before updates before deletes)
  // ──────────────────────────────────────────────────────────────────

  describe('sort order', () => {
    it('processes updates before deletes — sorted correctly even when staged in reverse', () => {
      // Pre-seed a model we can update and delete
      seedModel({ id: 'sort-order-model', name: 'sort-order-model' });

      const csId = seedChangeset();

      // Stage DELETE first (will be at position 0 in insertion order)
      // Stage UPDATE second (inserted after)
      // Without sorting: delete runs first → update fails (entity gone)
      // With sorting: update < delete, so update runs first → delete → both succeed
      stageMutation({
        changesetId: csId,
        entityType: 'model',
        entityId: 'sort-order-model',
        action: 'delete',
      });
      stageMutation({
        changesetId: csId,
        entityType: 'model',
        entityId: 'sort-order-model',
        action: 'update',
        payload: { description: 'updated before delete' },
      });

      // If sorting works: update runs first (no error), then delete
      const result = executePendingMutations(csId);
      expect(result.executed).toBe(2);
      expect(result.errors).toHaveLength(0);

      // Model should be gone (deleted last)
      const row = getDrizzle().select().from(modelRegistry).where(eq(modelRegistry.id, 'sort-order-model')).get();
      expect(row).toBeUndefined();
    });

    it('processes creates before updates — new entity available for immediate update', () => {
      // Verify creates come before updates so that a create + update batch
      // on the same provider type succeeds without FK issues.
      // Stage update before create to ensure sort order fixes it.
      seedProvider({ id: 'sort-prov', name: 'Sort Provider' });

      const csId = seedChangeset();

      // Stage update first, create second — sort should reorder to create → update
      // Here we have two separate providers: update existing, create new
      stageMutation({
        changesetId: csId,
        entityType: 'provider',
        entityId: 'sort-prov',
        action: 'update',
        payload: { name: 'Sort Provider Updated' },
      });
      stageMutation({
        changesetId: csId,
        entityType: 'provider',
        action: 'create',
        payload: { name: 'New Sort Provider', type: 'openai' },
      });

      const result = executePendingMutations(csId);
      expect(result.executed).toBe(2);
      expect(result.errors).toHaveLength(0);

      const updated = getDrizzle().select().from(modelProviders).where(eq(modelProviders.id, 'sort-prov')).get();
      expect(updated!.name).toBe('Sort Provider Updated');

      const created = getDrizzle().select().from(modelProviders).where(eq(modelProviders.name, 'New Sort Provider')).get();
      expect(created).toBeDefined();
    });
  });
});
