/**
 * Workflow Engine — deterministic orchestration of multi-agent workflows.
 *
 * No LLM involved in coordination. Steps execute based on defined
 * dependencies, parallel groups, and gate conditions.
 *
 * Flow:
 * 1. startRun() → finds steps with no deps → dispatches them
 * 2. onStepCompleted() → collects output → finds newly unblocked steps → dispatches
 * 3. Manual gates pause and notify operator
 * 4. Run completes when all steps are done (or failed if required step fails)
 */

import { randomUUID } from 'node:crypto';
import { getDrizzle } from '../db/drizzle.js';
import { workflows as workflowsTable, workflowRuns, workflowStepRuns, workflowProjects, issueDependencies, triagedIssues } from '../db/drizzle-schema.js';
import { eq, and, desc, sql, inArray } from 'drizzle-orm';
import { dispatchWebhook } from './webhook-dispatcher.js';
import { broadcast } from '../utils/event-bus.js';
import { getArtifactContextBlock } from '../routes/workflow-artifacts.js';
import { projectsRepo, agentsRepo, instancesRepo } from '../repositories/index.js';
import { getNodeClient } from '../infrastructure/node-client.js';
import { eventBus } from '../infrastructure/event-bus.js';

// Types — mirror shared package types locally to avoid build ordering issues
interface WorkflowStep {
  id: string; name?: string; role: string; prompt: string;
  parallel?: string; waitFor?: string[];
  optional?: boolean; gate?: 'manual';
  gatePolicy?: {
    notifyOnly?: ('human' | 'operator')[];
    approveOnly?: ('human' | 'operator')[];
  };
  retryOnFailure?: boolean;
  maxRetries?: number;
  retryDelayMs?: number;
  loopUntilApproved?: boolean;
  loopBackToStep?: string;
  maxLoopIterations?: number;
  isolateGit?: boolean;
  toolCategories?: string[];
  /** Optional condition — if evaluates to false, step is skipped (not a failure) */
  condition?: string;
  /** Per-step repo for multi-repo workflows */
  repo?: string;
}
interface RetryState {
  retryCount: number;
  loopIteration: number;
}
interface Workflow {
  id: string; projectId?: string; name: string; description: string;
  steps: WorkflowStep[]; enabled: boolean; createdAt: string;
}
type WorkflowRunStatus = 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
type StepRunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'waiting_gate' | 'waiting_for_rework' | 'rework';

interface ReworkEntry {
  requestedBy: { stepId: string; agent: string | null };
  targetStepId: string;
  feedback: string;
  iteration: number;
  requestedAt: string;
  resolvedAt: string | null;
}
interface WorkflowRun {
  id: string; workflowId: string; projectId: string;
  triggerType: string; triggerRef: string | null;
  status: WorkflowRunStatus; currentStep: string | null;
  context: Record<string, { output: string; sharedRefs: string[] }>;
  createdAt: string; completedAt: string | null;
}
interface WorkflowStepRun {
  id: string; runId: string; stepId: string; stepIndex: number;
  role: string; agentName: string | null; taskId: string | null;
  status: StepRunStatus; input: Record<string, any>;
  output: string | null; sharedRefs: string[];
  startedAt: string | null; completedAt: string | null;
  retryState: RetryState;
}

// ── Template variable resolution ────────────────────────────────────

function resolveTemplate(template: string, vars: Record<string, any>): string {
  return template.replace(/\{\{(\w+(?:\.\w+)*)(?:\|([^}]*))?\}\}/g, (match, path, fallback) => {
    const parts = path.split('.');
    let val: any = vars;
    for (const p of parts) {
      val = val?.[p];
      if (val === undefined) {
        // Use fallback if provided (group 2), or leave unresolved if no fallback
        if (fallback !== undefined) return fallback;
        return match;
      }
    }
    return typeof val === 'string' ? val : JSON.stringify(val);
  });
}

// ── Workflow context block for step prompts ─────────────────────────

export function buildWorkflowContextBlock(
  run: WorkflowRun,
  workflow: Workflow,
  step: WorkflowStep,
  stepRun: WorkflowStepRun,
): string {
  const context = run.context as any;
  const lines: string[] = [
    `[WORKFLOW CONTEXT]`,
    `Workflow: "${workflow.name}" (run ${run.id.slice(0, 8)})`,
    `Your step: "${step.name || step.id}" (role: ${step.role})`,
    '',
    '## Guidelines',
    '- You are one step in a multi-agent workflow. Other agents will read your output.',
    '- Be concise and structured. Use headings and bullet points.',
    '- State what you did, what you found, or what you decided — not your thought process.',
    '- If you produce files, upload them as artifacts using armada_artifact_upload.',
    '- If previous steps uploaded artifacts, download and review them using armada_artifact_download.',
    '- Do not repeat the full prompt or task description in your output.',
    `- Your run ID is ${run.id} and your step ID is ${step.id} (needed for artifact tools).`,
  ];

  // Project + repository context
  if (run.projectId) {
    try {
      const project = projectsRepo.get(run.projectId);
      if (project) {
        lines.push(`Project: ${project.name}`);
        const config = JSON.parse(project.configJson || '{}');
        const repos: Array<{ url: string }> = config.repositories || [];
        if (repos.length > 0) {
          lines.push(`Repositories: ${repos.map(r => r.url).join(', ')}`);
        }
        if (project.contextMd?.trim()) {
          lines.push('', '## Project Context', project.contextMd.trim());
        }
      }
    } catch { /* non-fatal */ }
  }
  if (run.triggerRef) {
    lines.push(`Trigger: ${run.triggerRef}`);
  }

  // List completed steps as a conversation thread — full output, no truncation
  const completedEntries: string[] = [];
  for (const s of workflow.steps) {
    if (s.id === step.id) continue;
    const ctx = context[s.id];
    if (ctx && typeof ctx === 'object' && ctx.output) {
      // Resolve the agent name from the step run records
      const agentName = (() => {
        try {
          const sr = getDrizzle().select().from(workflowStepRuns)
            .where(and(eq(workflowStepRuns.runId, run.id), eq(workflowStepRuns.stepId, s.id)))
            .get();
          return sr?.agentName || s.role;
        } catch { return s.role; }
      })();
      completedEntries.push(`### Agent: ${agentName} (${s.role})\nStep: ${s.name || s.id}\n\n${ctx.output}`);
    }
  }

  if (completedEntries.length > 0) {
    lines.push('', '## Previous Steps', '');
    lines.push(completedEntries.join('\n\n'));
  }

  // Rework feedback section
  const reworkFeedback = context[`${step.id}_reworkFeedback`];
  if (reworkFeedback) {
    const reworks = context.reworks as ReworkEntry[] | undefined;
    const rework = reworks?.find(r => r.targetStepId === step.id && r.resolvedAt === null);
    const previousOutput = context[`${step.id}_previousOutput`];

    lines.push('');
    lines.push('[REWORK FEEDBACK]');
    if (rework) {
      lines.push(`Requested by: ${rework.requestedBy.agent || 'unknown'} (step: ${rework.requestedBy.stepId})`);
    }
    lines.push(`Feedback: ${reworkFeedback}`);
    if (previousOutput) {
      const truncated = String(previousOutput).slice(0, 500);
      const ellipsis = String(previousOutput).length > 500 ? '...' : '';
      lines.push(`Your previous output: ${truncated}${ellipsis}`);
    }
    lines.push('[END REWORK FEEDBACK]');
  }

  lines.push('[END WORKFLOW CONTEXT]');
  return lines.join('\n');
}

// ── Dispatch a step to an agent ─────────────────────────────────────

interface DispatchFn {
  (opts: {
    role: string;
    message: string;
    projectId: string;
    runId: string;
    stepId: string;
    taskId: string;
    /** If true, an isolated Git worktree should be created before the step runs */
    isolateGit?: boolean;
    /** Restrict tool loading to these categories for this step */
    toolCategories?: string[];
    /** Resolved workflow template variables — used for workspace pre-provisioning */
    vars?: Record<string, any>;
    /** Override repo for this step (multi-repo workflows) */
    stepRepo?: string;
  }): Promise<{ agentName: string; armadaTaskId: string } | { error: string }>;
}

interface NotifyOptions {
  type: 'gate' | 'completed' | 'failed';
  workflowName: string;
  stepId?: string;
  runId: string;
  previousOutput?: string | null;
  projectId: string;
  gatePolicy?: {
    notifyOnly?: ('human' | 'operator')[];
    approveOnly?: ('human' | 'operator')[];
  };
  /** For failed notifications: which step failed */
  failedStepId?: string;
  failedStepName?: string;
  /** Error message or last output (will be truncated by notifier) */
  failureDetail?: string;
  /** Context from workflow run variables */
  issueNumber?: number;
  issueTitle?: string;
  issueRepo?: string;
  stepsCompleted?: number;
  totalSteps?: number;
}

let _dispatchFn: DispatchFn | null = null;
let _notifyFn: ((opts: NotifyOptions) => void) | null = null;
let _cleanupWorkspacesFn: ((run: { id: string }) => Promise<void>) | null = null;

export function setWorkflowDispatcher(fn: DispatchFn) {
  _dispatchFn = fn;
}

export function setWorkflowNotifier(fn: (opts: NotifyOptions) => void) {
  _notifyFn = fn;
}

