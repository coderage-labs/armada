/**
 * TaskManager — consolidates task completion side effects.
 *
 * Both `PUT /api/tasks/:id` and `POST /api/tasks/:id/result` perform
 * overlapping side effects when a task completes.  This service provides
 * a single `completeTask` entry-point so the routes stay thin.
 */

import { tasksRepo } from '../repositories/index.js';
import { eventBus } from '../infrastructure/event-bus.js';
import { logActivity } from './activity-service.js';
import { dispatchWebhook } from './webhook-dispatcher.js';
import { isNudgeTask, resolveNudge } from './nudge-resolver.js';
import { checkWorkflowStep } from './workflow-dispatcher.js';
import { onTaskCompleted } from './task-dispatcher.js';
import { emitTaskEvent } from '../routes/tasks.js';
import type { MeshTask } from '@coderage-labs/armada-shared';

export interface TaskManager {
  completeTask(id: string, status: string, result?: string): Promise<MeshTask | null>;
}

function createTaskManager(): TaskManager {
  return {
    async completeTask(id: string, status: string, result?: string): Promise<MeshTask | null> {
      // 1. Update task in DB
      const updates: Partial<MeshTask> = {
        status: status as MeshTask['status'],
        completedAt: new Date().toISOString(),
      };
      if (result !== undefined) {
        updates.result = result;
      }

      const task = tasksRepo.update(id, updates);
      if (!task) return null;

      // 2. Resolve pending nudge if applicable
      if (isNudgeTask(id) && (status === 'completed' || status === 'failed')) {
        resolveNudge(id, result ?? 'No response');
      }

      // 3. Emit task event for SSE listeners (also dispatches webhook internally)
      emitTaskEvent('task:updated', task);

      // 4. Log activity
      if (status === 'completed') {
        logActivity({
          eventType: 'task.completed',
          agentName: task.toAgent,
          detail: `Task from ${task.fromAgent} completed`,
        });
      } else if (status === 'failed') {
        logActivity({
          eventType: 'task.failed',
          agentName: task.toAgent,
          detail: `Task from ${task.fromAgent} failed`,
        });
      }

      // 5. Emit to event bus
      eventBus.emit('task.status', { taskId: id, status, agentName: task.toAgent });
      if (status === 'completed') {
        eventBus.emit('task.completed', { taskId: id, agentName: task.toAgent, success: true });
      } else if (status === 'failed') {
        eventBus.emit('task.completed', { taskId: id, agentName: task.toAgent, success: false });
      }

      // 6. Workflow step advancement is handled by the callback endpoint
      // (POST /tasks/:id/result → checkWorkflowStep in workflow-dispatcher)
      // Do NOT call it here — the PUT endpoint sends truncated output that
      // races with the POST's full output, causing condition evaluation failures.

      // 7. Handle board column management and next task dispatch
      await onTaskCompleted(task).catch(() => {});

      return task;
    },
  };
}

/** Singleton task manager instance */
export const taskManager = createTaskManager();
