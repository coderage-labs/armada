import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { humanize } from '../i18n';
import { Link } from 'react-router-dom';
import { apiFetch } from '../hooks/useApi';
import { useSSEAll } from '../providers/SSEProvider';
import { useOperations } from '../hooks/useOperations';
import { useOperationStream } from '../hooks/useOperationStream';
import AgentAvatar from '../components/AgentAvatar';
import StepRunModal from '../components/StepRunModal';
import PipelineView from '../components/PipelineView';
import { StepTimeline } from '../components/StepTimeline';
import {
  Activity, ChevronDown, ChevronRight, Clock, Play, RotateCcw,
  MessageSquare, CheckCircle2, XCircle, AlertTriangle, Pause,
  Radio, Zap, Bot, Hash, ExternalLink, Server, Loader2,
} from 'lucide-react';
import { PageHeader } from '../components/PageHeader';
import type { Operation } from '@coderage-labs/armada-shared';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Input } from '../components/ui/input';

/* ── Types ─────────────────────────────────────────── */

interface StepRun {
  id: string;
  run_id: string;
  step_id: string;
  step_index: number;
  role: string;
  agent_name: string | null;
  task_id: string | null;
  status: string;
  input: string | null;
  output: string | null;
  shared_refs: string | null;
  started_at: string | null;
  completed_at: string | null;
  gate?: string;
}

interface ActiveRun {
  id: string;
  workflow_id: string;
  project_id: string | null;
  trigger_type: string;
  trigger_ref: string | null;
  status: string;
  current_step: string | null;
  context_json: string;
  created_at: string;
  completed_at: string | null;
  updated_at: string | null;
  workflow_name: string;
  workflow_description: string | null;
  project_name: string | null;
  project_color: string | null;
  steps: StepRun[];
  context: Record<string, any>;
}

interface ArmadaTask {
  id: string;
  fromAgent: string;
  toAgent: string;
  taskText: string;
  result: string | null;
  status: string;
  createdAt: string;
  completedAt: string | null;
}

interface Agent {
  name: string;
  role: string;
  status: string;
  healthStatus?: string;
}

/* ── Constants ─────────────────────────────────────── */

const STEP_STATUS_COLOR: Record<string, string> = {
  running: 'border-blue-500 bg-blue-500/20 text-blue-300',
  completed: 'border-emerald-500 bg-emerald-500/20 text-emerald-300',
  failed: 'border-red-500 bg-red-500/20 text-red-300',
  waiting_gate: 'border-amber-500 bg-amber-500/20 text-amber-300',
  pending: 'border-zinc-600 bg-zinc-600/20 text-zinc-400',
  skipped: 'border-purple-500 bg-purple-500/20 text-purple-300',
};

const STEP_STATUS_DOT: Record<string, string> = {
  running: 'bg-blue-400',
  completed: 'bg-emerald-400',
  failed: 'bg-red-400',
  waiting_gate: 'bg-amber-400',
  pending: 'bg-zinc-500',
  skipped: 'bg-purple-400',
};

const TASK_STATUS_BADGE: Record<string, string> = {
  pending: 'bg-amber-500/20 text-amber-300 border-amber-500/30',
  running: 'bg-blue-500/20 text-blue-300 border-blue-500/30',
  completed: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
  failed: 'bg-red-500/20 text-red-300 border-red-500/30',
  blocked: 'bg-orange-500/20 text-orange-300 border-orange-500/30',
};

const TASK_STATUS_DOT: Record<string, string> = {
  pending: 'bg-amber-400',
  running: 'bg-blue-400 animate-pulse',
  completed: 'bg-emerald-400',
  failed: 'bg-red-400',
  blocked: 'bg-orange-400',
};

/* ── Helpers ───────────────────────────────────────── */

