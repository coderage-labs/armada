import { humanize } from '../i18n';
import { useState, useEffect, useCallback } from 'react';
import { Check, X, Minus, Loader2, Clock } from 'lucide-react';
import type { OperationStep } from '@coderage-labs/armada-shared';
import { useSSEAll } from '../providers/SSEProvider';

interface StepTimelineProps {
  steps: OperationStep[];
  compact?: boolean;
  /** When true, subscribe to operation.progress SSE events and show live progress detail */
  showProgress?: boolean;
}

interface StepProgress {
  message: string;
  detail?: string;
}

function stepDuration(step: OperationStep): string | null {
  if (!step.startedAt) return null;
  const end = step.completedAt ? new Date(step.completedAt).getTime() : Date.now();
  const ms = end - new Date(step.startedAt).getTime();
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  return `${mins}m ${secs % 60}s`;
}

function StepIcon({ status }: { status: OperationStep['status'] }) {
  switch (status) {
    case 'completed':
      return <Check className="w-3.5 h-3.5 text-green-400" />;
    case 'running':
      return <Loader2 className="w-3.5 h-3.5 text-violet-400 animate-spin" />;
    case 'failed':
      return <X className="w-3.5 h-3.5 text-red-400" />;
    case 'skipped':
      return <Minus className="w-3.5 h-3.5 text-zinc-600" />;
    default:
      return <span className="w-3.5 h-3.5 rounded-full border border-zinc-600 inline-block" />;
  }
}

function stepIconBg(status: OperationStep['status']): string {
  switch (status) {
    case 'completed': return 'bg-green-500/10 border-green-500/30';
    case 'running':   return 'bg-violet-500/10 border-violet-500/30';
    case 'failed':    return 'bg-red-500/10 border-red-500/30';
    case 'skipped':   return 'bg-zinc-800 border-zinc-700';
    default:          return 'bg-zinc-800/50 border-zinc-700/50';
  }
}

function stepNameColor(status: OperationStep['status']): string {
  switch (status) {
    case 'completed': return 'text-zinc-300';
    case 'running':   return 'text-violet-300';
    case 'failed':    return 'text-red-300';
    case 'skipped':   return 'text-zinc-600';
    default:          return 'text-zinc-500';
  }
}

function LiveStepDuration({ step }: { step: OperationStep }) {
  const [, tick] = useState(0);
  const isRunning = step.status === 'running' && step.startedAt && !step.completedAt;

  useEffect(() => {
    if (!isRunning) return;
    const interval = setInterval(() => tick(n => n + 1), 1000);
    return () => clearInterval(interval);
  }, [isRunning]);

  const dur = stepDuration(step);
  if (!dur) return null;

  return (
    <span className="flex-shrink-0 flex items-center gap-1 text-[10px] text-zinc-600 font-mono">
      <Clock className="w-3 h-3" />
      {dur}
    </span>
  );
}

export function StepTimeline({ steps, compact = false, showProgress = false }: StepTimelineProps) {
  // Map of step name → latest progress message from SSE operation.progress events
  const [stepProgress, setStepProgress] = useState<Map<string, StepProgress>>(new Map());

  const hasRunning = steps.some(s => s.status === 'running');

  const handleEvent = useCallback((event: string, data: any) => {
    if (event !== 'operation.progress') return;
    const stepName: string | undefined = data?.step;
    if (!stepName) return;
    setStepProgress(prev => {
      const next = new Map(prev);
      next.set(stepName, {
        message: data.message ?? '',
        detail: data.detail,
      });
      return next;
    });
  }, []);

  // Subscribe when showing progress and there's a running step; unsubscribe otherwise
  useSSEAll(useCallback((type: string, data: any) => {
    if (showProgress && hasRunning && type.startsWith('operation.')) {
      handleEvent(type, data);
    }
  }, [showProgress, hasRunning, handleEvent]));

  if (!steps || steps.length === 0) return null;

  return (
    <div className="space-y-1.5">
      {steps.map((step, idx) => {
        const isLast = idx === steps.length - 1;

        return (
          <div key={step.id} className="relative flex gap-2.5">
            {/* Connector line */}
            {!isLast && (
              <div className="absolute left-[13px] top-6 bottom-0 w-px bg-zinc-800" />
            )}

            {/* Icon */}
            <div
              className={`relative z-10 flex-shrink-0 w-7 h-7 rounded-full border flex items-center justify-center ${stepIconBg(step.status)}`}
            >
              <StepIcon status={step.status} />
            </div>

            {/* Content */}
            <div className="flex-1 min-w-0 pb-1">
              <div className="flex items-center justify-between gap-2">
                <span className={`text-xs font-medium truncate ${stepNameColor(step.status)}`}>
                  {humanize(step.name, 'steps')}
                </span>
                <LiveStepDuration step={step} />
              </div>
              {step.error && (
                <p className="text-[10px] text-red-400 mt-0.5 leading-relaxed">
                  {step.error}
                </p>
              )}
              {step.status === 'running' && showProgress && stepProgress.has(step.name) && (() => {
                const p = stepProgress.get(step.name)!;
                return (
                  <p className="text-[10px] text-zinc-500 mt-0.5 leading-relaxed truncate">
                    {p.message}{p.detail ? <span className="ml-1 font-mono text-zinc-600">{p.detail}</span> : null}
                  </p>
                );
              })()}
              {!compact && step.metadata && Object.keys(step.metadata).length > 0 && step.status === 'running' && (
                <div className="flex flex-wrap gap-1 mt-1">
                  {Object.entries(step.metadata).slice(0, 3).map(([k, v]) => (
                    <span key={k} className="text-[9px] px-1.5 py-0.5 rounded bg-zinc-800/50 text-zinc-500 font-mono">
                      {k}: {String(v)}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
