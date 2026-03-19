// ── PR Proxy Routes ─────────────────────────────────────────────────
// Agents call these to interact with pull requests without
// ever seeing credentials. Armada resolves project → integration → adapter.

import { Router } from 'express';
import { requireScope } from '../middleware/scopes.js';
import { getProvider } from '../services/integrations/registry.js';
import { integrationsRepo } from '../services/integrations/integrations-repo.js';
import { projectIntegrationsRepo } from '../services/integrations/project-integrations-repo.js';
import { agentsRepo, templatesRepo, projectsRepo, projectReposRepo, instancesRepo } from '../repositories/index.js';
import { logActivity } from '../services/activity-service.js';
import { registerToolDef } from '../utils/tool-registry.js';
import type { IntegrationProvider, PRFilters } from '../services/integrations/types.js';
import { getNodeClient } from '../infrastructure/node-client.js';

const router = Router();

/* ── Helpers ──────────────────────────────────────────────────────── */

/** Resolve a project by ID or name */
function resolveProject(projectRef: string) {
  return projectsRepo.get(projectRef) ?? projectsRepo.getByName?.(projectRef) ?? null;
}

/** Check if an agent is a member of a project */
function isAgentMember(agentName: string | null, projectName: string): boolean {
  if (agentName === null) return true; // Human callers always allowed through — not subject to per-project agent membership checks
  const agents = agentsRepo.getAll();
  const agent = agents.find(a => a.name === agentName);
  if (!agent) return true;
  if (!agent.templateId) return false;
  const tmpl = templatesRepo.getById(agent.templateId);
  if (!tmpl) return false;
  return ((tmpl as any).projects ?? []).includes(projectName);
}

/** Log a proxy action for audit trail */
function auditLog(agent: string, project: string, action: string, detail?: string) {
  logActivity({
    eventType: 'proxy.pr',
    detail: `[${agent}] ${action} on ${project}${detail ? `: ${detail}` : ''}`,
  });
}

/** Find the VCS integration for a project and normalise repo list.
 *  Prefers project_repos table; falls back to project_integrations.vcs config for backwards compat. */
function resolveVcsIntegration(projectId: string): {
  projectIntegration: any;
  integration: any;
  provider: IntegrationProvider;
  repos: string[];
} | null {
  // Prefer project_repos table
  const linkedRepos = projectReposRepo.getByProject(projectId);
  if (linkedRepos.length > 0) {
    // Use the first integration found (most recently linked)
    const firstRepo = linkedRepos[0];
    const integration = integrationsRepo.getById(firstRepo.integrationId);
    if (integration && integration.status === 'active') {
      const provider = getProvider(integration.provider);
      if (provider) {
        const repos = linkedRepos
          .filter(r => r.integrationId === firstRepo.integrationId)
          .map(r => r.fullName);
        return { projectIntegration: null, integration, provider, repos };
      }
    }
  }

  // Legacy fallback: project_integrations with capability=vcs
  const pis = projectIntegrationsRepo.getByProject(projectId);
  const vcsPI = pis.find(pi => pi.capability === 'vcs' && pi.enabled);
  if (!vcsPI) return null;

  const integration = integrationsRepo.getById(vcsPI.integrationId);
  if (!integration || integration.status !== 'active') return null;

  const provider = getProvider(integration.provider);
  if (!provider) return null;

  // Normalise config to get repo list
  const config = vcsPI.config || {};
  const repos: string[] = config.repos
    ? config.repos
    : config.projectKeys
      ? (config.projectKeys as string).split(',').map((s: string) => s.trim())
      : [];

  return { projectIntegration: vcsPI, integration, provider, repos };
}

/** Validate that a repo is in the project's VCS config */
function validateRepo(repos: string[], repo: string): boolean {
  return repos.includes(repo);
}

/* ── Routes ───────────────────────────────────────────────────────── */

// List available repos
registerToolDef({
  category: 'issues',
  name: 'armada_pr_repos',
  description: 'List available repositories for a project\'s VCS integration',
  method: 'POST',
  path: '/api/proxy/prs/repos',
  parameters: [
    { name: 'project', type: 'string', description: 'Project ID or name', required: true },
  ],
    scope: 'prs:read',
});

