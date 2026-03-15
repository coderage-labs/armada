/**
 * Concurrent changeset apply tests — #596
 *
 * Verifies:
 *   1. Instances on DIFFERENT nodes execute in parallel (concurrent, not sequential)
 *   2. Instances on the SAME node are capped at MAX_CONCURRENT_PER_NODE (2)
 *   3. Per-instance isolation: one instance failing does NOT abort others
 *   4. All instances still report their results (success/failure) in the final changeset
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setupTestDb, teardownTestDb } from '../../test/helpers.js';
import { getDrizzle } from '../../db/drizzle.js';
import { nodes, instances, changesets } from '../../db/drizzle-schema.js';
import { operationExecutor } from '../../infrastructure/executor-singleton.js';
import { operationManager } from '../../infrastructure/operations.js';
import { applyChangeset, MAX_CONCURRENT_PER_NODE } from '../changeset-apply.js';
import type { Changeset, ChangesetPlan, OperationStep } from '@coderage-labs/armada-shared';
import crypto from 'node:crypto';

// ── Seed helpers ──────────────────────────────────────────────────────────

function seedNode(id: string, hostname = 'host') {
  getDrizzle().insert(nodes).values({ id, hostname, status: 'online' }).run();
}

function seedInstance(id: string, nodeId: string) {
  getDrizzle().insert(instances).values({
    id,
    name: id,
    nodeId,
    status: 'running',
    capacity: 5,
    appliedConfigVersion: 0,
  }).run();
}

/** Build a minimal OperationStep with a nodeId in metadata. */
function makeStep(name: string, nodeId: string): OperationStep {
  return {
    id: crypto.randomUUID(),
    name,
    status: 'pending',
    metadata: { nodeId, containerName: `armada-instance-${name}` },
  };
}

/** Build an instanceOp entry for use inside a plan. */
function makeInstanceOp(instanceId: string, nodeId: string): ChangesetPlan['instanceOps'][0] {
  const step = makeStep('push_config', nodeId);
  return {
    instanceId,
    instanceName: instanceId,
    changes: [],
    steps: [step],
    stepDeps: [],
    estimatedDowntime: 0,
  };
}

/**
 * Insert a changeset into the DB and return the Changeset object.
 * Uses `status: 'approved'` so applyChangeset can process it.
 */
