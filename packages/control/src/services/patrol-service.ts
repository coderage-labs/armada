/**
 * Patrol service — autonomous system health monitoring and recovery (#194).
 *
 * Runs on a 5-minute timer, detects problems via DB queries, and takes automatic action.
 * Each finding is stored in the patrol_records table.
 */

import { randomUUID } from 'node:crypto';
import { getDrizzle } from '../db/drizzle.js';
import { sql } from 'drizzle-orm';
import { workflowStepRuns, workflowRuns, agents, reviewRecords, patrolRecords } from '../db/drizzle-schema.js';
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

function storePatrolRecord(record: Omit<PatrolRecord, 'id' | 'createdAt'>): void {
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
  }).run();
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
        description: `Step ${step.stepId} stuck for ${Math.round(age / 60000)} minutes — auto-failed`,
        actionTaken: 'Marked step as failed',
        status: 'open',
      };
      storePatrolRecord(record);
      records.push({ ...record, id: '', createdAt: '' });

      logActivity({
        eventType: 'patrol.stuck_task',
        agentName: step.agentName || 'unknown',
        detail: `Step ${step.stepId} in run ${step.runId} auto-failed after 60+ minutes`,
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
