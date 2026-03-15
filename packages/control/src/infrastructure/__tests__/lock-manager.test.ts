import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestDb, teardownTestDb } from '../../test/helpers.js';
import { getDrizzle } from '../../db/drizzle.js';
import { nodes, instances, operationLocks, operations } from '../../db/drizzle-schema.js';
import { createLockManager } from '../lock-manager.js';
import type { LockManager } from '../lock-manager.js';

// Helper to insert a node
function insertNode(nodeId: string) {
  getDrizzle().insert(nodes).values({
    id: nodeId,
    hostname: `node-${nodeId}`,
    ip: '',
    port: 8080,
    url: '',
    token: '',
    cores: 2,
    memory: 4096,
    status: 'online',
  }).run();
}

// Helper to insert an instance linked to a node
function insertInstance(instanceId: string, nodeId: string) {
  getDrizzle().insert(instances).values({
    id: instanceId,
    name: `instance-${instanceId}`,
    nodeId,
    status: 'running',
    capacity: 5,
  }).run();
}

describe('LockManager', () => {
  let lm: LockManager;

  beforeEach(() => {
    setupTestDb();
    lm = createLockManager();
  });

  afterEach(() => {
    teardownTestDb();
  });

  it('acquire + check returns lock info', () => {
    const result = lm.acquire('instance', 'inst-1', 'op-1');
    expect(result).toBe(true);

    const lock = lm.check('instance', 'inst-1');
    expect(lock).not.toBeNull();
    expect(lock!.operationId).toBe('op-1');
    expect(lock!.acquiredAt).toBeDefined();
  });

  it('acquire same target twice returns false (already locked)', () => {
    lm.acquire('instance', 'inst-1', 'op-1');
    const second = lm.acquire('instance', 'inst-1', 'op-2');
    expect(second).toBe(false);

    // Original lock should still be held
    const lock = lm.check('instance', 'inst-1');
    expect(lock!.operationId).toBe('op-1');
  });

  it('release removes the lock', () => {
    lm.acquire('instance', 'inst-1', 'op-1');
    const released = lm.release('instance', 'inst-1', 'op-1');
    expect(released).toBe(true);

    const lock = lm.check('instance', 'inst-1');
    expect(lock).toBeNull();
  });

  it('release with wrong operationId returns false and leaves lock intact', () => {
    lm.acquire('instance', 'inst-1', 'op-1');
    const released = lm.release('instance', 'inst-1', 'op-WRONG');
    expect(released).toBe(false);

    // Lock still held by op-1
    expect(lm.check('instance', 'inst-1')).not.toBeNull();
  });

  it('releaseAll removes all locks for an operation', () => {
    lm.acquire('instance', 'inst-1', 'op-1');
    lm.acquire('instance', 'inst-2', 'op-1');
    lm.acquire('node', 'node-1', 'op-1');

    const count = lm.releaseAll('op-1');
    expect(count).toBe(3);

    expect(lm.check('instance', 'inst-1')).toBeNull();
    expect(lm.check('instance', 'inst-2')).toBeNull();
    expect(lm.check('node', 'node-1')).toBeNull();
  });

  it('isGlobalLocked returns true when global lock held', () => {
    expect(lm.isGlobalLocked()).toBe(false);
    lm.acquire('global', 'fleet', 'op-global');
    expect(lm.isGlobalLocked()).toBe(true);
    lm.release('global', 'fleet', 'op-global');
    expect(lm.isGlobalLocked()).toBe(false);
  });

  it('check returns null when not locked', () => {
    expect(lm.check('instance', 'nonexistent')).toBeNull();
  });

  it('multiple locks on different targets work independently', () => {
    lm.acquire('instance', 'inst-A', 'op-1');
    lm.acquire('instance', 'inst-B', 'op-2');
    lm.acquire('node', 'node-X', 'op-3');

    expect(lm.check('instance', 'inst-A')!.operationId).toBe('op-1');
    expect(lm.check('instance', 'inst-B')!.operationId).toBe('op-2');
    expect(lm.check('node', 'node-X')!.operationId).toBe('op-3');

    const all = lm.getAll();
    expect(all).toHaveLength(3);
  });

  it('isNodeLocked detects node-level lock', () => {
    insertNode('node-42');
    expect(lm.isNodeLocked('node-42')).toBe(false);
    lm.acquire('node', 'node-42', 'op-node');
    expect(lm.isNodeLocked('node-42')).toBe(true);
  });

  it('isNodeLocked detects when an instance on the node is locked', () => {
    insertNode('node-99');
    insertInstance('inst-99', 'node-99');
    expect(lm.isNodeLocked('node-99')).toBe(false);
    lm.acquire('instance', 'inst-99', 'op-inst');
    expect(lm.isNodeLocked('node-99')).toBe(true);
  });

  it('isNodeLocked returns false for unknown node', () => {
    expect(lm.isNodeLocked('node-unknown')).toBe(false);
  });

  it('cleanupStale removes locks for stale operations', () => {
    const db = getDrizzle();
    const oldTs = new Date(Date.now() - 20 * 60 * 1000).toISOString(); // 20 min ago

    // Create a stale operation (running but no recent events)
    db.insert(operations).values({
      id: 'op-stale',
      type: 'test',
      status: 'running',
      startedAt: oldTs,
      eventsJson: '[]',
    }).run();

    // Manually insert lock for the stale operation
    db.insert(operationLocks).values({
      targetType: 'instance',
      targetId: 'inst-stale',
      operationId: 'op-stale',
      acquiredAt: oldTs,
    }).run();

    // Create a fresh operation
    db.insert(operations).values({
      id: 'op-fresh',
      type: 'test',
      status: 'running',
      startedAt: new Date().toISOString(),
      eventsJson: '[]',
    }).run();

    // Manually insert lock for the fresh operation
    db.insert(operationLocks).values({
      targetType: 'instance',
      targetId: 'inst-fresh',
      operationId: 'op-fresh',
      acquiredAt: new Date().toISOString(),
    }).run();

    // Stale threshold: 10 minutes
    const removed = lm.cleanupStale(10 * 60 * 1000);
    expect(removed).toBe(1);
    expect(lm.check('instance', 'inst-stale')).toBeNull();
    // Fresh lock still intact
    expect(lm.check('instance', 'inst-fresh')).not.toBeNull();
  });

  it('cleanupStale removes locks for completed operations', () => {
    const db = getDrizzle();
    const now = new Date().toISOString();

    // Create a completed operation (should be cleaned up regardless of recency)
    db.insert(operations).values({
      id: 'op-done',
      type: 'test',
      status: 'completed',
      startedAt: now,
      completedAt: now,
      eventsJson: '[]',
    }).run();

    db.insert(operationLocks).values({
      targetType: 'instance',
      targetId: 'inst-done',
      operationId: 'op-done',
      acquiredAt: now,
    }).run();

    const removed = lm.cleanupStale(10 * 60 * 1000);
    expect(removed).toBe(1);
    expect(lm.check('instance', 'inst-done')).toBeNull();
  });
});
