import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { apiFetch } from '../hooks/useApi';
import { useWorkflow } from '../hooks/queries/useWorkflows';
import ConfirmDialog from '../components/ConfirmDialog';
import { Checkbox } from '../components/ui/checkbox';
import StepRunModal from '../components/StepRunModal';
import PipelineView from '../components/PipelineView';
import WorkflowDAG from '../components/WorkflowDAG';
import {
  Workflow as WorkflowIcon, Play, Power, PowerOff, Plus, Trash2,
  Pencil, X, ChevronRight, Clock, RotateCcw, CheckCircle2,
  XCircle, Pause, Ban, SkipForward, ArrowLeft, Save,
  LayoutList, GitBranch,
} from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../components/ui/tabs';
import CollaborationThread from '../components/CollaborationThread';
import ReworkHistory from '../components/ReworkHistory';
import { PageHeader } from '../components/PageHeader';
import { LoadingState } from '../components/LoadingState';
import type {
  Workflow, WorkflowStep, WorkflowRun, WorkflowStepRun,
  WorkflowRunStatus, StepRunStatus,
} from '@coderage-labs/armada-shared';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Input } from '../components/ui/input';
import { Textarea } from '../components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../components/ui/responsive-dialog';
import { Switch } from '../components/ui/switch';

/* ── Types ─────────────────────────────────────────── */

interface WorkflowStats {
  totalRuns: number;
  successCount: number;
  failCount: number;
  pendingCount: number;
  cancelledCount: number;
  successRate: number;
  avgDurationMs: number | null;
  recentRuns: Array<{ durationMs: number | null; status: string; createdAt: string }>;
}

interface Project {
  id: string;
  name: string;
  color: string;
  icon: string | null;
}

/** Runtime workflow shape — API now returns projectIds[] */
type WorkflowWithProjects = Omit<Workflow, 'projectId'> & {
  projectId?: string;
  projectIds?: string[];
};

