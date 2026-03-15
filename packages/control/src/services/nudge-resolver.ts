/**
 * In-memory nudge resolver.
 * The nudge endpoint creates a promise and waits for a task callback to resolve it.
 * When PUT /api/tasks/:id is called with a nudge- prefixed task ID, it resolves here.
 */

interface PendingNudge {
  resolve: (result: string) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, PendingNudge>();

/**
 * Wait for a nudge response. Returns the result string or null on timeout.
 */
export function waitForNudge(taskId: string, timeoutMs = 30_000): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(taskId);
      resolve(null);
    }, timeoutMs);

    pending.set(taskId, { resolve: (result: string) => { clearTimeout(timer); resolve(result); }, timer });
  });
}

/**
 * Resolve a pending nudge. Called from the task update route.
 * Returns true if a nudge was pending and resolved.
 */
export function resolveNudge(taskId: string, result: string): boolean {
  const entry = pending.get(taskId);
  if (!entry) return false;
  pending.delete(taskId);
  entry.resolve(result);
  return true;
}

/**
 * Check if a task ID is a nudge task.
 */
export function isNudgeTask(taskId: string): boolean {
  return taskId.startsWith('nudge-');
}
