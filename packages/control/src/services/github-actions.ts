/**
 * GitHub Actions — higher-level helpers for performing issue lifecycle operations
 * on behalf of a project's configured GitHub integration.
 *
 * Uses the existing adapter + registry pattern (same as proxy.ts / integrations/).
 * Never touches GitHub's REST API directly — all calls go through the adapter.
 *
 * Used by:
 * - triage dismiss  (close issue + add wontfix label)
 * - workflow completion auto-close (comment + close + label)
 */

import { getProvider } from './integrations/registry.js';
import { integrationsRepo } from './integrations/integrations-repo.js';
import { projectIntegrationsRepo } from './integrations/project-integrations-repo.js';
import type { IntegrationProvider, AuthConfig } from './integrations/types.js';

// ── URL parser ─────────────────────────────────────────────────────────────────

export function parseGithubIssueUrl(url: string): { owner: string; repo: string; number: number } | null {
  const match = url.match(/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/);
  if (!match) return null;
  return { owner: match[1], repo: match[2], number: parseInt(match[3], 10) };
}

/** Convert owner/repo + number to the canonical issue key used by the adapter: owner/repo#number */
function toIssueKey(owner: string, repo: string, number: number): string {
  return `${owner}/${repo}#${number}`;
}

// ── Integration resolution ─────────────────────────────────────────────────────

interface ResolvedIntegration {
  provider: IntegrationProvider;
  authConfig: AuthConfig;
}

/**
 * Resolve the issues integration + adapter for a project.
 * Mirrors the `resolveIssueIntegration` helper in routes/proxy.ts.
 */
function resolveProjectIssueIntegration(projectId: string): ResolvedIntegration | null {
  const pis = projectIntegrationsRepo.getByProject(projectId);
  const issuePI = pis.find(pi => pi.capability === 'issues' && pi.enabled);
  if (!issuePI) return null;

  const integration = integrationsRepo.getById(issuePI.integrationId);
  if (!integration || integration.status !== 'active') return null;

  const provider = getProvider(integration.provider);
  if (!provider) return null;

  return { provider, authConfig: integration.authConfig };
}

// ── Public API helpers ─────────────────────────────────────────────────────────

/**
 * Post a comment on a GitHub issue via the project's integration.
 */
export async function addComment(
  projectId: string,
  owner: string,
  repo: string,
  issueNumber: number,
  body: string,
): Promise<void> {
  const resolved = resolveProjectIssueIntegration(projectId);
  if (!resolved) {
    console.warn(`[github-actions] No active issues integration for project ${projectId} — cannot add comment`);
    return;
  }

  if (!resolved.provider.addComment) {
    console.warn(`[github-actions] Provider does not support addComment`);
    return;
  }

  const issueKey = toIssueKey(owner, repo, issueNumber);
  await resolved.provider.addComment(resolved.authConfig, issueKey, body);
}

/**
 * Close a GitHub issue via the project's integration, optionally posting a comment first.
 */
export async function closeIssue(
  projectId: string,
  owner: string,
  repo: string,
  issueNumber: number,
  comment?: string,
): Promise<void> {
  const resolved = resolveProjectIssueIntegration(projectId);
  if (!resolved) {
    console.warn(`[github-actions] No active issues integration for project ${projectId} — cannot close issue`);
    return;
  }

  const issueKey = toIssueKey(owner, repo, issueNumber);

  // Post comment first if provided
  if (comment && resolved.provider.addComment) {
    try {
      await resolved.provider.addComment(resolved.authConfig, issueKey, comment);
    } catch (err: any) {
      console.warn(`[github-actions] Failed to post comment on ${issueKey}: ${err.message}`);
      // Don't throw — still attempt to close
    }
  }

  if (!resolved.provider.updateIssueStatus) {
    console.warn(`[github-actions] Provider does not support updateIssueStatus — cannot close issue`);
    return;
  }

  await resolved.provider.updateIssueStatus(resolved.authConfig, issueKey, 'closed');
}

/**
 * Add a label to a GitHub issue via the project's integration.
 */
export async function addLabel(
  projectId: string,
  owner: string,
  repo: string,
  issueNumber: number,
  label: string,
): Promise<void> {
  const resolved = resolveProjectIssueIntegration(projectId);
  if (!resolved) {
    console.warn(`[github-actions] No active issues integration for project ${projectId} — cannot add label`);
    return;
  }

  if (!resolved.provider.addIssueLabel) {
    console.warn(`[github-actions] Provider does not support addIssueLabel`);
    return;
  }

  const issueKey = toIssueKey(owner, repo, issueNumber);
  await resolved.provider.addIssueLabel(resolved.authConfig, issueKey, label);
}
