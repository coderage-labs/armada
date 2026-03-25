/**
 * Patrol service — autonomous system health monitoring and recovery (#194).
 *
 * Runs on a 5-minute timer, detects problems via DB queries, and takes automatic action.
 * Each finding is stored in the patrol_records table.
 */

import { randomUUID } from 'node:crypto';
import { getDrizzle } from '../db/drizzle.js';
import { sql } from 'drizzle-orm';
import { workflowStepRuns, workflowRuns, agents, reviewRecords, patrolRecords, agentLessons, projectConventions } from '../db/drizzle-schema.js';
import { eq } from 'drizzle-orm';
import { logActivity } from './activity-service.js';

// ── Types ────────────────────────────────────────────────────────────

export type PatrolRecordType =
  | 'stuck_task'
  | 'orphaned_run'
  | 'rework_overflow'
  | 'agent_offline'
  | 'score_drop';

export type PatrolSeverity = 'info' | 'warning' | 'critical';

export type FailureType = 
  | 'dispatch_failure' 
  | 'timeout' 
  | 'runtime_error' 
  | 'infinite_loop' 
  | 'no_deliverable' 
  | 'agent_crash' 
  | 'hung_mid_task' 
  | 'bad_upstream' 
  | 'workspace_failure' 
  | 'unknown';

export interface PatrolRecord {
  id: string;
  type: PatrolRecordType;
  severity: PatrolSeverity;
  runId?: string;
  stepId?: string;
  agentId?: string;
  description: string;
  actionTaken: string;
  status: 'open' | 'resolved';
  createdAt: string;
  resolvedAt?: string;
}

// ── Configuration ───────────────────────────────────────────────────

const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const STUCK_WARNING_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes
const STUCK_CRITICAL_THRESHOLD_MS = 60 * 60 * 1000; // 60 minutes
const AGENT_OFFLINE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
const REWORK_WARNING_COUNT = 3;
const REWORK_CRITICAL_COUNT = 5;
const SCORE_DROP_THRESHOLD = 1.0;
const SCORE_WINDOW_SIZE = 10;

let intervalHandle: ReturnType<typeof setInterval> | null = null;

// ── Database helpers ─────────────────────────────────────────────────

function storePatrolRecord(record: Omit<PatrolRecord, 'id' | 'createdAt'>, classification?: string): void {
  const db = getDrizzle();
  const id = randomUUID();
  db.insert(patrolRecords).values({
    id,
    type: record.type,
    severity: record.severity,
    runId: record.runId,
    stepId: record.stepId,
    agentId: record.agentId,
    description: record.description,
    actionTaken: record.actionTaken,
    status: record.status,
    createdAt: new Date().toISOString(),
    resolvedAt: record.resolvedAt,
    classification: classification || '',
  }).run();
}

// ── Failure classification ──────────────────────────────────────────

const LESSON_TEMPLATES: Record<FailureType, string> = {
  dispatch_failure: 'Task was dispatched but agent never responded. Check connectivity and agent health before starting.',
  timeout: 'Task timed out after {duration}. Break complex tasks into smaller subtasks.',
  runtime_error: 'Task hit a runtime error: {detail}. Add error handling for this case.',
  infinite_loop: 'Task appeared to loop without making progress. Set clear exit conditions and verify output before continuing.',
  no_deliverable: 'Task ran but produced no PR or commit. Always create a PR as the deliverable.',
  agent_crash: 'Agent went offline during task. Infrastructure issue.',
  hung_mid_task: 'Task started but stalled before completing. Check for blocking operations.',
  bad_upstream: 'Previous step output was unclear — insufficient context for this step.',
  workspace_failure: 'Workspace provisioning failed. Check git credentials and repo access.',
  unknown: 'Task failed for unknown reasons. Needs investigation.',
};

