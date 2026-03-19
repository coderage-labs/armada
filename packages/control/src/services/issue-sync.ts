import { projectsRepo, settingsRepo } from '../repositories/index.js';
import { getDrizzle } from '../db/drizzle.js';
import { githubIssueCache, triagedIssues } from '../db/drizzle-schema.js';
import { eq, sql, and } from 'drizzle-orm';
import { logActivity } from './activity-service.js';
import { eventBus } from '../infrastructure/event-bus.js';
import { projectIntegrationsRepo } from './integrations/project-integrations-repo.js';
import { integrationsRepo } from './integrations/integrations-repo.js';
import type { GitHubIssue } from '@coderage-labs/armada-shared';

const GITHUB_API = 'https://api.github.com';
const DEFAULT_SYNC_INTERVAL_MINUTES = 5;
const SCHEDULER_TICK_MS = 60_000; // Check every 60s which projects are due

// ── Per-project last sync tracking ──────────────────────────────────

const lastSyncAt = new Map<string, number>();

// ── DB-backed cache of GitHub issues per project ────────────────────

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
 * Resolve the GitHub token for a project:
 * 1. Check for a GitHub integration attached to the project
 * 2. Fall back to GITHUB_TOKEN env var
 */
function resolveGitHubToken(projectId: string): string {
  try {
    const projectIntegrations = projectIntegrationsRepo.getByProject(projectId);
    for (const pi of projectIntegrations) {
      if (!pi.enabled) continue;
      const integration = integrationsRepo.getById(pi.integrationId);
      if (integration && integration.provider === 'github' && integration.authConfig?.token) {
        return integration.authConfig.token as string;
      }
    }
  } catch (err: any) {
    console.warn(`[issue-sync] Failed to resolve integration token for project ${projectId}:`, err.message);
  }
  return process.env.GITHUB_TOKEN || '';
}

export async function syncProjectIssues(projectId: string): Promise<{ fetched: number }> {
  const project = projectsRepo.get(projectId);
  if (!project) throw new Error('Project not found');

  const config = JSON.parse(project.configJson || '{}');
  const repos: Array<{ url: string }> = config.repositories || [];
  const token = resolveGitHubToken(projectId);

  const allIssues: GitHubIssue[] = [];

  for (const repo of repos) {
    // Parse owner/repo from url
    const match = repo.url.match(/(?:github\.com\/)?([^/]+\/[^/]+?)(?:\.git)?$/);
    if (!match) continue;
    const slug = match[1].replace(/^\//, '');
    const parts = slug.split('/');
    if (parts.length < 2) continue;
    const owner = parts[0];
    const repoName = parts[1];
    const repoSlug = `${owner}/${repoName}`;

    // Fetch open issues (not PRs)
    const resp = await fetch(
      `${GITHUB_API}/repos/${owner}/${repoName}/issues?state=open&per_page=100&sort=updated`,
      {
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          Accept: 'application/vnd.github.v3+json',
        },
        signal: AbortSignal.timeout(30_000),
      },
    );

    if (!resp.ok) continue;
    const issues = (await resp.json()) as Array<Record<string, any>>;

    for (const issue of issues) {
      // Skip PRs (GitHub API returns PRs as issues too)
      if (issue.pull_request) continue;

      allIssues.push({
        number: issue.number as number,
        title: issue.title as string,
        body: (issue.body as string) || '',
        url: issue.html_url as string,
        htmlUrl: issue.html_url as string,
        labels: (issue.labels as Array<{ name: string }> || []).map(l => l.name),
        milestone: (issue.milestone as { title: string } | null)?.title,
        state: issue.state as string,
        createdAt: issue.created_at as string,
        updatedAt: issue.updated_at as string,
        repo: repoSlug,
      });
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

  // Mark cached issues NOT in the fresh response as closed (they were closed/deleted on GitHub)
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
      if ((config.repositories || []).length === 0) continue;

      // Resolve per-project interval
      const intervalMs = resolveProjectIntervalMs(config);
      if (intervalMs === 0) continue; // Explicitly disabled

      // Check if project has a GitHub token available
      const token = resolveGitHubToken(project.id);
      if (!token) continue; // No token, skip

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
