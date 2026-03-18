// ── Issue Proxy Routes ──────────────────────────────────────────────
// Agents call these to interact with external issue trackers without
// ever seeing credentials. Armada resolves project → integration → adapter.

import { Router } from 'express';
import { requireScope } from '../middleware/scopes.js';
import { getProvider } from '../services/integrations/registry.js';
import { integrationsRepo } from '../services/integrations/integrations-repo.js';
import { projectIntegrationsRepo } from '../services/integrations/project-integrations-repo.js';
import { agentsRepo, templatesRepo } from '../repositories/index.js';
import { projectsRepo } from '../repositories/index.js';
import { logActivity } from '../services/activity-service.js';
import { registerToolDef } from '../utils/tool-registry.js';

const router = Router();

/* ── Helpers ──────────────────────────────────────────────────────── */

/** Resolve a project by ID or name */
function resolveProject(projectRef: string) {
  return projectsRepo.get(projectRef) ?? projectsRepo.getByName?.(projectRef) ?? null;
}

/** Find the issues integration for a project */
function resolveIssueIntegration(projectId: string) {
  const pis = projectIntegrationsRepo.getByProject(projectId);
  const issuePI = pis.find(pi => pi.capability === 'issues' && pi.enabled);
  if (!issuePI) return null;

  const integration = integrationsRepo.getById(issuePI.integrationId);
  if (!integration || integration.status !== 'active') return null;

  const provider = getProvider(integration.provider);
  if (!provider) return null;

  return { projectIntegration: issuePI, integration, provider };
}

/** Check if an agent is a member of a project */
function isAgentMember(agentName: string | null, projectName: string): boolean {
  if (agentName === null) return true; // Human callers always allowed through — not subject to per-project agent membership checks
  const agents = agentsRepo.getAll();
  const agent = agents.find(a => a.name === agentName);
  if (!agent) return true; // Not a agent (e.g., operator instance) — allow through
  if (!agent.templateId) return false;
  const tmpl = templatesRepo.getById(agent.templateId);
  if (!tmpl) return false;
  return ((tmpl as any).projects ?? []).includes(projectName);
}

/** Log a proxy action for audit trail */
function auditLog(agent: string, project: string, action: string, detail?: string) {
  logActivity({
    eventType: 'proxy.issue',
    detail: `[${agent}] ${action} on ${project}${detail ? `: ${detail}` : ''}`,
  });
}

/* ── Routes ───────────────────────────────────────────────────────── */

// List issues for a project
registerToolDef({
  category: 'issues',
  name: 'armada_issue_list',
  description: 'List issues from a project\'s connected issue tracker',
  method: 'POST',
  path: '/api/proxy/issues/list',
  parameters: [
    { name: 'project', type: 'string', description: 'Project ID or name', required: true },
    { name: 'labels', type: 'string', description: 'Comma-separated label filter' },
    { name: 'statuses', type: 'string', description: 'Comma-separated status filter' },
    { name: 'assignees', type: 'string', description: 'Comma-separated assignee filter' },
    { name: 'types', type: 'string', description: 'Comma-separated issue type filter' },
    { name: 'cursor', type: 'string', description: 'Pagination cursor from previous response' },
  ],
    scope: 'integrations:write',
});

router.post('/list', async (req, res, next) => {
  try {
    const agentName = (req.caller as any)?.agentName ?? null;
    const { project: projectRef, labels, statuses, assignees, types, cursor } = req.body;
    if (!projectRef) return res.status(400).json({ error: 'project is required' });

    const project = resolveProject(projectRef);
    if (!project) return res.status(404).json({ error: `Project not found: ${projectRef}` });
    if (!isAgentMember(agentName, project.name)) return res.status(403).json({ error: `Agent ${agentName} is not a member of project ${project.name}` });

    const resolved = resolveIssueIntegration(project.id);
    if (!resolved) return res.status(404).json({ error: `No active issues integration for project: ${project.name}` });

    const { projectIntegration, integration, provider } = resolved;

    // Build filters from project-integration config + request overrides
    const piConfig = projectIntegration.config || {};
    const filters = {
      projects: piConfig.projectKeys ? (piConfig.projectKeys as string).split(',').map((s: string) => s.trim()) : undefined,
      labels: labels ? labels.split(',').map((s: string) => s.trim()) : piConfig.labels ? (piConfig.labels as string).split(',').map((s: string) => s.trim()) : undefined,
      statuses: statuses ? statuses.split(',').map((s: string) => s.trim()) : piConfig.statuses ? (piConfig.statuses as string).split(',').map((s: string) => s.trim()) : undefined,
      assignees: assignees ? assignees.split(',').map((s: string) => s.trim()) : piConfig.assignees ? (piConfig.assignees as string).split(',').map((s: string) => s.trim()) : undefined,
      types: types ? types.split(',').map((s: string) => s.trim()) : piConfig.issueTypes ? (piConfig.issueTypes as string).split(',').map((s: string) => s.trim()) : undefined,
    };

    const result = await provider.fetchIssues(integration.authConfig, filters, cursor);
    auditLog(agentName, project.name, 'list', `${result.issues.length} issues`);
    res.json(result);
  } catch (err) { next(err); }
});

// Get a single issue
registerToolDef({
  category: 'issues',
  name: 'armada_issue_get',
  description: 'Get full details of a specific issue',
  method: 'POST',
  path: '/api/proxy/issues/get',
  parameters: [
    { name: 'project', type: 'string', description: 'Project ID or name', required: true },
    { name: 'issueKey', type: 'string', description: 'Issue key (e.g., FIX-123, owner/repo#45)', required: true },
  ],
    scope: 'integrations:write',
});

