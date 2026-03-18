/**
 * Worktree Service — per-task Git worktree isolation for workflow steps.
 *
 * Creates isolated Git worktrees on the node (via WS command relay) so
 * parallel workflow steps operating on the same repo cannot conflict.
 *
 * Architecture:
 *   Control plane orchestrates (this service) → WS command → node agent
 *   → runs git commands on the node host (not inside Docker containers).
 *
 * Worktree lifecycle:
 *   1. createWorktree()  — before step dispatch (if step.isolateGit === true)
 *   2. mergeWorktree()   — after step completes successfully
 *   3. cleanupWorktree() — always (success or failure)
 */

import { getNodeClient } from '../infrastructure/node-client.js';

// ── Active worktree registry (in-memory) ───────────────────────────

export interface ActiveWorktree {
  stepId: string;
  runId: string;
  nodeId: string;
  repoPath: string;
  worktreePath: string;
  branch: string;
  createdAt: string;
}

const _activeWorktrees = new Map<string, ActiveWorktree>();

export function getActiveWorktrees(): ActiveWorktree[] {
  return Array.from(_activeWorktrees.values());
}

// ── Create a worktree on the node ───────────────────────────────────

export interface CreateWorktreeResult {
  worktreePath: string;
  branch: string;
}

/**
 * Creates a Git worktree at `<repoPath>/.armada-worktrees/<stepId>` with
 * branch `armada/<stepId>`, via WS command relay to the node.
 *
 * @param nodeId     Target node ID (where the repo lives)
 * @param repoPath   Absolute path to the git repo on the node
 * @param stepId     Workflow step ID — used to name the worktree/branch
 * @param runId      Workflow run ID — stored for tracking
 * @param baseBranch Branch to base the worktree on (default: main)
 */
export async function createWorktree(
  nodeId: string,
  repoPath: string,
  stepId: string,
  runId: string,
  baseBranch = 'main',
): Promise<CreateWorktreeResult> {
  const worktreePath = `${repoPath}/.armada-worktrees/${stepId}`;
  const branch = `armada/${stepId}`;

  const node = getNodeClient(nodeId);
  await (node as any).send('git.worktree.create', {
    repoPath,
    worktreePath,
    branch,
    baseBranch,
  }, 60_000);

  _activeWorktrees.set(stepId, {
    stepId,
    runId,
    nodeId,
    repoPath,
    worktreePath,
    branch,
    createdAt: new Date().toISOString(),
  });

  return { worktreePath, branch };
}

// ── Merge a worktree branch back to target ──────────────────────────

export interface MergeWorktreeResult {
  merged: boolean;
  conflicts?: string[];
}

/**
 * Merges the worktree branch back into `targetBranch` (default: main),
 * via WS command relay to the node.
 *
 * @param nodeId        Target node ID
 * @param worktreePath  Absolute path to the worktree on the node
 * @param targetBranch  Branch to merge into (default: main)
 */
export async function mergeWorktree(
  nodeId: string,
  worktreePath: string,
  targetBranch = 'main',
): Promise<MergeWorktreeResult> {
  const node = getNodeClient(nodeId);
  const result = await (node as any).send('git.worktree.merge', {
    worktreePath,
    targetBranch,
  }, 60_000) as { merged: boolean; conflicts?: string[] };

  return {
    merged: result.merged ?? false,
    conflicts: result.conflicts,
  };
}

// ── Cleanup a worktree ──────────────────────────────────────────────

/**
 * Removes the worktree and deletes its branch via WS command relay to the node.
 * Uses `git worktree remove --force` so it works even with uncommitted changes.
 *
 * @param nodeId       Target node ID
 * @param worktreePath Absolute path to the worktree on the node
 * @param stepId       Step ID — used to remove from the active registry
 */
export async function cleanupWorktree(
  nodeId: string,
  worktreePath: string,
  stepId: string,
): Promise<void> {
  const node = getNodeClient(nodeId);
  try {
    await (node as any).send('git.worktree.remove', {
      worktreePath,
    }, 60_000);
  } finally {
    // Always remove from registry even if the node command fails
    _activeWorktrees.delete(stepId);
  }
}
