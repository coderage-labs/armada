// ── Bitbucket Cloud Integration Provider Adapter ────────────────────

import type {
  AuthConfig,
  IntegrationProvider,
  ExternalProject,
  ExternalIssue,
  IssueFilters,
  ExternalRepo,
  CreatePROptions,
  ExternalPR,
} from './types.js';

const DEFAULT_API = 'https://api.bitbucket.org/2.0';

export class BitbucketAdapter implements IntegrationProvider {
  readonly name = 'bitbucket';

  private getBaseUrl(auth: AuthConfig): string {
    return (auth.url || DEFAULT_API).replace(/\/+$/, '');
  }

  private getHeaders(auth: AuthConfig): Record<string, string> {
    const headers: Record<string, string> = {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    };
    if (auth.email && auth.token) {
      headers['Authorization'] = `Basic ${Buffer.from(`${auth.email}:${auth.token}`).toString('base64')}`;
    } else if (auth.token) {
      headers['Authorization'] = `Bearer ${auth.token}`;
    }
    return headers;
  }

  private async fetchBB<T>(auth: AuthConfig, path: string, init?: RequestInit): Promise<T> {
    const base = this.getBaseUrl(auth);
    const url = path.startsWith('http') ? path : `${base}${path}`;
    const res = await fetch(url, {
      ...init,
      headers: { ...this.getHeaders(auth), ...init?.headers },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Bitbucket API ${res.status}: ${body}`);
    }
    return res.json() as Promise<T>;
  }

  async testConnection(auth: AuthConfig): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.fetchBB(auth, '/user');
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }

  async listProjects(auth: AuthConfig): Promise<ExternalProject[]> {
    const data = await this.fetchBB<{ values: Array<{ slug: string; name: string }> }>(
      auth, '/workspaces?pagelen=100',
    );
    return data.values.map(ws => ({
      id: ws.slug,
      key: ws.slug,
      name: ws.name,
    }));
  }

  async fetchIssues(
    auth: AuthConfig,
    filters: IssueFilters,
    cursor?: string,
  ): Promise<{ issues: ExternalIssue[]; cursor?: string }> {
    const repos = filters.projects || [];
    if (repos.length === 0) {
      return { issues: [] };
    }

    const allIssues: ExternalIssue[] = [];
    let nextCursor: string | undefined;

    for (const repo of repos) {
      const parts = repo.split('/');
      if (parts.length !== 2) continue;
      const [workspace, repoSlug] = parts;

      // Build query
      const qParts: string[] = ['state="open"'];
      if (filters.labels?.length) {
        qParts.push(`(${filters.labels.map(l => `kind="${l}"`).join(' OR ')})`);
      }
      const q = qParts.join(' AND ');
      const page = cursor || '1';

      const data = await this.fetchBB<{
        values: Array<Record<string, any>>;
        next?: string;
        page?: number;
      }>(auth, `/repositories/${workspace}/${repoSlug}/issues?q=${encodeURIComponent(q)}&page=${page}&pagelen=50`);

      for (const issue of data.values) {
        allIssues.push({
          externalId: `${workspace}/${repoSlug}#${issue.id}`,
          title: issue.title || '',
          description: issue.content?.raw || '',
          status: issue.state || 'open',
          priority: issue.priority || undefined,
          assignee: issue.assignee?.display_name || undefined,
          labels: issue.kind ? [issue.kind] : [],
          url: issue.links?.html?.href || '',
          createdAt: issue.created_on || '',
          updatedAt: issue.updated_on || '',
        });
      }

      if (data.next) {
        // Extract page number from next URL
        const match = data.next.match(/page=(\d+)/);
        nextCursor = match ? match[1] : undefined;
      }
    }

    return { issues: allIssues, cursor: nextCursor };
  }

  async getIssue(auth: AuthConfig, issueKey: string): Promise<ExternalIssue> {
    // Format: "workspace/repo#123"
    const match = issueKey.match(/^(.+?)\/(.+?)#(\d+)$/);
    if (!match) throw new Error(`Invalid issue key format: ${issueKey} (expected workspace/repo#123)`);
    const [, workspace, repoSlug, id] = match;

    const issue = await this.fetchBB<Record<string, any>>(
      auth, `/repositories/${workspace}/${repoSlug}/issues/${id}`,
    );

    return {
      externalId: issueKey,
      title: issue.title || '',
      description: issue.content?.raw || '',
      status: issue.state || 'open',
      priority: issue.priority || undefined,
      assignee: issue.assignee?.display_name || undefined,
      labels: issue.kind ? [issue.kind] : [],
      url: issue.links?.html?.href || '',
      createdAt: issue.created_on || '',
      updatedAt: issue.updated_on || '',
    };
  }

  async addComment(auth: AuthConfig, issueKey: string, comment: string): Promise<void> {
    const match = issueKey.match(/^(.+?)\/(.+?)#(\d+)$/);
    if (!match) throw new Error(`Invalid issue key format: ${issueKey}`);
    const [, workspace, repoSlug, id] = match;

    await this.fetchBB(
      auth,
      `/repositories/${workspace}/${repoSlug}/issues/${id}/comments`,
      { method: 'POST', body: JSON.stringify({ content: { raw: comment } }) },
    );
  }

  async listRepos(auth: AuthConfig): Promise<ExternalRepo[]> {
    const data = await this.fetchBB<{ values: Array<Record<string, any>> }>(
      auth, '/repositories/?role=member&sort=-updated_on&pagelen=100',
    );

    return data.values.map(repo => ({
      fullName: repo.full_name || '',
      name: repo.name || '',
      url: repo.links?.html?.href || '',
      defaultBranch: repo.mainbranch?.name || 'main',
      isPrivate: repo.is_private ?? false,
    }));
  }

  async createPR(auth: AuthConfig, opts: CreatePROptions): Promise<ExternalPR> {
    const parts = opts.repo.split('/');
    if (parts.length !== 2) throw new Error(`Invalid repo format: ${opts.repo}`);
    const [workspace, repoSlug] = parts;

    const pr = await this.fetchBB<Record<string, any>>(
      auth,
      `/repositories/${workspace}/${repoSlug}/pullrequests`,
      {
        method: 'POST',
        body: JSON.stringify({
          title: opts.title,
          description: opts.body,
          source: { branch: { name: opts.head } },
          destination: { branch: { name: opts.base } },
        }),
      },
    );

    return {
      number: pr.id as number,
      title: pr.title as string,
      body: (pr.description as string) || '',
      url: pr.links?.html?.href || '',
      status: pr.state as string,
      draft: false,
      repo: opts.repo,
      head: opts.head,
      base: opts.base,
      author: pr.author?.display_name || '',
      assignees: [],
      labels: [],
      reviews: [],
      additions: 0,
      deletions: 0,
      changedFiles: 0,
      mergeable: null,
      createdAt: pr.created_on || '',
      updatedAt: pr.updated_on || '',
    };
  }
}
