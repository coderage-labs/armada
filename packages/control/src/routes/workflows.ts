import { Router } from 'express';
import { requireScope } from '../middleware/scopes.js';
import { randomUUID } from 'node:crypto';
import { getDrizzle } from '../db/drizzle.js';
import { workflows, workflowProjects, workflowRuns, workflowStepRuns } from '../db/drizzle-schema.js';
import { eq, desc, and } from 'drizzle-orm';
import { registerToolDef } from '../utils/tool-registry.js';
import { setupSSE } from '../utils/sse.js';
import { parseJsonField } from '../utils/parse-json-field.js';
import { subscribe } from '../utils/event-bus.js';
import { logAudit } from '../services/audit.js';
import { editGateResolution } from '../services/telegram-bot.js';
import type { TelegramNotification } from '../services/user-notifier.js';

// ── Tool definitions ────────────────────────────────────────────────

registerToolDef({
  name: 'armada_workflows_list',
  description: 'List all workflows. Optional projectId filter.',
  method: 'GET', path: '/api/workflows',
  parameters: [{ name: 'projectId', type: 'string', description: 'Filter by project ID' }],
    scope: 'workflows:read',
});

registerToolDef({
  name: 'armada_workflow_get',
  description: 'Get a workflow by ID. Returns steps, projectIds, enabled status.',
  method: 'GET', path: '/api/workflows/:id',
  parameters: [{ name: 'id', type: 'string', description: 'Workflow ID', required: true }],
    scope: 'workflows:read',
});

registerToolDef({
  name: 'armada_workflow_create',
  description: 'Create a new workflow with steps and project assignments.',
  method: 'POST', path: '/api/workflows',
  parameters: [
    { name: 'name', type: 'string', description: 'Workflow name', required: true },
    { name: 'description', type: 'string', description: 'Description' },
    { name: 'projectIds', type: 'string', description: 'JSON array of project IDs to assign' },
    { name: 'steps', type: 'string', description: 'JSON array of workflow steps', required: true },
  ],
    scope: 'workflows:write',
});

registerToolDef({
  name: 'armada_workflow_update',
  description: 'Update a workflow (name, description, steps, enabled, projectIds).',
  method: 'PUT', path: '/api/workflows/:id',
  parameters: [
    { name: 'id', type: 'string', description: 'Workflow ID', required: true },
    { name: 'name', type: 'string', description: 'Workflow name' },
    { name: 'description', type: 'string', description: 'Description' },
    { name: 'steps', type: 'string', description: 'JSON array of workflow steps' },
    { name: 'projectIds', type: 'string', description: 'JSON array of project IDs' },
    { name: 'enabled', type: 'boolean', description: 'Enable/disable workflow' },
  ],
    scope: 'workflows:write',
});

registerToolDef({
  name: 'armada_workflow_delete',
  description: 'Delete a workflow.',
  method: 'DELETE', path: '/api/workflows/:id',
  parameters: [{ name: 'id', type: 'string', description: 'Workflow ID', required: true }],
    scope: 'workflows:write',
});

registerToolDef({
  name: 'armada_workflow_run',
  description: 'Start a workflow run. Dispatches steps to agents by role.',
  method: 'POST', path: '/api/workflows/:id/run',
  parameters: [
    { name: 'id', type: 'string', description: 'Workflow ID', required: true },
    { name: 'projectId', type: 'string', description: 'Project ID for this run' },
    { name: 'triggerRef', type: 'string', description: 'Trigger reference (e.g. issue URL)' },
    { name: 'vars', type: 'string', description: 'JSON object of template variables' },
  ],
    scope: 'workflows:write',
});

registerToolDef({
  name: 'armada_workflow_runs',
  description: 'List recent runs for a workflow.',
  method: 'GET', path: '/api/workflows/:id/runs',
  parameters: [
    { name: 'id', type: 'string', description: 'Workflow ID', required: true },
    { name: 'limit', type: 'number', description: 'Max runs to return (default 20)' },
  ],
    scope: 'workflows:read',
});

