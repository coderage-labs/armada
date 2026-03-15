import { eq, and, like, desc, sql, isNotNull } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { getDrizzle } from '../db/drizzle.js';
import { tasks, taskComments } from '../db/drizzle-schema.js';
import type { MeshTask, TaskComment, BoardColumn, TaskType, TaskPayload } from '@coderage-labs/armada-shared';

// ── Row → domain mappers ────────────────────────────────────────────

function rowToTask(r: typeof tasks.$inferSelect): MeshTask {
  let taskPayload: TaskPayload | null = null;
  if (r.taskPayload) {
    try { taskPayload = JSON.parse(r.taskPayload); } catch { /* ignore */ }
  }
  return {
    id: r.id,
    fromAgent: r.fromAgent,
    toAgent: r.toAgent,
    taskText: r.taskText,
    result: r.result,
    status: r.status as MeshTask['status'],
    createdAt: r.createdAt,
    completedAt: r.completedAt,
    lastProgressAt: r.lastProgressAt ?? null,
    taskType: (r.taskType as TaskType) ?? 'generic',
    taskPayload,
    ...(r.blockedReason ? { blockedReason: r.blockedReason } : {}),
    ...(r.blockedAt ? { blockedAt: r.blockedAt } : {}),
    ...(r.projectId ? { projectId: r.projectId } : {}),
    ...(r.githubIssueUrl ? { githubIssueUrl: r.githubIssueUrl } : {}),
    ...(r.githubIssueNumber != null ? { githubIssueNumber: r.githubIssueNumber } : {}),
    ...(r.githubPrUrl ? { githubPrUrl: r.githubPrUrl } : {}),
    ...(r.boardColumn ? { boardColumn: r.boardColumn } : {}),
    ...(r.workflowRunId ? { workflowRunId: r.workflowRunId } : {}),
  };
}

function rowToComment(r: typeof taskComments.$inferSelect): TaskComment {
  return {
    id: r.id,
    taskId: r.taskId,
    author: r.author,
    content: r.content,
    createdAt: r.createdAt,
  };
}

// ── Tasks Repository ────────────────────────────────────────────────

