/**
 * LRU cache for command responses — enables safe retries.
 * If a command ID has been seen before, return the cached response
 * instead of re-executing.
 */

import type { ResponseMessage } from '@coderage-labs/armada-shared';

interface CacheEntry {
  response: ResponseMessage;
  timestamp: number;
}

const DEFAULT_MAX_SIZE = 1000;
const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes

export class IdempotencyCache {
  private cache = new Map<string, CacheEntry>();
  private maxSize: number;
  private ttlMs: number;

  constructor(maxSize = DEFAULT_MAX_SIZE, ttlMs = DEFAULT_TTL_MS) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
  }

  /** Check if we have a cached response for this command ID. */
  get(commandId: string): ResponseMessage | null {
    const entry = this.cache.get(commandId);
    if (!entry) return null;

    // Expired?
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(commandId);
      return null;
    }

    // Move to end (LRU refresh)
    this.cache.delete(commandId);
    this.cache.set(commandId, entry);
    return entry.response;
  }

  /** Store a response for a command ID. */
  set(commandId: string, response: ResponseMessage): void {
    // Evict oldest if at capacity
    if (this.cache.size >= this.maxSize) {
      const oldest = this.cache.keys().next().value;
      if (oldest) this.cache.delete(oldest);
    }
    this.cache.set(commandId, { response, timestamp: Date.now() });
  }

  /** Check if a command ID is currently being processed (in-flight). */
  has(commandId: string): boolean {
    return this.cache.has(commandId);
  }

  /** Mark a command as in-flight (before execution). Stores a placeholder. */
  markInFlight(commandId: string): void {
    // Store a sentinel — if another request comes for this ID while
    // the first is still executing, we know it's a duplicate.
    // The real response will overwrite this.
    this.cache.set(commandId, {
      response: {
        type: 'response',
        id: commandId,
        status: 'error',
        error: 'Command still in flight',
        code: 'IN_FLIGHT',
      },
      timestamp: Date.now(),
    });
  }

  /** Number of cached entries. */
  get size(): number {
    return this.cache.size;
  }

  /** Periodically clean expired entries. Call from a setInterval. */
  prune(): void {
    const now = Date.now();
    for (const [id, entry] of this.cache) {
      if (now - entry.timestamp > this.ttlMs) {
        this.cache.delete(id);
      }
    }
  }
}
