import type Database from 'better-sqlite3';

/**
 * Startup recovery — clean up state left over from the previous run.
 *
 * This function handles five scenarios:
 *
 *   1. APPLYING changesets: The server crashed or restarted mid-apply.
 *      We do NOT silently delete these — we mark them 'failed' so the
 *      operator can see what was interrupted and manually verify state.
 *
 *   2. DRAFT / APPROVED changesets: Uncommitted work from the previous
 *      session — the user was building or reviewing a plan that was never
 *      applied. These represent user intent and are preserved across
 *      restarts.
 *
 *   3. PENDING mutations: Orphaned mutations (changeset_id = 'pending' /
 *      'unlinked', or referencing a non-existent changeset) are cleaned up.
 *      Mutations tied to surviving changesets (draft, approved, failed, etc.)
 *      are left in place.
 *
 *   4. PENDING_DELETE instances: Their deletion changeset was wiped, so
 *      their container is still running. Revert to 'running' to avoid
 *      orphaning live containers.
 *
 *   5. PENDING instances: Were never deployed (no container was ever
 *      started). Safe to remove — orphan safety added in #455.
 */
export function runStartupCleanup(db: Database.Database): void {
  // Step 1: Mark mid-flight changesets as failed
  const failedCount = markInterruptedChangesetsAsFailed(db);

  // Step 2: Count preserved draft / approved changesets
  const preservedDraftCount = countPreservedDraftChangesets(db);

  // Step 3: Clean up orphaned pending mutations
  const orphanedCount = cleanupOrphanedMutations(db);

  // Step 4: Revert instances stuck in pending_delete
  revertPendingDeleteInstances(db);

  // Step 5: Delete instances stuck in pending (never deployed)
  db.exec("DELETE FROM instances WHERE status = 'pending'");

  // Reset stale avatar generation flags
  db.exec('UPDATE agents SET avatar_generating = 0 WHERE avatar_generating = 1');
  db.exec('UPDATE users SET avatar_generating = 0 WHERE avatar_generating = 1');

  // Summary
  console.log(
    `[startup] Recovery: ${preservedDraftCount} draft changeset${preservedDraftCount !== 1 ? 's' : ''} preserved, ` +
      `${failedCount} applying changeset${failedCount !== 1 ? 's' : ''} marked failed, ` +
      `${orphanedCount} orphaned mutation${orphanedCount !== 1 ? 's' : ''} cleaned`,
  );
}

function markInterruptedChangesetsAsFailed(db: Database.Database): number {
  const applying = db
    .prepare("SELECT id FROM changesets WHERE status = 'applying'")
    .all() as Array<{ id: string }>;

  if (applying.length === 0) return 0;

  const markFailed = db.prepare(`
    UPDATE changesets
    SET status = 'failed',
        error  = 'Interrupted by server restart'
    WHERE id = ?
  `);

  for (const { id } of applying) {
    markFailed.run(id);
    console.warn(
      `[startup] Found changeset ${id} in 'applying' state — marking as failed (interrupted by restart)`,
    );
  }

  return applying.length;
}

function countPreservedDraftChangesets(db: Database.Database): number {
  const { cnt } = db
    .prepare("SELECT COUNT(*) as cnt FROM changesets WHERE status IN ('draft', 'approved')")
    .get() as { cnt: number };
  return cnt;
}

function cleanupOrphanedMutations(db: Database.Database): number {
  const { cnt } = db
    .prepare(`
      SELECT COUNT(*) as cnt FROM pending_mutations
      WHERE changeset_id NOT IN (SELECT id FROM changesets)
         OR changeset_id IN ('pending', 'unlinked')
    `)
    .get() as { cnt: number };

  if (cnt === 0) return 0;

  db.exec(`
    DELETE FROM pending_mutations
    WHERE changeset_id NOT IN (SELECT id FROM changesets)
       OR changeset_id IN ('pending', 'unlinked')
  `);

  return cnt;
}

function revertPendingDeleteInstances(db: Database.Database): void {
  const { cnt } = db
    .prepare("SELECT COUNT(*) as cnt FROM instances WHERE status = 'pending_delete'")
    .get() as { cnt: number };

  if (cnt === 0) return;

  db.exec("UPDATE instances SET status = 'running' WHERE status = 'pending_delete'");
  console.warn(
    `[startup] Found ${cnt} instance${cnt !== 1 ? 's' : ''} in 'pending_delete' state — reverting to 'running' (container still live)`,
  );
}