function classifyFailure(stepRun: any, agentHealth?: string): { type: FailureType; detail: string } {
  const output = stepRun.output || '';
  
  if (!output || output.trim().length === 0) {
    return { type: 'dispatch_failure', detail: 'Agent never responded — empty output' };
  }
  
  if (agentHealth === 'offline') {
    return { type: 'agent_crash', detail: 'Agent went offline during task' };
  }
  
  if (/timed?\s*out/i.test(output)) {
    return { type: 'timeout', detail: 'Task timed out' };
  }
  
  if (/error|Error|ERROR|exception|Exception/.test(output)) {
    const errorLine = output.split('\n').find((l: string) => /error|Error|ERROR|exception/i.test(l)) || '';
    return { type: 'runtime_error', detail: `Runtime error: ${errorLine.slice(0, 100)}` };
  }
  
  // Check for repeated text (infinite loop indicator)
  const lines = output.split('\n');
  const unique = new Set(lines);
  if (lines.length > 20 && unique.size < lines.length * 0.3) {
    return { type: 'infinite_loop', detail: 'Output contains excessive repetition' };
  }
  
  // Long output but no PR/commit reference
  if (output.length > 500 && !/pull\/\d+|PR\s*#?\d+|commit\s+[a-f0-9]{7}/i.test(output)) {
    return { type: 'no_deliverable', detail: 'Task produced output but no PR or commit' };
  }
  
  // Started but never completed
  if (output.length > 0 && output.length < 200) {
    return { type: 'hung_mid_task', detail: 'Task started but produced minimal output before stalling' };
  }
  
  return { type: 'unknown', detail: 'Could not classify failure — needs manual review' };
}

async function extractLessonFromFailure(
  stepRun: any, 
  classification: { type: FailureType; detail: string }, 
  agentId: string, 
  projectId?: string
): Promise<void> {
  // Don't create lessons for infra issues
  if (classification.type === 'agent_crash' || classification.type === 'workspace_failure') {
    return;
  }
  
  const lessonText = LESSON_TEMPLATES[classification.type]
    .replace('{detail}', classification.detail)
    .replace('{duration}', '60+ minutes');
  
  const db = getDrizzle();
  const id = randomUUID();
  
  db.insert(agentLessons).values({
    id,
    agentId,
    projectId: projectId || null,
    lesson: lessonText,
    source: 'patrol',
    severity: classification.type === 'unknown' ? 'medium' : 'high',
    active: 1,
    timesInjected: 0,
  }).run();
  
  console.log(`[patrol] Lesson extracted for ${agentId}: ${classification.type}`);
}

async function checkForConventionPromotion(projectId: string): Promise<void> {
  if (!projectId) return;
  
  const db = getDrizzle();
  
  // Get patrol records for this project in the last 30 days
  const recent = db.all(
    sql`
      SELECT pr.*, wr.project_id 
      FROM patrol_records pr
      LEFT JOIN workflow_runs wr ON pr.run_id = wr.id
      WHERE wr.project_id = ${projectId}
        AND pr.created_at > datetime('now', '-30 days')
        AND pr.classification IS NOT NULL
        AND pr.classification != ''
    `
  ) as any[];
  
  // Group by classification
  const grouped: Record<string, number> = {};
  for (const r of recent) {
    if (r.classification) {
      grouped[r.classification] = (grouped[r.classification] || 0) + 1;
    }
  }
  
  // If any type appears 3+ times, create a convention
  for (const [type, count] of Object.entries(grouped)) {
    if (count >= 3 && type in LESSON_TEMPLATES) {
      // Check if convention already exists
      const existing = db.select().from(projectConventions)
        .where(sql`project_id = ${projectId} AND convention LIKE ${'%' + type + '%'}`)
        .all();
      
      if (existing.length === 0) {
        const id = randomUUID();
        db.insert(projectConventions).values({
          id,
          projectId,
          convention: `Recurring patrol finding (${count}x): ${LESSON_TEMPLATES[type as FailureType]}`,
          source: 'patrol',
          evidenceCount: count,
          active: 1,
        }).run();
        console.log(`[patrol] Convention promoted for project ${projectId}: ${type} (${count} occurrences)`);
      }
    }
  }
}

// ── Detection checks ─────────────────────────────────────────────────