/**
 * Register a callback to clean up workspace worktrees when a run finishes.
 * Called fire-and-forget after a run transitions to completed/failed/cancelled.
 */
export function setWorkspaceCleanupFn(fn: (run: { id: string }) => Promise<void>) {
  _cleanupWorkspacesFn = fn;
}

// ── Start a workflow run ────────────────────────────────────────────

export async function startRun(
  workflow: Workflow,
  triggerType: 'manual' | 'issue' | 'api' = 'manual',
  triggerRef?: string,
  extraVars?: Record<string, any>,
  projectId?: string,
): Promise<WorkflowRun> {
  const db = getDrizzle();
  const runId = randomUUID();
  const resolvedProjectId = projectId || workflow.projectId || (workflow as any).projectIds?.[0] || '';

  // Store trigger variables in context so all steps can access them
  const initialContext = extraVars && Object.keys(extraVars).length > 0
    ? { _vars: extraVars }
    : {};

  db.insert(workflowRuns).values({
    id: runId,
    workflowId: workflow.id,
    projectId: resolvedProjectId,
    triggerType,
    triggerRef: triggerRef || null,
    status: 'running',
    contextJson: JSON.stringify(initialContext),
  }).run();

  // Mark the issue as triaged so it doesn't get re-triaged on future sync cycles
  if (resolvedProjectId && extraVars?.issueNumber) {
    try {
      db.insert(triagedIssues).values({
        id: randomUUID(),
        projectId: resolvedProjectId,
        issueNumber: extraVars.issueNumber,
        triagedAt: new Date().toISOString(),
      }).onConflictDoNothing().run();
    } catch { /* ignore — table may not have unique constraint */ }
  }

  // Create step run entries for all steps
  for (let i = 0; i < workflow.steps.length; i++) {
    const step = workflow.steps[i];
    db.insert(workflowStepRuns).values({
      id: randomUUID(),
      runId,
      stepId: step.id,
      stepIndex: i,
      role: step.role || '',
      status: 'pending',
    }).run();
  }

  const run = getRunById(runId)!;

  
  dispatchWebhook('workflow.run.started', { runId, workflowId: workflow.id, workflowName: workflow.name, triggerType, triggerRef: triggerRef || null });

  // Find and dispatch initial steps (no waitFor deps)
  await advanceRun(run, workflow, extraVars);

  return run;
}

// ── Condition evaluation for conditional step execution ─────────────

