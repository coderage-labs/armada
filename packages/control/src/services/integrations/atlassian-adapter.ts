// ── Atlassian Integration Provider (delegates to Jira + Bitbucket) ───

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
import { JiraAdapter } from './jira-adapter.js';
import { BitbucketAdapter } from './bitbucket-adapter.js';

/**
 * Unified Atlassian provider — same credentials (email:token) work
 * for both Jira Cloud and Bitbucket Cloud.
 *
 * Issues capability → JiraAdapter (needs auth.url for Jira site)
 * VCS capability    → BitbucketAdapter (fixed API URL)
 */
export class AtlassianAdapter implements IntegrationProvider {
  readonly name = 'atlassian';

  private jira = new JiraAdapter();
  private bitbucket = new BitbucketAdapter();

  async testConnection(auth: AuthConfig): Promise<{ ok: boolean; error?: string }> {
    const results: string[] = [];
    let anyOk = false;

    // Test Jira if URL provided (Jira needs site URL)
    if (auth.url) {
      const jiraResult = await this.jira.testConnection(auth);
      if (jiraResult.ok) {
        anyOk = true;
      } else {
        results.push(`Jira: ${jiraResult.error}`);
      }
    }

    // Test Bitbucket (always available — fixed API URL)
    const bbResult = await this.bitbucket.testConnection(auth);
    if (bbResult.ok) {
      anyOk = true;
    } else {
      results.push(`Bitbucket: ${bbResult.error}`);
    }

    if (anyOk) return { ok: true };
    return { ok: false, error: results.join('; ') || 'Connection failed' };
  }

  // ── Issues (Jira) ──────────────────────────────────────────────────

  async listProjects(auth: AuthConfig): Promise<ExternalProject[]> {
    return this.jira.listProjects!(auth);
  }

  async fetchIssues(
    auth: AuthConfig,
    filters: IssueFilters,
    cursor?: string,
  ): Promise<{ issues: ExternalIssue[]; cursor?: string }> {
    return this.jira.fetchIssues(auth, filters, cursor);
  }

  async getIssue(auth: AuthConfig, issueKey: string): Promise<ExternalIssue> {
    return this.jira.getIssue!(auth, issueKey);
  }

  async updateIssueStatus(auth: AuthConfig, issueKey: string, status: string): Promise<void> {
    return this.jira.updateIssueStatus!(auth, issueKey, status);
  }

  async addComment(auth: AuthConfig, issueKey: string, comment: string): Promise<void> {
    return this.jira.addComment!(auth, issueKey, comment);
  }

  // ── VCS (Bitbucket) ────────────────────────────────────────────────

  async listRepos(auth: AuthConfig): Promise<ExternalRepo[]> {
    return this.bitbucket.listRepos!(auth);
  }

  async createPR(auth: AuthConfig, opts: CreatePROptions): Promise<ExternalPR> {
    return this.bitbucket.createPR!(auth, opts);
  }
}
