/**
 * Workflow metrics service — query existing tables for analytics.
 * Pure read-only, no new tables created.
 */

import { getDrizzle } from '../db/drizzle.js';
import { sql } from 'drizzle-orm';

// ── Rank system (imported from learning.ts) ────────────────────────

interface Rank {
  name: string;
  title: string;
  minScore: number;
}

const RANKS: Rank[] = [
  { name: 'admiral', title: 'Admiral', minScore: 200 },
  { name: 'captain', title: 'Captain', minScore: 100 },
  { name: 'commander', title: 'Commander', minScore: 50 },
  { name: 'lieutenant', title: 'Lieutenant', minScore: 20 },
  { name: 'cadet', title: 'Cadet', minScore: 0 },
];

function getRank(totalScore: number): Rank {
  return RANKS.find(r => totalScore >= r.minScore) || RANKS[RANKS.length - 1];
}

// ── Workflow stats ──────────────────────────────────────────────────

export interface WorkflowStats {
  workflowId: string;
  workflowName: string;
  totalRuns: number;
  completed: number;
  failed: number;
  cancelled: number;
  completionRate: number;
  avgDurationMs: number;
  avgStepDurationMs: Record<string, number>;
  avgGateWaitMs: number;
  avgReviewScore: number;
  runsThisWeek: number;
  trend: 'improving' | 'stable' | 'declining';
}

export function getWorkflowStats(workflowId?: string): WorkflowStats[] {
  const db = getDrizzle();

  // Get all workflow runs, optionally filtered by workflow_id
  const whereClause = workflowId ? `WHERE wr.workflow_id = '${workflowId}'` : '';

  const query = `
    SELECT
      wr.workflow_id,
      w.name as workflow_name,
      COUNT(*) as total_runs,
      SUM(CASE WHEN wr.status = 'completed' THEN 1 ELSE 0 END) as completed,
      SUM(CASE WHEN wr.status = 'failed' THEN 1 ELSE 0 END) as failed,
      SUM(CASE WHEN wr.status = 'cancelled' THEN 1 ELSE 0 END) as cancelled,
      AVG(
        CASE
          WHEN wr.completed_at IS NOT NULL AND wr.created_at IS NOT NULL
          THEN (julianday(wr.completed_at) - julianday(wr.created_at)) * 86400000
          ELSE NULL
        END
      ) as avg_duration_ms,
      SUM(
        CASE
          WHEN wr.created_at >= datetime('now', '-7 days')
          THEN 1
          ELSE 0
        END
      ) as runs_this_week
    FROM workflow_runs wr
    LEFT JOIN workflows w ON w.id = wr.workflow_id
    ${whereClause}
    GROUP BY wr.workflow_id, w.name
  `;

  const rows = db.all(sql.raw(query)) as any[];

  return rows.map((row) => {
    const completionRate = row.total_runs > 0 ? row.completed / row.total_runs : 0;

    // Calculate per-step durations
    const avgStepDurationMs = getAvgStepDurations(row.workflow_id);

    // Calculate avg gate wait time
    const avgGateWaitMs = getAvgGateWaitTime(row.workflow_id);

    // Calculate avg review score
    const avgReviewScore = getAvgReviewScore(row.workflow_id);

    // Determine trend (placeholder logic: based on recent vs older completion rate)
    const trend = determineTrend(row.workflow_id);

    return {
      workflowId: row.workflow_id,
      workflowName: row.workflow_name || 'Unnamed Workflow',
      totalRuns: row.total_runs,
      completed: row.completed,
      failed: row.failed,
      cancelled: row.cancelled,
      completionRate: parseFloat(completionRate.toFixed(2)),
      avgDurationMs: Math.round(row.avg_duration_ms || 0),
      avgStepDurationMs,
      avgGateWaitMs,
      avgReviewScore: parseFloat(avgReviewScore.toFixed(1)),
      runsThisWeek: row.runs_this_week,
      trend,
    };
  });
}