/**
 * Check for stuck workflow step runs.
 * - Warning: running >30 min
 * - Critical: running >60 min (mark as failed)
 */
function checkStuckTasks(): PatrolRecord[] {
  const db = getDrizzle();
  const now = Date.now();
  const records: PatrolRecord[] = [];

  const runningSteps = db
    .select()
    .from(workflowStepRuns)
    .where(eq(workflowStepRuns.status, 'running'))
    .all();

  for (const step of runningSteps) {
    if (!step.startedAt) continue;

    const startedTime = new Date(step.startedAt).getTime();
    const age = now - startedTime;

    if (age > STUCK_CRITICAL_THRESHOLD_MS) {
      // Get agent health status
      let agentHealth: string | undefined;
      if (step.agentName) {
        const agent = db.select().from(agents).where(eq(agents.name, step.agentName)).get();
        agentHealth = agent?.healthStatus || undefined;
      }
      
      // Classify the failure
      const classification = classifyFailure(step, agentHealth);
      
      // Mark as failed
      db.update(workflowStepRuns)
        .set({ 
          status: 'failed',
          output: 'Auto-failed by patrol service: stuck for >60 minutes',
          completedAt: new Date().toISOString(),
        })
        .where(eq(workflowStepRuns.id, step.id))
        .run();

      const record: Omit<PatrolRecord, 'id' | 'createdAt'> = {
        type: 'stuck_task',
        severity: 'critical',
        runId: step.runId,
        stepId: step.stepId,
        agentId: step.agentName || undefined,
        description: `Step ${step.stepId} stuck for ${Math.round(age / 60000)} minutes — auto-failed [${classification.type}]: ${classification.detail}`,
        actionTaken: `Marked step as failed. Classified as: ${classification.type}`,
        status: 'open',
      };
      storePatrolRecord(record, classification.type);
      records.push({ ...record, id: '', createdAt: '' });

      // Extract lesson for the agent
      if (step.agentName) {
        const run = db.select().from(workflowRuns).where(eq(workflowRuns.id, step.runId)).get();
        extractLessonFromFailure(step, classification, step.agentName, run?.projectId).catch(err => {
          console.error('[patrol] Failed to extract lesson:', err);
        });
      }

      logActivity({
        eventType: 'patrol.stuck_task',
        agentName: step.agentName || 'unknown',
        detail: `Step ${step.stepId} in run ${step.runId} auto-failed after 60+ minutes (${classification.type})`,
      });
    } else if (age > STUCK_WARNING_THRESHOLD_MS) {
      // Warning only
      const record: Omit<PatrolRecord, 'id' | 'createdAt'> = {
        type: 'stuck_task',
        severity: 'warning',
        runId: step.runId,
        stepId: step.stepId,
        agentId: step.agentName || undefined,
        description: `Step ${step.stepId} running for ${Math.round(age / 60000)} minutes`,
        actionTaken: 'None (monitoring)',
        status: 'open',
      };
      storePatrolRecord(record);
      records.push({ ...record, id: '', createdAt: '' });
    }
  }

  return records;
}

/**
 * Check for orphaned workflow runs.
 * - A run is orphaned if status='running' but has no running/pending/waiting_gate steps.
 */
function checkOrphanedRuns(): PatrolRecord[] {
  const db = getDrizzle();
  const records: PatrolRecord[] = [];

  const runningRuns = db
    .select()
    .from(workflowRuns)
    .where(eq(workflowRuns.status, 'running'))
    .all();

  for (const run of runningRuns) {
    const activeSteps = db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.runId, run.id))
      .all()
      .filter(s => ['running', 'pending', 'waiting_gate'].includes(s.status));

    if (activeSteps.length === 0) {
      // Orphaned — mark run as failed
      db.update(workflowRuns)
        .set({ 
          status: 'failed',
          completedAt: new Date().toISOString(),
        })
        .where(eq(workflowRuns.id, run.id))
        .run();

      const record: Omit<PatrolRecord, 'id' | 'createdAt'> = {
        type: 'orphaned_run',
        severity: 'critical',
        runId: run.id,
        description: `Workflow run ${run.id} orphaned (no active steps) — auto-failed`,
        actionTaken: 'Marked run as failed',
        status: 'open',
      };
      storePatrolRecord(record);
      records.push({ ...record, id: '', createdAt: '' });

      logActivity({
        eventType: 'patrol.orphaned_run',
        detail: `Workflow run ${run.id} auto-failed (orphaned)`,
      });
    }
  }

  return records;
}

