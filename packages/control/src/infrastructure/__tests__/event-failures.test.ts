/**
 * Negative-path tests for event wiring failures.
 *
 * These tests verify that the system remains resilient when individual
 * event handlers throw — mutations stay in the DB, changesets survive,
 * and other handlers are not prevented from running.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setupTestDb, teardownTestDb } from '../../test/helpers.js';
import { createEventBus } from '../event-bus.js';
import { changesetService } from '../../services/changeset-service.js';
import { mutationService } from '../../services/mutation-service.js';
import { pendingMutationRepo } from '../../repositories/index.js';
import { configDiffService } from '../../services/config-diff.js';
import { getDrizzle } from '../../db/drizzle.js';
import { changesets, pendingMutations } from '../../db/drizzle-schema.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function seedDraftChangeset(id = 'draft-cs-1'): void {
  getDrizzle().insert(changesets).values({
    id,
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
    createdAt: new Date().toISOString(),
  }).run();
}

function seedPendingMutation(id: string, changesetId = 'draft-cs-1'): void {
  getDrizzle().insert(pendingMutations).values({
    id,
    changesetId,
    entityType: 'model',
    entityId: 'model-1',
    action: 'update',
    payloadJson: JSON.stringify({ name: 'gpt-4' }),
  }).run();
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Event Wiring Failures — negative paths', () => {
  beforeEach(() => {
    setupTestDb();
  });

  afterEach(() => {
    teardownTestDb();
    vi.restoreAllMocks();
  });

  // ── Scenario 1 ───────────────────────────────────────────────────────────
  it('rebuildSteps throws during mutation.created → draft changeset still exists, mutation still stored, console.warn called', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const changesetId = 'draft-cs-1';
    seedDraftChangeset(changesetId);
    seedPendingMutation('mut-1', changesetId);

    // Make rebuildSteps throw to simulate a failure during mutation stage
    vi.spyOn(changesetService, 'rebuildSteps').mockImplementation(() => {
      throw new Error('DB constraint violated');
    });

    // Replicate the same wiring logic from initEventWiring() on an isolated bus
    const bus = createEventBus();
    bus.on('mutation.created', (event: any) => {
      const { changesetId: csId } = event.data ?? event;
      try {
        changesetService.rebuildSteps(csId);
      } catch (err: any) {
        console.warn('[event-wiring] rebuildSteps failed:', err.message);
      }
    });

    // Trigger the event
    bus.emit('mutation.created', { changesetId });

    // Error should be logged via console.warn
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0][0]).toMatch(/\[event-wiring\] rebuildSteps failed:/);
    expect(warnSpy.mock.calls[0][1]).toMatch(/DB constraint violated/);

    // Draft changeset must still exist
    const cs = changesetService.get(changesetId);
    expect(cs).not.toBeNull();
    expect(cs!.status).toBe('draft');

    // Mutation must still be in the DB
    const mutations = pendingMutationRepo.getByChangeset(changesetId);
    expect(mutations).toHaveLength(1);
    expect(mutations[0].id).toBe('mut-1');
  });

  // ── Scenario 2 ───────────────────────────────────────────────────────────
  it('config-version-tracker handler throws → mutation still written to DB, error logged via event bus error handler', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Mutation is written to DB *before* the event fires — simulating mutation-service.stage()
    seedPendingMutation('mut-2', 'pending');

    // Make bumpVersion throw to simulate a config-version-tracker failure
    vi.spyOn(configDiffService, 'bumpVersion').mockImplementation(() => {
      throw new Error('version bump failed');
    });

    // Replicate the config-version-tracker wiring on an isolated bus
    const bus = createEventBus();
    bus.on('mutation.staged', () => {
      configDiffService.bumpVersion(); // will throw
      bus.emit('config.changed', {});
    });

    // Trigger the config-change event (mutation.staged is in CONFIG_CHANGE_EVENTS)
    bus.emit('mutation.staged', { entityType: 'provider', entityId: 'prov-1' });

    // Event bus should have caught the throw and logged via console.error
    expect(errorSpy).toHaveBeenCalled();
    expect(errorSpy.mock.calls[0][0]).toMatch(/\[event-bus\] Handler error on 'mutation\.staged': version bump failed/);

    // Mutation must still be in the DB despite the handler failure
    const allMutations = pendingMutationRepo.getAll();
    expect(allMutations.some(m => m.id === 'mut-2')).toBe(true);
  });

  // ── Scenario 3 ───────────────────────────────────────────────────────────
  it('multiple event handlers registered, one throws → other handlers still execute (bus isolation)', () => {
    const bus = createEventBus();
    const executed: string[] = [];

    bus.on('fleet.update', () => { executed.push('handler-a'); });
    bus.on('fleet.update', () => { throw new Error('handler-b exploded'); });
    bus.on('fleet.update', () => { executed.push('handler-c'); });

    // Bus must not propagate the error to the caller
    expect(() => bus.emit('fleet.update', { instanceId: 'inst-1' })).not.toThrow();

    // Handlers before and after the failing one must still run
    expect(executed).toContain('handler-a');
    expect(executed).toContain('handler-c');
    // handler-b never pushed to executed
    expect(executed).not.toContain('handler-b');
    // Total: exactly two successful handlers
    expect(executed).toHaveLength(2);
  });

  // ── Scenario 4 ───────────────────────────────────────────────────────────
  it('getOrCreateDraft() returns null when no pending changes → mutation stored with changesetId pending, no crash', () => {
    // No running instances seeded → changesetService.create() throws "No pending changes"
    // mutationService.stage() must catch this gracefully
    let mutation: ReturnType<typeof mutationService.stage> | undefined;

    expect(() => {
      mutation = mutationService.stage('model', 'update', { name: 'gpt-4o' }, 'model-42');
    }).not.toThrow();

    expect(mutation).toBeDefined();

    // Mutation must be persisted in DB
    const allMutations = pendingMutationRepo.getAll();
    const stored = allMutations.find(m => m.id === mutation!.id);
    expect(stored).toBeDefined();

    // No changeset was created — mutation stays with the 'pending' placeholder id
    expect(stored!.changesetId).toBe('pending');

    // Absolutely no active draft changeset should exist
    const drafts = changesetService.list(20).filter(c => c.status === 'draft');
    expect(drafts).toHaveLength(0);
  });
});
