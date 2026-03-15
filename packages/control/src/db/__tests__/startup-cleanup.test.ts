import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setupTestDb, teardownTestDb } from '../../test/helpers.js';
import { runStartupCleanup } from '../startup-cleanup.js';
import type Database from 'better-sqlite3';

// ── Helpers ──────────────────────────────────────────────────────────

function seedNode(db: Database.Database, id = 'test-node') {
  db.prepare(`
    INSERT OR IGNORE INTO nodes (id, hostname, ip, port, url, token)
    VALUES (?, 'test-host', '127.0.0.1', 8080, '', '')
  `).run(id);
}

function seedChangeset(
  db: Database.Database,
  id: string,
  status: string,
) {
  db.prepare(`
    INSERT INTO changesets (id, status, changes_json, plan_json)
    VALUES (?, ?, '[]', '{}')
  `).run(id, status);
}

function seedInstance(
  db: Database.Database,
  id: string,
  status: string,
  nodeId = 'test-node',
) {
  db.prepare(`
    INSERT INTO instances (id, name, node_id, status, capacity)
    VALUES (?, ?, ?, ?, 5)
  `).run(id, `instance-${id}`, nodeId, status);
}

function seedMutation(
  db: Database.Database,
  id: string,
  changesetId: string,
) {
  db.prepare(`
    INSERT INTO pending_mutations (id, changeset_id, entity_type, action, payload_json)
    VALUES (?, ?, 'agent', 'create', '{}')
  `).run(id, changesetId);
}

