import { projectsRepo, settingsRepo } from '../repositories/index.js';
import { getDrizzle } from '../db/drizzle.js';
import { githubIssueCache, triagedIssues } from '../db/drizzle-schema.js';
import { eq, sql, and } from 'drizzle-orm';
import { logActivity } from './activity-service.js';
import { eventBus } from '../infrastructure/event-bus.js';
import type { GitHubIssue } from '@coderage-labs/armada-shared';

const GITHUB_API = 'https://api.github.com';

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
    url: '',
    htmlUrl: '',
    labels: r.labelsJson ? JSON.parse(r.labelsJson) : [],
    state: r.state || 'open',
    createdAt: r.createdAt || '',
    updatedAt: r.updatedAt || '',
    repo: r.repo,
  }));
}

export async function syncProjectIssues(projectId: string): Promise<{ fetched: number }> {
  const project = projectsRepo.get(projectId);
  if (!project) throw new Error('Project not found');

  const config = JSON.parse(project.configJson || '{}');
  const repos: Array<{ url: string }> = config.repositories || [];
  const token = process.env.GITHUB_TOKEN || '';

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
        state: sql`excluded.state`,
        labelsJson: sql`excluded.labels_json`,
        assigneesJson: sql`excluded.assignees_json`,
        updatedAt: sql`excluded.updated_at`,
        cachedAt: sql`excluded.cached_at`,
      },
    }).run();
  }

  // Note: Routine sync no longer logs to activity feed to avoid noise (#261)

  return { fetched: allIssues.length };
}

// ── New-issue detection ─────────────────────────────────────────────

/**
 * Returns issue numbers that are present in `freshIssues` but have NOT yet
 * been triaged (i.e. absent from the `triaged_issues` table).
 */
function findUntriagedNew(projectId: string, freshIssues: GitHubIssue[]): number[] {
  const db = getDrizzle();
  const freshNumbers = freshIssues.map(i => i.number);
  if (freshNumbers.length === 0) return [];

  // Load all previously cached issue numbers for this project so we can spot
  // brand-new ones (present in fresh response but absent from cache).
  const cached = db
    .select({ issueNumber: githubIssueCache.issueNumber })
    .from(githubIssueCache)
    .where(eq(githubIssueCache.projectId, projectId))
    .all();
  const cachedNumbers = new Set(cached.map(r => r.issueNumber));

  // Brand-new = in fresh response but not yet in our cache
  const brandNewNumbers = freshNumbers.filter(n => !cachedNumbers.has(n));
  if (brandNewNumbers.length === 0) return [];

  // Of those, keep only ones that haven't been triaged yet
  const triaged = db
    .select({ issueNumber: triagedIssues.issueNumber })
    .from(triagedIssues)
    .where(eq(triagedIssues.projectId, projectId))
    .all();
  const triagedNumbers = new Set(triaged.map(r => r.issueNumber));

  return brandNewNumbers.filter(n => !triagedNumbers.has(n));
}

// ── Periodic sync scheduler ─────────────────────────────────────────

let syncInterval: ReturnType<typeof setInterval> | null = null;

/** Resolve interval from DB setting, falling back to the provided default. */
function resolveIntervalMs(defaultMs: number): number {
  try {
    const raw = settingsRepo.get('github_sync_interval_minutes');
    if (raw) {
      const minutes = parseFloat(raw);
      if (Number.isFinite(minutes) && minutes > 0) return minutes * 60 * 1000;
    }
  } catch (err: any) {
    console.warn('[github-sync] Failed to read sync interval setting:', err.message);
  }
  return defaultMs;
}

export function startGithubSyncScheduler(intervalMs: number = 15 * 60 * 1000) {
  if (syncInterval) clearInterval(syncInterval);

  const effectiveInterval = resolveIntervalMs(intervalMs);

  syncInterval = setInterval(async () => {
    const projects = projectsRepo.getAll();
    for (const project of projects) {
      const config = JSON.parse(project.configJson || '{}');
      if ((config.repositories || []).length === 0) continue;

      try {
        // Snapshot cached issue numbers BEFORE the sync so we can detect new ones
        const beforeSync = getCachedIssues(project.id);
        const beforeNumbers = new Set(beforeSync.map(i => i.number));

        const { fetched } = await syncProjectIssues(project.id);

        // After sync, check for brand-new untriaged issues
        const afterSync = getCachedIssues(project.id);
        const newIssues = afterSync.filter(i => !beforeNumbers.has(i.number));

        if (newIssues.length > 0) {
          // Filter to only those not yet triaged
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
            console.log(`[github-sync] ${untriagedNew.length} new untriaged issue(s) for project "${project.name}":`, untriagedNew);
            eventBus.emit('github.new_issues', {
              projectId: project.id,
              projectName: project.name,
              issueNumbers: untriagedNew,
            });
          }
        }
      } catch (err: any) {
        console.error(`GitHub sync failed for ${project.name}:`, err.message);
      }
    }
  }, effectiveInterval);
}

export function stopGithubSyncScheduler() {
  if (syncInterval) {
    clearInterval(syncInterval);
    syncInterval = null;
  }
}
