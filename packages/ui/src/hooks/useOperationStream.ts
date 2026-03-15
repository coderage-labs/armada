import { useState, useEffect, useCallback } from 'react';
import type { Operation, OperationStep } from '@coderage-labs/armada-shared';

interface UseOperationStreamResult {
  operation: Operation | null;
  steps: OperationStep[];
  done: boolean;
  error: string | null;
}

/**
 * Subscribe to a specific operation's SSE stream.
 * Returns live-updated operation data.
 */
export function useOperationStream(
  operationId: string | null,
  initialOperation: Operation | null = null,
): UseOperationStreamResult {
  const [operation, setOperation] = useState<Operation | null>(initialOperation);
  const [steps, setSteps] = useState<OperationStep[]>(initialOperation?.steps ?? []);
  const [done, setDone] = useState(
    !!(initialOperation && initialOperation.status !== 'running' && initialOperation.status !== 'pending'),
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!operationId) return;

    const token = localStorage.getItem('fleet_token') || '';
    const url = `/api/operations/${operationId}/stream?token=${token}`;
    const es = new EventSource(url);

    // 'progress' events: append/update event log (may carry step updates)
    es.addEventListener('progress', (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        // progress may contain updated steps
        if (data.steps) {
          setSteps(data.steps);
        }
      } catch {/* ignore */}
    });

    // 'steps' event: full steps array replacement
    es.addEventListener('steps', (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        if (data.steps) {
          setSteps(data.steps);
        } else if (Array.isArray(data)) {
          setSteps(data);
        }
      } catch {/* ignore */}
    });

    const handleTerminal = (status: Operation['status']) => (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        setOperation(prev => prev ? { ...prev, ...data, status } : null);
        if (data.steps) setSteps(data.steps);
        setDone(true);
        if (status === 'failed') setError(data.error ?? 'Operation failed');
      } catch {/* ignore */}
      es.close();
    };

    es.addEventListener('completed', handleTerminal('completed'));
    es.addEventListener('failed', handleTerminal('failed'));
    es.addEventListener('cancelled', handleTerminal('cancelled'));

    es.onerror = () => {
      // EventSource auto-reconnects; don't close unless done
    };

    return () => es.close();
  }, [operationId]);

  return { operation, steps, done, error };
}