function duration(start: string | null, end: string | null): string {
  if (!start) return '—';
  const endMs = end ? new Date(end).getTime() : Date.now();
  const diff = endMs - new Date(start).getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

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

function truncate(s: string, max: number) {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function parseSharedRefs(refs: string | null): string[] {
  if (!refs) return [];
  try { return JSON.parse(refs); } catch { return []; }
}

/* ── Live Duration Timer ───────────────────────────── */

function LiveDuration({ start, end }: { start: string | null; end: string | null }) {
  const [, forceUpdate] = useState(0);

  useEffect(() => {
    if (end || !start) return;
    const interval = setInterval(() => forceUpdate(n => n + 1), 1000);
    return () => clearInterval(interval);
  }, [start, end]);

  return <span className="font-mono text-[10px]">{duration(start, end)}</span>;
}

/* ── Step Detail (uses shared component) ───────────── */

function stepToData(step: StepRun, runId: string, gate?: 'manual') {
  return {
    id: step.id,
    runId,
    stepId: step.step_id,
    role: step.role,
    agentName: step.agent_name,
    taskId: step.task_id,
    status: step.status,
    input: step.input ? (typeof step.input === 'string' ? JSON.parse(step.input) : step.input) : null,
    output: step.output,
    sharedRefs: parseSharedRefs(step.shared_refs),
    startedAt: step.started_at,
    completedAt: step.completed_at,
    gate,
  };
}

/* ── Workflow Run Row ──────────────────────────────── */

function RunCard({
  run,
  expanded,
  onToggle,
  agents,
  onRefresh,
}: {
  run: ActiveRun;
  expanded: boolean;
  onToggle: () => void;
  agents: Map<string, Agent>;
  onRefresh: () => void;
}) {
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [detailSteps, setDetailSteps] = useState<StepRun[]>(run.steps);
  const detailRef = useRef<HTMLDivElement>(null);

  // When expanded, fetch fresh step data
  const fetchSteps = useCallback(() =>
    apiFetch<any[]>(`/api/workflows/runs/${run.id}/steps`)
      .then(srs => setDetailSteps(srs.map(normalizeStep)))
      .catch(() => {}),
    [run.id]);

  useEffect(() => {
    if (!expanded) { setSelectedStepId(null); return; }
    fetchSteps();
  }, [expanded, fetchSteps]);

  // SSE for real-time step updates
  useSSEAll(useCallback((type: string, data: any) => {
    if (!expanded || (run.status !== 'running' && run.status !== 'paused')) return;
    if (data?.runId === run.id) fetchSteps();
  }, [expanded, run.status, run.id, fetchSteps]));

  // Scroll selected step detail into view
  useEffect(() => {
    if (selectedStepId && detailRef.current) {
      detailRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [selectedStepId]);

  const selectedStep = selectedStepId ? detailSteps.find(s => s.step_id === selectedStepId) : null;
  const isRecent = run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled';
  const triggerLabel = run.trigger_ref
    ? run.trigger_ref.includes('#') ? run.trigger_ref.split('/').pop() : truncate(run.trigger_ref, 30)
    : null;

  return (
    <div className={`border-b border-zinc-800/50 last:border-0 ${isRecent ? 'opacity-60' : ''} ${expanded ? 'bg-zinc-800/20' : ''}`}>
      {/* Header — clickable */}
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-zinc-800/40 transition-colors cursor-pointer"
      >
        {expanded ? <ChevronDown className="w-4 h-4 text-zinc-500 shrink-0" /> : <ChevronRight className="w-4 h-4 text-zinc-500 shrink-0" />}

        {/* Status dot */}
        <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${
          run.status === 'running' ? 'bg-blue-400 animate-pulse' :
          run.status === 'paused' ? 'bg-yellow-400 animate-pulse' :
          run.status === 'completed' ? 'bg-emerald-400' :
          run.status === 'failed' ? 'bg-red-400' : 'bg-zinc-500'
        }`} />

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-zinc-100">{run.workflow_name}</span>
            {run.project_name && (
              <Link
                to={`/projects/${run.project_id || run.project_name}`}
                onClick={e => e.stopPropagation()}
                className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full hover:bg-zinc-700/50 transition"
                style={{ backgroundColor: (run.project_color || '#6b7280') + '20', color: run.project_color || '#9ca3af' }}
              >
                <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: run.project_color || '#6b7280' }} />
                {run.project_name}
              </Link>
            )}
            {triggerLabel && (
              <span className="text-[10px] text-zinc-500 font-mono">{triggerLabel}</span>
            )}
          </div>
        </div>

        {/* Compact pipeline (collapsed only) */}
        {!expanded && (
          <div className="hidden md:flex items-center gap-0.5 shrink-0">
            {run.steps.slice(0, 8).map(step => (
              <span
                key={step.id}
                title={`${humanize(step.step_id, 'steps')}: ${humanize(step.status, 'status')}`}
                className={`w-2.5 h-2.5 rounded-full ${STEP_STATUS_DOT[step.status] || 'bg-zinc-500'} ${step.status === 'running' ? 'animate-pulse' : ''}`}
              />
            ))}
            {run.steps.length > 8 && <span className="text-[9px] text-zinc-600 ml-0.5">+{run.steps.length - 8}</span>}
          </div>
        )}

        {/* Duration + time */}
        <div className="flex items-center gap-2 text-xs text-zinc-500 shrink-0">
          <Clock className="w-3 h-3" />
          <LiveDuration start={run.created_at} end={run.completed_at} />
          <span className="hidden sm:inline text-zinc-600">·</span>
          <span className="hidden sm:inline">{relativeTime(run.created_at)}</span>
        </div>
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="px-4 pb-4 space-y-4 animate-[fadeIn_200ms_ease-out]">
          {/* Full pipeline */}
          <PipelineView
            steps={detailSteps.map(s => ({ id: s.step_id, role: s.role, gate: s.status === 'waiting_gate' ? 'manual' : undefined }))}
            stepRuns={detailSteps.map(s => ({ stepId: s.step_id, status: s.status, agentName: s.agent_name, output: s.output, startedAt: s.started_at, completedAt: s.completed_at }))}
            selectedStepId={selectedStepId}
            onSelectStep={setSelectedStepId}
          />

          {/* Selected step detail modal */}
          {selectedStep && (
            <StepRunModal
              step={stepToData(selectedStep, run.id, selectedStep.gate === 'manual' ? 'manual' : undefined)}
              onAction={onRefresh}
              onClose={() => setSelectedStepId(null)}
            />
          )}
        </div>
      )}
    </div>
  );
}

/* ── Standalone Task Row ───────────────────────────── */

function TaskRow({ task }: { task: ArmadaTask }) {
  const [expanded, setExpanded] = useState(false);
  const [steerMsg, setSteerMsg] = useState('');
  const [acting, setActing] = useState(false);

  async function handleSteer() {
    if (!steerMsg.trim()) return;
    setActing(true);
    try {
      await apiFetch(`/api/tasks/${task.id}/steer`, {
        method: 'POST',
        body: JSON.stringify({ message: steerMsg }),
      });
      setSteerMsg('');
    } catch (err) {
      console.error('Steer failed:', err);
    } finally {
      setActing(false);
    }
  }

  return (
    <div className={`border-b border-zinc-800/50 last:border-0 ${expanded ? 'bg-zinc-800/20' : ''}`}>
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-zinc-800/40 transition-colors cursor-pointer"
      >
        {expanded ? <ChevronDown className="w-3.5 h-3.5 text-zinc-600 shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 text-zinc-600 shrink-0" />}
        {/* Status: dot on mobile, text badge on md+ */}
        <span className={`md:hidden w-2.5 h-2.5 rounded-full shrink-0 ${TASK_STATUS_DOT[task.status] || 'bg-zinc-500'}`} title={task.status} />
        <Badge className={`hidden md:inline text-[10px] px-2 py-0.5 rounded-full border ${TASK_STATUS_BADGE[task.status] || ''}`}>
          {task.status}
        </Badge>
        <span className="text-zinc-300 truncate flex-1">{truncate(task.taskText, 80)}</span>
        <div className="flex items-center gap-2 text-xs text-zinc-500 shrink-0">
          <span className="hidden sm:inline">{task.toAgent}</span>
          <Clock className="w-3 h-3" />
          <LiveDuration start={task.createdAt} end={task.completedAt} />
        </div>
      </button>
      {expanded && (
        <div className="px-4 pb-3 space-y-2 animate-[fadeIn_200ms_ease-out]">
          <div className="text-xs text-zinc-500">
            <span className="font-mono">{task.fromAgent}</span> → <span className="font-mono">{task.toAgent}</span>
            {' · '}{relativeTime(task.createdAt)}
          </div>
          <pre className="max-h-40 overflow-auto rounded-lg bg-black/30 p-2 text-xs text-zinc-400 font-mono whitespace-pre-wrap">
            {task.taskText}
          </pre>
          {task.result && (
            <div>
              <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">Result</div>
              <pre className="max-h-40 overflow-auto rounded-lg bg-black/30 p-2 text-xs text-zinc-400 font-mono whitespace-pre-wrap">
                {task.result}
              </pre>
            </div>
          )}
          {task.status === 'running' && (
            <div className="flex gap-2">
              <Input
                value={steerMsg}
                onChange={e => setSteerMsg(e.target.value)}
                placeholder="Inject message…"
                className="flex-1 rounded-lg border border-zinc-800 bg-zinc-900/50 px-3 py-2 text-sm text-zinc-300 focus:border-violet-500 focus:outline-none transition-colors"
              />
              <Button
                variant="ghost" onClick={handleSteer}
                disabled={acting || !steerMsg.trim()}
                className="flex items-center gap-1.5 rounded-lg border border-violet-500/30 bg-violet-500/20 px-3 py-1.5 text-xs font-medium text-violet-300 hover:bg-violet-500/30 transition disabled:opacity-50"
              >
                <MessageSquare className="w-3.5 h-3.5" />
                Steer
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ── Normalize step from API (camelCase → snake_case) ── */

function normalizeStep(s: any): StepRun {
  return {
    id: s.id,
    run_id: s.run_id ?? s.runId,
    step_id: s.step_id ?? s.stepId,
    step_index: s.step_index ?? s.stepIndex ?? 0,
    role: s.role,
    agent_name: s.agent_name ?? s.agentName ?? null,
    task_id: s.task_id ?? s.taskId ?? null,
    status: s.status,
    input: s.input ?? null,
    output: s.output ?? null,
    shared_refs: typeof s.shared_refs === 'string' ? s.shared_refs :
                 typeof s.sharedRefs === 'string' ? s.sharedRefs :
                 Array.isArray(s.shared_refs ?? s.sharedRefs) ? JSON.stringify(s.shared_refs ?? s.sharedRefs) : null,
    started_at: s.started_at ?? s.startedAt ?? null,
    completed_at: s.completed_at ?? s.completedAt ?? null,
    gate: s.gate === 'manual' ? 'manual' as const : undefined,
  };
}

/* ── Operation Status Badge ─────────────────── */

const OP_STATUS_STYLES: Record<Operation['status'], string> = {
  pending:   'bg-zinc-500/20 text-zinc-400 border-zinc-500/30',
  running:   'bg-violet-500/20 text-violet-300 border-violet-500/30',
  completed: 'bg-green-500/20 text-green-300 border-green-500/30',
  failed:    'bg-red-500/20 text-red-300 border-red-500/30',
  cancelled: 'bg-zinc-600/20 text-zinc-500 border-zinc-600/30',
};

function OpStatusBadge({ status }: { status: Operation['status'] }) {
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border font-medium ${OP_STATUS_STYLES[status] ?? ''}`}>
      {status === 'running' && <Loader2 className="w-2.5 h-2.5 animate-spin" />}
      {status}
    </span>
  );
}

/* ── Operation Row ───────────────────────────── */

function OperationCard({ op }: { op: Operation }) {
  const [expanded, setExpanded] = useState(op.status === 'running' || op.status === 'pending');

  // Stream live updates for running operations
  const { steps } = useOperationStream(
    op.status === 'running' || op.status === 'pending' ? op.id : null,
    op,
  );

  const liveSteps = steps.length > 0 ? steps : op.steps;
  const totalSteps = liveSteps.length;
  const doneSteps = liveSteps.filter(s => s.status === 'completed' || s.status === 'skipped').length;
  const progressPct = totalSteps > 0 ? Math.round((doneSteps / totalSteps) * 100) : 0;

  return (
    <div className={`border-b border-zinc-800/50 last:border-0 ${expanded ? 'bg-zinc-800/20' : ''}`}>
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-zinc-800/40 transition-colors cursor-pointer"
      >
        {expanded ? <ChevronDown className="w-4 h-4 text-zinc-500 shrink-0" /> : <ChevronRight className="w-4 h-4 text-zinc-500 shrink-0" />}

        <Server className="w-4 h-4 text-zinc-600 shrink-0" />

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-zinc-100">{humanize(op.type, 'operations')}</span>
            <OpStatusBadge status={op.status} />
            {op.targetType && (
              <span className="text-[10px] text-zinc-500 truncate max-w-[200px]">{op.targetType}{op.targetId ? `: ${op.targetId.slice(0, 8)}…` : ''}</span>
            )}
          </div>
        </div>

        {/* Compact step dots */}
        {!expanded && liveSteps.length > 0 && (
          <div className="hidden md:flex items-center gap-0.5 shrink-0">
            {liveSteps.slice(0, 8).map(step => (
              <span
                key={step.id}
                title={`${humanize(step.name, 'steps')}: ${humanize(step.status, 'status')}`}
                className={`w-2 h-2 rounded-full ${
                  step.status === 'completed' ? 'bg-green-400' :
                  step.status === 'running'   ? 'bg-violet-400 animate-pulse' :
                  step.status === 'failed'    ? 'bg-red-400' :
                  step.status === 'skipped'   ? 'bg-zinc-600' :
                  'bg-zinc-700'
                }`}
              />
            ))}
          </div>
        )}

        <div className="flex items-center gap-2 text-xs text-zinc-500 shrink-0">
          <Clock className="w-3 h-3" />
          <span className="font-mono text-[10px]">{
            (() => {
              const ms = (op.completedAt ? new Date(op.completedAt).getTime() : Date.now()) - new Date(op.startedAt).getTime();
              const s = Math.floor(ms / 1000);
              return s < 60 ? `${s}s` : `${Math.floor(s/60)}m ${s%60}s`;
            })()
          }</span>
        </div>
      </button>

      {expanded && (
        <div className="px-4 pb-4 space-y-3">
          {liveSteps.length > 0 && <StepTimeline steps={liveSteps} />}

          {op.status === 'running' && totalSteps > 0 && (
            <div className="mt-2 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
              <div
                className="h-full bg-violet-500 rounded-full transition-all duration-500"
                style={{ width: `${progressPct}%` }}
              />
            </div>
          )}

          {op.error && (
            <div className="flex items-start gap-2 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2">
              <XCircle className="w-3.5 h-3.5 text-red-400 shrink-0 mt-0.5" />
              <p className="text-xs text-red-400">{op.error}</p>
            </div>
          )}

          {op.createdBy && (
            <p className="text-[10px] text-zinc-600">Created by: {op.createdBy}</p>
          )}
        </div>
      )}
    </div>
  );
}

/* ── Table Section Header ──────────────────────────── */

function TableSectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 px-4 py-2.5 border-b border-zinc-800 text-[11px] text-zinc-500 uppercase tracking-wider">
      {children}
    </div>
  );
}

/* ── Main Operations Page ──────────────────────────── */

export default function Operations() {
  const [activeRuns, setActiveRuns] = useState<ActiveRun[]>([]);
  const [recentRuns, setRecentRuns] = useState<ActiveRun[]>([]);
  const [tasks, setTasks] = useState<ArmadaTask[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  const [showRecent, setShowRecent] = useState(false);
  const [recentTab, setRecentTab] = useState<'workflows' | 'tasks'>('workflows');
  const [recentTasks, setRecentTasks] = useState<ArmadaTask[]>([]);
  const [loading, setLoading] = useState(true);
  const completedTimers = useRef<Map<string, NodeJS.Timeout>>(new Map());

  // Deployment operations (separate from workflow runs)
  const { active: fleetOpsActive, recent: fleetOpsRecent } = useOperations();

  const agentMap = useMemo(() => {
    const m = new Map<string, Agent>();
    for (const a of agents) m.set(a.name, a);
    return m;
  }, [agents]);

  // Fetch data
  const loadData = useCallback(async () => {
    try {
      const [active, running, pending, agentList] = await Promise.all([
        apiFetch<ActiveRun[]>('/api/workflows/runs/active').catch(() => []),
        apiFetch<ArmadaTask[]>('/api/tasks?status=running&limit=50').catch(() => []),
        apiFetch<ArmadaTask[]>('/api/tasks?status=pending&limit=50').catch(() => []),
        apiFetch<Agent[]>('/api/agents').catch(() => []),
      ]);

      // Normalize steps
      const normalizedRuns = active.map(r => ({
        ...r,
        steps: (r.steps || []).map(normalizeStep),
      }));

      setActiveRuns(normalizedRuns);
      setAgents(agentList);

      // Filter standalone tasks (no workflow association)
      const allTasks = [...running, ...pending];
      setTasks(allTasks);
    } catch (err) {
      console.error('Failed to load operations data:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadRecent = useCallback(async () => {
    try {
      const recent = await apiFetch<ActiveRun[]>('/api/workflows/runs/recent');
      setRecentRuns(recent.map(r => ({
        ...r,
        steps: (r.steps || []).map(normalizeStep),
      })));
    } catch {
      setRecentRuns([]);
    }
  }, []);

  const loadRecentTasks = useCallback(async () => {
    try {
      const [completed, failed] = await Promise.all([
        apiFetch<ArmadaTask[]>('/api/tasks?status=completed&limit=50').catch(() => []),
        apiFetch<ArmadaTask[]>('/api/tasks?status=failed&limit=50').catch(() => []),
      ]);
      // Merge + sort by most recent, filter to last 24h
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      const all = [...completed, ...failed]
        .filter(t => new Date(t.completedAt || t.createdAt).getTime() > cutoff)
        .sort((a, b) => new Date(b.completedAt || b.createdAt).getTime() - new Date(a.completedAt || a.createdAt).getTime());
      setRecentTasks(all);
    } catch {
      setRecentTasks([]);
    }
  }, []);

  useEffect(() => {
    loadData();
    loadRecent();
  }, [loadData, loadRecent]);

  useEffect(() => {
    if (showRecent) loadRecent();
  }, [showRecent, loadRecent]);

  // SSE for live updates — operation and task events
  useSSEAll(useCallback((type: string) => {
    if (type.startsWith('operation.') || type.startsWith('task.') || type.startsWith('workflow.')) {
      loadData();
    }
  }, [loadData]));

  // Compute summary stats
  const stats = useMemo(() => {
    const busyAgents = new Set<string>();
    for (const run of activeRuns) {
      for (const step of run.steps) {
        if (step.status === 'running' && step.agent_name) busyAgents.add(step.agent_name);
      }
    }
    for (const task of tasks) {
      if (task.status === 'running') busyAgents.add(task.toAgent);
    }

    return {
      activeRuns: activeRuns.length,
      tasksInProgress: tasks.filter(t => t.status === 'running').length + tasks.filter(t => t.status === 'pending').length,
      agentsBusy: busyAgents.size,
      completedToday: 0, // populated from recent if loaded
    };
  }, [activeRuns, tasks]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-zinc-500 text-sm animate-pulse flex items-center gap-2">
          <Radio className="w-4 h-4" />
          Loading operations…
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-6xl">
      {/* Page header */}
      <PageHeader icon={Radio} title="Operations" subtitle="Live view of all active work" />

      {/* Stats bar */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard icon={<Activity className="w-4 h-4 text-blue-400" />} label="Active Runs" value={stats.activeRuns} color="blue" />
        <StatCard icon={<Zap className="w-4 h-4 text-amber-400" />} label="Tasks" value={stats.tasksInProgress} color="amber" />
        <StatCard icon={<Bot className="w-4 h-4 text-emerald-400" />} label="Agents Busy" value={stats.agentsBusy} color="emerald" />
        <StatCard icon={<CheckCircle2 className="w-4 h-4 text-violet-400" />} label="Completed (24h)" value={recentRuns.length} color="violet" />
      </div>

      {/* Deployment Operations */}
      {(fleetOpsActive.length > 0 || fleetOpsRecent.length > 0) && (
        <section>
          <div className="flex items-center gap-2 mb-3">
            <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider">Operations</h2>
            {fleetOpsActive.length > 0 && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-violet-500/20 text-violet-300">{fleetOpsActive.length} active</span>
            )}
          </div>
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/50">
            <TableSectionHeader>
              <span className="flex-1">Operation</span>
              <span className="hidden md:block w-32 text-center">Steps</span>
              <span className="w-20 text-right">Duration</span>
            </TableSectionHeader>
            {fleetOpsActive.map(op => <OperationCard key={op.id} op={op} />)}
            {fleetOpsRecent.slice(0, 5).map(op => <OperationCard key={op.id} op={op} />)}
          </div>
        </section>
      )}

      {/* Active Workflow Runs */}
      <section>
        <div className="flex items-center gap-2 mb-3">
          <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider">Active Workflow Runs</h2>
          {activeRuns.length > 0 && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-500/20 text-blue-300">{activeRuns.length}</span>
          )}
        </div>
        {activeRuns.length === 0 ? (
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-8 text-center">
            <Activity className="w-8 h-8 text-zinc-700 mx-auto mb-2" />
            <p className="text-sm text-zinc-600">No active workflow runs</p>
          </div>
        ) : (
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/50">
            <TableSectionHeader>
              <span className="flex-1">Workflow</span>
              <span className="hidden md:block w-32 text-center">Steps</span>
              <span className="w-28 text-right">Duration</span>
            </TableSectionHeader>
            {activeRuns.map(run => (
              <RunCard
                key={run.id}
                run={run}
                expanded={expandedRunId === run.id}
                onToggle={() => setExpandedRunId(expandedRunId === run.id ? null : run.id)}
                agents={agentMap}
                onRefresh={loadData}
              />
            ))}
          </div>
        )}
      </section>

      {/* Standalone Tasks */}
      {tasks.length > 0 && (
        <section>
          <div className="flex items-center gap-2 mb-3">
            <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider">Tasks</h2>
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-300">{tasks.length}</span>
          </div>
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/50">
            <TableSectionHeader>
              <span className="flex-1">Task</span>
              <span className="hidden sm:block w-32 text-right">Agent · Duration</span>
            </TableSectionHeader>
            {tasks.map(task => (
              <TaskRow key={task.id} task={task} />
            ))}
          </div>
        </section>
      )}

      {/* Recent (collapsible, tabbed) */}
      <section>
        <Button
          variant="ghost" onClick={() => { setShowRecent(!showRecent); if (!showRecent) { loadRecent(); loadRecentTasks(); } }}
          className="flex items-center gap-2 text-sm font-semibold text-zinc-500 uppercase tracking-wider hover:text-zinc-300 transition"
        >
          {showRecent ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
          Recent (24h)
        </Button>
        {showRecent && (
          <div className="mt-3 space-y-3">
            {/* Tabs */}
            <div className="flex gap-1 border-b border-zinc-800 pb-px">
              <Button
                variant="ghost" onClick={() => setRecentTab('workflows')}
                className={`px-3 py-1.5 text-xs font-medium rounded-t-lg transition ${
                  recentTab === 'workflows'
                    ? 'bg-zinc-700/50 text-zinc-100 border-b-2 border-violet-400'
                    : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/50'
                }`}
              >
                Workflow Runs
                {recentRuns.length > 0 && (
                  <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full bg-zinc-500/20 text-zinc-400">{recentRuns.length}</span>
                )}
              </Button>
              <Button
                variant="ghost" onClick={() => { setRecentTab('tasks'); if (recentTasks.length === 0) loadRecentTasks(); }}
                className={`px-3 py-1.5 text-xs font-medium rounded-t-lg transition ${
                  recentTab === 'tasks'
                    ? 'bg-zinc-700/50 text-zinc-100 border-b-2 border-violet-400'
                    : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/50'
                }`}
              >
                Tasks
                {recentTasks.length > 0 && (
                  <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full bg-zinc-500/20 text-zinc-400">{recentTasks.length}</span>
                )}
              </Button>
            </div>

            {/* Tab content */}
            {recentTab === 'workflows' && (
              recentRuns.length === 0 ? (
                <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-6 text-center">
                  <p className="text-sm text-zinc-600">No completed workflow runs in the last 24 hours</p>
                </div>
              ) : (
                <div className="rounded-lg border border-zinc-800 bg-zinc-900/50">
                  <TableSectionHeader>
                    <span className="flex-1">Workflow</span>
                    <span className="hidden md:block w-32 text-center">Steps</span>
                    <span className="w-28 text-right">Duration</span>
                  </TableSectionHeader>
                  {recentRuns.map(run => (
                    <RunCard
                      key={run.id}
                      run={run}
                      expanded={expandedRunId === run.id}
                      onToggle={() => setExpandedRunId(expandedRunId === run.id ? null : run.id)}
                      agents={agentMap}
                      onRefresh={loadRecent}
                    />
                  ))}
                </div>
              )
            )}

            {recentTab === 'tasks' && (
              recentTasks.length === 0 ? (
                <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-6 text-center">
                  <p className="text-sm text-zinc-600">No completed tasks in the last 24 hours</p>
                </div>
              ) : (
                <div className="rounded-lg border border-zinc-800 bg-zinc-900/50">
                  <TableSectionHeader>
                    <span className="flex-1">Task</span>
                    <span className="hidden sm:block w-32 text-right">Agent · Duration</span>
                  </TableSectionHeader>
                  {recentTasks.map(task => (
                    <TaskRow key={task.id} task={task} />
                  ))}
                </div>
              )
            )}
          </div>
        )}
      </section>
    </div>
  );
}

/* ── Stat Card Component ───────────────────────────── */

function StatCard({
  icon,
  label,
  value,
  color,
}: {
  icon: React.ReactNode;
  label: string;
  value: number | string;
  color: string;
}) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 px-4 py-3 flex items-center gap-3">
      <div className={`rounded-lg p-2 bg-${color}-500/10`}>
        {icon}
      </div>
      <div>
        <div className="text-lg font-bold text-zinc-100">{value}</div>
        <div className="text-[10px] text-zinc-500 uppercase tracking-wider">{label}</div>
      </div>
    </div>
  );
}
