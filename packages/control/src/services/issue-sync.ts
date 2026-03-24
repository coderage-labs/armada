import { projectsRepo, settingsRepo, projectReposRepo } from '../repositories/index.js';
import { getDrizzle } from '../db/drizzle.js';
import { githubIssueCache, triagedIssues, issueDependencies } from '../db/drizzle-schema.js';
import { eq, sql, and } from 'drizzle-orm';
import { logActivity } from './activity-service.js';
import { eventBus } from '../infrastructure/event-bus.js';
import { projectIntegrationsRepo } from './integrations/project-integrations-repo.js';
import { integrationsRepo } from './integrations/integrations-repo.js';
import { getProvider } from './integrations/registry.js';
import type { GitHubIssue } from '@coderage-labs/armada-shared';
import type { AuthConfig, ExternalIssue } from './integrations/types.js';

const DEFAULT_SYNC_INTERVAL_MINUTES = 5;
const SCHEDULER_TICK_MS = 60_000; // Check every 60s which projects are due

// ── Per-project last sync tracking ──────────────────────────────────

const lastSyncAt = new Map<string, number>();

// ── DB-backed cache of issues per project ───────────────────────────

export function getCachedIssues(projectId: string): GitHubIssue[] {
  const rows = getDrizzle()
    .select().from(githubIssueCache)
    .where(eq(githubIssueCache.projectId, projectId))
    .orderBy(githubIssueCache.issueNumber)
    .all();
  return rows.map(r => ({
    number: r.issueNumber,
    title: r.title || '',
    body: r.body || '',
    url: r.htmlUrl || '',
    htmlUrl: r.htmlUrl || '',
    labels: r.labelsJson ? JSON.parse(r.labelsJson) : [],
    state: r.state || 'open',
    createdAt: r.createdAt || '',
    updatedAt: r.updatedAt || '',
    repo: r.repo,
  }));
}

/**
 * Resolve integration auth for a project.
 * Returns the first enabled integration with the specified provider (or any provider if not specified).
 * Falls back to GITHUB_TOKEN env var for GitHub provider.
 */
function resolveIntegrationAuth(projectId: string, provider?: string): { provider: string; authConfig: AuthConfig } | null {
  try {
    const projectIntegrations = projectIntegrationsRepo.getByProject(projectId);
    for (const pi of projectIntegrations) {
      if (!pi.enabled) continue;
      const integration = integrationsRepo.getById(pi.integrationId);
      if (!integration) continue;
      
      // Filter by provider if specified
      if (provider && integration.provider !== provider) continue;
      
      if (integration.authConfig) {
        return { provider: integration.provider, authConfig: integration.authConfig };
      }
    }
  } catch (err: any) {
    console.warn(`[issue-sync] Failed to resolve integration auth for project ${projectId}:`, err.message);
  }

  // Fallback to GITHUB_TOKEN env var for GitHub only
  if ((!provider || provider === 'github') && process.env.GITHUB_TOKEN) {
    return { provider: 'github', authConfig: { token: process.env.GITHUB_TOKEN } };
  }

  return null;
}

/**
 * Parse "blocked by" / "depends on" references from an issue body and
 * upsert them into the issue_dependencies table.
 *
 * Supported patterns:
 *   blocked by #123          → same repo
 *   depends on #123          → same repo
 *   blocked by owner/repo#123 → cross-repo
 */
export function parseDependencies(
  projectId: string,
  issueRepo: string,
  issueNumber: number,
  body: string,
): void {
  if (!body) return;

  const db = getDrizzle();
  const DEPENDENCY_RE = /(?:blocked by|depends on)\s+(?:([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+))?#(\d+)/gi;

  let match: RegExpExecArray | null;
  while ((match = DEPENDENCY_RE.exec(body)) !== null) {
    const blockedByRepo = match[1] ? match[1] : issueRepo;
    const blockedByIssueNumber = parseInt(match[2], 10);
    if (!blockedByRepo || !blockedByIssueNumber) continue;

    const id = `${projectId}:${issueRepo}:${issueNumber}:${blockedByRepo}:${blockedByIssueNumber}`;
    db.insert(issueDependencies).values({
      id,
      projectId,
      repo: issueRepo,
      issueNumber,
      blockedByRepo,
      blockedByIssueNumber,
      resolved: 0,
    }).onConflictDoUpdate({
      target: [issueDependencies.id],
      set: {
        // Keep resolved state — don't reset if already resolved
        repo: sql`excluded.repo`,
        issueNumber: sql`excluded.issue_number`,
        blockedByRepo: sql`excluded.blocked_by_repo`,
        blockedByIssueNumber: sql`excluded.blocked_by_issue_number`,
      },
    }).run();
  }
}

/**
 * Convert ExternalIssue (from adapter) to GitHubIssue (legacy format for cache).
 * Maps provider-specific issue keys to numbers for storage.
 */
function externalToGitHubIssue(external: ExternalIssue, repo: string, provider: string): GitHubIssue {
  // Extract issue number from externalId
  // GitHub: "123" → number 123
  // Jira: "PROJ-123" → hash to number for compatibility
  let issueNumber: number;
  if (provider === 'github') {
    issueNumber = parseInt(external.externalId, 10);
  } else {
    // For non-GitHub providers (Jira, etc.), hash the external ID to a number
    // This maintains the number field for DB compatibility while supporting keys
    issueNumber = hashStringToNumber(external.externalId);
  }

  return {
    number: issueNumber,
    title: external.title,
    body: external.description,
    url: external.url,
    htmlUrl: external.url,
    labels: external.labels,
    milestone: external.priority, // Map priority to milestone field
    state: external.status,
    createdAt: external.createdAt,
    updatedAt: external.updatedAt,
    repo,
  };
}

/**
 * Simple hash function to convert string keys (e.g., "PROJ-123") to numbers.
 * Used for non-GitHub providers that use string keys instead of numeric IDs.
 */
function hashStringToNumber(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash);
}

