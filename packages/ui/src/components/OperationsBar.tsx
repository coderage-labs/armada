import { useOperations } from '../contexts/OperationsContext';
import { Loader2, X, CheckCircle2, AlertCircle } from 'lucide-react';
import { Button } from './ui/button';
import { humanize } from '../i18n';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip';

export function OperationsBar() {
  const { operations, activeOps, dismiss } = useOperations();

  // Show recently completed (last 10s) + active
  // Exclude changeset_apply — handled by ChangesetBottomBar
  const recentlyCompleted = operations.filter(
    o => o.type !== 'changeset_apply' &&
    (o.status === 'completed' || o.status === 'failed') &&
    o.completedAt &&
    Date.now() - new Date(o.completedAt).getTime() < 10_000
  );

  const visible = [...activeOps.filter(o => o.type !== 'changeset_apply'), ...recentlyCompleted];
  if (visible.length === 0) return null;

  return (
    <TooltipProvider>
    <div className="fixed bottom-0 left-0 right-0 z-50 border-t border-zinc-700 bg-zinc-950/95">
      <div className="max-w-7xl mx-auto px-6 py-3 space-y-2">
        {visible.map(op => {
          const lastEvent = op.events[op.events.length - 1];
          const label = formatOpType(op.type);
          const progress = lastEvent ? formatProgress(lastEvent) : '';

          return (
            <div key={op.id} className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-3 min-w-0">
                {op.status === 'running' && <Loader2 className="w-4 h-4 text-blue-400 animate-spin flex-shrink-0" />}
                {op.status === 'completed' && <CheckCircle2 className="w-4 h-4 text-emerald-400 flex-shrink-0" />}
                {op.status === 'failed' && <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0" />}
                <span className="text-sm text-zinc-300 font-medium">{label}</span>
                <span className="text-sm text-zinc-500 truncate">{progress}</span>
              </div>
              {op.status !== 'running' && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="icon" onClick={() => dismiss(op.id)} className="h-7 w-7">
                      <X className="w-4 h-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Dismiss</TooltipContent>
                </Tooltip>
              )}
            </div>
          );
        })}
      </div>
    </div>
    </TooltipProvider>
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
  return event.step || '';
}
