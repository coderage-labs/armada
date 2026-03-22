import { useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../hooks/useApi';
import { useSSEEvent } from '../providers/SSEProvider';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from './ui/table';

/* ── Types ─────────────────────────────────────────── */

interface ReworkEntry {
  requestedBy: { stepId: string; agent: string };
  targetStepId: string;
  feedback: string;
  iteration: number;
  requestedAt: string;
  resolvedAt: string | null;
}

interface RunContext {
  workflow: { id: string; name: string; status: string };
  steps: unknown[];
  reworks: ReworkEntry[];
}

/* ── Helpers ───────────────────────────────────────── */

function relativeTime(dateStr: string | null): string {
  if (!dateStr) return '—';
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/* ── Component ──────────────────────────────────────── */

export interface ReworkHistoryProps {
  runId: string;
}

export default function ReworkHistory({ runId }: ReworkHistoryProps) {
  const {
    data,
    isLoading,
    isError,
    refetch,
  } = useQuery<RunContext>({
    queryKey: ['workflow-run-context', runId],
    queryFn: () => apiFetch<RunContext>(`/api/workflows/runs/${runId}/context`),
    refetchInterval: false,
  });

  const handleRefetch = useCallback(() => { refetch(); }, [refetch]);
  useSSEEvent('workflow.rework.requested', handleRefetch);
  useSSEEvent('workflow.rework.resolved', handleRefetch);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <span className="text-zinc-500 text-sm animate-pulse">Loading rework history…</span>
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="text-center py-8 text-zinc-500 text-sm">
        Failed to load rework history.
      </div>
    );
  }

  const { reworks } = data;

  if (reworks.length === 0) {
    return (
      <div className="text-center py-8 text-zinc-600 text-sm">
        No rework requests for this run.
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-zinc-800 overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow className="border-zinc-800 hover:bg-transparent">
            <TableHead className="text-zinc-500 text-[11px] uppercase tracking-wider">Requested By</TableHead>
            <TableHead className="text-zinc-500 text-[11px] uppercase tracking-wider">Target Step</TableHead>
            <TableHead className="text-zinc-500 text-[11px] uppercase tracking-wider">Feedback</TableHead>
            <TableHead className="text-zinc-500 text-[11px] uppercase tracking-wider">Status</TableHead>
            <TableHead className="text-zinc-500 text-[11px] uppercase tracking-wider text-right">Time</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {reworks.map((r, idx) => (
            <TableRow key={idx} className="border-zinc-800 hover:bg-zinc-800/30">
              <TableCell className="text-sm text-zinc-300 font-mono">
                <div>{r.requestedBy.agent}</div>
                <div className="text-[10px] text-zinc-600">({r.requestedBy.stepId})</div>
              </TableCell>
              <TableCell className="text-sm text-zinc-400 font-mono">
                {r.targetStepId}
                {r.iteration > 0 && (
                  <span className="ml-1 text-[10px] text-zinc-600">·&nbsp;iter {r.iteration + 1}</span>
                )}
              </TableCell>
              <TableCell className="text-sm text-zinc-400 max-w-[300px]">
                <span title={r.feedback} className="line-clamp-2">
                  {r.feedback}
                </span>
              </TableCell>
              <TableCell>
                {r.resolvedAt ? (
                  <span className="inline-flex items-center gap-1 text-xs text-emerald-400 font-medium">
                    Resolved ✓
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-xs text-amber-400 animate-pulse">
                    Pending…
                  </span>
                )}
              </TableCell>
              <TableCell className="text-xs text-zinc-500 text-right whitespace-nowrap">
                {relativeTime(r.requestedAt)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
