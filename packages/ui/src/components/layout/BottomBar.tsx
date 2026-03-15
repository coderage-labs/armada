import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { X, CheckCircle2, AlertCircle, Loader2, GitPullRequest } from 'lucide-react';
import { Button } from '../ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip';
import { apiFetch } from '../../hooks/useApi';
import { useSSEAll } from '../../providers/SSEProvider';
import { useOperations } from '../../contexts/OperationsContext';
import type { Changeset } from '@coderage-labs/armada-shared';
import { humanize } from '../../i18n';

const ACTIVE_CHANGESET_STATUSES: Changeset['status'][] = ['draft', 'approved', 'applying'];

export default function BottomBar() {
  const navigate = useNavigate();
  const { operations, dismiss } = useOperations();
  const [changeset, setChangeset] = useState<Changeset | null>(null);
  const [dismissedChangesetId, setDismissedChangesetId] = useState<string | null>(null);

  // Load active changeset
  const loadChangeset = useCallback(async () => {
    try {
      const data = await apiFetch<Changeset[]>('/api/changesets?limit=5');
      const active = data.find(cs => ACTIVE_CHANGESET_STATUSES.includes(cs.status)) ?? null;
      setChangeset(prev => {
        if (!active && prev && ACTIVE_CHANGESET_STATUSES.includes(prev.status)) {
          const updated = data.find(cs => cs.id === prev.id);
          if (updated && (updated.status === 'completed' || updated.status === 'failed')) {
            return updated;
          }
        }
        return active;
      });
    } catch {
      setChangeset(null);
    }
  }, []);

  useEffect(() => { loadChangeset(); }, [loadChangeset]);

  useSSEAll(useCallback((type: string) => {
    if (type.startsWith('operation.') || type.startsWith('changeset.') || type.startsWith('mutation.') || type.startsWith('draft.')) {
      loadChangeset();
    }
  }, [loadChangeset]));

  // Auto-dismiss completed/failed changesets after 5 seconds
  useEffect(() => {
    if (!changeset) return;
    if (changeset.status === 'completed' || changeset.status === 'failed') {
      const timer = setTimeout(() => setDismissedChangesetId(changeset.id), 5000);
      return () => clearTimeout(timer);
    }
  }, [changeset?.id, changeset?.status]);

  // Filter operations (exclude changeset_apply, show recent completed)
  const recentlyCompleted = operations.filter(
    o => o.type !== 'changeset_apply' &&
    (o.status === 'completed' || o.status === 'failed') &&
    o.completedAt &&
    Date.now() - new Date(o.completedAt).getTime() < 10_000
  );
  const activeOps = operations.filter(o => o.status === 'running' && o.type !== 'changeset_apply');
  const visibleOps = [...activeOps, ...recentlyCompleted];

  // Show bar if there's a changeset or operations
  const showChangeset = changeset && changeset.id !== dismissedChangesetId;
  const showOps = visibleOps.length > 0;
  const visible = showChangeset || showOps;

  if (!visible) return null;

  // Changeset summary
  const changesetSummary = changeset ? (
    <div className="flex items-center gap-3">
      <GitPullRequest className="w-4 h-4 text-violet-400 shrink-0" />
      <span className="text-sm text-zinc-300">
        {changeset.status === 'applying' ? 'Applying changes…' : 'Pending changeset'}
      </span>
      {changeset.status === 'draft' || changeset.status === 'approved' ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate('/changesets')}
          className="h-7 px-3 text-xs text-violet-300 hover:text-violet-200 hover:bg-violet-500/20"
        >
          Review
        </Button>
      ) : null}
    </div>
  ) : null;

  return (
    <div className="fixed bottom-0 left-0 right-0 z-50 border-t border-zinc-700 bg-zinc-950/95 dark:bg-zinc-950/95">
      <div className="max-w-7xl mx-auto px-6 py-3 flex items-center justify-between gap-6 flex-wrap">
        {/* Left: Changeset */}
        <div className="flex-1 min-w-0">
          {changesetSummary}
        </div>

        {/* Right: Operations */}
        {showOps && (
          <div className="flex items-center gap-4 flex-wrap">
            {visibleOps.slice(0, 3).map(op => {
              const lastEvent = op.events[op.events.length - 1];
              const label = formatOpType(op.type);
              const progress = lastEvent ? formatProgress(lastEvent) : '';

              return (
                <div key={op.id} className="flex items-center gap-3">
                  {op.status === 'running' && <Loader2 className="w-4 h-4 text-blue-400 animate-spin flex-shrink-0" />}
                  {op.status === 'completed' && <CheckCircle2 className="w-4 h-4 text-emerald-400 flex-shrink-0" />}
                  {op.status === 'failed' && <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0" />}
                  <div className="flex flex-col min-w-0">
                    <span className="text-sm text-zinc-300 font-medium">{label}</span>
                    <span className="text-xs text-zinc-500 truncate">{progress}</span>
                  </div>
                  {op.status !== 'running' && (
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button variant="ghost" size="icon" onClick={() => dismiss(op.id)} className="h-7 w-7">
                            <X className="w-4 h-4" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Dismiss</TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  )}
                </div>
              );
            })}
            {visibleOps.length > 3 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => navigate('/operations')}
                className="h-7 px-3 text-xs text-zinc-400 hover:text-zinc-200"
              >
                +{visibleOps.length - 3} more
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function formatOpType(type: string): string {
  return humanize(type, 'operations');
}

function formatProgress(event: any): string {
  if (event.step === 'backup') return `Backing up ${event.plugin || ''}…`;
  if (event.step === 'install') return event.status === 'done' ? `Installed ${event.plugin}` : `Installing ${event.plugin}…`;
  if (event.step === 'restart') return event.status === 'healthy' ? `${event.instance} ✓` : `Restarting ${event.instance}…`;
  if (event.step === 'rollback') return 'Rolling back…';
  if (event.step === 'completed') return 'Done';
  if (event.step === 'failed') return `Failed: ${event.error || 'unknown'}`;
  if (event.step === 'upgrading') return `Upgrading ${event.instance}…`;
  if (event.step === 'waiting_healthy') return `Waiting for ${event.instance}…`;
  if (event.step === 'draining') return 'Draining tasks…';
  if (event.step === 'reloading') return 'Reloading…';
  if (event.completedAt) {
    const ago = Math.floor((Date.now() - new Date(event.completedAt).getTime()) / 1000);
    return ago < 5 ? 'Just now' : `${ago}s ago`;
  }
  return event.step || '';
}
