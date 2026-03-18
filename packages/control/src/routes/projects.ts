import { Router } from 'express';
import { requireScope } from '../middleware/scopes.js';
import { projectsRepo, tasksRepo, userProjectsRepo, usersRepo } from '../repositories/index.js';
import { parseJsonField } from '../utils/parse-json-field.js';
import { isValidName } from '../utils/validate.js';
import { getProjectMetrics } from '../services/project-service.js';
import { setupSSE } from '../utils/sse.js';
import { registerToolDef } from '../utils/tool-registry.js';
import { logActivity } from '../services/activity-service.js';
import { emitTaskEvent } from './tasks.js';
import { dispatchWebhook } from '../services/webhook-dispatcher.js';
import { syncProjectIssues, getCachedIssues } from '../services/github-sync.js';
import { isIssueTriaged } from '../services/triage.js';
import type { BoardColumn, MeshTask } from '@coderage-labs/armada-shared';

// ── SSE event bus for project events ────────────────────────────────

type ProjectEventType = 'project:created' | 'project:updated' | 'project:deleted';
type ProjectListener = (event: ProjectEventType, data: any) => void;

const projectListeners = new Set<ProjectListener>();

export function emitProjectEvent(event: ProjectEventType, data: any) {
  for (const listener of projectListeners) {
    try { listener(event, data); } catch (err: any) { console.warn('[projects] listener threw:', err.message); }
  }
  dispatchWebhook(event, data);
}

const router = Router();

// ── Tool definitions ─────────────────────────────────────────────────

registerToolDef({
  name: 'armada_projects_list',
  description: 'List all armada projects. Projects provide shared context for agent workstreams.',
  method: 'GET',
  path: '/api/projects',
  parameters: [
    { name: 'includeArchived', type: 'boolean', description: 'Include archived projects (default: false)' },
  ],
    scope: 'projects:read',
});

registerToolDef({
  name: 'armada_project_get',
  description: 'Get a single armada project by ID.',
  method: 'GET',
  path: '/api/projects/:id',
  parameters: [
    { name: 'id', type: 'string', description: 'Project ID', required: true },
  ],
    scope: 'projects:read',
});

registerToolDef({
  name: 'armada_project_create',
  description: 'Create a new armada project.',
  method: 'POST',
  path: '/api/projects',
  parameters: [
    { name: 'name', type: 'string', description: 'Project name (lowercase, alphanumeric, hyphens)', required: true },
    { name: 'description', type: 'string', description: 'Project description' },
    { name: 'context_md', type: 'string', description: 'Project context markdown' },
    { name: 'color', type: 'string', description: 'Project colour (hex)' },
    { name: 'icon', type: 'string', description: 'Project icon (emoji)' },
    { name: 'repositories', type: 'string', description: 'JSON array of {url, defaultBranch?, cloneDir?} repository objects' },
  ],
    scope: 'projects:write',
});

registerToolDef({
  name: 'armada_project_update',
  description: 'Update an existing armada project.',
  method: 'PUT',
  path: '/api/projects/:id',
  parameters: [
    { name: 'id', type: 'string', description: 'Project ID', required: true },
    { name: 'name', type: 'string', description: 'Project name' },
    { name: 'description', type: 'string', description: 'Project description' },
    { name: 'context_md', type: 'string', description: 'Project context markdown' },
    { name: 'color', type: 'string', description: 'Project colour (hex)' },
    { name: 'icon', type: 'string', description: 'Project icon (emoji)' },
    { name: 'repositories', type: 'string', description: 'JSON array of {url, defaultBranch?, cloneDir?} repository objects' },
  ],
    scope: 'projects:write',
});

registerToolDef({
  name: 'armada_project_delete',
  description: 'Delete a armada project.',
  method: 'DELETE',
  path: '/api/projects/:id',
  parameters: [
    { name: 'id', type: 'string', description: 'Project ID', required: true },
  ],
    scope: 'projects:write',
});

