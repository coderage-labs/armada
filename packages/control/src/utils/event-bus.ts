/**
 * Simple in-process event bus for broadcasting SSE events.
 */
type Listener = (event: string, data: any) => void;

const listeners = new Set<Listener>();

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function broadcast(event: string, data: any): void {
  for (const fn of listeners) {
    try { fn(event, data); } catch (err: any) { console.warn('[event-bus] listener threw:', err.message); }
  }
}