router.post('/repos', async (req, res, next) => {
  try {
    const agentName = (req.caller as any)?.agentName ?? null;
    const { project: projectRef } = req.body;
    if (!projectRef) return res.status(400).json({ error: 'project is required' });

    const project = resolveProject(projectRef);
    if (!project) return res.status(404).json({ error: `Project not found: ${projectRef}` });
    if (!isAgentMember(agentName, project.name)) return res.status(403).json({ error: `Agent ${agentName} is not a member of project ${project.name}` });

    const resolved = resolveVcsIntegration(project.id);
    if (!resolved) return res.status(404).json({ error: `No active VCS integration for project: ${project.name}` });

    const { integration, provider, repos: configRepos } = resolved;

    // Try to get full repo info from provider, filtered to config repos
    if (provider.listRepos) {
      try {
        const allRepos = await provider.listRepos(integration.authConfig);
        const configSet = new Set(configRepos);
        const filtered = allRepos.filter(r => configSet.has(r.fullName));
        auditLog(agentName, project.name, 'repos', `${filtered.length} repos`);
        return res.json({ repos: filtered });
      } catch (err: any) {
        console.warn('[proxy-prs] listRepos failed:', err.message);
      }
    }

    // Fallback: return config repos with minimal info
    const repos = configRepos.map(fullName => ({
      fullName,
      name: fullName.split('/')[1] || fullName,
      defaultBranch: 'main',
      url: `https://github.com/${fullName}`,
      isPrivate: false,
    }));

    auditLog(agentName, project.name, 'repos', `${repos.length} repos`);
    res.json({ repos });
  } catch (err) { next(err); }
});

// List PRs
registerToolDef({
  category: 'issues',
  name: 'armada_pr_list',
  description: 'List pull requests for a project repository',
  method: 'POST',
  path: '/api/proxy/prs/list',
  parameters: [
    { name: 'project', type: 'string', description: 'Project ID or name', required: true },
    { name: 'repo', type: 'string', description: 'Repository full name (owner/repo). If omitted, lists from all project repos' },
    { name: 'state', type: 'string', description: 'PR state: open, closed, all (default: open)' },
    { name: 'author', type: 'string', description: 'Filter by author username' },
    { name: 'labels', type: 'string', description: 'Comma-separated label filter' },
    { name: 'cursor', type: 'string', description: 'Pagination cursor from previous response' },
  ],
    scope: 'prs:read',
});

router.post('/list', async (req, res, next) => {
  try {
    const agentName = (req.caller as any)?.agentName ?? null;
    const { project: projectRef, repo, state, author, labels, cursor } = req.body;
    if (!projectRef) return res.status(400).json({ error: 'project is required' });

    const project = resolveProject(projectRef);
    if (!project) return res.status(404).json({ error: `Project not found: ${projectRef}` });
    if (!isAgentMember(agentName, project.name)) return res.status(403).json({ error: `Agent ${agentName} is not a member of project ${project.name}` });

    const resolved = resolveVcsIntegration(project.id);
    if (!resolved) return res.status(404).json({ error: `No active VCS integration for project: ${project.name}` });

    const { integration, provider, repos: configRepos } = resolved;
    if (!provider.listPRs) return res.status(501).json({ error: `Provider ${integration.provider} does not support listPRs` });

    const filters: PRFilters = {
      state: state || 'open',
      author,
      labels: labels ? labels.split(',').map((s: string) => s.trim()) : undefined,
      cursor,
    };

    // If repo specified, validate and list from that repo
    if (repo) {
      if (!validateRepo(configRepos, repo)) return res.status(403).json({ error: `Repo ${repo} is not configured for project ${project.name}` });
      const result = await provider.listPRs(integration.authConfig, repo, filters);
      auditLog(agentName, project.name, 'list', `${repo} (${result.prs.length} PRs)`);
      return res.json(result);
    }

    // No repo specified — list from all project repos
    const allPRs: any[] = [];
    for (const repoName of configRepos) {
      try {
        const result = await provider.listPRs(integration.authConfig, repoName, filters);
        allPRs.push(...result.prs);
      } catch (err: any) {
        console.error(`PR list error for ${repoName}:`, err.message);
      }
    }

    auditLog(agentName, project.name, 'list', `${allPRs.length} PRs across ${configRepos.length} repos`);
    res.json({ prs: allPRs });
  } catch (err) { next(err); }
});

