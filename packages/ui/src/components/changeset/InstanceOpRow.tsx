import { StepTimeline } from '../StepTimeline';
import type { OperationStep } from '@coderage-labs/armada-shared';

const CHANGE_TYPE_STYLES: Record<string, string> = {
  config:  'bg-blue-500/10 text-blue-400',
  image:   'bg-purple-500/10 text-purple-400',
  plugin:  'bg-emerald-500/10 text-emerald-400',
  env:     'bg-amber-500/10 text-amber-400',
  model:   'bg-cyan-500/10 text-cyan-400',
};

export interface InstanceOp {
  instanceId: string;
  instanceName: string;
  changes: Array<{ type: string; field: string; current: any; desired: any }>;
  steps: OperationStep[];
  estimatedDowntime: number;
}

export function InstanceOpRow({ op }: { op: InstanceOp }) {
  const totalSteps = op.steps.length;
  const doneSteps = op.steps.filter(s => s.status === 'completed' || s.status === 'skipped').length;
  const runningStep = op.steps.find(s => s.status === 'running');
  const failedStep = op.steps.find(s => s.status === 'failed');
  const isIdle = !runningStep && !failedStep && doneSteps < totalSteps;

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-3 space-y-2">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <span className="text-sm font-medium text-zinc-200">{op.instanceName}</span>
          <span className="ml-2 text-[10px] text-zinc-600 font-mono">{op.instanceId.slice(0, 8)}</span>
        </div>
        <span className="text-[10px] text-zinc-500">
          {totalSteps > 0 ? (
            isIdle ? 'queued' : `${doneSteps}/${totalSteps} steps`
          ) : null}
        </span>
      </div>

      {/* Changes */}
      <div className="flex flex-wrap gap-1">
        {op.changes.map((c, i) => (
          <span
            key={i}
            className={`text-[10px] px-1.5 py-0.5 rounded ${CHANGE_TYPE_STYLES[c.type] ?? 'bg-zinc-700 text-zinc-400'}`}
          >
            {c.type}: {c.field}
          </span>
        ))}
      </div>

      {/* Steps */}
      {op.steps.length > 0 && <StepTimeline steps={op.steps} compact showProgress />}

      {isIdle && op.steps.length === 0 && (
        <p className="text-[11px] text-zinc-600">⏳ Waiting…</p>
      )}
    </div>
  );
}
