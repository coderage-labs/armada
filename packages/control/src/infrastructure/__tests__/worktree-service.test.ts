/**
 * Unit tests for WorktreeService — per-task Git worktree isolation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the node client before importing worktree-service
vi.mock('../../infrastructure/node-client.js', () => ({
  getNodeClient: vi.fn(),
}));

import { getNodeClient } from '../../infrastructure/node-client.js';
import {
  createWorktree,
  mergeWorktree,
  cleanupWorktree,
  getActiveWorktrees,
} from '../../services/worktree-service.js';

// ── Helpers ─────────────────────────────────────────────────────────

function makeMockNode(overrides: Record<string, any> = {}) {
  return {
    send: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('WorktreeService', () => {
  let mockNode: ReturnType<typeof makeMockNode>;

  beforeEach(() => {
    mockNode = makeMockNode();
    vi.mocked(getNodeClient).mockReturnValue(mockNode as any);
  });

  describe('createWorktree', () => {
    it('sends git.worktree.create command via WS relay', async () => {
      const result = await createWorktree('node-1', '/repos/myapp', 'step-abc', 'run-123', 'main');

      expect(getNodeClient).toHaveBeenCalledWith('node-1');
      expect(mockNode.send).toHaveBeenCalledWith(
        'git.worktree.create',
        {
          repoPath: '/repos/myapp',
          worktreePath: '/repos/myapp/.armada-worktrees/step-abc',
          branch: 'armada/step-abc',
          baseBranch: 'main',
        },
        60_000,
      );

      expect(result.worktreePath).toBe('/repos/myapp/.armada-worktrees/step-abc');
      expect(result.branch).toBe('armada/step-abc');
    });

    it('registers worktree in active registry', async () => {
      await createWorktree('node-1', '/repos/myapp', 'step-reg', 'run-456', 'main');

      const active = getActiveWorktrees();
      const entry = active.find(w => w.stepId === 'step-reg');

      expect(entry).toBeDefined();
      expect(entry!.nodeId).toBe('node-1');
      expect(entry!.repoPath).toBe('/repos/myapp');
      expect(entry!.runId).toBe('run-456');
      expect(entry!.branch).toBe('armada/step-reg');
    });

    it('defaults baseBranch to main', async () => {
      await createWorktree('node-1', '/repos/myapp', 'step-def', 'run-789');

      expect(mockNode.send).toHaveBeenCalledWith(
        'git.worktree.create',
        expect.objectContaining({ baseBranch: 'main' }),
        60_000,
      );
    });
  });

  describe('mergeWorktree', () => {
    it('sends git.worktree.merge command via WS relay', async () => {
      mockNode.send = vi.fn().mockResolvedValue({ merged: true });

      const result = await mergeWorktree('node-1', '/repos/myapp/.armada-worktrees/step-abc', 'main');

      expect(mockNode.send).toHaveBeenCalledWith(
        'git.worktree.merge',
        {
          worktreePath: '/repos/myapp/.armada-worktrees/step-abc',
          targetBranch: 'main',
        },
        60_000,
      );

      expect(result.merged).toBe(true);
      expect(result.conflicts).toBeUndefined();
    });

    it('returns conflict info when merge fails', async () => {
      mockNode.send = vi.fn().mockResolvedValue({
        merged: false,
        conflicts: ['src/index.ts', 'src/app.ts'],
      });

      const result = await mergeWorktree('node-1', '/repos/myapp/.armada-worktrees/step-abc');

      expect(result.merged).toBe(false);
      expect(result.conflicts).toEqual(['src/index.ts', 'src/app.ts']);
    });

    it('defaults targetBranch to main', async () => {
      mockNode.send = vi.fn().mockResolvedValue({ merged: true });

      await mergeWorktree('node-1', '/some/worktree');

      expect(mockNode.send).toHaveBeenCalledWith(
        'git.worktree.merge',
        expect.objectContaining({ targetBranch: 'main' }),
        60_000,
      );
    });
  });

  describe('cleanupWorktree', () => {
    it('sends git.worktree.remove command via WS relay', async () => {
      // First create so it's in the registry
      await createWorktree('node-1', '/repos/myapp', 'step-cleanup', 'run-999');

      await cleanupWorktree('node-1', '/repos/myapp/.armada-worktrees/step-cleanup', 'step-cleanup');

      // Both createWorktree and cleanupWorktree call send
      const removeCalls = mockNode.send.mock.calls.filter(
        (c: any[]) => c[0] === 'git.worktree.remove',
      );
      expect(removeCalls).toHaveLength(1);
      expect(removeCalls[0][1]).toEqual({
        worktreePath: '/repos/myapp/.armada-worktrees/step-cleanup',
      });
    });

    it('removes worktree from active registry after cleanup', async () => {
      await createWorktree('node-1', '/repos/myapp', 'step-gone', 'run-001');

      // Confirm it's registered
      expect(getActiveWorktrees().some(w => w.stepId === 'step-gone')).toBe(true);

      await cleanupWorktree('node-1', '/repos/myapp/.armada-worktrees/step-gone', 'step-gone');

      // Should be removed from registry
      expect(getActiveWorktrees().some(w => w.stepId === 'step-gone')).toBe(false);
    });

    it('removes from registry even if node command fails', async () => {
      await createWorktree('node-1', '/repos/myapp', 'step-fail', 'run-002');

      // Make the remove command fail
      mockNode.send = vi.fn().mockRejectedValue(new Error('Node unreachable'));

      // Error should propagate but registry entry must still be removed
      await expect(
        cleanupWorktree('node-1', '/repos/myapp/.armada-worktrees/step-fail', 'step-fail'),
      ).rejects.toThrow('Node unreachable');

      // Should still be removed from registry despite the error
      expect(getActiveWorktrees().some(w => w.stepId === 'step-fail')).toBe(false);
    });
  });

  describe('getActiveWorktrees', () => {
    it('returns all currently active worktrees', async () => {
      await createWorktree('node-1', '/repo', 'step-a1', 'run-a');
      await createWorktree('node-1', '/repo', 'step-b1', 'run-b');

      const active = getActiveWorktrees();
      const stepIds = active.map(w => w.stepId);
      expect(stepIds).toContain('step-a1');
      expect(stepIds).toContain('step-b1');
    });
  });
});