// Get a single PR
registerToolDef({
  category: 'issues',
  name: 'armada_pr_get',
  description: 'Get full details of a pull request including reviews and diff stats',
  method: 'POST',
  path: '/api/proxy/prs/get',
  parameters: [
    { name: 'project', type: 'string', description: 'Project ID or name', required: true },
    { name: 'repo', type: 'string', description: 'Repository full name (owner/repo)', required: true },
    { name: 'number', type: 'number', description: 'PR number', required: true },
  ],
    scope: 'prs:read',
});

router.post('/get', async (req, res, next) => {
  try {
    const agentName = (req.caller as any)?.agentName ?? null;
    const { project: projectRef, repo, number } = req.body;
    if (!projectRef || !repo || !number) return res.status(400).json({ error: 'project, repo, and number are required' });

    const project = resolveProject(projectRef);
    if (!project) return res.status(404).json({ error: `Project not found: ${projectRef}` });
    if (!isAgentMember(agentName, project.name)) return res.status(403).json({ error: `Agent ${agentName} is not a member of project ${project.name}` });

    const resolved = resolveVcsIntegration(project.id);
    if (!resolved) return res.status(404).json({ error: `No active VCS integration for project: ${project.name}` });

    const { integration, provider, repos: configRepos } = resolved;
    if (!provider.getPR) return res.status(501).json({ error: `Provider ${integration.provider} does not support getPR` });
    if (!validateRepo(configRepos, repo)) return res.status(403).json({ error: `Repo ${repo} is not configured for project ${project.name}` });

    const pr = await provider.getPR(integration.authConfig, repo, number);
    auditLog(agentName, project.name, 'get', `${repo}#${number}`);
    res.json(pr);
  } catch (err) { next(err); }
});

// Get PR reviews
registerToolDef({
  category: 'issues',
  name: 'armada_pr_reviews',
  description: 'Get reviews and inline comments for a pull request',
  method: 'POST',
  path: '/api/proxy/prs/reviews',
  parameters: [
    { name: 'project', type: 'string', description: 'Project ID or name', required: true },
    { name: 'repo', type: 'string', description: 'Repository full name (owner/repo)', required: true },
    { name: 'number', type: 'number', description: 'PR number', required: true },
  ],
    scope: 'prs:read',
});

router.post('/reviews', async (req, res, next) => {
  try {
    const agentName = (req.caller as any)?.agentName ?? null;
    const { project: projectRef, repo, number } = req.body;
    if (!projectRef || !repo || !number) return res.status(400).json({ error: 'project, repo, and number are required' });

    const project = resolveProject(projectRef);
    if (!project) return res.status(404).json({ error: `Project not found: ${projectRef}` });
    if (!isAgentMember(agentName, project.name)) return res.status(403).json({ error: `Agent ${agentName} is not a member of project ${project.name}` });

    const resolved = resolveVcsIntegration(project.id);
    if (!resolved) return res.status(404).json({ error: `No active VCS integration for project: ${project.name}` });

    const { integration, provider, repos: configRepos } = resolved;
    if (!provider.getPRReviews) return res.status(501).json({ error: `Provider ${integration.provider} does not support getPRReviews` });
    if (!validateRepo(configRepos, repo)) return res.status(403).json({ error: `Repo ${repo} is not configured for project ${project.name}` });

    const result = await provider.getPRReviews(integration.authConfig, repo, number);
    auditLog(agentName, project.name, 'reviews', `${repo}#${number}`);
    res.json(result);
  } catch (err) { next(err); }
});