function insertApprovedChangeset(instanceOps: ChangesetPlan['instanceOps']): Changeset {
  const id = crypto.randomUUID();
  const plan: ChangesetPlan = {
    instanceOps,
    order: 'parallel',
    concurrency: 0,
    totalInstances: instanceOps.length,
    totalChanges: instanceOps.length,
    totalRestarts: 0,
    estimatedDuration: 0,
  };
  getDrizzle().insert(changesets).values({
    id,
    status: 'approved',
    changesJson: '[]',
    planJson: JSON.stringify(plan),
  }).run();
  return {
    id,
    status: 'approved',
    changes: [],
    plan,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Build a `getChangeset` function suitable for injection into applyChangeset.
 * Returns the in-memory object on the first call (approved), then re-reads from DB
 * so subsequent calls reflect the updated status/error.
 */
function makeGetChangeset(initial: Changeset): (id: string) => Changeset | null {
  let firstCall = true;
  return (id: string): Changeset | null => {
    if (id !== initial.id) return null;
    if (firstCall) {
      firstCall = false;
      return initial; // Return approved changeset with plan intact
    }
    // Subsequent calls: read final status from DB, preserve original plan
    const row = getDrizzle().select().from(changesets).all().find(r => r.id === id);
    if (!row) return null;
    return {
      ...initial,
      status: row.status as Changeset['status'],
      error: row.error ?? undefined,
      appliedAt: row.appliedAt ?? undefined,
      completedAt: row.completedAt ?? undefined,
    };
  };
}

// ── Mock helpers ──────────────────────────────────────────────────────────

/**
 * Replace operationExecutor.execute with a spy that:
 *  - records the call order / overlap via the provided tracker
 *  - marks the operation completed after an optional delay
 */
function mockExecutorWithTracker(
  tracker: { running: Set<string>; maxConcurrent: number; order: string[] },
  delayMs = 10,
) {
  return vi.spyOn(operationExecutor, 'execute').mockImplementation(async (opId: string) => {
    const op = operationManager.get(opId);
    const instanceId: string = op?.target?.instanceId ?? opId;

    tracker.running.add(instanceId);
    tracker.order.push(instanceId);
    if (tracker.running.size > tracker.maxConcurrent) {
      tracker.maxConcurrent = tracker.running.size;
    }

    operationManager.setRunning(opId);
    await new Promise(r => setTimeout(r, delayMs));

    tracker.running.delete(instanceId);
    operationManager.complete(opId);
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('Concurrent changeset apply (#596)', () => {
  beforeEach(() => {
    setupTestDb();
  });

  afterEach(() => {
    teardownTestDb();
    vi.restoreAllMocks();
  });

  // ── 1. Cross-node parallelism ──────────────────────────────────────────

  it('instances on different nodes execute concurrently (not sequentially)', async () => {
    seedNode('node-a');
    seedNode('node-b');
    seedNode('node-c');
    seedInstance('inst-a', 'node-a');
    seedInstance('inst-b', 'node-b');
    seedInstance('inst-c', 'node-c');

    const tracker = { running: new Set<string>(), maxConcurrent: 0, order: [] as string[] };
    mockExecutorWithTracker(tracker, 20 /* ms per op */);

    const cs = insertApprovedChangeset([
      makeInstanceOp('inst-a', 'node-a'),
      makeInstanceOp('inst-b', 'node-b'),
      makeInstanceOp('inst-c', 'node-c'),
    ]);

    await applyChangeset(cs.id, undefined, makeGetChangeset(cs));

    // All 3 instances ran concurrently — maxConcurrent should be 3 (one per node)
    expect(tracker.maxConcurrent).toBe(3);
    expect(tracker.order).toHaveLength(3);
  });

  // ── 2. Same-node concurrency cap ──────────────────────────────────────

  it(`same-node concurrency is capped at MAX_CONCURRENT_PER_NODE (${MAX_CONCURRENT_PER_NODE})`, async () => {
    seedNode('node-busy');
    for (let i = 1; i <= 4; i++) {
      seedInstance(`inst-${i}`, 'node-busy');
    }

    const concurrencySnapshots: number[] = [];
    let running = 0;

    vi.spyOn(operationExecutor, 'execute').mockImplementation(async (opId: string) => {
      running++;
      concurrencySnapshots.push(running);
      operationManager.setRunning(opId);
      await new Promise(r => setTimeout(r, 20));
      running--;
      operationManager.complete(opId);
    });

    const cs = insertApprovedChangeset([
      makeInstanceOp('inst-1', 'node-busy'),
      makeInstanceOp('inst-2', 'node-busy'),
      makeInstanceOp('inst-3', 'node-busy'),
      makeInstanceOp('inst-4', 'node-busy'),
    ]);

    await applyChangeset(cs.id, undefined, makeGetChangeset(cs));

    // No snapshot should exceed MAX_CONCURRENT_PER_NODE
    expect(Math.max(...concurrencySnapshots)).toBeLessThanOrEqual(MAX_CONCURRENT_PER_NODE);
    // All 4 ran
    expect(concurrencySnapshots).toHaveLength(4);
  });

  // ── 3. Per-instance failure isolation ─────────────────────────────────

  it('one instance failing does not abort other instances', async () => {
    seedNode('node-x');
    seedNode('node-y');
    seedInstance('inst-good-1', 'node-x');
    seedInstance('inst-fail',   'node-x');
    seedInstance('inst-good-2', 'node-y');

    const executed: string[] = [];

    vi.spyOn(operationExecutor, 'execute').mockImplementation(async (opId: string) => {
      const op = operationManager.get(opId);
      const instanceId: string = op?.target?.instanceId ?? opId;
      executed.push(instanceId);
      operationManager.setRunning(opId);
      await new Promise(r => setTimeout(r, 10));

      if (instanceId === 'inst-fail') {
        operationManager.fail(opId, 'simulated failure');
      } else {
        operationManager.complete(opId);
      }
    });

    const cs = insertApprovedChangeset([
      makeInstanceOp('inst-good-1', 'node-x'),
      makeInstanceOp('inst-fail',   'node-x'),
      makeInstanceOp('inst-good-2', 'node-y'),
    ]);

    await applyChangeset(cs.id, undefined, makeGetChangeset(cs));

    // All 3 instances were attempted — failure did not abort the others
    expect(executed).toHaveLength(3);
    expect(executed).toContain('inst-good-1');
    expect(executed).toContain('inst-fail');
    expect(executed).toContain('inst-good-2');

    // Check DB for final status
    const finalRow = getDrizzle().select().from(changesets).all().find(r => r.id === cs.id);
    expect(finalRow?.status).toBe('failed');
    expect(finalRow?.error).toContain('inst-fail');
    // Good instances should NOT appear in the error
    expect(finalRow?.error).not.toContain('inst-good-1');
    expect(finalRow?.error).not.toContain('inst-good-2');
  });

  // ── 4. All success → changeset completed ──────────────────────────────

  it('changeset status is completed when all instances succeed', async () => {
    seedNode('node-ok');
    seedInstance('inst-ok-1', 'node-ok');
    seedInstance('inst-ok-2', 'node-ok');

    vi.spyOn(operationExecutor, 'execute').mockImplementation(async (opId: string) => {
      operationManager.setRunning(opId);
      operationManager.complete(opId);
    });

    const cs = insertApprovedChangeset([
      makeInstanceOp('inst-ok-1', 'node-ok'),
      makeInstanceOp('inst-ok-2', 'node-ok'),
    ]);

    await applyChangeset(cs.id, undefined, makeGetChangeset(cs));

    const finalRow = getDrizzle().select().from(changesets).all().find(r => r.id === cs.id);
    expect(finalRow?.status).toBe('completed');
  });

  // ── 5. Constant value ─────────────────────────────────────────────────

  it('MAX_CONCURRENT_PER_NODE is 2', () => {
    expect(MAX_CONCURRENT_PER_NODE).toBe(2);
  });
});
