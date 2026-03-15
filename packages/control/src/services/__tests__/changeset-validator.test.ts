// ── Changeset Validator Tests ──────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setupTestDb, teardownTestDb } from '../../test/helpers.js';
import { createChangesetValidator } from '../changeset-validator.js';
import type { StateChange, Changeset, ConfigSnapshot } from '@coderage-labs/armada-shared';
import { getDrizzle } from '../../db/drizzle.js';
import { changesets, nodes, instances } from '../../db/drizzle-schema.js';
import crypto from 'node:crypto';

// ── Mocks ────────────────────────────────────────────────────────────

vi.mock('../../infrastructure/lock-manager.js', () => ({
  lockManager: {
    getAll: vi.fn(() => []),
    isGlobalLocked: vi.fn(() => false),
    isNodeLocked: vi.fn(() => false),
    check: vi.fn(() => null),
  },
}));

vi.mock('../config-diff.js', () => ({
  configDiffService: {
    snapshot: vi.fn(),
    getCurrentVersion: vi.fn(() => 1),
    getStaleInstances: vi.fn(() => []),
    getPendingRestarts: vi.fn(() => []),
    markApplied: vi.fn(),
    clearPendingRestart: vi.fn(),
  },
}));

// ── Imports after mocks ──────────────────────────────────────────────

import { lockManager } from '../../infrastructure/lock-manager.js';
import { configDiffService } from '../config-diff.js';

// ── Helpers ──────────────────────────────────────────────────────────

