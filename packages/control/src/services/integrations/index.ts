// ── Integration Provider Registration ────────────────────────────────

import { registerProvider } from './registry.js';
import { GitHubAdapter } from './github-adapter.js';
import { JiraAdapter } from './jira-adapter.js';
import { BitbucketAdapter } from './bitbucket-adapter.js';
import { AtlassianAdapter } from './atlassian-adapter.js';

export function registerAllProviders(): void {
  registerProvider(new GitHubAdapter());
  registerProvider(new JiraAdapter());
  registerProvider(new BitbucketAdapter());
  registerProvider(new AtlassianAdapter());
}

export type { IntegrationProvider, AuthConfig, ExternalIssue, ExternalProject, ExternalRepo } from './types.js';