registerToolDef({
  name: 'armada_project_archive',
  description: 'Archive a armada project.',
  method: 'POST',
  path: '/api/projects/:id/archive',
  parameters: [
    { name: 'id', type: 'string', description: 'Project ID', required: true },
  ],
    scope: 'projects:write',
});

registerToolDef({
  name: 'armada_project_unarchive',
  description: 'Unarchive a armada project.',
  method: 'POST',
  path: '/api/projects/:id/unarchive',
  parameters: [
    { name: 'id', type: 'string', description: 'Project ID', required: true },
  ],
    scope: 'projects:write',
});

registerToolDef({
  name: 'armada_project_members',
  description: 'List agent members of a armada project.',
  method: 'GET',
  path: '/api/projects/:id/members',
  parameters: [
    { name: 'id', type: 'string', description: 'Project ID', required: true },
  ],
    scope: 'projects:read',
});

registerToolDef({
  name: 'armada_project_repos',
  description: 'List repositories linked to a armada project.',
  method: 'GET',
  path: '/api/projects/:id/repos',
  parameters: [
    { name: 'id', type: 'string', description: 'Project ID or name', required: true },
  ],
    scope: 'projects:read',
});

registerToolDef({
  name: 'armada_project_sync',
  description: 'Trigger a manual GitHub issue sync for a project. Imports open issues from linked repositories.',
  method: 'POST',
  path: '/api/projects/:id/sync',
  parameters: [
    { name: 'id', type: 'string', description: 'Project ID', required: true },
  ],
    scope: 'projects:write',
});

registerToolDef({
  name: 'armada_project_issues',
  description: 'Get cached GitHub issues for a project backlog. Returns issues not yet promoted to tasks.',
  method: 'GET',
  path: '/api/projects/:id/issues',
  parameters: [
    { name: 'id', type: 'string', description: 'Project ID or name', required: true },
  ],
    scope: 'projects:read',
});

registerToolDef({
  name: 'armada_project_board',
  description: 'Get the task board for a project, grouped by column (queued, in-progress, review, done).',
  method: 'GET',
  path: '/api/projects/:id/board',
  parameters: [
    { name: 'id', type: 'string', description: 'Project ID or name', required: true },
  ],
    scope: 'projects:read',
});

registerToolDef({
  name: 'armada_task_board_column',
  description: 'Move a task to a different board column.',
  method: 'PUT',
  path: '/api/tasks/:id/board-column',
  parameters: [
    { name: 'id', type: 'string', description: 'Task ID', required: true },
    { name: 'column', type: 'string', description: 'Target board column', required: true },
  ],
    scope: 'projects:write',
});

registerToolDef({
  name: 'armada_project_metrics',
  description: 'Get project-level metrics and stats: task/workflow counts by status, timing, GitHub issues, and recent activity.',
  method: 'GET',
  path: '/api/projects/:id/metrics',
  parameters: [
    { name: 'id', type: 'string', description: 'Project ID or name', required: true },
  ],
    scope: 'projects:read',
});

// ── Routes ───────────────────────────────────────────────────────────

// GET /api/projects/stream — SSE endpoint (must be before /:id routes)
router.get('/stream', (req, res) => {
  const sse = setupSSE(res);

  const listener: ProjectListener = (event, data) => {
    sse.send(event, data);
  };
  projectListeners.add(listener);

  req.on('close', () => {
    projectListeners.delete(listener);
  });
});

// GET /api/projects/:id/metrics — project-level metrics
router.get('/:id/metrics', (req, res) => {
  const metrics = getProjectMetrics(req.params.id);
  if (!metrics) { res.status(404).json({ error: 'Project not found' }); return; }
  res.json(metrics);
});

// GET /api/projects
router.get('/', (req, res) => {
  const includeArchived = req.query.includeArchived === 'true';
  res.json(projectsRepo.getAll(includeArchived));
});

