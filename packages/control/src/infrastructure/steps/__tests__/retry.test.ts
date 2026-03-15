import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withRetry } from '../retry.js';

describe('withRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves immediately when the function succeeds on the first attempt', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withRetry(fn);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries and resolves when the function succeeds on a subsequent attempt', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('fail 1'))
      .mockRejectedValueOnce(new Error('fail 2'))
      .mockResolvedValue('success');

    const promise = withRetry(fn, { maxAttempts: 3, delayMs: 100, backoff: 1 });
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('throws the last error after exhausting all attempts', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('persistent failure'));
    const promise = withRetry(fn, { maxAttempts: 3, delayMs: 100, backoff: 1 });
    // Attach catch handler BEFORE advancing timers to prevent unhandled rejection
    const caught = promise.catch(e => e);
    await vi.runAllTimersAsync();
    const err = await caught;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('persistent failure');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('uses defaults: 3 attempts, 2s delay, 2x backoff', async () => {
    // Track when each attempt fires using Date.now() (fake timers mock this)
    const attempts: number[] = [];
    const fn = vi.fn().mockImplementation(async () => {
      attempts.push(Date.now());
      throw new Error('fail');
    });

    const promise = withRetry(fn);
    const caught = promise.catch(e => e);
    await vi.runAllTimersAsync();
    await caught;

    expect(fn).toHaveBeenCalledTimes(3);
    // First attempt fires at t=0
    // Second at t≥2000 (2s delay, backoff^0 = 1x)
    // Third at t≥6000 (2s * 2^1 = 4s after second)
    expect(attempts[1] - attempts[0]).toBeGreaterThanOrEqual(2000);
    expect(attempts[2] - attempts[1]).toBeGreaterThanOrEqual(4000);
  });

  it('applies exponential backoff between retries', async () => {
    const attempts: number[] = [];
    const fn = vi.fn().mockImplementation(async () => {
      attempts.push(Date.now());
      throw new Error('fail');
    });

    const promise = withRetry(fn, { maxAttempts: 4, delayMs: 500, backoff: 3 });
    const caught = promise.catch(e => e);
    await vi.runAllTimersAsync();
    await caught;

    expect(fn).toHaveBeenCalledTimes(4);
    // Delays: 500 * 3^0=500ms, 500 * 3^1=1500ms, 500 * 3^2=4500ms
    expect(attempts[1] - attempts[0]).toBeGreaterThanOrEqual(500);
    expect(attempts[2] - attempts[1]).toBeGreaterThanOrEqual(1500);
    expect(attempts[3] - attempts[2]).toBeGreaterThanOrEqual(4500);
  });

  it('calls onRetry with the attempt number and error on each retry', async () => {
    const onRetry = vi.fn();
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('err1'))
      .mockRejectedValueOnce(new Error('err2'))
      .mockResolvedValue('done');

    const promise = withRetry(fn, { maxAttempts: 3, delayMs: 10, backoff: 1, onRetry });
    await vi.runAllTimersAsync();
    await promise;

    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenNthCalledWith(1, 1, expect.objectContaining({ message: 'err1' }));
    expect(onRetry).toHaveBeenNthCalledWith(2, 2, expect.objectContaining({ message: 'err2' }));
  });

  it('does not call onRetry when function succeeds on the first attempt', async () => {
    const onRetry = vi.fn();
    const fn = vi.fn().mockResolvedValue('win');

    await withRetry(fn, { onRetry });

    expect(onRetry).not.toHaveBeenCalled();
  });

  it('does not call onRetry on the final failing attempt', async () => {
    const onRetry = vi.fn();
    const fn = vi.fn().mockRejectedValue(new Error('fail'));

    const promise = withRetry(fn, { maxAttempts: 2, delayMs: 10, backoff: 1, onRetry });
    const caught = promise.catch(e => e);
    await vi.runAllTimersAsync();
    await caught;

    // Only 1 retry callback (between attempt 1 and attempt 2); no callback after the final failure
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(1, expect.any(Error));
  });

  it('wraps non-Error rejections in an Error', async () => {
    // eslint-disable-next-line prefer-promise-reject-errors
    const fn = vi.fn().mockRejectedValue('string error');

    const promise = withRetry(fn, { maxAttempts: 1 });
    await expect(promise).rejects.toBeInstanceOf(Error);
  });

  it('succeeds with maxAttempts: 1 when function resolves', async () => {
    const fn = vi.fn().mockResolvedValue(42);
    const result = await withRetry(fn, { maxAttempts: 1 });
    expect(result).toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('throws immediately with maxAttempts: 1 when function fails', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('instant fail'));
    await expect(withRetry(fn, { maxAttempts: 1 })).rejects.toThrow('instant fail');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
