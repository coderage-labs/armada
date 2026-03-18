/**
 * Triage Service — routes new issues to workflows.
 *
 * Logic:
 * - Project has a PM-tier agent? → Send triage task to that agent
 * - No PM? → Return null (operator handles triage via armada-control tools)
 *
 * PM triage returns structured JSON: { workflowId, vars, reasoning }
 * which is then used to start a workflow run.
 */

import { agentsRepo, projectsRepo, roleMetaRepo, tasksRepo, instancesRepo, userProjectsRepo, assignmentRepo } from '../repositories/index.js';
import { getDrizzle } from '../db/drizzle.js';
import { triagedIssues } from '../db/drizzle-schema.js';
import { and, eq, sql } from 'drizzle-orm';
import { getWorkflowsForProject, startRun, getWorkflowById } from './workflow-engine.js';
import { getCachedIssues } from './github-sync.js';
import { logActivity } from './activity-service.js';
import { eventBus } from '../infrastructure/event-bus.js';
import { getNodeClient } from '../infrastructure/node-client.js';
import { notifyTriageOperatorFallback } from './user-notifier.js';
import type { GitHubIssue } from '@coderage-labs/armada-shared';

// ── Rate limiting for operator fallback notifications ─────────────────────────
// Prevents notification spam when many issues fall back at once.
// Each unique (projectId, issueNumber) pair is debounced: the first fallback triggers
// a notification immediately; subsequent fallbacks within COOLDOWN_MS are silently skipped.

const FALLBACK_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
const fallbackNotifiedAt = new Map<string, number>(); // key: `${projectId}:${issueNumber}`

function shouldNotifyFallback(projectId: string, issueNumber: number): boolean {
  const key = `${projectId}:${issueNumber}`;
  const last = fallbackNotifiedAt.get(key);
  const now = Date.now();
  if (last !== undefined && now - last < FALLBACK_COOLDOWN_MS) return false;
  fallbackNotifiedAt.set(key, now);
  return true;
}

const CONTROL_PLANE_URL = process.env.ARMADA_API_URL || 'http://armada-control:3001';

// ── Persistent triage state (DB-backed) ─────────────────────────────

function isIssueTriaged(projectId: string, issueNumber: number): boolean {
  const row = getDrizzle()
    .select({ id: triagedIssues.id })
    .from(triagedIssues)
    .where(and(eq(triagedIssues.projectId, projectId), eq(triagedIssues.issueNumber, issueNumber)))
    .get();
  return !!row;
}

function markIssueTriage(projectId: string, issueNumber: number): void {
  const id = `${projectId}:${issueNumber}`;
  getDrizzle().insert(triagedIssues).values({
    id,
    projectId,
    issueNumber,
    triagedAt: new Date().toISOString(),
  }).onConflictDoNothing().run();
}

// Cache issue data for handleTriageResult (taskId → issue metadata)
const pendingTriageIssues = new Map<string, { number: number; title: string; body: string; labels: string[] }>();

interface TriageResult {
  workflowId: string;
  vars: Record<string, any>;
  reasoning: string;
}

/**
 * Resolve the PM agent for a project (tier 1 in hierarchy).
 */
function resolveProjectManager(projectId: string): { name: string; role: string } | null {
  const project = projectsRepo.get(projectId);
  if (!project) return null;

  const members = projectsRepo.getMembers(project.id);
  const agents = agentsRepo.getAll();
  const roles = roleMetaRepo.getAll();

  for (const memberName of members) {
    const agent = agents.find(a => a.name === memberName);
    if (!agent?.role) continue;
    const meta = roles.find(r => r.role === agent.role);
    if (meta?.tier === 1 && (agent.status === 'running' || (agent.status as string) === 'healthy')) {
      return { name: agent.name, role: agent.role };
    }
  }
  return null;
}

/**
 * Triage a single issue for a project.
 * Returns the triage result if a PM handles it, null if operator should handle it.
 */
