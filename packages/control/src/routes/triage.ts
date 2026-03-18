import { Router } from 'express';
import { requireScope } from '../middleware/scopes.js';
import { registerToolDef } from '../utils/tool-registry.js';

registerToolDef({
  category: 'issues',
  name: 'armada_triage_dismiss',
  description: 'Dismiss a GitHub issue — mark it as triaged and optionally close it on GitHub with a wontfix label.',
  method: 'POST',
  path: '/api/triage/dismiss',
  parameters: [
    { name: 'projectId', type: 'string', description: 'Project ID', required: true },
    { name: 'issueNumber', type: 'number', description: 'GitHub issue number', required: true },
    { name: 'reason', type: 'string', description: 'Reason for dismissal', required: true },
    { name: 'closeOnGithub', type: 'boolean', description: 'Also close the issue on GitHub and add wontfix label' },
  ],
  scope: 'tasks:write',
});

registerToolDef({
  category: 'issues',
  name: 'armada_triage_scan',
  description: 'Scan all projects for untriaged GitHub issues and dispatch triage to PM agents.',
  method: 'POST', path: '/api/triage/scan',
  parameters: [],
    scope: 'tasks:write',
});

registerToolDef({
  category: 'issues',
  name: 'armada_triage_issue',
  description: 'Triage a specific GitHub issue. If project has a PM agent, it triages. Otherwise returns to operator.',
  method: 'POST', path: '/api/triage/issue',
  parameters: [
    { name: 'projectId', type: 'string', description: 'Project ID', required: true },
    { name: 'issueNumber', type: 'number', description: 'GitHub issue number', required: true },
  ],
    scope: 'tasks:write',
});

registerToolDef({
  category: 'issues',
  name: 'armada_triage_mark',
  description: 'Mark an issue as triaged (when operator handles it manually).',
  method: 'POST', path: '/api/triage/mark',
  parameters: [
    { name: 'projectId', type: 'string', description: 'Project ID', required: true },
    { name: 'issueNumber', type: 'number', description: 'GitHub issue number', required: true },
  ],
    scope: 'tasks:write',
});

registerToolDef({
  category: 'issues',
  name: 'armada_triage_dispatch',
  description: 'Triage a GitHub issue by selecting a workflow and launching it. Auto-populates issue details as template variables. Marks the issue as triaged.',
  method: 'POST',
  path: '/api/triage/dispatch',
  parameters: [
    { name: 'projectId', type: 'string', description: 'Project ID', required: true },
    { name: 'issueNumber', type: 'number', description: 'GitHub issue number', required: true },
    { name: 'workflowId', type: 'string', description: 'Workflow ID to run', required: true },
    { name: 'vars', type: 'string', description: 'Additional template variables as JSON (optional)' },
  ],
  scope: 'workflows:write',
});

import { triageIssue, handleTriageResult, triageNewIssues, markIssueTriaged, triageDispatch, triageDismiss } from '../services/triage.js';
import { getCachedIssues } from '../services/issue-sync.js';

const router = Router();

/** POST /api/triage/callback — PM agent triage result callback */
router.post('/callback', requireScope('tasks:write'), async (req, res) => {
  const { taskId, result, status, message: resultMessage, error } = req.body;

  // Ignore pings and progress
  if (req.body.type === 'ping' || status === 'working') {
    res.json({ ok: true, ack: 'ping' });
    return;
  }

  if (status === 'error' || error) {
    console.error(`[triage] PM triage failed for ${taskId}: ${error || resultMessage}`);
    res.json({ ok: true, error: 'Triage failed' });
    return;
  }

  const finalResult = result || resultMessage || '';
  console.log(`[triage] Received triage result for ${taskId}: ${finalResult.slice(0, 200)}`);

  const outcome = await handleTriageResult(taskId, finalResult);
  res.json(outcome);
});

/** POST /api/triage/issue — Manually triage a specific issue */
router.post('/issue', requireScope('tasks:write'), async (req, res) => {
  const { projectId, issueNumber } = req.body;
  if (!projectId || !issueNumber) {
    res.status(400).json({ error: 'projectId and issueNumber required' });
    return;
  }

  const issues = getCachedIssues(projectId);
  const issue = issues.find(i => i.number === issueNumber);
  if (!issue) {
    res.status(404).json({ error: `Issue #${issueNumber} not found in cache` });
    return;
  }

  const result = await triageIssue(projectId, issue);
  res.json(result);
});

/** POST /api/triage/scan — Scan all projects for untriaged issues */
router.post('/scan', requireScope('tasks:write'), async (_req, res) => {
  const results = await triageNewIssues();
  res.json({ scanned: true, results });
});

/** POST /api/triage/mark — Mark an issue as triaged (operator handled it) */
router.post('/mark', requireScope('tasks:write'), (req, res) => {
  const { projectId, issueNumber } = req.body;
  if (!projectId || !issueNumber) {
    res.status(400).json({ error: 'projectId and issueNumber required' });
    return;
  }
  markIssueTriaged(projectId, issueNumber);
  res.json({ marked: true });
});

/** POST /api/triage/dispatch — Unified triage dispatch for humans and agents */
router.post('/dispatch', requireScope('workflows:write'), async (req, res) => {
  const { projectId, issueNumber, workflowId, vars: rawVars } = req.body;
  if (!projectId || !issueNumber || !workflowId) {
    res.status(400).json({ error: 'projectId, issueNumber, and workflowId are required' });
    return;
  }

  // Parse vars if passed as JSON string (from agent tool calls)
  let extraVars: Record<string, string> = {};
  if (rawVars) {
    if (typeof rawVars === 'string') {
      try {
        extraVars = JSON.parse(rawVars);
      } catch {
        res.status(400).json({ error: 'vars must be valid JSON' });
        return;
      }
    } else if (typeof rawVars === 'object') {
      extraVars = rawVars;
    }
  }

  const result = await triageDispatch({ projectId, issueNumber, workflowId, vars: extraVars });

  if (result.error === 'issue_not_found') {
    res.status(404).json({ error: `Issue #${issueNumber} not found in cache for project ${projectId}` });
    return;
  }
  if (result.error === 'workflow_not_found') {
    res.status(404).json({ error: `Workflow ${workflowId} not found or is disabled` });
    return;
  }
  if (result.error) {
    res.status(500).json({ error: result.error });
    return;
  }

  res.json({ ok: true, runId: result.runId, workflowName: result.workflowName });
});

/** POST /api/triage/dismiss — Dismiss an issue (mark triaged, optionally close on GitHub) */
router.post('/dismiss', requireScope('tasks:write'), async (req, res) => {
  const { projectId, issueNumber, reason, closeOnGithub } = req.body;
  if (!projectId || !issueNumber || !reason) {
    res.status(400).json({ error: 'projectId, issueNumber, and reason are required' });
    return;
  }

  const result = await triageDismiss({
    projectId,
    issueNumber: Number(issueNumber),
    reason,
    closeOnGithub: Boolean(closeOnGithub),
  });

  if (result.error) {
    // Still dismissed locally — return 200 with warning
    res.json({ dismissed: result.dismissed, warning: result.error });
    return;
  }

  res.json({ dismissed: result.dismissed });
});

export default router;
