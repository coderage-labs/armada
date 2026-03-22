import { humanize } from '../i18n';
/**
 * Shared step run detail component — used by both Operations and WorkflowDetail pages.
 * Shows step metadata, timing, input, output, shared refs, and action buttons.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from './ui/button';
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle,
  AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction,
} from './ui/alert-dialog';
import {
  CheckCircle2, XCircle, RotateCcw, ChevronDown, ChevronRight,
  ExternalLink, Send, User,
} from 'lucide-react';
import { apiFetch } from '../hooks/useApi';
import { useAuth } from '../hooks/useAuth';
import { useUsers, resolveUser } from '../hooks/useUsers';
import AgentAvatar from './AgentAvatar';
import { Badge } from './ui/badge';
import { Input } from './ui/input';

/* ── Types ─────────────────────────────────────────── */

export interface StepRunData {
  id: string;
  runId: string;
  stepId: string;
  role: string;
  agentName: string | null;
  taskId: string | null;
  status: string;
  input: any | null;
  output: string | null;
  sharedRefs: string[];
  startedAt: string | null;
  completedAt: string | null;
  // Optional enrichment
  gate?: 'manual';
  optional?: boolean;
  waitFor?: string[];
  prompt?: string;
}

interface Props {
  step: StepRunData;
  onAction: () => void;
  /** Show the static prompt (from workflow step definition) */
  showPrompt?: boolean;
}

/* ── Helpers ───────────────────────────────────────── */

function LiveDuration({ start, end }: { start: string | null; end: string | null }) {
  const [, setTick] = useState(0);

  // Re-render every second if still running
  if (start && !end) {
    setTimeout(() => setTick(t => t + 1), 1000);
  }

  if (!start) return <span>—</span>;
  const from = new Date(start).getTime();
  const to = end ? new Date(end).getTime() : Date.now();
  const secs = Math.floor((to - from) / 1000);
  if (secs < 60) return <span>{secs}s</span>;
  if (secs < 3600) return <span>{Math.floor(secs / 60)}m {secs % 60}s</span>;
  return <span>{Math.floor(secs / 3600)}h {Math.floor((secs % 3600) / 60)}m</span>;
}

const STATUS_DOT: Record<string, string> = {
  pending: 'bg-zinc-500',
  running: 'bg-blue-400 animate-pulse',
  completed: 'bg-emerald-400',
  failed: 'bg-red-400',
  waiting_gate: 'bg-amber-400 animate-pulse',
};

const STATUS_COLOR: Record<string, string> = {
  pending: 'border-zinc-500/40 bg-zinc-500/10 text-zinc-400',
  running: 'border-blue-500/40 bg-blue-500/10 text-blue-300',
  completed: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300',
  failed: 'border-red-500/40 bg-red-500/10 text-red-300',
  waiting_gate: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
};

/* ── Component ─────────────────────────────────────── */

/** Parse gate resolution from output text, e.g. "✅ Approved by Chris" */
function parseGateResolution(output: string | null): { resolved: true; approved: boolean; by: string } | null {
  if (!output) return null;
  const approveMatch = output.match(/✅ Approved by (.+)/);
  if (approveMatch) return { resolved: true, approved: true, by: approveMatch[1].trim() };
  const rejectMatch = output.match(/❌ Rejected by (.+)/);
  if (rejectMatch) return { resolved: true, approved: false, by: rejectMatch[1].trim() };
  return null;
}

