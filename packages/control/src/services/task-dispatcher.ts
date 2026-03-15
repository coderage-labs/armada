import { agentsRepo, instancesRepo } from '../repositories/index.js';
import { tasksRepo, projectsRepo, roleMetaRepo } from '../repositories/index.js';
import { emitTaskEvent } from '../routes/tasks.js';
import { logActivity } from './activity-service.js';
import { getAgentsByRoleWithCapacity } from './health-monitor.js';
import { getNodeClient } from '../infrastructure/node-client.js';

/**
 * Resolve the relay info to dispatch a task to a given agent via node relay.
 */
function resolveAgentRelay(agentName: string): { containerName: string; nodeId: string; targetAgent: string } {
  const agent = agentsRepo.getAll().find(a => a.name === agentName);
  if (!agent) {
    throw new Error(`Agent not found: ${agentName}`);
  }
  if (!agent.instanceId) {
    throw new Error(`Agent ${agentName} has no instanceId — all agents must belong to an instance`);
  }
  const instance = instancesRepo.getById(agent.instanceId);
  if (!instance?.nodeId) {
    throw new Error(`Instance ${agent.instanceId} for agent ${agentName} not found or has no nodeId`);
  }
  return { containerName: `armada-instance-${instance.name}`, nodeId: instance.nodeId, targetAgent: agentName };
}

/**
 * Build a task message enriched with project context.
 */
function buildTaskMessage(task: any, project: any): string {
  const parts: string[] = [task.taskText];

  // Add project context
  if (project.contextMd) {
    parts.push(`\n\n---\n## Project Context\n${project.contextMd}`);
  }

  // Add repo info
  const config = JSON.parse(project.configJson || '{}');
  const repos: Array<{ url: string; defaultBranch?: string }> = config.repositories || [];
  if (repos.length > 0) {
    parts.push('\n## Repositories');
    for (const repo of repos) {
      const branch = repo.defaultBranch || 'main';
      parts.push(`- \`${repo.url}\` (branch: \`${branch}\`) — clone with \`git clone https://github.com/${repo.url}\` then \`git checkout ${branch}\``);
    }
  }

  return parts.join('\n');
}

/**
 * Resolve the manager-tier agent for a project.
 * Manager = agent whose role has tier === 1 in role_metadata.
 * When multiple managers exist, picks the one with the most available capacity.
 */
function resolveProjectManager(projectId: string): { name: string; role: string } | null {
  const project = projectsRepo.get(projectId);
  if (!project) return null;

  const members = projectsRepo.getMembers(project.id);
  const agents = agentsRepo.getAll();
  const roles = roleMetaRepo.getAll();

  // Collect all manager-tier candidates
  const managerCandidates: Array<{ name: string; role: string }> = [];
  for (const memberName of members) {
    const agent = agents.find(a => a.name === memberName);
    if (!agent?.role) continue;
    const meta = roles.find(r => r.role === agent.role);
    if (meta?.tier === 1) {
      managerCandidates.push({ name: agent.name, role: agent.role });
    }
  }

  if (managerCandidates.length === 0) return null;
  if (managerCandidates.length === 1) return managerCandidates[0];

  // Multiple managers — pick by capacity (least busy first)
  const memberSet = new Set(managerCandidates.map(c => c.name));
  const roleSet = new Set(managerCandidates.map(c => c.role));

  for (const role of roleSet) {
    const sorted = getAgentsByRoleWithCapacity(role);
    for (const candidate of sorted) {
      if (memberSet.has(candidate.name)) {
        const match = managerCandidates.find(c => c.name === candidate.name);
        if (match) return match;
      }
    }
  }

  // Fallback to first candidate if capacity data unavailable
  return managerCandidates[0];
}

/**
 * Count in-progress tasks for a project.
 */
function countInProgress(projectName: string): number {
  const tasks = tasksRepo.getByProject(projectName);
  return tasks.filter(t => t.boardColumn === 'in-progress').length;
}

/**
 * Get queued tasks for a project, ordered by created_at ASC (FIFO).
 */