// GET /api/projects/:id
router.get('/:id', (req, res) => {
  const project = projectsRepo.get(req.params.id) || projectsRepo.getByName(req.params.id);
  if (!project) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }
  res.json(project);
});

// POST /api/projects
router.post('/', requireScope('projects:write'), (req, res) => {
  const { name, description, context_md, color, icon, repositories, maxConcurrent } = req.body;
  if (!name) {
    res.status(400).json({ error: 'name is required' });
    return;
  }
  if (!isValidName(name)) {
    res.status(400).json({ error: 'name must be lowercase alphanumeric + hyphens, 1-63 chars' });
    return;
  }
  const existing = projectsRepo.getByName(name);
  if (existing) {
    res.status(409).json({ error: `Project "${name}" already exists` });
    return;
  }
  const project = projectsRepo.create({ name, description, context_md, color, icon, repositories: parseJsonField(repositories), maxConcurrent });
  logActivity({ eventType: 'project.created', detail: `Project "${name}" created` });
  emitProjectEvent('project:created', project);
  res.status(201).json(project);
});

// PUT /api/projects/:id
router.put('/:id', requireScope('projects:write'), (req, res) => {
  const project = projectsRepo.get(req.params.id);
  if (!project) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }
  const { name, description, context_md, color, icon, repositories, maxConcurrent } = req.body;
  if (name !== undefined && !isValidName(name)) {
    res.status(400).json({ error: 'name must be lowercase alphanumeric + hyphens, 1-63 chars' });
    return;
  }
  const updateData: Record<string, any> = { name, description, context_md, color, icon, repositories: parseJsonField(repositories) };
  if (maxConcurrent !== undefined) {
    updateData.maxConcurrent = Math.max(1, Math.min(20, Number(maxConcurrent) || 3));
  }
  const updated = projectsRepo.update(req.params.id, updateData);
  logActivity({ eventType: 'project.updated', detail: `Project "${updated.name}" updated` });
  emitProjectEvent('project:updated', updated);
  res.json(updated);
});

// DELETE /api/projects/:id
router.delete('/:id', requireScope('projects:write'), (req, res) => {
  const project = projectsRepo.get(req.params.id);
  if (!project) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }
  projectsRepo.delete(req.params.id);
  logActivity({ eventType: 'project.deleted', detail: `Project "${project.name}" deleted` });
  emitProjectEvent('project:deleted', { id: project.id, name: project.name });
  res.status(204).send();
});

// POST /api/projects/:id/archive
router.post('/:id/archive', requireScope('projects:write'), (req, res) => {
  const project = projectsRepo.get(req.params.id);
  if (!project) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }
  const updated = projectsRepo.update(req.params.id, { archived: true });
  logActivity({ eventType: 'project.archived', detail: `Project "${updated.name}" archived` });
  emitProjectEvent('project:updated', updated);
  res.json(updated);
});

// POST /api/projects/:id/unarchive
router.post('/:id/unarchive', requireScope('projects:write'), (req, res) => {
  const project = projectsRepo.get(req.params.id);
  if (!project) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }
  const updated = projectsRepo.update(req.params.id, { archived: false });
  logActivity({ eventType: 'project.unarchived', detail: `Project "${updated.name}" unarchived` });
  emitProjectEvent('project:updated', updated);
  res.json(updated);
});

// GET /api/projects/:id/members
router.get('/:id/members', (req, res) => {
  const project = projectsRepo.get(req.params.id);
  if (!project) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }
  const members = projectsRepo.getMembers(req.params.id);
  res.json({ members });
});

// GET /api/projects/:id/repos — list project repositories
router.get('/:id/repos', (req, res) => {
  const project = projectsRepo.get(req.params.id) || projectsRepo.getByName(req.params.id);
  if (!project) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }
  res.json({ repositories: project.repositories });
});

