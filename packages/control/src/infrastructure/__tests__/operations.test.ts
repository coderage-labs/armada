import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestDb, teardownTestDb } from '../../test/helpers.js';
import { createOperationManager } from '../operations.js';

describe('OperationManager', () => {
  let ops: ReturnType<typeof createOperationManager>;

  beforeEach(() => {
    setupTestDb();
    ops = createOperationManager();
  });

  afterEach(() => {
    teardownTestDb();
  });

  describe('create', () => {
    it('creates an operation in pending state', () => {
      const id = ops.create('plugin.rollout', { plugin: 'test-plugin' });
      expect(id).toBeDefined();
      expect(typeof id).toBe('string');

      const op = ops.get(id);
      expect(op).not.toBeNull();
      expect(op!.type).toBe('plugin.rollout');
      expect(op!.status).toBe('pending');
      expect(op!.target).toEqual({ plugin: 'test-plugin' });
      expect(op!.events).toEqual([]);
      expect(op!.result).toBeNull();
      expect(op!.completedAt).toBeNull();
      expect(op!.startedAt).toBeDefined();
    });

    it('generates unique IDs', () => {
      const id1 = ops.create('type.a', {});
      const id2 = ops.create('type.b', {});
      expect(id1).not.toBe(id2);
    });
  });

  describe('emit', () => {
    it('appends event to operation events array', () => {
      const id = ops.create('test', {});
      ops.emit(id, { step: 'downloading' });
      ops.emit(id, { step: 'installing' });

      const op = ops.get(id);
      expect(op!.events).toHaveLength(2);
      expect(op!.events[0].step).toBe('downloading');
      expect(op!.events[1].step).toBe('installing');
    });

    it('adds timestamp to each event', () => {
      const id = ops.create('test', {});
      const before = Date.now();
      ops.emit(id, { step: 'step1' });
      const after = Date.now();

      const op = ops.get(id);
      expect(op!.events[0].timestamp).toBeGreaterThanOrEqual(before);
      expect(op!.events[0].timestamp).toBeLessThanOrEqual(after);
    });

    it('preserves extra fields on event', () => {
      const id = ops.create('test', {});
      ops.emit(id, { step: 'progress', percent: 50, agent: 'forge' });

      const op = ops.get(id);
      expect(op!.events[0]).toMatchObject({ step: 'progress', percent: 50, agent: 'forge' });
    });

    it('silently ignores unknown operation IDs', () => {
      expect(() => ops.emit('nonexistent-id', { step: 'x' })).not.toThrow();
    });
  });

  describe('complete', () => {
    it('sets status to completed', () => {
      const id = ops.create('test', {});
      ops.complete(id, { success: true });

      const op = ops.get(id);
      expect(op!.status).toBe('completed');
      expect(op!.result).toEqual({ success: true });
      expect(op!.completedAt).toBeDefined();
    });

    it('works without result argument', () => {
      const id = ops.create('test', {});
      ops.complete(id);

      const op = ops.get(id);
      expect(op!.status).toBe('completed');
      expect(op!.result).toBeNull();
    });
  });

  describe('fail', () => {
    it('sets status to failed with error', () => {
      const id = ops.create('test', {});
      ops.fail(id, 'Something went wrong');

      const op = ops.get(id);
      expect(op!.status).toBe('failed');
      expect(op!.result).toEqual({ error: 'Something went wrong' });
      expect(op!.completedAt).toBeDefined();
    });
  });

  describe('get', () => {
    it('returns null for unknown ID', () => {
      expect(ops.get('nonexistent')).toBeNull();
    });

    it('parses JSON fields correctly', () => {
      const id = ops.create('test', { agents: ['a', 'b'] });
      ops.emit(id, { step: 'done' });
      ops.complete(id, { count: 42 });

      const op = ops.get(id);
      expect(op!.target).toEqual({ agents: ['a', 'b'] });
      expect(op!.events).toHaveLength(1);
      expect(op!.result).toEqual({ count: 42 });
    });
  });

  describe('getActive', () => {
    it('returns only running operations', () => {
      const id1 = ops.create('a', {});
      const id2 = ops.create('b', {});
      ops.complete(id2);

      const active = ops.getActive();
      expect(active).toHaveLength(1);
      expect(active[0].id).toBe(id1);
    });

    it('returns empty when no active operations', () => {
      const id = ops.create('test', {});
      ops.complete(id);
      expect(ops.getActive()).toHaveLength(0);
    });
  });

  describe('getRecent', () => {
    it('returns all recent operations', () => {
      const id1 = ops.create('a', {});
      const id2 = ops.create('b', {});
      const id3 = ops.create('c', {});

      const recent = ops.getRecent();
      expect(recent).toHaveLength(3);
      // All three should be present
      const ids = recent.map(o => o.id);
      expect(ids).toContain(id1);
      expect(ids).toContain(id2);
      expect(ids).toContain(id3);
    });

    it('respects limit parameter', () => {
      ops.create('a', {});
      ops.create('b', {});
      ops.create('c', {});

      const recent = ops.getRecent(2);
      expect(recent).toHaveLength(2);
    });
  });
});