function getQueuedTasks(projectName: string): ReturnType<typeof tasksRepo.getByProject> {
  const tasks = tasksRepo.getByProject(projectName);
  return tasks
    .filter(t => t.boardColumn === 'queued')
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
}

/**
 * Dispatch a single task to the project manager.
 */
async function dispatchTaskToPM(
  task: ReturnType<typeof tasksRepo.getById> & {},
  pm: { name: string; role: string },
  project: { name: string },
): Promise<boolean> {
  const agent = agentsRepo.getAll().find(a => a.name === pm.name);
  if (!agent || agent.status !== 'running') return false;

  const { containerName, nodeId, targetAgent } = resolveAgentRelay(pm.name);
  const controlPlaneUrl = process.env.ARMADA_API_URL || 'http://armada-control:3001';

  // Update the existing task to assign it to the PM
  tasksRepo.update(task.id, {
    toAgent: pm.name,
    status: 'pending',
    boardColumn: 'in-progress',
  });
  const updated = tasksRepo.getById(task.id);
  if (updated) emitTaskEvent('task:updated', updated);

  try {
    const node = getNodeClient(nodeId);
    const body = JSON.stringify({
      taskId: task.id,
      from: 'armada-dispatcher',
      fromRole: 'operator',
      message: buildTaskMessage(task, project),
      project: project.name,
      callbackUrl: `${controlPlaneUrl}/api/tasks/${task.id}/result`,
      targetAgent,
    });

    const resp = await node.relayRequest(containerName, 'POST', '/armada/task', body) as any;
    const status = resp?.statusCode ?? resp?.status ?? 200;

    if (status >= 400) {
      tasksRepo.update(task.id, { status: 'failed', result: `Dispatch failed: ${status}`, boardColumn: 'queued' });
      const failed = tasksRepo.getById(task.id);
      if (failed) emitTaskEvent('task:updated', failed);
      return false;
    }

    tasksRepo.update(task.id, { status: 'running' });
    const running = tasksRepo.getById(task.id);
    if (running) emitTaskEvent('task:updated', running);

    logActivity({
      eventType: 'task.dispatched',
      agentName: pm.name,
      detail: `Dispatched task ${task.id} to ${pm.name} for project "${project.name}"`,
    });

    return true;
  } catch (err: any) {
    tasksRepo.update(task.id, { status: 'failed', result: `Dispatch error: ${err.message}`, boardColumn: 'queued' });
    const failed = tasksRepo.getById(task.id);
    if (failed) emitTaskEvent('task:updated', failed);
    return false;
  }
}

/**
 * Check capacity and dispatch queued tasks for a project.
 */
export async function checkAndDispatch(projectName: string): Promise<number> {
  const project = projectsRepo.getByName(projectName);
  if (!project) return 0;

  const pm = resolveProjectManager(project.id);
  if (!pm) return 0;

  const maxConcurrent = project.maxConcurrent || 3;
  let inProgress = countInProgress(projectName);
  const queued = getQueuedTasks(projectName);
  let dispatched = 0;

  for (const task of queued) {
    if (inProgress >= maxConcurrent) break;
    const ok = await dispatchTaskToPM(task, pm, project);
    if (ok) {
      dispatched++;
      inProgress++;
    }
  }

  return dispatched;
}

/**
 * Handle task completion — check if we can dispatch next queued task.
 * Call this when a task with a projectId moves to done/review/completed/failed.
 */
export async function onTaskCompleted(task: { id: string; status?: string; projectId?: string | null; boardColumn?: string | null; result?: string | null }): Promise<void> {
  if (!task.projectId) return;

  // Auto-move completed tasks to review column — "done" is manual after PR merge
  if (task.boardColumn === 'in-progress' && task.status !== 'failed') {
    tasksRepo.updateBoardColumn(task.id, 'review');
    const updated = tasksRepo.getById(task.id);
    if (updated) emitTaskEvent('task:updated', updated);
  }

  // Check queue for next task
  await checkAndDispatch(task.projectId);
}