/**
 * Check for rework overflow.
 * - Warning: >3 attempts for same (run_id, step_id)
 * - Critical: >5 attempts (fail the run)
 */
function checkReworkOverflow(): PatrolRecord[] {
  const db = getDrizzle();
  const records: PatrolRecord[] = [];

  // Group by (run_id, step_id) and count
  const reworkCounts = db.all<{ run_id: string; step_id: string; count: number }>(
    sql`
      SELECT run_id, step_id, COUNT(*) as count
      FROM workflow_step_runs
      GROUP BY run_id, step_id
      HAVING count > ${REWORK_WARNING_COUNT}
    `
  );

  for (const { run_id, step_id, count } of reworkCounts) {
    if (count > REWORK_CRITICAL_COUNT) {
      // Critical — fail the run
      db.update(workflowRuns)
        .set({ 
          status: 'failed',
          completedAt: new Date().toISOString(),
        })
        .where(eq(workflowRuns.id, run_id))
        .run();

      const record: Omit<PatrolRecord, 'id' | 'createdAt'> = {
        type: 'rework_overflow',
        severity: 'critical',
        runId: run_id,
        stepId: step_id,
        description: `Step ${step_id} reworked ${count} times — run auto-failed`,
        actionTaken: 'Marked run as failed',
        status: 'open',
      };
      storePatrolRecord(record);
      records.push({ ...record, id: '', createdAt: '' });

      logActivity({
        eventType: 'patrol.rework_overflow',
        detail: `Run ${run_id} auto-failed after ${count} rework attempts on step ${step_id}`,
      });
    } else {
      // Warning only
      const record: Omit<PatrolRecord, 'id' | 'createdAt'> = {
        type: 'rework_overflow',
        severity: 'warning',
        runId: run_id,
        stepId: step_id,
        description: `Step ${step_id} reworked ${count} times`,
        actionTaken: 'None (monitoring)',
        status: 'open',
      };
      storePatrolRecord(record);
      records.push({ ...record, id: '', createdAt: '' });
    }
  }

  return records;
}

/**
 * Check for offline agents.
 * - Agents with status='running' and last_heartbeat >5 min old.
 */
function checkAgentOffline(): PatrolRecord[] {
  const db = getDrizzle();
  const now = Date.now();
  const records: PatrolRecord[] = [];

  const runningAgents = db
    .select()
    .from(agents)
    .where(eq(agents.status, 'running'))
    .all();

  for (const agent of runningAgents) {
    if (!agent.lastHeartbeat) continue;

    const lastHeartbeatTime = new Date(agent.lastHeartbeat).getTime();
    const age = now - lastHeartbeatTime;

    if (age > AGENT_OFFLINE_THRESHOLD_MS) {
      // Set health to offline
      db.update(agents)
        .set({ healthStatus: 'offline' })
        .where(eq(agents.id, agent.id))
        .run();

      const record: Omit<PatrolRecord, 'id' | 'createdAt'> = {
        type: 'agent_offline',
        severity: 'warning',
        agentId: agent.name,
        description: `Agent ${agent.name} offline — no heartbeat for ${Math.round(age / 60000)} minutes`,
        actionTaken: 'Set health status to offline',
        status: 'open',
      };
      storePatrolRecord(record);
      records.push({ ...record, id: '', createdAt: '' });

      logActivity({
        eventType: 'patrol.agent_offline',
        agentName: agent.name,
        detail: `Agent ${agent.name} marked offline (no heartbeat for ${Math.round(age / 60000)} minutes)`,
      });
    }
  }

  return records;
}

