/**
 * WorkflowStepOutput — shows completed workflow step outputs inside the task detail panel.
 * Fetches the run context (all steps + outputs) via /api/workflows/runs/:runId/context
 * and renders each completed step's output as a collapsible card with basic markdown formatting.
 */
import { useState, useEffect } from 'react';
import { ChevronDown, ChevronRight, CheckCircle2, XCircle, SkipForward, Clock, Bot } from 'lucide-react';
import { apiFetch } from '../hooks/useApi';
import { Badge } from './ui/badge';
import AgentAvatar from './AgentAvatar';

/* ── Types ──────────────────────────────────────────── */

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

interface RunContext {
  workflow: { id: string; name: string; status: string };
  steps: ContextStep[];
  reworks: unknown[];
}

/* ── Helpers ─────────────────────────────────────────── */

const STEP_STATUS_BADGE: Record<string, string> = {
  completed: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
  failed:    'bg-red-500/20 text-red-300 border-red-500/30',
  skipped:   'bg-zinc-500/20 text-zinc-400 border-zinc-500/30',
  running:   'bg-blue-500/20 text-blue-300 border-blue-500/30',
  waiting_gate: 'bg-amber-500/20 text-amber-300 border-amber-500/30',
  pending:   'bg-zinc-600/20 text-zinc-500 border-zinc-600/30',
};

function StepStatusIcon({ status }: { status: string }) {
  switch (status) {
    case 'completed': return <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />;
    case 'failed':    return <XCircle className="w-3.5 h-3.5 text-red-400 shrink-0" />;
    case 'skipped':   return <SkipForward className="w-3.5 h-3.5 text-zinc-500 shrink-0" />;
    case 'running':   return <Clock className="w-3.5 h-3.5 text-blue-400 shrink-0 animate-pulse" />;
    default:          return <span className="w-3.5 h-3.5 rounded-full border border-zinc-600 shrink-0 inline-block" />;
  }
}

/**
 * Minimal markdown renderer — no external deps, handles common patterns.
 * Renders: bold, italic, inline code, code blocks, headings, lists, hr, line breaks.
 */
