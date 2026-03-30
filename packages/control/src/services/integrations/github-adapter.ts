// ── GitHub Integration Provider Adapter ────────────────────────────

import type {
  AuthConfig,
  IntegrationProvider,
  ExternalProject,
  ExternalIssue,
  IssueFilters,
  ExternalRepo,
  CreatePROptions,
  ExternalPR,
  PRFilters,
  PRReview,
  PRComment,
  PRChecks,
  PRCheckRun,
} from './types.js';

const DEFAULT_GITHUB_API = 'https://api.github.com';

function mapPR(pr: any, repoFullName: string): ExternalPR {
  return {
    number: pr.number,
    title: pr.title,
    body: pr.body || '',
    url: pr.html_url,
    status: pr.merged ? 'merged' : pr.state,
    draft: pr.draft || false,
    repo: repoFullName,
    head: pr.head?.ref || '',
    base: pr.base?.ref || '',
    author: pr.user?.login || '',
    assignees: (pr.assignees || []).map((a: any) => a.login),
    labels: (pr.labels || []).map((l: any) => l.name),
    reviewDecision: undefined,
    reviews: [],
    additions: pr.additions ?? 0,
    deletions: pr.deletions ?? 0,
    changedFiles: pr.changed_files ?? 0,
    mergeable: pr.mergeable ?? null,
    createdAt: pr.created_at,
    updatedAt: pr.updated_at,
    mergedAt: pr.merged_at || undefined,
    mergedBy: pr.merged_by?.login || undefined,
  };
}

function mapReview(r: any): PRReview {
  return {
    author: r.user?.login || '',
    state: r.state,
    body: r.body || '',
    submittedAt: r.submitted_at || '',
  };
}

function mapComment(c: any): PRComment {
  return {
    id: c.id,
    author: c.user?.login || '',
    body: c.body || '',
    path: c.path || undefined,
    line: c.line || c.original_line || undefined,
    createdAt: c.created_at,
    updatedAt: c.updated_at,
  };
}

function parseRepo(repoFullName: string): [string, string] {
  const parts = repoFullName.split('/');
  if (parts.length !== 2) throw new Error(`Invalid repo format: ${repoFullName}`);
  return [parts[0], parts[1]];
}

export class GitHubAdapter implements IntegrationProvider {
  readonly name = 'github';
  private getBaseUrl(auth: AuthConfig): string {
    return auth.url || DEFAULT_GITHUB_API;
  }