// POST /api/projects/:id/sync — trigger manual GitHub sync (refreshes issue cache)
router.post('/:id/sync', requireScope('projects:write'), async (req, res) => {
  const project = projectsRepo.get(req.params.id) || projectsRepo.getByName(req.params.id);
  if (!project) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }
  try {
    const result = await syncProjectIssues(project.id);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Sync failed' });
  }
});

// GET /api/projects/:id/issues — cached GitHub issues (?all=true skips task filtering)
router.get('/:id/issues', (req, res) => {
  const project = projectsRepo.get(req.params.id) || projectsRepo.getByName(req.params.id);
  if (!project) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }
  const cached = getCachedIssues(project.id);
  if (req.query.all === 'true') {
    res.json(cached);
    return;
  }
  // Filter out issues that already have a corresponding task OR are triaged
  const existingNumbers = new Set(tasksRepo.getGithubIssueNumbers(project.name));
  const filtered = cached.filter(i => !existingNumbers.has(i.number) && !isIssueTriaged(project.id, i.number));
  res.json(filtered);
});

// GET /api/projects/:id/board — get board tasks grouped by column (excludes backlog — use /issues for that)
router.get('/:id/board', (req, res) => {
  const project = projectsRepo.get(req.params.id) || projectsRepo.getByName(req.params.id);
  if (!project) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }
  const tasks = tasksRepo.getBoardTasks(project.name);
  const columns: Record<string, MeshTask[]> = {
    queued: [],
    'in-progress': [],
    review: [],
    done: [],
  };
  for (const task of tasks) {
    const col = task.boardColumn || 'queued';
    if (col in columns) {
      columns[col].push(task);
    }
    // Skip any leftover 'backlog' tasks — backlog is now GitHub issues only
  }
  res.json(columns);
});

// GET /api/projects/:id/context — serve context_md with repo info
router.get('/:id/context', (req, res) => {
  const project = projectsRepo.get(req.params.id) || projectsRepo.getByName(req.params.id);
  if (!project) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }

  let context = '';

  // Include repository info if any exist
  if (project.repositories.length > 0) {
    context += '**Repositories:**\n';
    for (const repo of project.repositories) {
      const branch = repo.defaultBranch ? ` (branch: ${repo.defaultBranch})` : '';
      const dir = repo.cloneDir ? ` → ${repo.cloneDir}` : '';
      context += `- ${repo.url}${branch}${dir}\n`;
    }
    context += '\n';
  }

  if (project.contextMd.trim()) {
    context += project.contextMd;
  }

  res.type('text/markdown').send(context);
});

// GET /api/projects/:id/users — list users assigned to project
router.get('/:id/users', (req, res) => {
  const project = projectsRepo.get(req.params.id) || projectsRepo.getByName(req.params.id);
  if (!project) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }
  const users = userProjectsRepo.getUsersForProject(project.id);
  res.json({ users });
});

// POST /api/projects/:id/users — assign user to project
router.post('/:id/users', requireScope('projects:write'), (req, res) => {
  const project = projectsRepo.get(req.params.id) || projectsRepo.getByName(req.params.id);
  if (!project) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }
  const { userId, role } = req.body;
  if (!userId) {
    res.status(400).json({ error: 'userId is required' });
    return;
  }
  const user = usersRepo.getById(userId);
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  if (role === 'owner') {
    userProjectsRepo.setOwner(userId, project.id);
  } else {
    userProjectsRepo.assign(userId, project.id, role);
  }
  const users = userProjectsRepo.getUsersForProject(project.id);
  res.json({ users });
});

// DELETE /api/projects/:id/users/:userId — remove user from project
router.delete('/:id/users/:userId', requireScope('projects:write'), (req, res) => {
  const project = projectsRepo.get(req.params.id) || projectsRepo.getByName(req.params.id);
  if (!project) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }
  userProjectsRepo.remove(req.params.userId, project.id);
  const users = userProjectsRepo.getUsersForProject(project.id);
  res.json({ users });
});

export default router;
