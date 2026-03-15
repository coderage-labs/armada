export interface AuthConfig {
  token?: string;
  url?: string;
  email?: string;          // Required for Jira (basic auth = email:token)
  privateKey?: string;
  host?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: string;
}

export interface ExternalIssue {
  externalId: string;
  title: string;
  description: string;
  status: string;
  priority?: string;
  assignee?: string;
  labels: string[];
  url: string;
  createdAt: string;
  updatedAt: string;
}

export interface ExternalProject {
  id: string;
  key?: string;
  name: string;
}

export interface ExternalRepo {
  fullName: string;
  name: string;
  defaultBranch: string;
  url: string;
  isPrivate: boolean;
}

export interface IssueFilters {
  projects?: string[];
  labels?: string[];
  statuses?: string[];
  assignees?: string[];
  types?: string[];
}

export interface CreatePROptions {
  repo: string;
  title: string;
  body: string;
  head: string;
  base: string;
  draft?: boolean;
  labels?: string[];
}

export interface ExternalPR {
  number: number;
  title: string;
  body: string;
  url: string;
  status: string;
  draft: boolean;
  repo: string;
  head: string;
  base: string;
  author: string;
  assignees: string[];
  labels: string[];
  reviewDecision?: string;
  reviews: PRReview[];
  additions: number;
  deletions: number;
  changedFiles: number;
  mergeable: boolean | null;
  createdAt: string;
  updatedAt: string;
  mergedAt?: string;
  mergedBy?: string;
}

export interface PRReview {
  author: string;
  state: string;
  body: string;
  submittedAt: string;
}

export interface PRComment {
  id: number;
  author: string;
  body: string;
  path?: string;
  line?: number;
  createdAt: string;
  updatedAt: string;
}

export interface PRFilters {
  state?: 'open' | 'closed' | 'all';
  author?: string;
  labels?: string[];
  cursor?: string;
}

export interface IntegrationProvider {
  name: string;
  testConnection(auth: AuthConfig): Promise<{ ok: boolean; error?: string }>;
  
  // Issues
  listProjects?(auth: AuthConfig): Promise<ExternalProject[]>;
  fetchIssues(auth: AuthConfig, filters: IssueFilters, cursor?: string): Promise<{
    issues: ExternalIssue[];
    cursor?: string;
  }>;
  getIssue?(auth: AuthConfig, issueKey: string): Promise<ExternalIssue>;
  updateIssueStatus?(auth: AuthConfig, issueKey: string, status: string): Promise<void>;
  addComment?(auth: AuthConfig, issueKey: string, comment: string): Promise<void>;
  
  // VCS
  listRepos?(auth: AuthConfig): Promise<ExternalRepo[]>;
  createPR?(auth: AuthConfig, opts: CreatePROptions): Promise<ExternalPR>;

  // VCS — Pull Requests
  listPRs?(auth: AuthConfig, repo: string, filters?: PRFilters): Promise<{ prs: ExternalPR[]; cursor?: string }>;
  getPR?(auth: AuthConfig, repo: string, number: number): Promise<ExternalPR>;
  getPRReviews?(auth: AuthConfig, repo: string, number: number): Promise<{ reviews: PRReview[]; comments: PRComment[] }>;
  addPRComment?(auth: AuthConfig, repo: string, number: number, comment: string, path?: string, line?: number): Promise<void>;
  mergePR?(auth: AuthConfig, repo: string, number: number, method?: string, title?: string, message?: string): Promise<{ sha: string }>;
  updatePR?(auth: AuthConfig, repo: string, number: number, updates: Partial<{ title: string; body: string; state: string; draft: boolean; labels: string[]; assignees: string[] }>): Promise<ExternalPR>;
}
