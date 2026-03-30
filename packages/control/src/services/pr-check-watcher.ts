// ── PR Check Watcher Service ───────────────────────────────────────
//
// Watches GitHub Actions checks on merged PRs and triggers workflow
// rework when CI fails.

import type { PRChecks } from './integrations/types.js';
import { projectIntegrationsRepo } from './integrations/project-integrations-repo.js';
import { integrationsRepo } from './integrations/integrations-repo.js';
import { getProvider } from './integrations/registry.js';

export interface PRCheckStatus {
  prNumber: number;
  repo: string;
  status: 'pending' | 'success' | 'failure' | 'error';
  checks: Array<{ name: string; status: string; conclusion: string }>;
}

interface WatchedPR {
  runId: string;
  repo: string;
  prNumber: number;
  projectId: string;
  startedAt: number;
  lastChecked?: number;
}

// In-memory store (could be persisted to DB later)
const watchedPRs = new Map<string, WatchedPR>();
const MAX_WATCH_TIME_MS = 10 * 60 * 1000; // 10 minutes
const POLL_INTERVAL_MS = 30 * 1000; // 30 seconds

/**
 * Start watching a PR's CI checks after merge.
 */
export function watchPR(
  runId: string,
  repo: string,
  prNumber: number,
  projectId: string,
): void {
  watchedPRs.set(runId, {
    runId,
    repo,
    prNumber,
    projectId,
    startedAt: Date.now(),
  });

  console.log(`[pr-check-watcher] Started watching ${repo}#${prNumber} (run ${runId})`);
}

/**
 * Stop watching a PR.
 */
export function unwatchPR(runId: string): void {
  const removed = watchedPRs.delete(runId);
  if (removed) {
    console.log(`[pr-check-watcher] Stopped watching run ${runId}`);
  }
}

/**
 * Check all watched PRs and update their status.
 * Should be called periodically (e.g., every 30s).
 */
export async function pollWatchedPRs(): Promise<void> {
  const now = Date.now();
  const toRemove: string[] = [];

  for (const [runId, watched] of watchedPRs.entries()) {
    // Stop watching if max time exceeded
    if (now - watched.startedAt > MAX_WATCH_TIME_MS) {
      console.log(
        `[pr-check-watcher] Watch timeout for ${watched.repo}#${watched.prNumber} (run ${runId})`,
      );
      toRemove.push(runId);
      continue;
    }

    // Skip if checked too recently
    if (watched.lastChecked && now - watched.lastChecked < POLL_INTERVAL_MS) {
      continue;
    }

    try {
      const status = await checkPRStatus(watched.repo, watched.prNumber, watched.projectId);
      watched.lastChecked = now;

      if (status.status === 'success') {
        console.log(
          `[pr-check-watcher] CI passed for ${watched.repo}#${watched.prNumber} (run ${runId})`,
        );
        toRemove.push(runId);
        // TODO: Mark workflow step as complete
      } else if (status.status === 'failure' || status.status === 'error') {
        console.error(
          `[pr-check-watcher] CI failed for ${watched.repo}#${watched.prNumber} (run ${runId})`,
        );
        toRemove.push(runId);
        // TODO: Trigger workflow rework (create a new workflow run or update existing)
        // For now, just log the failure
      }
    } catch (err: any) {
      console.error(
        `[pr-check-watcher] Error checking ${watched.repo}#${watched.prNumber}:`,
        err.message,
      );
      // Continue watching on error
    }
  }

  // Remove completed/timed-out watches
  for (const runId of toRemove) {
    watchedPRs.delete(runId);
  }
}

/**
 * Check the CI status of a specific PR.
 * Returns aggregated check status.
 */
export async function checkPRStatus(
  repo: string,
  prNumber: number,
  projectId: string,
): Promise<PRCheckStatus> {
  // Get the GitHub integration from the project
  const projectIntegrations = projectIntegrationsRepo.getByProject(projectId);
  const githubProjectIntegration = projectIntegrations.find(
    pi => pi.capability === 'vcs' && pi.enabled,
  );

  if (!githubProjectIntegration) {
    throw new Error(`No VCS integration found for project ${projectId}`);
  }

  const integration = integrationsRepo.getById(githubProjectIntegration.integrationId);
  if (!integration) {
    throw new Error(`Integration ${githubProjectIntegration.integrationId} not found`);
  }

  if (integration.provider !== 'github') {
    throw new Error(`Integration ${integration.name} is not a GitHub provider`);
  }

  const adapter = getProvider('github');
  if (!adapter || !adapter.getPRChecks) {
    throw new Error('GitHub adapter does not support getPRChecks');
  }

  const result: PRChecks = await adapter.getPRChecks(integration.authConfig, repo, prNumber);

  let status: 'pending' | 'success' | 'failure' | 'error';
  if (result.pending) {
    status = 'pending';
  } else if (result.anyFailed) {
    status = 'failure';
  } else if (result.allPassed) {
    status = 'success';
  } else {
    // No checks or undetermined state
    status = 'error';
  }

  return {
    prNumber,
    repo,
    status,
    checks: result.checks.map(c => ({
      name: c.name,
      status: c.status,
      conclusion: c.conclusion || '',
    })),
  };
}

/**
 * Get the list of currently watched PRs.
 */
export function getWatchedPRs(): Array<{
  runId: string;
  repo: string;
  prNumber: number;
  projectId: string;
  startedAt: number;
  lastChecked?: number;
}> {
  return Array.from(watchedPRs.values());
}
