/**
 * Assignment routes — project responsibility assignments (#77)
 *
 * GET    /api/projects/:id/assignments          → list all assignments for project
 * PUT    /api/projects/:id/assignments/:type    → set assignment (upsert)
 * DELETE /api/projects/:id/assignments/:type    → remove assignment
 */
import { Router } from 'express';
import type { Request } from 'express';
import { requireScope } from '../middleware/scopes.js';
import { projectsRepo, assignmentRepo } from '../repositories/index.js';
import { registerToolDef } from '../utils/tool-registry.js';
import { logActivity } from '../services/activity-service.js';
import type { AssignmentType, AssigneeType } from '../repositories/assignment-repo.js';

const VALID_ASSIGNMENT_TYPES: AssignmentType[] = ['triager', 'approver', 'owner'];
const VALID_ASSIGNEE_TYPES: AssigneeType[] = ['user', 'agent', 'role'];

// Helper to extract merged params (id comes from parent route via mergeParams)
function getProjectId(req: Request): string {
  return (req.params as Record<string, string>).id ?? '';
}

const router = Router({ mergeParams: true });

// ── Tool definitions ─────────────────────────────────────────────────

registerToolDef({
  name: 'armada_project_assignments_list',
  description: 'List all responsibility assignments for a project (triager, approver, owner).',
  method: 'GET',
  path: '/api/projects/:id/assignments',
  parameters: [
    { name: 'id', type: 'string', description: 'Project ID', required: true },
  ],
  scope: 'projects:read',
});

registerToolDef({
  name: 'armada_project_assignment_set',
  description: 'Set a responsibility assignment for a project. Assignment types: triager, approver, owner. Assignee types: user, agent, role.',
  method: 'PUT',
  path: '/api/projects/:id/assignments/:type',
  parameters: [
    { name: 'id', type: 'string', description: 'Project ID', required: true },
    { name: 'type', type: 'string', description: 'Assignment type: triager | approver | owner', required: true },
    { name: 'assigneeType', type: 'string', description: 'Assignee type: user | agent | role', required: true },
    { name: 'assigneeId', type: 'string', description: 'Assignee identifier (user ID, agent name, or role name)', required: true },
  ],
  scope: 'projects:write',
});

registerToolDef({
  name: 'armada_project_assignment_remove',
  description: 'Remove a responsibility assignment from a project.',
  method: 'DELETE',
  path: '/api/projects/:id/assignments/:type',
  parameters: [
    { name: 'id', type: 'string', description: 'Project ID', required: true },
    { name: 'type', type: 'string', description: 'Assignment type: triager | approver | owner', required: true },
  ],
  scope: 'projects:write',
});

registerToolDef({
  name: 'armada_project_assignment_resolve',
  description: 'Resolve the effective assignee for a triager or approver slot, following the full priority chain.',
  method: 'GET',
  path: '/api/projects/:id/assignments/:type/resolve',
  parameters: [
    { name: 'id', type: 'string', description: 'Project ID', required: true },
    { name: 'type', type: 'string', description: 'Assignment type: triager | approver', required: true },
  ],
  scope: 'projects:read',
});

// ── Routes ───────────────────────────────────────────────────────────

// GET /api/projects/:id/assignments
router.get('/', (req, res) => {
  const projectId = getProjectId(req);
  const project = projectsRepo.get(projectId) || projectsRepo.getByName(projectId);
  if (!project) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }
  const assignments = assignmentRepo.getAssignmentsForProject(project.id);
  res.json({ assignments });
});

// PUT /api/projects/:id/assignments/:type
router.put('/:type', requireScope('projects:write'), (req, res) => {
  const projectId = getProjectId(req);
  const project = projectsRepo.get(projectId) || projectsRepo.getByName(projectId);
  if (!project) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }

  const assignmentType = req.params.type as AssignmentType;
  if (!VALID_ASSIGNMENT_TYPES.includes(assignmentType)) {
    res.status(400).json({ error: `Invalid assignment type. Must be one of: ${VALID_ASSIGNMENT_TYPES.join(', ')}` });
    return;
  }

  const { assigneeType, assigneeId } = req.body;
  if (!assigneeType || !assigneeId) {
    res.status(400).json({ error: 'assigneeType and assigneeId are required' });
    return;
  }
  if (!VALID_ASSIGNEE_TYPES.includes(assigneeType as AssigneeType)) {
    res.status(400).json({ error: `Invalid assigneeType. Must be one of: ${VALID_ASSIGNEE_TYPES.join(', ')}` });
    return;
  }

  const assignment = assignmentRepo.setAssignment(project.id, assignmentType, assigneeType as AssigneeType, assigneeId);
  logActivity({
    eventType: 'project.assignment.set',
    detail: `Project "${project.name}" ${assignmentType} set to ${assigneeType}:${assigneeId}`,
  });
  res.json({ assignment });
});

// DELETE /api/projects/:id/assignments/:type
router.delete('/:type', requireScope('projects:write'), (req, res) => {
  const projectId = getProjectId(req);
  const project = projectsRepo.get(projectId) || projectsRepo.getByName(projectId);
  if (!project) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }

  const assignmentType = req.params.type as AssignmentType;
  if (!VALID_ASSIGNMENT_TYPES.includes(assignmentType)) {
    res.status(400).json({ error: `Invalid assignment type. Must be one of: ${VALID_ASSIGNMENT_TYPES.join(', ')}` });
    return;
  }

  assignmentRepo.removeAssignment(project.id, assignmentType);
  logActivity({
    eventType: 'project.assignment.removed',
    detail: `Project "${project.name}" ${assignmentType} assignment removed`,
  });
  res.status(204).send();
});

// GET /api/projects/:id/assignments/:type/resolve
router.get('/:type/resolve', (req, res) => {
  const projectId = getProjectId(req);
  const project = projectsRepo.get(projectId) || projectsRepo.getByName(projectId);
  if (!project) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }

  const assignmentType = req.params.type as AssignmentType;
  if (!['triager', 'approver'].includes(assignmentType)) {
    res.status(400).json({ error: 'resolve only applies to triager and approver types' });
    return;
  }

  const resolved = assignmentType === 'triager'
    ? assignmentRepo.resolveTriager(project.id)
    : assignmentRepo.resolveApprover(project.id);

  res.json({ resolved });
});

export default router;