// Add a comment to a PR
registerToolDef({
  category: 'issues',
  name: 'armada_pr_comment',
  description: 'Add a comment to a pull request (general or inline)',
  method: 'POST',
  path: '/api/proxy/prs/comment',
  parameters: [
    { name: 'project', type: 'string', description: 'Project ID or name', required: true },
    { name: 'repo', type: 'string', description: 'Repository full name (owner/repo)', required: true },
    { name: 'number', type: 'number', description: 'PR number', required: true },
    { name: 'comment', type: 'string', description: 'Comment text', required: true },
    { name: 'path', type: 'string', description: 'File path for inline review comment' },
    { name: 'line', type: 'number', description: 'Line number for inline comment' },
  ],
    scope: 'prs:write',
});

router.post('/comment', requireScope('prs:write'), async (req, res, next) => {
  try {
    const agentName = (req.caller as any)?.agentName ?? null;
    const { project: projectRef, repo, number, comment, path: filePath, line } = req.body;
    if (!projectRef || !repo || !number || !comment) return res.status(400).json({ error: 'project, repo, number, and comment are required' });

    const project = resolveProject(projectRef);
    if (!project) return res.status(404).json({ error: `Project not found: ${projectRef}` });
    if (!isAgentMember(agentName, project.name)) return res.status(403).json({ error: `Agent ${agentName} is not a member of project ${project.name}` });

    const resolved = resolveVcsIntegration(project.id);
    if (!resolved) return res.status(404).json({ error: `No active VCS integration for project: ${project.name}` });

    const { integration, provider, repos: configRepos } = resolved;
    if (!provider.addPRComment) return res.status(501).json({ error: `Provider ${integration.provider} does not support addPRComment` });
    if (!validateRepo(configRepos, repo)) return res.status(403).json({ error: `Repo ${repo} is not configured for project ${project.name}` });

    await provider.addPRComment(integration.authConfig, repo, number, comment, filePath, line);
    const inlineDetail = filePath ? ` (inline: ${filePath}${line ? `:${line}` : ''})` : '';
    auditLog(agentName, project.name, 'comment', `${repo}#${number}${inlineDetail}`);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// Create a PR
registerToolDef({
  category: 'issues',
  name: 'armada_pr_create',
  description: 'Create a pull request. If workspacePath is provided, runs the verify command from armada.json (or auto-detected build config) before creating the PR — the PR is only created if verification passes.',
  method: 'POST',
  path: '/api/proxy/prs/create',
  parameters: [
    { name: 'project', type: 'string', description: 'Project ID or name', required: true },
    { name: 'repo', type: 'string', description: 'Repository full name (owner/repo)', required: true },
    { name: 'title', type: 'string', description: 'PR title', required: true },
    { name: 'body', type: 'string', description: 'PR description', required: true },
    { name: 'head', type: 'string', description: 'Source branch', required: true },
    { name: 'base', type: 'string', description: 'Target branch (defaults to repo default branch)' },
    { name: 'draft', type: 'boolean', description: 'Create as draft PR (default: false)' },
    { name: 'labels', type: 'string', description: 'JSON array of label names' },
    { name: 'workspacePath', type: 'string', description: 'Absolute path in the calling agent\'s container to run build verification from (reads armada.json or auto-detects). PR is blocked if verify fails.' },
  ],
    scope: 'prs:write',
});

router.post('/create', requireScope('prs:write'), async (req, res, next) => {
  try {
    const agentName = (req.caller as any)?.agentName ?? null;
    const { project: projectRef, repo, title, body, head, base, draft, labels, workspacePath } = req.body;
    if (!projectRef || !repo || !title || !body || !head) return res.status(400).json({ error: 'project, repo, title, body, and head are required' });

    const project = resolveProject(projectRef);
    if (!project) return res.status(404).json({ error: `Project not found: ${projectRef}` });
    if (!isAgentMember(agentName, project.name)) return res.status(403).json({ error: `Agent ${agentName} is not a member of project ${project.name}` });

    const resolved = resolveVcsIntegration(project.id);
    if (!resolved) return res.status(404).json({ error: `No active VCS integration for project: ${project.name}` });

    const { integration, provider, repos: configRepos } = resolved;
    if (!provider.createPR) return res.status(501).json({ error: `Provider ${integration.provider} does not support createPR` });
    if (!validateRepo(configRepos, repo)) return res.status(403).json({ error: `Repo ${repo} is not configured for project ${project.name}` });

    // ── Build verification (optional) ────────────────────────────────
    // When workspacePath is provided, discover the build config and run
    // the verify command inside the calling agent's container. PR creation
    // is blocked if verification fails.
    if (workspacePath && agentName) {
      try {
        // Resolve the calling agent's instance to find its node
        const agents = agentsRepo.getAll();
        const callerAgent = agents.find(a => a.name === agentName);
        const instanceId = callerAgent?.instanceId;
        const instance = instanceId ? instancesRepo.getById(instanceId) : null;

        if (instance?.nodeId) {
          const nodeClient = getNodeClient(instance.nodeId);
          const discovery = await nodeClient.discoverWorkspace(instance.name, workspacePath);

          // Prefer rootConfig verify; fall back to first detected stack's verify
          const verifyCmd = discovery.rootConfig?.verify
            ?? discovery.detected.find(d => d.buildConfig.verify)?.buildConfig.verify;

          if (verifyCmd) {
            console.log(`[proxy-prs] Running build verification for ${agentName}: ${verifyCmd}`);

            // Execute the verify command in the container via workspace.exec
            const verifyResult = await nodeClient.execInWorkspace(instance.name, workspacePath, verifyCmd, 120_000);

            if (verifyResult.exitCode !== 0) {
              auditLog(agentName, project.name, 'create-blocked', `${repo} — verify failed`);
              return res.status(422).json({
                error: 'Build verification failed — PR not created',
                verifyCmd,
                output: verifyResult.output,
                exitCode: verifyResult.exitCode,
              });
            }

            console.log(`[proxy-prs] Build verification passed for ${agentName}`);
          }
        } else {
          console.warn(`[proxy-prs] workspacePath provided but could not resolve instance for agent ${agentName} — skipping verification`);
        }
      } catch (verifyErr: any) {
        // Log but don't block PR creation if verification infrastructure fails
        console.warn(`[proxy-prs] Build verification error (non-blocking): ${verifyErr.message}`);
      }
    }

    // Parse labels — accept both JSON array and string array
    let parsedLabels: string[] | undefined;
    if (labels) {
      parsedLabels = Array.isArray(labels) ? labels : typeof labels === 'string' ? JSON.parse(labels) : undefined;
    }

    const pr = await provider.createPR(integration.authConfig, {
      repo,
      title,
      body,
      head,
      base: base || 'main',
      draft: draft || false,
      labels: parsedLabels,
    });

    auditLog(agentName, project.name, 'create', `${repo}#${pr.number}`);
    res.json(pr);
  } catch (err) { next(err); }
});

// Merge a PR
registerToolDef({
  category: 'issues',
  name: 'armada_pr_merge',
  description: 'Merge a pull request',
  method: 'POST',
  path: '/api/proxy/prs/merge',
  parameters: [
    { name: 'project', type: 'string', description: 'Project ID or name', required: true },
    { name: 'repo', type: 'string', description: 'Repository full name (owner/repo)', required: true },
    { name: 'number', type: 'number', description: 'PR number', required: true },
    { name: 'method', type: 'string', description: 'Merge method: merge, squash, rebase (default: squash)' },
    { name: 'commitTitle', type: 'string', description: 'Custom merge commit title' },
    { name: 'commitMessage', type: 'string', description: 'Custom merge commit message' },
  ],
    scope: 'prs:write',
});

router.post('/merge', requireScope('prs:write'), async (req, res, next) => {
  try {
    const agentName = (req.caller as any)?.agentName ?? null;
    const { project: projectRef, repo, number, method, commitTitle, commitMessage } = req.body;
    if (!projectRef || !repo || !number) return res.status(400).json({ error: 'project, repo, and number are required' });

    const project = resolveProject(projectRef);
    if (!project) return res.status(404).json({ error: `Project not found: ${projectRef}` });
    if (!isAgentMember(agentName, project.name)) return res.status(403).json({ error: `Agent ${agentName} is not a member of project ${project.name}` });

    const resolved = resolveVcsIntegration(project.id);
    if (!resolved) return res.status(404).json({ error: `No active VCS integration for project: ${project.name}` });

    const { integration, provider, repos: configRepos } = resolved;
    if (!provider.mergePR) return res.status(501).json({ error: `Provider ${integration.provider} does not support mergePR` });
    if (!validateRepo(configRepos, repo)) return res.status(403).json({ error: `Repo ${repo} is not configured for project ${project.name}` });

    const result = await provider.mergePR(integration.authConfig, repo, number, method || 'squash', commitTitle, commitMessage);
    auditLog(agentName, project.name, 'merge', `${repo}#${number} (${method || 'squash'})`);
    res.json({ ok: true, sha: result.sha });
  } catch (err) { next(err); }
});

// Update a PR
registerToolDef({
  category: 'issues',
  name: 'armada_pr_update',
  description: 'Update a pull request (title, body, state, labels, assignees)',
  method: 'POST',
  path: '/api/proxy/prs/update',
  parameters: [
    { name: 'project', type: 'string', description: 'Project ID or name', required: true },
    { name: 'repo', type: 'string', description: 'Repository full name (owner/repo)', required: true },
    { name: 'number', type: 'number', description: 'PR number', required: true },
    { name: 'title', type: 'string', description: 'New PR title' },
    { name: 'body', type: 'string', description: 'New PR description' },
    { name: 'state', type: 'string', description: 'New state: open or closed' },
    { name: 'draft', type: 'boolean', description: 'Convert to/from draft' },
    { name: 'labels', type: 'string', description: 'JSON array of label names (replaces all)' },
    { name: 'assignees', type: 'string', description: 'JSON array of assignee usernames' },
  ],
    scope: 'prs:write',
});

router.post('/update', requireScope('prs:write'), async (req, res, next) => {
  try {
    const agentName = (req.caller as any)?.agentName ?? null;
    const { project: projectRef, repo, number, title, body, state, draft, labels, assignees } = req.body;
    if (!projectRef || !repo || !number) return res.status(400).json({ error: 'project, repo, and number are required' });

    const project = resolveProject(projectRef);
    if (!project) return res.status(404).json({ error: `Project not found: ${projectRef}` });
    if (!isAgentMember(agentName, project.name)) return res.status(403).json({ error: `Agent ${agentName} is not a member of project ${project.name}` });

    const resolved = resolveVcsIntegration(project.id);
    if (!resolved) return res.status(404).json({ error: `No active VCS integration for project: ${project.name}` });

    const { integration, provider, repos: configRepos } = resolved;
    if (!provider.updatePR) return res.status(501).json({ error: `Provider ${integration.provider} does not support updatePR` });
    if (!validateRepo(configRepos, repo)) return res.status(403).json({ error: `Repo ${repo} is not configured for project ${project.name}` });

    // Parse array fields
    const parsedLabels = labels ? (Array.isArray(labels) ? labels : JSON.parse(labels)) : undefined;
    const parsedAssignees = assignees ? (Array.isArray(assignees) ? assignees : JSON.parse(assignees)) : undefined;

    const updates: Record<string, any> = {};
    if (title !== undefined) updates.title = title;
    if (body !== undefined) updates.body = body;
    if (state !== undefined) updates.state = state;
    if (draft !== undefined) updates.draft = draft;
    if (parsedLabels !== undefined) updates.labels = parsedLabels;
    if (parsedAssignees !== undefined) updates.assignees = parsedAssignees;

    const pr = await provider.updatePR(integration.authConfig, repo, number, updates);
    auditLog(agentName, project.name, 'update', `${repo}#${number}`);
    res.json(pr);
  } catch (err) { next(err); }
});

export default router;