function getAvgStepDurations(workflowId: string): Record<string, number> {
  const db = getDrizzle();

  const query = `
    SELECT
      wsr.step_id,
      AVG(
        CASE
          WHEN wsr.completed_at IS NOT NULL AND wsr.started_at IS NOT NULL
          THEN (julianday(wsr.completed_at) - julianday(wsr.started_at)) * 86400000
          ELSE NULL
        END
      ) as avg_duration_ms
    FROM workflow_step_runs wsr
    JOIN workflow_runs wr ON wr.id = wsr.run_id
    WHERE wr.workflow_id = '${workflowId}'
      AND wsr.started_at IS NOT NULL
      AND wsr.completed_at IS NOT NULL
    GROUP BY wsr.step_id
  `;

  const rows = db.all(sql.raw(query)) as any[];
  const result: Record<string, number> = {};

  for (const row of rows) {
    result[row.step_id] = Math.round(row.avg_duration_ms || 0);
  }

  return result;
}

function getAvgGateWaitTime(workflowId: string): number {
  const db = getDrizzle();

  const query = `
    SELECT
      AVG(
        CASE
          WHEN wsr.completed_at IS NOT NULL AND wsr.started_at IS NOT NULL
          THEN (julianday(wsr.completed_at) - julianday(wsr.started_at)) * 86400000
          ELSE NULL
        END
      ) as avg_wait_ms
    FROM workflow_step_runs wsr
    JOIN workflow_runs wr ON wr.id = wsr.run_id
    WHERE wr.workflow_id = '${workflowId}'
      AND wsr.status = 'waiting_gate'
      AND wsr.started_at IS NOT NULL
      AND wsr.completed_at IS NOT NULL
  `;

  const row = db.get(sql.raw(query)) as any;
  return Math.round(row?.avg_wait_ms || 0);
}

function getAvgReviewScore(workflowId: string): number {
  const db = getDrizzle();

  const query = `
    SELECT AVG(rr.score) as avg_score
    FROM review_records rr
    JOIN workflow_step_runs wsr ON wsr.id = rr.step_id
    JOIN workflow_runs wr ON wr.id = wsr.run_id
    WHERE wr.workflow_id = '${workflowId}'
  `;

  const row = db.get(sql.raw(query)) as any;
  return row?.avg_score || 0;
}

function determineTrend(workflowId: string): 'improving' | 'stable' | 'declining' {
  const db = getDrizzle();

  // Compare completion rate of last 7 days vs previous 7 days
  const recentQuery = `
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed
    FROM workflow_runs
    WHERE workflow_id = '${workflowId}'
      AND created_at >= datetime('now', '-7 days')
  `;

  const priorQuery = `
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed
    FROM workflow_runs
    WHERE workflow_id = '${workflowId}'
      AND created_at >= datetime('now', '-14 days')
      AND created_at < datetime('now', '-7 days')
  `;

  const recent = db.get(sql.raw(recentQuery)) as any;
  const prior = db.get(sql.raw(priorQuery)) as any;

  if (!recent?.total || recent.total < 3) return 'stable'; // Not enough data
  if (!prior?.total || prior.total < 3) return 'stable';

  const recentRate = recent.completed / recent.total;
  const priorRate = prior.completed / prior.total;

  if (recentRate > priorRate + 0.1) return 'improving';
  if (recentRate < priorRate - 0.1) return 'declining';
  return 'stable';
}

// ── Agent stats ─────────────────────────────────────────────────────

export interface AgentStats {
  agent: string;
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  avgDurationMs: number;
  avgReviewScore: number;
  reviewCount: number;
  rank: Rank;
  topCategories: Array<{
    category: string;
    count: number;
    avgScore: number;
  }>;
}

