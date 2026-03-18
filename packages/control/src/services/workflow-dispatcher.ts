/**
 * Workflow Dispatcher — wires the workflow engine to actual task dispatch.
 * 
 * Resolves role → agent, sends tasks, handles completion callbacks.
 */

import { agentsRepo, instancesRepo, projectsRepo } from '../repositories/index.js';
import { tasksRepo } from '../repositories/index.js';
import { setWorkflowDispatcher, setWorkflowNotifier, onStepCompleted } from './workflow-engine.js';
import { getAgentsByRoleWithCapacity } from './health-monitor.js';
import { notifyGate, notifyCompletion } from './user-notifier.js';
import { getNodeClient } from '../infrastructure/node-client.js';
import { createWorktree, mergeWorktree, cleanupWorktree } from './worktree-service.js';

const CONTROL_PLANE_URL = process.env.ARMADA_API_URL || 'http://armada-control:3001';

// ── Worktree task registry ──────────────────────────────────────────

interface WorktreeTaskEntry {
  nodeId: string;
  worktreePath: string;
  stepId: string;
}

/** Map of taskId → worktree info for tasks that have an active worktree */
const _worktreeTasks = new Map<string, WorktreeTaskEntry>();

/**
 * Find the least busy running agent with the given role.
 * Uses capacity data from the health monitor for load balancing:
 * sorted by healthy first, then lowest taskCount, then lowest responseMs.
 *
 * When the agent belongs to a multi-agent instance, returns the instance URL
 * plus targetAgent so the receiving instance can route correctly.
 */
function findAgentByRole(role: string): { name: string; url: string; targetAgent?: string } | null {
  const candidates = getAgentsByRoleWithCapacity(role);
  if (candidates.length === 0) return null;

  // Already sorted by capacity (healthy first, lowest taskCount, lowest responseMs)
  return {
    name: candidates[0].name,
    url: candidates[0].url,
    // If the agent belongs to an instance (instanceId set), include targetAgent for multiplexing
    targetAgent: candidates[0].instanceId ? candidates[0].name : undefined,
  };
}

/**
 * Initialize the workflow dispatcher — call once at startup.
 */