function makeChange(overrides: Partial<StateChange> = {}): StateChange {
  return {
    instanceId: 'inst-1',
    type: 'config',
    field: 'config_version',
    current: 1,
    desired: 2,
    requiresRestart: true,
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<ConfigSnapshot> = {}): ConfigSnapshot {
  return {
    version: 1,
    providers: [],
    models: [],
    plugins: [],
    templateModels: {},
    ...overrides,
  };
}

function makeChangeset(overrides: Partial<Changeset> = {}): Changeset {
  return {
    id: crypto.randomUUID(),
    status: 'approved',
    changes: [makeChange()],
    plan: {
      instanceOps: [],
      order: 'sequential',
      concurrency: 1,
      totalInstances: 1,
      totalChanges: 1,
      totalRestarts: 1,
      estimatedDuration: 15,
    },
    rollback: makeSnapshot(),
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function seedNode(id = 'test-node') {
  getDrizzle().insert(nodes).values({
    id,
    hostname: 'test-host',
    status: 'online',
  }).run();
}

function seedInstance(id = 'inst-1', nodeId = 'test-node') {
  getDrizzle().insert(instances).values({
    id,
    name: id,
    nodeId,
    status: 'running',
    capacity: 5,
    appliedConfigVersion: 0,
  }).run();
}

function seedChangeset(overrides: { id?: string; status?: string; changes?: StateChange[] } = {}) {
  const id = overrides.id ?? crypto.randomUUID();
  const changes = overrides.changes ?? [makeChange({ instanceId: 'inst-other' })];
  getDrizzle().insert(changesets).values({
    id,
    status: overrides.status ?? 'draft',
    changesJson: JSON.stringify(changes),
    planJson: JSON.stringify({ instanceOps: [], order: 'sequential', concurrency: 1, totalInstances: 0, totalChanges: 0, totalRestarts: 0, estimatedDuration: 0 }),
    rollbackJson: JSON.stringify(makeSnapshot()),
    createdAt: new Date().toISOString(),
  }).run();
  return id;
}

// ── Tests ────────────────────────────────────────────────────────────

describe('ChangesetValidator', () => {
  let validator: ReturnType<typeof createChangesetValidator>;

  beforeEach(() => {
    setupTestDb();
    seedNode();
    seedInstance();
    validator = createChangesetValidator();

    // Reset mocks to safe defaults
    vi.mocked(lockManager.getAll).mockReturnValue([]);
    vi.mocked(lockManager.isGlobalLocked).mockReturnValue(false);
    vi.mocked(configDiffService.snapshot).mockReturnValue(makeSnapshot());
  });

  afterEach(() => {
    teardownTestDb();
    vi.restoreAllMocks();
  });

  // ── validateIntra ───────────────────────────────────────────────

  describe('validateIntra', () => {
    it('1. returns empty for non-conflicting changes', () => {
      const changes = [
        makeChange({ instanceId: 'inst-1' }),
        makeChange({ instanceId: 'inst-2' }),
      ];
      const result = validator.validateIntra(changes);
      expect(result).toHaveLength(0);
    });

    it('2. detects modify + delete on same instance', () => {
      const changes = [
        makeChange({ instanceId: 'inst-1', desired: 2 }),       // modify
        makeChange({ instanceId: 'inst-1', desired: null, field: 'remove' }),   // delete
      ];
      const result = validator.validateIntra(changes);
      expect(result).toHaveLength(1);
      expect(result[0].code).toBe('MODIFY_DELETED_INSTANCE');
      expect(result[0].type).toBe('error');
      expect(result[0].changeIndices).toContain(0);
      expect(result[0].changeIndices).toContain(1);
    });

    it('3. detects duplicate instance targets (warning)', () => {
      const changes = [
        makeChange({ instanceId: 'inst-1', field: 'config_version', desired: 2 }),
        makeChange({ instanceId: 'inst-1', field: 'config_version', desired: 3 }),
      ];
      const result = validator.validateIntra(changes);
      expect(result).toHaveLength(1);
      expect(result[0].code).toBe('DUPLICATE_TARGET');
      expect(result[0].type).toBe('warning');
      expect(result[0].changeIndices).toEqual([0, 1]);
    });

    it('returns empty for single change', () => {
      const result = validator.validateIntra([makeChange()]);
      expect(result).toHaveLength(0);
    });

    it('does not flag different fields on same instance as duplicate', () => {
      const changes = [
        makeChange({ instanceId: 'inst-1', field: 'config_version' }),
        makeChange({ instanceId: 'inst-1', field: 'image_tag' }),
      ];
      const result = validator.validateIntra(changes);
      expect(result).toHaveLength(0);
    });
  });

  // ── validateInter ───────────────────────────────────────────────

  describe('validateInter', () => {
    it('4. detects locked targets', () => {
      vi.mocked(lockManager.getAll).mockReturnValue([
        { targetType: 'instance', targetId: 'inst-1', operationId: 'op-123', acquiredAt: new Date().toISOString() },
      ]);

      const changes = [makeChange({ instanceId: 'inst-1' })];
      const result = validator.validateInter('cs-1', changes);

      expect(result).toHaveLength(1);
      expect(result[0].code).toBe('LOCKED_TARGET');
      expect(result[0].type).toBe('error');
      expect(result[0].message).toContain('op-123');
    });

    it('5. returns empty when no locks', () => {
      vi.mocked(lockManager.getAll).mockReturnValue([]);

      const changes = [makeChange({ instanceId: 'inst-1' })];
      const result = validator.validateInter('cs-1', changes);

      expect(result).toHaveLength(0);
    });

    it('returns global lock error when global lock is active', () => {
      vi.mocked(lockManager.isGlobalLocked).mockReturnValue(true);

      const changes = [makeChange()];
      const result = validator.validateInter('cs-1', changes);

      expect(result).toHaveLength(1);
      expect(result[0].code).toBe('GLOBAL_LOCK');
    });

    it('detects overlapping draft changeset', () => {
      const otherId = seedChangeset({ status: 'draft', changes: [makeChange({ instanceId: 'inst-1' })] });

      const changes = [makeChange({ instanceId: 'inst-1' })];
      const result = validator.validateInter('my-cs-id', changes);

      expect(result).toHaveLength(1);
      expect(result[0].code).toBe('OVERLAPPING_CHANGESET');
      expect(result[0].message).toContain(otherId);
    });

    it('ignores the current changeset when checking overlaps', () => {
      const myId = seedChangeset({ status: 'approved', changes: [makeChange({ instanceId: 'inst-1' })] });

      const changes = [makeChange({ instanceId: 'inst-1' })];
      const result = validator.validateInter(myId, changes);

      // Should not flag itself
      const overlapErrors = result.filter(c => c.code === 'OVERLAPPING_CHANGESET');
      expect(overlapErrors).toHaveLength(0);
    });
  });

  // ── checkStaleness ──────────────────────────────────────────────

  describe('checkStaleness', () => {
    it('6. returns stale=false when snapshot matches', () => {
      const snapshot = makeSnapshot({ version: 1 });
      vi.mocked(configDiffService.snapshot).mockReturnValue(snapshot);

      const changeset = makeChangeset({ rollback: snapshot });
      const result = validator.checkStaleness(changeset);

      expect(result.stale).toBe(false);
      expect(result.drift).toHaveLength(0);
    });

    it('7. returns stale=true when snapshot has drifted', () => {
      const oldSnapshot = makeSnapshot({ version: 1, providers: [] });
      const newSnapshot = makeSnapshot({
        version: 2,
        providers: [{ id: 'prov-1', type: 'anthropic', keys: [] }],
      });
      vi.mocked(configDiffService.snapshot).mockReturnValue(newSnapshot);

      const changeset = makeChangeset({ rollback: oldSnapshot });
      const result = validator.checkStaleness(changeset);

      expect(result.stale).toBe(true);
      expect(result.reason).toBeDefined();
      expect(result.drift.length).toBeGreaterThan(0);
    });

    it('returns stale=false when rollback is undefined', () => {
      const changeset = makeChangeset({ rollback: undefined });
      const result = validator.checkStaleness(changeset);

      expect(result.stale).toBe(false);
    });

    it('returns stale=false on version bump with identical data (version-only staleness removed)', () => {
      const oldSnapshot = makeSnapshot({ version: 1 });
      const newSnapshot = makeSnapshot({ version: 2 });
      vi.mocked(configDiffService.snapshot).mockReturnValue(newSnapshot);

      const changeset = makeChangeset({ rollback: oldSnapshot });
      const result = validator.checkStaleness(changeset);

      // Version-based staleness was removed (commit e6fd59e) — only real data drift matters
      expect(result.stale).toBe(false);
    });
  });

  // ── validate (full) ─────────────────────────────────────────────

  describe('validate', () => {
    it('8. returns canApply=true when all clear', () => {
      vi.mocked(lockManager.getAll).mockReturnValue([]);
      vi.mocked(lockManager.isGlobalLocked).mockReturnValue(false);
      const snapshot = makeSnapshot({ version: 1 });
      vi.mocked(configDiffService.snapshot).mockReturnValue(snapshot);

      const changeset = makeChangeset({ rollback: snapshot });
      const result = validator.validate(changeset);

      expect(result.canApply).toBe(true);
      expect(result.conflicts).toHaveLength(0);
      expect(result.staleness.stale).toBe(false);
    });

    it('9. returns canApply=false on error-level conflicts', () => {
      vi.mocked(lockManager.getAll).mockReturnValue([
        { targetType: 'instance', targetId: 'inst-1', operationId: 'op-999', acquiredAt: new Date().toISOString() },
      ]);

      const snapshot = makeSnapshot({ version: 1 });
      vi.mocked(configDiffService.snapshot).mockReturnValue(snapshot);

      const changeset = makeChangeset({
        changes: [makeChange({ instanceId: 'inst-1' })],
        rollback: snapshot,
      });
      const result = validator.validate(changeset);

      expect(result.canApply).toBe(false);
      expect(result.conflicts.some(c => c.type === 'error')).toBe(true);
    });

    it('returns canApply=false when stale', () => {
      vi.mocked(lockManager.getAll).mockReturnValue([]);
      vi.mocked(lockManager.isGlobalLocked).mockReturnValue(false);

      const oldSnapshot = makeSnapshot({ version: 1 });
      const newSnapshot = makeSnapshot({ version: 2 });
      vi.mocked(configDiffService.snapshot).mockReturnValue(newSnapshot);

      const changeset = makeChangeset({ rollback: oldSnapshot });
      const result = validator.validate(changeset);

      // Version-only bump is NOT stale anymore (removed in e6fd59e)
      expect(result.canApply).toBe(true);
      expect(result.staleness.stale).toBe(false);
    });

    it('returns canApply=true with only warning-level conflicts', () => {
      vi.mocked(lockManager.getAll).mockReturnValue([]);
      vi.mocked(lockManager.isGlobalLocked).mockReturnValue(false);
      const snapshot = makeSnapshot({ version: 1 });
      vi.mocked(configDiffService.snapshot).mockReturnValue(snapshot);

      // Duplicate target = warning only
      const changeset = makeChangeset({
        rollback: snapshot,
        changes: [
          makeChange({ instanceId: 'inst-1', field: 'config_version', desired: 2 }),
          makeChange({ instanceId: 'inst-1', field: 'config_version', desired: 3 }),
        ],
      });
      const result = validator.validate(changeset);

      expect(result.conflicts.some(c => c.type === 'warning')).toBe(true);
      expect(result.conflicts.some(c => c.type === 'error')).toBe(false);
      expect(result.canApply).toBe(true);
    });
  });
});