function evaluateStepCondition(
  condition: string,
  run: WorkflowRun,
  stepRuns: WorkflowStepRun[],
): boolean {
  const vars = (run.context as any)?._vars ?? {};

  // Replace {{vars.X}} with actual values
  let resolved = condition;
  for (const [key, value] of Object.entries(vars)) {
    resolved = resolved.replace(new RegExp(`\\{\\{vars\\.${key}\\}\\}`, 'g'), String(value ?? ''));
  }

  // Replace {{steps.X.output}} with step output
  for (const sr of stepRuns) {
    resolved = resolved.replace(
      new RegExp(`\\{\\{steps\\.${sr.stepId}\\.output\\}\\}`, 'g'),
      sr.output ?? '',
    );
  }

  // Strip markdown formatting from resolved text (agents often use **bold**, *italic*, etc.)
  resolved = resolved.replace(/\*\*/g, '').replace(/\*/g, '').replace(/`/g, '');

  // "X contains 'text'" — use \s+contains\s+ as delimiter, not anchored to start/end
  const containsMatch = resolved.match(/^([\s\S]+?)\s+contains\s+'([^']+)'$/i);
  if (containsMatch) return containsMatch[1].includes(containsMatch[2]);

  // "X not empty"
  if (resolved.trim().endsWith('not empty')) {
    return resolved.replace(/\s+not\s+empty$/i, '').trim().length > 0;
  }

  // "X equals 'text'"
  const equalsMatch = resolved.match(/^([\s\S]+?)\s+equals\s+'([^']+)'$/i);
  if (equalsMatch) return equalsMatch[1].trim() === equalsMatch[2];

  // Boolean literals
  if (resolved.trim().toLowerCase() === 'false') return false;
  if (resolved.trim().toLowerCase() === 'true') return true;

  // Default: truthy (non-empty = run)
  return resolved.trim().length > 0;
}

// ── Advance a run — find and dispatch ready steps ───────────────────

async function advanceRun(
  run: WorkflowRun,
  workflow: Workflow,
  extraVars?: Record<string, any>,
): Promise<void> {
  if (run.status !== 'running' && run.status !== 'paused') return;
  // Paused runs can still advance non-gated steps (gates only block THEIR step)

  const steps = workflow.steps;

  // Loop until no more steps can be advanced (handles cascade skips)
  let madeProgress = true;
  while (madeProgress) {
    madeProgress = false;
    const stepRuns = getStepRunsForRun(run.id); // Re-fetch each pass

  for (const step of steps) {
    const stepRun = stepRuns.find(sr => sr.stepId === step.id);
    if (!stepRun) continue;
    // Skip already-completed/failed/skipped steps
    if (['completed', 'failed', 'skipped', 'running'].includes(stepRun.status)) continue;
    // For waiting_gate steps, re-check if deps have since failed
    if (stepRun.status === 'waiting_gate') {
      const deps = step.waitFor || [];
      const gateDepFailed = deps.some(depId => {
        const depRun = stepRuns.find(sr => sr.stepId === depId);
        const depStep = steps.find(s => s.id === depId);
        if (depStep?.optional || depStep?.condition) return false;
        return depRun && (depRun.status === 'failed' || depRun.status === 'skipped');
      });
      if (gateDepFailed) {
        markStepStatus(stepRun.id, 'skipped');
        madeProgress = true;
      }
      continue;
    }
    if (stepRun.status !== 'pending') continue;

    // Check if all dependencies are satisfied
    const deps = step.waitFor || [];
    const allDepsMet = deps.every(depId => {
      const depRun = stepRuns.find(sr => sr.stepId === depId);
      const depStep = steps.find(s => s.id === depId);
      // Only 'completed' satisfies a dependency.
      // 'skipped' counts if: step is optional, OR step was condition-skipped (planned skip).
      return depRun && (
        depRun.status === 'completed' ||
        (depRun.status === 'skipped' && (depStep?.optional === true || depStep?.condition != null))
      );
    });

    // Check if any required dep failed or was cascade-skipped
    // Condition-skipped deps are planned, not failures
    const anyDepFailed = deps.some(depId => {
      const depRun = stepRuns.find(sr => sr.stepId === depId);
      const depStep = steps.find(s => s.id === depId);
      if (depStep?.optional || depStep?.condition) return false; // planned skips aren't failures
      return depRun && (depRun.status === 'failed' || depRun.status === 'skipped');
    });

    if (anyDepFailed) {
      // Skip this step — a required dependency failed or was cascade-skipped
      markStepStatus(stepRun.id, 'skipped');
      madeProgress = true; // Trigger another pass for cascade
      continue;
    }

    if (!allDepsMet) continue;

    // Check condition — skip if condition evaluates to false (planned skip, not failure)
    if (step.condition) {
      console.log(`[workflow-engine] Evaluating condition for step "${step.id}": ${step.condition}`);
      const shouldRun = evaluateStepCondition(step.condition, run, stepRuns);
      console.log(`[workflow-engine] Condition result for step "${step.id}": ${shouldRun}`);
      if (!shouldRun) {
        markStepStatus(stepRun.id, 'skipped');
        getDrizzle().run(sql`UPDATE workflow_step_runs SET output = 'Skipped: condition not met' WHERE id = ${stepRun.id}`);
        madeProgress = true;
        continue;
      }
    }

    // Check gate
    if (step.gate === 'manual' || (step as any).manualGate === true) {
      const changed = markStepStatus(stepRun.id, 'waiting_gate');
      if (_notifyFn && changed) {
        // Get previous step output from context
        const previousOutput = getPreviousStepOutput(run, step);
        _notifyFn({
          type: 'gate',
          workflowName: workflow.name,
          stepId: step.id,
          runId: run.id,
          previousOutput,
          projectId: run.projectId,
          gatePolicy: step.gatePolicy,
        });
      }
      
      continue;
    }

    // Dispatch this step
    await dispatchStep(run, workflow, step, stepRun, extraVars);
    madeProgress = true;
  }
  } // end while (madeProgress)

  // Check if run is complete
  const updatedStepRuns = getStepRunsForRun(run.id);
  const allDone = updatedStepRuns.every(sr =>
    ['completed', 'failed', 'skipped'].includes(sr.status)
  );
  const anyGated = updatedStepRuns.some(sr => sr.status === 'waiting_gate');

  if (allDone) {
    // A workflow fails if any non-optional step failed, OR if any non-optional
    // step was skipped due to a failed dependency (cascade failure).
    const anyRequiredFailed = updatedStepRuns.some(sr => {
      const step = steps.find(s => s.id === sr.stepId);
      if (step?.optional) return false;
      if (sr.status === 'failed') return true;
      // A skipped non-optional step — check if it's a planned skip (condition) or failure cascade
      if (sr.status === 'skipped') {
        // Condition-skipped steps are intentional, not failures
        if (sr.output?.startsWith('Skipped: condition')) return false;
        // Steps with a condition that was evaluated are planned skips
        if (step?.condition) return false;
        // Otherwise check if it was cascade-skipped due to failed deps
        if (step && (step.waitFor || []).length > 0) {
          const hasFailedDep = (step.waitFor || []).some(depId => {
            const depRun = updatedStepRuns.find(d => d.stepId === depId);
            return depRun && (depRun.status === 'failed' || depRun.status === 'skipped');
          });
          return hasFailedDep;
        }
      }
      return false;
    });
    const finalStatus = anyRequiredFailed ? 'failed' : 'completed';

    // Only transition if still running (prevents duplicate completion notifications)
    const updateResult = getDrizzle().run(sql`
      UPDATE workflow_runs SET status = ${finalStatus}, completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ${run.id} AND status = 'running'
    `);
    if ((updateResult as any).changes === 0) return; // Already completed by another concurrent advanceRun

    // ── Clean up workspace worktrees for this run ──────────────────────
    if (_cleanupWorkspacesFn) {
      const completedRun = getRunById(run.id);
      if (completedRun) {
        _cleanupWorkspacesFn(completedRun).catch((err: Error) => {
          console.error(`[workflow-engine] Workspace cleanup failed for run ${run.id}: ${err.message}`);
        });
      }
    }

    // ── Auto-close GitHub issue on workflow completion ──────────────────
    if (finalStatus === 'completed' && run.triggerRef) {
      // Fire-and-forget — failure must not affect run status
      closeGithubIssueForRun(run, workflow, updatedStepRuns).catch((err: Error) => {
        console.error('[workflow-engine] GitHub auto-close failed (non-fatal):', err.message);
      });
    }

    if (_notifyFn) {
      // For failed runs, include details about which step failed and why
      const failedStepRun = finalStatus === 'failed'
        ? updatedStepRuns.find(sr => {
            const step = steps.find(s => s.id === sr.stepId);
            return sr.status === 'failed' && !step?.optional;
          })
        : undefined;
      const failedStep = failedStepRun ? steps.find(s => s.id === failedStepRun.stepId) : undefined;

      const vars = (run.context as any)?._vars ?? {};
      const completedCount = updatedStepRuns.filter(sr => sr.status === 'completed').length;
      _notifyFn({
        type: finalStatus === 'completed' ? 'completed' : 'failed',
        workflowName: workflow.name,
        runId: run.id,
        projectId: run.projectId,
        issueNumber: vars.issueNumber,
        issueTitle: vars.issueTitle,
        issueRepo: vars.issueRepo,
        stepsCompleted: completedCount,
        totalSteps: steps.length,
        ...(finalStatus === 'failed' && failedStepRun && {
          failedStepId: failedStepRun.stepId,
          failedStepName: failedStep?.name,
          failureDetail: failedStepRun.output ?? undefined,
        }),
      });
    }

    // ── Auto-dispatch unblocked issues (#159) ────────────────────────
    if (finalStatus === 'completed') {
      checkAndDispatchUnblockedIssues(run).catch((err: Error) => {
        console.error('[workflow-engine] Failed to check unblocked issues:', err.message);
      });
    }
  } else if (anyGated) {
    // Only set paused if nothing else is running or pending (gates truly block)
    const anyStillActive = updatedStepRuns.some(sr =>
      ['running', 'pending'].includes(sr.status)
    );
    if (!anyStillActive) {
      getDrizzle().update(workflowRuns).set({ status: 'paused' }).where(eq(workflowRuns.id, run.id)).run();
    }
  }
}

// ── Dispatch a single step ──────────────────────────────────────────

async function dispatchStep(
  run: WorkflowRun,
  workflow: Workflow,
  step: WorkflowStep,
  stepRun: WorkflowStepRun,
  extraVars?: Record<string, any>,
): Promise<void> {
  if (!_dispatchFn) {
    console.error('[workflow-engine] No dispatch function configured');
    return;
  }

  // Build template variables — merge trigger vars from context + extraVars
  const storedVars = (run.context as any)?._vars || {};
  const mergedUserVars = { ...storedVars, ...extraVars };
  const vars: Record<string, any> = {
    ...mergedUserVars,
    // Also expose under 'vars' namespace so {{vars.X}} templates work
    vars: mergedUserVars,
    steps: {} as Record<string, any>,
    run: { id: run.id, trigger: run.triggerRef },
  };

  // Inject completed step outputs (skip metadata keys like 'reworks', '_reworkFeedback', etc.)
  for (const [contextKey, ctx] of Object.entries(run.context)) {
    const ctxAny = ctx as any;
    if (ctxAny && typeof ctxAny === 'object' && 'output' in ctxAny && 'sharedRefs' in ctxAny) {
      vars.steps[contextKey] = {
        output: ctxAny.output,
        sharedRefs: ctxAny.sharedRefs,
        sharedMarkers: (ctxAny.sharedRefs as string[]).join('\n'),
      };
    }
  }

  // Inject rework template vars (feedback + previous output for this step)
  const reworkCtxVars = run.context as any;
  for (const s of workflow.steps) {
    if (!vars.steps[s.id]) vars.steps[s.id] = {};
    const reworkFeedback = reworkCtxVars[`${s.id}_reworkFeedback`];
    const previousOutput = reworkCtxVars[`${s.id}_previousOutput`];
    if (reworkFeedback !== undefined) vars.steps[s.id].reworkFeedback = reworkFeedback;
    if (previousOutput !== undefined) vars.steps[s.id].previousOutput = previousOutput;
  }

  const resolvedPrompt = resolveTemplate(step.prompt || '', vars);
  const workflowContextBlock = buildWorkflowContextBlock(run, workflow, step, stepRun);
  const artifactBlock = await getArtifactContextBlock(run.id, step.id);
  const contextWithArtifacts = artifactBlock
    ? workflowContextBlock + '\n\n' + artifactBlock
    : workflowContextBlock;
  const prompt = contextWithArtifacts + '\n\n' + resolvedPrompt;
  const taskId = `wf-${run.id.slice(0, 8)}-${step.id}`;

  // Mark step as running and store the resolved prompt
  const db = getDrizzle();
  db.run(sql`
    UPDATE workflow_step_runs SET status = 'running', started_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), task_id = ${taskId}, input_json = ${JSON.stringify({ prompt })}
    WHERE id = ${stepRun.id}
  `);

  db.update(workflowRuns).set({ currentStep: step.id }).where(eq(workflowRuns.id, run.id)).run();

  

  try {
    const result = await _dispatchFn({
      role: step.role,
      message: prompt,
      projectId: run.projectId,
      runId: run.id,
      stepId: step.id,
      taskId,
      isolateGit: step.isolateGit,
      toolCategories: step.toolCategories,
      vars: mergedUserVars,
      stepRepo: (step as any).repo,
    });

    if ('error' in result) {
      await handleDispatchFailure(stepRun, step, run, workflow, result.error, extraVars);
    } else {
      db.update(workflowStepRuns).set({ agentName: result.agentName }).where(eq(workflowStepRuns.id, stepRun.id)).run();
    }
  } catch (err: any) {
    await handleDispatchFailure(stepRun, step, run, workflow, err.message, extraVars);
  }
}

// ── Handle dispatch failure with optional auto-retry ────────────────

async function handleDispatchFailure(
  stepRun: WorkflowStepRun,
  step: WorkflowStep,
  run: WorkflowRun,
  workflow: Workflow,
  error: string,
  extraVars?: Record<string, any>,
): Promise<void> {
  const db = getDrizzle();
  const maxRetries = step.maxRetries ?? 3;
  const retryDelayMs = step.retryDelayMs ?? 5000;

  if (step.retryOnFailure && stepRun.retryState.retryCount < maxRetries) {
    const nextCount = stepRun.retryState.retryCount + 1;
    console.log(`[workflow-engine] Step "${step.id}" dispatch failed (attempt ${nextCount}/${maxRetries + 1}). Retrying in ${retryDelayMs}ms…`);

    const newState: RetryState = { retryCount: nextCount, loopIteration: stepRun.retryState.loopIteration };
    db.run(sql`
      UPDATE workflow_step_runs
      SET status = 'pending', output = NULL, task_id = NULL, agent_name = NULL,
          started_at = NULL, completed_at = NULL, retry_config = ${JSON.stringify(newState)}
      WHERE id = ${stepRun.id}
    `);

    await new Promise(resolve => setTimeout(resolve, retryDelayMs));

    const freshRun = getRunById(run.id);
    if (!freshRun || freshRun.status !== 'running') return;
    const freshStepRuns = getStepRunsForRun(run.id);
    const freshStepRun = freshStepRuns.find(sr => sr.stepId === step.id);
    if (!freshStepRun || freshStepRun.status !== 'pending') return;

    await dispatchStep(freshRun, workflow, step, freshStepRun, extraVars);
  } else {
    if (step.retryOnFailure) {
      console.log(`[workflow-engine] Step "${step.id}" exhausted all ${maxRetries} retries. Failing.`);
    }
    markStepFailed(stepRun.id, error);
    if (step.optional) {
      await advanceRun(getRunById(run.id)!, workflow, extraVars);
    }
  }
}

// ── Step completion callback ────────────────────────────────────────

export async function onStepCompleted(
  taskId: string,
  status: 'completed' | 'failed',
  output: string,
  sharedRefs: string[] = [],
): Promise<void> {
  const db = getDrizzle();

  // Find the step run by task ID
  const stepRun = db.select().from(workflowStepRuns).where(eq(workflowStepRuns.taskId, taskId)).get();

  if (!stepRun) return; // Not a workflow task

  const runId = stepRun.runId;
  const stepId = stepRun.stepId;

  // If step already transitioned to waiting_for_rework (via requestRework()),
  // don't overwrite — the agent called rework before its task completed.
  // Store the output but preserve the waiting_for_rework status.
  if (stepRun.status === 'waiting_for_rework') {
    console.log(`[workflow-engine] Step "${stepId}" completed but is waiting_for_rework — preserving status, storing output`);
    db.run(sql`
      UPDATE workflow_step_runs
      SET output = ${output}, shared_refs_json = ${JSON.stringify(sharedRefs)}, completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ${stepRun.id}
    `);
    // Still update context with output
    const run = getRunById(runId);
    if (run) {
      const context = { ...run.context } as any;
      context[stepId] = { output, sharedRefs };
      db.update(workflowRuns).set({ contextJson: JSON.stringify(context) }).where(eq(workflowRuns.id, runId)).run();
    }
    return; // Don't advance — rework target will trigger re-dispatch when it completes
  }

  // Update step run
  const stepStatus: StepRunStatus = status === 'completed' ? 'completed' : 'failed';
  db.run(sql`
    UPDATE workflow_step_runs
    SET status = ${stepStatus}, output = ${output}, shared_refs_json = ${JSON.stringify(sharedRefs)}, completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ${stepRun.id}
  `);

  // Update run context with step output
  const run = getRunById(runId);
  if (!run) return;

  const context = { ...run.context } as any;
  context[stepId] = { output, sharedRefs };
  db.update(workflowRuns).set({ contextJson: JSON.stringify(context) }).where(eq(workflowRuns.id, runId)).run();

  // ── Rework resolution ──────────────────────────────────────────────
  if (status === 'completed') {
    const reworks = context.reworks as ReworkEntry[] | undefined;
    if (reworks) {
      const pendingRework = reworks.find((r: ReworkEntry) => r.targetStepId === stepId && r.resolvedAt === null);
      if (pendingRework) {
        // Mark rework as resolved
        pendingRework.resolvedAt = new Date().toISOString();
        // Clean up rework context keys
        delete context[`${stepId}_reworkFeedback`];
        delete context[`${stepId}_previousOutput`];

        // Reset steps that were waiting_for_rework because of this rework
        const allStepRuns = getStepRunsForRun(runId);
        for (const ws of allStepRuns) {
          if (ws.status === 'waiting_for_rework') {
            const waitingRework = (context.reworks as ReworkEntry[]).find(
              (r: ReworkEntry) => r.requestedBy.stepId === ws.stepId && r.targetStepId === stepId && r.resolvedAt !== null,
            );
            if (waitingRework) {
              db.run(sql`
                UPDATE workflow_step_runs
                SET status = 'pending', output = NULL, task_id = NULL, agent_name = NULL,
                    started_at = NULL, completed_at = NULL
                WHERE id = ${ws.id}
              `);
              delete context[ws.stepId];
            }
          }
        }

        // Save updated context with resolved rework
        db.update(workflowRuns).set({ contextJson: JSON.stringify(context) }).where(eq(workflowRuns.id, runId)).run();

        // Emit SSE event
        broadcast('workflow.rework.resolved', { runId, targetStepId: stepId });
      }
    }
  }

  // Get workflow and advance
  const workflowRow = db.select().from(workflowsTable).where(eq(workflowsTable.id, run.workflowId)).get();
  if (!workflowRow) return;

  const workflow = parseWorkflow(workflowRow);
  const stepDef = workflow.steps.find(s => s.id === stepId);

  // ── Auto-retry when agent reports failure ──────────────────────────
  if (stepDef?.retryOnFailure && status === 'failed') {
    const maxRetries = stepDef.maxRetries ?? 3;
    const retryDelayMs = stepDef.retryDelayMs ?? 5000;
    const stateRow = db.get(sql`SELECT retry_config FROM workflow_step_runs WHERE id = ${stepRun.id}`) as any;
    const currentState: RetryState = JSON.parse(stateRow?.retry_config || '{"retryCount":0,"loopIteration":0}');

    if (currentState.retryCount < maxRetries) {
      const nextCount = currentState.retryCount + 1;
      console.log(`[workflow-engine] Step "${stepId}" failed (attempt ${nextCount}/${maxRetries + 1}). Retrying in ${retryDelayMs}ms…`);

      const newState: RetryState = { retryCount: nextCount, loopIteration: currentState.loopIteration };
      db.run(sql`
        UPDATE workflow_step_runs
        SET status = 'pending', output = NULL, task_id = NULL, agent_name = NULL,
            started_at = NULL, completed_at = NULL, retry_config = ${JSON.stringify(newState)}
        WHERE id = ${stepRun.id}
      `);

      // Remove from context so the step can re-populate it
      const retryCtx = { ...run.context };
      delete retryCtx[stepId];
      db.update(workflowRuns).set({ contextJson: JSON.stringify(retryCtx), status: 'running' }).where(eq(workflowRuns.id, runId)).run();

      await new Promise(resolve => setTimeout(resolve, retryDelayMs));
      const freshRun = getRunById(runId);
      if (freshRun && freshRun.status === 'running') await advanceRun(freshRun, workflow);
      return;
    }
    console.log(`[workflow-engine] Step "${stepId}" exhausted all ${maxRetries} retries. Failing.`);
  }

  // ── Review loop: loop back when output needs revision ──────────────
  if (stepDef?.loopUntilApproved && status === 'completed') {
    if (detectNeedsRevision(output)) {
      const loopBackStepId = stepDef.loopBackToStep;
      const maxIter = stepDef.maxLoopIterations ?? 5;
      const stateRow = db.get(sql`SELECT retry_config FROM workflow_step_runs WHERE id = ${stepRun.id}`) as any;
      const currentState: RetryState = JSON.parse(stateRow?.retry_config || '{"retryCount":0,"loopIteration":0}');
      const nextIter = currentState.loopIteration + 1;

      if (loopBackStepId && nextIter < maxIter) {
        console.log(`[workflow-engine] Review step "${stepId}" needs revision (loop ${nextIter}/${maxIter}). Looping back to "${loopBackStepId}".`);

        // Save updated iteration count on the review step
        db.run(sql`UPDATE workflow_step_runs SET retry_config = ${JSON.stringify({ retryCount: 0, loopIteration: nextIter })} WHERE id = ${stepRun.id}`);

        // Stash revision output in context (for history)
        const loopCtx = { ...run.context };
        loopCtx[`${stepId}_revision_${nextIter}`] = { output, sharedRefs };

        // Reset loopBackStep and all its downstream (including this review step)
        const downstream = findDownstream(loopBackStepId, workflow.steps);
        const toReset = new Set([loopBackStepId, ...downstream]);
        const allStepRuns = getStepRunsForRun(runId);
        for (const sr of allStepRuns) {
          if (toReset.has(sr.stepId)) {
            db.run(sql`
              UPDATE workflow_step_runs
              SET status = 'pending', output = NULL, shared_refs_json = '[]',
                  task_id = NULL, agent_name = NULL, started_at = NULL, completed_at = NULL
              WHERE id = ${sr.id}
            `);
            delete loopCtx[sr.stepId];
          }
        }

        db.run(sql`UPDATE workflow_runs SET context_json = ${JSON.stringify(loopCtx)}, status = 'running', completed_at = NULL WHERE id = ${runId}`);
        const freshRun = getRunById(runId)!;
        await advanceRun(freshRun, workflow);
        return;
      }

      if (nextIter >= maxIter) {
        const maxIterMsg = `Max review loop iterations (${maxIter}) exceeded without approval`;
        console.log(`[workflow-engine] Review step "${stepId}" exceeded max loop iterations (${maxIter}). Failing.`);
        db.run(sql`UPDATE workflow_step_runs SET status = 'failed', output = ${maxIterMsg}, completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ${stepRun.id}`);
        db.run(sql`UPDATE workflow_runs SET status = 'failed', completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ${runId}`);
        if (_notifyFn) _notifyFn({
          type: 'failed',
          workflowName: workflow.name,
          runId,
          projectId: run.projectId,
          failedStepId: stepId,
          failedStepName: stepDef?.name,
          failureDetail: maxIterMsg,
        });
        return;
      }
    }
  }

  const updatedRun = getRunById(runId)!;
  await advanceRun(updatedRun, workflow);
}

/**
 * Detect whether a review step's output indicates the result needs revision.
 */
function detectNeedsRevision(output: string): boolean {
  if (!output) return false;
  const lower = output.toLowerCase();
  return (
    lower.includes('needs revision') ||
    lower.includes('needs_revision') ||
    lower.includes('requires revision') ||
    lower.includes('not approved') ||
    lower.includes('needs changes') ||
    lower.includes('changes required') ||
    lower.includes('revision required') ||
    lower.includes('"approved": false') ||
    lower.includes('"approved":false') ||
    lower.includes('status: revision') ||
    lower.includes('"status":"revision"') ||
    lower.includes('"status": "needs_revision"') ||
    lower.includes('"status":"needs_revision"')
  );
}

// ── Approve a manual gate ───────────────────────────────────────────

export async function approveGate(runId: string, stepId: string, resolvedBy?: string): Promise<void> {
  const db = getDrizzle();

  const stepRun = db.get(sql`
    SELECT * FROM workflow_step_runs WHERE run_id = ${runId} AND step_id = ${stepId} AND status = 'waiting_gate'
  `) as any;

  if (!stepRun) throw new Error(`No waiting gate found for step ${stepId} in run ${runId}`);

  // Mark gate step as completed (gates are checkpoints, not work)
  const output = resolvedBy ? `✅ Approved by ${resolvedBy}` : '✅ Approved';
  db.run(sql`
    UPDATE workflow_step_runs SET status = 'completed', output = ${output}, completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ${stepRun.id}
  `);

  // Ensure run is back to running
  db.update(workflowRuns).set({ status: 'running' }).where(eq(workflowRuns.id, runId)).run();

  // Advance to next steps
  const run = getRunById(runId)!;
  const workflowRow = db.select().from(workflowsTable).where(eq(workflowsTable.id, run.workflowId)).get() as any;
  if (!workflowRow) return;
  const workflow = parseWorkflow(workflowRow);
  await advanceRun(run, workflow);
}

// ── Reject a manual gate ────────────────────────────────────────────

export async function rejectGate(runId: string, stepId: string, reason?: string): Promise<void> {
  const db = getDrizzle();

  const stepRun = db.get(sql`
    SELECT * FROM workflow_step_runs WHERE run_id = ${runId} AND step_id = ${stepId} AND status = 'waiting_gate'
  `) as any;

  if (!stepRun) throw new Error(`No waiting gate found for step ${stepId} in run ${runId}`);

  // Mark gate step as failed with reason
  db.run(sql`
    UPDATE workflow_step_runs SET status = 'failed', output = ${reason || 'Gate rejected'}, completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ${stepRun.id}
  `);

  // Check if this was a required step — if so, fail the run
  const run = getRunById(runId)!;
  const workflowRow = db.select().from(workflowsTable).where(eq(workflowsTable.id, run.workflowId)).get() as any;
  if (!workflowRow) return;
  const workflow = parseWorkflow(workflowRow);
  const stepDef = workflow.steps.find(s => s.id === stepId);

  // Check for loopUntilApproved — loop back to target step instead of failing
  if (stepDef?.loopUntilApproved && stepDef.loopBackToStep) {
    const loopTargetId = stepDef.loopBackToStep;
    const loopTargetDef = workflow.steps.find(s => s.id === loopTargetId);
    if (!loopTargetDef) {
      console.error(`[workflow-engine] loopBackToStep "${loopTargetId}" not found in workflow`);
    } else {
      console.log(`[workflow-engine] Gate "${stepId}" rejected — looping back to "${loopTargetId}" (reason: ${reason || 'none'})`);

      // Reset the gate step to pending
      const currentState: RetryState = JSON.parse(stepRun.retry_config || '{"retryCount":0,"loopIteration":0}');
      const newState: RetryState = { retryCount: 0, loopIteration: currentState.loopIteration + 1 };
      db.run(sql`
        UPDATE workflow_step_runs
        SET status = 'pending', output = NULL, task_id = NULL, agent_name = NULL,
            started_at = NULL, completed_at = NULL, retry_config = ${JSON.stringify(newState)}
        WHERE id = ${stepRun.id}
      `);

      // Reset the loop target step
      const loopTargetRun = db.get(sql`
        SELECT * FROM workflow_step_runs WHERE run_id = ${runId} AND step_id = ${loopTargetId}
      `) as any;
      if (loopTargetRun) {
        db.run(sql`
          UPDATE workflow_step_runs
          SET status = 'pending', output = NULL, task_id = NULL, agent_name = NULL,
              started_at = NULL, completed_at = NULL
          WHERE id = ${loopTargetRun.id}
        `);
      }

      // Inject rejection feedback into context for the loop target
      const context = { ...run.context } as any;
      context[`${loopTargetId}_reworkFeedback`] = reason || 'Gate rejected — please revise.';
      context[`${loopTargetId}_previousOutput`] = context[loopTargetId]?.output;
      delete context[loopTargetId];
      delete context[stepId];
      db.update(workflowRuns).set({ contextJson: JSON.stringify(context), status: 'running' }).where(eq(workflowRuns.id, runId)).run();

      // Re-dispatch the loop target step
      const freshRun = getRunById(runId)!;
      const freshStepRuns = getStepRunsForRun(runId);
      const freshLoopStep = freshStepRuns.find(sr => sr.stepId === loopTargetId);
      if (freshLoopStep) {
        await dispatchStep(freshRun, workflow, loopTargetDef, freshLoopStep);
      }
      return;
    }
  }

  if (!stepDef?.optional) {
    db.run(sql`UPDATE workflow_runs SET status = 'failed', completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ${runId}`);

    if (_notifyFn) {
      _notifyFn({
        type: 'failed',
        workflowName: workflow.name,
        runId: run.id,
        projectId: run.projectId,
        failedStepId: stepId,
        failedStepName: stepDef?.name,
        failureDetail: reason ? `Gate rejected: ${reason}` : 'Gate rejected',
      });
    }
  } else {
    // Optional gate rejected — skip downstream and continue
    db.update(workflowRuns).set({ status: 'running' }).where(eq(workflowRuns.id, runId)).run();
    await advanceRun(getRunById(runId)!, workflow);
  }
}

// ── Retry a step (and cascade reset downstream) ────────────────────

export async function retryStep(
  runId: string,
  stepId: string,
  feedback?: string,
): Promise<void> {
  const db = getDrizzle();

  const run = getRunById(runId);
  if (!run) throw new Error(`Run ${runId} not found`);

  const stepRuns = getStepRunsForRun(runId);
  const stepRun = stepRuns.find(sr => sr.stepId === stepId);
  if (!stepRun) throw new Error(`Step ${stepId} not found in run ${runId}`);
  if (stepRun.status === 'running') throw new Error(`Step ${stepId} is already running`);

  // Gate steps cannot be retried directly — they reopen when an upstream step is retried
  const workflowRow = db.select().from(workflowsTable).where(eq(workflowsTable.id, run.workflowId)).get() as any;
  if (!workflowRow) throw new Error(`Workflow ${run.workflowId} not found`);
  const workflowCheck = parseWorkflow(workflowRow);
  const stepDef = workflowCheck.steps.find(s => s.id === stepId);
  if (stepDef?.gate === 'manual') throw new Error(`Gate step "${stepId}" cannot be retried directly — retry an upstream step instead`);
  const workflow = workflowCheck;

  // Store previous attempt as context (so the retried step knows what was wrong)
  const context = { ...run.context };
  if (context[stepId]) {
    context[`${stepId}_previous`] = {
      output: context[stepId].output,
      sharedRefs: context[stepId].sharedRefs,
    };
    if (feedback) {
      context[`${stepId}_feedback`] = { output: feedback, sharedRefs: [] };
    }
    delete context[stepId];
  }

  // Find all downstream steps (anything that transitively depends on this step)
  const downstream = findDownstream(stepId, workflow.steps);

  // Reset this step and all downstream steps
  for (const sr of stepRuns) {
    if (sr.stepId === stepId || downstream.has(sr.stepId)) {
      db.run(sql`
        UPDATE workflow_step_runs
        SET status = 'pending', output = NULL, shared_refs_json = '[]',
            task_id = NULL, agent_name = NULL, started_at = NULL, completed_at = NULL
        WHERE id = ${sr.id}
      `);

      // Clear downstream context too
      if (sr.stepId !== stepId) {
        delete context[sr.stepId];
        delete context[`${sr.stepId}_previous`];
        delete context[`${sr.stepId}_feedback`];
      }
    }
  }

  // Update run context and ensure it's running
  db.run(sql`UPDATE workflow_runs SET context_json = ${JSON.stringify(context)}, status = 'running', completed_at = NULL WHERE id = ${runId}`);

  console.log(`[workflow-engine] Retrying step "${stepId}" in run ${runId}. Downstream reset: ${[...downstream].join(', ') || 'none'}`);

  // Re-advance — the reset step will be dispatched since deps are still met
  const updatedRun = getRunById(runId)!;

  // Inject feedback into the step prompt if provided
  if (feedback) {
    const step = workflow.steps.find(s => s.id === stepId);
    if (step) {
      const originalPrompt = step.prompt;
      step.prompt = `${originalPrompt}\n\n--- FEEDBACK FROM PREVIOUS ATTEMPT ---\n${feedback}\n\nPrevious output is available at {{steps.${stepId}_previous.output}}`;
      await advanceRun(updatedRun, workflow);
      step.prompt = originalPrompt; // restore
      return;
    }
  }

  await advanceRun(updatedRun, workflow);
}

// ── Request rework on a previously completed step ──────────────────

export async function requestRework(
  runId: string,
  requestingStepId: string,
  targetStepId: string,
  feedback: string,
  maxReworkIterations = 3,
): Promise<void> {
  const db = getDrizzle();

  // Validate run exists and is running
  const run = getRunById(runId);
  if (!run) throw new Error(`Run ${runId} not found`);
  if (run.status !== 'running') throw new Error(`Run ${runId} is not running (status: ${run.status})`);

  // Can't target own step
  if (requestingStepId === targetStepId) throw new Error(`Cannot request rework on your own step`);

  const stepRuns = getStepRunsForRun(runId);

  // Requesting step must be running
  const requestingStepRun = stepRuns.find(sr => sr.stepId === requestingStepId);
  if (!requestingStepRun) throw new Error(`Step ${requestingStepId} not found in run ${runId}`);
  if (requestingStepRun.status !== 'running') {
    throw new Error(`Step ${requestingStepId} is not running (status: ${requestingStepRun.status})`);
  }

  // Target step must be completed
  const targetStepRun = stepRuns.find(sr => sr.stepId === targetStepId);
  if (!targetStepRun) throw new Error(`Step ${targetStepId} not found in run ${runId}`);
  if (targetStepRun.status !== 'completed') {
    throw new Error(`Step ${targetStepId} is not completed (status: ${targetStepRun.status})`);
  }

  // Check rework iteration limit
  const context = { ...run.context } as any;
  if (!context.reworks) context.reworks = [];
  const reworks = context.reworks as ReworkEntry[];
  const reworkCount = reworks.filter((r: ReworkEntry) => r.targetStepId === targetStepId).length;
  if (reworkCount >= maxReworkIterations) {
    throw new Error(`Step ${targetStepId} has exceeded the maximum rework iterations (${maxReworkIterations})`);
  }

  // Load workflow definition
  const workflowRow = db.select().from(workflowsTable).where(eq(workflowsTable.id, run.workflowId)).get();
  if (!workflowRow) throw new Error(`Workflow ${run.workflowId} not found`);
  const workflow = parseWorkflow(workflowRow);

  // 2. Pause the requesting step
  db.run(sql`UPDATE workflow_step_runs SET status = 'waiting_for_rework' WHERE id = ${requestingStepRun.id}`);
  broadcast('workflow:step', { runId, stepId: requestingStepId, status: 'waiting_for_rework' });

  // 3. Record the rework in context
  reworks.push({
    requestedBy: { stepId: requestingStepId, agent: requestingStepRun.agentName },
    targetStepId,
    feedback,
    iteration: reworkCount + 1,
    requestedAt: new Date().toISOString(),
    resolvedAt: null,
  });

  // 4. Stash target step's previous output
  context[`${targetStepId}_previousOutput`] = context[targetStepId]?.output ?? null;

  // 5. Reset target step + downstream (except the requesting step)
  const downstream = findDownstream(targetStepId, workflow.steps);
  const toReset = new Set([targetStepId, ...downstream]);

  for (const sr of stepRuns) {
    if (toReset.has(sr.stepId) && sr.stepId !== requestingStepId) {
      db.run(sql`
        UPDATE workflow_step_runs
        SET status = 'pending', output = NULL, shared_refs_json = '[]',
            task_id = NULL, agent_name = NULL, started_at = NULL, completed_at = NULL
        WHERE id = ${sr.id}
      `);
      delete context[sr.stepId];
    }
  }

  // 6. Inject feedback into target step's context
  context[`${targetStepId}_reworkFeedback`] = feedback;

  // Save updated context
  db.run(sql`UPDATE workflow_runs SET context_json = ${JSON.stringify(context)}, status = 'running' WHERE id = ${runId}`);

  // 8. Emit SSE event
  broadcast('workflow.rework.requested', { runId, requestingStepId, targetStepId, feedback });

  // 7. Re-advance the workflow — target step is now pending with deps met
  const updatedRun = getRunById(runId)!;
  await advanceRun(updatedRun, workflow);
}

/**
 * Find all steps that transitively depend on the given step.
 */
function findDownstream(stepId: string, steps: WorkflowStep[]): Set<string> {
  const downstream = new Set<string>();
  const queue = [stepId];

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const step of steps) {
      if (step.waitFor?.includes(current) && !downstream.has(step.id)) {
        downstream.add(step.id);
        queue.push(step.id);
      }
    }
  }

  return downstream;
}

// ── Auto-close GitHub issue when a workflow run completes ───────────

/**
 * If the workflow run was triggered by a GitHub issue URL, post a resolution
 * comment, close the issue, and add the "resolved-by-armada" label.
 *
 * Failures are non-fatal — the caller should wrap in try/catch.
 */
async function closeGithubIssueForRun(
  run: WorkflowRun,
  workflow: Workflow,
  stepRuns: WorkflowStepRun[],
): Promise<void> {
  if (!run.triggerRef) return;

  const { parseGithubIssueUrl, closeIssue, addLabel, addComment } = await import('./github-actions.js');

  const parsed = parseGithubIssueUrl(run.triggerRef);
  if (!parsed) return; // Not a GitHub issue URL

  const { owner, repo, number: issueNumber } = parsed;

  // Get the last completed step's output as summary
  const completedSteps = stepRuns.filter(sr => sr.status === 'completed' && sr.output);
  const finalOutput = completedSteps.length > 0
    ? completedSteps[completedSteps.length - 1].output ?? ''
    : '';

  const comment =
    `✅ Resolved by Armada workflow "${workflow.name}"\n\n## Summary\n${finalOutput}`.trimEnd();

  await addComment(run.projectId, owner, repo, issueNumber, comment);
  await closeIssue(run.projectId, owner, repo, issueNumber);
  await addLabel(run.projectId, owner, repo, issueNumber, 'resolved-by-armada');

  console.log(`[workflow-engine] Auto-closed GitHub issue ${owner}/${repo}#${issueNumber} after workflow "${workflow.name}" completed`);
}