router.post('/get', async (req, res, next) => {
  try {
    const agentName = (req.caller as any)?.agentName ?? null;
    const { project: projectRef, issueKey } = req.body;
    if (!projectRef || !issueKey) return res.status(400).json({ error: 'project and issueKey are required' });

    const project = resolveProject(projectRef);
    if (!project) return res.status(404).json({ error: `Project not found: ${projectRef}` });
    if (!isAgentMember(agentName, project.name)) return res.status(403).json({ error: `Agent ${agentName} is not a member of project ${project.name}` });

    const resolved = resolveIssueIntegration(project.id);
    if (!resolved) return res.status(404).json({ error: `No active issues integration for project: ${project.name}` });

    const { integration, provider } = resolved;
    if (!provider.getIssue) return res.status(501).json({ error: `Provider ${integration.provider} does not support getIssue` });

    const issue = await provider.getIssue(integration.authConfig, issueKey);
    auditLog(agentName, project.name, 'get', issueKey);
    res.json(issue);
  } catch (err) { next(err); }
});

// Add a comment to an issue
registerToolDef({
  category: 'issues',
  name: 'armada_issue_comment',
  description: 'Add a comment to an issue',
  method: 'POST',
  path: '/api/proxy/issues/comment',
  parameters: [
    { name: 'project', type: 'string', description: 'Project ID or name', required: true },
    { name: 'issueKey', type: 'string', description: 'Issue key', required: true },
    { name: 'comment', type: 'string', description: 'Comment text', required: true },
  ],
    scope: 'integrations:write',
});

router.post('/comment', requireScope('integrations:write'), async (req, res, next) => {
  try {
    const agentName = (req.caller as any)?.agentName ?? null;
    const { project: projectRef, issueKey, comment } = req.body;
    if (!projectRef || !issueKey || !comment) return res.status(400).json({ error: 'project, issueKey, and comment are required' });

    const project = resolveProject(projectRef);
    if (!project) return res.status(404).json({ error: `Project not found: ${projectRef}` });
    if (!isAgentMember(agentName, project.name)) return res.status(403).json({ error: `Agent ${agentName} is not a member of project ${project.name}` });

    const resolved = resolveIssueIntegration(project.id);
    if (!resolved) return res.status(404).json({ error: `No active issues integration for project: ${project.name}` });

    const { integration, provider } = resolved;
    if (!provider.addComment) return res.status(501).json({ error: `Provider ${integration.provider} does not support addComment` });

    await provider.addComment(integration.authConfig, issueKey, comment);
    auditLog(agentName, project.name, 'comment', issueKey);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// Transition/change issue status
registerToolDef({
  category: 'issues',
  name: 'armada_issue_transition',
  description: 'Change the status of an issue',
  method: 'POST',
  path: '/api/proxy/issues/transition',
  parameters: [
    { name: 'project', type: 'string', description: 'Project ID or name', required: true },
    { name: 'issueKey', type: 'string', description: 'Issue key', required: true },
    { name: 'status', type: 'string', description: 'Target status', required: true },
  ],
    scope: 'integrations:write',
});

router.post('/transition', requireScope('integrations:write'), async (req, res, next) => {
  try {
    const agentName = (req.caller as any)?.agentName ?? null;
    const { project: projectRef, issueKey, status } = req.body;
    if (!projectRef || !issueKey || !status) return res.status(400).json({ error: 'project, issueKey, and status are required' });

    const project = resolveProject(projectRef);
    if (!project) return res.status(404).json({ error: `Project not found: ${projectRef}` });
    if (!isAgentMember(agentName, project.name)) return res.status(403).json({ error: `Agent ${agentName} is not a member of project ${project.name}` });

    const resolved = resolveIssueIntegration(project.id);
    if (!resolved) return res.status(404).json({ error: `No active issues integration for project: ${project.name}` });

    const { integration, provider } = resolved;
    if (!provider.updateIssueStatus) return res.status(501).json({ error: `Provider ${integration.provider} does not support status transitions` });

    await provider.updateIssueStatus(integration.authConfig, issueKey, status);
    auditLog(agentName, project.name, 'transition', `${issueKey} → ${status}`);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// Search issues (provider-specific query)
registerToolDef({
  category: 'issues',
  name: 'armada_issue_search',
  description: 'Search issues using provider-specific query (JQL for Jira, query for GitHub)',
  method: 'POST',
  path: '/api/proxy/issues/search',
  parameters: [
    { name: 'project', type: 'string', description: 'Project ID or name', required: true },
    { name: 'query', type: 'string', description: 'Search query (JQL for Jira, query string for GitHub)', required: true },
    { name: 'cursor', type: 'string', description: 'Pagination cursor' },
  ],
    scope: 'integrations:write',
});

router.post('/search', async (req, res, next) => {
  try {
    const agentName = (req.caller as any)?.agentName ?? null;
    const { project: projectRef, query, cursor } = req.body;
    if (!projectRef || !query) return res.status(400).json({ error: 'project and query are required' });

    const project = resolveProject(projectRef);
    if (!project) return res.status(404).json({ error: `Project not found: ${projectRef}` });
    if (!isAgentMember(agentName, project.name)) return res.status(403).json({ error: `Agent ${agentName} is not a member of project ${project.name}` });

    const resolved = resolveIssueIntegration(project.id);
    if (!resolved) return res.status(404).json({ error: `No active issues integration for project: ${project.name}` });

    const { integration, provider } = resolved;

    // For search, we pass the raw query through filters.projects as the search mechanism
    // Provider adapters should handle raw query strings
    const result = await provider.fetchIssues(integration.authConfig, { projects: [query] }, cursor);
    auditLog(agentName, project.name, 'search', query);
    res.json(result);
  } catch (err) { next(err); }
});

export default router;
