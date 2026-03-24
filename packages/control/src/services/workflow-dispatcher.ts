/**
 * Workflow Dispatcher — wires the workflow engine to actual task dispatch.
 * 
 * Resolves role → agent, sends tasks, handles completion callbacks.
 */

import { agentsRepo, instancesRepo, projectsRepo } from '../repositories/index.js';
import { tasksRepo } from '../repositories/index.js';
import { setWorkflowDispatcher, setWorkflowNotifier, setWorkspaceCleanupFn, onStepCompleted } from './workflow-engine.js';
import { getAgentsByRoleWithCapacity } from './health-monitor.js';
import { notifyGate, notifyCompletion } from './user-notifier.js';
import { getNodeClient } from '../infrastructure/node-client.js';
import { createWorktree, mergeWorktree, cleanupWorktree } from './worktree-service.js';

const CONTROL_PLANE_URL = process.env.ARMADA_API_URL || 'http://armada-control:3001';

// ── Retry helpers ────────────────────────────────────────────────────

/**
 * Retry a function with exponential backoff on retryable errors.
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  delays: number[] = [5000, 15000, 30000],
  shouldRetry?: (error: any) => boolean,
): Promise<T> {
  let lastError: Error;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err;
      if (attempt < maxRetries && (!shouldRetry || shouldRetry(err))) {
        const delay = delays[attempt] || delays[delays.length - 1];
        console.log(`[workflow-dispatcher] Retry ${attempt + 1}/${maxRetries} in ${delay}ms: ${err.message}`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastError!;
}

/**
 * Check if an error is retryable (connection/network related).
 */
function isRetryableError(err: any): boolean {
  const msg = (err.message || '').toLowerCase();
  return msg.includes('not connected') || 
         msg.includes('connection refused') || 
         msg.includes('socket hang up') ||
         msg.includes('timeout') ||
         msg.includes('econnreset') ||
         msg.includes('disconnected') ||
         msg.includes('unreachable');
}

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
 * If multiple agents match, prefer the one with higher review scores for this role.
 *
 * When the agent belongs to a multi-agent instance, returns the instance URL
 * plus targetAgent so the receiving instance can route correctly.
 */