/** Helper to resolve project IDs from either field */
function getProjectIds(wf: WorkflowWithProjects): string[] {
  return wf.projectIds?.length ? wf.projectIds : wf.projectId ? [wf.projectId] : [];
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

const RUN_STATUS_STYLES: Record<string, string> = {
  running: 'bg-blue-500/20 border-blue-500/30 text-blue-300',
  paused: 'bg-yellow-500/20 border-yellow-500/30 text-yellow-300',
  completed: 'bg-emerald-500/20 border-emerald-500/30 text-emerald-300',
  failed: 'bg-red-500/20 border-red-500/30 text-red-300',
  cancelled: 'bg-zinc-500/20 border-zinc-500/30 text-zinc-400',
};

/* Step status constants moved to shared PipelineView component */

/* ── Step Editor Dialog ────────────────────────────── */

function StepEditorDialog({
  step,
  allStepIds,
  projectIds,
  onSave,
  onCancel,
}: {
  step: WorkflowStep | null; // null = creating new
  allStepIds: string[];
  projectIds?: string[];
  onSave: (step: WorkflowStep) => void;
  onCancel: () => void;
}) {
  const [id, setId] = useState(step?.id || '');
  const [stepType, setStepType] = useState<'agent' | 'action'>(step?.stepType || 'agent');
  const [role, setRole] = useState(step?.role || '');
  const [prompt, setPrompt] = useState(step?.prompt || '');
  const [waitFor, setWaitFor] = useState<string[]>(step?.waitFor || []);
  const [parallel, setParallel] = useState(step?.parallel || '');
  const [optional, setOptional] = useState(step?.optional || false);
  const [gate, setGate] = useState<'manual' | ''>(step?.gate === 'manual' ? 'manual' : '');
  const [notifyHumans, setNotifyHumans] = useState(step?.gatePolicy?.notifyOnly?.includes('human') ?? true);
  const [notifyOperators, setNotifyOperators] = useState(step?.gatePolicy?.notifyOnly?.includes('operator') ?? true);
  const [approveHumans, setApproveHumans] = useState(step?.gatePolicy?.approveOnly?.includes('human') ?? true);
  const [approveOperators, setApproveOperators] = useState(step?.gatePolicy?.approveOnly?.includes('operator') ?? true);
  const [availableRoles, setAvailableRoles] = useState<string[]>([]);

  // Retry config state
  const [retryOnFailure, setRetryOnFailure] = useState(step?.retryOnFailure ?? false);
  const [maxRetries, setMaxRetries] = useState(step?.maxRetries ?? 3);
  const [retryDelayMs, setRetryDelayMs] = useState(step?.retryDelayMs ?? 5000);
  const [loopUntilApproved, setLoopUntilApproved] = useState(step?.loopUntilApproved ?? false);
  const [loopBackToStep, setLoopBackToStep] = useState(step?.loopBackToStep ?? '');
  const [maxLoopIterations, setMaxLoopIterations] = useState(step?.maxLoopIterations ?? 5);
  const [toolCategories, setToolCategories] = useState<string[]>(step?.toolCategories || []);

  // Action step state
  const [action, setAction] = useState(step?.action || '');
  const [actionTimeoutMs, setActionTimeoutMs] = useState(step?.actionTimeoutMs || 300000);
  const [onFailure, setOnFailure] = useState<'fail' | 'culprit'>(step?.onFailure || 'fail');
  const [stepRepo, setStepRepo] = useState((step as any)?.repo || '');
  const [availableActions, setAvailableActions] = useState<Array<{name: string, command: string, description?: string}>>([]);
  const [projectRepos, setProjectRepos] = useState<Array<{fullName: string}>>([]);

  // Fetch repos from project for action step repo dropdown
  useEffect(() => {
    if (projectIds?.length) {
      apiFetch<Array<{fullName: string}>>(`/api/projects/${projectIds[0]}/repos2`)
        .then(repos => setProjectRepos(repos || []))
        .catch(() => setProjectRepos([]));
    }
  }, [projectIds]);

  // Auto-select first repo if none set
  useEffect(() => {
    if (stepType === 'action' && !stepRepo && projectRepos.length > 0) {
      setStepRepo(projectRepos[0].fullName);
    }
  }, [stepType, projectRepos, stepRepo]);

  const TOOL_CATEGORIES = [
    'instances', 'projects', 'issues', 'workflows', 'git', 'changesets',
    'integrations', 'notifications', 'system', 'hierarchy', 'plugins',
    'admin', 'tasks', 'tools',
  ];

  useEffect(() => {
    apiFetch<{ rules: Record<string, string[]> }>('/api/hierarchy')
      .then(data => {
        const roles = Object.keys(data.rules || {}).filter(r => !/^\d+$/.test(r));
        setAvailableRoles(roles.sort());
      })
      .catch(() => {});
  }, []);

  // Fetch available actions when repo changes for action steps
  useEffect(() => {
    if (stepType === 'action' && stepRepo) {
      apiFetch<{ actions: Array<{name: string, command: string}> }>('/api/codebase/actions', { 
        method: 'POST', 
        body: JSON.stringify({ repo: stepRepo }) 
      })
        .then(data => setAvailableActions(data.actions || []))
        .catch(() => setAvailableActions([]));
    } else {
      setAvailableActions([]);
    }
  }, [stepType, stepRepo]);

  const otherIds = allStepIds.filter((sid) => sid !== step?.id);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    // Validation
    if (!id.trim()) return;
    if (stepType === 'agent' && (!role.trim() || !prompt.trim())) return;
    if (stepType === 'action' && !action.trim()) return;

    // Build gatePolicy only if gate is manual and not all types selected
    let gatePolicy: WorkflowStep['gatePolicy'] | undefined;
    if (gate === 'manual') {
      const notifyOnly: ('human' | 'operator')[] = [];
      if (notifyHumans) notifyOnly.push('human');
      if (notifyOperators) notifyOnly.push('operator');
      const approveOnly: ('human' | 'operator')[] = [];
      if (approveHumans) approveOnly.push('human');
      if (approveOperators) approveOnly.push('operator');

      // Only set policy if it's not "everyone for everything"
      if (notifyOnly.length < 2 || approveOnly.length < 2) {
        gatePolicy = {};
        if (notifyOnly.length < 2) gatePolicy.notifyOnly = notifyOnly;
        if (approveOnly.length < 2) gatePolicy.approveOnly = approveOnly;
      }
    }

    const saved: WorkflowStep = {
      id: id.trim(),
      role: stepType === 'agent' ? role.trim() : 'system', // action steps don't need a real role
      prompt: stepType === 'agent' ? prompt.trim() : '', // no prompt for actions
      stepType,
      waitFor: waitFor.length > 0 ? waitFor : undefined,
      parallel: parallel.trim() || undefined,
      optional: optional || undefined,
      gate: gate || undefined,
      gatePolicy,
      ...(stepType === 'agent' && {
        retryOnFailure: retryOnFailure || undefined,
        maxRetries: retryOnFailure ? maxRetries : undefined,
        retryDelayMs: retryOnFailure ? retryDelayMs : undefined,
        loopUntilApproved: loopUntilApproved || undefined,
        loopBackToStep: loopUntilApproved && loopBackToStep.trim() ? loopBackToStep.trim() : undefined,
        maxLoopIterations: loopUntilApproved ? maxLoopIterations : undefined,
        toolCategories: toolCategories.length > 0 ? toolCategories : undefined,
      }),
      ...(stepType === 'action' && {
        action: action.trim(),
        actionTimeoutMs,
        onFailure,
        repo: stepRepo.trim() || undefined,
      }),
    };

    onSave(saved);
  }

  return (
    <Dialog open onOpenChange={(isOpen) => !isOpen && onCancel()}>
      <DialogContent className="sm:max-w-lg sm:max-h-[90vh] sm:overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{step ? 'Edit Step' : 'Add Step'}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
        {/* Step Type Selector */}
        <div>
          <label className="block text-xs text-zinc-500 uppercase tracking-wider mb-2">Step Type</label>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => setStepType('agent')}
              className={`flex-1 px-4 py-2.5 rounded-lg border text-sm font-medium transition-all ${
                stepType === 'agent'
                  ? 'bg-violet-500/20 border-violet-500/50 text-violet-300'
                  : 'bg-zinc-800/50 border-zinc-700 text-zinc-400 hover:border-zinc-600'
              }`}
            >
              Agent
            </button>
            <button
              type="button"
              onClick={() => setStepType('action')}
              className={`flex-1 px-4 py-2.5 rounded-lg border text-sm font-medium transition-all ${
                stepType === 'action'
                  ? 'bg-violet-500/20 border-violet-500/50 text-violet-300'
                  : 'bg-zinc-800/50 border-zinc-700 text-zinc-400 hover:border-zinc-600'
              }`}
            >
              Action
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs text-zinc-500 uppercase tracking-wider mb-1">Step ID</label>
            <Input
              value={id}
              onChange={(e) => setId(e.target.value)}
              placeholder="e.g. analyse"
              disabled={!!step}
              className="w-full rounded-lg border border-zinc-800 bg-zinc-800/50 px-3 py-2 text-sm text-zinc-200 placeholder-gray-600 focus:outline-none focus:border-violet-500/50 disabled:opacity-50"
            />
          </div>
          {stepType === 'agent' && (
          <div>
            <label className="block text-xs text-zinc-500 uppercase tracking-wider mb-1">Role</label>
            {availableRoles.length > 0 ? (
              <Select value={role || '__none__'} onValueChange={(val) => setRole(val === '__none__' ? '' : val)}>
                <SelectTrigger className="w-full border-zinc-800 bg-zinc-800/50">
                  <SelectValue placeholder="Select role…" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">Select role…</SelectItem>
                  {availableRoles.map(r => (
                    <SelectItem key={r} value={r}>{r}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                value={role}
                onChange={(e) => setRole(e.target.value)}
                placeholder="e.g. development"
                className="w-full rounded-lg border border-zinc-800 bg-zinc-800/50 px-3 py-2 text-sm text-zinc-200 placeholder-gray-600 focus:outline-none focus:border-violet-500/50"
              />
            )}
          </div>
          )}
        </div>

        {stepType === 'agent' && (
        <div>
          <label className="block text-xs text-zinc-500 uppercase tracking-wider mb-1">Prompt</label>
          <Textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Instructions for this step…"
            rows={4}
            className="w-full rounded-lg border border-zinc-800 bg-zinc-800/50 px-3 py-2 text-sm text-zinc-200 placeholder-gray-600 focus:outline-none focus:border-violet-500/50 resize-none font-mono"
          />
        </div>
        )}

        {stepType === 'action' && (
        <div className="space-y-4">
          {/* Repo field — dropdown from project repos, or text input */}
          <div>
            <label className="block text-xs text-zinc-500 uppercase tracking-wider mb-1">
              Repo <span className="text-zinc-600">(optional, falls back to issueRepo)</span>
            </label>
            {projectRepos.length > 0 ? (
              <select
                value={stepRepo}
                onChange={(e) => setStepRepo(e.target.value)}
                className="w-full rounded-lg border border-zinc-800 bg-zinc-800/50 px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-violet-500/50"
              >
                <option value="">Select repo...</option>
                {projectRepos.map(r => (
                  <option key={r.fullName} value={r.fullName}>{r.fullName}</option>
                ))}
              </select>
            ) : (
              <Input
                value={stepRepo}
                onChange={(e) => setStepRepo(e.target.value)}
                placeholder="e.g. owner/repo"
                className="w-full rounded-lg border border-zinc-800 bg-zinc-800/50 px-3 py-2 text-sm text-zinc-200 placeholder-gray-600 focus:outline-none focus:border-violet-500/50"
              />
            )}
          </div>

          {/* Action name - dropdown if actions available, text input otherwise */}
          <div>
            <label className="block text-xs text-zinc-500 uppercase tracking-wider mb-1">Action Name</label>
            {availableActions.length > 0 ? (
              <Select value={action || '__none__'} onValueChange={(val) => setAction(val === '__none__' ? '' : val)}>
                <SelectTrigger className="w-full border-zinc-800 bg-zinc-800/50">
                  <SelectValue placeholder="Select action…" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">Select action…</SelectItem>
                  {availableActions.map(a => (
                    <SelectItem key={a.name} value={a.name}>{a.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                value={action}
                onChange={(e) => setAction(e.target.value)}
                placeholder="e.g. test, lint, build"
                className="w-full rounded-lg border border-zinc-800 bg-zinc-800/50 px-3 py-2 text-sm text-zinc-200 placeholder-gray-600 focus:outline-none focus:border-violet-500/50"
              />
            )}
          </div>

          {/* Timeout */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-zinc-500 uppercase tracking-wider mb-1">Timeout (seconds)</label>
              <Input
                type="number"
                min={1}
                value={actionTimeoutMs / 1000}
                onChange={(e) => setActionTimeoutMs(Number(e.target.value) * 1000)}
                className="w-full rounded-lg border border-zinc-800 bg-zinc-800/50 px-3 py-2 text-sm text-zinc-200"
              />
            </div>

            {/* On Failure */}
            <div>
              <label className="block text-xs text-zinc-500 uppercase tracking-wider mb-1">On Failure</label>
              <Select value={onFailure} onValueChange={(val) => setOnFailure(val as 'fail' | 'culprit')}>
                <SelectTrigger className="w-full border-zinc-800 bg-zinc-800/50">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="fail">Fail</SelectItem>
                  <SelectItem value="culprit">Route to culprit step</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
        )}

        {otherIds.length > 0 && (
          <div>
            <label className="block text-xs text-zinc-500 uppercase tracking-wider mb-1">Wait For</label>
            <div className="flex flex-wrap gap-2">
              {otherIds.map((sid) => (
                <Checkbox
                  key={sid}
                  checked={waitFor.includes(sid)}
                  onChange={(v) => {
                    if (v) setWaitFor([...waitFor, sid]);
                    else setWaitFor(waitFor.filter((w) => w !== sid));
                  }}
                  label={sid}
                />
              ))}
            </div>
          </div>
        )}

        <div className="grid grid-cols-3 gap-4">
          <div>
            <label className="block text-xs text-zinc-500 uppercase tracking-wider mb-1">Parallel Group</label>
            <Input
              value={parallel}
              onChange={(e) => setParallel(e.target.value)}
              placeholder="e.g. batch-1"
              className="w-full rounded-lg border border-zinc-800 bg-zinc-800/50 px-3 py-2 text-sm text-zinc-200 placeholder-gray-600 focus:outline-none focus:border-violet-500/50"
            />
          </div>
          {stepType === 'agent' && (
          <div>
            <label className="block text-xs text-zinc-500 uppercase tracking-wider mb-1">Gate</label>
            <Select value={gate || '__none__'} onValueChange={(val) => setGate(val === '__none__' ? '' : val as 'manual' | '')}>
              <SelectTrigger className="w-full border-zinc-800 bg-zinc-800/50">
                <SelectValue placeholder="None" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">None</SelectItem>
                <SelectItem value="manual">Manual approval</SelectItem>
              </SelectContent>
            </Select>
          </div>
          )}
          <div className="flex items-end pb-2">
            <Checkbox
              checked={optional}
              onChange={setOptional}
              label="Optional (failure won't block)"
            />
          </div>
        </div>

        {stepType === 'agent' && gate === 'manual' && (
          <div className="rounded-lg border border-yellow-500/20 bg-yellow-500/5 p-3 space-y-3">
            <div className="text-xs font-semibold text-yellow-300">Gate Policy</div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <div className="text-[10px] uppercase text-zinc-500 tracking-wider mb-1.5">Notify</div>
                <div className="space-y-1">
                  <Checkbox checked={notifyHumans} onChange={setNotifyHumans} label="Humans" />
                  <Checkbox checked={notifyOperators} onChange={setNotifyOperators} label="Operators" />
                </div>
              </div>
              <div>
                <div className="text-[10px] uppercase text-zinc-500 tracking-wider mb-1.5">Can Approve</div>
                <div className="space-y-1">
                  <Checkbox checked={approveHumans} onChange={setApproveHumans} label="Humans" />
                  <Checkbox checked={approveOperators} onChange={setApproveOperators} label="Operators" />
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ── Retry Config ──────────────────────────────────── */}
        {stepType === 'agent' && (
        <div className="rounded-lg border border-zinc-700/50 bg-zinc-800/30 p-3 space-y-3">
          <div className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Retry &amp; Loop</div>

          {/* Retry on failure */}
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm text-zinc-300">Retry on failure</div>
              <div className="text-xs text-zinc-500">Auto-retry this step when it fails</div>
            </div>
            <Switch checked={retryOnFailure} onCheckedChange={setRetryOnFailure} />
          </div>

          {retryOnFailure && (
            <div className="grid grid-cols-2 gap-3 pl-1">
              <div>
                <label className="block text-[10px] text-zinc-500 uppercase tracking-wider mb-1">Max retries</label>
                <Input
                  type="number"
                  min={1}
                  max={10}
                  value={maxRetries}
                  onChange={(e) => setMaxRetries(Number(e.target.value))}
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-800/50 px-3 py-2 text-sm text-zinc-200"
                />
              </div>
              <div>
                <label className="block text-[10px] text-zinc-500 uppercase tracking-wider mb-1">Delay (ms)</label>
                <Input
                  type="number"
                  min={0}
                  step={1000}
                  value={retryDelayMs}
                  onChange={(e) => setRetryDelayMs(Number(e.target.value))}
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-800/50 px-3 py-2 text-sm text-zinc-200"
                />
              </div>
            </div>
          )}

          {/* Loop until approved */}
          <div className="flex items-center justify-between border-t border-zinc-700/50 pt-3">
            <div>
              <div className="text-sm text-zinc-300">Loop until approved</div>
              <div className="text-xs text-zinc-500">For review steps: loop back when output needs revision</div>
            </div>
            <Switch checked={loopUntilApproved} onCheckedChange={setLoopUntilApproved} />
          </div>

          {loopUntilApproved && (
            <div className="grid grid-cols-2 gap-3 pl-1">
              <div>
                <label className="block text-[10px] text-zinc-500 uppercase tracking-wider mb-1">Loop back to step</label>
                <Select value={loopBackToStep || '__none__'} onValueChange={(v) => setLoopBackToStep(v === '__none__' ? '' : v)}>
                  <SelectTrigger className="w-full border-zinc-700 bg-zinc-800/50">
                    <SelectValue placeholder="Select step…" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">Select step…</SelectItem>
                    {otherIds.map(sid => (
                      <SelectItem key={sid} value={sid}>{sid}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="block text-[10px] text-zinc-500 uppercase tracking-wider mb-1">Max iterations</label>
                <Input
                  type="number"
                  min={1}
                  max={20}
                  value={maxLoopIterations}
                  onChange={(e) => setMaxLoopIterations(Number(e.target.value))}
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-800/50 px-3 py-2 text-sm text-zinc-200"
                />
              </div>
            </div>
          )}

          {/* Tool Categories */}
          <div className="border-t border-zinc-700/50 pt-3">
            <div className="mb-2">
              <div className="text-sm text-zinc-300">Tool Categories</div>
              <div className="text-xs text-zinc-500">Restrict which tools the agent can use (empty = all tools)</div>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {TOOL_CATEGORIES.map(cat => {
                const selected = toolCategories.includes(cat);
                return (
                  <button
                    key={cat}
                    type="button"
                    onClick={() => {
                      setToolCategories(prev =>
                        selected ? prev.filter(c => c !== cat) : [...prev, cat]
                      );
                    }}
                    className={`px-2.5 py-1 rounded-md text-xs font-medium transition-all ${
                      selected
                        ? 'bg-violet-500/30 text-violet-300 border border-violet-500/50'
                        : 'bg-zinc-800/50 text-zinc-500 border border-zinc-700 hover:border-zinc-600 hover:text-zinc-400'
                    }`}
                  >
                    {cat}
                  </button>
                );
              })}
            </div>
            {toolCategories.length > 0 && (
              <button
                type="button"
                onClick={() => setToolCategories([])}
                className="mt-1.5 text-[10px] text-zinc-500 hover:text-zinc-300 transition-colors"
              >
                Clear all
              </button>
            )}
          </div>
        </div>
        )}

        <DialogFooter>
          <Button
            variant="ghost" type="button"
            onClick={onCancel}
            className="rounded-lg border border-zinc-800 px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-700/50 transition"
          >
            Cancel
          </Button>
          <Button
            variant="ghost" type="submit"
            disabled={
              !id.trim() || 
              (stepType === 'agent' && (!role.trim() || !prompt.trim())) ||
              (stepType === 'action' && !action.trim())
            }
            className="rounded-lg border border-violet-500/30 bg-violet-500/20 px-4 py-2 text-sm font-medium text-violet-300 hover:bg-violet-500/30 transition disabled:opacity-50"
          >
            {step ? 'Save' : 'Add Step'}
          </Button>
        </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ── Run Now Dialog ────────────────────────────────── */

function RunNowDialog({
  workflowId,
  workflowName,
  projects,
  onRun,
  onCancel,
}: {
  workflowId: string;
  workflowName: string;
  projects: Project[];
  onRun: (vars: Record<string, string>) => void;
  onCancel: () => void;
}) {
  const [varsText, setVarsText] = useState('');
  const [triggerRef, setTriggerRef] = useState('');
  const [runProjectId, setRunProjectId] = useState(projects[0]?.id || '');
  const [variables, setVariables] = useState<Array<{ name: string; type: string; required: boolean }>>([]);
  const [varValues, setVarValues] = useState<Record<string, string>>({});
  const [showAdvanced, setShowAdvanced] = useState(false);

  useEffect(() => {
    apiFetch<Array<{ name: string; type: string; required: boolean }>>(`/api/workflows/${workflowId}/variables`)
      .then(setVariables)
      .catch(() => {});
  }, [workflowId]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    let advancedVars: Record<string, string> = {};
    if (varsText.trim()) {
      try {
        advancedVars = JSON.parse(varsText);
      } catch {
        // Try key=value format
        for (const line of varsText.split('\n')) {
          const [k, ...v] = line.split('=');
          if (k?.trim()) advancedVars[k.trim()] = v.join('=').trim();
        }
      }
    }
    // Structured var fields take precedence over advanced textarea
    const vars = { ...advancedVars, ...varValues };
    onRun({
      ...vars,
      ...(triggerRef ? { _triggerRef: triggerRef } : {}),
      ...(runProjectId ? { _projectId: runProjectId } : {}),
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-md rounded-lg border border-zinc-800 bg-zinc-900/95 p-6 shadow-2xl space-y-4 sm:max-h-[90vh] sm:overflow-y-auto"
      >
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold text-zinc-200">Run "{workflowName}"</h3>
          <Button variant="ghost" type="button" onClick={onCancel} className="text-zinc-500 hover:text-zinc-300">
            <X className="w-5 h-5" />
          </Button>
        </div>

        {projects.length > 0 && (
          <div>
            <label className="block text-xs text-zinc-500 uppercase tracking-wider mb-1">
              Project (run context)
            </label>
            <Select value={runProjectId || '__none__'} onValueChange={(val) => setRunProjectId(val === '__none__' ? '' : val)}>
              <SelectTrigger className="w-full border-zinc-800 bg-zinc-800/50">
                <SelectValue placeholder="No project" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">No project</SelectItem>
                {projects.map((p) => (
                  <SelectItem key={p.id} value={p.id}>{p.icon || '📁'} {p.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        <div>
          <label className="block text-xs text-zinc-500 uppercase tracking-wider mb-1">
            Trigger Reference (optional)
          </label>
          <Input
            value={triggerRef}
            onChange={(e) => setTriggerRef(e.target.value)}
            placeholder="e.g. issue URL or PR reference"
            className="w-full rounded-lg border border-zinc-800 bg-zinc-800/50 px-3 py-2 text-sm text-zinc-200 placeholder-gray-600 focus:outline-none focus:border-violet-500/50"
          />
        </div>

        {variables.length > 0 && (
          <div className="space-y-3">
            <label className="block text-xs text-zinc-500 uppercase tracking-wider">
              Template Variables
            </label>
            {variables.map(v => (
              <div key={v.name}>
                <label className="block text-xs text-zinc-400 mb-1">{v.name}</label>
                <Input
                  value={varValues[v.name] || ''}
                  onChange={e => setVarValues(prev => ({ ...prev, [v.name]: e.target.value }))}
                  placeholder={v.name}
                  className="w-full rounded-lg border border-zinc-800 bg-zinc-800/50 px-3 py-2 text-sm text-zinc-200 placeholder-gray-600 focus:outline-none focus:border-violet-500/50"
                />
              </div>
            ))}
          </div>
        )}

        <div>
          <Button
            variant="ghost" type="button"
            onClick={() => setShowAdvanced(v => !v)}
            className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-300 transition"
          >
            <ChevronRight className={`w-3.5 h-3.5 transition-transform ${showAdvanced ? 'rotate-90' : ''}`} />
            Advanced (JSON / key=value)
          </Button>
          {showAdvanced && (
            <div className="mt-2">
              <Textarea
                value={varsText}
                onChange={(e) => setVarsText(e.target.value)}
                placeholder={'{"issueUrl": "https://..."}\nor\nissueUrl=https://...'}
                rows={4}
                className="w-full rounded-lg border border-zinc-800 bg-zinc-800/50 px-3 py-2 text-sm text-zinc-200 placeholder-gray-600 focus:outline-none focus:border-violet-500/50 resize-none font-mono"
              />
            </div>
          )}
        </div>

        <div className="flex justify-end gap-3 pt-2">
          <Button
            variant="ghost" type="button"
            onClick={onCancel}
            className="rounded-lg border border-zinc-800 px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-700/50 transition"
          >
            Cancel
          </Button>
          <Button
            variant="ghost" type="submit"
            className="rounded-lg border border-emerald-500/30 bg-emerald-500/20 px-4 py-2 text-sm font-medium text-emerald-300 hover:bg-emerald-500/30 transition flex items-center gap-2"
          >
            <Play className="w-4 h-4" />
            Run
          </Button>
        </div>
      </form>
    </div>
  );
}

/* ── Pipeline Visualization ────────────────────────── */

/* ── Step Detail Panel removed — uses shared StepRunModal + PipelineView ── */

/* ── Run Detail View ───────────────────────────────── */

function RunDetailView({
  run,
  workflow,
  onBack,
}: {
  run: WorkflowRun;
  workflow: WorkflowWithProjects;
  onBack: () => void;
}) {
  const [stepRuns, setStepRuns] = useState<WorkflowStepRun[]>([]);
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reworkCount, setReworkCount] = useState(0);
  const [viewMode, setViewMode] = useState<'graph' | 'list'>('graph');

  const loadStepRuns = useCallback(async () => {
    try {
      const srs = await apiFetch<WorkflowStepRun[]>(`/api/workflows/runs/${run.id}/steps`);
      setStepRuns(srs);
    } catch (err) {
      console.error('Failed to load step runs:', err);
    } finally {
      setLoading(false);
    }
  }, [run.id]);

  // Load rework count for conditional tab display
  const loadReworkCount = useCallback(async () => {
    try {
      const ctx = await apiFetch<any>(`/api/workflows/runs/${run.id}/context`);
      setReworkCount(Array.isArray(ctx?.reworks) ? ctx.reworks.length : 0);
    } catch {
      // Silently ignore — context endpoint may not exist yet
    }
  }, [run.id]);

  useEffect(() => {
    loadStepRuns();
    loadReworkCount();
  }, [loadStepRuns, loadReworkCount]);

  const stepRunMap = useMemo(() => {
    const m = new Map<string, WorkflowStepRun>();
    for (const sr of stepRuns) m.set(sr.stepId, sr);
    return m;
  }, [stepRuns]);

  const selectedStep = workflow.steps.find((s: WorkflowStep) => s.id === selectedStepId) || null;
  const selectedStepRun = selectedStepId ? stepRunMap.get(selectedStepId) || null : null;

  async function handleRetry(stepId: string, feedback: string) {
    try {
      await apiFetch(`/api/workflows/runs/${run.id}/retry/${stepId}`, {
        method: 'POST',
        body: JSON.stringify({ feedback }),
      });
      await loadStepRuns();
    } catch (err) {
      console.error('Failed to retry step:', err);
    }
  }

  async function handleApprove(stepId: string) {
    try {
      await apiFetch(`/api/workflows/runs/${run.id}/approve/${stepId}`, {
        method: 'POST',
      });
      await loadStepRuns();
    } catch (err) {
      console.error('Failed to approve step:', err);
    }
  }

  async function handleCancel() {
    try {
      await apiFetch(`/api/workflows/runs/${run.id}/cancel`, { method: 'POST' });
    } catch (err) {
      console.error('Failed to cancel run:', err);
    }
  }

  return (
    <div className="space-y-4">
      {/* Run header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <Button variant="ghost" onClick={onBack} className="text-zinc-500 hover:text-zinc-300 transition">
            <ArrowLeft className="w-4 h-4" />
          </Button>
          <h3 className="text-sm font-semibold text-zinc-100">
            Run {run.id.slice(0, 8)}
          </h3>
          <Badge className={`text-[10px] px-2 py-0.5 rounded-full border ${RUN_STATUS_STYLES[run.status] || ''}`}>
            {run.status}
          </Badge>
        </div>
        <div className="flex items-center gap-2 text-xs text-zinc-500">
          <span>Trigger: {run.triggerType}</span>
          {run.triggerRef && <span>· {run.triggerRef}</span>}
          <span>· {relativeTime(run.createdAt)}</span>
          <span>· {duration(run.createdAt, run.completedAt)}</span>
          {(run.status === 'running' || run.status === 'paused') && (
            <Button
              variant="ghost" onClick={handleCancel}
              className="flex items-center gap-1 rounded-lg border border-red-500/30 bg-red-500/10 px-2 py-1 text-xs text-red-400 hover:bg-red-500/20 transition"
            >
              <Ban className="w-3 h-3" />
              Cancel
            </Button>
          )}
        </div>
      </div>

      {/* Tabbed run detail */}
      <Tabs defaultValue="pipeline">
        <TabsList>
          <TabsTrigger value="pipeline">Pipeline</TabsTrigger>
          <TabsTrigger value="thread">Collaboration</TabsTrigger>
          {reworkCount > 0 && (
            <TabsTrigger value="reworks">
              Rework History
              <span className="ml-1.5 px-1.5 py-0.5 text-[10px] rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/30">
                {reworkCount}
              </span>
            </TabsTrigger>
          )}
        </TabsList>

        {/* Tab 1: Pipeline */}
        <TabsContent value="pipeline">
          {loading ? (
            <LoadingState size="sm" message="Loading steps…" />
          ) : (
            <div className="space-y-3">
              {/* View toggle */}
              <div className="flex items-center gap-1 p-0.5 rounded-lg bg-zinc-800/50 border border-zinc-800 w-fit">
                <button
                  onClick={() => setViewMode('graph')}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                    viewMode === 'graph'
                      ? 'bg-zinc-700 text-zinc-100 shadow-sm'
                      : 'text-zinc-500 hover:text-zinc-300'
                  }`}
                >
                  <GitBranch className="w-3.5 h-3.5" />
                  Graph view
                </button>
                <button
                  onClick={() => setViewMode('list')}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                    viewMode === 'list'
                      ? 'bg-zinc-700 text-zinc-100 shadow-sm'
                      : 'text-zinc-500 hover:text-zinc-300'
                  }`}
                >
                  <LayoutList className="w-3.5 h-3.5" />
                  List view
                </button>
              </div>

              {/* Graph view */}
              {viewMode === 'graph' && (
                <WorkflowDAG
                  steps={workflow.steps}
                  runId={run.id}
                  stepRuns={stepRuns}
                  selectedStepId={selectedStepId}
                  onSelectStep={setSelectedStepId}
                  isRunning={run.status === 'running' || run.status === 'paused'}
                />
              )}

              {/* List view */}
              {viewMode === 'list' && (
                <PipelineView
                  steps={workflow.steps}
                  stepRuns={stepRuns}
                  selectedStepId={selectedStepId}
                  onSelectStep={setSelectedStepId}
                  vertical
                />
              )}
            </div>
          )}
        </TabsContent>

        {/* Tab 2: Collaboration thread */}
        <TabsContent value="thread">
          <CollaborationThread runId={run.id} />
        </TabsContent>

        {/* Tab 3: Rework history (conditional) */}
        {reworkCount > 0 && (
          <TabsContent value="reworks">
            <ReworkHistory runId={run.id} />
          </TabsContent>
        )}
      </Tabs>

      {/* Selected step detail modal */}
      {selectedStep && (
        <StepRunModal
          step={{
            id: selectedStepRun?.id || selectedStep.id,
            runId: run.id,
            stepId: selectedStep.id,
            role: selectedStep.role,
            agentName: selectedStepRun?.agentName || null,
            taskId: selectedStepRun?.taskId || null,
            status: selectedStepRun?.status || 'pending',
            input: selectedStepRun?.input || null,
            output: selectedStepRun?.output || null,
            sharedRefs: selectedStepRun?.sharedRefs || [],
            startedAt: selectedStepRun?.startedAt || null,
            completedAt: selectedStepRun?.completedAt || null,
            gate: selectedStep.gate,
            optional: selectedStep.optional,
            waitFor: selectedStep.waitFor,
            prompt: selectedStep.prompt,
          }}
          onAction={loadStepRuns}
          onClose={() => setSelectedStepId(null)}
          showPrompt
        />
      )}
    </div>
  );
}

/* ── Main Page ─────────────────────────────────────── */

export default function WorkflowDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const { data: workflowRaw, isLoading: loading, isError, refetch: refetchWorkflow } = useWorkflow(id);
  const workflow = useMemo<WorkflowWithProjects | null>(() => {
    if (!workflowRaw) return null;
    const wf = { ...(workflowRaw as WorkflowWithProjects) };
    if (typeof wf.steps === 'string') {
      try { wf.steps = JSON.parse(wf.steps as any); } catch { wf.steps = []; }
    }
    if (!Array.isArray(wf.steps)) wf.steps = [];
    return wf;
  }, [workflowRaw]);
  const error = isError ? 'Failed to load workflow' : '';
  const [allProjects, setAllProjects] = useState<Project[]>([]);
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [stats, setStats] = useState<WorkflowStats | null>(null);

  // Inline edit state for workflow metadata + projects
  const [editProjectIds, setEditProjectIds] = useState<string[] | null>(null); // null = not editing
  const [savingProjects, setSavingProjects] = useState(false);

  // Dialog state
  const [editingStep, setEditingStep] = useState<WorkflowStep | null | undefined>(undefined); // undefined=closed, null=creating
  const [showRunNow, setShowRunNow] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [selectedRun, setSelectedRun] = useState<WorkflowRun | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    if (!id) return;
    try {
      const [wfRuns, projs, wfStats] = await Promise.all([
        apiFetch<WorkflowRun[]>(`/api/workflows/${id}/runs`),
        apiFetch<Project[]>('/api/projects'),
        apiFetch<WorkflowStats>(`/api/workflows/${id}/stats`).catch(() => null),
      ]);
      setRuns(wfRuns);
      setAllProjects(projs);
      setStats(wfStats);
    } catch (err: any) {
      console.error('Failed to load workflow data:', err);
    }
  }, [id]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const projectMap = useMemo(() => {
    const m = new Map<string, Project>();
    for (const p of allProjects) m.set(p.id, p);
    return m;
  }, [allProjects]);

  // Resolved project IDs for current workflow
  const currentProjectIds = workflow ? getProjectIds(workflow) : [];

  // Projects assigned to this workflow (for Run Now dialog filtering)
  const assignedProjects = useMemo(() => {
    return currentProjectIds
      .map((pid) => projectMap.get(pid))
      .filter((p): p is Project => !!p);
  }, [currentProjectIds, projectMap]);

  async function handleToggleEnabled() {
    if (!workflow) return;
    try {
      await apiFetch<WorkflowWithProjects>(`/api/workflows/${workflow.id}`, {
        method: 'PUT',
        body: JSON.stringify({ enabled: !workflow.enabled }),
      });
      refetchWorkflow();
    } catch (err: any) {
      setToast(`Failed: ${err.message}`);
      setTimeout(() => setToast(null), 4000);
    }
  }

  async function handleSaveProjects() {
    if (!workflow || editProjectIds === null) return;
    setSavingProjects(true);
    try {
      await apiFetch<WorkflowWithProjects>(`/api/workflows/${workflow.id}`, {
        method: 'PUT',
        body: JSON.stringify({ projectIds: editProjectIds }),
      });
      refetchWorkflow();
      setEditProjectIds(null);
      setToast('Projects updated');
      setTimeout(() => setToast(null), 3000);
    } catch (err: any) {
      setToast(`Failed: ${err.message}`);
      setTimeout(() => setToast(null), 4000);
    } finally {
      setSavingProjects(false);
    }
  }

  async function handleSaveStep(step: WorkflowStep) {
    if (!workflow) return;
    const isEditing = editingStep !== null && editingStep !== undefined;
    let newSteps: WorkflowStep[];
    if (isEditing) {
      newSteps = workflow.steps.map((s: WorkflowStep) => (s.id === step.id ? step : s));
    } else {
      newSteps = [...workflow.steps, step];
    }

    try {
      await apiFetch<WorkflowWithProjects>(`/api/workflows/${workflow.id}`, {
        method: 'PUT',
        body: JSON.stringify({ steps: newSteps }),
      });
      refetchWorkflow();
      setEditingStep(undefined);
    } catch (err: any) {
      setToast(`Failed: ${err.message}`);
      setTimeout(() => setToast(null), 4000);
    }
  }

  async function handleDeleteStep(stepId: string) {
    if (!workflow) return;
    const newSteps = workflow.steps.filter((s: WorkflowStep) => s.id !== stepId);
    // Also remove from waitFor of other steps
    const cleaned = newSteps.map((s: WorkflowStep) => ({
      ...s,
      waitFor: s.waitFor?.filter((w: string) => w !== stepId),
    }));

    try {
      await apiFetch<WorkflowWithProjects>(`/api/workflows/${workflow.id}`, {
        method: 'PUT',
        body: JSON.stringify({ steps: cleaned }),
      });
      refetchWorkflow();
    } catch (err: any) {
      setToast(`Failed: ${err.message}`);
      setTimeout(() => setToast(null), 4000);
    }
  }

  async function handleRunNow(vars: Record<string, string>) {
    if (!workflow) return;
    const triggerRef = vars._triggerRef || null;
    const projectId = vars._projectId || null;
    const cleanVars = { ...vars };
    delete cleanVars._triggerRef;
    delete cleanVars._projectId;

    try {
      await apiFetch(`/api/workflows/${workflow.id}/run`, {
        method: 'POST',
        body: JSON.stringify({
          triggerType: 'manual',
          triggerRef,
          projectId,
          vars: Object.keys(cleanVars).length > 0 ? cleanVars : undefined,
        }),
      });
      setShowRunNow(false);
      // Reload runs
      const wfRuns = await apiFetch<WorkflowRun[]>(`/api/workflows/${workflow.id}/runs`);
      setRuns(wfRuns);
      setToast('Workflow started!');
      setTimeout(() => setToast(null), 3000);
    } catch (err: any) {
      setToast(`Failed: ${err.message}`);
      setTimeout(() => setToast(null), 4000);
    }
  }

  async function handleDelete() {
    if (!workflow) return;
    try {
      await apiFetch(`/api/workflows/${workflow.id}`, { method: 'DELETE' });
      navigate('/workflows');
    } catch (err: any) {
      setToast(`Failed: ${err.message}`);
      setTimeout(() => setToast(null), 4000);
    }
  }

  if (loading) {
    return <LoadingState message="Loading workflow…" />;
  }

  if (error || !workflow) {
    return (
      <div className="text-center py-12">
        <p className="text-red-400">{error || 'Workflow not found'}</p>
        <Link to="/workflows" className="text-sm text-violet-400 hover:text-violet-300 mt-2 inline-block">
          ← Back to Workflows
        </Link>
      </div>
    );
  }

  // If a run is selected, show run detail view
  if (selectedRun) {
    return (
      <div className="space-y-6">
        <Link to="/workflows" className="text-sm text-zinc-500 hover:text-zinc-300">← Workflows</Link>
        <RunDetailView
          run={selectedRun}
          workflow={workflow}
          onBack={() => {
            setSelectedRun(null);
            loadData(); // Refresh data
          }}
        />
      </div>
    );
  }

  const isEditingProjects = editProjectIds !== null;

  return (
    <div className="space-y-6">
      {/* Toast */}
      {toast && (
        <div className="fixed top-4 right-4 z-50 px-4 py-2 rounded-lg bg-zinc-800 border border-zinc-800 text-sm text-zinc-200 shadow-xl">
          {toast}
        </div>
      )}

      {/* Back */}
      <Link to="/workflows" className="text-sm text-zinc-500 hover:text-zinc-300">← Workflows</Link>

      {/* Header */}
      <PageHeader icon={WorkflowIcon} title={workflow.name} subtitle={workflow.description || undefined}>
        <Button
          variant="ghost" onClick={handleToggleEnabled}
          className={`flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm transition ${
            workflow.enabled
              ? 'border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10'
              : 'border-zinc-800 text-zinc-500 hover:bg-zinc-700/50'
          }`}
        >
          {workflow.enabled ? <Power className="w-4 h-4" /> : <PowerOff className="w-4 h-4" />}
          {workflow.enabled ? 'Enabled' : 'Disabled'}
        </Button>
        <Button
          variant="ghost" onClick={() => setShowRunNow(true)}
          className="flex items-center gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/20 px-4 py-2 text-sm font-medium text-emerald-300 hover:bg-emerald-500/30 transition"
        >
          <Play className="w-4 h-4" />
          Run Now
        </Button>
        <Button
          variant="ghost" onClick={() => setConfirmDelete(true)}
          className="flex items-center gap-1.5 rounded-lg border border-red-500/20 px-3 py-2 text-sm text-red-400 hover:bg-red-500/10 transition"
        >
          <Trash2 className="w-4 h-4" />
        </Button>
      </PageHeader>

      {/* Projects Section — inline editable */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-5">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider">
            Projects
          </h2>
          {!isEditingProjects ? (
            <Button
              variant="ghost" onClick={() => setEditProjectIds([...currentProjectIds])}
              className="flex items-center gap-1.5 rounded-lg border border-zinc-800 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700/50 transition"
            >
              <Pencil className="w-3.5 h-3.5" />
              Edit
            </Button>
          ) : (
            <div className="flex gap-2">
              <Button
                variant="ghost" onClick={() => setEditProjectIds(null)}
                className="rounded-lg border border-zinc-800 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700/50 transition"
              >
                Cancel
              </Button>
              <Button
                variant="ghost" onClick={handleSaveProjects}
                disabled={savingProjects}
                className="flex items-center gap-1.5 rounded-lg border border-violet-500/30 bg-violet-500/20 px-3 py-1.5 text-xs font-medium text-violet-300 hover:bg-violet-500/30 transition disabled:opacity-50"
              >
                <Save className="w-3.5 h-3.5" />
                {savingProjects ? 'Saving…' : 'Save'}
              </Button>
            </div>
          )}
        </div>

        {isEditingProjects ? (
          /* Edit mode: checkboxes */
          allProjects.length === 0 ? (
            <p className="text-xs text-zinc-600">No projects available</p>
          ) : (
            <div className="rounded-lg border border-zinc-800 bg-zinc-800/50 p-2 space-y-1 max-h-48 overflow-y-auto">
              {allProjects.map((p) => (
                <Checkbox
                  key={p.id}
                  checked={editProjectIds.includes(p.id)}
                  onChange={() =>
                    setEditProjectIds((prev) =>
                      prev!.includes(p.id) ? prev!.filter((x) => x !== p.id) : [...prev!, p.id],
                    )
                  }
                  className="px-1 py-0.5 rounded hover:bg-zinc-800/50"
                >
                  <span className="flex items-center gap-2 text-sm text-zinc-300">
                    <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: p.color }} />
                    {p.icon || '📁'} {p.name}
                  </span>
                </Checkbox>
              ))}
            </div>
          )
        ) : (
          /* Display mode: tags */
          <div className="flex items-center gap-1.5 flex-wrap">
            {currentProjectIds.length === 0 ? (
              <span className="text-xs text-zinc-600">No projects assigned</span>
            ) : (
              currentProjectIds.map((pid) => {
                const proj = projectMap.get(pid);
                const color = proj?.color || '#6b7280';
                return (
                  <span
                    key={pid}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-sm text-zinc-300"
                    style={{ backgroundColor: color + '20' }}
                  >
                    <span className="w-2 h-2 rounded-full" style={{ backgroundColor: color }} />
                    {proj?.icon || '📁'} {proj?.name || pid}
                  </span>
                );
              })
            )}
          </div>
        )}
      </div>

      {/* Stats Section */}
      {stats && stats.totalRuns > 0 && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-5 space-y-4">
          <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider">Run Statistics</h2>

          {/* Stat cards */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="bg-zinc-800/50 rounded-lg border border-zinc-800 p-4">
              <p className="text-xs text-zinc-400 mb-1">Total Runs</p>
              <p className="text-2xl font-bold text-white">{stats.totalRuns}</p>
            </div>
            <div className="bg-zinc-800/50 rounded-lg border border-zinc-800 p-4">
              <p className="text-xs text-zinc-400 mb-1">Success Rate</p>
              <p className={`text-2xl font-bold ${stats.successRate >= 80 ? 'text-emerald-400' : stats.successRate >= 50 ? 'text-amber-400' : 'text-red-400'}`}>
                {stats.successRate}%
              </p>
            </div>
            <div className="bg-zinc-800/50 rounded-lg border border-zinc-800 p-4">
              <p className="text-xs text-zinc-400 mb-1">Avg Duration</p>
              <p className="text-2xl font-bold text-white">
                {stats.avgDurationMs != null ? duration(new Date(Date.now() - stats.avgDurationMs).toISOString(), new Date().toISOString()) : '—'}
              </p>
            </div>
            <div className="bg-zinc-800/50 rounded-lg border border-zinc-800 p-4">
              <p className="text-xs text-zinc-400 mb-1">Failed</p>
              <p className={`text-2xl font-bold ${stats.failCount > 0 ? 'text-red-400' : 'text-zinc-400'}`}>{stats.failCount}</p>
            </div>
          </div>

          {/* Sparkline */}
          {stats.recentRuns?.length > 1 && (
            <div>
              <p className="text-xs text-zinc-500 mb-2">Recent run durations (last {stats.recentRuns?.length})</p>
              <div className="flex items-end gap-1 h-12">
                {(() => {
                  const maxMs = Math.max(...stats.recentRuns.map(r => r.durationMs ?? 0), 1);
                  return stats.recentRuns.map((r, i) => {
                    const heightPct = r.durationMs != null ? Math.max(4, Math.round((r.durationMs / maxMs) * 100)) : 4;
                    const barColor =
                      r.status === 'completed' ? 'bg-emerald-500' :
                      r.status === 'failed' ? 'bg-red-500' :
                      r.status === 'cancelled' ? 'bg-zinc-600' : 'bg-blue-500';
                    return (
                      <div key={i} className="flex-1 flex flex-col items-center justify-end h-full group relative">
                        <div
                          className={`w-full rounded-sm ${barColor} opacity-70 group-hover:opacity-100 transition-opacity`}
                          style={{ height: `${heightPct}%` }}
                        />
                        <div className="absolute bottom-full mb-1 left-1/2 -translate-x-1/2 hidden group-hover:flex bg-zinc-800 text-xs text-zinc-200 px-2 py-1 rounded shadow-lg whitespace-nowrap z-10">
                          {r.durationMs != null
                            ? duration(new Date(Date.now() - r.durationMs).toISOString(), new Date().toISOString())
                            : '—'}
                          {' · '}{r.status}
                        </div>
                      </div>
                    );
                  });
                })()}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Steps Section */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider">
            Steps ({workflow.steps.length})
          </h2>
          <Button
            variant="ghost" onClick={() => setEditingStep(null)}
            className="flex items-center gap-1.5 rounded-lg border border-zinc-800 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700/50 transition"
          >
            <Plus className="w-3.5 h-3.5" />
            Add Step
          </Button>
        </div>

        {workflow.steps.length === 0 ? (
          <div className="text-center py-6 text-zinc-600 text-sm">
            No steps yet. Add steps to define your workflow pipeline.
          </div>
        ) : (
          <div className="space-y-2">
            {workflow.steps.map((step: WorkflowStep, idx: number) => (
              <div
                key={step.id}
                className="flex items-center justify-between gap-3 rounded-lg border border-zinc-800 bg-zinc-900/50 px-4 py-3 hover:bg-zinc-900/50 transition group"
              >
                <div className="flex items-center gap-3 min-w-0 flex-1">
                  <span className="text-[10px] text-zinc-600 font-mono w-5 shrink-0">{idx + 1}</span>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-zinc-200">{step.id}</span>
                      {step.role && <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800/50 text-zinc-500">{step.role}</span>}
                      {step.gate === 'manual' && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-yellow-500/10 text-yellow-400 border border-yellow-500/20">
                          manual gate
                        </span>
                      )}
                      {step.optional && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800/50 text-zinc-500">optional</span>
                      )}
                    </div>
                    {step.prompt && (
                      <p className="text-xs text-zinc-500 truncate max-w-md mt-0.5">
                        {step.prompt?.slice(0, 80)}{step.prompt?.length > 80 ? '…' : ''}
                      </p>
                    )}
                    {step.waitFor && step.waitFor.length > 0 && (
                      <p className="text-[10px] text-zinc-600 mt-0.5">
                        depends on: {step.waitFor.join(', ')}
                      </p>
                    )}
                  </div>
                </div>
                <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition shrink-0">
                  <Button
                    variant="ghost" onClick={() => setEditingStep(step)}
                    className="p-1.5 rounded hover:bg-zinc-700/50 text-zinc-500 hover:text-zinc-300 transition"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </Button>
                  <Button
                    variant="ghost" onClick={() => handleDeleteStep(step.id)}
                    className="p-1.5 rounded hover:bg-red-500/10 text-zinc-500 hover:text-red-400 transition"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Runs Section */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-5">
        <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider mb-4">
          Recent Runs ({runs.length})
        </h2>

        {runs.length === 0 ? (
          <div className="text-center py-6 text-zinc-600 text-sm">
            No runs yet. Click "Run Now" to start one.
          </div>
        ) : (
          <div className="space-y-2">
            {runs.map((run) => (
              <Button
                variant="ghost" key={run.id}
                onClick={() => setSelectedRun(run)}
                className="w-full flex items-center justify-between gap-3 rounded-lg border border-zinc-800 bg-zinc-900/50 px-4 py-3 hover:bg-zinc-800/50 transition text-left"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <Badge className={`text-[10px] px-2 py-0.5 rounded-full border ${RUN_STATUS_STYLES[run.status] || ''}`}>
                    {run.status}
                  </Badge>
                  <span className="text-xs text-zinc-400 font-mono">{run.id.slice(0, 8)}</span>
                  <span className="text-xs text-zinc-500">{run.triggerType}</span>
                  {run.triggerRef && (
                    <span className="text-xs text-zinc-600 truncate max-w-[200px]">{run.triggerRef}</span>
                  )}
                </div>
                <div className="flex items-center gap-3 text-xs text-zinc-500 shrink-0">
                  <span>{duration(run.createdAt, run.completedAt)}</span>
                  <span>{relativeTime(run.createdAt)}</span>
                  <ChevronRight className="w-3.5 h-3.5" />
                </div>
              </Button>
            ))}
          </div>
        )}
      </div>

      {/* Dialogs */}
      {editingStep !== undefined && (
        <StepEditorDialog
          step={editingStep}
          allStepIds={workflow.steps.map((s: WorkflowStep) => s.id)}
          projectIds={getProjectIds(workflow)}
          onSave={handleSaveStep}
          onCancel={() => setEditingStep(undefined)}
        />
      )}

      {showRunNow && (
        <RunNowDialog
          workflowId={workflow.id}
          workflowName={workflow.name}
          projects={assignedProjects.length > 0 ? assignedProjects : allProjects}
          onRun={handleRunNow}
          onCancel={() => setShowRunNow(false)}
        />
      )}

      <ConfirmDialog
        open={confirmDelete}
        title="Delete Workflow"
        message={`Are you sure you want to delete "${workflow.name}"? This cannot be undone.`}
        confirmLabel="Delete"
        destructive
        onConfirm={handleDelete}
        onCancel={() => setConfirmDelete(false)}
      />
    </div>
  );
}