registerToolDef({
  name: 'armada_workflow_run_get',
  description: 'Get details of a workflow run including step outputs and context.',
  method: 'GET', path: '/api/workflows/runs/:runId',
  parameters: [{ name: 'runId', type: 'string', description: 'Run ID', required: true }],
    scope: 'workflows:read',
});

registerToolDef({
  name: 'armada_workflow_run_steps',
  description: 'Get step runs for a workflow run.',
  method: 'GET', path: '/api/workflows/runs/:runId/steps',
  parameters: [{ name: 'runId', type: 'string', description: 'Run ID', required: true }],
    scope: 'workflows:read',
});

registerToolDef({
  name: 'armada_workflow_run_approve',
  description: 'Approve a manual gate step to continue the workflow.',
  method: 'POST', path: '/api/workflows/runs/:runId/approve/:stepId',
  parameters: [
    { name: 'runId', type: 'string', description: 'Run ID', required: true },
    { name: 'stepId', type: 'string', description: 'Step ID to approve', required: true },
  ],
    scope: 'workflows:write',
});

registerToolDef({
  name: 'armada_workflow_run_reject',
  description: 'Reject a manual gate step. Fails the run if the gate is required, skips downstream if optional.',
  method: 'POST', path: '/api/workflows/runs/:runId/reject/:stepId',
  parameters: [
    { name: 'runId', type: 'string', description: 'Run ID', required: true },
    { name: 'stepId', type: 'string', description: 'Step ID to reject', required: true },
    { name: 'reason', type: 'string', description: 'Rejection reason' },
  ],
    scope: 'workflows:write',
});

registerToolDef({
  name: 'armada_workflow_run_retry',
  description: 'Retry a workflow step with optional feedback. Cascades reset to downstream steps.',
  method: 'POST', path: '/api/workflows/runs/:runId/retry/:stepId',
  parameters: [
    { name: 'runId', type: 'string', description: 'Run ID', required: true },
    { name: 'stepId', type: 'string', description: 'Step ID to retry', required: true },
    { name: 'feedback', type: 'string', description: 'Feedback for the retry (what was wrong)' },
  ],
    scope: 'workflows:write',
});

registerToolDef({
  name: 'armada_workflow_run_cancel',
  description: 'Cancel a workflow run.',
  method: 'POST', path: '/api/workflows/runs/:runId/cancel',
  parameters: [{ name: 'runId', type: 'string', description: 'Run ID', required: true }],
    scope: 'workflows:write',
});

registerToolDef({
  name: 'armada_workflow_run_context',
  description: 'Get the full workflow context for a run — all steps, their outputs, agents, and rework history. Agents use this to inspect the workflow state.',
  method: 'GET', path: '/api/workflow-runs/:runId/context',
  parameters: [{ name: 'runId', type: 'string', description: 'Run ID', required: true }],
    scope: 'workflows:read',
});

registerToolDef({
  name: 'armada_workflow_run_rework',
  description: 'Request rework on a previously completed step. The requesting step is paused, the target step is reset and re-dispatched with feedback.',
  method: 'POST', path: '/api/workflow-runs/:runId/rework',
  parameters: [
    { name: 'runId', type: 'string', description: 'Run ID', required: true },
    { name: 'requestingStepId', type: 'string', description: 'Step ID requesting the rework (must be running)', required: true },
    { name: 'targetStepId', type: 'string', description: 'Step ID to rework (must be completed)', required: true },
    { name: 'feedback', type: 'string', description: 'Feedback explaining what needs to change', required: true },
  ],
    scope: 'workflows:write',
});

registerToolDef({
  name: 'armada_workflow_runs_active',
  description: 'Get all active (running/paused) workflow runs with step data.',
  method: 'GET', path: '/api/workflows/runs/active',
  parameters: [],
    scope: 'workflows:read',
});