export async function triageIssue(
  projectId: string,
  issue: GitHubIssue,
): Promise<{ triaged: boolean; by: 'pm' | 'operator'; result?: TriageResult; runId?: string }> {
  if (isIssueTriaged(projectId, issue.number)) {
    return { triaged: false, by: 'operator' };
  }

  const project = projectsRepo.get(projectId);
  const projectName = project?.name ?? projectId;

  // Try resolveTriager first (explicit assignment → role-based → owner → operators)
  // then fall back to the legacy PM resolution chain.
  const triagerCandidates = assignmentRepo.resolveTriager(projectId);
  const triagerAgent = triagerCandidates.find(c => c.type === 'agent');

  // Also check for PM-tier agent (legacy chain, kept as fallback)
  const legacyPm = resolveProjectManager(projectId);

  // Prefer explicit triager assignment, fall back to legacy PM
  const pm = triagerAgent
    ? { name: triagerAgent.name!, role: 'triager' }
    : legacyPm;

  const workflows = getWorkflowsForProject(projectId).filter(w => w.enabled);

  if (!pm) {
    // No triager or PM — notify owner/operators
    const reason = 'No triager or PM-tier agent is assigned and running for this project';
    if (shouldNotifyFallback(projectId, issue.number)) {
      // Notify project owner if one exists
      const owner = userProjectsRepo.getOwner(projectId);
      if (owner) {
        import('./user-notifier.js').then(({ deliverToUser }) => {
          const message = `🔔 **Triage Required**\n\nIssue #${issue.number}: ${issue.title}\nProject: ${projectName}\n\nNo triager agent available. As project owner, please triage this issue manually.\n\nReason: ${reason}`;
          deliverToUser(owner, message, { event: 'triage.owner_fallback', issueNumber: issue.number, issueTitle: issue.title, projectId, projectName, reason });
        }).catch((err: Error) => console.error('[triage] Failed to notify owner:', err.message));
      } else {
        // Try resolving owner from assignment table
        const ownerCandidates = assignmentRepo.resolveTriager(projectId).filter(c => c.type === 'user');
        for (const ownerCandidate of ownerCandidates) {
          import('./user-notifier.js').then(({ deliverToUser }) => {
            import('../repositories/index.js').then(({ usersRepo }) => {
              const ownerUser = usersRepo.getById(ownerCandidate.id);
              if (ownerUser) {
                const message = `🔔 **Triage Required**\n\nIssue #${issue.number}: ${issue.title}\nProject: ${projectName}\n\nNo triager agent available. Please triage this issue manually.\n\nReason: ${reason}`;
                deliverToUser(ownerUser, message, { event: 'triage.owner_fallback', issueNumber: issue.number, issueTitle: issue.title, projectId, projectName, reason });
              }
            }).catch(() => {});
          }).catch((err: Error) => console.error('[triage] Failed to notify owner candidate:', err.message));
        }
      }
      // Also notify operators (excluding already-notified owner)
      const alreadyNotified: string[] = [];
      if (owner) alreadyNotified.push(owner.id);
      notifyTriageOperatorFallback({
        issueNumber: issue.number,
        issueTitle: issue.title,
        projectId,
        projectName,
        reason,
        excludeUserIds: alreadyNotified,
      }).catch((err: Error) => console.error('[triage] Failed to send operator fallback notification:', err.message));
    }
    return { triaged: false, by: 'operator' };
  }

  if (workflows.length === 0) {
    // No workflows defined — can't auto-triage
    const reason = 'No enabled workflows are configured for this project';
    if (shouldNotifyFallback(projectId, issue.number)) {
      // Notify project owner if one exists
      const owner = userProjectsRepo.getOwner(projectId);
      if (owner) {
        import('./user-notifier.js').then(({ deliverToUser }) => {
          const message = `🔔 **Triage Required**\n\nIssue #${issue.number}: ${issue.title}\nProject: ${projectName}\n\nNo workflows configured. As project owner, please triage this issue manually.\n\nReason: ${reason}`;
          deliverToUser(owner, message, { event: 'triage.owner_fallback', issueNumber: issue.number, issueTitle: issue.title, projectId, projectName, reason });
        }).catch((err: Error) => console.error('[triage] Failed to notify owner:', err.message));
      }
      // Also notify operators
      notifyTriageOperatorFallback({
        issueNumber: issue.number,
        issueTitle: issue.title,
        projectId,
        projectName,
        reason,
      }).catch((err: Error) => console.error('[triage] Failed to send operator fallback notification:', err.message));
    }
    return { triaged: false, by: 'operator' };
  }

  // Build the triage prompt
  const AUTO_VARS = new Set(['vars.issueNumber', 'vars.issueTitle', 'vars.issueBody', 'vars.issueLabels', 'vars.issueUrl']);
  const workflowList = workflows.map(w => {
    const stepIds = w.steps.map(s => s.id).join(' → ');
    const allVars = extractTemplateVars(w.steps);
    const manualVars = allVars.filter(v => !AUTO_VARS.has(v));
    return `- **${w.name}** (id: ${w.id}): ${w.description || 'No description'}\n  Steps: ${stepIds}\n  Additional variables you must provide: ${manualVars.join(', ') || 'none (all auto-populated)'}`;
  }).join('\n');

  const triagePrompt = `You are triaging a GitHub issue for project assignment.

## Issue #${issue.number}: ${issue.title}
${issue.body?.slice(0, 2000) || 'No description'}

Labels: ${issue.labels?.join(', ') || 'none'}
${issue.milestone ? `Milestone: ${issue.milestone}` : ''}

## Available Workflows
${workflowList}

## Auto-populated variables (DO NOT include these in your vars — they are injected automatically)
- issueNumber, issueTitle, issueBody, issueLabels

## Your Task
1. Decide which workflow best fits this issue
2. Fill in ONLY the template variables that are NOT auto-populated
3. Explain your reasoning briefly

Respond with ONLY a JSON object (no markdown, no code fences):
{
  "workflowId": "the-workflow-id",
  "vars": { "additionalVarName": "value" },
  "reasoning": "brief explanation"
}

If none of the workflows fit, respond with:
{ "workflowId": null, "vars": {}, "reasoning": "why no workflow fits" }`;

  // Send triage task to PM agent via node relay
  const taskId = `triage-${projectId.slice(0, 8)}-${issue.number}`;

  // Resolve relay path for PM agent
  const pmAgent = agentsRepo.getAll().find(a => a.name === pm.name);
  if (!pmAgent?.instanceId) {
    console.error(`[triage] PM ${pm.name} has no instanceId`);
    const reason = `PM agent "${pm.name}" has no associated instance`;
    if (shouldNotifyFallback(projectId, issue.number)) {
      notifyTriageOperatorFallback({ issueNumber: issue.number, issueTitle: issue.title, projectId, projectName, reason })
        .catch((err: Error) => console.error('[triage] Failed to send operator fallback notification:', err.message));
    }
    return { triaged: false, by: 'operator' };
  }
  const pmInstance = instancesRepo.getById(pmAgent.instanceId);
  if (!pmInstance?.nodeId) {
    console.error(`[triage] Instance for PM ${pm.name} has no nodeId`);
    const reason = `PM agent "${pm.name}" instance has no associated node`;
    if (shouldNotifyFallback(projectId, issue.number)) {
      notifyTriageOperatorFallback({ issueNumber: issue.number, issueTitle: issue.title, projectId, projectName, reason })
        .catch((err: Error) => console.error('[triage] Failed to send operator fallback notification:', err.message));
    }
    return { triaged: false, by: 'operator' };
  }
  const pmContainerName = `armada-instance-${pmInstance.name}`;

  // Cache issue data so handleTriageResult can inject it as vars
  pendingTriageIssues.set(taskId, {
    number: issue.number,
    title: issue.title,
    body: issue.body?.slice(0, 4000) || '',
    labels: issue.labels || [],
  });

  try {
    const node = getNodeClient(pmInstance.nodeId);
    const body = JSON.stringify({
      taskId,
      from: 'triage-service',
      fromRole: 'operator',
      message: triagePrompt,
      callbackUrl: `${CONTROL_PLANE_URL}/api/triage/callback`,
    });

    const resp = await node.relayRequest(pmContainerName, 'POST', '/armada/task', body) as any;
    const status = resp?.statusCode ?? resp?.status ?? 200;

    if (status >= 400) {
      console.error(`[triage] PM ${pm.name} rejected triage task: ${JSON.stringify(resp)}`);
      const reason = `PM agent "${pm.name}" rejected the triage task (HTTP ${status})`;
      if (shouldNotifyFallback(projectId, issue.number)) {
        notifyTriageOperatorFallback({ issueNumber: issue.number, issueTitle: issue.title, projectId, projectName, reason })
          .catch((err: Error) => console.error('[triage] Failed to send operator fallback notification:', err.message));
      }
      return { triaged: false, by: 'operator' };
    }

    // Record in DB for tracking
    tasksRepo.create({
      id: taskId,
      fromAgent: 'triage-service',
      toAgent: pm.name,
      taskText: `Triage issue #${issue.number}: ${issue.title}`,
      result: null,
      status: 'running',
    });

    markIssueTriage(projectId, issue.number);

    logActivity({
      eventType: 'triage.dispatched',
      agentName: pm.name,
      detail: `Triaging issue #${issue.number}: ${issue.title}`,
    });

    console.log(`[triage] Dispatched issue #${issue.number} to ${pm.name} for triage`);
    return { triaged: true, by: 'pm' };
  } catch (err: any) {
    console.error(`[triage] Failed to reach PM ${pm.name}:`, err.message);
    const reason = `Could not reach PM agent "${pm.name}": ${err.message}`;
    if (shouldNotifyFallback(projectId, issue.number)) {
      notifyTriageOperatorFallback({ issueNumber: issue.number, issueTitle: issue.title, projectId, projectName, reason })
        .catch((notifyErr: Error) => console.error('[triage] Failed to send operator fallback notification:', notifyErr.message));
    }
    return { triaged: false, by: 'operator' };
  }
}