function MarkdownOutput({ text }: { text: string }) {
  const lines = text.split('\n');
  const elements: React.ReactNode[] = [];
  let i = 0;
  let key = 0;

  function inlineFormat(line: string): React.ReactNode {
    // Split on code spans first, then handle bold/italic
    const parts = line.split(/(`[^`]+`)/);
    return parts.map((part, pi) => {
      if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
        return (
          <code key={pi} className="px-1 py-0.5 rounded bg-zinc-800 text-violet-300 font-mono text-[11px]">
            {part.slice(1, -1)}
          </code>
        );
      }
      // Bold + italic: ***text***
      // Bold: **text**
      // Italic: *text* or _text_
      const formatted = part
        .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>')
        .replace(/_(.+?)_/g, '<em>$1</em>');
      if (formatted !== part) {
        return <span key={pi} dangerouslySetInnerHTML={{ __html: formatted }} />;
      }
      return part;
    });
  }

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      elements.push(
        <pre key={key++} className="rounded-lg bg-black/40 border border-zinc-800 p-3 text-[11px] font-mono text-zinc-400 overflow-x-auto whitespace-pre my-2">
          {lang && <div className="text-[9px] text-zinc-600 uppercase tracking-wider mb-2">{lang}</div>}
          {codeLines.join('\n')}
        </pre>
      );
      i++;
      continue;
    }

    // Headings
    const h3 = line.match(/^### (.+)/);
    if (h3) {
      elements.push(<h3 key={key++} className="text-xs font-semibold text-zinc-300 mt-3 mb-1">{inlineFormat(h3[1])}</h3>);
      i++;
      continue;
    }
    const h2 = line.match(/^## (.+)/);
    if (h2) {
      elements.push(<h2 key={key++} className="text-sm font-semibold text-zinc-200 mt-3 mb-1">{inlineFormat(h2[1])}</h2>);
      i++;
      continue;
    }
    const h1 = line.match(/^# (.+)/);
    if (h1) {
      elements.push(<h1 key={key++} className="text-sm font-bold text-zinc-100 mt-3 mb-1">{inlineFormat(h1[1])}</h1>);
      i++;
      continue;
    }

    // Horizontal rule
    if (/^(-{3,}|_{3,}|\*{3,})$/.test(line.trim())) {
      elements.push(<hr key={key++} className="border-zinc-700 my-3" />);
      i++;
      continue;
    }

    // Unordered list item
    const bullet = line.match(/^(\s*)[*\-+] (.+)/);
    if (bullet) {
      const indent = bullet[1].length;
      elements.push(
        <div key={key++} className="flex gap-2 text-xs text-zinc-400 leading-relaxed" style={{ paddingLeft: `${indent * 8}px` }}>
          <span className="text-zinc-600 shrink-0 mt-0.5">•</span>
          <span>{inlineFormat(bullet[2])}</span>
        </div>
      );
      i++;
      continue;
    }

    // Ordered list item
    const numbered = line.match(/^(\s*)\d+\. (.+)/);
    if (numbered) {
      const match = line.match(/^(\s*)(\d+)\. (.+)/)!;
      const indent = match[1].length;
      elements.push(
        <div key={key++} className="flex gap-2 text-xs text-zinc-400 leading-relaxed" style={{ paddingLeft: `${indent * 8}px` }}>
          <span className="text-zinc-600 shrink-0 font-mono">{match[2]}.</span>
          <span>{inlineFormat(match[3])}</span>
        </div>
      );
      i++;
      continue;
    }

    // Blank line → spacer
    if (line.trim() === '') {
      elements.push(<div key={key++} className="h-1.5" />);
      i++;
      continue;
    }

    // Regular paragraph
    elements.push(
      <p key={key++} className="text-xs text-zinc-400 leading-relaxed">{inlineFormat(line)}</p>
    );
    i++;
  }

  return <div className="space-y-0.5">{elements}</div>;
}

/* ── Step Card ───────────────────────────────────────── */

function StepCard({ step, defaultOpen = false }: { step: ContextStep; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const agentLabel = step.agent || step.role;
  const hasOutput = !!step.output;

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2.5 px-3 py-2.5 text-left hover:bg-zinc-800/30 transition-colors"
        disabled={!hasOutput}
      >
        <StepStatusIcon status={step.status} />

        {/* Agent avatar (small) */}
        {step.agent ? (
          <AgentAvatar name={step.agent} size="xs" />
        ) : (
          <div className="w-5 h-5 rounded-full bg-zinc-700 flex items-center justify-center shrink-0">
            <Bot className="w-3 h-3 text-zinc-400" />
          </div>
        )}

        {/* Step name + role */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-xs font-medium text-zinc-300 truncate">{step.name || step.id}</span>
            {step.iteration > 0 && (
              <span className="text-[9px] text-zinc-600">·&nbsp;iter&nbsp;{step.iteration + 1}</span>
            )}
          </div>
          <div className="text-[10px] text-zinc-600">{agentLabel}</div>
        </div>

        {/* Status badge */}
        <Badge className={`text-[10px] px-2 py-0.5 rounded-full border shrink-0 ${STEP_STATUS_BADGE[step.status] ?? 'bg-zinc-500/20 text-zinc-400 border-zinc-500/30'}`}>
          {step.status.replace('_', ' ')}
        </Badge>

        {/* Expand chevron (only if output exists) */}
        {hasOutput && (
          open
            ? <ChevronDown className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
            : <ChevronRight className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
        )}
      </button>

      {open && hasOutput && (
        <div className="px-3 pb-3 pt-1 border-t border-zinc-800/50">
          <div className="max-h-72 overflow-y-auto rounded-lg bg-black/20 p-3">
            <MarkdownOutput text={step.output!} />
          </div>
          {step.completedAt && (
            <div className="mt-2 text-[10px] text-zinc-600 text-right">
              completed {new Date(step.completedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ── Main Component ──────────────────────────────────── */

interface WorkflowStepOutputProps {
  workflowRunId: string;
}

export default function WorkflowStepOutput({ workflowRunId }: WorkflowStepOutputProps) {
  const [open, setOpen] = useState(true);
  const [context, setContext] = useState<RunContext | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    apiFetch<RunContext>(`/api/workflows/runs/${workflowRunId}/context`)
      .then(ctx => setContext(ctx))
      .catch(err => setError(err?.message ?? 'Failed to load workflow progress'))
      .finally(() => setLoading(false));
  }, [workflowRunId]);

  // Only show steps that have started (not pure pending ones with no data)
  const relevantSteps = context?.steps.filter(s =>
    s.status === 'completed' || s.status === 'failed' || s.status === 'skipped' || s.status === 'running'
  ) ?? [];

  return (
    <div className="border-t border-zinc-700 pt-4">
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-2 text-[10px] uppercase text-zinc-500 tracking-wider hover:text-zinc-300 transition-colors w-full text-left mb-3"
      >
        {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        Workflow Progress
        {context && (
          <span className="ml-auto text-[10px] bg-zinc-700/50 px-1.5 py-0.5 rounded-full normal-case tracking-normal">
            {relevantSteps.length} step{relevantSteps.length !== 1 ? 's' : ''}
          </span>
        )}
        {context?.workflow.name && (
          <span className="text-[10px] text-zinc-600 normal-case tracking-normal truncate max-w-[120px]">
            {context.workflow.name}
          </span>
        )}
      </button>

      {open && (
        <div className="space-y-2">
          {loading && (
            <p className="text-xs text-zinc-500">Loading workflow steps…</p>
          )}
          {!loading && error && (
            <p className="text-xs text-red-400">{error}</p>
          )}
          {!loading && !error && relevantSteps.length === 0 && (
            <p className="text-xs text-zinc-600">No completed steps yet.</p>
          )}
          {relevantSteps.map((step, idx) => (
            <StepCard
              key={step.id}
              step={step}
              // Auto-open the last completed step so users see relevant context immediately
              defaultOpen={idx === relevantSteps.length - 1 && step.status === 'completed'}
            />
          ))}
        </div>
      )}
    </div>
  );
}