export function initWorkflowDispatcher() {
  setWorkflowDispatcher(async (opts) => {
    const agent = findAgentByRole(opts.role);
    // Resolve project UUID → project name (tasks table stores name as project_id)
    const projectName = opts.projectId
      ? (projectsRepo.get(opts.projectId)?.name ?? opts.projectId)
      : undefined;

    if (!agent) {
      const errMsg = `No running agent with role "${opts.role}" available`;
      // Create the task record as failed so checkWorkflowStep can advance the workflow
      tasksRepo.create({
        id: opts.taskId,
        fromAgent: 'workflow-engine',
        toAgent: opts.role,
        taskText: opts.message.slice(0, 5000),
        result: errMsg,
        status: 'failed',
        workflowRunId: opts.runId,
        projectId: projectName,
      });
      checkWorkflowStep(opts.taskId, 'failed', errMsg);
      return { error: errMsg };
    }

    // Record task in DB
    tasksRepo.create({
      id: opts.taskId,
      fromAgent: 'workflow-engine',
      toAgent: agent.name,
      taskText: opts.message.slice(0, 5000),
      result: null,
      status: 'pending',
      workflowRunId: opts.runId,
      projectId: projectName,
    });

    // Dispatch via node relay (routes through node agent → container)
    try {
      const agentRecord = agentsRepo.getAll().find(a => a.name === agent.name);
      const instance = agentRecord?.instanceId ? instancesRepo.getById(agentRecord.instanceId) : undefined;
      if (!instance?.nodeId) {
        const errMsg = `Agent ${agent.name} has no instance or node`;
        tasksRepo.update(opts.taskId, { status: 'failed', result: 'No instance/node for agent' });
        checkWorkflowStep(opts.taskId, 'failed', errMsg);
        return { error: errMsg };
      }

      const containerName = `armada-instance-${instance.name}`;
      const node = getNodeClient(instance.nodeId);

      // ── Git worktree isolation ─────────────────────────────────────
      let worktreeContext = '';
      if (opts.isolateGit) {
        // Derive repo path from the project's first repository (cloneDir or a default)
        const project = opts.projectId ? projectsRepo.get(opts.projectId) : null;
        const repoPath = project?.repositories?.[0]?.cloneDir
          || (project?.repositories?.[0]?.url ? `/workspace/${project.name}` : null);

        if (repoPath) {
          try {
            const baseBranch = project?.repositories?.[0]?.defaultBranch || 'main';
            const wt = await createWorktree(
              instance.nodeId,
              repoPath,
              opts.stepId,
              opts.runId,
              baseBranch,
            );
            // Record worktree for post-completion merge+cleanup
            _worktreeTasks.set(opts.taskId, {
              nodeId: instance.nodeId,
              worktreePath: wt.worktreePath,
              stepId: opts.stepId,
            });
            worktreeContext = `\n\n[WORKTREE ISOLATION]\nYour isolated Git worktree is at: ${wt.worktreePath}\nWorking branch: ${wt.branch}\nAll code changes must be made in this directory.\n[END WORKTREE ISOLATION]`;
            console.log(`[workflow-dispatcher] Created worktree for step "${opts.stepId}" at ${wt.worktreePath}`);
          } catch (wtErr: any) {
            console.warn(`[workflow-dispatcher] Failed to create worktree for step "${opts.stepId}": ${wtErr.message}`);
            // Non-fatal — proceed without worktree isolation
          }
        } else {
          console.warn(`[workflow-dispatcher] isolateGit=true but no repoPath for project "${opts.projectId}" — skipping worktree`);
        }
      }

      // Use instance proxyUrl for callback so agents can reach the control plane through the node proxy
      const callbackBaseUrl = process.env.ARMADA_AGENT_GATEWAY_URL || 'http://armada-node:3002';
      const body = JSON.stringify({
        taskId: opts.taskId,
        from: 'workflow-engine',
        fromRole: 'operator',
        message: opts.message + worktreeContext,
        callbackUrl: `${callbackBaseUrl}/api/tasks/${opts.taskId}/result`,
        projectId: opts.projectId,
        ...(agent.targetAgent && { targetAgent: agent.targetAgent }),
      });

      const resp = await node.relayRequest(containerName, 'POST', '/armada/task', body) as any;
      const status = resp?.statusCode ?? resp?.status ?? 200;

      if (status >= 400) {
        const errBody = typeof resp?.body === 'string' ? resp.body : JSON.stringify(resp);
        const errMsg = `Agent ${agent.name} rejected task (${status})`;
        tasksRepo.update(opts.taskId, { status: 'failed', result: `Dispatch failed (${status}): ${errBody}` });
        // Cleanup worktree on dispatch failure
        await _cleanupWorktreeForTask(opts.taskId);
        checkWorkflowStep(opts.taskId, 'failed', errMsg);
        return { error: errMsg };
      }

      tasksRepo.update(opts.taskId, { status: 'running' });
      console.log(`[workflow-dispatcher] Dispatched step "${opts.stepId}" to ${agent.name} (${opts.role}) via relay — task ${opts.taskId}`);

      return { agentName: agent.name, armadaTaskId: opts.taskId };
    } catch (err: any) {
      const errMsg = `Failed to reach ${agent.name}: ${err.message}`;
      tasksRepo.update(opts.taskId, { status: 'failed', result: `Dispatch error: ${err.message}` });
      await _cleanupWorktreeForTask(opts.taskId);
      checkWorkflowStep(opts.taskId, 'failed', errMsg);
      return { error: errMsg };
    }
  });

  setWorkflowNotifier((opts) => {
    console.log(`[workflow-dispatcher] Notification: ${opts.type} for workflow "${opts.workflowName}"`);

    if (opts.type === 'gate') {
      notifyGate({
        workflowName: opts.workflowName,
        stepId: opts.stepId!,
        runId: opts.runId,
        previousOutput: opts.previousOutput || null,
        projectId: opts.projectId,
        gatePolicy: opts.gatePolicy,
      }).catch(err => {
        console.error(`[workflow-dispatcher] Failed to send gate notification:`, err);
      });
    } else if (opts.type === 'completed' || opts.type === 'failed') {
      notifyCompletion({
        workflowName: opts.workflowName,
        runId: opts.runId,
        status: opts.type,
        projectId: opts.projectId,
      }).catch(err => {
        console.error(`[workflow-dispatcher] Failed to send completion notification:`, err);
      });
    }
  });

  console.log('🔄 Workflow dispatcher initialized');
}

