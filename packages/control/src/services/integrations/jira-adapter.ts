/**
 * Jira Cloud Provider Adapter
 * API v3: https://{site}.atlassian.net/rest/api/3/
 */

import type {
  IntegrationProvider,
  AuthConfig,
  ExternalProject,
  IssueFilters,
  ExternalIssue,
} from './types.js';

export class JiraAdapter implements IntegrationProvider {
  readonly name = 'jira';

  /**
   * Test connection by fetching current user
   */
  async testConnection(auth: AuthConfig): Promise<{ ok: boolean; error?: string }> {
    try {
      const response = await this.fetch(auth, '/rest/api/3/myself');
      if (response.ok) {
        return { ok: true };
      }
      const error = await response.text();
      return { ok: false, error: `HTTP ${response.status}: ${error}` };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }

  /**
   * List available Jira projects
   */
  async listProjects(auth: AuthConfig): Promise<ExternalProject[]> {
    const response = await this.fetch(auth, '/rest/api/3/project/search');
    if (!response.ok) {
      throw new Error(`Failed to list projects: ${response.status} ${await response.text()}`);
    }

    const data = await response.json();
    return (data.values || []).map((p: any) => ({
      id: p.id,
      key: p.key,
      name: p.name,
    }));
  }

  /**
   * Fetch issues using JQL search
   */
  async fetchIssues(
    auth: AuthConfig,
    filters: IssueFilters,
    cursor?: string
  ): Promise<{ issues: ExternalIssue[]; cursor?: string }> {
    const jql = this.buildJQL(filters);
    const startAt = cursor ? parseInt(cursor, 10) : 0;

    const response = await this.fetch(auth, '/rest/api/3/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jql,
        startAt,
        maxResults: 50,
        fields: [
          'summary',
          'description',
          'status',
          'priority',
          'assignee',
          'labels',
          'issuetype',
          'created',
          'updated',
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch issues: ${response.status} ${await response.text()}`);
    }

    const data = await response.json();
    const issues = (data.issues || []).map((issue: any) => this.mapIssue(auth, issue));
    
    const nextCursor = data.startAt + data.maxResults < data.total 
      ? String(data.startAt + data.maxResults) 
      : undefined;

    return { issues, cursor: nextCursor };
  }

  /**
   * Get a single issue by key (e.g. "PROJ-123")
   */
  async getIssue(auth: AuthConfig, issueKey: string): Promise<ExternalIssue> {
    const response = await this.fetch(auth, `/rest/api/3/issue/${issueKey}`);
    if (!response.ok) {
      throw new Error(`Failed to get issue: ${response.status} ${await response.text()}`);
    }

    const issue = await response.json();
    return this.mapIssue(auth, issue);
  }

  /**
   * Update issue status via transitions
   */
  async updateIssueStatus(auth: AuthConfig, issueKey: string, status: string): Promise<void> {
    // Step 1: Get available transitions
    const transitionsResp = await this.fetch(auth, `/rest/api/3/issue/${issueKey}/transitions`);
    if (!transitionsResp.ok) {
      throw new Error(`Failed to get transitions: ${transitionsResp.status} ${await transitionsResp.text()}`);
    }

    const { transitions } = await transitionsResp.json();
    const transition = transitions.find(
      (t: any) => t.name.toLowerCase() === status.toLowerCase() || t.to.name.toLowerCase() === status.toLowerCase()
    );

    if (!transition) {
      throw new Error(`No transition found for status: ${status}`);
    }

    // Step 2: Execute transition
    const response = await this.fetch(auth, `/rest/api/3/issue/${issueKey}/transitions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transition: { id: transition.id } }),
    });

    if (!response.ok) {
      throw new Error(`Failed to update status: ${response.status} ${await response.text()}`);
    }
  }

  /**
   * Add a comment to an issue (using ADF format)
   */
  async addComment(auth: AuthConfig, issueKey: string, comment: string): Promise<void> {
    const response = await this.fetch(auth, `/rest/api/3/issue/${issueKey}/comment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        body: {
          type: 'doc',
          version: 1,
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: comment }],
            },
          ],
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to add comment: ${response.status} ${await response.text()}`);
    }
  }

  /**
   * Build JQL query from filters
   */
  private buildJQL(filters: IssueFilters): string {
    const conditions: string[] = [];

    if (filters.projects?.length) {
      const projects = filters.projects.map((p) => p).join(', ');
      conditions.push(`project IN (${projects})`);
    }

    if (filters.statuses?.length) {
      const statuses = filters.statuses.map((s) => `"${s}"`).join(', ');
      conditions.push(`status IN (${statuses})`);
    }

    if (filters.labels?.length) {
      const labels = filters.labels.map((l) => l).join(', ');
      conditions.push(`labels IN (${labels})`);
    }

    if (filters.assignees?.length) {
      const assignees = filters.assignees.map((a) => {
        if (a === '@me') return 'currentUser()';
        return a;
      });
      if (assignees.length === 1) {
        conditions.push(`assignee = ${assignees[0]}`);
      } else {
        conditions.push(`assignee IN (${assignees.join(', ')})`);
      }
    }

    if (filters.types?.length) {
      const types = filters.types.map((t) => t).join(', ');
      conditions.push(`issuetype IN (${types})`);
    }

    // Default query if no filters
    if (conditions.length === 0) {
      return 'status != Done ORDER BY updated DESC';
    }

    return `${conditions.join(' AND ')} ORDER BY updated DESC`;
  }

  /**
   * Map Jira issue to ExternalIssue
   */
  private mapIssue(auth: AuthConfig, issue: any): ExternalIssue {
    const { fields } = issue;
    
    return {
      externalId: issue.key,
      title: fields.summary,
      description: this.extractPlainText(fields.description),
      status: fields.status?.name || 'Unknown',
      priority: fields.priority?.name,
      assignee: fields.assignee?.displayName,
      labels: fields.labels || [],
      url: `${auth.url}/browse/${issue.key}`,
      createdAt: fields.created,
      updatedAt: fields.updated,
    };
  }

  /**
   * Extract plain text from ADF (Atlassian Document Format)
   * For now, just do a simple traversal. Full ADF parsing would be more complex.
   */
  private extractPlainText(adf: any): string {
    if (!adf) return '';
    if (typeof adf === 'string') return adf;

    let text = '';
    
    const traverse = (node: any) => {
      if (node.type === 'text') {
        text += node.text;
      }
      if (node.content) {
        for (const child of node.content) {
          traverse(child);
        }
      }
    };

    traverse(adf);
    return text.trim();
  }

  /**
   * Make authenticated fetch request to Jira API
   */
  private async fetch(auth: AuthConfig, path: string, init?: RequestInit): Promise<Response> {
    if (!auth.url || !auth.email || !auth.token) {
      throw new Error('Jira auth requires url, email, and token');
    }

    const url = `${auth.url}${path}`;
    const authHeader = `Basic ${Buffer.from(`${auth.email}:${auth.token}`).toString('base64')}`;

    return fetch(url, {
      ...init,
      headers: {
        ...init?.headers,
        Authorization: authHeader,
      },
    });
  }
}