/**
 * Handle triage callback — PM agent returns structured JSON.
 * Parse it and start the workflow if valid.
 */
export async function handleTriageResult(
  taskId: string,
  result: string,
): Promise<{ launched: boolean; runId?: string; error?: string }> {
  // Parse the triage result
  let triageResult: TriageResult;
  try {
    // Strip markdown fences if present
    const cleaned = result.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    triageResult = JSON.parse(cleaned);
  } catch (err: any) {
    console.warn('[triage] Failed to parse triage result as JSON:', err.message);
    return { launched: false, error: `Failed to parse triage result as JSON: ${result.slice(0, 200)}` };
  }

  if (!triageResult.workflowId) {
    console.log(`[triage] PM decided no workflow fits: ${triageResult.reasoning}`);
    return { launched: false, error: `No workflow selected: ${triageResult.reasoning}` };
  }

  const workflow = getWorkflowById(triageResult.workflowId);
  if (!workflow) {
    return { launched: false, error: `Workflow ${triageResult.workflowId} not found` };
  }

  // Extract issue info from task ID
  const issueMatch = taskId.match(/triage-\w+-(\d+)/);
  const issueNumber = issueMatch ? issueMatch[1] : undefined;

  // Extract project ID from triage task ID: triage-{projectId8}-{issueNumber}
  const projectMatch = taskId.match(/triage-(\w+)-\d+/);
  const triageProjectId = projectMatch ? findProjectByPrefix(projectMatch[1]) : undefined;

  // Merge cached issue data into vars (authoritative — PM doesn't need to echo these)
  const cachedIssue = pendingTriageIssues.get(taskId);
  const mergedVars: Record<string, any> = {
    ...triageResult.vars,
    ...(cachedIssue ? {
      issueNumber: cachedIssue.number,
      issueTitle: cachedIssue.title,
      issueBody: cachedIssue.body,
      issueLabels: cachedIssue.labels.join(', '),
    } : {}),
  };
  pendingTriageIssues.delete(taskId);

  // Start the workflow run
  try {
    const run = await startRun(
      workflow,
      'issue',
      issueNumber ? `#${issueNumber}` : taskId,
      mergedVars,
      triageProjectId,
    );

    logActivity({
      eventType: 'triage.launched',
      agentName: 'triage-service',
      detail: `Launched workflow "${workflow.name}" for issue #${issueNumber}: ${triageResult.reasoning}`,
    });

    console.log(`[triage] Launched workflow "${workflow.name}" (run ${run.id}) — reason: ${triageResult.reasoning}`);
    return { launched: true, runId: run.id };
  } catch (err: any) {
    return { launched: false, error: `Failed to start workflow: ${err.message}` };
  }
}

