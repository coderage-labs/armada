/**
 * withRetry — configurable retry with exponential backoff.
 *
 * Wraps an async function and retries it on failure up to `maxAttempts` times,
 * waiting `delayMs * backoff^(attempt-1)` milliseconds between each attempt.
 *
 * @example
 *   await withRetry(() => node.pullImage(image), { maxAttempts: 3, delayMs: 2000, backoff: 2 });
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts?: {
    maxAttempts?: number;
    delayMs?: number;
    backoff?: number;
    onRetry?: (attempt: number, err: Error) => void;
  },
): Promise<T> {
  const maxAttempts = opts?.maxAttempts ?? 3;
  const delayMs = opts?.delayMs ?? 2000;
  const backoff = opts?.backoff ?? 2;
  const onRetry = opts?.onRetry;

  let lastError: Error = new Error('withRetry: no attempts made');

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (attempt < maxAttempts) {
        onRetry?.(attempt, lastError);
        const wait = delayMs * Math.pow(backoff, attempt - 1);
        await new Promise(r => setTimeout(r, wait));
      }
    }
  }

  throw lastError;
}