function getChangeset(db: Database.Database, id: string) {
  return db.prepare('SELECT * FROM changesets WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
}

function countMutations(db: Database.Database) {
  return (
    db.prepare('SELECT COUNT(*) as cnt FROM pending_mutations').get() as {
      cnt: number;
    }
  ).cnt;
}

function countChangesets(db: Database.Database) {
  return (
    db.prepare('SELECT COUNT(*) as cnt FROM changesets').get() as {
      cnt: number;
    }
  ).cnt;
}

function getInstance(db: Database.Database, id: string) {
  return db.prepare('SELECT * FROM instances WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
}

function countInstances(db: Database.Database) {
  return (
    db.prepare('SELECT COUNT(*) as cnt FROM instances').get() as {
      cnt: number;
    }
  ).cnt;
}

// ── Tests ────────────────────────────────────────────────────────────

describe('runStartupCleanup', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = setupTestDb();
    seedNode(db);
  });

  afterEach(() => {
    teardownTestDb();
  });

  // ── Scenario 1: Interrupted (applying) changesets ─────────────────

  describe('scenario 1: applying changeset (interrupted)', () => {
    it('marks an applying changeset as failed', () => {
      seedChangeset(db, 'cs-applying', 'applying');

      runStartupCleanup(db);

      const cs = getChangeset(db, 'cs-applying');
      expect(cs).toBeDefined();
      expect(cs!.status).toBe('failed');
    });

    it('sets error message on interrupted changeset', () => {
      seedChangeset(db, 'cs-applying', 'applying');

      runStartupCleanup(db);

      const cs = getChangeset(db, 'cs-applying');
      expect(cs!.error).toBe('Interrupted by server restart');
    });

    it('does not delete an applying changeset', () => {
      seedChangeset(db, 'cs-applying', 'applying');

      runStartupCleanup(db);

      expect(countChangesets(db)).toBe(1);
    });

    it('marks multiple applying changesets as failed', () => {
      seedChangeset(db, 'cs-applying-1', 'applying');
      seedChangeset(db, 'cs-applying-2', 'applying');

      runStartupCleanup(db);

      expect(getChangeset(db, 'cs-applying-1')!.status).toBe('failed');
      expect(getChangeset(db, 'cs-applying-2')!.status).toBe('failed');
    });

    it('leaves completed/failed/rolled_back changesets untouched', () => {
      seedChangeset(db, 'cs-completed', 'completed');
      seedChangeset(db, 'cs-failed', 'failed');
      seedChangeset(db, 'cs-rolled-back', 'rolled_back');

      runStartupCleanup(db);

      expect(getChangeset(db, 'cs-completed')!.status).toBe('completed');
      expect(getChangeset(db, 'cs-failed')!.status).toBe('failed');
      expect(getChangeset(db, 'cs-rolled-back')!.status).toBe('rolled_back');
    });

    it('logs the correct warning message for each interrupted changeset', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      seedChangeset(db, 'cs-applying', 'applying');

      runStartupCleanup(db);

      expect(warnSpy).toHaveBeenCalledWith(
        "[startup] Found changeset cs-applying in 'applying' state — marking as failed (interrupted by restart)",
      );
      warnSpy.mockRestore();
    });
  });

  // ── Scenario 2: Draft / approved changesets — PRESERVED ──────────

  describe('scenario 2: draft and approved changesets (preserved across restarts)', () => {
    it('preserves draft changesets', () => {
      seedChangeset(db, 'cs-draft', 'draft');

      runStartupCleanup(db);

      const cs = getChangeset(db, 'cs-draft');
      expect(cs).toBeDefined();
      expect(cs!.status).toBe('draft');
    });

    it('preserves approved changesets', () => {
      seedChangeset(db, 'cs-approved', 'approved');

      runStartupCleanup(db);

      const cs = getChangeset(db, 'cs-approved');
      expect(cs).toBeDefined();
      expect(cs!.status).toBe('approved');
    });

    it('preserves multiple draft and approved changesets', () => {
      seedChangeset(db, 'cs-draft-1', 'draft');
      seedChangeset(db, 'cs-draft-2', 'draft');
      seedChangeset(db, 'cs-approved-1', 'approved');

      runStartupCleanup(db);

      expect(countChangesets(db)).toBe(3);
    });

    it('preserves draft changesets alongside completed ones', () => {
      seedChangeset(db, 'cs-done', 'completed');
      seedChangeset(db, 'cs-draft', 'draft');

      runStartupCleanup(db);

      expect(getChangeset(db, 'cs-done')).toBeDefined();
      expect(getChangeset(db, 'cs-draft')).toBeDefined();
    });
  });

  // ── Scenario 3: Orphaned mutations ───────────────────────────────

  describe('scenario 3: orphaned mutations', () => {
    it('cleans up mutations with changeset_id = pending', () => {
      seedMutation(db, 'mut-pending', 'pending');

      runStartupCleanup(db);

      expect(countMutations(db)).toBe(0);
    });

    it('cleans up mutations with changeset_id = unlinked', () => {
      seedMutation(db, 'mut-unlinked', 'unlinked');

      runStartupCleanup(db);

      expect(countMutations(db)).toBe(0);
    });

    it('cleans up mutations referencing a non-existent changeset', () => {
      seedMutation(db, 'mut-orphan', 'cs-nonexistent');

      runStartupCleanup(db);

      expect(countMutations(db)).toBe(0);
    });

    it('retains mutations tied to surviving (failed) changesets', () => {
      seedChangeset(db, 'cs-applying', 'applying');
      seedMutation(db, 'mut-tied', 'cs-applying');

      runStartupCleanup(db);

      // applying → failed, so mutation should stay
      expect(countMutations(db)).toBe(1);
    });

    it('retains mutations tied to draft changesets', () => {
      seedChangeset(db, 'cs-draft', 'draft');
      seedMutation(db, 'mut-draft', 'cs-draft');

      runStartupCleanup(db);

      // draft changeset is preserved, so its mutation should survive
      expect(countMutations(db)).toBe(1);
    });

    it('retains mutations tied to approved changesets', () => {
      seedChangeset(db, 'cs-approved', 'approved');
      seedMutation(db, 'mut-approved', 'cs-approved');

      runStartupCleanup(db);

      // approved changeset is preserved, so its mutation should survive
      expect(countMutations(db)).toBe(1);
    });
  });

  // ── Scenario 4: pending_delete instances ─────────────────────────

  describe('scenario 4: pending_delete instances', () => {
    it('reverts pending_delete instance to running', () => {
      seedInstance(db, 'inst-pd', 'pending_delete');

      runStartupCleanup(db);

      expect(getInstance(db, 'inst-pd')!.status).toBe('running');
    });

    it('reverts multiple pending_delete instances', () => {
      seedInstance(db, 'inst-pd-1', 'pending_delete');
      seedInstance(db, 'inst-pd-2', 'pending_delete');

      runStartupCleanup(db);

      expect(getInstance(db, 'inst-pd-1')!.status).toBe('running');
      expect(getInstance(db, 'inst-pd-2')!.status).toBe('running');
    });

    it('does not affect running instances', () => {
      seedInstance(db, 'inst-running', 'running');

      runStartupCleanup(db);

      expect(getInstance(db, 'inst-running')!.status).toBe('running');
    });

    it('logs a warning when reverting pending_delete instances', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      seedInstance(db, 'inst-pd', 'pending_delete');

      runStartupCleanup(db);

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("'pending_delete' state — reverting to 'running'"),
      );
      warnSpy.mockRestore();
    });
  });

  // ── Scenario 5: pending instances ────────────────────────────────

  describe('scenario 5: pending instances (never deployed)', () => {
    it('deletes pending instances', () => {
      seedInstance(db, 'inst-pend', 'pending');

      runStartupCleanup(db);

      expect(getInstance(db, 'inst-pend')).toBeUndefined();
    });

    it('deletes multiple pending instances', () => {
      seedInstance(db, 'inst-p1', 'pending');
      seedInstance(db, 'inst-p2', 'pending');

      runStartupCleanup(db);

      expect(countInstances(db)).toBe(0);
    });

    it('does not delete stopped instances', () => {
      seedInstance(db, 'inst-stopped', 'stopped');

      runStartupCleanup(db);

      expect(getInstance(db, 'inst-stopped')).toBeDefined();
    });
  });

  // ── Scenario 6: Summary log ───────────────────────────────────────

  describe('scenario 6: startup recovery summary log', () => {
    it('logs the recovery summary', () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      seedChangeset(db, 'cs-applying', 'applying');
      seedChangeset(db, 'cs-draft', 'draft');
      seedMutation(db, 'mut-orphan', 'cs-nonexistent');

      runStartupCleanup(db);

      expect(logSpy).toHaveBeenCalledWith(
        '[startup] Recovery: 1 draft changeset preserved, 1 applying changeset marked failed, 1 orphaned mutation cleaned',
      );
      logSpy.mockRestore();
    });

    it('logs zeros when nothing needs recovery', () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      runStartupCleanup(db);

      expect(logSpy).toHaveBeenCalledWith(
        '[startup] Recovery: 0 draft changesets preserved, 0 applying changesets marked failed, 0 orphaned mutations cleaned',
      );
      logSpy.mockRestore();
    });

    it('uses plural forms correctly for multiple items', () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      seedChangeset(db, 'cs-applying-1', 'applying');
      seedChangeset(db, 'cs-applying-2', 'applying');
      seedChangeset(db, 'cs-draft-1', 'draft');
      seedChangeset(db, 'cs-draft-2', 'draft');
      seedMutation(db, 'mut-orphan-1', 'cs-nonexistent-1');
      seedMutation(db, 'mut-orphan-2', 'cs-nonexistent-2');

      runStartupCleanup(db);

      expect(logSpy).toHaveBeenCalledWith(
        '[startup] Recovery: 2 draft changesets preserved, 2 applying changesets marked failed, 2 orphaned mutations cleaned',
      );
      logSpy.mockRestore();
    });
  });

  // ── Scenario 7: Mixed scenario ────────────────────────────────────

  describe('scenario 7: mixed — all scenarios in one run', () => {
    it('handles all recovery scenarios correctly in a single call', () => {
      // applying changeset → should become failed
      seedChangeset(db, 'cs-applying', 'applying');
      seedMutation(db, 'mut-applying', 'cs-applying');

      // draft changeset + its mutations → should be PRESERVED
      seedChangeset(db, 'cs-draft', 'draft');
      seedMutation(db, 'mut-draft', 'cs-draft');

      // approved changeset + its mutations → should be PRESERVED
      seedChangeset(db, 'cs-approved', 'approved');
      seedMutation(db, 'mut-approved', 'cs-approved');

      // orphaned mutations (no changeset)
      seedMutation(db, 'mut-orphan-pending', 'pending');
      seedMutation(db, 'mut-orphan-unlinked', 'unlinked');
      seedMutation(db, 'mut-orphan-gone', 'cs-nonexistent');

      // pending_delete instance → should revert to running
      seedInstance(db, 'inst-pd', 'pending_delete');

      // pending instance → should be deleted
      seedInstance(db, 'inst-p', 'pending');

      // healthy running instance → must survive
      seedInstance(db, 'inst-ok', 'running');

      runStartupCleanup(db);

      // applying → failed, still exists
      const applying = getChangeset(db, 'cs-applying');
      expect(applying!.status).toBe('failed');
      expect(applying!.error).toBe('Interrupted by server restart');

      // draft and approved → preserved
      expect(getChangeset(db, 'cs-draft')!.status).toBe('draft');
      expect(getChangeset(db, 'cs-approved')!.status).toBe('approved');

      // mutations: applying(1) + draft(1) + approved(1) = 3 survive; 3 orphaned gone
      expect(countMutations(db)).toBe(3);

      // pending_delete → running
      expect(getInstance(db, 'inst-pd')!.status).toBe('running');

      // pending → gone
      expect(getInstance(db, 'inst-p')).toBeUndefined();

      // running instance untouched
      expect(getInstance(db, 'inst-ok')!.status).toBe('running');
    });
  });
});