/** User chip component — shows avatar + display name */
function UserChip({ name, approved }: { name: string; by?: string; approved?: boolean }) {
  const resolved = resolveUser(name);
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs px-2 py-0.5 rounded-full border ${
      approved
        ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/20'
        : 'bg-red-500/15 text-red-300 border-red-500/20'
    }`}>
      {resolved.avatar ? (
        <img src={resolved.avatar} alt={resolved.displayName} className="w-3.5 h-3.5 rounded-full object-cover" />
      ) : (
        <User className="w-3 h-3 opacity-60" />
      )}
      {resolved.displayName}
    </span>
  );
}

export default function StepRunDetail({ step, onAction, showPrompt }: Props) {
  const [feedback, setFeedback] = useState('');
  const [steerMsg, setSteerMsg] = useState('');
  const [showOutput, setShowOutput] = useState(true);
  const [showInput, setShowInput] = useState(true);
  const [acting, setActing] = useState(false);

  const { user: authUser } = useAuth();
  // Pre-warm the users cache so resolveUser() has data
  useUsers();

  async function handleApprove() {
    setActing(true);
    try {
      await apiFetch(`/api/workflows/runs/${step.runId}/approve/${step.stepId}`, {
        method: 'POST',
        body: JSON.stringify({ resolvedBy: authUser?.displayName || authUser?.name }),
      });
      onAction();
    } catch (err) {
      console.error('Approve failed:', err);
    } finally {
      setActing(false);
    }
  }

  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState('');

  async function handleReject() {
    setActing(true);
    try {
      await apiFetch(`/api/workflows/runs/${step.runId}/reject/${step.stepId}`, {
        method: 'POST',
        body: JSON.stringify({ reason: rejectReason || 'Rejected via UI' }),
      });
      setRejectOpen(false);
      setRejectReason('');
      onAction();
    } catch (err) {
      console.error('Reject failed:', err);
    } finally {
      setActing(false);
    }
  }

  async function handleRetry() {
    setActing(true);
    try {
      await apiFetch(`/api/workflows/runs/${step.runId}/retry/${step.stepId}`, {
        method: 'POST',
        body: JSON.stringify({ feedback }),
      });
      setFeedback('');
      onAction();
    } catch (err) {
      console.error('Retry failed:', err);
    } finally {
      setActing(false);
    }
  }

  async function handleSteer() {
    if (!step.taskId || !steerMsg.trim()) return;
    setActing(true);
    try {
      await apiFetch(`/api/tasks/${step.taskId}/steer`, {
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

  // Resolve input display — hide empty objects
  const rawInput = step.input
    ? typeof step.input === 'string'
      ? step.input
      : step.input?.prompt || null
    : null;
  const inputText = rawInput && rawInput.trim() ? rawInput : null;

  return (
    <div className="rounded-xl border border-zinc-700 bg-zinc-900/50 p-4 space-y-3 animate-[fadeIn_200ms_ease-out]">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${STATUS_DOT[step.status] || 'bg-zinc-500'}`} />
          <h4 className="text-sm font-semibold text-zinc-100">{humanize(step.stepId, 'steps')}</h4>
          <Badge className={`text-[10px] px-2 py-0.5 rounded-full border ${STATUS_COLOR[step.status] || ''}`}>
            {step.status}
          </Badge>
          <span className="text-[10px] text-zinc-600">{step.role}</span>
          {step.gate === 'manual' && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300">gate</span>
          )}
          {step.optional && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-500/20 text-zinc-400">optional</span>
          )}
        </div>
      </div>

      {/* Timing */}
      <div className="grid grid-cols-3 gap-3 text-xs">
        <div>
          <span className="text-zinc-600">Started</span>
          <div className="text-zinc-300">{step.startedAt ? new Date(step.startedAt).toLocaleTimeString() : '—'}</div>
        </div>
        <div>
          <span className="text-zinc-600">Duration</span>
          <div className="text-zinc-300"><LiveDuration start={step.startedAt} end={step.completedAt} /></div>
        </div>
        <div>
          <span className="text-zinc-600">Completed</span>
          <div className="text-zinc-300">{step.completedAt ? new Date(step.completedAt).toLocaleTimeString() : '—'}</div>
        </div>
      </div>

      {/* Agent + Task */}
      <div className="flex items-center gap-3 text-xs">
        {step.agentName && (
          <Link to={`/agents/${step.agentName}`} className="flex items-center gap-1.5 text-zinc-300 hover:text-violet-300 transition">
            <AgentAvatar name={step.agentName} size="xs" />
            <span>{step.agentName}</span>
            <ExternalLink className="w-3 h-3 opacity-50" />
          </Link>
        )}
        {step.taskId && (
          <span className="text-zinc-600 font-mono">task: {step.taskId.slice(0, 8)}</span>
        )}
      </div>

      {/* Dependencies */}
      {step.waitFor && step.waitFor.length > 0 && (
        <div className="text-xs">
          <span className="text-zinc-600">Depends on: </span>
          <span className="text-zinc-400">{step.waitFor.join(', ')}</span>
        </div>
      )}

      {/* Prompt (static workflow step definition) */}
      {showPrompt && step.prompt && (
        <div>
          <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">Prompt</div>
          <pre className="max-h-24 overflow-auto rounded-lg bg-black/30 p-2 text-xs text-zinc-500 font-mono whitespace-pre-wrap">
            {step.prompt}
          </pre>
        </div>
      )}

      {/* Input (resolved prompt sent to agent) */}
      {inputText && (
        <div>
          <Button
           variant="ghost"
            size="sm"
            onClick={() => setShowInput(!showInput)}
            className="flex items-center gap-1 h-auto text-[10px] text-zinc-500 uppercase tracking-wider mb-1 px-0 py-0 hover:bg-transparent hover:text-zinc-300"
          >
            {showInput ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            Input
          </Button>
          {showInput && (
            <pre className="max-h-32 overflow-auto rounded-lg bg-black/30 p-2 text-xs text-zinc-500 font-mono whitespace-pre-wrap">
              {inputText}
            </pre>
          )}
        </div>
      )}

      {/* Output */}
      {step.output && (() => {
        const gateRes = step.gate === 'manual' ? parseGateResolution(step.output) : null;
        if (gateRes) {
          // Gate resolution — show a user chip instead of raw output
          return (
            <div className="flex items-center gap-2 text-xs text-zinc-400">
              <span>{gateRes.approved ? '✅ Approved by' : '❌ Rejected by'}</span>
              <UserChip name={gateRes.by} approved={gateRes.approved} />
            </div>
          );
        }
        return (
          <div>
            <Button
             variant="ghost"
              size="sm"
              onClick={() => setShowOutput(!showOutput)}
              className="flex items-center gap-1 h-auto text-[10px] text-zinc-500 uppercase tracking-wider mb-1 px-0 py-0 hover:bg-transparent hover:text-zinc-300"
            >
              {showOutput ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
              Output
            </Button>
            {showOutput && (
              <pre className="max-h-48 overflow-auto rounded-lg bg-black/30 p-2 text-xs text-zinc-400 font-mono whitespace-pre-wrap">
                {step.output}
              </pre>
            )}
          </div>
        );
      })()}

      {/* Shared refs */}
      {step.sharedRefs?.length > 0 && (
        <div>
          <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">Shared Files</div>
          <div className="flex flex-wrap gap-1">
            {step.sharedRefs.map((ref, i) => (
              <span key={i} className="text-[10px] px-2 py-0.5 rounded bg-zinc-800/50 text-zinc-400 font-mono">{ref}</span>
            ))}
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="flex flex-wrap gap-2 pt-1">
        {step.status === 'waiting_gate' && (
          <>
            <Button
             variant="secondary"
              size="sm"
              onClick={handleApprove}
              disabled={acting}
              className="bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30 border-emerald-500/30"
            >
              <CheckCircle2 className="w-3.5 h-3.5" />
              Approve
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setRejectOpen(true)}
              disabled={acting}
            >
              <XCircle className="w-3.5 h-3.5" />
              Reject
            </Button>
            <AlertDialog open={rejectOpen} onOpenChange={setRejectOpen}>
              <AlertDialogContent className="bg-zinc-900 border-zinc-700">
                <AlertDialogHeader>
                  <AlertDialogTitle className="text-zinc-100">Reject this gate?</AlertDialogTitle>
                  <AlertDialogDescription className="text-zinc-400">
                    This will fail the workflow run. You can optionally provide a reason.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <Input
                  placeholder="Reason (optional)"
                  value={rejectReason}
                  onChange={(e) => setRejectReason(e.target.value)}
                  className="bg-zinc-800 border-zinc-700 text-zinc-200"
                />
                <AlertDialogFooter>
                  <AlertDialogCancel className="bg-zinc-800 border-zinc-700 text-zinc-300 hover:bg-zinc-700">Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={handleReject}
                    className="bg-red-600 hover:bg-red-700 text-white"
                    disabled={acting}
                  >
                    {acting ? 'Rejecting...' : 'Reject'}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </>
        )}
        {(step.status === 'completed' || step.status === 'failed') && step.gate !== 'manual' && (
          <div className="flex-1 space-y-2">
            <div className="flex gap-2">
              <Input
                value={feedback}
                onChange={e => setFeedback(e.target.value)}
                placeholder="Feedback for retry…"
                className="flex-1 rounded-lg border border-zinc-700 bg-zinc-800/50 px-2 py-1.5 text-xs text-zinc-200 placeholder-gray-600 focus:outline-none focus:border-violet-500/50"
              />
              <Button
               variant="secondary"
                size="sm"
                onClick={handleRetry}
                disabled={acting}
                className="bg-amber-500/20 text-amber-300 hover:bg-amber-500/30 border-amber-500/30"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                Retry
              </Button>
            </div>
          </div>
        )}
        {step.status === 'running' && step.taskId && (
          <div className="flex-1 flex gap-2">
            <Input
              value={steerMsg}
              onChange={e => setSteerMsg(e.target.value)}
              placeholder="Send message to agent…"
              className="flex-1 rounded-lg border border-zinc-700 bg-zinc-800/50 px-2 py-1.5 text-xs text-zinc-200 placeholder-gray-600 focus:outline-none focus:border-violet-500/50"
              onKeyDown={e => e.key === 'Enter' && handleSteer()}
            />
            <Button
             variant="secondary"
              size="icon"
              onClick={handleSteer}
              disabled={acting || !steerMsg.trim()}
              className="h-7 w-7 bg-blue-500/20 text-blue-300 hover:bg-blue-500/30 border-blue-500/30"
            >
              <Send className="w-3.5 h-3.5" />
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
