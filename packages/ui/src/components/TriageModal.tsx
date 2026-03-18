import { useEffect, useState } from 'react';
import {
  ResponsiveDialog as Dialog,
  ResponsiveDialogContent as DialogContent,
  ResponsiveDialogHeader as DialogHeader,
  ResponsiveDialogTitle as DialogTitle,
  ResponsiveDialogFooter as DialogFooter,
} from './ui/responsive-dialog';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { apiFetch } from '../hooks/useApi';
import { toast } from 'sonner';
import { Loader2, ChevronDown, ChevronUp, ExternalLink } from 'lucide-react';

/* ── Types ─────────────────────────────────────────── */

export interface TriageIssue {
  number: number;
  title: string;
  body?: string;
  labels: string[];
  htmlUrl?: string;
}

interface WorkflowStep {
  prompt?: string;
  [key: string]: unknown;
}

interface WorkflowInfo {
  id: string;
  name: string;
  description?: string;
  steps: WorkflowStep[];
  enabled: boolean;
  projectId?: string;
  projectIds?: string[];
}

interface TriageModalProps {
  open: boolean;
  issue: TriageIssue | null;
  projectId: string;
  onSuccess: () => void;
  onCancel: () => void;
}

/* ── Helpers ───────────────────────────────────────── */

/** Extract {{vars.X}} variable names from workflow steps JSON */
function extractTemplateVars(stepsJson: string): string[] {
  const matches = stepsJson.matchAll(/\{\{vars\.(\w+)\}\}/g);
  return [...new Set([...matches].map((m) => m[1]))];
}

/** Auto-populated vars that come directly from the issue */
const AUTO_VARS: Record<string, (issue: TriageIssue) => string> = {
  issueTitle: (i) => i.title,
  issueBody: (i) => i.body || '',
  issueNumber: (i) => String(i.number),
  issueLabels: (i) => (i.labels || []).join(', '),
  issueUrl: (i) => i.htmlUrl || '',
};

const LABEL_COLORS: Record<string, string> = {
  bug: 'bg-red-500/20 border-red-500/30 text-red-300',
  enhancement: 'bg-blue-500/20 border-blue-500/30 text-blue-300',
  feature: 'bg-emerald-500/20 border-emerald-500/30 text-emerald-300',
  documentation: 'bg-cyan-500/20 border-cyan-500/30 text-cyan-300',
  'good first issue': 'bg-purple-500/20 border-purple-500/30 text-purple-300',
};

function labelStyle(label: string): string {
  const lower = label.toLowerCase();
  for (const [key, style] of Object.entries(LABEL_COLORS)) {
    if (lower.includes(key)) return style;
  }
  if (lower.includes('priority')) return 'bg-orange-500/20 border-orange-500/30 text-orange-300';
  return 'bg-zinc-700/50 border-zinc-600 text-zinc-300';
}

/* ── Component ─────────────────────────────────────── */

