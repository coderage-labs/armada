import { Clock, User } from 'lucide-react';
import { StatusBadge } from './StatusBadge';
import type { Changeset } from '@coderage-labs/armada-shared';

export function relativeTime(dateStr: string | null | undefined): string {
  if (!dateStr) return '—';
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

interface ChangesetSummaryProps {
  cs: Changeset;
  /** Show created-by field (hidden on small screens by default) */
  showCreatedBy?: boolean;
}

export function ChangesetSummary({ cs, showCreatedBy = true }: ChangesetSummaryProps) {
  const totalInstances = cs.plan?.instanceOps?.length ?? cs.plan?.totalInstances ?? 0;
  const totalChanges = cs.plan?.totalChanges ?? cs.changes.length;
  const totalRestarts = cs.plan?.totalRestarts ?? 0;

  return (
    <div className="flex items-center gap-2 flex-wrap min-w-0">
      <span className="text-sm font-semibold text-zinc-100 font-mono">
        #{cs.id.slice(0, 8)}
      </span>
      <StatusBadge status={cs.status} />
      {totalInstances > 0 && (
        <span className="text-[10px] text-zinc-500">
          {totalInstances} instance{totalInstances !== 1 ? 's' : ''}
        </span>
      )}
      {totalChanges > 0 && (
        <span className="text-[10px] text-zinc-500">
          {totalChanges} change{totalChanges !== 1 ? 's' : ''}
        </span>
      )}
      {totalRestarts > 0 && (
        <span className="text-[10px] text-amber-600">
          {totalRestarts} restart{totalRestarts !== 1 ? 's' : ''}
        </span>
      )}
      {showCreatedBy && cs.createdBy && (
        <span className="hidden sm:flex items-center gap-1 text-[11px] text-zinc-500">
          <User className="w-3 h-3" />
          {cs.createdBy}
        </span>
      )}
      <span className="flex items-center gap-1 text-[11px] text-zinc-500">
        <Clock className="w-3 h-3" />
        {relativeTime(cs.createdAt)}
      </span>
    </div>
  );
}

/** Compact one-liner for the bottom bar collapsed state */
export function ChangesetSummaryLine({ cs }: { cs: Changeset }) {
  const totalInstances = cs.plan?.instanceOps?.length ?? cs.plan?.totalInstances ?? 0;
  const totalChanges = cs.plan?.totalChanges ?? cs.changes.length;
  const totalRestarts = cs.plan?.totalRestarts ?? 0;

  const parts: string[] = [];
  if (totalChanges > 0) parts.push(`${totalChanges} change${totalChanges !== 1 ? 's' : ''}`);
  if (totalRestarts > 0) parts.push(`${totalRestarts} restart${totalRestarts !== 1 ? 's' : ''}`);
  if (totalInstances > 0) parts.push(`${totalInstances} instance${totalInstances !== 1 ? 's' : ''}`);

  return (
    <span className="text-xs text-zinc-400">{parts.join(' · ') || 'No changes'}</span>
  );
}
