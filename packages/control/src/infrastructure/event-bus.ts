// ── Unified Event Bus with wildcard subscriptions and ring buffer replay ──

export interface FleetEvent {
  id: number;
  event: string;   // e.g. 'instance.restarted', 'plugin.rollout.progress'
  data: any;
  timestamp: number;
}

export type EventBusErrorHandler = (eventName: string, error: unknown) => void;

export interface EventBus {
  emit(event: string, data: any): void;
  on(pattern: string, handler: (event: FleetEvent) => void): () => void;
  once(pattern: string, handler: (event: FleetEvent) => void): () => void;
  replay(fromId: number, filter?: string): FleetEvent[];
  getLastId(): number;
  onError(handler: EventBusErrorHandler): () => void;
}

interface Subscription {
  pattern: string;
  handler: (event: FleetEvent) => void;
}

const RING_BUFFER_SIZE = 2000;

/**
 * Pattern matching rules:
 * - Exact match: 'instance.restarted' matches 'instance.restarted' only
 * - Wildcard suffix: 'instance.*' matches 'instance.restarted', 'instance.stopped', etc.
 * - Global wildcard: '*' matches everything
 */
function matchesPattern(pattern: string, event: string): boolean {
  if (pattern === '*') return true;
  if (pattern === event) return true;
  if (pattern.endsWith('.*')) {
    const prefix = pattern.slice(0, -2);
    return event.startsWith(prefix + '.');
  }
  return false;
}

export function createEventBus(): EventBus {
  let nextId = 1;
  const buffer: (FleetEvent | undefined)[] = new Array(RING_BUFFER_SIZE);
  let bufferStart = 0;
  let bufferCount = 0;
  const subscriptions = new Set<Subscription>();
  const errorHandlers = new Set<EventBusErrorHandler>();

  function emit(event: string, data: any): void {
    const fleetEvent: FleetEvent = {
      id: nextId++,
      event,
      data,
      timestamp: Date.now(),
    };

    // Write into ring buffer
    const writeIdx = (bufferStart + bufferCount) % RING_BUFFER_SIZE;
    buffer[writeIdx] = fleetEvent;
    if (bufferCount < RING_BUFFER_SIZE) {
      bufferCount++;
    } else {
      bufferStart = (bufferStart + 1) % RING_BUFFER_SIZE;
    }

    // Notify subscribers
    for (const sub of subscriptions) {
      if (matchesPattern(sub.pattern, event)) {
        try {
          sub.handler(fleetEvent);
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          console.error(
            `[event-bus] Handler error on '${event}': ${error.message}`,
            error.stack,
          );
          for (const onErr of errorHandlers) {
            try { onErr(event, err); } catch { /* don't let error handlers crash the bus */ }
          }
        }
      }
    }
  }

  function on(pattern: string, handler: (event: FleetEvent) => void): () => void {
    const sub: Subscription = { pattern, handler };
    subscriptions.add(sub);
    return () => { subscriptions.delete(sub); };
  }

  function once(pattern: string, handler: (event: FleetEvent) => void): () => void {
    const sub: Subscription = {
      pattern,
      handler: (event: FleetEvent) => {
        subscriptions.delete(sub);
        handler(event);
      },
    };
    subscriptions.add(sub);
    return () => { subscriptions.delete(sub); };
  }

  function replay(fromId: number, filter?: string): FleetEvent[] {
    const result: FleetEvent[] = [];
    for (let i = 0; i < bufferCount; i++) {
      const idx = (bufferStart + i) % RING_BUFFER_SIZE;
      const evt = buffer[idx];
      if (!evt || evt.id <= fromId) continue;
      if (filter && !matchesPattern(filter, evt.event)) continue;
      result.push(evt);
    }
    return result;
  }

  function getLastId(): number {
    return nextId - 1;
  }

  function onError(handler: EventBusErrorHandler): () => void {
    errorHandlers.add(handler);
    return () => { errorHandlers.delete(handler); };
  }

  return { emit, on, once, replay, getLastId, onError };
}

/** Singleton event bus for the fleet API */
export const eventBus = createEventBus();
