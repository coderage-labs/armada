import { describe, it, expect, beforeEach } from 'vitest';
import { IdempotencyCache } from '../ws/idempotency-cache.js';
import type { ResponseMessage } from '@coderage-labs/armada-shared';

const makeResponse = (id: string, status: 'ok' | 'error' = 'ok'): ResponseMessage => ({
  type: 'response',
  id,
  status,
  data: { result: 'success' },
});

describe('IdempotencyCache', () => {
  let cache: IdempotencyCache;

  beforeEach(() => {
    cache = new IdempotencyCache(5, 1000); // small for testing
  });

  it('returns null for unknown commands', () => {
    expect(cache.get('unknown')).toBeNull();
  });

  it('caches and retrieves responses', () => {
    const resp = makeResponse('cmd-1');
    cache.set('cmd-1', resp);
    expect(cache.get('cmd-1')).toEqual(resp);
  });

  it('evicts oldest when at capacity', () => {
    for (let i = 0; i < 6; i++) {
      cache.set(`cmd-${i}`, makeResponse(`cmd-${i}`));
    }
    // cmd-0 should be evicted (max size 5)
    expect(cache.get('cmd-0')).toBeNull();
    expect(cache.get('cmd-5')).not.toBeNull();
  });

  it('expires entries after TTL', async () => {
    cache = new IdempotencyCache(100, 50); // 50ms TTL
    cache.set('cmd-1', makeResponse('cmd-1'));
    await new Promise(r => setTimeout(r, 60));
    expect(cache.get('cmd-1')).toBeNull();
  });

  it('marks in-flight and overwrites with real response', () => {
    cache.markInFlight('cmd-1');
    const inflight = cache.get('cmd-1');
    expect(inflight?.code).toBe('IN_FLIGHT');

    const real = makeResponse('cmd-1');
    cache.set('cmd-1', real);
    expect(cache.get('cmd-1')).toEqual(real);
  });

  it('prune removes expired entries', async () => {
    cache = new IdempotencyCache(100, 50);
    cache.set('cmd-1', makeResponse('cmd-1'));
    cache.set('cmd-2', makeResponse('cmd-2'));
    await new Promise(r => setTimeout(r, 60));
    cache.prune();
    expect(cache.size).toBe(0);
  });
});