// ── Cancel a run ────────────────────────────────────────────────────

export async function cancelRun(runId: string): Promise<void> {
  const db = getDrizzle();
  const now = sql`strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;

  // Query running step runs BEFORE updating status (we need agentName + taskId)
  const runningSteps = db.select().from(workflowStepRuns)
    .where(and(eq(workflowStepRuns.runId, runId), eq(workflowStepRuns.status, 'running')))
    .all();

  db.run(sql`UPDATE workflow_runs SET status = 'cancelled', completed_at = ${now} WHERE id = ${runId}`);
  db.run(sql`UPDATE workflow_step_runs SET status = 'cancelled', completed_at = ${now} WHERE run_id = ${runId} AND status = 'running'`);
  db.run(sql`UPDATE workflow_step_runs SET status = 'skipped' WHERE run_id = ${runId} AND status IN ('pending', 'waiting_gate', 'waiting_for_rework')`);

  // Clean up workspace worktrees for this run
  if (_cleanupWorkspacesFn) {
    const cancelledRun = getRunById(runId);
    if (cancelledRun) {
      _cleanupWorkspacesFn(cancelledRun).catch((err: Error) => {
        console.error(`[workflow-engine] Workspace cleanup failed for cancelled run ${runId}: ${err.message}`);
      });
    }
  }

  // Fire-and-forget abort requests to running agents
  for (const stepRun of runningSteps) {
    if (!stepRun.agentName || !stepRun.taskId) continue;

    try {
      const agentRecord = agentsRepo.getAll().find(a => a.name === stepRun.agentName);
      if (!agentRecord?.instanceId) continue;

      const instance = instancesRepo.getById(agentRecord.instanceId);
      if (!instance?.nodeId) continue;

      const containerName = `armada-instance-${instance.name}`;
      const node = getNodeClient(instance.nodeId);

      node.relayRequest(containerName, 'POST', '/armada/abort', { taskId: stepRun.taskId })
        .catch((err: any) => {
          console.warn(`[workflow-engine] Failed to abort task ${stepRun.taskId} on ${stepRun.agentName}: ${err.message}`);
        });
    } catch (err: any) {
      console.warn(`[workflow-engine] Error sending abort for step ${stepRun.stepId}: ${err.message}`);
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

/** Mark step status. Returns true if actually changed (prevents duplicate notifications). */
function markStepStatus(stepRunId: string, status: StepRunStatus): boolean {
  const db = getDrizzle();
  let changed: boolean;
  if (status === 'waiting_gate') {
    const result = db.run(sql`UPDATE workflow_step_runs SET status = ${status}, started_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ${stepRunId} AND status != ${status}`);
    changed = (result as any).changes > 0;
  } else {
    const result = db.update(workflowStepRuns).set({ status }).where(eq(workflowStepRuns.id, stepRunId)).run();
    changed = (result as any).changes > 0;
  }
  // Broadcast step change for SSE listeners
  if (changed) {
    const sr = db.select({ runId: workflowStepRuns.runId, stepId: workflowStepRuns.stepId }).from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRunId)).get();
    if (sr) broadcast('workflow:step', { runId: sr.runId, stepId: sr.stepId, status });
  }
  return changed;
}

function getPreviousStepOutput(run: WorkflowRun, currentStep: WorkflowStep): string | null {
  // Get the most recent completed step's output from context
  const deps = currentStep.waitFor || [];
  if (deps.length === 0) {
    // No dependencies, get the last completed step in context
    const contextKeys = Object.keys(run.context);
    if (contextKeys.length === 0) return null;
    const lastKey = contextKeys[contextKeys.length - 1];
    return run.context[lastKey]?.output || null;
  }
  
  // Return the output of the last dependency
  const lastDep = deps[deps.length - 1];
  return run.context[lastDep]?.output || null;
}

function markStepFailed(stepRunId: string, error: string) {
  getDrizzle().run(sql`
    UPDATE workflow_step_runs SET status = 'failed', output = ${error}, completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ${stepRunId}
  `);
}

function getRunById(runId: string): WorkflowRun | null {
  const row = getDrizzle().select().from(workflowRuns).where(eq(workflowRuns.id, runId)).get();
  if (!row) return null;
  return {
    id: row.id,
    workflowId: row.workflowId,
    projectId: row.projectId,
    triggerType: row.triggerType,
    triggerRef: row.triggerRef,
    status: row.status as WorkflowRunStatus,
    currentStep: row.currentStep,
    context: JSON.parse(row.contextJson || '{}'),
    createdAt: row.createdAt,
    completedAt: row.completedAt,
  };
}

function getStepRunsForRun(runId: string): WorkflowStepRun[] {
  const rows = getDrizzle().select().from(workflowStepRuns).where(eq(workflowStepRuns.runId, runId)).orderBy(workflowStepRuns.stepIndex).all();
  return rows.map(r => ({
    id: r.id,
    runId: r.runId,
    stepId: r.stepId,
    stepIndex: r.stepIndex,
    role: r.role,
    agentName: r.agentName,
    taskId: r.taskId,
    status: r.status as StepRunStatus,
    input: JSON.parse(r.inputJson || '{}'),
    output: r.output,
    sharedRefs: JSON.parse(r.sharedRefsJson || '[]'),
    startedAt: r.startedAt,
    completedAt: r.completedAt,
    retryState: JSON.parse((r as any).retryConfigJson || '{"retryCount":0,"loopIteration":0}'),
  }));
}

function parseWorkflow(row: any): Workflow {
  // Resolve projectId from the workflow_projects junction table
  let projectId = row.projectId ?? row.project_id;
  if (!projectId) {
    try {
      const wpRow = getDrizzle().select().from(workflowProjects)
        .where(eq(workflowProjects.workflowId, row.id))
        .get();
      if (wpRow) projectId = wpRow.projectId;
    } catch { /* table may not exist in tests */ }
  }
  return {
    id: row.id,
    projectId,
    name: row.name,
    description: row.description || '',
    steps: JSON.parse(row.stepsJson ?? row.steps_json ?? '[]'),
    enabled: !!row.enabled,
    createdAt: row.createdAt ?? row.created_at,
  };
}

// ── Cycle detection ─────────────────────────────────────────────────

/**
 * Detect circular dependencies in workflow steps using DFS.
 * Returns the cycle path if found, null otherwise.
 */
export function detectCycle(steps: WorkflowStep[]): string[] | null {
  const graph = new Map<string, string[]>();
  for (const step of steps) {
    graph.set(step.id, step.waitFor || []);
  }

  const visited = new Set<string>();
  const inStack = new Set<string>();
  const path: string[] = [];

  function dfs(node: string): string[] | null {
    if (inStack.has(node)) {
      const cycleStart = path.indexOf(node);
      return [...path.slice(cycleStart), node];
    }
    if (visited.has(node)) return null;

    visited.add(node);
    inStack.add(node);
    path.push(node);

    for (const dep of graph.get(node) || []) {
      const cycle = dfs(dep);
      if (cycle) return cycle;
    }

    path.pop();
    inStack.delete(node);
    return null;
  }

  for (const step of steps) {
    const cycle = dfs(step.id);
    if (cycle) return cycle;
  }
  return null;
}

// ── Workflow CRUD ────────────────────────────────────────────────────

export interface CreateWorkflowParams {
  name: string;
  description?: string;
  steps: WorkflowStep[];
  projectIds?: string[];
}

export function createWorkflow(id: string, params: CreateWorkflowParams): Workflow & { projectIds: string[] } {
  const { name, description = '', steps: rawSteps, projectIds = [] } = params;
  const db = getDrizzle();

  // Ensure every step has an id (default to name)
  const steps = rawSteps.map(s => ({
    ...s,
    id: s.id || (s as any).name || randomUUID(),
    waitFor: s.waitFor || (s as any).dependsOn || (s as any).dependencies || [],
  }));

  db.insert(workflowsTable).values({
    id,
    name,
    description,
    stepsJson: JSON.stringify(steps),
  }).run();

  for (const pid of projectIds) {
    db.insert(workflowProjects).values({ workflowId: id, projectId: pid }).onConflictDoNothing().run();
  }

  const wf = getWorkflowById(id)!;
  return { ...wf, projectIds };
}

export interface UpdateWorkflowParams {
  name?: string;
  description?: string;
  steps?: WorkflowStep[];
  enabled?: boolean;
  projectIds?: string[];
}

export function updateWorkflow(id: string, params: UpdateWorkflowParams): (Workflow & { projectIds: string[] }) | null {
  const db = getDrizzle();
  const existing = db.select({ id: workflowsTable.id }).from(workflowsTable).where(eq(workflowsTable.id, id)).get();
  if (!existing) return null;

  if (params.name !== undefined) db.update(workflowsTable).set({ name: params.name }).where(eq(workflowsTable.id, id)).run();
  if (params.description !== undefined) db.update(workflowsTable).set({ description: params.description }).where(eq(workflowsTable.id, id)).run();
  if (params.steps !== undefined) {
    const normalised = params.steps.map(s => ({
      ...s,
      id: s.id || (s as any).name || randomUUID(),
      waitFor: s.waitFor || (s as any).dependsOn || (s as any).dependencies || [],
    }));
    db.update(workflowsTable).set({ stepsJson: JSON.stringify(normalised) }).where(eq(workflowsTable.id, id)).run();
  }
  if (params.enabled !== undefined) db.update(workflowsTable).set({ enabled: params.enabled ? 1 : 0 }).where(eq(workflowsTable.id, id)).run();

  if (params.projectIds !== undefined) {
    db.delete(workflowProjects).where(eq(workflowProjects.workflowId, id)).run();
    for (const pid of params.projectIds) {
      db.insert(workflowProjects).values({ workflowId: id, projectId: pid }).onConflictDoNothing().run();
    }
  }

  const wf = getWorkflowById(id)!;
  const pIds = db.select({ projectId: workflowProjects.projectId }).from(workflowProjects).where(eq(workflowProjects.workflowId, id)).all();
  return { ...wf, projectIds: pIds.map(p => p.projectId) };
}

// ── Analytics queries ─────────────────────────────────────────────

export interface ActiveWorkflowRun {
  id: string;
  workflow_name: string;
  workflow_description: string;
  project_name: string | null;
  project_color: string | null;
  steps: any[];
  context: Record<string, any>;
  [key: string]: any;
}

export function getActiveWorkflowRuns(): ActiveWorkflowRun[] {
  const db = getDrizzle();
  const runs = db.all(sql`
    SELECT wr.*, w.name as workflow_name, w.description as workflow_description,
           p.name as project_name, p.color as project_color
    FROM workflow_runs wr
    JOIN workflows w ON w.id = wr.workflow_id
    LEFT JOIN projects p ON p.id = wr.project_id
    WHERE wr.status IN ('running', 'paused')
    ORDER BY wr.created_at DESC
  `);

  return (runs as any[]).map((run: any) => ({
    ...run,
    steps: db.select().from(workflowStepRuns).where(eq(workflowStepRuns.runId, run.id)).all(),
    context: JSON.parse(run.context_json || '{}'),
  }));
}

export interface RecentWorkflowRun {
  id: string;
  workflow_name: string;
  project_name: string | null;
  project_color: string | null;
  steps: any[];
  context: Record<string, any>;
  [key: string]: any;
}

export function getRecentWorkflowRuns(): RecentWorkflowRun[] {
  const db = getDrizzle();
  const runs = db.all(sql`
    SELECT wr.*, w.name as workflow_name, p.name as project_name, p.color as project_color
    FROM workflow_runs wr
    JOIN workflows w ON w.id = wr.workflow_id
    LEFT JOIN projects p ON p.id = wr.project_id
    WHERE wr.status IN ('completed', 'failed', 'cancelled')
    AND wr.completed_at > datetime('now', '-24 hours')
    ORDER BY wr.completed_at DESC
  `);

  return (runs as any[]).map((r: any) => ({
    ...r,
    steps: db.select().from(workflowStepRuns).where(eq(workflowStepRuns.runId, r.id)).all(),
    context: JSON.parse(r.context_json || '{}'),
  }));
}

export interface WorkflowStats {
  totalRuns: number;
  successCount: number;
  failCount: number;
  pendingCount: number;
  cancelledCount: number;
  successRate: number;
  avgDurationMs: number | null;
  recentRuns: Array<{ durationMs: number | null; status: string; createdAt: string }>;
}

export function getWorkflowStats(workflowId: string): WorkflowStats | null {
  const wf = getWorkflowById(workflowId);
  if (!wf) return null;

  const db = getDrizzle();
  const wid = wf.id;

  const statusRows = db.all<{ status: string; count: number }>(
    sql`SELECT status, COUNT(*) as count FROM workflow_runs WHERE workflow_id = ${wid} GROUP BY status`,
  );
  const counts: Record<string, number> = {};
  let totalRuns = 0;
  for (const r of statusRows) { counts[r.status] = r.count; totalRuns += r.count; }

  const successCount = counts['completed'] || 0;
  const failCount = counts['failed'] || 0;
  const pendingCount = counts['running'] || 0;
  const cancelledCount = counts['cancelled'] || 0;
  const successRate = totalRuns > 0 ? Math.round((successCount / totalRuns) * 100) : 0;

  const durationRow = db.get<{ avg_ms: number | null }>(
    sql`SELECT AVG((julianday(completed_at) - julianday(created_at)) * 86400000) as avg_ms
        FROM workflow_runs WHERE workflow_id = ${wid} AND completed_at IS NOT NULL`,
  ) ?? { avg_ms: null };

  const sparklineRows = db.all<{ duration_ms: number | null; status: string; created_at: string }>(
    sql`SELECT
          CASE WHEN completed_at IS NOT NULL
               THEN (julianday(completed_at) - julianday(created_at)) * 86400000
               ELSE NULL END as duration_ms,
          status,
          created_at
        FROM workflow_runs
        WHERE workflow_id = ${wid}
        ORDER BY created_at DESC
        LIMIT 10`,
  );

  return {
    totalRuns,
    successCount,
    failCount,
    pendingCount,
    cancelledCount,
    successRate,
    avgDurationMs: durationRow.avg_ms ? Math.round(durationRow.avg_ms) : null,
    recentRuns: sparklineRows.reverse().map(r => ({
      durationMs: r.duration_ms ? Math.round(r.duration_ms) : null,
      status: r.status,
      createdAt: r.created_at,
    })),
  };
}

export interface TemplateVariable {
  name: string;
  type: string;
  required: boolean;
}

export function getWorkflowVariables(workflowId: string): TemplateVariable[] | null {
  const wf = getWorkflowById(workflowId);
  if (!wf) return null;

  const builtinPrefixes = ['steps', 'run', 'trigger', 'project', 'context'];
  const vars = new Set<string>();

  for (const step of wf.steps) {
    const matches = (step.prompt || '').matchAll(/\{\{(\w+(?:\.\w+)*)\}\}/g);
    for (const m of matches) {
      const name = m[1];
      if (!builtinPrefixes.some(p => name.startsWith(p + '.'))) {
        vars.add(name);
      }
    }
  }

  return Array.from(vars).map(name => ({ name, type: 'string', required: false }));
}

// ── Workflow run context (for agents to inspect) ────────────────────

export interface WorkflowContextResponse {
  workflow: { id: string; name: string; status: string };
  steps: Array<{
    id: string;
    name: string;
    role: string;
    agent: string | null;
    status: string;
    output: string | null;
    completedAt: string | null;
    iteration: number;
  }>;
  reworks: Array<{
    requestedBy: { stepId: string; agent: string | null };
    targetStepId: string;
    feedback: string;
    iteration: number;
    requestedAt: string;
    resolvedAt: string | null;
  }>;
}

export function getRunContext(runId: string): WorkflowContextResponse | null {
  const run = getRunById(runId);
  if (!run) return null;

  const workflowRow = getDrizzle().select().from(workflowsTable).where(eq(workflowsTable.id, run.workflowId)).get();
  if (!workflowRow) return null;
  const workflow = parseWorkflow(workflowRow);

  const stepRuns = getStepRunsForRun(runId);
  const context = run.context as any;

  const steps = workflow.steps.map(s => {
    const sr = stepRuns.find(r => r.stepId === s.id);
    return {
      id: s.id,
      name: s.name || s.id,
      role: s.role,
      agent: sr?.agentName ?? null,
      status: sr?.status ?? 'pending',
      output: sr?.output ?? null,
      completedAt: sr?.completedAt ?? null,
      iteration: sr?.retryState.loopIteration ?? 0,
    };
  });

  const reworks: WorkflowContextResponse['reworks'] = (context.reworks as ReworkEntry[] | undefined) ?? [];

  return {
    workflow: { id: workflow.id, name: workflow.name, status: run.status },
    steps,
    reworks,
  };
}

// ── Public query helpers ────────────────────────────────────────────

export function getWorkflowsForProject(projectId: string): Workflow[] {
  const db = getDrizzle();
  const wpRows = db.select({ workflowId: workflowProjects.workflowId }).from(workflowProjects).where(eq(workflowProjects.projectId, projectId)).all();
  if (wpRows.length === 0) return [];
  const wIds = wpRows.map(r => r.workflowId);
  const rows = db.select().from(workflowsTable).where(inArray(workflowsTable.id, wIds)).all();
  return rows.map(parseWorkflow);
}

export function getWorkflowById(id: string): Workflow | null {
  const row = getDrizzle().select().from(workflowsTable).where(eq(workflowsTable.id, id)).get();
  return row ? parseWorkflow(row) : null;
}

export function getRunsForWorkflow(workflowId: string, limit = 20): WorkflowRun[] {
  const rows = getDrizzle().select().from(workflowRuns)
    .where(eq(workflowRuns.workflowId, workflowId))
    .orderBy(desc(workflowRuns.createdAt))
    .limit(limit)
    .all();
  return rows.map(r => getRunById(r.id)!).filter(Boolean);
}

export function getStepRuns(runId: string): (WorkflowStepRun & { gate?: string })[] {
  const stepRuns = getStepRunsForRun(runId);
  // Enrich with gate info from workflow definition
  const run = getRunById(runId);
  if (!run) return stepRuns;
  const workflowRow = getDrizzle().select().from(workflowsTable).where(eq(workflowsTable.id, run.workflowId)).get();
  if (!workflowRow) return stepRuns;
  const workflow = parseWorkflow(workflowRow);
  const stepMap = new Map(workflow.steps.map(s => [s.id, s]));
  return stepRuns.map(sr => {
    const def = stepMap.get(sr.stepId);
    return def?.gate ? { ...sr, gate: def.gate } : sr;
  });
}

/**
 * Get the retryable upstream steps for a gate step.
 * Returns the steps listed in the gate's `waitFor` array (these are what can be retried).
 */
export function getGateUpstreamSteps(
  runId: string,
  gateStepId: string,
): { id: string; name: string }[] {
  const run = getRunById(runId);
  if (!run) return [];
  const workflowRow = getDrizzle().select().from(workflowsTable).where(eq(workflowsTable.id, run.workflowId)).get();
  if (!workflowRow) return [];
  const workflow = parseWorkflow(workflowRow);
  const gateStep = workflow.steps.find(s => s.id === gateStepId);
  if (!gateStep || !gateStep.waitFor) return [];
  return gateStep.waitFor.map(depId => {
    const step = workflow.steps.find(s => s.id === depId);
    return { id: depId, name: step?.name ?? depId };
  });
}

// ── Auto-dispatch unblocked issues (#159) ────────────────────────────

/**
 * Called after a workflow run completes successfully.
 * Marks any dependencies on the completed issue as resolved, then checks
 * if any previously-blocked issues are now fully unblocked.
 * If so (and the WIP limit allows), emits an event to trigger triage.
 */
async function checkAndDispatchUnblockedIssues(run: WorkflowRun): Promise<void> {
  const vars = (run.context as any)?._vars ?? {};
  const issueNumber = vars.issueNumber as number | undefined;
  const issueRepo = vars.issueRepo as string | undefined;

  if (!issueNumber || !issueRepo) {
    // Run wasn't triggered by a GitHub issue — nothing to unblock
    return;
  }

  const db = getDrizzle();

  // Mark all dependencies where this issue was the blocker as resolved
  db.run(sql`
    UPDATE issue_dependencies
    SET resolved = 1
    WHERE blocked_by_repo = ${issueRepo}
      AND blocked_by_issue_number = ${issueNumber}
      AND resolved = 0
  `);

  // Find issues that were blocked by this one
  const dependents = db.select().from(issueDependencies)
    .where(
      and(
        eq(issueDependencies.blockedByRepo, issueRepo),
        eq(issueDependencies.blockedByIssueNumber, issueNumber),
      ),
    )
    .all();

  if (dependents.length === 0) return;

  for (const dep of dependents) {
    // Check if ALL blockers for this dependent issue are now resolved
    const unresolvedCount = db.all(sql`
      SELECT COUNT(*) as cnt
      FROM issue_dependencies
      WHERE repo = ${dep.repo}
        AND issue_number = ${dep.issueNumber}
        AND resolved = 0
    `) as Array<{ cnt: number }>;

    const remaining = unresolvedCount[0]?.cnt ?? 0;
    if (remaining > 0) {
      console.log(`[workflow-engine] Issue #${dep.issueNumber} in ${dep.repo} still has ${remaining} unresolved blocker(s) — skipping`);
      continue;
    }

    // Check WIP limit for the project
    const activeRuns = getActiveWorkflowRuns().filter(r => r.projectId === dep.projectId);
    const project = projectsRepo.get(dep.projectId);
    const maxConcurrent = project?.maxConcurrent ?? 3;

    if (activeRuns.length >= maxConcurrent) {
      console.log(`[workflow-engine] WIP limit (${maxConcurrent}) reached for project "${project?.name ?? dep.projectId}" — issue #${dep.issueNumber} will be picked up on next completion`);
      continue;
    }

    // All blockers resolved and WIP allows — emit event to trigger triage
    console.log(`[workflow-engine] Issue #${dep.issueNumber} in ${dep.repo} is now unblocked — emitting issue.unblocked`);
    eventBus.emit('issue.unblocked', {
      projectId: dep.projectId,
      repo: dep.repo,
      issueNumber: dep.issueNumber,
    });
  }
}