async function findAgentByRole(role: string, category?: string): Promise<{ name: string; url: string; targetAgent?: string } | null> {
  const candidates = getAgentsByRoleWithCapacity(role);
  if (candidates.length === 0) return null;

  // If multiple candidates exist and we have a category, prefer higher-scoring agents
  if (candidates.length > 1 && category) {
    const { getDrizzle } = await import('../db/drizzle.js');
    const { agentScores } = await import('../db/drizzle-schema.js');
    const { eq, and } = await import('drizzle-orm');
    
    const db = getDrizzle();
    const cat = category || role; // Use role as fallback category
    
    // Fetch scores for all candidates
    const candidateNames = candidates.map(c => c.name);
    const scores = db.select()
      .from(agentScores)
      .where(eq(agentScores.category, cat))
      .all();
    
    // Build score map
    const scoreMap = new Map<string, number>();
    for (const score of scores) {
      if (candidateNames.includes(score.agentId)) {
        scoreMap.set(score.agentId, score.avgScore || 0);
      }
    }
    
    // Sort candidates: first by score (desc), then by capacity
    candidates.sort((a, b) => {
      const scoreA = scoreMap.get(a.name) || 0;
      const scoreB = scoreMap.get(b.name) || 0;
      
      if (scoreA !== scoreB) return scoreB - scoreA; // Higher score first
      
      // Fall back to capacity sort
      if (a.taskCount !== b.taskCount) return a.taskCount - b.taskCount;
      return a.responseMs - b.responseMs;
    });
  }

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
    // Use role as category for skill-level routing (Phase 3 enhancement)
    const agent = await findAgentByRole(opts.role, opts.role);
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

      // ── Workspace pre-provisioning ────────────────────────────────────
      // For development steps with an issueRepo, clone the repo into the
      // instance container before sending the task so the agent can start
      // work immediately without needing to clone manually.
      let discoveryContext = '';
      // Resolve the repo for this step: step.repo > vars.issueRepo
      const stepRepo = (opts as any).stepRepo as string | undefined;
      const targetRepo = stepRepo || opts.vars?.issueRepo as string | undefined;
      if (opts.role === 'development' && targetRepo) {
        const issueNumber = opts.vars?.issueNumber as number | undefined;
        const issueTitle = opts.vars?.issueTitle as string | undefined;
        const repoName = targetRepo.split('/').pop() || 'work';
        const slugTitle = issueTitle
          ? issueTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30).replace(/-+$/, '')
          : 'impl';
        const branch = `feature/${issueNumber ? `${issueNumber}-` : ''}${slugTitle}`;
        let workPath: string | undefined;
        try {
          const wsNode = getNodeClient(instance.nodeId);
          // Wrap provisioning with retry logic for reconnection resilience
          const provisionResult = await withRetry(
            async () => wsNode.provisionWorkspace(instance.name, {
              repo: targetRepo,
              branch,
              stepId: opts.stepId,
              runId: opts.runId,
              installCmd: undefined, // Let the node discover from armada.json
            }),
            3,
            [5000, 15000, 30000],
            isRetryableError,
          );
          workPath = provisionResult.path;
          console.log(`[workflow-dispatcher] Provisioned worktree for step "${opts.stepId}": ${workPath} (branch: ${branch})`);

          // Run workspace discovery after clone to inject stack info into the task prompt
          try {
            const discovery = await wsNode.discoverWorkspace(instance.name, workPath);
            const lines: string[] = [];

            if (discovery.rootConfig) {
              lines.push('[WORKSPACE CONFIG]');
              const cfg = discovery.rootConfig;
              if (cfg.install) lines.push(`Install: ${cfg.install}`);
              if (cfg.verify) lines.push(`Verify: ${cfg.verify}`);
              if (cfg.test) lines.push(`Test: ${cfg.test}`);
              if (cfg.context) lines.push(`Context: ${cfg.context}`);
              if (cfg.conventions) lines.push(`Conventions: ${cfg.conventions}`);
              lines.push('[END WORKSPACE CONFIG]');
            }

            if (discovery.detected.length > 0) {
              lines.push('[DETECTED STACKS]');
              for (const pkg of discovery.detected) {
                const cfgParts: string[] = [];
                if (pkg.buildConfig.verify) cfgParts.push(`verify: ${pkg.buildConfig.verify}`);
                if (pkg.buildConfig.test) cfgParts.push(`test: ${pkg.buildConfig.test}`);
                lines.push(`- ${pkg.path} (${pkg.stack})${cfgParts.length ? ': ' + cfgParts.join(', ') : ''}`);
              }
              lines.push('[END DETECTED STACKS]');
            }

            if (lines.length > 0) {
              discoveryContext = '\n\n' + lines.join('\n');
              console.log(`[workflow-dispatcher] Discovery context injected for step "${opts.stepId}"`);
            }
          } catch (discErr: any) {
            // Non-fatal — discovery is best-effort
            console.warn(`[workflow-dispatcher] Workspace discovery failed for step "${opts.stepId}": ${discErr.message}`);
          }
        } catch (err: any) {
          // Non-fatal — the agent can still clone manually
          console.warn(`[workflow-dispatcher] Workspace provisioning failed for step "${opts.stepId}": ${err.message}`);
        }
      }

      // Use instance proxyUrl for callback so agents can reach the control plane through the node proxy
      const callbackBaseUrl = process.env.ARMADA_AGENT_GATEWAY_URL || 'http://armada-node:3002';
      const body = JSON.stringify({
        taskId: opts.taskId,
        from: 'workflow-engine',
        fromRole: 'operator',
        message: opts.message + worktreeContext + (discoveryContext ?? '') + (opts as any).learningContext || '',
        callbackUrl: `${callbackBaseUrl}/api/tasks/${opts.taskId}/result`,
        projectId: opts.projectId,
        ...(agent.targetAgent && { targetAgent: agent.targetAgent }),
        ...(opts.toolCategories?.length && { toolCategories: opts.toolCategories }),
      });

      // Wrap relay request with retry logic for reconnection resilience
      const resp = await withRetry(
        async () => node.relayRequest(containerName, 'POST', '/armada/task', body),
        3,
        [5000, 15000, 30000],
        isRetryableError,
      ) as any;
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
        issueNumber: opts.issueNumber,
        issueTitle: opts.issueTitle,
        issueRepo: opts.issueRepo,
        stepsCompleted: opts.stepsCompleted,
        totalSteps: opts.totalSteps,
        ...(opts.type === 'failed' && {
          failedStepId: opts.failedStepId,
          failedStepName: opts.failedStepName,
          failureDetail: opts.failureDetail,
        }),
      }).catch(err => {
        console.error(`[workflow-dispatcher] Failed to send completion notification:`, err);
      });
    }
  });

  // ── Register workspace cleanup hook ──────────────────────────────────
  setWorkspaceCleanupFn(async (run) => {
    await cleanupWorkspacesForRun(run.id);
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
 * Clean up all workspace worktrees provisioned for a workflow run.
 * Finds the agent/instance that ran this run's steps and calls cleanupWorkspaces.
 */
async function cleanupWorkspacesForRun(runId: string): Promise<void> {
  // Find steps that were run with a task in this run (any step run with an agent assigned)
  // We need the instance name — look up from any agent that ran steps in this run
  const stepRunsWithAgents = Array.from(_worktreeTasks.entries())
    .filter(([taskId]) => taskId.startsWith(`wf-${runId.slice(0, 8)}`));

  // Also query tasks repo to find which agents ran steps for this run
  const runTasks = tasksRepo.getAll?.().filter((t: any) => t.workflowRunId === runId) ?? [];

  const instanceNames = new Set<string>();

  for (const task of runTasks) {
    if (!task.toAgent) continue;
    const agentRecord = agentsRepo.getAll().find((a: any) => a.name === task.toAgent);
    const instance = agentRecord?.instanceId ? instancesRepo.getById(agentRecord.instanceId) : undefined;
    if (instance?.name) {
      instanceNames.add(instance.name);
    }
  }

  if (instanceNames.size === 0) {
    // No agents found — nothing to clean up
    console.log(`[workflow-dispatcher] No instances found for run ${runId.slice(0, 8)} — skipping workspace cleanup`);
    return;
  }

  for (const instanceName of instanceNames) {
    try {
      const agentRecord = agentsRepo.getAll().find((a: any) => {
        const inst = a.instanceId ? instancesRepo.getById(a.instanceId) : undefined;
        return inst?.name === instanceName;
      });
      const instance = agentRecord?.instanceId ? instancesRepo.getById(agentRecord.instanceId) : undefined;
      if (!instance?.nodeId) continue;

      const wsNode = getNodeClient(instance.nodeId);
      const result = await wsNode.cleanupWorkspaces(instanceName, runId);
      console.log(`[workflow-dispatcher] Cleaned up ${result.cleaned} worktree(s) for run ${runId.slice(0, 8)} on instance ${instanceName}`);
    } catch (err: any) {
      console.warn(`[workflow-dispatcher] Workspace cleanup failed for run ${runId.slice(0, 8)} on instance ${instanceName}: ${err.message}`);
    }
  }
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