// ── Worktree helpers ────────────────────────────────────────────────

/**
 * Merge (if completed) and cleanup the worktree associated with a task.
 * Always runs cleanup even if merge fails — worktrees are ephemeral.
 */
async function _mergeAndCleanupWorktree(taskId: string, succeeded: boolean): Promise<void> {
  const entry = _worktreeTasks.get(taskId);
  if (!entry) return;

  if (succeeded) {
    try {
      const mergeResult = await mergeWorktree(entry.nodeId, entry.worktreePath);
      if (!mergeResult.merged) {
        console.warn(
          `[workflow-dispatcher] Merge conflicts for step "${entry.stepId}": ` +
          (mergeResult.conflicts?.join(', ') || 'unknown'),
        );
      } else {
        console.log(`[workflow-dispatcher] Merged worktree for step "${entry.stepId}"`);
      }
    } catch (err: any) {
      console.warn(`[workflow-dispatcher] Merge failed for step "${entry.stepId}": ${err.message}`);
    }
  }

  await _cleanupWorktreeForTask(taskId);
}

async function _cleanupWorktreeForTask(taskId: string): Promise<void> {
  const entry = _worktreeTasks.get(taskId);
  if (!entry) return;

  try {
    await cleanupWorktree(entry.nodeId, entry.worktreePath, entry.stepId);
    console.log(`[workflow-dispatcher] Cleaned up worktree for step "${entry.stepId}"`);
  } catch (err: any) {
    console.warn(`[workflow-dispatcher] Cleanup failed for step "${entry.stepId}": ${err.message}`);
  }
  // cleanupWorktree already removes from _activeWorktrees; remove from local map too
  _worktreeTasks.delete(taskId);
}

/**
 * Check if a completed task is a workflow step and advance the workflow.
 * Call this from the task result endpoint.
 */
export function checkWorkflowStep(taskId: string, status: string, result: string): boolean {
  if (!taskId.startsWith('wf-')) return false;

  // Get the task from the database to ensure we have the latest result
  // (the result parameter might be empty even if the task record has content)
  const task = tasksRepo.getById(taskId);
  const finalResult = task?.result || result || '';

  // Extract shared refs from result
  const sharedRefs: string[] = [];
  const sharedPattern = /\{\{shared:([^:}]+):([^}]+)\}\}/g;
  let match;
  while ((match = sharedPattern.exec(finalResult)) !== null) {
    sharedRefs.push(match[0]);
  }

  const stepStatus = status === 'completed' ? 'completed' : 'failed';
  const succeeded = stepStatus === 'completed';

  // Handle worktree merge + cleanup before advancing the workflow
  _mergeAndCleanupWorktree(taskId, succeeded)
    .catch(err => {
      console.error(`[workflow-dispatcher] Worktree merge/cleanup failed for task ${taskId}:`, err);
    })
    .finally(() => {
      onStepCompleted(taskId, stepStatus as any, finalResult, sharedRefs).catch(err => {
        console.error(`[workflow-dispatcher] Failed to advance workflow for task ${taskId}:`, err);
      });
    });

  return true;
}
