import { createContext, useContext, useState, useEffect, useCallback, useRef, type ReactNode } from 'react';
import { apiFetch } from '../hooks/useApi';

interface OperationEvent {
  step: string;
  timestamp: number;
  [key: string]: any;
}

interface Operation {
  id: string;
  type: string;
  status: 'running' | 'completed' | 'failed';
  target: any;
  startedAt: string;
  completedAt: string | null;
  events: OperationEvent[];
  result: any;
}

interface OperationsContextValue {
  operations: Operation[];
  activeOps: Operation[];
  subscribe(opId: string): void;
  dismiss(opId: string): void;
}

const OperationsContext = createContext<OperationsContextValue | null>(null);

export function OperationsProvider({ children }: { children: ReactNode }) {
  const [operations, setOperations] = useState<Operation[]>([]);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const streamsRef = useRef<Map<string, AbortController>>(new Map());

  const subscribeToOp = useCallback((opId: string) => {
    if (streamsRef.current.has(opId)) return; // already subscribed

    const controller = new AbortController();
    streamsRef.current.set(opId, controller);
    const token = localStorage.getItem('armada_token');

    fetch(`/api/operations/${opId}/stream`, {
      headers: { 'Authorization': `Bearer ${token}` },
      signal: controller.signal,
    }).then(async (resp) => {
      if (!resp.ok || !resp.body) return;
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              setOperations(prev => {
                const idx = prev.findIndex(o => o.id === opId);
                if (idx === -1) {
                  // Add new operation
                  return [...prev, {
                    id: opId, type: data.type || '', status: 'running',
                    target: null, startedAt: '', completedAt: null,
                    events: [data], result: null,
                  }];
                }
                const updated = [...prev];
                const op = { ...updated[idx] };
                op.events = [...op.events, data];
                if (data.step === 'completed') {
                  op.status = 'completed';
                  op.completedAt = new Date().toISOString();
                  op.result = data;
                } else if (data.step === 'failed') {
                  op.status = 'failed';
                  op.completedAt = new Date().toISOString();
                  op.result = data;
                }
                updated[idx] = op;
                return updated;
              });
            } catch { /* ignore parse errors */ }
          }
        }
      }
    }).catch(() => { /* connection closed or aborted */ }).finally(() => {
      streamsRef.current.delete(opId);
    });
  }, []);

  // Fetch active operations on mount
  useEffect(() => {
    apiFetch<Operation[]>('/api/operations?status=running')
      .then(ops => {
        setOperations(ops);
        // Auto-subscribe to all running operations
        ops.forEach(op => subscribeToOp(op.id));
      })
      .catch(() => {});
  }, [subscribeToOp]);

  const subscribe = useCallback((opId: string) => {
    // Add to operations list and start streaming
    setOperations(prev => {
      if (prev.find(o => o.id === opId)) return prev;
      return [...prev, {
        id: opId, type: '', status: 'running', target: null,
        startedAt: new Date().toISOString(), completedAt: null,
        events: [], result: null,
      }];
    });
    subscribeToOp(opId);
  }, [subscribeToOp]);

  const dismiss = useCallback((opId: string) => {
    setDismissed(prev => new Set([...prev, opId]));
  }, []);

  const activeOps = operations.filter(o => o.status === 'running' && !dismissed.has(o.id));

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      streamsRef.current.forEach(c => c.abort());
    };
  }, []);

  return (
    <OperationsContext.Provider value={{ operations, activeOps, subscribe, dismiss }}>
      {children}
    </OperationsContext.Provider>
  );
}

export function useOperations() {
  const ctx = useContext(OperationsContext);
  if (!ctx) throw new Error('useOperations must be inside OperationsProvider');
  return ctx;
}