/**
 * Scan all projects for untriaged issues and dispatch triage.
 */
export async function triageNewIssues(): Promise<{ project: string; triaged: number; skipped: number }[]> {
  const projects = projectsRepo.getAll();
  const results: { project: string; triaged: number; skipped: number }[] = [];

  for (const project of projects) {
    const issues = getCachedIssues(project.id);
    if (issues.length === 0) continue;

    // Check which issues already have tasks in the DB
    const existingTasks = tasksRepo.getByProject(project.id);
    const existingIssueNumbers = new Set(
      existingTasks
        .filter(t => t.githubIssueNumber)
        .map(t => t.githubIssueNumber)
    );

    let triaged = 0;
    let skipped = 0;

    for (const issue of issues) {
      // Skip if already triaged or already has a task
      if (isIssueTriaged(project.id, issue.number) || existingIssueNumbers.has(issue.number)) {
        skipped++;
        continue;
      }

      const result = await triageIssue(project.id, issue);
      if (result.triaged) {
        triaged++;
      } else {
        skipped++;
      }
    }

    if (triaged > 0) {
      results.push({ project: project.name, triaged, skipped });
    }
  }

  return results;
}

/**
 * Extract template variable names from workflow steps.
 */
function extractTemplateVars(steps: Array<{ prompt: string }>): string[] {
  const vars = new Set<string>();
  for (const step of steps) {
    const matches = step.prompt.matchAll(/\{\{(\w+(?:\.\w+)*)\}\}/g);
    for (const m of matches) {
      const varName = m[1];
      // Skip step output references (steps.X.output)
      if (!varName.startsWith('steps.')) {
        vars.add(varName);
      }
    }
  }
  return [...vars];
}

/**
 * Mark an issue as triaged (e.g. when operator handles it manually).
 */
function findProjectByPrefix(prefix: string): string | undefined {
  const projects = projectsRepo.getAll();
  return projects.find(p => p.id.startsWith(prefix))?.id;
}

export function markIssueTriaged(projectId: string, issueNumber: number) {
  markIssueTriage(projectId, issueNumber);
}

// ── Auto-triage wiring ────────────────────────────────────────────────────────
// Subscribe to github.new_issues events emitted by github-sync.ts so that
// newly discovered issues are automatically triaged without manual intervention.

eventBus.on('github.new_issues', (event) => {
  const { projectId: _projectId, projectName, issueNumbers } = event.data as { projectId: string; projectName: string; issueNumbers: number[] };
  console.log(`[triage] Auto-triage triggered for project "${projectName}" (${issueNumbers?.length ?? 0} new issue(s))`);
  triageNewIssues().catch((err: Error) => {
    console.error('[triage] Auto-triage failed:', err);
  });
});