export function getAgentStats(agentName?: string): AgentStats[] {
  const db = getDrizzle();

  // Get all agents with task history
  const whereClause = agentName ? `WHERE wsr.agent_name = '${agentName}'` : '';

  const query = `
    SELECT
      wsr.agent_name,
      COUNT(*) as total_tasks,
      SUM(CASE WHEN wsr.status = 'completed' THEN 1 ELSE 0 END) as completed_tasks,
      SUM(CASE WHEN wsr.status = 'failed' THEN 1 ELSE 0 END) as failed_tasks,
      AVG(
        CASE
          WHEN wsr.completed_at IS NOT NULL AND wsr.started_at IS NOT NULL
          THEN (julianday(wsr.completed_at) - julianday(wsr.started_at)) * 86400000
          ELSE NULL
        END
      ) as avg_duration_ms
    FROM workflow_step_runs wsr
    ${whereClause}
    GROUP BY wsr.agent_name
  `;

  const rows = db.all(sql.raw(query)) as any[];

  return rows
    .filter((row) => row.agent_name) // Skip nulls
    .map((row) => {
      // Get agent score and rank
      const scoreQuery = `
        SELECT
          total_score,
          review_count,
          avg_score
        FROM agent_scores
        WHERE agent_id = '${row.agent_name}'
          AND category = 'overall'
      `;

      const scoreRow = db.get(sql.raw(scoreQuery)) as any;
      const totalScore = scoreRow?.total_score || 0;
      const reviewCount = scoreRow?.review_count || 0;
      const avgReviewScore = scoreRow?.avg_score || 0;

      // Get top categories
      const topCategories = getTopCategories(row.agent_name);

      return {
        agent: row.agent_name,
        totalTasks: row.total_tasks,
        completedTasks: row.completed_tasks,
        failedTasks: row.failed_tasks,
        avgDurationMs: Math.round(row.avg_duration_ms || 0),
        avgReviewScore: parseFloat(avgReviewScore.toFixed(1)),
        reviewCount,
        rank: getRank(totalScore),
        topCategories,
      };
    });
}

function getTopCategories(
  agentName: string
): Array<{ category: string; count: number; avgScore: number }> {
  const db = getDrizzle();

  const query = `
    SELECT
      category,
      review_count as count,
      avg_score
    FROM agent_scores
    WHERE agent_id = '${agentName}'
      AND category != 'overall'
    ORDER BY review_count DESC
    LIMIT 5
  `;

  const rows = db.all(sql.raw(query)) as any[];

  return rows.map((row) => ({
    category: row.category,
    count: row.count,
    avgScore: parseFloat(row.avg_score?.toFixed(1) || '0'),
  }));
}

// ── Recent run history ──────────────────────────────────────────────

export interface RecentRun {
  id: string;
  workflowId: string;
  workflowName: string;
  projectId: string;
  status: string;
  createdAt: string;
  completedAt: string | null;
  durationMs: number;
  steps: Array<{
    stepId: string;
    role: string;
    agentName: string | null;
    status: string;
    durationMs: number;
  }>;
}

export function getRecentRuns(limit: number = 20): RecentRun[] {
  const db = getDrizzle();

  const query = `
    SELECT
      wr.id,
      wr.workflow_id,
      w.name as workflow_name,
      wr.project_id,
      wr.status,
      wr.created_at,
      wr.completed_at,
      CASE
        WHEN wr.completed_at IS NOT NULL AND wr.created_at IS NOT NULL
        THEN (julianday(wr.completed_at) - julianday(wr.created_at)) * 86400000
        ELSE 0
      END as duration_ms
    FROM workflow_runs wr
    LEFT JOIN workflows w ON w.id = wr.workflow_id
    ORDER BY wr.created_at DESC
    LIMIT ${limit}
  `;

  const rows = db.all(sql.raw(query)) as any[];

  return rows.map((row) => {
    // Get steps for this run
    const stepsQuery = `
      SELECT
        step_id,
        role,
        agent_name,
        status,
        CASE
          WHEN completed_at IS NOT NULL AND started_at IS NOT NULL
          THEN (julianday(completed_at) - julianday(started_at)) * 86400000
          ELSE 0
        END as duration_ms
      FROM workflow_step_runs
      WHERE run_id = '${row.id}'
      ORDER BY step_index ASC
    `;

    const steps = db.all(sql.raw(stepsQuery)) as any[];

    return {
      id: row.id,
      workflowId: row.workflow_id,
      workflowName: row.workflow_name || 'Unnamed Workflow',
      projectId: row.project_id,
      status: row.status,
      createdAt: row.created_at,
      completedAt: row.completed_at,
      durationMs: Math.round(row.duration_ms),
      steps: steps.map((step) => ({
        stepId: step.step_id,
        role: step.role,
        agentName: step.agent_name,
        status: step.status,
        durationMs: Math.round(step.duration_ms),
      })),
    };
  });
}