registerToolDef({
  name: 'armada_workflow_runs_recent',
  description: 'Get completed/failed/cancelled workflow runs from the last 24 hours.',
  method: 'GET', path: '/api/workflows/runs/recent',
  parameters: [],
    scope: 'workflows:read',
});
import {
  getWorkflowsForProject,
  getWorkflowById,
  getRunsForWorkflow,
  getStepRuns,
  startRun,
  approveGate,
  rejectGate,
  cancelRun,
  retryStep,
  onStepCompleted,
  detectCycle,
  createWorkflow,
  updateWorkflow,
  getActiveWorkflowRuns,
  getRecentWorkflowRuns,
  getWorkflowStats,
  getWorkflowVariables,
  requestRework,
  getRunContext,
} from '../services/workflow-engine.js';

const router = Router();

// ── CRUD: Workflows ───────────────────────────────────────────────

/** GET /api/workflows?projectId= */
router.get('/', (req, res) => {
  const projectId = req.query.projectId as string;
  if (projectId) {
    res.json(getWorkflowsForProject(projectId));
    return;
  }
  // Return all workflows
  const rows = getDrizzle().select().from(workflows).orderBy(desc(workflows.createdAt)).all();
  res.json(rows.map(r => ({
    ...r,
    steps: JSON.parse(r.stepsJson || '[]'),
    projectId: undefined,
    enabled: !!r.enabled,
  })));
});

/** GET /api/workflows/runs/active — All active workflow runs with step data */
router.get('/runs/active', (_req, res) => {
  res.json(getActiveWorkflowRuns());
});

/** GET /api/workflows/runs/recent — Completed runs from last 24h */
router.get('/runs/recent', (_req, res) => {
  res.json(getRecentWorkflowRuns());
});

/** GET /api/workflows/:id */
router.get('/:id', (req, res) => {
  const wf = getWorkflowById(req.params.id);
  if (!wf) { res.status(404).json({ error: 'Workflow not found' }); return; }
  const pIds = getDrizzle()
    .select({ projectId: workflowProjects.projectId })
    .from(workflowProjects)
    .where(eq(workflowProjects.workflowId, req.params.id))
    .all();
  res.json({ ...wf, projectIds: pIds.map(p => p.projectId) });
});

/** POST /api/workflows */
router.post('/', requireScope('workflows:write'), (req, res) => {
  const { projectIds, projectId, name, description, steps } = req.body;
  const parsedSteps = parseJsonField(steps);
  const parsedProjectIds = parseJsonField<string[]>(projectIds);
  if (!name || !parsedSteps) {
    res.status(400).json({ error: 'name and steps are required' });
    return;
  }
  const cycle = detectCycle(parsedSteps as any[]);
  if (cycle) {
    res.status(400).json({ error: `Circular dependency detected: ${cycle.join(' → ')}` });
    return;
  }

  const id = randomUUID();
  const pIds: string[] = parsedProjectIds || (projectId ? [projectId] : []);
  const wf = createWorkflow(id, { name, description, steps: parsedSteps as any[], projectIds: pIds });

  logAudit(req, 'workflow.create', 'workflow', id, { name });
  res.status(201).json(wf);
});

/** PUT /api/workflows/:id */
router.put('/:id', requireScope('workflows:write'), (req, res) => {
  const { name, description, enabled, projectIds } = req.body;
  let parsedSteps: any[] | undefined;

  if (req.body.steps !== undefined) {
    parsedSteps = parseJsonField(req.body.steps) as any[];
    const cycle = detectCycle(parsedSteps as any[]);
    if (cycle) {
      res.status(400).json({ error: `Circular dependency detected: ${cycle.join(' → ')}` });
      return;
    }
  }

  const parsedProjectIds = projectIds !== undefined ? (parseJsonField<string[]>(projectIds) || []) : undefined;

  const wf = updateWorkflow(req.params.id, {
    name,
    description,
    steps: parsedSteps,
    enabled,
    projectIds: parsedProjectIds,
  });

  if (!wf) { res.status(404).json({ error: 'Workflow not found' }); return; }

  logAudit(req, 'workflow.update', 'workflow', req.params.id, { name });
  res.json(wf);
});

