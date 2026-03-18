import { useState, useEffect } from 'react';
import { ChevronUp, ChevronDown, XCircle } from 'lucide-react';
import { Button } from './ui/button';
import { useActiveChangeset } from '../hooks/queries/useChangesets';
import { StatusBadge } from './changeset/StatusBadge';
import { ChangesetSummaryLine } from './changeset/ChangesetSummary';
import { ChangesetActions } from './changeset/ChangesetActions';
import { MutationsList } from './changeset/MutationsList';
import { InstanceOpRow } from './changeset/InstanceOpRow';
import { ProgressBar } from './changeset/ProgressBar';
import type { Changeset } from '@coderage-labs/armada-shared';

const ACTIVE_STATUSES: Changeset['status'][] = ['draft', 'approved', 'applying', 'failed'];

export function ChangesetBottomBar() {
  const { data: changeset, refetch } = useActiveChangeset();
  const [expanded, setExpanded] = useState(false);
  const [dismissedId, setDismissedId] = useState<string | null>(null);

  // Auto-dismiss completed changesets after 5 seconds (failed ones stay — user must retry or dismiss)
  useEffect(() => {
    if (!changeset) return;
    if (changeset.status === 'completed') {
      const timer = setTimeout(() => setDismissedId(changeset.id), 5000);
      return () => clearTimeout(timer);
    }
  }, [changeset?.id, changeset?.status]);

  // Track which changesets we saw transition to a terminal state (don't show stale completed ones on page load)
  const [seenActiveIds, setSeenActiveIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (changeset && ACTIVE_STATUSES.includes(changeset.status)) {
      setSeenActiveIds(prev => {
        if (prev.has(changeset.id)) return prev;
        return new Set(prev).add(changeset.id);
      });
    }
  }, [changeset?.id, changeset?.status]);

  if (!changeset) return null;
  if (!ACTIVE_STATUSES.includes(changeset.status) && changeset.id === dismissedId) return null;
  // Only show completed/failed changesets if we saw them while they were active
  if (!ACTIVE_STATUSES.includes(changeset.status) && !seenActiveIds.has(changeset.id)) return null;
  if (!ACTIVE_STATUSES.includes(changeset.status) && changeset.status !== 'completed' && changeset.status !== 'failed') return null;

  const isApplying = changeset.status === 'applying';

  // Progress for applying changesets
  let progressPct = 0;
  if (isApplying && changeset.plan?.instanceOps) {
    const allSteps = changeset.plan.instanceOps.flatMap(op => op.steps);
    const done = allSteps.filter(s =>
      s.status === 'completed' || s.status === 'skipped' || s.status === 'failed',
    ).length;
    progressPct = allSteps.length > 0 ? Math.round((done / allSteps.length) * 100) : 0;
  }

  return (
    <div className="fixed bottom-0 left-0 right-0 z-50 flex flex-col" style={{ marginLeft: 0 }}>
      {/* Expanded panel */}
      <div
        className={`transition-all duration-300 overflow-hidden bg-zinc-950 border-t border-zinc-700 ${
          expanded ? 'max-h-[60vh]' : 'max-h-0'
        }`}
      >
        <div className="overflow-y-auto max-h-[60vh] px-4 py-3 space-y-4">
          {(changeset.status === 'draft' || changeset.status === 'approved') && (
            <div className="space-y-2">
              <div className="text-[10px] text-zinc-500 uppercase tracking-wider">Pending Changes</div>
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 px-3 py-2">
                <MutationsList changesetId={changeset.id} />
              </div>
            </div>
          )}

          {changeset.plan?.instanceOps && changeset.plan.instanceOps.length > 0 && (
            <div className="space-y-3">
              <div className="text-[10px] text-zinc-500 uppercase tracking-wider">Instance Operations</div>
              {changeset.plan.instanceOps.map(op => (
                <InstanceOpRow key={op.instanceId} op={op} />
              ))}
            </div>
          )}

          {changeset.status === 'failed' && changeset.error && (
            <div className="flex items-start gap-2 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2">
              <XCircle className="w-3.5 h-3.5 text-red-400 shrink-0 mt-0.5" />
              <p className="text-xs text-red-400">{changeset.error}</p>
            </div>
          )}
        </div>
      </div>

      {/* Progress bar */}
      {isApplying && (
        <div className="bg-zinc-950 px-4 pt-1.5">
          <div className="flex justify-between text-[10px] text-zinc-400 mb-1">
            <span>Applying…</span>
            <span>{progressPct}%</span>
          </div>
          <ProgressBar pct={progressPct} />
        </div>
      )}

      {/* Bottom bar */}
      <div className="bg-zinc-950 border-t border-zinc-700 px-4 py-2.5">
        <div className="flex items-center gap-3 flex-wrap sm:flex-nowrap">
          <div className="flex items-center gap-2 flex-1 min-w-0 flex-wrap">
            <StatusBadge status={changeset.status} />
            <ChangesetSummaryLine cs={changeset} />
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <ChangesetActions cs={changeset} onRefresh={() => refetch()} stopPropagation={false} />
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => setExpanded(e => !e)}
              aria-label={expanded ? 'Collapse changeset bar' : 'Expand changeset bar'}
            >
              {expanded
                ? <ChevronDown className="w-4 h-4" />
                : <ChevronUp className="w-4 h-4" />
              }
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
