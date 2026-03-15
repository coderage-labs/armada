import { tasksRepo } from '../repositories/index.js';
import { logActivity } from './activity-service.js';
import { getDrizzle } from '../db/drizzle.js';
import { tasks } from '../db/drizzle-schema.js';
import { eq } from 'drizzle-orm';

// ── Configuration ───────────────────────────────────────────────────

const CHECK_INTERVAL_MS = 60_000;            // 60 seconds
const RUNNING_STUCK_THRESHOLD_MS = 1_800_000; // 30 minutes
const PENDING_STUCK_THRESHOLD_MS = 900_000;   // 15 minutes

let intervalHandle: ReturnType<typeof setInterval> | null = null;

// ── Detector logic ──────────────────────────────────────────────────

function detectStuckTasks(): void {
  const now = Date.now();

  // Find running tasks that haven't been updated in >10 minutes
  const runningTasks = getDrizzle().select().from(tasks).where(eq(tasks.status, 'running')).all();

  for (const row of runningTasks) {
    const lastUpdate = new Date(row.lastProgressAt || row.createdAt).getTime();
    const age = now - lastUpdate;
    if (age > RUNNING_STUCK_THRESHOLD_MS) {
      tasksRepo.update(row.id, {
        status: 'blocked',
        blockedReason: 'No progress for 30+ minutes',
        blockedAt: new Date().toISOString(),
      });
      logActivity({
        eventType: 'task.blocked',
        agentName: row.toAgent,
        detail: `Task ${row.id} auto-blocked: No progress for 30+ minutes (from ${row.fromAgent})`,
      });
      console.log(`🚫 Task ${row.id} auto-blocked (running >30min)`);
    }
  }

  // Find pending tasks stuck for >15 minutes (only if assigned to an agent)
  const pendingTasks = getDrizzle().select().from(tasks)
    .where(eq(tasks.status, 'pending'))
    .all()
    .filter(t => t.toAgent && t.toAgent !== '');

  for (const row of pendingTasks) {
    const lastUpdate = new Date(row.lastProgressAt || row.createdAt).getTime();
    const age = now - lastUpdate;
    if (age > PENDING_STUCK_THRESHOLD_MS) {
      tasksRepo.update(row.id, {
        status: 'blocked',
        blockedReason: 'Pending for 15+ minutes — agent may not have received the task',
        blockedAt: new Date().toISOString(),
      });
      logActivity({
        eventType: 'task.blocked',
        agentName: row.toAgent,
        detail: `Task ${row.id} auto-blocked: Pending for 15+ minutes (from ${row.fromAgent})`,
      });
      console.log(`🚫 Task ${row.id} auto-blocked (pending >15min)`);
    }
  }
}

// ── Lifecycle ───────────────────────────────────────────────────────

export function startStuckDetector(): void {
  if (intervalHandle) return;
  console.log('🔍 Stuck task detector started (checking every 60s)');
  intervalHandle = setInterval(() => {
    try {
      detectStuckTasks();
    } catch (err) {
      console.error('Stuck detector error:', err);
    }
  }, CHECK_INTERVAL_MS);
}

export function stopStuckDetector(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    console.log('🔍 Stuck task detector stopped');
  }
}
