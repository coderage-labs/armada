import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Check, Play, Trash2, AlertTriangle, RotateCcw } from 'lucide-react';
import { apiFetch } from '../../hooks/useApi';
import { Button } from '../ui/button';
import type { Changeset } from '@coderage-labs/armada-shared';

interface ChangesetActionsProps {
  cs: Changeset;
  onRefresh: () => void;
  /** Stop click events from bubbling (e.g. inside a toggle button) */
  stopPropagation?: boolean;
}

export function ChangesetActions({ cs, onRefresh, stopPropagation = true }: ChangesetActionsProps) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  if (cs.status !== 'draft' && cs.status !== 'approved' && cs.status !== 'failed') return null;

  const maybeStop = (e: React.MouseEvent) => {
    if (stopPropagation) e.stopPropagation();
  };

  const doAction = async (e: React.MouseEvent, action: string) => {
    maybeStop(e);
    setError(null);
    setLoading(true);
    try {
      if (action === 'cancel') {
        // Use draft discard for draft changesets, legacy cancel for others
        await apiFetch('/api/draft/discard', { method: 'POST' });
        // Invalidate ALL entity caches so pending indicators clear immediately
        queryClient.invalidateQueries();
      } else {
        await apiFetch(`/api/changesets/${cs.id}/${action}`, { method: 'POST' });
        // Apply also changes all entities
        queryClient.invalidateQueries();
      }
      onRefresh();
    } catch (err: any) {
      const raw = err?.message || String(err);
      // apiFetch throws "409 Conflict: {json...}" — extract the JSON error field
      const jsonStart = raw.indexOf('{');
      if (jsonStart >= 0) {
        try {
          const parsed = JSON.parse(raw.slice(jsonStart));
          // Extract validation reason if present
          const reason = parsed?.validation?.staleness?.reason;
          setError(reason || parsed.error || raw);
        } catch {
          setError(raw);
        }
      } else {
        setError(raw);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {cs.status === 'draft' && (
        <Button
         variant="secondary"
          size="sm"
          disabled={loading}
          className="bg-yellow-500/20 text-yellow-300 hover:bg-yellow-500/30 border-yellow-500/20"
          onClick={(e) => doAction(e, 'approve')}
        >
          <Check className="w-3 h-3" />
          Approve
        </Button>
      )}
      {cs.status === 'approved' && (
        <Button
         variant="secondary"
          size="sm"
          disabled={loading}
          className="bg-violet-500/20 text-violet-300 hover:bg-violet-500/30 border-violet-500/20"
          onClick={(e) => doAction(e, 'apply')}
        >
          <Play className="w-3 h-3" />
          Apply
        </Button>
      )}
      {cs.status === 'failed' && (
        <Button
          variant="secondary"
          size="sm"
          disabled={loading}
          className="bg-amber-500/20 text-amber-300 hover:bg-amber-500/30 border-amber-500/20"
          onClick={(e) => doAction(e, 'retry')}
        >
          <RotateCcw className="w-3 h-3" />
          Retry Failed
        </Button>
      )}
      {(cs.status === 'draft' || cs.status === 'approved' || cs.status === 'failed') && (
        <Button
          variant="secondary"
          size="sm"
          disabled={loading}
          onClick={(e) => doAction(e, 'cancel')}
        >
          <Trash2 className="w-3 h-3" />
          Discard
        </Button>
      )}
      {error && (
        <div className="flex items-center gap-1.5 text-xs text-red-400">
          <AlertTriangle className="w-3 h-3 shrink-0" />
          <span className="truncate max-w-[200px] sm:max-w-xs">{error}</span>
        </div>
      )}
    </div>
  );
}
