import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setupTestDb, teardownTestDb } from '../../test/helpers.js';
import { createOperationManager } from '../operations.js';
import { createStepRegistry } from '../step-registry.js';
import { createOperationExecutor } from '../operation-executor.js';
import type { StepHandler, StepContext } from '../step-registry.js';
import type { OperationStep } from '@coderage-labs/armada-shared';
import crypto from 'node:crypto';

// Minimal mock services for the executor
const mockServices: StepContext['services'] = {
  nodeClient: () => ({} as any),
  instanceRepo: {} as any,
  agentsRepo: {} as any,
  nodesRepo: {} as any,
  eventBus: { emit: vi.fn() } as any,
};

function makeStep(name: string, metadata?: Record<string, any>): OperationStep {
  return {
    id: crypto.randomUUID(),
    name,
    status: 'pending' as const,
    metadata,
  };
}

describe('OperationExecutor', () => {
  let ops: ReturnType<typeof createOperationManager>;
  let registry: ReturnType<typeof createStepRegistry>;
  let executor: ReturnType<typeof createOperationExecutor>;

  beforeEach(() => {
    setupTestDb();
    ops = createOperationManager();
    registry = createStepRegistry();
    executor = createOperationExecutor(ops, registry, mockServices);
  });

  afterEach(() => {
    teardownTestDb();
  });

  it('executes all steps in order and completes', async () => {
    const executionOrder: string[] = [];

    registry.register({
      name: 'step_a',
      async execute() { executionOrder.push('a'); },
    });
    registry.register({
      name: 'step_b',
      async execute() { executionOrder.push('b'); },
    });
    registry.register({
      name: 'step_c',
      async execute() { executionOrder.push('c'); },
    });

    const steps = [makeStep('step_a'), makeStep('step_b'), makeStep('step_c')];
    const opId = ops.create('test.sequential', { test: true }, { steps });

    await executor.execute(opId);

    expect(executionOrder).toEqual(['a', 'b', 'c']);

    const op = ops.get(opId);
    expect(op!.status).toBe('completed');
    expect(op!.steps).toHaveLength(3);
    expect(op!.steps.every(s => s.status === 'completed')).toBe(true);
    // Each step should have startedAt and completedAt
    for (const step of op!.steps) {
      expect(step.startedAt).toBeDefined();
      expect(step.completedAt).toBeDefined();
    }
  });

  it('marks operation as failed when a step throws', async () => {
    registry.register({
      name: 'step_ok',
      async execute() { /* succeeds */ },
    });
    registry.register({
      name: 'step_fail',
      async execute() { throw new Error('boom'); },
    });
    registry.register({
      name: 'step_after',
      async execute() { /* should never run */ },
    });

    const steps = [makeStep('step_ok'), makeStep('step_fail'), makeStep('step_after')];
    const opId = ops.create('test.failure', {}, { steps });

    await executor.execute(opId);

    const op = ops.get(opId);
    expect(op!.status).toBe('failed');
    expect(op!.error).toContain('boom');

    // Step statuses: completed, failed, skipped
    expect(op!.steps[0].status).toBe('completed');
    expect(op!.steps[1].status).toBe('failed');
    expect(op!.steps[1].error).toContain('boom');
    expect(op!.steps[2].status).toBe('skipped');
  });

  it('fails when step handler is not registered', async () => {
    // Don't register 'unknown_step'
    const steps = [makeStep('unknown_step')];
    const opId = ops.create('test.unknown', {}, { steps });

    await executor.execute(opId);

    const op = ops.get(opId);
    expect(op!.status).toBe('failed');
    expect(op!.error).toContain('Unknown step handler');
  });

  it('cancels operation — remaining steps skipped', async () => {
    const executionOrder: string[] = [];

    registry.register({
      name: 'step_a',
      async execute() {
        executionOrder.push('a');
        // Request cancellation after first step runs
        await executor.cancel(opId);
      },
    });
    registry.register({
      name: 'step_b',
      async execute() { executionOrder.push('b'); },
    });

    const steps = [makeStep('step_a'), makeStep('step_b')];
    const opId = ops.create('test.cancel', {}, { steps });

    await executor.execute(opId);

    // step_a ran, step_b should be skipped
    expect(executionOrder).toEqual(['a']);

    const op = ops.get(opId);
    expect(op!.status).toBe('cancelled');
    expect(op!.steps[0].status).toBe('completed');
    expect(op!.steps[1].status).toBe('skipped');
  });

  it('handles empty steps list gracefully', async () => {
    const opId = ops.create('test.empty', {}, { steps: [] });

    await executor.execute(opId);

    const op = ops.get(opId);
    expect(op!.status).toBe('completed');
  });

  it('passes params from step metadata to handler', async () => {
    let receivedParams: Record<string, any> = {};

    registry.register({
      name: 'param_check',
      async execute(ctx) {
        receivedParams = ctx.params;
      },
    });

    const steps = [makeStep('param_check', { nodeId: 'node-1', image: 'test:latest' })];
    const opId = ops.create('test.params', {}, { steps });

    await executor.execute(opId);

    expect(receivedParams).toEqual({ nodeId: 'node-1', image: 'test:latest' });
  });

  it('emit function in context works', async () => {
    let emitCalled = false;

    registry.register({
      name: 'emit_test',
      async execute(ctx) {
        ctx.emit('Pulling image', { image: 'test:latest' });
        emitCalled = true;
      },
    });

    const steps = [makeStep('emit_test')];
    const opId = ops.create('test.emit', {}, { steps });

    await executor.execute(opId);

    expect(emitCalled).toBe(true);
    // Check that the event was recorded
    const op = ops.get(opId);
    const progressEvents = op!.events.filter(e => e.message === 'Pulling image');
    expect(progressEvents.length).toBeGreaterThanOrEqual(1);
  });

  it('throws if operation ID is invalid', async () => {
    await expect(executor.execute('nonexistent')).rejects.toThrow('not found');
  });
});

