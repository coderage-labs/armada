import { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';

interface SSEContextValue {
  connected: boolean;
  subscribe: (eventType: string, callback: (data: any) => void) => () => void;
  /** Timestamp of last received SSE event (0 = never) */
  lastEventTime: number;
  /** Count of events received this session */
  eventCount: number;
  /** Whether fallback polling is active */
  polling: boolean;
}

const SSEContext = createContext<SSEContextValue | null>(null);

// ── Invalidation mapping ──
// When an SSE event arrives, which react-query caches should be invalidated?
// Mutation and changeset events affect ALL entity caches (pending overlay changes).

const ALL_ENTITIES = [
  'agents', 'instances', 'nodes', 'providers', 'templates',
  'models', 'webhooks', 'integrations', 'plugins', 'skills',
];

const INVALIDATION_MAP: Record<string, string[]> = {
  'agent.session.updated': ['agent-session-messages'],
  'agent.avatar.generating': ['agents'],
  'agent.avatar.completed':  ['agents'],
  'agent.avatar.failed':     ['agents'],
  'user.avatar.generating':  ['users'],
  'user.avatar.completed':   ['users'],
  'user.avatar.failed':      ['users'],
  'agent.':     ['agents', 'badges'],
  'node.':      ['nodes', 'badges'],
  'instance.':  ['instances'],
  'operation.': ['operations', 'badges'],
  'task.':      ['tasks'],
  'template.':  ['templates'],
  'plugin.':    ['plugins'],
  'skill.':     ['skills'],
  'workflow.':  ['workflows'],
  'activity.':  ['activity'],
  'github.':    ['projects', 'tasks'],
  // These affect pending overlay on ALL entities
  'changeset.': ['changesets', 'mutations', 'draft', ...ALL_ENTITIES],
  'mutation.':  ['mutations', 'draft', ...ALL_ENTITIES],
  'draft.':     ['draft', 'changesets', ...ALL_ENTITIES],
  // Config changes may affect anything
  'config.':    ['changesets', ...ALL_ENTITIES],
};

export function SSEProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const [connected, setConnected] = useState(false);
  const esRef = useRef<EventSource | null>(null);
  const callbacksRef = useRef<Map<string, Set<(data: any) => void>>>(new Map());
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectDelayRef = useRef(1000);

  const connect = useCallback(() => {
    const token = localStorage.getItem('armada_token');
    const authed = localStorage.getItem('armada_authed');
    console.log('[SSE] connect() called, token:', token ? 'present' : 'MISSING', 'authed:', authed || 'none');
    
    // Need either a token OR cookie-based auth (passkey/password session)
    if (!token && !authed) return;

    // If we have a token, pass it as query param. Otherwise rely on session cookie.
    const url = token
      ? `/api/events/stream?token=${token}`
      : '/api/events/stream';
    console.log('[SSE] Opening EventSource:', url.substring(0, 50));
    const es = new EventSource(url);
    esRef.current = es;

    es.onopen = () => {
      console.log('[SSE] Connected!');
      setConnected(true);
      reconnectDelayRef.current = 1000;
    };

    es.onerror = (err) => {
      console.log('[SSE] Error, readyState:', es.readyState);
      setConnected(false);
      es.close();
      esRef.current = null;

      const delay = Math.min(reconnectDelayRef.current, 30000);
      reconnectTimeoutRef.current = setTimeout(() => {
        reconnectDelayRef.current = delay * 2;
        connect();
      }, delay);
    };

    es.onmessage = (e) => {
      try {
        lastEventRef.current = Date.now();
        eventCountRef.current++;
        setLastEventTime(lastEventRef.current);
        setEventCount(eventCountRef.current);
        const data = JSON.parse(e.data);
        const eventType: string | undefined = data.event || data.type;
        if (!eventType) return;

        // Notify registered subscribers
        const callbacks = callbacksRef.current.get(eventType);
        if (callbacks) {
          callbacks.forEach(cb => cb(data));
        }
        // Notify wildcard subscribers
        const wildcardCallbacks = callbacksRef.current.get('*');
        if (wildcardCallbacks) {
          wildcardCallbacks.forEach(cb => cb(data));
        }

        // Invalidate react-query caches based on event prefix
        for (const [prefix, queryKeys] of Object.entries(INVALIDATION_MAP)) {
          if (eventType.startsWith(prefix)) {
            for (const key of queryKeys) {
              queryClient.invalidateQueries({ queryKey: [key] });
            }
            break; // First match wins
          }
        }
      } catch {
        // Ignore parse errors (e.g., SSE comments)
      }
    };
  }, [queryClient]);

  // SSE diagnostics
  const lastEventRef = useRef(0);
  const eventCountRef = useRef(0);
  const [lastEventTime, setLastEventTime] = useState(0);
  const [eventCount, setEventCount] = useState(0);
  const [polling, setPolling] = useState(false);

  // Fallback polling: ONLY activates when SSE is confirmed disconnected.
  // Does NOT poll during startup — waits for SSE to connect first, then monitors.
  const pollRef = useRef<NodeJS.Timeout | null>(null);
  const hasEverConnectedRef = useRef(false);

  useEffect(() => {
    if (connected) hasEverConnectedRef.current = true;
  }, [connected]);

  useEffect(() => {
    pollRef.current = setInterval(() => {
      // Don't poll if we've never connected — still initialising
      if (!hasEverConnectedRef.current) {
        setPolling(false);
        return;
      }
      // Only poll if SSE is disconnected AND last event was >15s ago
      const stale = !connected && (Date.now() - lastEventRef.current > 15_000);
      setPolling(stale);
      if (stale) {
        queryClient.invalidateQueries({ queryKey: ['changesets'] });
        queryClient.invalidateQueries({ queryKey: ['nodes'] });
        queryClient.invalidateQueries({ queryKey: ['providers'] });
        queryClient.invalidateQueries({ queryKey: ['agents'] });
        queryClient.invalidateQueries({ queryKey: ['instances'] });
        queryClient.invalidateQueries({ queryKey: ['badges'] });
      }
    }, 15_000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [queryClient, connected]);

  useEffect(() => {
    connect();

    // Re-connect when token appears (e.g., after login)
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'armada_token' && e.newValue && !esRef.current) {
        console.log('[SSE] Token appeared in storage, connecting...');
        connect();
      }
    };
    window.addEventListener('storage', onStorage);

    // Also poll for token/session since storage events don't fire in the same tab
    const tokenPoll = setInterval(() => {
      const token = localStorage.getItem('armada_token');
      const authed = localStorage.getItem('armada_authed');
      if ((token || authed) && !esRef.current) {
        console.log('[SSE] Auth found via poll, connecting...');
        connect();
      }
    }, 2000);

    return () => {
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
      if (esRef.current) esRef.current.close();
      window.removeEventListener('storage', onStorage);
      clearInterval(tokenPoll);
    };
  }, [connect]);

  const subscribe = useCallback((eventType: string, callback: (data: any) => void) => {
    if (!callbacksRef.current.has(eventType)) {
      callbacksRef.current.set(eventType, new Set());
    }
    callbacksRef.current.get(eventType)!.add(callback);

    return () => {
      const callbacks = callbacksRef.current.get(eventType);
      if (callbacks) {
        callbacks.delete(callback);
        if (callbacks.size === 0) callbacksRef.current.delete(eventType);
      }
    };
  }, []);

  return (
    <SSEContext.Provider value={{ connected, subscribe, lastEventTime, eventCount, polling }}>
      {children}
    </SSEContext.Provider>
  );
}

export function useSSEEvent(eventType: string, callback: (data: any) => void) {
  const context = useContext(SSEContext);
  if (!context) throw new Error('useSSEEvent must be used within SSEProvider');

  useEffect(() => {
    return context.subscribe(eventType, callback);
  }, [context, eventType, callback]);
}

/**
 * Subscribe to ALL SSE events. Callback receives (eventType, data).
 * Uses the shared single SSEProvider connection — no extra EventSource.
 */
export function useSSEAll(callback: (eventType: string, data: any) => void) {
  const context = useContext(SSEContext);
  if (!context) throw new Error('useSSEAll must be used within SSEProvider');

  const cbRef = useRef(callback);
  cbRef.current = callback;

  useEffect(() => {
    return context.subscribe('*', (data: any) => {
      cbRef.current(data.event || data.type || 'unknown', data);
    });
  }, [context]);
}

export function useSSEConnection() {
  const context = useContext(SSEContext);
  if (!context) throw new Error('useSSEConnection must be used within SSEProvider');
  return {
    connected: context.connected,
    lastEventTime: context.lastEventTime,
    eventCount: context.eventCount,
    polling: context.polling,
  };
}