export default function TriageModal({
  open,
  issue,
  projectId,
  onSuccess,
  onCancel,
}: TriageModalProps) {
  const [workflows, setWorkflows] = useState<WorkflowInfo[]>([]);
  const [loadingWorkflows, setLoadingWorkflows] = useState(false);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState('');
  const [manualVars, setManualVars] = useState<Record<string, string>>({});
  const [running, setRunning] = useState(false);
  const [bodyExpanded, setBodyExpanded] = useState(false);

  /* Load workflows when modal opens */
  useEffect(() => {
    if (!open) return;
    setSelectedWorkflowId('');
    setManualVars({});
    setBodyExpanded(false);

    setLoadingWorkflows(true);
    apiFetch<WorkflowInfo[]>(`/api/workflows?projectId=${projectId}`)
      .then((wfs) => {
        // API already filters by project — just filter to enabled
        setWorkflows(wfs.filter((wf) => wf.enabled !== false));
      })
      .catch((err) => {
        console.error('Failed to load workflows:', err);
        setWorkflows([]);
      })
      .finally(() => setLoadingWorkflows(false));
  }, [open, projectId]);

  /* Recompute manual vars when workflow changes */
  const selectedWorkflow = workflows.find((wf) => wf.id === selectedWorkflowId) ?? null;

  const allVarNames: string[] = selectedWorkflow
    ? extractTemplateVars(JSON.stringify(selectedWorkflow.steps))
    : [];

  const manualVarNames = allVarNames.filter((v) => !(v in AUTO_VARS));

  /* Reset manual vars when workflow changes */
  useEffect(() => {
    setManualVars({});
  }, [selectedWorkflowId]);

  /* Auto-populated values */
  const autoVarValues: Record<string, string> = issue
    ? Object.fromEntries(
        Object.entries(AUTO_VARS)
          .filter(([k]) => allVarNames.includes(k))
          .map(([k, fn]) => [k, fn(issue)]),
      )
    : {};

  async function handleRun() {
    if (!selectedWorkflow || !issue) return;

    setRunning(true);
    try {
      await apiFetch('/api/triage/dispatch', {
        method: 'POST',
        body: JSON.stringify({
          projectId,
          issueNumber: issue.number,
          workflowId: selectedWorkflow.id,
          vars: manualVars,
        }),
      });

      toast.success(`Workflow "${selectedWorkflow.name}" started for #${issue.number}`);
      onSuccess();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      toast.error(`Failed to run workflow: ${message}`);
    } finally {
      setRunning(false);
    }
  }

  if (!issue) return null;

  const bodyPreview = (issue.body || '').slice(0, 300);
  const bodyFull = issue.body || '';
  const bodyTruncated = bodyFull.length > 300;

  const canRun = !!selectedWorkflowId && !running;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onCancel(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <span className="text-zinc-400 font-mono text-sm">#{issue.number}</span>
            <span className="text-zinc-100 font-semibold leading-snug">{issue.title}</span>
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-1">
          {/* Labels */}
          {issue.labels.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {issue.labels.map((label) => (
                <span
                  key={label}
                  className={`text-[10px] px-1.5 py-0.5 rounded-full border ${labelStyle(label)}`}
                >
                  {label}
                </span>
              ))}
            </div>
          )}

          {/* Body preview */}
          {bodyFull && (
            <div className="rounded-lg bg-zinc-900/50 border border-zinc-800 p-3">
              <pre className="text-xs text-zinc-400 leading-relaxed whitespace-pre-wrap font-mono overflow-hidden">
                {bodyExpanded ? bodyFull : bodyPreview}
                {!bodyExpanded && bodyTruncated && '…'}
              </pre>
              {bodyTruncated && (
                <button
                  type="button"
                  className="mt-2 flex items-center gap-1 text-[10px] text-zinc-500 hover:text-zinc-300 transition-colors"
                  onClick={() => setBodyExpanded((v) => !v)}
                >
                  {bodyExpanded ? (
                    <><ChevronUp className="w-3 h-3" /> Show less</>
                  ) : (
                    <><ChevronDown className="w-3 h-3" /> Show more</>
                  )}
                </button>
              )}
            </div>
          )}

          {/* GitHub link */}
          {issue.htmlUrl && (
            <a
              href={issue.htmlUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-[11px] text-violet-400 hover:text-violet-300 transition-colors"
            >
              <ExternalLink className="w-3 h-3" />
              View on GitHub
            </a>
          )}

          {/* Workflow selector */}
          <div>
            <label className="block text-xs font-medium text-zinc-400 mb-1.5 uppercase tracking-wider">
              Workflow
            </label>
            {loadingWorkflows ? (
              <div className="flex items-center gap-2 text-xs text-zinc-500 py-2">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                Loading workflows…
              </div>
            ) : workflows.length === 0 ? (
              <p className="text-xs text-zinc-500 py-2">
                No enabled workflows available for this project.
              </p>
            ) : (
              <Select
                value={selectedWorkflowId || '__none__'}
                onValueChange={(val) =>
                  setSelectedWorkflowId(val === '__none__' ? '' : val)
                }
              >
                <SelectTrigger className="w-full border-zinc-700 bg-zinc-800/50">
                  <SelectValue placeholder="Select a workflow…" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">Select a workflow…</SelectItem>
                  {workflows.map((wf) => (
                    <SelectItem key={wf.id} value={wf.id}>
                      {wf.name}
                      {wf.description && (
                        <span className="ml-1.5 text-zinc-500 text-[10px]">
                          — {wf.description}
                        </span>
                      )}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          {/* Auto-populated vars (read-only) */}
          {selectedWorkflow && Object.keys(autoVarValues).length > 0 && (
            <div>
              <label className="block text-xs font-medium text-zinc-500 mb-1.5 uppercase tracking-wider">
                Auto-filled Variables
              </label>
              <div className="space-y-1.5">
                {Object.entries(autoVarValues).map(([key, value]) => (
                  <div key={key} className="flex items-center gap-2">
                    <span className="text-[11px] text-zinc-500 font-mono w-28 shrink-0">{key}</span>
                    <Input
                      value={value}
                      readOnly
                      disabled
                      className="flex-1 text-[11px] font-mono bg-zinc-900/50 border-zinc-800 text-zinc-500 cursor-not-allowed opacity-60 py-1 h-7"
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Manual vars */}
          {selectedWorkflow && manualVarNames.length > 0 && (
            <div>
              <label className="block text-xs font-medium text-zinc-300 mb-1.5 uppercase tracking-wider">
                Variables
              </label>
              <div className="space-y-2">
                {manualVarNames.map((key) => (
                  <div key={key} className="flex items-center gap-2">
                    <span className="text-[11px] text-zinc-400 font-mono w-28 shrink-0">{key}</span>
                    <Input
                      value={manualVars[key] ?? ''}
                      onChange={(e) =>
                        setManualVars((prev) => ({ ...prev, [key]: e.target.value }))
                      }
                      placeholder={`Enter ${key}…`}
                      className="flex-1 text-xs font-mono bg-zinc-800/50 border-zinc-700 text-zinc-200 py-1 h-7 focus:border-violet-500/50"
                    />
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            onClick={onCancel}
            disabled={running}
            className="border-zinc-700 text-zinc-300 hover:bg-zinc-800"
          >
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleRun}
            disabled={!canRun}
            className="bg-violet-600 hover:bg-violet-500 text-white font-medium disabled:opacity-40"
          >
            {running ? (
              <>
                <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                Running…
              </>
            ) : (
              'Run Workflow'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
