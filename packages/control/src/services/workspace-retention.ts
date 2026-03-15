/**
 * workspace-retention.ts
 *
 * Periodically cleans up workspace directories for deleted agents on nodes.
 * Agents that have been deleted for more than N days (configurable) will have
 * their workspace directory removed via the WS node client.
 *
 * Stopped agents are NOT targeted — they are just paused, not deleted.
 * Only agents tracked in the `deleted_agents` table are eligible for cleanup.
 *
 * #299 — Fix workspace retention to target deleted agents
 * #167 — Workspace Retention Policy
 */

import { deletedAgentRepo } from '../repositories/index.js';
import { settingsRepo } from '../repositories/settings-repo.js';
import { commandDispatcher } from '../ws/command-dispatcher.js';
import { nodeConnectionManager } from '../ws/node-connections.js';
import { logActivity } from './activity-service.js';

const DEFAULT_RETENTION_DAYS = 30;
/** How long to wait between retention checks (24 hours) */
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

let retentionTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Returns the configured retention period in days.
 */
function getRetentionDays(): number {
  const raw = settingsRepo.get('workspace_retention_days');
  if (!raw) return DEFAULT_RETENTION_DAYS;
  const parsed = parseInt(raw, 10);
  return isNaN(parsed) || parsed < 1 ? DEFAULT_RETENTION_DAYS : parsed;
}

export interface RetentionResult {
  dryRun: boolean;
  retentionDays: number;
  candidates: Array<{
    agentName: string;
    instanceId: string;
    nodeId: string;
    workspacePath: string;
    deletedAt: string;
    removed: boolean;
    error?: string;
  }>;
  removed: number;
  skipped: number;
  errors: number;
}

/**
 * Find and optionally remove workspace directories for deleted agents.
 *
 * Only agents tracked in `deleted_agents` (i.e. intentionally destroyed)
 * are targeted — stopped agents are not touched.
 *
 * @param dryRun  When true, only report what would be removed (default: true)
 * @param days    Override retention period (defaults to configured value)
 */
async function cleanStaleWorkspaces(
  dryRun = true,
  days?: number,
): Promise<RetentionResult> {
  const retentionDays = days ?? getRetentionDays();

  const result: RetentionResult = {
    dryRun,
    retentionDays,
    candidates: [],
    removed: 0,
    skipped: 0,
    errors: 0,
  };

  // Find deleted agents whose workspace hasn't been cleaned yet and whose
  // deletion is older than the retention cutoff.
  const staleDeleted = deletedAgentRepo.getStaleWorkspaces(retentionDays);

  if (staleDeleted.length === 0) {
    return result;
  }

  for (const deleted of staleDeleted) {
    const workspacePath = `workspace/agents/${deleted.name}`;
    const candidate = {
      agentName: deleted.name,
      instanceId: deleted.instanceId,
      nodeId: deleted.nodeId,
      workspacePath,
      deletedAt: deleted.deletedAt,
      removed: false,
      error: undefined as string | undefined,
    };

    result.candidates.push(candidate);

    if (dryRun) {
      result.skipped++;
      continue;
    }

    // Only attempt removal if the node is connected
    if (!nodeConnectionManager.isOnline(deleted.nodeId)) {
      candidate.error = `Node ${deleted.nodeId} is not connected`;
      result.errors++;
      continue;
    }

    try {
      await commandDispatcher.send(deleted.nodeId, 'file.delete', {
        instance: deleted.instanceId,
        path: workspacePath,
        recursive: true,
      }, 30_000);

      candidate.removed = true;
      result.removed++;

      // Mark workspace as deleted so we don't attempt it again
      deletedAgentRepo.markWorkspaceDeleted(deleted.id);

      logActivity({
        eventType: 'workspace.cleaned',
        detail: `Removed workspace for deleted agent "${deleted.name}" (deleted: ${deleted.deletedAt})`,
      });
    } catch (err: any) {
      candidate.error = err.message || 'Unknown error';
      result.errors++;
    }
  }

  if (!dryRun && result.removed > 0) {
    logActivity({
      eventType: 'workspace.retention_run',
      detail: `Workspace retention: removed ${result.removed} deleted agent workspace(s) (retention: ${retentionDays}d)`,
    });
  }

  return result;
}

/**
 * Start the periodic workspace retention check (daily).
 */
export function startWorkspaceRetention(): void {
  if (retentionTimer) return;
  console.log(`🧹 Workspace retention monitor started (daily, default ${DEFAULT_RETENTION_DAYS}d)`);
  // Run a non-destructive dry-run on startup just to log candidates
  cleanStaleWorkspaces(true).then((r) => {
    if (r.candidates.length > 0) {
      console.log(`🧹 Workspace retention: ${r.candidates.length} deleted agent workspace(s) pending cleanup (dry-run)`);
    }
  }).catch(() => { /* non-critical */ });

  retentionTimer = setInterval(() => {
    cleanStaleWorkspaces(false).then((r) => {
      console.log(`🧹 Workspace retention run: removed=${r.removed} errors=${r.errors} (${r.retentionDays}d policy)`);
    }).catch((err) => {
      console.error('🧹 Workspace retention error:', err.message);
    });
  }, CHECK_INTERVAL_MS);
}

/**
 * Stop the periodic workspace retention check.
 */
export function stopWorkspaceRetention(): void {
  if (retentionTimer) {
    clearInterval(retentionTimer);
    retentionTimer = null;
    console.log('🧹 Workspace retention monitor stopped');
  }
}