export const tasksRepo = {
  getAll(): MeshTask[] {
    return getDrizzle().select().from(tasks).all().map(rowToTask);
  },

  getById(id: string): MeshTask | undefined {
    const row = getDrizzle().select().from(tasks).where(eq(tasks.id, id)).get();
    return row ? rowToTask(row) : undefined;
  },

  getRecent(limit = 50): MeshTask[] {
    return getDrizzle().select().from(tasks).orderBy(desc(tasks.createdAt)).limit(limit).all().map(rowToTask);
  },

  getByAgent(name: string, limit = 20): MeshTask[] {
    return getDrizzle()
      .select().from(tasks)
      .where(sql`${tasks.fromAgent} = ${name} OR ${tasks.toAgent} = ${name}`)
      .orderBy(desc(tasks.createdAt))
      .limit(limit)
      .all()
      .map(rowToTask);
  },

  getByStatus(status: string, limit = 50): MeshTask[] {
    return getDrizzle()
      .select().from(tasks)
      .where(eq(tasks.status, status))
      .orderBy(desc(tasks.createdAt))
      .limit(limit)
      .all()
      .map(rowToTask);
  },

  create(data: Omit<MeshTask, 'id' | 'createdAt' | 'completedAt'> & { id?: string }): MeshTask {
    const id = data.id || uuidv4();
    getDrizzle().insert(tasks).values({
      id,
      fromAgent: data.fromAgent,
      toAgent: data.toAgent,
      taskText: data.taskText,
      result: data.result ?? null,
      status: data.status,
      blockedReason: data.blockedReason ?? null,
      blockedAt: data.blockedAt ?? null,
      projectId: data.projectId ?? null,
      githubIssueUrl: data.githubIssueUrl ?? null,
      githubIssueNumber: data.githubIssueNumber ?? null,
      githubPrUrl: data.githubPrUrl ?? null,
      boardColumn: data.boardColumn ?? null,
      workflowRunId: data.workflowRunId ?? null,
      taskType: data.taskType ?? 'generic',
      taskPayload: data.taskPayload ? JSON.stringify(data.taskPayload) : null,
    }).onConflictDoNothing().run();
    return rowToTask(getDrizzle().select().from(tasks).where(eq(tasks.id, id)).get()!);
  },

  update(id: string, data: Partial<MeshTask>): MeshTask | undefined {
    const existing = tasksRepo.getById(id);
    if (!existing) return undefined;
    const merged = { ...existing, ...data, id };
    getDrizzle().update(tasks).set({
      fromAgent: merged.fromAgent,
      toAgent: merged.toAgent,
      taskText: merged.taskText,
      result: merged.result ?? null,
      status: merged.status,
      completedAt: merged.completedAt ?? null,
      lastProgressAt: merged.lastProgressAt ?? null,
      blockedReason: merged.blockedReason ?? null,
      blockedAt: merged.blockedAt ?? null,
      projectId: merged.projectId ?? null,
      githubIssueUrl: merged.githubIssueUrl ?? null,
      githubIssueNumber: merged.githubIssueNumber ?? null,
      githubPrUrl: merged.githubPrUrl ?? null,
      boardColumn: merged.boardColumn ?? null,
      workflowRunId: merged.workflowRunId ?? null,
      taskType: merged.taskType ?? 'generic',
      taskPayload: merged.taskPayload ? JSON.stringify(merged.taskPayload) : null,
    }).where(eq(tasks.id, id)).run();
    return merged;
  },

  getByProject(projectId: string, limit = 50): MeshTask[] {
    return getDrizzle()
      .select().from(tasks)
      .where(eq(tasks.projectId, projectId))
      .orderBy(desc(tasks.createdAt))
      .limit(limit)
      .all()
      .map(rowToTask);
  },

  getBoardTasks(projectId: string): MeshTask[] {
    return getDrizzle()
      .select().from(tasks)
      .where(and(eq(tasks.projectId, projectId), isNotNull(tasks.boardColumn)))
      .orderBy(desc(tasks.createdAt))
      .all()
      .map(rowToTask);
  },

  updateBoardColumn(taskId: string, column: BoardColumn): MeshTask | undefined {
    const existing = tasksRepo.getById(taskId);
    if (!existing) return undefined;
    getDrizzle().update(tasks).set({ boardColumn: column }).where(eq(tasks.id, taskId)).run();
    return { ...existing, boardColumn: column };
  },

  findByGithubIssue(repo: string, issueNumber: number): MeshTask | null {
    const row = getDrizzle()
      .select().from(tasks)
      .where(and(
        eq(tasks.githubIssueNumber, issueNumber),
        like(tasks.githubIssueUrl, `%${repo}%`),
      ))
      .get();
    return row ? rowToTask(row) : null;
  },

  getGithubIssueNumbers(projectName: string): number[] {
    return getDrizzle()
      .select({ githubIssueNumber: tasks.githubIssueNumber })
      .from(tasks)
      .where(and(eq(tasks.projectId, projectName), isNotNull(tasks.githubIssueNumber)))
      .all()
      .map(r => r.githubIssueNumber!);
  },

  remove(id: string): boolean {
    const result = getDrizzle().delete(tasks).where(eq(tasks.id, id)).run();
    return result.changes > 0;
  },
};

// ── Task Comments Repository ────────────────────────────────────────

export const commentsRepo = {
  getByTask(taskId: string): TaskComment[] {
    return getDrizzle()
      .select().from(taskComments)
      .where(eq(taskComments.taskId, taskId))
      .orderBy(taskComments.createdAt)
      .all()
      .map(rowToComment);
  },

  create(data: { taskId: string; author: string; content: string }): TaskComment {
    const id = crypto.randomUUID();
    getDrizzle().insert(taskComments).values({
      id,
      taskId: data.taskId,
      author: data.author,
      content: data.content,
    }).run();
    return rowToComment(getDrizzle().select().from(taskComments).where(eq(taskComments.id, id)).get()!);
  },

  delete(id: string): void {
    getDrizzle().delete(taskComments).where(eq(taskComments.id, id)).run();
  },
};
