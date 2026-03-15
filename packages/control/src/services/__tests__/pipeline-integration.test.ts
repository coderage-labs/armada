/**
 * Pipeline Integration Tests
 *
 * Issue #461 — executePendingMutations()
 * Issue #458 — Full mutation → changeset → apply pipeline
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setupTestDb, teardownTestDb } from '../../test/helpers.js';
import { executePendingMutations } from '../mutation-executor.js';
import { mutationService } from '../mutation-service.js';
import { createChangesetService } from '../changeset-service.js';
import { getDrizzle } from '../../db/drizzle.js';
import {
  nodes,
  instances,
  changesets,
  pendingMutations,
} from '../../db/drizzle-schema.js';
import {
  agentsRepo,
  modelProviderRepo,
  modelRegistryRepo,
  instancesRepo,
  pendingMutationRepo,
} from '../../repositories/index.js';
import { operationExecutor } from '../../infrastructure/executor-singleton.js';
import { operationManager } from '../../infrastructure/operations.js';

// ── Seed helpers ────────────────────────────────────────────────────

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
  status?: string;
} = {}) {
  const {
    id = 'inst-1',
    name = 'instance-1',
    nodeId = 'test-node',
    status = 'running',
  } = overrides;
  getDrizzle().insert(instances).values({
    id,
    name,
    nodeId,
    status,
    capacity: 5,
    appliedConfigVersion: 0,
  }).run();
}

function seedChangeset(id: string, status = 'draft') {
  getDrizzle().insert(changesets).values({
    id,
    status,
    changesJson: '[]',
    planJson: '{"instanceOps":[],"order":"sequential","concurrency":1,"totalInstances":0,"totalChanges":0,"totalRestarts":0,"estimatedDuration":0}',
  }).run();
}

function seedPendingMutation(opts: {
  id?: string;
  changesetId: string;
  entityType: string;
  entityId?: string;
  action: 'create' | 'update' | 'delete';
  payload: Record<string, any>;
}) {
  getDrizzle().insert(pendingMutations).values({
    id: opts.id ?? `mut-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    changesetId: opts.changesetId,
    entityType: opts.entityType,
    entityId: opts.entityId ?? null,
    action: opts.action,
    payloadJson: JSON.stringify(opts.payload),
  }).run();
}

// ── Suite 1: executePendingMutations() (#461) ───────────────────────

describe('executePendingMutations()', () => {
  beforeEach(() => {
    setupTestDb();
    seedNode();
    seedInstance();
  });

  afterEach(() => {
    teardownTestDb();
    vi.restoreAllMocks();
  });

  it('returns { executed: 0, errors: [] } for an empty / unknown changeset', () => {
    const result = executePendingMutations('nonexistent-cs');
    expect(result).toEqual({ executed: 0, errors: [] });
  });

  it('agent create mutation → agent appears in agents table', () => {
    const changesetId = 'cs-agent-create';
    seedChangeset(changesetId);
    seedPendingMutation({
      changesetId,
      entityType: 'agent',
      action: 'create',
      payload: {
        name: 'test-agent',
        nodeId: 'test-node',
        instanceId: 'inst-1',
        port: 8080,
        status: 'stopped',
        role: 'coder',
        skills: '',
        model: "",
      },
    });

    const result = executePendingMutations(changesetId);

    expect(result.errors).toHaveLength(0);
    expect(result.executed).toBeGreaterThan(0);

    const created = agentsRepo.getAll().find(a => a.name === 'test-agent');
    expect(created).toBeDefined();
    expect(created?.nodeId).toBe('test-node');
    expect(created?.instanceId).toBe('inst-1');
  });

  it('agent delete mutation → agent removed from agents table', () => {
    // Pre-create an agent directly so we have something to delete
    const agent = agentsRepo.create({
      name: 'agent-to-delete',
      nodeId: 'test-node',
      instanceId: 'inst-1',
      port: 8081,
      status: 'stopped',
      role: 'coder',
      skills: '',
      model: "",
      healthStatus: 'unknown',
      heartbeatMeta: null,
      avatarGenerating: false,
      lastHeartbeat: null,
      containerId: '',
      templateId: '',
    });

    const changesetId = 'cs-agent-delete';
    seedChangeset(changesetId);
    seedPendingMutation({
      changesetId,
      entityType: 'agent',
      entityId: agent.id,
      action: 'delete',
      payload: {},
    });

    const result = executePendingMutations(changesetId);

    expect(result.errors).toHaveLength(0);
    expect(agentsRepo.getById(agent.id)).toBeUndefined();
  });

  it('instance update mutation → instance fields updated', () => {
    const changesetId = 'cs-instance-update';
    seedChangeset(changesetId);
    seedPendingMutation({
      changesetId,
      entityType: 'instance',
      entityId: 'inst-1',
      action: 'update',
      payload: { capacity: 10 },
    });

    const result = executePendingMutations(changesetId);

    expect(result.errors).toHaveLength(0);
    const inst = instancesRepo.getById('inst-1');
    expect(inst).toBeDefined();
    expect(inst!.capacity).toBe(10);
  });

  it('provider create mutation → provider appears in DB', () => {
    const changesetId = 'cs-provider-create';
    seedChangeset(changesetId);
    seedPendingMutation({
      changesetId,
      entityType: 'provider',
      action: 'create',
      payload: {
        name: 'OpenAI',
        type: 'openai',
        apiKey: 'sk-test',
        enabled: 1,
      },
    });

    const result = executePendingMutations(changesetId);

    expect(result.errors).toHaveLength(0);
    expect(result.executed).toBeGreaterThan(0);
    const providers = modelProviderRepo.getAll();
    expect(providers.some(p => p.name === 'OpenAI')).toBe(true);
  });

  it('model create mutation → model appears in DB', () => {
    const changesetId = 'cs-model-create';
    seedChangeset(changesetId);
    seedPendingMutation({
      changesetId,
      entityType: 'model',
      action: 'create',
      payload: {
        name: 'gpt-4-turbo',
        provider: 'openai',
        modelId: 'gpt-4-turbo',
        description: 'GPT-4 Turbo',
        capabilities: ['chat'],
        costTier: 'premium',
      },
    });

    const result = executePendingMutations(changesetId);

    expect(result.errors).toHaveLength(0);
    const model = modelRegistryRepo.getByName('gpt-4-turbo');
    expect(model).not.toBeNull();
    expect(model?.provider).toBe('openai');
  });

  it('transaction atomicity: one failing mutation rolls back the entire batch', () => {
    const changesetId = 'cs-atomicity';
    seedChangeset(changesetId);

    // Valid provider create — should NOT persist because a later mutation fails
    seedPendingMutation({
      id: 'mut-valid',
      changesetId,
      entityType: 'provider',
      action: 'create',
      payload: { name: 'TestProvider', type: 'openai', enabled: 1 },
    });

    // Invalid agent create — references a non-existent instance → FK violation
    seedPendingMutation({
      id: 'mut-bad',
      changesetId,
      entityType: 'agent',
      action: 'create',
      payload: {
        name: 'bad-agent',
        nodeId: 'test-node',
        instanceId: 'nonexistent-instance', // no FK match → will throw
        port: 9999,
        status: 'stopped',
        role: null,
        skills: null,
        model: "",
      },
    });

    const result = executePendingMutations(changesetId);

    // At least one error reported
    expect(result.errors.length).toBeGreaterThan(0);
    // Counter reset to 0 — nothing committed
    expect(result.executed).toBe(0);

    // Provider should NOT be in DB (rolled back with the bad agent)
    const providers = modelProviderRepo.getAll();
    expect(providers.some(p => p.name === 'TestProvider')).toBe(false);

    // Pending mutations should still exist (removeByChangeset was inside the rolled-back tx)
    const remaining = pendingMutationRepo.getByChangeset(changesetId);
    expect(remaining.length).toBeGreaterThan(0);
  });

  it('pending mutations are removed from DB after successful execution', () => {
    const changesetId = 'cs-cleanup';
    seedChangeset(changesetId);
    seedPendingMutation({
      changesetId,
      entityType: 'model',
      action: 'create',
      payload: { name: 'cleanup-model', provider: 'openai', modelId: 'gpt-cleanup' },
    });

    expect(pendingMutationRepo.getByChangeset(changesetId)).toHaveLength(1);

    executePendingMutations(changesetId);

    expect(pendingMutationRepo.getByChangeset(changesetId)).toHaveLength(0);
  });
});

// ── Suite 2: Full mutation → changeset → apply pipeline (#458) ──────

describe('Full mutation → changeset → apply pipeline', () => {
  beforeEach(() => {
    setupTestDb();
    seedNode();
    seedInstance({ status: 'running' });
  });

  afterEach(() => {
    teardownTestDb();
    vi.restoreAllMocks();
  });

  it('staging a model mutation auto-creates a draft changeset', () => {
    const service = createChangesetService();

    mutationService.stage('model', 'create', {
      name: 'pipeline-model',
      provider: 'openai',
      modelId: 'gpt-4',
      description: 'Test model',
    });

    const drafts = service.list().filter(c => c.status === 'draft');
    expect(drafts.length).toBeGreaterThan(0);

    // The draft changeset should target the running instance
    const draft = drafts[0]!;
    expect(draft.plan.instanceOps.length).toBeGreaterThan(0);
    expect(draft.plan.instanceOps.some(op => op.instanceId === 'inst-1')).toBe(true);
  });

  it('staging an agent mutation targets the correct instance', () => {
    const service = createChangesetService();

    mutationService.stage('agent', 'create', {
      name: 'pipeline-agent',
      nodeId: 'test-node',
      instanceId: 'inst-1',
      port: 8080,
      status: 'stopped',
      role: 'coder',
    });

    const drafts = service.list().filter(c => c.status === 'draft');
    expect(drafts.length).toBeGreaterThan(0);

    const draft = drafts[0]!;
    const instanceIds = draft.plan.instanceOps.map(op => op.instanceId);
    expect(instanceIds).toContain('inst-1');
  });

  it('approve transitions changeset from draft to approved', () => {
    const service = createChangesetService();

    mutationService.stage('model', 'create', {
      name: 'approve-test-model',
      provider: 'anthropic',
      modelId: 'claude-3',
    });

    const drafts = service.list().filter(c => c.status === 'draft');
    expect(drafts.length).toBeGreaterThan(0);

    const draft = drafts[0]!;
    const approved = service.approve(draft.id, 'test-admin');

    expect(approved.status).toBe('approved');
    expect(approved.approvedBy).toBe('test-admin');
    expect(approved.approvedAt).toBeTruthy();
  });

  it('apply flushes mutations to real DB tables and marks changeset completed', async () => {
    const service = createChangesetService();

    mutationService.stage('provider', 'create', {
      name: 'Anthropic',
      type: 'anthropic',
      enabled: 1,
    });

    const drafts = service.list().filter(c => c.status === 'draft');
    const draft = drafts[0]!;
    service.approve(draft.id, 'test-admin');

    // Mock the operation executor — no Docker available in tests
    vi.spyOn(operationExecutor, 'execute').mockResolvedValue(undefined);
    vi.spyOn(operationManager, 'get').mockReturnValue({
      id: 'mock-op-id',
      type: 'changeset_apply',
      status: 'completed',
      target: {},
      steps: [],
      stepDeps: [],
      priority: 'normal',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      events: [],
      result: null,
    });

    const result = await service.apply(draft.id);

    // Changeset reaches completed state
    expect(result.status).toBe('completed');
    expect(result.completedAt).toBeTruthy();

    // Provider flushed from pending_mutations to real DB
    const providers = modelProviderRepo.getAll();
    expect(providers.some(p => p.name === 'Anthropic')).toBe(true);

    // Pending mutations cleaned up
    expect(pendingMutationRepo.getByChangeset(draft.id)).toHaveLength(0);
  });

  it('apply with a failing mutation marks changeset as failed and does not commit entities', async () => {
    const service = createChangesetService();

    // Stage a valid model mutation (creates the draft changeset)
    mutationService.stage('model', 'create', {
      name: 'fail-test-model',
      provider: 'openai',
      modelId: 'gpt-fail',
    });

    const drafts = service.list().filter(c => c.status === 'draft');
    const draft = drafts[0]!;
    service.approve(draft.id);

    // Inject a bad agent mutation (FK violation) into the same changeset
    seedPendingMutation({
      changesetId: draft.id,
      entityType: 'agent',
      action: 'create',
      payload: {
        name: 'bad-agent-in-pipeline',
        nodeId: 'test-node',
        instanceId: 'nonexistent-instance', // FK violation → tx rollback
        port: 9999,
        status: 'stopped',
      },
    });

    // executor mock — won't be reached because executePendingMutations fails first
    vi.spyOn(operationExecutor, 'execute').mockResolvedValue(undefined);

    const result = await service.apply(draft.id);

    // Changeset marked failed
    expect(result.status).toBe('failed');
    // Model should NOT be in DB — transaction was rolled back
    expect(modelRegistryRepo.getByName('fail-test-model')).toBeNull();
  });
});