  private getHeaders(auth: AuthConfig): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github.v3+json',
    };
    if (auth.token) {
      headers.Authorization = `Bearer ${auth.token}`;
    }
    return headers;
  }

  private async fetchGitHub<T = any>(
    auth: AuthConfig,
    path: string,
    options?: RequestInit,
  ): Promise<T> {
    const baseUrl = this.getBaseUrl(auth);
    const url = `${baseUrl}${path}`;
    const headers = this.getHeaders(auth);

    const resp = await fetch(url, {
      ...options,
      headers: { ...headers, ...options?.headers },
      signal: AbortSignal.timeout(30_000),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`GitHub API error (${resp.status}): ${text}`);
    }

    return resp.json();
  }

  async testConnection(auth: AuthConfig): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.fetchGitHub(auth, '/user');
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }

  async listProjects(auth: AuthConfig): Promise<ExternalProject[]> {
    try {
      const orgs = await this.fetchGitHub<Array<{ login: string; id: number; url: string }>>(
        auth,
        '/user/orgs',
      );

      const projects: ExternalProject[] = orgs.map(org => ({
        id: org.login,
        name: org.login,
        key: org.login,
      }));

      const user = await this.fetchGitHub<{ login: string; id: number }>(auth, '/user');
      projects.unshift({
        id: user.login,
        name: `${user.login} (Personal)`,
        key: user.login,
      });

      return projects;
    } catch (err: any) {
      console.error('GitHub listProjects error:', err.message);
      return [];
    }
  }

  async fetchIssues(
    auth: AuthConfig,
    filters: IssueFilters,
    cursor?: string,
  ): Promise<{ issues: ExternalIssue[]; cursor?: string }> {
    const issues: ExternalIssue[] = [];
    const page = cursor ? parseInt(cursor, 10) : 1;

    const repos = filters.projects || [];

    if (repos.length === 0) {
      return { issues: [], cursor: undefined };
    }

    for (const repoFullName of repos) {
      const parts = repoFullName.split('/');
      if (parts.length !== 2) continue;

      const [owner, repo] = parts;

      const params = new URLSearchParams({
        state: 'open',
        per_page: '100',
        page: page.toString(),
        sort: 'updated',
      });

      if (filters.labels && filters.labels.length > 0) {
        params.set('labels', filters.labels.join(','));
      }

      if (filters.assignees && filters.assignees.length > 0) {
        params.set('assignee', filters.assignees[0]);
      }

      try {
        const data = await this.fetchGitHub<Array<Record<string, any>>>(
          auth,
          `/repos/${owner}/${repo}/issues?${params.toString()}`,
        );

        for (const issue of data) {
          if (issue.pull_request) continue;

          issues.push({
            externalId: issue.number.toString(),
            title: issue.title as string,
            description: (issue.body as string) || '',
            status: issue.state as string,
            assignee: (issue.assignee as { login: string } | null)?.login,
            labels: (issue.labels as Array<{ name: string }> || []).map(l => l.name),
            url: issue.html_url as string,
            createdAt: issue.created_at as string,
            updatedAt: issue.updated_at as string,
          });
        }
      } catch (err: any) {
        console.error(`GitHub fetchIssues error for ${repoFullName}:`, err.message);
      }
    }

    const nextCursor = issues.length >= 100 ? (page + 1).toString() : undefined;

    return { issues, cursor: nextCursor };
  }

  async getIssue(auth: AuthConfig, issueKey: string): Promise<ExternalIssue> {
    const match = issueKey.match(/^([^/]+)\/([^#]+)#(\d+)$/);
    if (!match) {
      throw new Error(`Invalid GitHub issue key format: ${issueKey}`);
    }

    const [, owner, repo, number] = match;

    const issue = await this.fetchGitHub<Record<string, any>>(
      auth,
      `/repos/${owner}/${repo}/issues/${number}`,
    );

    return {
      externalId: issue.number.toString(),
      title: issue.title as string,
      description: (issue.body as string) || '',
      status: issue.state as string,
      assignee: (issue.assignee as { login: string } | null)?.login,
      labels: (issue.labels as Array<{ name: string }> || []).map(l => l.name),
      url: issue.html_url as string,
      createdAt: issue.created_at as string,
      updatedAt: issue.updated_at as string,
    };
  }

  async addComment(auth: AuthConfig, issueKey: string, comment: string): Promise<void> {
    const match = issueKey.match(/^([^/]+)\/([^#]+)#(\d+)$/);
    if (!match) {
      throw new Error(`Invalid GitHub issue key format: ${issueKey}`);
    }

    const [, owner, repo, number] = match;

    await this.fetchGitHub(auth, `/repos/${owner}/${repo}/issues/${number}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body: comment }),
      headers: { 'Content-Type': 'application/json' },
    });
  }

  async updateIssueStatus(auth: AuthConfig, issueKey: string, status: string): Promise<void> {
    const match = issueKey.match(/^([^/]+)\/([^#]+)#(\d+)$/);
    if (!match) {
      throw new Error(`Invalid GitHub issue key format: ${issueKey}`);
    }

    const [, owner, repo, number] = match;

    // GitHub only supports 'open' and 'closed'
    const state = status === 'closed' ? 'closed' : 'open';

    await this.fetchGitHub(auth, `/repos/${owner}/${repo}/issues/${number}`, {
      method: 'PATCH',
      body: JSON.stringify({ state }),
      headers: { 'Content-Type': 'application/json' },
    });
  }

  async addIssueLabel(auth: AuthConfig, issueKey: string, label: string): Promise<void> {
    const match = issueKey.match(/^([^/]+)\/([^#]+)#(\d+)$/);
    if (!match) {
      throw new Error(`Invalid GitHub issue key format: ${issueKey}`);
    }

    const [, owner, repo, number] = match;

    // Ensure label exists — create it if not (422 = already exists, safe to ignore)
    try {
      await this.fetchGitHub(auth, `/repos/${owner}/${repo}/labels`, {
        method: 'POST',
        body: JSON.stringify({ name: label, color: '0075ca' }),
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (err: any) {
      // "already_exists" from GitHub returns 422 — our fetchGitHub throws on !resp.ok
      if (!err.message?.includes('422')) {
        console.warn(`[github-adapter] Could not ensure label "${label}" exists: ${err.message}`);
      }
    }

    await this.fetchGitHub(auth, `/repos/${owner}/${repo}/issues/${number}/labels`, {
      method: 'POST',
      body: JSON.stringify({ labels: [label] }),
      headers: { 'Content-Type': 'application/json' },
    });
  }

  async listRepos(auth: AuthConfig): Promise<ExternalRepo[]> {
    try {
      const data = await this.fetchGitHub<Array<Record<string, any>>>(
        auth,
        '/user/repos?per_page=100&sort=updated',
      );

      return data.map(repo => ({
        fullName: repo.full_name as string,
        name: repo.name as string,
        url: repo.html_url as string,
        defaultBranch: repo.default_branch as string,
        isPrivate: repo.private as boolean,
      }));
    } catch (err: any) {
      console.error('GitHub listRepos error:', err.message);
      return [];
    }
  }

  // ── PR Methods ──────────────────────────────────────────────────────

  async createPR(auth: AuthConfig, opts: CreatePROptions): Promise<ExternalPR> {
    const [owner, repo] = parseRepo(opts.repo);

    const pr = await this.fetchGitHub<Record<string, any>>(
      auth,
      `/repos/${owner}/${repo}/pulls`,
      {
        method: 'POST',
        body: JSON.stringify({
          title: opts.title,
          body: opts.body,
          head: opts.head,
          base: opts.base,
          draft: opts.draft || false,
        }),
        headers: { 'Content-Type': 'application/json' },
      },
    );

    // Add labels if provided
    if (opts.labels && opts.labels.length > 0) {
      try {
        await this.fetchGitHub(
          auth,
          `/repos/${owner}/${repo}/issues/${pr.number}/labels`,
          {
            method: 'POST',
            body: JSON.stringify({ labels: opts.labels }),
            headers: { 'Content-Type': 'application/json' },
          },
        );
        // Re-fetch to get labels in the response
        const updated = await this.fetchGitHub<Record<string, any>>(
          auth,
          `/repos/${owner}/${repo}/pulls/${pr.number}`,
        );
        return mapPR(updated, opts.repo);
      } catch (err: any) {
        console.error(`GitHub createPR: failed to add labels: ${err.message}`);
      }
    }

    return mapPR(pr, opts.repo);
  }

  async listPRs(
    auth: AuthConfig,
    repoFullName: string,
    filters?: PRFilters,
  ): Promise<{ prs: ExternalPR[]; cursor?: string }> {
    const [owner, repo] = parseRepo(repoFullName);
    const page = filters?.cursor ? parseInt(filters.cursor, 10) : 1;

    const params = new URLSearchParams({
      state: filters?.state || 'open',
      per_page: '30',
      page: page.toString(),
      sort: 'updated',
      direction: 'desc',
    });

    const data = await this.fetchGitHub<Array<Record<string, any>>>(
      auth,
      `/repos/${owner}/${repo}/pulls?${params.toString()}`,
    );

    let prs = data.map(pr => mapPR(pr, repoFullName));

    // Client-side filter by author if specified
    if (filters?.author) {
      prs = prs.filter(pr => pr.author === filters.author);
    }

    // Client-side filter by labels if specified
    if (filters?.labels && filters.labels.length > 0) {
      const filterLabels = new Set(filters.labels);
      prs = prs.filter(pr => pr.labels.some(l => filterLabels.has(l)));
    }

    const nextCursor = data.length >= 30 ? (page + 1).toString() : undefined;
    return { prs, cursor: nextCursor };
  }

  async getPR(auth: AuthConfig, repoFullName: string, prNumber: number): Promise<ExternalPR> {
    const [owner, repo] = parseRepo(repoFullName);

    const pr = await this.fetchGitHub<Record<string, any>>(
      auth,
      `/repos/${owner}/${repo}/pulls/${prNumber}`,
    );

    const mapped = mapPR(pr, repoFullName);

    // Fetch reviews for the PR
    try {
      const reviews = await this.fetchGitHub<Array<Record<string, any>>>(
        auth,
        `/repos/${owner}/${repo}/pulls/${prNumber}/reviews`,
      );
      mapped.reviews = reviews.map(mapReview);
    } catch (err: any) {
      console.warn('[github-adapter] Failed to fetch PR reviews:', err.message);
    }

    return mapped;
  }

  async getPRReviews(
    auth: AuthConfig,
    repoFullName: string,
    prNumber: number,
  ): Promise<{ reviews: PRReview[]; comments: PRComment[] }> {
    const [owner, repo] = parseRepo(repoFullName);

    const [reviewsData, commentsData] = await Promise.all([
      this.fetchGitHub<Array<Record<string, any>>>(
        auth,
        `/repos/${owner}/${repo}/pulls/${prNumber}/reviews`,
      ),
      this.fetchGitHub<Array<Record<string, any>>>(
        auth,
        `/repos/${owner}/${repo}/pulls/${prNumber}/comments`,
      ),
    ]);

    return {
      reviews: reviewsData.map(mapReview),
      comments: commentsData.map(mapComment),
    };
  }

  async addPRComment(
    auth: AuthConfig,
    repoFullName: string,
    prNumber: number,
    comment: string,
    path?: string,
    line?: number,
  ): Promise<void> {
    const [owner, repo] = parseRepo(repoFullName);

    if (path && line) {
      // Inline review comment — needs commit_id from PR head
      const pr = await this.fetchGitHub<Record<string, any>>(
        auth,
        `/repos/${owner}/${repo}/pulls/${prNumber}`,
      );
      const commitId = pr.head?.sha;
      if (!commitId) throw new Error('Could not resolve PR head SHA for inline comment');

      await this.fetchGitHub(
        auth,
        `/repos/${owner}/${repo}/pulls/${prNumber}/comments`,
        {
          method: 'POST',
          body: JSON.stringify({
            body: comment,
            commit_id: commitId,
            path,
            line,
          }),
          headers: { 'Content-Type': 'application/json' },
        },
      );
    } else {
      // General issue comment
      await this.fetchGitHub(
        auth,
        `/repos/${owner}/${repo}/issues/${prNumber}/comments`,
        {
          method: 'POST',
          body: JSON.stringify({ body: comment }),
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }
  }

  async mergePR(
    auth: AuthConfig,
    repoFullName: string,
    prNumber: number,
    method?: string,
    title?: string,
    message?: string,
  ): Promise<{ sha: string }> {
    const [owner, repo] = parseRepo(repoFullName);

    const body: Record<string, any> = {
      merge_method: method || 'squash',
    };
    if (title) body.commit_title = title;
    if (message) body.commit_message = message;

    const result = await this.fetchGitHub<{ sha: string }>(
      auth,
      `/repos/${owner}/${repo}/pulls/${prNumber}/merge`,
      {
        method: 'PUT',
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json' },
      },
    );

    return { sha: result.sha };
  }

  async updatePR(
    auth: AuthConfig,
    repoFullName: string,
    prNumber: number,
    updates: Partial<{ title: string; body: string; state: string; draft: boolean; labels: string[]; assignees: string[] }>,
  ): Promise<ExternalPR> {
    const [owner, repo] = parseRepo(repoFullName);

    // Update title, body, state, draft on the PR itself
    const prBody: Record<string, any> = {};
    if (updates.title !== undefined) prBody.title = updates.title;
    if (updates.body !== undefined) prBody.body = updates.body;
    if (updates.state !== undefined) prBody.state = updates.state;

    let pr: any;
    if (Object.keys(prBody).length > 0) {
      pr = await this.fetchGitHub<Record<string, any>>(
        auth,
        `/repos/${owner}/${repo}/pulls/${prNumber}`,
        {
          method: 'PATCH',
          body: JSON.stringify(prBody),
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }

    // Update labels via issues endpoint (replace all)
    if (updates.labels !== undefined) {
      await this.fetchGitHub(
        auth,
        `/repos/${owner}/${repo}/issues/${prNumber}/labels`,
        {
          method: 'PUT',
          body: JSON.stringify({ labels: updates.labels }),
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }

    // Update assignees
    if (updates.assignees !== undefined) {
      await this.fetchGitHub(
        auth,
        `/repos/${owner}/${repo}/issues/${prNumber}/assignees`,
        {
          method: 'POST',
          body: JSON.stringify({ assignees: updates.assignees }),
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }

    // Re-fetch to return the updated PR
    const updated = await this.fetchGitHub<Record<string, any>>(
      auth,
      `/repos/${owner}/${repo}/pulls/${prNumber}`,
    );

    return mapPR(updated, repoFullName);
  }

  async getPRChecks(
    auth: AuthConfig,
    repoFullName: string,
    prNumber: number,
  ): Promise<PRChecks> {
    const [owner, repo] = parseRepo(repoFullName);

    // First, get the PR to retrieve the head SHA
    const pr = await this.fetchGitHub<Record<string, any>>(
      auth,
      `/repos/${owner}/${repo}/pulls/${prNumber}`,
    );

    const headSha = pr.head?.sha;
    if (!headSha) {
      throw new Error(`Could not resolve head SHA for PR #${prNumber}`);
    }

    // Fetch check runs for the head commit
    const checkRunsData = await this.fetchGitHub<{
      total_count: number;
      check_runs: Array<Record<string, any>>;
    }>(auth, `/repos/${owner}/${repo}/commits/${headSha}/check-runs`);

    const checks: PRCheckRun[] = checkRunsData.check_runs.map(run => ({
      name: run.name as string,
      status: run.status as string,
      conclusion: (run.conclusion as string | null) || null,
      detailsUrl: run.details_url as string | undefined,
      completedAt: run.completed_at as string | undefined,
    }));

    // Determine aggregate status
    const pending = checks.some(c => c.status !== 'completed');
    const anyFailed = checks.some(
      c => c.conclusion && ['failure', 'cancelled', 'timed_out', 'action_required'].includes(c.conclusion),
    );
    const allPassed = !pending && !anyFailed && checks.length > 0;

    return {
      checks,
      allPassed,
      anyFailed,
      pending,
    };
  }
}