/**
 * Check for score drops.
 * - Compare last 10 reviews vs previous 10 for each agent.
 * - Warning if avg score drop >1.0
 */
function checkScoreDrops(): PatrolRecord[] {
  const db = getDrizzle();
  const records: PatrolRecord[] = [];

  // Get all agents with reviews
  const agentsWithReviews = db.all<{ executor: string }>(
    sql`SELECT DISTINCT executor FROM review_records WHERE executor IS NOT NULL`
  );

  for (const { executor } of agentsWithReviews) {
    if (!executor) continue;

    // Get all reviews for this agent, ordered by created_at desc
    const allReviews = db
      .select()
      .from(reviewRecords)
      .where(eq(reviewRecords.executor, executor))
      .orderBy(sql`created_at DESC`)
      .all();

    if (allReviews.length < SCORE_WINDOW_SIZE * 2) continue; // Need at least 20 reviews

    const last10 = allReviews.slice(0, SCORE_WINDOW_SIZE);
    const previous10 = allReviews.slice(SCORE_WINDOW_SIZE, SCORE_WINDOW_SIZE * 2);

    const avgLast = last10.reduce((sum, r) => sum + r.score, 0) / last10.length;
    const avgPrevious = previous10.reduce((sum, r) => sum + r.score, 0) / previous10.length;
    const drop = avgPrevious - avgLast;

    if (drop > SCORE_DROP_THRESHOLD) {
      const record: Omit<PatrolRecord, 'id' | 'createdAt'> = {
        type: 'score_drop',
        severity: 'warning',
        agentId: executor,
        description: `Agent ${executor} score dropped by ${drop.toFixed(2)} (${avgPrevious.toFixed(2)} → ${avgLast.toFixed(2)})`,
        actionTaken: 'None (monitoring)',
        status: 'open',
      };
      storePatrolRecord(record);
      records.push({ ...record, id: '', createdAt: '' });

      logActivity({
        eventType: 'patrol.score_drop',
        agentName: executor,
        detail: `Score drop detected: ${drop.toFixed(2)} points`,
      });
    }
  }

  return records;
}

// ── Main patrol logic ────────────────────────────────────────────────

export function runPatrol(): PatrolRecord[] {
  console.log('🚔 Patrol service running checks…');
  const allRecords: PatrolRecord[] = [];

  try {
    allRecords.push(...checkStuckTasks());
    allRecords.push(...checkOrphanedRuns());
    allRecords.push(...checkReworkOverflow());
    allRecords.push(...checkAgentOffline());
    allRecords.push(...checkScoreDrops());

    if (allRecords.length > 0) {
      console.log(`🚨 Patrol found ${allRecords.length} issue(s)`);
    } else {
      console.log('✅ Patrol completed — no issues detected');
    }
    
    // Check for convention promotion across all affected projects
    const db = getDrizzle();
    const projectIds = new Set(
      allRecords
        .filter(r => r.runId)
        .map(r => {
          const run = db.select().from(workflowRuns).where(eq(workflowRuns.id, r.runId!)).get();
          return run?.projectId;
        })
        .filter(Boolean) as string[]
    );
    
    for (const pid of projectIds) {
      checkForConventionPromotion(pid).catch(err => {
        console.error('[patrol] Failed to check convention promotion:', err);
      });
    }
  } catch (err: unknown) {
    console.error('Patrol service error:', err);
  }

  return allRecords;
}

// ── Lifecycle ────────────────────────────────────────────────────────

export function startPatrolScheduler(intervalMs: number = CHECK_INTERVAL_MS): void {
  if (intervalHandle) {
    console.warn('Patrol scheduler already running');
    return;
  }

  console.log(`🚔 Patrol scheduler started (checking every ${intervalMs / 1000}s)`);
  intervalHandle = setInterval(() => {
    runPatrol();
  }, intervalMs);

  // Run once immediately
  runPatrol();
}

export function stopPatrolScheduler(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    console.log('🚔 Patrol scheduler stopped');
  }
}
