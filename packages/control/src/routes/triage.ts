import { Router } from 'express';
import { requireScope } from '../middleware/scopes.js';
import { registerToolDef } from '../utils/tool-registry.js';

registerToolDef({
  name: 'armada_triage_scan',
  description: 'Scan all projects for untriaged GitHub issues and dispatch triage to PM agents.',
  method: 'POST', path: '/api/triage/scan',
  parameters: [],
});

registerToolDef({
  name: 'armada_triage_issue',
  description: 'Triage a specific GitHub issue. If project has a PM agent, it triages. Otherwise returns to operator.',
  method: 'POST', path: '/api/triage/issue',
  parameters: [
    { name: 'projectId', type: 'string', description: 'Project ID', required: true },
    { name: 'issueNumber', type: 'number', description: 'GitHub issue number', required: true },
  ],
});

registerToolDef({
  name: 'armada_triage_mark',
  description: 'Mark an issue as triaged (when operator handles it manually).',
  method: 'POST', path: '/api/triage/mark',
  parameters: [
    { name: 'projectId', type: 'string', description: 'Project ID', required: true },
    { name: 'issueNumber', type: 'number', description: 'GitHub issue number', required: true },
  ],
});
import { triageIssue, handleTriageResult, triageNewIssues, markIssueTriaged } from '../services/triage.js';
import { getCachedIssues } from '../services/github-sync.js';

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

export default router;
