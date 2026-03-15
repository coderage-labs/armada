import { humanize } from '../i18n';
/**
 * Shared pipeline visualization for workflow step runs.
 * Supports horizontal (workflow overview) and vertical (single run) layouts.
 */
import { useMemo } from 'react';
import {
  ChevronRight, ChevronDown, Clock, CheckCircle2, XCircle, Pause, SkipForward,
} from 'lucide-react';
import { Button } from './ui/button';

/* ── Types ─────────────────────────────────────────── */

export interface PipelineStep {
  id: string;
  role: string;
  gate?: string;
  waitFor?: string[];
}

export interface PipelineStepRun {
  stepId: string;
  status: string;
  agentName?: string | null;
  output?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
}

interface Props {
  steps: PipelineStep[];
  stepRuns: PipelineStepRun[];
  selectedStepId: string | null;
  onSelectStep: (id: string) => void;
  vertical?: boolean;
}

/* ── Helpers ────────────────────────────────────────── */

function duration(start: string | null | undefined, end: string | null | undefined): string {
  if (!start) return '—';
  const endMs = end ? new Date(end).getTime() : Date.now();
  const diff = endMs - new Date(start).getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

const STEP_STATUS_STYLES: Record<string, string> = {
  pending: 'border-zinc-500/40 bg-zinc-500/10 text-zinc-400',
  running: 'border-blue-500/40 bg-blue-500/10 text-blue-300',
  completed: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300',
  failed: 'border-red-500/40 bg-red-500/10 text-red-300',
  waiting_gate: 'border-yellow-500/40 bg-yellow-500/10 text-yellow-300',
  skipped: 'border-purple-500/40 bg-purple-500/10 text-purple-300',
};

const STEP_STATUS_ICON: Record<string, typeof CheckCircle2> = {
  completed: CheckCircle2,
  failed: XCircle,
  waiting_gate: Pause,
  skipped: SkipForward,
};

/* ── Component ─────────────────────────────────────── */

export default function PipelineView({ steps, stepRuns, selectedStepId, onSelectStep, vertical }: Props) {
  const stepRunMap = useMemo(() => {
    const m = new Map<string, PipelineStepRun>();
    for (const sr of stepRuns) m.set(sr.stepId, sr);
    return m;
  }, [stepRuns]);

  // Compute layers: if any step has waitFor, use dependency graph; otherwise treat as sequential
  const layers = useMemo(() => {
    const hasAnyDeps = steps.some(s => s.waitFor && s.waitFor.length > 0);

    if (!hasAnyDeps) {
      // No dependencies defined — each step is its own sequential layer
      return steps.map(s => [s]);
    }

    // Dependency-based layering
    const layerMap = new Map<string, number>();
    const resolved = new Set<string>();

    function resolveLayer(step: PipelineStep): number {
      if (layerMap.has(step.id)) return layerMap.get(step.id)!;
      if (!step.waitFor || step.waitFor.length === 0) {
        layerMap.set(step.id, 0);
        resolved.add(step.id);
        return 0;
      }
      let maxDep = 0;
      for (const depId of step.waitFor) {
        const dep = steps.find((s) => s.id === depId);
        if (dep && !resolved.has(depId)) {
          maxDep = Math.max(maxDep, resolveLayer(dep) + 1);
        } else if (layerMap.has(depId)) {
          maxDep = Math.max(maxDep, layerMap.get(depId)! + 1);
        }
      }
      layerMap.set(step.id, maxDep);
      resolved.add(step.id);
      return maxDep;
    }

    for (const s of steps) resolveLayer(s);

    const result: PipelineStep[][] = [];
    for (const s of steps) {
      const layer = layerMap.get(s.id) || 0;
      if (!result[layer]) result[layer] = [];
      result[layer].push(s);
    }
    return result;
  }, [steps]);

  if (steps.length === 0) {
    return <div className="text-center py-8 text-zinc-600 text-sm">No steps defined</div>;
  }

  function renderCard(step: PipelineStep, opts?: { fullWidth?: boolean }) {
    const sr = stepRunMap.get(step.id);
    const status = sr?.status || 'pending';
    const isSelected = selectedStepId === step.id;
    const StatusIcon = STEP_STATUS_ICON[status] || Clock;
    const dur = sr?.startedAt ? duration(sr.startedAt, sr.completedAt) : null;
    const outputPreview = sr?.output
      ? sr.output.length > 80 ? sr.output.slice(0, 80) + '…' : sr.output
      : null;

    return (
      <Button
        key={step.id}
        variant="ghost"
        onClick={() => onSelectStep(step.id)}
        className={`relative rounded-xl border-2 p-3 text-left transition-all h-auto justify-start flex-col items-start whitespace-normal ${
          opts?.fullWidth ? 'w-full' : 'min-w-[160px] max-w-[220px] flex-1'
        } ${STEP_STATUS_STYLES[status] || STEP_STATUS_STYLES.pending} ${
          isSelected ? 'ring-2 ring-violet-500/50' : ''
        }`}
      >
        <div className="flex items-center gap-1.5 mb-1">
          <StatusIcon className="w-3.5 h-3.5 shrink-0" />
          <span className="text-xs font-semibold truncate">{humanize(step.id, 'steps')}</span>
          {step.role && <span className="text-[10px] opacity-60">{step.role}</span>}
          {dur && <span className="text-[9px] opacity-50 ml-auto">{dur}</span>}
        </div>
        <div className="flex items-center gap-2 text-[10px]">
          {sr?.agentName && <span className="opacity-50">{sr.agentName}</span>}
          {outputPreview && <span className="opacity-40 truncate flex-1">{outputPreview}</span>}
        </div>
        {step.gate === 'manual' && (
          <span className="absolute -top-1.5 -right-1.5 text-[9px] px-1 py-0.5 rounded bg-yellow-500/30 text-yellow-300 border border-yellow-500/30">
            gate
          </span>
        )}
      </Button>
    );
  }

  if (vertical) {
    const allSteps = layers.flat();
    return (
      <div className="p-1 space-y-0">
        {allSteps.map((step, idx) => (
          <div key={step.id}>
            {idx > 0 && (
              <div className="flex justify-center py-1">
                <ChevronDown className="w-4 h-4 text-zinc-600" />
              </div>
            )}
            {renderCard(step, { fullWidth: true })}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="overflow-x-auto pb-2 px-1 pt-1">
      <div className="flex items-stretch gap-0 min-w-max">
        {layers.map((layer, layerIdx) => (
          <div key={layerIdx} className="flex items-stretch">
            {layerIdx > 0 && (
              <div className="flex items-center">
                <ChevronRight className="w-5 h-5 text-zinc-600 mx-2 shrink-0" />
              </div>
            )}
            <div className="flex flex-col gap-2 items-stretch h-full">
              {layer.map((step) => renderCard(step))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
