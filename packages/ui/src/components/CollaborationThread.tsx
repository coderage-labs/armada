import { useState, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../hooks/useApi';
import { useSSEEvent } from '../providers/SSEProvider';
import { Card, CardContent } from './ui/card';
import { Badge } from './ui/badge';

/* ── Types ─────────────────────────────────────────── */

interface ContextStep {
  id: string;
  name: string;
  role: string;
  agent: string | null;
  status: string;
  output: string | null;
  completedAt: string | null;
  iteration: number;
}

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
  steps: ContextStep[];
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

const AGENT_COLORS = [
  'bg-violet-500',
  'bg-blue-500',
  'bg-emerald-500',
  'bg-pink-500',
  'bg-amber-500',
  'bg-cyan-500',
  'bg-indigo-500',
  'bg-rose-500',
];

function agentColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) & 0xffff;
  return AGENT_COLORS[hash % AGENT_COLORS.length];
}

const ROLE_BADGE_STYLES: Record<string, string> = {
  development:  'bg-violet-500/20 text-violet-300 border-violet-500/30',
  design:       'bg-pink-500/20 text-pink-300 border-pink-500/30',
  analysis:     'bg-blue-500/20 text-blue-300 border-blue-500/30',
  review:       'bg-amber-500/20 text-amber-300 border-amber-500/30',
  testing:      'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
  planning:     'bg-cyan-500/20 text-cyan-300 border-cyan-500/30',
};

function roleBadgeStyle(role: string): string {
  return ROLE_BADGE_STYLES[role] || 'bg-zinc-700/50 text-zinc-400 border-zinc-600/50';
}

/* ── Agent Avatar ───────────────────────────────────── */