describe('OperationManager extended', () => {
  let ops: ReturnType<typeof createOperationManager>;

  beforeEach(() => {
    setupTestDb();
    ops = createOperationManager();
  });

  afterEach(() => {
    teardownTestDb();
  });

  it('create with opts stores steps, targetType, targetId, priority, createdBy', () => {
    const steps = [makeStep('pull_image'), makeStep('health_check')];
    const opId = ops.create('instance.provision', { instanceId: 'i-1' }, {
      steps,
      targetType: 'instance',
      targetId: 'i-1',
      priority: 'high',
      createdBy: 'user-123',
    });

    const op = ops.get(opId);
    expect(op!.steps).toHaveLength(2);
    expect(op!.targetType).toBe('instance');
    expect(op!.targetId).toBe('i-1');
    expect(op!.priority).toBe('high');
    expect(op!.createdBy).toBe('user-123');
    expect(op!.status).toBe('pending');
  });

  it('create without opts still works (backwards compat)', () => {
    const opId = ops.create('test', { foo: 'bar' });
    const op = ops.get(opId);
    expect(op!.status).toBe('pending');
    expect(op!.steps).toEqual([]);
    expect(op!.priority).toBe('normal');
    expect(op!.targetType).toBeUndefined();
  });

  it('updateSteps persists step changes', () => {
    const steps = [makeStep('pull_image'), makeStep('health_check')];
    const opId = ops.create('test', {}, { steps });

    const updated = steps.map((s, i) =>
      i === 0 ? { ...s, status: 'completed' as const, completedAt: new Date().toISOString() } : s
    );
    ops.updateSteps(opId, updated);

    const op = ops.get(opId);
    expect(op!.steps[0].status).toBe('completed');
    expect(op!.steps[1].status).toBe('pending');
  });

  it('cancel sets status to cancelled', () => {
    const opId = ops.create('test', {});
    ops.cancel(opId);

    const op = ops.get(opId);
    expect(op!.status).toBe('cancelled');
    expect(op!.completedAt).toBeDefined();
  });

  it('getActive returns pending and running ops', () => {
    const id1 = ops.create('a', {});  // pending
    const id2 = ops.create('b', {});  // will complete
    const id3 = ops.create('c', {});  // pending

    ops.complete(id2);

    const active = ops.getActive();
    expect(active).toHaveLength(2);
    const activeIds = active.map(o => o.id);
    expect(activeIds).toContain(id1);
    expect(activeIds).toContain(id3);
    expect(activeIds).not.toContain(id2);
  });
});
