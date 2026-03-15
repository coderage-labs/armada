/**
 * Project Service — business logic for project operations.
 *
 * Extracted from the projects route to keep route handlers thin.
 */

import { getDrizzle } from '../db/drizzle.js';
import { sql } from 'drizzle-orm';
import { agentsRepo } from '../repositories/index.js';
import { projectsRepo, tasksRepo } from '../repositories/index.js';
import { getCachedIssues } from './github-sync.js';

export interface ProjectMetrics {
  tasks: {
    total: number;
    completed: number;
    failed: number;
    running: number;
    pending: number;
    blocked: number;
  };
  workflows: {
    totalRuns: number;
    completed: number;
    running: number;
    failed: number;
    cancelled: number;
  };
  agents: {
    assigned: number;
    activeOnProject: number;
  };
  timing: {
    avgTaskDurationMs: number | null;
    avgWorkflowDurationMs: number | null;
    fastestTaskMs: number | null;
    slowestTaskMs: number | null;
  };
  github: {
    totalIssues: number;
    openIssues: number;
    triagedIssues: number;
    issuesByLabel: Record<string, number>;
  };
  activity: {
    last24h: number;
    last7d: number;
    last30d: number;
    daily: Array<{ date: string; count: number }>;
  };
}

/**
 * Compute project-level metrics: task/workflow counts, timing, GitHub issues, activity.
 * Returns null if the project does not exist.
 */
export function getProjectMetrics(projectId: string): ProjectMetrics | null {
  const project = projectsRepo.get(projectId) || projectsRepo.getByName(projectId);
  if (!project) return null;

  const db = getDrizzle();
  const pid = project.name;

  // Tasks by status
  const taskRows = db.all<{ status: string; count: number }>(
    sql`SELECT status, COUNT(*) as count FROM tasks WHERE project_id = ${pid} GROUP BY status`,
  );
  const taskCounts: Record<string, number> = {};
  let taskTotal = 0;
  for (const r of taskRows) { taskCounts[r.status] = r.count; taskTotal += r.count; }

  // Task timing
  const timingRow = db.get<{ avg_ms: number | null; min_ms: number | null; max_ms: number | null }>(
    sql`SELECT
      AVG(CASE WHEN completed_at IS NOT NULL THEN (julianday(completed_at) - julianday(created_at)) * 86400000 END) as avg_ms,
      MIN(CASE WHEN completed_at IS NOT NULL THEN (julianday(completed_at) - julianday(created_at)) * 86400000 END) as min_ms,
      MAX(CASE WHEN completed_at IS NOT NULL THEN (julianday(completed_at) - julianday(created_at)) * 86400000 END) as max_ms
    FROM tasks WHERE project_id = ${pid}`,
  ) ?? { avg_ms: null, min_ms: null, max_ms: null };

  // Workflow runs by status
  const wfRows = db.all<{ status: string; count: number }>(
    sql`SELECT status, COUNT(*) as count FROM workflow_runs WHERE project_id = ${project.id} GROUP BY status`,
  );
  const wfCounts: Record<string, number> = {};
  let wfTotal = 0;
  for (const r of wfRows) { wfCounts[r.status] = r.count; wfTotal += r.count; }

  const wfTimingRow = db.get<{ avg_ms: number | null }>(
    sql`SELECT AVG(CASE WHEN completed_at IS NOT NULL THEN (julianday(completed_at) - julianday(created_at)) * 86400000 END) as avg_ms
    FROM workflow_runs WHERE project_id = ${project.id}`,
  ) ?? { avg_ms: null };

  // Agents
  const allAgents = agentsRepo.getAll();
  const members = projectsRepo.getMembers(project.id);
  const memberNames = members.map((m: any) => typeof m === 'string' ? m : m.name);
  const activeAgents = allAgents.filter((a: any) => memberNames.includes(a.name) && a.status === 'running');

  // GitHub issues
  const cachedIssues = getCachedIssues(project.id);
  const openIssues = cachedIssues.filter((i: any) => i.state === 'open');
  const triagedIssueRows = tasksRepo.getGithubIssueNumbers(pid);
  const triagedNumbers = new Set(triagedIssueRows);
  const issuesByLabel: Record<string, number> = {};
  for (const issue of cachedIssues) {
    for (const label of ((issue as any).labels || [])) {
      issuesByLabel[label] = (issuesByLabel[label] || 0) + 1;
    }
  }

  // Activity counts
  const now = new Date();
  const ago24h = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const ago7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const ago30d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const activityCount = (since: string) => {
    const row = db.get<{ count: number }>(
      sql`SELECT COUNT(*) as count FROM tasks WHERE project_id = ${pid} AND created_at >= ${since}`,
    );
    return row?.count ?? 0;
  };

  // Daily activity for last 7 days
  const dailyActivity: { date: string; count: number }[] = [];
  for (let i = 6; i >= 0; i--) {
    const dayStart = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
    const dayLabel = dayStart.toISOString().slice(0, 10);
    const row = db.get<{ count: number }>(
      sql`SELECT COUNT(*) as count FROM tasks WHERE project_id = ${pid} AND created_at >= ${dayStart.toISOString()} AND created_at < ${dayEnd.toISOString()}`,
    );
    dailyActivity.push({ date: dayLabel, count: row?.count ?? 0 });
  }

  return {
    tasks: {
      total: taskTotal,
      completed: taskCounts['completed'] || 0,
      failed: taskCounts['failed'] || 0,
      running: taskCounts['running'] || 0,
      pending: taskCounts['pending'] || 0,
      blocked: taskCounts['blocked'] || 0,
    },
    workflows: {
      totalRuns: wfTotal,
      completed: wfCounts['completed'] || 0,
      running: wfCounts['running'] || 0,
      failed: wfCounts['failed'] || 0,
      cancelled: wfCounts['cancelled'] || 0,
    },
    agents: { assigned: memberNames.length, activeOnProject: activeAgents.length },
    timing: {
      avgTaskDurationMs: timingRow.avg_ms ? Math.round(timingRow.avg_ms) : null,
      avgWorkflowDurationMs: wfTimingRow.avg_ms ? Math.round(wfTimingRow.avg_ms) : null,
      fastestTaskMs: timingRow.min_ms ? Math.round(timingRow.min_ms) : null,
      slowestTaskMs: timingRow.max_ms ? Math.round(timingRow.max_ms) : null,
    },
    github: {
      totalIssues: cachedIssues.length,
      openIssues: openIssues.length,
      triagedIssues: triagedNumbers.size,
      issuesByLabel,
    },
    activity: {
      last24h: activityCount(ago24h),
      last7d: activityCount(ago7d),
      last30d: activityCount(ago30d),
      daily: dailyActivity,
    },
  };
}