function AgentAvatar({ name }: { name: string }) {
  const initial = name.charAt(0).toUpperCase();
  const color = agentColor(name);
  return (
    <div
      className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold text-white shrink-0 ${color}`}
      title={name}
    >
      {initial}
    </div>
  );
}

/* ── Step Bubble ────────────────────────────────────── */

function StepBubble({
  step,
  isRight,
}: {
  step: ContextStep;
  isRight: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const agentName = step.agent || step.role;
  const output = step.output || '';
  const truncated = output.length > 500 && !expanded;
  const displayOutput = truncated ? output.slice(0, 500) + '…' : output;

  const isRunning = step.status === 'running';
  const isPaused = step.status === 'waiting_for_rework';
  const isCompleted = step.status === 'completed';

  return (
    <div className={`flex items-start gap-3 ${isRight ? 'flex-row-reverse' : 'flex-row'}`}>
      <AgentAvatar name={agentName} />
      <div className={`flex-1 max-w-[80%] ${isRight ? 'items-end' : 'items-start'} flex flex-col gap-1`}>
        {/* Header */}
        <div className={`flex items-center gap-2 ${isRight ? 'flex-row-reverse' : 'flex-row'}`}>
          <span className="text-xs font-medium text-zinc-200">{agentName}</span>
          <Badge className={`text-[10px] px-1.5 py-0 rounded border ${roleBadgeStyle(step.role)}`}>
            {step.role}
          </Badge>
          {isRunning && (
            <span className="flex items-center gap-1 text-[10px] text-purple-400">
              <span className="w-1.5 h-1.5 rounded-full bg-purple-500 animate-pulse" />
              running
            </span>
          )}
          {isPaused && (
            <span className="text-[10px] text-amber-400 border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 rounded">
              ⏸ Paused — waiting for rework
            </span>
          )}
        </div>

        {/* Step name */}
        <div className={`text-[10px] text-zinc-500 uppercase tracking-wider ${isRight ? 'text-right' : 'text-left'}`}>
          {step.name || step.id}
          {step.iteration > 0 && (
            <span className="ml-1 text-zinc-600">·&nbsp;iter {step.iteration + 1}</span>
          )}
        </div>

        {/* Output bubble */}
        <Card className={`w-full border ${
          isRunning
            ? 'border-purple-500/30 bg-purple-500/5'
            : isPaused
            ? 'border-amber-500/30 bg-amber-500/5'
            : isCompleted
            ? 'border-zinc-700/50 bg-zinc-800/40'
            : 'border-zinc-800 bg-zinc-900/50'
        }`}>
          <CardContent className="p-3">
            {output ? (
              <>
                <pre className="text-xs text-zinc-400 font-mono whitespace-pre-wrap break-words leading-relaxed">
                  {displayOutput}
                </pre>
                {output.length > 500 && (
                  <button
                    onClick={() => setExpanded(!expanded)}
                    className="mt-2 text-[10px] text-violet-400 hover:text-violet-300 transition"
                  >
                    {expanded ? '▲ Collapse' : `▼ Show ${output.length - 500} more chars`}
                  </button>
                )}
              </>
            ) : (
              <span className="text-xs text-zinc-600 italic">
                {isRunning ? 'In progress…' : 'No output'}
              </span>
            )}
          </CardContent>
        </Card>

        {/* Timestamp */}
        {step.completedAt && (
          <div className={`text-[10px] text-zinc-600 ${isRight ? 'text-right' : 'text-left'}`}>
            {relativeTime(step.completedAt)}
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Rework Block ───────────────────────────────────── */

function ReworkBlock({ rework }: { rework: ReworkEntry }) {
  return (
    <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 space-y-1.5 mx-8">
      <div className="flex items-center gap-2">
        <span className="text-sm">🔄</span>
        <span className="text-xs font-medium text-amber-300">
          Rework requested by {rework.requestedBy.agent} (step: {rework.requestedBy.stepId})
        </span>
        <span className="ml-auto text-[10px] text-zinc-500">{relativeTime(rework.requestedAt)}</span>
      </div>
      <p className="text-xs text-amber-200/80 pl-5">{rework.feedback}</p>
      <div className="flex items-center gap-1 pl-5">
        {rework.resolvedAt ? (
          <span className="text-[10px] text-emerald-400 font-medium">Resolved ✓</span>
        ) : (
          <span className="text-[10px] text-amber-400 animate-pulse">Pending…</span>
        )}
      </div>
    </div>
  );
}

/* ── Main Component ─────────────────────────────────── */

export interface CollaborationThreadProps {
  runId: string;
}

export default function CollaborationThread({ runId }: CollaborationThreadProps) {
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

  // Stable refetch callback for SSE hooks
  const handleRefetch = useCallback(() => { refetch(); }, [refetch]);
  useSSEEvent('workflow.rework.requested', handleRefetch);
  useSSEEvent('workflow.rework.resolved', handleRefetch);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <span className="text-zinc-500 text-sm animate-pulse">Loading thread…</span>
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="text-center py-8 text-zinc-500 text-sm">
        Failed to load collaboration context.
      </div>
    );
  }

  const { steps, reworks } = data;

  if (steps.length === 0) {
    return (
      <div className="text-center py-8 text-zinc-600 text-sm">
        No steps recorded yet.
      </div>
    );
  }

  // Track unique agents in order for alternating alignment
  const agentOrder: string[] = [];
  for (const step of steps) {
    const name = step.agent || step.role;
    if (!agentOrder.includes(name)) agentOrder.push(name);
  }

  // Build interleaved timeline: steps + reworks sorted by time/iteration
  type TimelineItem =
    | { kind: 'step'; step: ContextStep }
    | { kind: 'rework'; rework: ReworkEntry };

  const timeline: TimelineItem[] = [];

  for (const step of steps) {
    // Insert any reworks that target this step (by targetStepId)
    // and whose iteration matches (show rework after the step it targets)
    const relatedReworks = reworks.filter(
      (r) => r.targetStepId === step.id && r.iteration === step.iteration,
    );
    timeline.push({ kind: 'step', step });
    for (const rework of relatedReworks) {
      timeline.push({ kind: 'rework', rework });
    }
  }

  return (
    <div className="space-y-4 py-2">
      {timeline.map((item, idx) => {
        if (item.kind === 'rework') {
          return <ReworkBlock key={`rework-${idx}`} rework={item.rework} />;
        }
        const agentName = item.step.agent || item.step.role;
        const agentIdx = agentOrder.indexOf(agentName);
        const isRight = agentIdx % 2 === 1;
        return (
          <StepBubble
            key={`step-${item.step.id}-${item.step.iteration}`}
            step={item.step}
            isRight={isRight}
          />
        );
      })}
    </div>
  );
}