/** DELETE /api/workflows/:id */
router.delete('/:id', requireScope('workflows:write'), (req, res) => {
  getDrizzle().delete(workflows).where(eq(workflows.id, req.params.id)).run();
  logAudit(req, 'workflow.delete', 'workflow', req.params.id);
  res.json({ deleted: true });
});

// ── Runs ────────────────────────────────────────────────────────────

/** GET /api/workflows/:id/variables — Extract template variables from step prompts */
router.get('/:id/variables', requireScope('workflows:read'), (req, res) => {
  const vars = getWorkflowVariables(req.params.id);
  if (!vars) { res.status(404).json({ error: 'Workflow not found' }); return; }
  res.json(vars);
});

/** GET /api/workflows/:id/runs */
router.get('/:id/runs', (req, res) => {
  const limit = parseInt(req.query.limit as string) || 20;
  res.json(getRunsForWorkflow(req.params.id, limit));
});

/** GET /api/workflows/:id/stats — Run statistics for a workflow */
router.get('/:id/stats', (req, res) => {
  const stats = getWorkflowStats(req.params.id);
  if (!stats) { res.status(404).json({ error: 'Workflow not found' }); return; }
  res.json(stats);
});

/** POST /api/workflows/:id/run — Start a new run */
router.post('/:id/run', requireScope('workflows:write'), async (req, res) => {
  const wf = getWorkflowById(req.params.id);
  if (!wf) { res.status(404).json({ error: 'Workflow not found' }); return; }
  if (!wf.enabled) { res.status(400).json({ error: 'Workflow is disabled' }); return; }

  try {
    const { triggerType, triggerRef, vars, variables, projectId } = req.body || {};
    const parsedVars = parseJsonField<Record<string, any>>(vars || variables);
    const run = await startRun(wf, triggerType || 'api', triggerRef, parsedVars, projectId);
    logAudit(req, 'workflow.run_start', 'workflow_run', run.id, { workflowId: req.params.id });
    res.status(201).json(run);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/workflow-runs/:runId */
router.get('/runs/:runId', (req, res) => {
  const row = getDrizzle().select().from(workflowRuns).where(eq(workflowRuns.id, req.params.runId)).get();
  if (!row) { res.status(404).json({ error: 'Run not found' }); return; }
  res.json({
    ...row,
    context: JSON.parse(row.contextJson || '{}'),
  });
});

/** GET /api/workflow-runs/:runId/steps */
router.get('/runs/:runId/steps', (req, res) => {
  res.json(getStepRuns(req.params.runId));
});

/** POST /api/workflow-runs/:runId/approve/:stepId — Approve a manual gate */
router.post('/runs/:runId/approve/:stepId', requireScope('workflows:write'), async (req, res) => {
  try {
    const { resolvedBy } = req.body || {};
    const approver = resolvedBy || req.caller?.displayName || req.caller?.name || 'operator';

    // Fetch telegram notification IDs before approving (step status will change)
    const stepRunBefore = getDrizzle().select().from(workflowStepRuns)
      .where(and(eq(workflowStepRuns.runId, req.params.runId), eq(workflowStepRuns.stepId, req.params.stepId)))
      .get();

    await approveGate(req.params.runId, req.params.stepId, approver);
    logAudit(req, 'gate.approve', 'workflow_run', req.params.runId, { stepId: req.params.stepId });

    // Edit original Telegram notification to show resolution
    if (stepRunBefore?.telegramNotificationsJson) {
      try {
        const notifications: TelegramNotification[] = JSON.parse(stepRunBefore.telegramNotificationsJson);
        for (const n of notifications) {
          await editGateResolution(n.chatId, n.messageId, `✅ Approved by <b>${approver}</b>`);
        }
      } catch (err: any) {
        console.error('[workflows] Failed to update Telegram gate notification on approve:', err.message);
      }
    }

    res.json({ approved: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

/** POST /api/workflow-runs/:runId/reject/:stepId — Reject a manual gate */
router.post('/runs/:runId/reject/:stepId', requireScope('workflows:write'), async (req, res) => {
  try {
    const { reason } = req.body || {};
    const rejector = req.caller?.displayName || req.caller?.name || 'operator';

    // Fetch telegram notification IDs before rejecting (step status will change)
    const stepRunBefore = getDrizzle().select().from(workflowStepRuns)
      .where(and(eq(workflowStepRuns.runId, req.params.runId), eq(workflowStepRuns.stepId, req.params.stepId)))
      .get();

    await rejectGate(req.params.runId, req.params.stepId, reason || 'Rejected');
    logAudit(req, 'gate.reject', 'workflow_run', req.params.runId, { stepId: req.params.stepId, reason });

    // Edit original Telegram notification to show rejection
    if (stepRunBefore?.telegramNotificationsJson) {
      try {
        const notifications: TelegramNotification[] = JSON.parse(stepRunBefore.telegramNotificationsJson);
        for (const n of notifications) {
          await editGateResolution(n.chatId, n.messageId, `❌ Rejected by <b>${rejector}</b>${reason ? `\n\n💬 ${reason}` : ''}`);
        }
      } catch (err: any) {
        console.error('[workflows] Failed to update Telegram gate notification on reject:', err.message);
      }
    }

    res.json({ rejected: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

/** POST /api/workflow-runs/:runId/retry/:stepId — Retry a step with optional feedback */
router.post('/runs/:runId/retry/:stepId', requireScope('workflows:write'), async (req, res) => {
  try {
    const { feedback } = req.body || {};
    await retryStep(req.params.runId, req.params.stepId, feedback);
    logAudit(req, 'step.retry', 'workflow_run', req.params.runId, { stepId: req.params.stepId, feedback });
    res.json({ retrying: true, stepId: req.params.stepId });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

/** GET /api/workflow-runs/:runId/context — Full workflow state for agent inspection */
router.get('/runs/:runId/context', requireScope('workflows:read'), (req, res) => {
  const ctx = getRunContext(req.params.runId);
  if (!ctx) { res.status(404).json({ error: 'Run not found' }); return; }
  res.json(ctx);
});

/** POST /api/workflow-runs/:runId/rework — Request rework on a completed step */
router.post('/runs/:runId/rework', requireScope('workflows:write'), async (req, res) => {
  const { requestingStepId, targetStepId, feedback } = req.body || {};
  if (!requestingStepId || !targetStepId || !feedback) {
    res.status(400).json({ error: 'requestingStepId, targetStepId, and feedback are required' });
    return;
  }
  try {
    await requestRework(req.params.runId, requestingStepId, targetStepId, feedback);
    logAudit(req, 'workflow.rework_requested', 'workflow_run', req.params.runId, {
      requestingStepId, targetStepId, feedback,
    });
    res.json({ reworkRequested: true, requestingStepId, targetStepId });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

/** POST /api/workflow-runs/:runId/cancel */
router.post('/runs/:runId/cancel', requireScope('workflows:write'), (req, res) => {
  cancelRun(req.params.runId);
  logAudit(req, 'workflow.run_cancel', 'workflow_run', req.params.runId);
  res.json({ cancelled: true });
});

/** POST /api/workflow-runs/step-completed — Called when a task completes */
router.post('/runs/step-completed', requireScope('workflows:write'), async (req, res) => {
  const { taskId, status, output, sharedRefs } = req.body;
  if (!taskId || !status) {
    res.status(400).json({ error: 'taskId and status required' });
    return;
  }
  try {
    await onStepCompleted(taskId, status, output || '', sharedRefs || []);
    res.json({ processed: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** SSE stream for workflow step updates */
router.get('/events', (req, res) => {
  const sse = setupSSE(res);
  const unsub = subscribe((event, data) => {
    if (event.startsWith('workflow:')) {
      sse.send(event, data);
    }
  });
  res.on('close', unsub);
});

export default router;