export async function syncProjectIssues(projectId: string): Promise<{ fetched: number }> {
  const project = projectsRepo.get(projectId);
  if (!project) throw new Error('Project not found');

  // Prefer project_repos table; fall back to config.repositories for backwards compat
  const linkedRepos = projectReposRepo.getByProject(projectId);
  const config = JSON.parse(project.configJson || '{}');
  const legacyRepos: Array<{ url: string }> = config.repositories || [];

  const allIssues: GitHubIssue[] = [];

  // Sync from linked repos (modern path — uses adapters)
  if (linkedRepos.length > 0) {
    for (const linkedRepo of linkedRepos) {
      const integration = integrationsRepo.getById(linkedRepo.integrationId);
      if (!integration) {
        console.warn(`[issue-sync] Integration not found for repo ${linkedRepo.fullName}`);
        continue;
      }

      const adapter = getProvider(integration.provider);
      if (!adapter?.fetchIssues) {
        console.warn(`[issue-sync] Provider ${integration.provider} does not support fetchIssues`);
        continue;
      }

      try {
        // Fetch issues for this repo
        const filters = {
          projects: [linkedRepo.fullName], // For GitHub: owner/repo, for Jira: project key
        };

        const { issues } = await adapter.fetchIssues(integration.authConfig, filters);

        // Convert to GitHubIssue format for cache
        for (const issue of issues) {
          const ghIssue = externalToGitHubIssue(issue, linkedRepo.fullName, integration.provider);
          allIssues.push(ghIssue);
        }
      } catch (err: any) {
        console.error(`[issue-sync] Failed to fetch issues from ${linkedRepo.fullName}:`, err.message);
      }
    }
  } else if (legacyRepos.length > 0) {
    // Legacy fallback: config.repositories + global GitHub token
    const auth = resolveIntegrationAuth(projectId, 'github');
    if (!auth) {
      console.warn(`[issue-sync] No GitHub integration or token available for project ${projectId}`);
      return { fetched: 0 };
    }

    const adapter = getProvider('github');
    if (!adapter?.fetchIssues) {
      console.error('[issue-sync] GitHub adapter not registered or does not support fetchIssues');
      return { fetched: 0 };
    }

    for (const repo of legacyRepos) {
      const match = repo.url.match(/(?:github\.com\/)?([^/]+\/[^/]+?)(?:\.git)?$/);
      if (!match) continue;
      const slug = match[1].replace(/^\//, '');
      const parts = slug.split('/');
      if (parts.length < 2) continue;

      try {
        const filters = { projects: [slug] };
        const { issues } = await adapter.fetchIssues(auth.authConfig, filters);

        for (const issue of issues) {
          const ghIssue = externalToGitHubIssue(issue, slug, 'github');
          allIssues.push(ghIssue);
        }
      } catch (err: any) {
        console.error(`[issue-sync] Failed to fetch issues from ${slug}:`, err.message);
      }
    }
  }

  // Store in DB cache (upsert)
  const now = new Date().toISOString();
  const db = getDrizzle();
  for (const issue of allIssues) {
    const id = `${projectId}:${issue.repo}:${issue.number}`;
    db.insert(githubIssueCache).values({
      id,
      projectId,
      repo: issue.repo || '',
      issueNumber: issue.number,
      title: issue.title,
      body: issue.body || '',
      htmlUrl: issue.htmlUrl || '',
      state: issue.state,
      labelsJson: JSON.stringify(issue.labels || []),
      assigneesJson: '[]',
      createdAt: issue.createdAt || '',
      updatedAt: issue.updatedAt || '',
      cachedAt: now,
    }).onConflictDoUpdate({
      target: [githubIssueCache.projectId, githubIssueCache.repo, githubIssueCache.issueNumber],
      set: {
        title: sql`excluded.title`,
        body: sql`excluded.body`,
        htmlUrl: sql`excluded.html_url`,
        state: sql`excluded.state`,
        labelsJson: sql`excluded.labels_json`,
        assigneesJson: sql`excluded.assignees_json`,
        updatedAt: sql`excluded.updated_at`,
        cachedAt: sql`excluded.cached_at`,
      },
    }).run();
  }

  // Parse and upsert issue dependencies from issue bodies
  for (const issue of allIssues) {
    parseDependencies(projectId, issue.repo || '', issue.number, issue.body || '');
  }

  // Mark cached issues NOT in the fresh response as closed (they were closed/deleted on the provider)
  const freshNumbers = new Set(allIssues.map(i => `${i.repo}:${i.number}`));
  const cached = db.select().from(githubIssueCache)
    .where(eq(githubIssueCache.projectId, projectId))
    .all();
  for (const row of cached) {
    const key = `${row.repo}:${row.issueNumber}`;
    if (!freshNumbers.has(key) && row.state === 'open') {
      db.update(githubIssueCache)
        .set({ state: 'closed', cachedAt: now })
        .where(eq(githubIssueCache.id, row.id))
        .run();
    }
  }

  return { fetched: allIssues.length };
}

// ── Sync interval resolution ────────────────────────────────────────

/**
 * Resolve sync interval for a specific project:
 * 1. Project config `issueSyncIntervalMinutes`
 * 2. Global setting `issue_sync_interval_minutes`
 * 3. Default (5 minutes)
 *
 * Returns milliseconds. Returns 0 if explicitly disabled.
 */
function resolveProjectIntervalMs(projectConfig: Record<string, any>): number {
  // Check project-level setting
  if (projectConfig.issueSyncIntervalMinutes !== undefined) {
    const minutes = Number(projectConfig.issueSyncIntervalMinutes);
    if (minutes === 0) return 0; // Explicitly disabled
    if (Number.isFinite(minutes) && minutes > 0) return minutes * 60 * 1000;
  }

  // Fall back to global setting
  try {
    const raw = settingsRepo.get('issue_sync_interval_minutes');
    if (raw) {
      const minutes = parseFloat(raw);
      if (Number.isFinite(minutes) && minutes > 0) return minutes * 60 * 1000;
    }
  } catch (err: any) {
    console.warn('[issue-sync] Failed to read global sync interval setting:', err.message);
  }

  return DEFAULT_SYNC_INTERVAL_MINUTES * 60 * 1000;
}

// ── Periodic sync scheduler ─────────────────────────────────────────

let syncInterval: ReturnType<typeof setInterval> | null = null;

export function startIssueSyncScheduler() {
  if (syncInterval) clearInterval(syncInterval);

  // Tick every 60s and check which projects are due for sync
  syncInterval = setInterval(async () => {
    const projects = projectsRepo.getAll();
    const now = Date.now();

    for (const project of projects) {
      const config = JSON.parse(project.configJson || '{}');
      const linkedReposCount = projectReposRepo.getByProject(project.id).length;
      if (linkedReposCount === 0 && (config.repositories || []).length === 0) continue;

      // Resolve per-project interval
      const intervalMs = resolveProjectIntervalMs(config);
      if (intervalMs === 0) continue; // Explicitly disabled

      // Check if project has any integration available
      const auth = resolveIntegrationAuth(project.id);
      if (!auth && linkedReposCount === 0) continue; // No auth for legacy repos

      // Check if due
      const last = lastSyncAt.get(project.id) || 0;
      if (now - last < intervalMs) continue;

      // Mark as synced now (before async work to prevent double-sync)
      lastSyncAt.set(project.id, now);

      try {
        const beforeSync = getCachedIssues(project.id);
        const beforeNumbers = new Set(beforeSync.map(i => i.number));

        const { fetched } = await syncProjectIssues(project.id);

        // After sync, check for brand-new untriaged open issues
        const afterSync = getCachedIssues(project.id);
        const newIssues = afterSync.filter(i => !beforeNumbers.has(i.number) && i.state === 'open');

        if (newIssues.length > 0) {
          const db = getDrizzle();
          const triagedRows = db
            .select({ issueNumber: triagedIssues.issueNumber })
            .from(triagedIssues)
            .where(eq(triagedIssues.projectId, project.id))
            .all();
          const triagedNumbers = new Set(triagedRows.map(r => r.issueNumber));
          const untriagedNew = newIssues
            .filter(i => !triagedNumbers.has(i.number))
            .map(i => i.number);

          if (untriagedNew.length > 0) {
            console.log(`[issue-sync] ${untriagedNew.length} new untriaged issue(s) for project "${project.name}":`, untriagedNew);
            eventBus.emit('github.new_issues', {
              projectId: project.id,
              projectName: project.name,
              issueNumbers: untriagedNew,
            });
          }
        }
      } catch (err: any) {
        console.error(`[issue-sync] Sync failed for ${project.name}:`, err.message);
        // Reset last sync so it retries next tick
        lastSyncAt.delete(project.id);
      }
    }
  }, SCHEDULER_TICK_MS);
}

export function stopIssueSyncScheduler() {
  if (syncInterval) {
    clearInterval(syncInterval);
    syncInterval = null;
  }
}
