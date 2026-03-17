import { useState, useEffect, useCallback } from 'react';
import { apiFetch } from '../hooks/useApi';
import { useSSEAll } from '../providers/SSEProvider';
import { PageHeader } from '../components/PageHeader';
import {
  StatusBadge,
  ProgressBar,
  MutationsList,
  InstanceOpRow,
  ChangesetActions,
  ImpactBadge,
  AffectedResourcesList,
  relativeTime,
} from '../components/changeset';
import type { Changeset } from '@coderage-labs/armada-shared';
import {
  GitBranch,
  ChevronDown,
  ChevronRight,
  XCircle,
  User,
  Clock,
} from 'lucide-react';
import { RowSkeleton } from '../components/ui/skeleton';
import { EmptyState } from '../components/EmptyState';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select';
import { Table, TableHeader, TableBody, TableHead, TableRow, TableCell } from '../components/ui/table';

/* ── Changeset Row ────────────────────────────────────────────────── */

function ChangesetRow({ cs, onRefresh }: { cs: Changeset; onRefresh: () => void }) {
  const [expanded, setExpanded] = useState(cs.status === 'applying');

  // Auto-expand when changeset starts applying
  useEffect(() => {
    if (cs.status === 'applying') setExpanded(true);
  }, [cs.status]);

  // Compute progress for applying changesets
  let progressPct = 0;
  if (cs.status === 'applying' && cs.plan?.instanceOps) {
    const allSteps = cs.plan.instanceOps.flatMap(op => op.steps);
    const done = allSteps.filter(
      s => s.status === 'completed' || s.status === 'skipped' || s.status === 'failed',
    ).length;
    progressPct = allSteps.length > 0 ? Math.round((done / allSteps.length) * 100) : 0;
  } else if (cs.status === 'completed') {
    progressPct = 100;
  }

  const totalInstances = cs.plan?.instanceOps?.length ?? cs.plan?.totalInstances ?? 0;
  const totalChanges = cs.plan?.totalChanges ?? cs.changes.length;
  const totalRestarts = cs.plan?.totalRestarts ?? 0;

  const rowClass = [
    'border-b border-zinc-800/50 hover:bg-zinc-800/40 transition-colors cursor-pointer',
    cs.status === 'applying' ? 'bg-violet-500/[0.03]' : '',
  ].join(' ');

  return (
    <>
      <TableRow onClick={() => setExpanded(!expanded)} className={rowClass}>
        {/* Expand chevron */}
        <TableCell className="w-8 text-zinc-500">
          {expanded
            ? <ChevronDown className="w-3.5 h-3.5" />
            : <ChevronRight className="w-3.5 h-3.5" />
          }
        </TableCell>

        {/* ID */}
        <TableCell>
          <span className="text-sm font-mono font-semibold text-zinc-100">
            #{cs.id.slice(0, 8)}
          </span>
        </TableCell>

        {/* Status */}
        <TableCell>
          <StatusBadge status={cs.status} />
        </TableCell>

        {/* Summary: impact badge + changes / instances / restarts */}
        <TableCell className="hidden sm:table-cell">
          <div className="flex items-center gap-3 flex-wrap">
            {/* Impact badge (#83) */}
            {cs.impactLevel && (
              <ImpactBadge
                impactLevel={cs.impactLevel}
                requiresRestart={cs.requiresRestart}
                compact
              />
            )}
            {totalChanges > 0 && (
              <span className="text-xs">
                <span className="text-zinc-300">{totalChanges}</span>{' '}
                <span className="text-zinc-500">change{totalChanges !== 1 ? 's' : ''}</span>
              </span>
            )}
            {totalInstances > 0 && (
              <span className="text-xs">
                <span className="text-zinc-300">{totalInstances}</span>{' '}
                <span className="text-zinc-500">instance{totalInstances !== 1 ? 's' : ''}</span>
              </span>
            )}
            {totalRestarts > 0 && (
              <span className="text-xs text-amber-500">
                {totalRestarts} restart{totalRestarts !== 1 ? 's' : ''}
              </span>
            )}
            {totalChanges === 0 && totalInstances === 0 && !cs.impactLevel && (
              <span className="text-xs text-zinc-600">—</span>
            )}
          </div>
        </TableCell>

        {/* Progress inline (applying / completed) */}
        <TableCell className="hidden md:table-cell w-36">
          {(cs.status === 'applying' || cs.status === 'completed') && (
            <div className="space-y-1">
              <ProgressBar pct={progressPct} />
              <span className="text-[10px] text-zinc-600">{progressPct}%</span>
            </div>
          )}
        </TableCell>

        {/* Created */}
        <TableCell className="hidden lg:table-cell">
          <div className="flex flex-col gap-0.5">
            {cs.createdBy && (
              <span className="flex items-center gap-1 text-[11px] text-zinc-500">
                <User className="w-3 h-3" />
                {cs.createdBy}
              </span>
            )}
            <span className="flex items-center gap-1 text-[11px] text-zinc-600">
              <Clock className="w-3 h-3" />
              {relativeTime(cs.createdAt)}
            </span>
          </div>
        </TableCell>

        {/* Actions — stop propagation so clicks don't toggle expand */}
        <TableCell onClick={e => e.stopPropagation()}>
          {(cs.status === 'draft' || cs.status === 'approved' || cs.status === 'failed') && (
            <ChangesetActions cs={cs} onRefresh={onRefresh} />
          )}
        </TableCell>
      </TableRow>

      {/* Expanded detail row */}
      {expanded && (
        <TableRow className="border-b border-zinc-800/50 bg-zinc-900/30">
          <TableCell colSpan={7} className="px-6 py-4">
            <div className="space-y-4">
              {/* Progress bar detail */}
              {(cs.status === 'applying' || cs.status === 'completed') && (
                <div>
                  <div className="flex justify-between text-[10px] text-zinc-600 mb-1.5">
                    <span>{cs.status === 'applying' ? 'Applying…' : 'Completed'}</span>
                    <span>{progressPct}%</span>
                  </div>
                  <ProgressBar pct={progressPct} />
                </div>
              )}

              {/* Error */}
              {cs.status === 'failed' && cs.error && (
                <div className="flex items-start gap-2 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2">
                  <XCircle className="w-3.5 h-3.5 text-red-400 shrink-0 mt-0.5" />
                  <p className="text-xs text-red-400">{cs.error}</p>
                </div>
              )}

              {/* Impact analysis (#83) */}
              {cs.impactLevel && (cs.status === 'draft' || cs.status === 'approved') && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <div className="text-[10px] text-zinc-500 uppercase tracking-wider">Impact</div>
                    <ImpactBadge impactLevel={cs.impactLevel} requiresRestart={cs.requiresRestart} />
                    {cs.impactLevel === 'none' && (
                      <span className="text-[11px] text-emerald-500/80">Auto-applying…</span>
                    )}
                  </div>
                  {cs.affectedResources && cs.affectedResources.length > 0 && (
                    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 px-3 py-2">
                      <AffectedResourcesList
                        resources={cs.affectedResources}
                        requiresRestart={cs.requiresRestart}
                      />
                    </div>
                  )}
                </div>
              )}

              {/* Pending mutations diff (draft / approved) */}
              {(cs.status === 'draft' || cs.status === 'approved') && (
                <div className="space-y-2">
                  <div className="text-[10px] text-zinc-500 uppercase tracking-wider">
                    Pending Changes
                  </div>
                  <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 px-3 py-2">
                    <MutationsList changesetId={cs.id} />
                  </div>
                </div>
              )}

              {/* Instance operations */}
              {cs.plan?.instanceOps && (
                <div className="space-y-3">
                  <div className="text-[10px] text-zinc-500 uppercase tracking-wider">
                    Instance Operations
                  </div>
                  {cs.plan.instanceOps.map(op => (
                    <InstanceOpRow key={op.instanceId} op={op} />
                  ))}
                  {cs.plan.order && (
                    <p className="text-[10px] text-zinc-600">
                      Order: <span className="text-zinc-500">{cs.plan.order}</span>
                      {cs.plan.concurrency > 1 && ` · Concurrency: ${cs.plan.concurrency}`}
                      {cs.plan.estimatedDuration > 0 && ` · Est. ${cs.plan.estimatedDuration}s`}
                    </p>
                  )}
                </div>
              )}
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

/* ── Main Page ────────────────────────────────────────────────────── */

export default function Changesets() {
  const [changesets, setChangesets] = useState<Changeset[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>('all');

  const load = useCallback(async () => {
    try {
      const data = await apiFetch<Changeset[]>('/api/changesets?limit=50');
      setChangesets(data);
    } catch {
      setChangesets([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // SSE: live updates for changeset and operation events
  useSSEAll(useCallback((type: string) => {
    if (type.startsWith('operation.') || type.startsWith('changeset.') || type.startsWith('mutation.') || type.startsWith('draft.')) {
      load();
    }
  }, [load]));

  const activeCount = changesets.filter(
    cs => cs.status === 'applying' || cs.status === 'approved',
  ).length;
  const draftCount = changesets.filter(cs => cs.status === 'draft').length;

  const filtered = changesets.filter(cs => {
    if (statusFilter === 'all') return true;
    if (statusFilter === 'active') return cs.status === 'applying' || cs.status === 'approved';
    if (statusFilter === 'draft') return cs.status === 'draft';
    if (statusFilter === 'history') {
      return (
        cs.status === 'completed' ||
        cs.status === 'failed' ||
        cs.status === 'rolled_back' ||
        cs.status === 'cancelled'
      );
    }
    return true;
  });

  return (
    <div className="space-y-6 max-w-5xl">
      <PageHeader
        icon={GitBranch}
        title="Changesets"
        subtitle="Declarative config changes across Armada instances"
      />

      {/* Filters */}
      <div className="flex items-center gap-3">
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-44 h-9 text-sm rounded-lg border border-zinc-800 bg-zinc-900/50 text-zinc-300 focus:border-violet-500">
            <SelectValue placeholder="Filter by status" />
          </SelectTrigger>
          <SelectContent className="bg-zinc-900">
            <SelectItem value="all">All changesets</SelectItem>
            <SelectItem value="active">
              Active{activeCount > 0 ? ` (${activeCount})` : ''}
            </SelectItem>
            <SelectItem value="draft">
              Draft{draftCount > 0 ? ` (${draftCount})` : ''}
            </SelectItem>
            <SelectItem value="history">History</SelectItem>
          </SelectContent>
        </Select>
        <span className="text-xs text-zinc-600">
          {filtered.length} changeset{filtered.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Table */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50">
        <Table>
          <TableHeader>
            <TableRow className="border-b border-zinc-800">
              <TableHead className="w-8" />
              <TableHead className="text-left text-[11px] text-zinc-500 uppercase tracking-wider">
                ID
              </TableHead>
              <TableHead className="text-left text-[11px] text-zinc-500 uppercase tracking-wider">
                Status
              </TableHead>
              <TableHead className="text-left text-[11px] text-zinc-500 uppercase tracking-wider hidden sm:table-cell">
                Changes
              </TableHead>
              <TableHead className="text-left text-[11px] text-zinc-500 uppercase tracking-wider hidden md:table-cell w-36">
                Progress
              </TableHead>
              <TableHead className="text-left text-[11px] text-zinc-500 uppercase tracking-wider hidden lg:table-cell">
                Created
              </TableHead>
              <TableHead className="text-[11px] text-zinc-500 uppercase tracking-wider">
                Actions
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <>
                <RowSkeleton cols={7} />
                <RowSkeleton cols={7} />
                <RowSkeleton cols={7} />
              </>
            ) : filtered.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7}>
                  <EmptyState
                    icon={GitBranch}
                    title="No changesets"
                    description={
                      statusFilter === 'all'
                        ? 'Changesets are created automatically when config changes are detected.'
                        : 'No changesets match the current filter.'
                    }
                  />
                </TableCell>
              </TableRow>
            ) : (
              filtered.map(cs => (
                <ChangesetRow key={cs.id} cs={cs} onRefresh={load} />
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

// Re-export relativeTime for external use if needed
export { relativeTime };
