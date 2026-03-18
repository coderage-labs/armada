import { useEffect, useState, useCallback, useMemo } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { apiFetch } from '../hooks/useApi';
import { useProject } from '../hooks/queries/useProjects';
import AgentAvatar from '../components/AgentAvatar';
import { Checkbox } from '../components/ui/checkbox';
import ConfirmDialog from '../components/ConfirmDialog';
import {
  ArrowLeft, RefreshCw, GitPullRequest, Tag, Users, Clock,
  Search, ExternalLink, Bot,
  Workflow, Activity, Pencil, Zap, Loader2, AlertCircle,
  Hash, Circle, BarChart3, CheckCircle2, Timer, TrendingUp,
  Settings, Package, X, Plug, GitBranch, Plus, FolderKanban,
  Crown, User,
} from 'lucide-react';
import {
  ResponsiveDialog as Dialog,
  ResponsiveDialogContent as DialogContent,
  ResponsiveDialogHeader as DialogHeader,
  ResponsiveDialogTitle as DialogTitle,
  ResponsiveDialogFooter as DialogFooter,
} from '../components/ui/responsive-dialog';
import { PageHeader } from '../components/PageHeader';
import ProjectAssignments from '../components/ProjectAssignments';
import TriageModal, { type TriageIssue } from '../components/TriageModal';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Input } from '../components/ui/input';
import { Textarea } from '../components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Switch } from '../components/ui/switch';
import { toast } from 'sonner';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../components/ui/tabs';
import { LoadingState } from '../components/LoadingState';

/* ── Types ─────────────────────────────────────────── */

interface ProjectRepository {
  url: string;
  defaultBranch?: string;
  cloneDir?: string;
}

interface Project {
  id: string;
  name: string;
  description: string;
  contextMd: string;
  color: string;
  icon: string | null;
  archived: boolean;
  repositories: ProjectRepository[];
  maxConcurrent: number;
  githubSyncIntervalMinutes?: number;
  createdAt: string;
}

interface GitHubIssue {
  number: number;
  title: string;
  body?: string;
  url: string;
  htmlUrl: string;
  labels: string[];
  state: string;
  author?: string;
  createdAt?: string;
  updatedAt: string;
  repo: string;
}

interface ArmadaTask {
  id: string;
  fromAgent: string;
  toAgent: string;
  taskText: string;
  result: string | null;
  status: string;
  projectId?: string;
  createdAt: string;
  completedAt: string | null;
}

interface AgentInfo {
  name: string;
  role: string;
  status: string;
  healthStatus: string;
}

interface WorkflowInfo {
  id: string;
  name: string;
  description: string;
  steps: any[];
  enabled: boolean;
  projectId?: string;
  projectIds?: string[];
}

interface ArmadaUser {
  id: string;
  name: string;
  displayName: string;
  type: 'human' | 'operator';
  role: 'owner' | 'operator' | 'viewer';
  avatarUrl: string | null;
  createdAt: string;
}

interface Integration {
  id: string;
  name: string;
  provider: string;
  authType: string;
  capabilities: string[];
  status: string;
  statusMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ProjectIntegration {
  id: string;
  projectId: string;
  integrationId: string;
  integration?: Integration;
  capability: string;
  config: any;
  enabled: boolean;
  syncCursor: string | null;
  lastSyncedAt: string | null;
  createdAt: string;
}

interface ExternalRepo {
  fullName: string;
  defaultBranch?: string;
}

/* ── Helpers ───────────────────────────────────────── */


interface ProjectMetrics {
  tasks: { total: number; completed: number; failed: number; running: number; pending: number; blocked: number };
  workflows: { totalRuns: number; completed: number; running: number; failed: number; cancelled: number };
  agents: { assigned: number; activeOnProject: number };
  timing: { avgTaskDurationMs: number | null; avgWorkflowDurationMs: number | null; fastestTaskMs: number | null; slowestTaskMs: number | null };
  github: { totalIssues: number; openIssues: number; triagedIssues: number; issuesByLabel: Record<string, number> };
  activity: { last24h: number; last7d: number; last30d: number; daily: { date: string; count: number }[] };
}

function relativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

const PROJECT_COLOURS = [
  '#ef4444', '#f97316', '#f59e0b', '#eab308', '#84cc16', '#22c55e',
  '#14b8a6', '#06b6d4', '#3b82f6', '#6366f1', '#8b5cf6', '#a855f7',
  '#d946ef', '#ec4899', '#f43f5e', '#6b7280', '#78716c', '#737373',
];

const PROJECT_EMOJIS = [
  '🚀', '⚡', '🔧', '🎯', '📦', '🌐', '🔒', '💡',
  '📊', '🎨', '🔬', '📝', '🏗️', '🤖', '⭐', '🔥',
  '💎', '🧪', '📈', '🛠️', '🎮', '🌟', '🔑', '📱',
];

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

function truncate(s: string, max: number) {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/* ── Issue Detail Modal ────────────────────────────── */

function IssueDetailModal({
  issue,
  onClose,
  onTriage,
}: {
  issue: GitHubIssue | null;
  onClose: () => void;
  onTriage: (issue: GitHubIssue) => void;
}) {
  if (!issue) return null;

  return (
    <Dialog open={!!issue} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-start gap-2 text-base leading-snug pr-6">
            <Circle className={`w-4 h-4 mt-0.5 shrink-0 ${issue.state === 'open' ? 'text-emerald-400' : 'text-zinc-500'}`} />
            <span>
              <span className="text-zinc-500 font-mono text-sm mr-1.5">#{issue.number}</span>
              {issue.title}
            </span>
          </DialogTitle>
          <div className="flex items-center gap-3 mt-1 text-xs text-zinc-500 flex-wrap">
            {issue.author && <span>by {issue.author}</span>}
            {issue.createdAt && (
              <span>opened {formatDate(issue.createdAt)}</span>
            )}
            <a
              href={issue.htmlUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 text-violet-400 hover:text-violet-300 transition-colors ml-auto"
            >
              View on GitHub <ExternalLink className="w-3 h-3" />
            </a>
          </div>
        </DialogHeader>

        {/* Labels */}
        {issue.labels.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-1">
            {issue.labels.map((label) => (
              <span
                key={label}
                className={`text-[11px] px-2 py-0.5 rounded-full border font-medium ${labelStyle(label)}`}
              >
                {label}
              </span>
            ))}
          </div>
        )}

        {/* Body */}
        <div className="flex-1 overflow-y-auto rounded-lg bg-zinc-950 border border-zinc-800 p-4 min-h-0">
          {issue.body ? (
            <IssueBodyRenderer body={issue.body} />
          ) : (
            <p className="text-sm text-zinc-600 italic">No description provided.</p>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={onClose}
            className="text-zinc-400 hover:text-zinc-200"
          >
            Close
          </Button>
          <Button
            onClick={() => {
              onClose();
              onTriage(issue);
            }}
            className="flex items-center gap-1.5 bg-violet-600 hover:bg-violet-500 text-white font-medium"
          >
            <Zap className="w-4 h-4" />
            Triage Issue
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Minimal inline markdown renderer for issue bodies — no external deps */
function IssueBodyRenderer({ body }: { body: string }) {
  const lines = body.split('\n');
  const elements: React.ReactNode[] = [];
  let i = 0;
  let key = 0;

  function inlineFormat(line: string): React.ReactNode {
    const parts = line.split(/(`[^`]+`)/);
    return parts.map((part, pi) => {
      if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
        return (
          <code key={pi} className="px-1 py-0.5 rounded bg-zinc-800 text-violet-300 font-mono text-[11px]">
            {part.slice(1, -1)}
          </code>
        );
      }
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

    // Fenced code blocks
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      elements.push(
        <pre key={key++} className="rounded-lg bg-zinc-900 border border-zinc-800 p-3 overflow-x-auto my-2">
          <code className="text-xs text-zinc-300 font-mono">{codeLines.join('\n')}</code>
        </pre>
      );
      i++;
      continue;
    }

    // Headings
    const headingMatch = line.match(/^(#{1,6})\s+(.*)/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const cls = level === 1 ? 'text-base font-bold text-zinc-100 mt-3 mb-1' :
                  level === 2 ? 'text-sm font-bold text-zinc-200 mt-2 mb-1' :
                                'text-xs font-semibold text-zinc-300 mt-2 mb-0.5';
      elements.push(<div key={key++} className={cls}>{inlineFormat(headingMatch[2])}</div>);
      i++;
      continue;
    }

    // HR
    if (/^---+$/.test(line.trim()) || /^\*\*\*+$/.test(line.trim())) {
      elements.push(<hr key={key++} className="border-zinc-800 my-2" />);
      i++;
      continue;
    }

    // List items
    const listMatch = line.match(/^(\s*)[-*+]\s+(.*)/);
    if (listMatch) {
      const indent = listMatch[1].length;
      elements.push(
        <div key={key++} className="flex gap-2 text-sm text-zinc-300 leading-relaxed" style={{ paddingLeft: `${indent * 12}px` }}>
          <span className="text-zinc-600 shrink-0">•</span>
          <span>{inlineFormat(listMatch[2])}</span>
        </div>
      );
      i++;
      continue;
    }

    // Numbered list
    const numListMatch = line.match(/^(\s*)\d+\.\s+(.*)/);
    if (numListMatch) {
      const numMatch = line.match(/^(\s*)(\d+)\.\s+(.*)/);
      if (numMatch) {
        elements.push(
          <div key={key++} className="flex gap-2 text-sm text-zinc-300 leading-relaxed" style={{ paddingLeft: `${numMatch[1].length * 12}px` }}>
            <span className="text-zinc-600 shrink-0">{numMatch[2]}.</span>
            <span>{inlineFormat(numMatch[3])}</span>
          </div>
        );
      }
      i++;
      continue;
    }

    // Blank line
    if (line.trim() === '') {
      elements.push(<div key={key++} className="h-2" />);
      i++;
      continue;
    }

    // Regular paragraph
    elements.push(
      <p key={key++} className="text-sm text-zinc-300 leading-relaxed">
        {inlineFormat(line)}
      </p>
    );
    i++;
  }

  return <div className="space-y-0.5">{elements}</div>;
}

/* ── Issue Row ─────────────────────────────────────── */

function IssueRow({
  issue,
  onOpen,
}: {
  issue: GitHubIssue;
  onOpen: () => void;
}) {
  return (
    <div
      className="flex items-center gap-3 px-4 py-3 border-b border-zinc-800 last:border-0 hover:bg-zinc-900/50 transition-colors cursor-pointer"
      onClick={onOpen}
    >
      {/* Issue state icon */}
      <Circle className={`w-4 h-4 shrink-0 ${
        issue.state === 'open' ? 'text-emerald-400' : 'text-zinc-500'
      }`} />

      {/* Number */}
      <span className="text-xs text-zinc-500 font-mono shrink-0 w-12">
        #{issue.number}
      </span>

      {/* Title */}
      <span className="text-sm text-zinc-200 font-medium flex-1 truncate">
        {issue.title}
      </span>

      {/* Labels */}
      <div className="hidden sm:flex items-center gap-1 shrink-0">
        {issue.labels.slice(0, 3).map((label) => (
          <span
            key={label}
            className={`text-[10px] px-1.5 py-0.5 rounded-full border ${labelStyle(label)}`}
          >
            {label}
          </span>
        ))}
        {issue.labels.length > 3 && (
          <span className="text-[10px] text-zinc-600">+{issue.labels.length - 3}</span>
        )}
      </div>

      {/* Author & date */}
      <span className="text-[11px] text-zinc-600 shrink-0 hidden md:block">
        {issue.author && <span>{issue.author} · </span>}
        {relativeTime(issue.createdAt || issue.updatedAt)}
      </span>

      {/* GitHub link — always visible, stops row click propagation */}
      <a
        href={issue.htmlUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="shrink-0 text-zinc-600 hover:text-zinc-300 transition-colors"
        title="Open on GitHub"
        onClick={(e) => e.stopPropagation()}
      >
        <ExternalLink className="w-3.5 h-3.5" />
      </a>
    </div>
  );
}

/* ── Issues Tab ────────────────────────────────────── */

function IssuesTab({
  projectId,
  issues,
  syncing,
  lastSynced,
  onSync,
  onTriageOne,
}: {
  projectId: string;
  issues: GitHubIssue[];
  syncing: boolean;
  lastSynced: string | null;
  onSync: () => void;
  onTriageOne: (issue: GitHubIssue) => void;
}) {
  const [search, setSearch] = useState('');
  const [labelFilter, setLabelFilter] = useState<string | null>(null);
  const [selectedIssue, setSelectedIssue] = useState<GitHubIssue | null>(null);
  const [triagingAll, setTriagingAll] = useState(false);

  // All unique labels
  const allLabels = useMemo(() => {
    const set = new Set<string>();
    issues.forEach((i) => i.labels.forEach((l) => set.add(l)));
    return Array.from(set).sort();
  }, [issues]);

  // Filtered issues
  const filtered = useMemo(() => {
    let result = issues;
    if (search) {
      const q = search.toLowerCase();
      result = result.filter(
        (i) =>
          i.title.toLowerCase().includes(q) ||
          String(i.number).includes(q) ||
          i.labels.some((l) => l.toLowerCase().includes(q)),
      );
    }
    if (labelFilter) {
      result = result.filter((i) => i.labels.includes(labelFilter));
    }
    return result;
  }, [issues, search, labelFilter]);

  async function handleTriageAll() {
    setTriagingAll(true);
    try {
      await apiFetch('/api/triage/scan', { method: 'POST' });
      toast('Triage scan started for all projects');
    } catch (err: any) {
      toast.error(`Triage failed: ${err.message}`);
    } finally {
      setTriagingAll(false);
    }
  }

  return (
    <div className="space-y-3">
      {/* Toolbar */}
      <div className="flex items-center gap-3 flex-wrap">
        {/* Search */}
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-600" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search issues…"
            className="w-full pl-9 pr-3 py-2 rounded-lg bg-zinc-800/50 border border-zinc-800 text-sm text-zinc-200 focus:outline-none focus:border-violet-500/50"
          />
        </div>

        {/* Label filter */}
        {allLabels.length > 0 && (
          <Select value={labelFilter ?? '__all__'} onValueChange={(val) => setLabelFilter(val === '__all__' ? null : val)}>
            <SelectTrigger className="w-40 border-zinc-800 bg-zinc-800/50">
              <SelectValue placeholder="All labels" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">All labels</SelectItem>
              {allLabels.map((l) => (
                <SelectItem key={l} value={l}>{l}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {/* Sync button */}
        <Button
          variant="ghost" onClick={onSync}
          disabled={syncing}
          className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-zinc-800/50 border border-zinc-800 hover:bg-zinc-700/50 text-sm text-zinc-300 transition-colors disabled:opacity-40"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} />
          {syncing ? 'Syncing…' : 'Sync'}
        </Button>


      </div>

      {/* Sync status */}
      <div className="text-[11px] text-zinc-600 flex items-center gap-1.5">
        <Clock className="w-3 h-3" />
        {syncing
          ? 'Syncing…'
          : lastSynced
            ? `Last synced ${relativeTime(lastSynced)}`
            : 'Not yet synced'}
        <span className="mx-1">·</span>
        <span>{filtered.length} issue{filtered.length !== 1 ? 's' : ''}</span>
        {search || labelFilter ? (
          <span className="text-zinc-500">
            {' '}(of {issues.length} total)
          </span>
        ) : null}
      </div>

      {/* Issues list */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 overflow-hidden">
        {filtered.length === 0 ? (
          <div className="text-center py-12 text-sm text-zinc-600">
            {issues.length === 0 ? (
              <div className="space-y-2">
                <AlertCircle className="w-8 h-8 mx-auto text-zinc-700" />
                <p>No issues synced yet</p>
                <p className="text-xs">Click Sync to fetch issues from GitHub</p>
              </div>
            ) : (
              'No issues match your search'
            )}
          </div>
        ) : (
          filtered.map((issue) => (
            <IssueRow
              key={issue.number}
              issue={issue}
              onOpen={() => setSelectedIssue(issue)}
            />
          ))
        )}
      </div>

      {/* Issue detail modal */}
      <IssueDetailModal
        issue={selectedIssue}
        onClose={() => setSelectedIssue(null)}
        onTriage={(issue) => {
          setSelectedIssue(null);
          onTriageOne(issue);
        }}
      />

    </div>
  );
}

/* ── Workflows Tab ─────────────────────────────────── */

function WorkflowsTab({ workflows }: { workflows: WorkflowInfo[] }) {
  const [runningWf, setRunningWf] = useState<string | null>(null);
  const [showVars, setShowVars] = useState<string | null>(null);
  const [vars, setVars] = useState('');

  async function handleRun(wfId: string) {
    setRunningWf(wfId);
    try {
      let parsedVars = {};
      if (vars.trim()) {
        try {
          parsedVars = JSON.parse(vars);
        } catch {
          toast.error('Invalid JSON for variables');
          setRunningWf(null);
          return;
        }
      }
      await apiFetch(`/api/workflows/${wfId}/run`, {
        method: 'POST',
        body: JSON.stringify({ vars: parsedVars }),
      });
      toast.success('Workflow run started');
      setShowVars(null);
      setVars('');
    } catch (err: any) {
      toast.error(`Failed: ${err.message}`);
    } finally {
      setRunningWf(null);
    }
  }

  if (workflows.length === 0) {
    return (
      <div className="text-center py-12">
        <Workflow className="w-8 h-8 text-zinc-700 mx-auto" />
        <p className="text-sm text-zinc-500 mt-2">No workflows assigned to this project</p>
        <Link
          to="/workflows"
          className="text-xs text-violet-400 hover:text-violet-300 mt-1 inline-block"
        >
          Create a workflow →
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {workflows.map((wf) => (
        <div
          key={wf.id}
          className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4 hover:bg-zinc-900/50 transition-colors"
        >
          <div className="flex items-center justify-between gap-3">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <Link
                  to={`/workflows/${wf.id}`}
                  className="text-sm font-medium text-zinc-200 hover:text-violet-300 transition-colors"
                >
                  {wf.name}
                </Link>
                <span
                  className={`text-[10px] px-1.5 py-0.5 rounded-full ${
                    wf.enabled
                      ? 'bg-emerald-500/20 border border-emerald-500/30 text-emerald-300'
                      : 'bg-zinc-500/20 border border-zinc-500/30 text-zinc-400'
                  }`}
                >
                  {wf.enabled ? 'Enabled' : 'Disabled'}
                </span>
              </div>
              {wf.description && (
                <p className="text-xs text-zinc-500 mt-0.5">{wf.description}</p>
              )}
              <p className="text-[10px] text-zinc-600 mt-1">
                {wf.steps.length} step{wf.steps.length !== 1 ? 's' : ''}
              </p>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              {showVars === wf.id ? (
                <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                  <Input
                    value={vars}
                    onChange={(e) => setVars(e.target.value)}
                    placeholder='{"key": "value"}'
                    className="w-48 rounded-lg bg-zinc-800/50 border border-zinc-800 text-xs text-zinc-200 px-2 py-1.5 focus:outline-none focus:border-violet-500/50 font-mono"
                  />
                  <Button
                    variant="ghost" onClick={() => handleRun(wf.id)}
                    disabled={runningWf === wf.id}
                    className="px-2.5 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-xs font-medium disabled:opacity-40"
                  >
                    {runningWf === wf.id ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Go'}
                  </Button>
                  <Button
                    variant="ghost" onClick={() => { setShowVars(null); setVars(''); }}
                    className="text-zinc-500 hover:text-zinc-300 text-xs"
                  >
                    ×
                  </Button>
                </div>
              ) : (
                <Button
                  variant="ghost" onClick={() => setShowVars(wf.id)}
                  disabled={!wf.enabled}
                  className="px-3 py-1.5 rounded-lg bg-violet-600/80 hover:bg-violet-500 text-white text-xs font-medium transition-colors disabled:opacity-30"
                >
                  Run
                </Button>
              )}
              <Link
                to={`/workflows/${wf.id}`}
                className="text-zinc-600 hover:text-zinc-300 transition-colors"
                title="Edit workflow"
              >
                <Pencil className="w-3.5 h-3.5" />
              </Link>
            </div>
          </div>
        </div>
      ))}

    </div>
  );
}

/* ── Agents Tab ────────────────────────────────────── */

function AgentsTab({ agents }: { agents: AgentInfo[] }) {
  if (agents.length === 0) {
    return (
      <div className="text-center py-12">
        <Users className="w-8 h-8 text-zinc-700 mx-auto" />
        <p className="text-sm text-zinc-500 mt-2">No agents assigned to this project</p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      {agents.map((agent) => (
        <Link
          key={agent.name}
          to={`/agents/${agent.name}`}
          className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4 hover:bg-zinc-800/50 transition-colors flex items-center gap-3"
        >
          <AgentAvatar name={agent.name} size="sm" healthStatus={agent.healthStatus} />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-zinc-200">{agent.name}</div>
            <div className="text-[11px] text-zinc-500">{agent.role}</div>
          </div>
          <span
            className={`text-[10px] px-1.5 py-0.5 rounded-full ${
              agent.status === 'running'
                ? 'bg-emerald-500/20 text-emerald-300'
                : agent.status === 'stopped'
                  ? 'bg-zinc-500/20 text-zinc-400'
                  : 'bg-amber-500/20 text-amber-300'
            }`}
          >
            {agent.status}
          </span>
        </Link>
      ))}
    </div>
  );
}

/* ── Activity Tab ──────────────────────────────────── */

function ActivityTab({ tasks }: { tasks: ArmadaTask[] }) {
  if (tasks.length === 0) {
    return (
      <div className="text-center py-12">
        <Activity className="w-8 h-8 text-zinc-700 mx-auto" />
        <p className="text-sm text-zinc-500 mt-2">No recent activity for this project</p>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {tasks.map((task) => (
        <div
          key={task.id}
          className="flex items-center gap-3 px-4 py-2.5 rounded-lg hover:bg-zinc-900/50 transition-colors"
        >
          {/* Timeline dot */}
          <div className="flex flex-col items-center shrink-0">
            <div
              className={`w-2 h-2 rounded-full ${
                task.status === 'completed'
                  ? 'bg-emerald-400'
                  : task.status === 'running'
                    ? 'bg-amber-400'
                    : task.status === 'failed'
                      ? 'bg-red-400'
                      : 'bg-zinc-500'
              }`}
            />
          </div>

          {/* Content */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 text-xs">
              <span className="text-violet-300 font-medium">{task.fromAgent}</span>
              <span className="text-zinc-600">→</span>
              <span className="text-blue-300 font-medium">{task.toAgent}</span>
              <span
                className={`text-[10px] px-1.5 py-0.5 rounded-full ${
                  task.status === 'completed'
                    ? 'bg-emerald-500/20 text-emerald-300'
                    : task.status === 'running'
                      ? 'bg-amber-500/20 text-amber-300'
                      : task.status === 'failed'
                        ? 'bg-red-500/20 text-red-300'
                        : 'bg-zinc-700/50 text-zinc-400'
                }`}
              >
                {task.status}
              </span>
            </div>
            <p className="text-[11px] text-zinc-500 truncate mt-0.5">
              {truncate(task.taskText, 100)}
            </p>
          </div>

          {/* Time */}
          <span className="text-[10px] text-zinc-600 shrink-0">
            {relativeTime(task.completedAt || task.createdAt)}
          </span>
        </div>
      ))}
    </div>
  );
}

/* ── Members Tab ───────────────────────────────────── */

function MembersTab({ projectId, users: initialUsers }: { projectId: string; users: ArmadaUser[] }) {
  const [users, setUsers] = useState<ArmadaUser[]>(initialUsers);
  const [allUsers, setAllUsers] = useState<ArmadaUser[]>([]);
  const [adding, setAdding] = useState(false);
  const [selectedUserId, setSelectedUserId] = useState('');
  const [makeOwner, setMakeOwner] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [makingOwner, setMakingOwner] = useState<string | null>(null);
  const [confirmOwner, setConfirmOwner] = useState<{ userId: string; name: string } | null>(null);

  useEffect(() => {
    // Load all users for the add dropdown
    apiFetch<ArmadaUser[]>('/api/users')
      .then(setAllUsers)
      .catch(console.error);
  }, []);

  async function handleAdd() {
    if (!selectedUserId) return;
    setAdding(true);
    try {
      const resp = await apiFetch<{ users: ArmadaUser[] }>(`/api/projects/${projectId}/users`, {
        method: 'POST',
        body: JSON.stringify({ userId: selectedUserId, role: makeOwner ? 'owner' : 'member' }),
      });
      setUsers(resp.users);
      setSelectedUserId('');
      setMakeOwner(false);
      toast.success(makeOwner ? 'User added as project owner' : 'User added to project');
    } catch (err: any) {
      toast.error(`Failed: ${err.message}`);
    } finally {
      setAdding(false);
    }
  }

  async function handleMakeOwner(userId: string) {
    setMakingOwner(userId);
    try {
      const resp = await apiFetch<{ users: ArmadaUser[] }>(`/api/projects/${projectId}/users`, {
        method: 'POST',
        body: JSON.stringify({ userId, role: 'owner' }),
      });
      setUsers(resp.users);
      toast.success('Project owner updated');
    } catch (err: any) {
      toast.error(`Failed: ${err.message}`);
    } finally {
      setMakingOwner(null);
      setConfirmOwner(null);
    }
  }

  async function handleRemove(userId: string) {
    setRemoving(userId);
    try {
      const resp = await apiFetch<{ users: ArmadaUser[] }>(`/api/projects/${projectId}/users/${userId}`, {
        method: 'DELETE',
      });
      setUsers(resp.users);
      toast.success('User removed from project');
    } catch (err: any) {
      toast.error(`Failed: ${err.message}`);
    } finally {
      setRemoving(null);
    }
  }

  const assignedUserIds = new Set(users.map(u => u.id));
  const availableUsers = allUsers.filter(u => !assignedUserIds.has(u.id));

  return (
    <div className="space-y-4">
      {/* Add user section */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
        <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-3">Add Member</h3>
        <div className="flex gap-2">
          <Select value={selectedUserId || '__none__'} onValueChange={(val) => setSelectedUserId(val === '__none__' ? '' : val)} disabled={adding}>
            <SelectTrigger className="flex-1 border-zinc-800 bg-zinc-800/50">
              <SelectValue placeholder="Select a user…" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">Select a user…</SelectItem>
              {availableUsers.map(u => (
                <SelectItem key={u.id} value={u.id}>{u.displayName} ({u.name})</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="ghost" onClick={handleAdd}
            disabled={!selectedUserId || adding}
            className="px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-sm font-medium transition-colors disabled:opacity-40"
          >
            {adding ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Add'}
          </Button>
        </div>
        <div className="flex items-center gap-2 mt-3">
          <input
            type="checkbox"
            id="makeOwner"
            checked={makeOwner}
            onChange={(e) => setMakeOwner(e.target.checked)}
            disabled={!selectedUserId || adding}
            className="rounded border-zinc-600 bg-zinc-800 text-violet-600 focus:ring-violet-500"
          />
          <label htmlFor="makeOwner" className="text-xs text-zinc-400 cursor-pointer select-none">
            Make owner (replaces current owner)
          </label>
        </div>
      </div>

      {/* Members list */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50">
        {users.length === 0 ? (
          <div className="text-center py-12">
            <Users className="w-8 h-8 text-zinc-700 mx-auto" />
            <p className="text-sm text-zinc-500 mt-2">No members assigned to this project</p>
            <p className="text-xs text-zinc-600 mt-1">Add users to receive project notifications</p>
          </div>
        ) : (
          <div className="divide-y divide-white/5">
            {users.map(user => (
              <div key={user.id} className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-zinc-900/50 transition-colors">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-full bg-gradient-to-br from-violet-500 to-blue-500 flex items-center justify-center text-white font-medium text-sm overflow-hidden">
                    {user.avatarUrl ? (
                      <img src={`/api/users/${user.name}/avatar?size=sm`} alt={user.displayName} className="w-full h-full object-cover" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                    ) : user.displayName[0].toUpperCase()}
                  </div>
                  <div>
                    <div className="flex items-center gap-1.5">
                      <span title={user.type === 'operator' ? 'Operator' : 'Human'}>
                        {user.type === 'operator' ? (
                          <Bot className="w-3.5 h-3.5 text-violet-400 shrink-0" />
                        ) : (
                          <User className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
                        )}
                      </span>
                      <span className="text-sm font-medium text-zinc-200">{user.displayName}</span>
                      {user.role === 'owner' && <span title="Project Owner"><Crown className="w-3.5 h-3.5 text-amber-400 shrink-0" /></span>}
                    </div>
                    <div className="text-xs text-zinc-500 ml-5">@{user.name}</div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {user.role !== 'owner' && (
                    <Button
                      variant="ghost"
                      onClick={() => setConfirmOwner({ userId: user.id, name: user.displayName })}
                      disabled={makingOwner === user.id}
                      className="text-xs px-2 py-1 text-amber-500 hover:text-amber-400 hover:bg-amber-500/10 disabled:opacity-40"
                      title="Make owner"
                    >
                      {makingOwner === user.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Crown className="w-3.5 h-3.5" />}
                    </Button>
                  )}
                  <Button
                    variant="ghost" onClick={() => handleRemove(user.id)}
                    disabled={removing === user.id}
                    className="text-zinc-600 hover:text-red-400 transition-colors text-xs px-2 py-1 disabled:opacity-40"
                  >
                    {removing === user.id ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Remove'}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={!!confirmOwner}
        title="Change Project Owner"
        message={`Make ${confirmOwner?.name ?? 'this user'} the project owner? The current owner (if any) will become a regular member.`}
        confirmLabel="Make Owner"
        destructive={false}
        onConfirm={() => confirmOwner && handleMakeOwner(confirmOwner.userId)}
        onCancel={() => setConfirmOwner(null)}
      />
    </div>
  );
}

/* ── Integrations Tab ──────────────────────────────── */

function IntegrationsTab({ projectId }: { projectId: string }) {
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [projectIntegrations, setProjectIntegrations] = useState<ProjectIntegration[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAttach, setShowAttach] = useState(false);
  const [selectedIntegrationId, setSelectedIntegrationId] = useState('');
  const [selectedCapability, setSelectedCapability] = useState<'issues' | 'vcs'>('issues');
  const [issueFilters, setIssueFilters] = useState({
    projects: '',
    labels: '',
    statuses: '',
    assignees: '',
    types: '',
  });
  const [repos, setRepos] = useState<ExternalRepo[]>([]);
  const [selectedRepos, setSelectedRepos] = useState<Set<string>>(new Set());
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const [syncing, setSyncing] = useState<string | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<{ title: string; message: string; confirmLabel: string; onConfirm: () => void } | null>(null);

  useEffect(() => {
    loadData();
  }, [projectId]);

  async function loadData() {
    setLoading(true);
    try {
      const [allInts, projInts] = await Promise.all([
        apiFetch<Integration[]>('/api/integrations'),
        apiFetch<ProjectIntegration[]>(`/api/projects/${projectId}/integrations`),
      ]);
      setIntegrations(allInts);
      setProjectIntegrations(projInts);
    } catch (err) {
      console.error('Failed to load integrations:', err);
    } finally {
      setLoading(false);
    }
  }

  async function loadRepos(integrationId: string) {
    setLoadingRepos(true);
    try {
      const repoList = await apiFetch<ExternalRepo[]>(`/api/integrations/${integrationId}/repos`);
      setRepos(repoList);
    } catch (err) {
      console.error('Failed to load repos:', err);
    } finally {
      setLoadingRepos(false);
    }
  }

  function handleIntegrationSelect(intId: string) {
    setSelectedIntegrationId(intId);
    const integration = integrations.find(i => i.id === intId);
    if (integration && integration.capabilities.includes('vcs')) {
      loadRepos(intId);
    }
  }

  async function handleAttach() {
    if (!selectedIntegrationId) return;
    setAttaching(true);
    try {
      const config: any = {};
      if (selectedCapability === 'issues') {
        config.filters = {
          projects: issueFilters.projects.split(',').map(s => s.trim()).filter(Boolean),
          labels: issueFilters.labels.split(',').map(s => s.trim()).filter(Boolean),
          statuses: issueFilters.statuses.split(',').map(s => s.trim()).filter(Boolean),
          assignees: issueFilters.assignees.split(',').map(s => s.trim()).filter(Boolean),
          types: issueFilters.types.split(',').map(s => s.trim()).filter(Boolean),
        };
      } else {
        config.repos = Array.from(selectedRepos).map(fullName => {
          const repo = repos.find(r => r.fullName === fullName);
          return {
            fullName,
            defaultBranch: repo?.defaultBranch || 'main',
          };
        });
      }

      await apiFetch(`/api/projects/${projectId}/integrations`, {
        method: 'POST',
        body: JSON.stringify({
          integrationId: selectedIntegrationId,
          capability: selectedCapability,
          config,
        }),
      });

      setShowAttach(false);
      setSelectedIntegrationId('');
      setIssueFilters({ projects: '', labels: '', statuses: '', assignees: '', types: '' });
      setSelectedRepos(new Set());
      toast.success('Integration attached');
      await loadData();
    } catch (err: any) {
      toast.error(`Failed: ${err.message}`);
    } finally {
      setAttaching(false);
    }
  }

  function handleDetach(piId: string) {
    setConfirmDialog({
      title: 'Detach Integration',
      message: 'Detach this integration?',
      confirmLabel: 'Detach',
      onConfirm: async () => {
        setConfirmDialog(null);
        try {
          await apiFetch(`/api/projects/${projectId}/integrations/${piId}`, { method: 'DELETE' });
          toast.success('Integration detached');
          await loadData();
        } catch (err: any) {
          toast.error(`Failed: ${err.message}`);
        }
      },
    });
  }

  async function handleSync(piId: string) {
    setSyncing(piId);
    try {
      await apiFetch(`/api/projects/${projectId}/integrations/${piId}/sync`, { method: 'POST' });
      toast.success('Sync started');
      await loadData();
    } catch (err: any) {
      toast.error(`Sync failed: ${err.message}`);
    } finally {
      setSyncing(null);
    }
  }

  async function handleToggle(pi: ProjectIntegration) {
    try {
      await apiFetch(`/api/projects/${projectId}/integrations/${pi.id}`, {
        method: 'PUT',
        body: JSON.stringify({ enabled: !pi.enabled }),
      });
      await loadData();
    } catch (err: any) {
      toast.error(`Failed: ${err.message}`);
    }
  }

  function providerIcon(provider: string): string {
    if (provider === 'github') return '🐙';
    if (provider === 'jira') return '🔵';
    if (provider === 'bitbucket') return '🪣';
    return '🔌';
  }

  if (loading) {
    return <LoadingState message="Loading project…" />;
  }

  return (
    <div className="space-y-4">
      {/* Attach Integration */}
      {!showAttach && (
        <Button
          variant="ghost" onClick={() => setShowAttach(true)}
          className="px-4 py-2 rounded-lg text-sm font-medium bg-violet-500/20 text-violet-300 border border-violet-500/30 hover:bg-violet-500/30 transition-colors"
        >
          <Plus className="w-3.5 h-3.5 inline-block mr-1.5" />
          Attach Integration
        </Button>
      )}

      {showAttach && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4 space-y-4">
          <h3 className="text-sm font-semibold text-zinc-300">Attach Integration</h3>
          
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-zinc-400 mb-1.5">Integration</label>
              <Select value={selectedIntegrationId || '__none__'} onValueChange={(val) => handleIntegrationSelect(val === '__none__' ? '' : val)}>
                <SelectTrigger className="w-full border-zinc-800 bg-zinc-800/50">
                  <SelectValue placeholder="Select integration…" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">Select integration…</SelectItem>
                  {integrations.map(int => (
                    <SelectItem key={int.id} value={int.id}>{providerIcon(int.provider)} {int.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="block text-xs text-zinc-400 mb-1.5">Capability</label>
              <Select value={selectedCapability} onValueChange={(val) => setSelectedCapability(val as 'issues' | 'vcs')}>
                <SelectTrigger className="w-full border-zinc-800 bg-zinc-800/50">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="issues">Issues</SelectItem>
                  <SelectItem value="vcs">Version Control</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {selectedIntegrationId && selectedCapability === 'issues' && (
            <div className="space-y-2">
              <label className="block text-xs text-zinc-400">Filters (comma-separated)</label>
              <Input
                placeholder="Project keys (e.g., PROJ, TEAM)"
                value={issueFilters.projects}
                onChange={(e) => setIssueFilters({ ...issueFilters, projects: e.target.value })}
                className="w-full rounded-lg bg-zinc-800/50 border border-zinc-800 text-xs text-zinc-200 px-3 py-2 focus:outline-none focus:border-violet-500/50"
              />
              <Input
                placeholder="Labels (e.g., bug, feature)"
                value={issueFilters.labels}
                onChange={(e) => setIssueFilters({ ...issueFilters, labels: e.target.value })}
                className="w-full rounded-lg bg-zinc-800/50 border border-zinc-800 text-xs text-zinc-200 px-3 py-2 focus:outline-none focus:border-violet-500/50"
              />
              <Input
                placeholder="Statuses (e.g., To Do, In Progress)"
                value={issueFilters.statuses}
                onChange={(e) => setIssueFilters({ ...issueFilters, statuses: e.target.value })}
                className="w-full rounded-lg bg-zinc-800/50 border border-zinc-800 text-xs text-zinc-200 px-3 py-2 focus:outline-none focus:border-violet-500/50"
              />
              <Input
                placeholder="Assignees (e.g., @me, username)"
                value={issueFilters.assignees}
                onChange={(e) => setIssueFilters({ ...issueFilters, assignees: e.target.value })}
                className="w-full rounded-lg bg-zinc-800/50 border border-zinc-800 text-xs text-zinc-200 px-3 py-2 focus:outline-none focus:border-violet-500/50"
              />
              <Input
                placeholder="Issue types (e.g., Bug, Story)"
                value={issueFilters.types}
                onChange={(e) => setIssueFilters({ ...issueFilters, types: e.target.value })}
                className="w-full rounded-lg bg-zinc-800/50 border border-zinc-800 text-xs text-zinc-200 px-3 py-2 focus:outline-none focus:border-violet-500/50"
              />
            </div>
          )}

          {selectedIntegrationId && selectedCapability === 'vcs' && (
            <div>
              <label className="block text-xs text-zinc-400 mb-2">Repositories</label>
              {loadingRepos ? (
                <div className="text-xs text-zinc-500">Loading repos...</div>
              ) : repos.length === 0 ? (
                <div className="text-xs text-zinc-500">No repos available</div>
              ) : (
                <div className="space-y-1 max-h-48 overflow-y-auto">
                  {repos.map(repo => (
                    <div key={repo.fullName} className="hover:bg-zinc-800/50 px-2 py-1.5 rounded-lg">
                      <Checkbox
                        checked={selectedRepos.has(repo.fullName)}
                        onChange={(checked) => {
                          const newSet = new Set(selectedRepos);
                          if (checked) newSet.add(repo.fullName);
                          else newSet.delete(repo.fullName);
                          setSelectedRepos(newSet);
                        }}
                      >
                        <span className="text-xs text-zinc-300 flex items-center gap-1.5">
                          {repo.fullName}
                          {repo.defaultBranch && (
                            <span className="text-[10px] text-zinc-600">({repo.defaultBranch})</span>
                          )}
                        </span>
                      </Checkbox>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="flex gap-2 justify-end">
            <Button
              variant="ghost" onClick={() => { setShowAttach(false); setSelectedIntegrationId(''); }}
              className="px-3 py-1.5 rounded-lg text-xs text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700/50 transition-colors"
            >
              Cancel
            </Button>
            <Button
              variant="ghost" onClick={handleAttach}
              disabled={!selectedIntegrationId || attaching || (selectedCapability === 'vcs' && selectedRepos.size === 0)}
              className="px-3 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-xs font-medium transition-colors disabled:opacity-40"
            >
              {attaching ? 'Attaching…' : 'Attach'}
            </Button>
          </div>
        </div>
      )}

      {/* List of attached integrations */}
      <div className="space-y-2">
        {projectIntegrations.length === 0 ? (
          <div className="text-center py-12 text-zinc-500">
            <Plug className="w-8 h-8 mx-auto mb-2" />
            <p className="text-sm">No integrations attached to this project</p>
            <p className="text-xs mt-1">Click "Attach Integration" to get started</p>
          </div>
        ) : (
          projectIntegrations.map(pi => {
            const integration = integrations.find(i => i.id === pi.integrationId) || pi.integration;
            if (!integration) return null;
            
            return (
              <div key={pi.id} className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4 hover:bg-zinc-900/50 transition-colors">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-lg">{providerIcon(integration.provider)}</span>
                      <span className="text-sm font-medium text-zinc-200">{integration.name}</span>
                      <Badge variant="secondary" className="bg-zinc-700/50 text-zinc-400">
                        {pi.capability}
                      </Badge>
                      <Switch
                        checked={pi.enabled}
                        onCheckedChange={() => handleToggle(pi)}
                        title={pi.enabled ? 'Disable' : 'Enable'}
                      />
                    </div>
                    
                    {pi.lastSyncedAt && (
                      <div className="text-[10px] text-zinc-600">
                        Last synced {relativeTime(pi.lastSyncedAt)}
                      </div>
                    )}
                    
                    {pi.capability === 'issues' && pi.config?.filters && (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {Object.entries(pi.config.filters).map(([key, val]) => {
                          const arr = val as string[];
                          if (!arr || arr.length === 0) return null;
                          return (
                            <span key={key} className="text-[10px] px-1.5 py-0.5 rounded-full bg-zinc-800/50 text-zinc-500">
                              {key}: {arr.join(', ')}
                            </span>
                          );
                        })}
                      </div>
                    )}
                    
                    {pi.capability === 'vcs' && pi.config?.repos && (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {pi.config.repos.map((repo: any) => (
                          <span key={repo.fullName} className="text-[10px] px-1.5 py-0.5 rounded-full bg-zinc-800/50 text-zinc-500">
                            <GitBranch className="w-2.5 h-2.5 inline-block mr-0.5" />
                            {repo.fullName}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  
                  <div className="flex items-center gap-2 shrink-0">
                    <Button
                      variant="ghost" onClick={() => handleSync(pi.id)}
                      disabled={syncing === pi.id}
                      className="px-2.5 py-1.5 rounded-lg text-xs bg-blue-500/20 text-blue-300 hover:bg-blue-500/30 disabled:opacity-40"
                    >
                      {syncing === pi.id ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        'Sync Now'
                      )}
                    </Button>
                    <Button
                      variant="ghost" onClick={() => handleDetach(pi.id)}
                      className="text-zinc-600 hover:text-red-400 text-xs px-2 py-1"
                    >
                      Detach
                    </Button>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      <ConfirmDialog
        open={!!confirmDialog}
        title={confirmDialog?.title ?? ''}
        message={confirmDialog?.message ?? ''}
        confirmLabel={confirmDialog?.confirmLabel ?? 'Confirm'}
        destructive
        onConfirm={() => confirmDialog?.onConfirm()}
        onCancel={() => setConfirmDialog(null)}
      />
    </div>
  );
}

/* ── Metrics Tab ───────────────────────────────────── */

function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600000) return `${Math.round(ms / 60000)}m`;
  return `${(ms / 3600000).toFixed(1)}h`;
}

function MetricsTab({ metrics }: { metrics: ProjectMetrics | null }) {
  if (!metrics) {
    return (
      <LoadingState message="Loading metrics…" />
    );
  }

  const { tasks, workflows, agents, timing, github, activity } = metrics;

  const taskPcts = tasks.total > 0
    ? {
        completed: (tasks.completed / tasks.total) * 100,
        failed: (tasks.failed / tasks.total) * 100,
        running: (tasks.running / tasks.total) * 100,
        pending: (tasks.pending / tasks.total) * 100,
        blocked: (tasks.blocked / tasks.total) * 100,
      }
    : { completed: 0, failed: 0, running: 0, pending: 0, blocked: 0 };

  const maxDaily = Math.max(...(activity.daily || []).map(d => d.count), 1);

  const labelEntries = Object.entries(github.issuesByLabel).sort((a, b) => b[1] - a[1]);

  return (
    <div className="space-y-6">
      {/* Stats cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 px-4 py-3">
          <div className="flex items-center gap-1.5 text-[10px] uppercase text-zinc-600 tracking-wider">
            <CheckCircle2 className="w-3 h-3" /> Tasks Completed
          </div>
          <div className="text-xl font-bold text-emerald-300 mt-1">
            {tasks.completed}
            <span className="text-sm text-zinc-500 font-normal"> / {tasks.total}</span>
          </div>
        </div>
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 px-4 py-3">
          <div className="flex items-center gap-1.5 text-[10px] uppercase text-zinc-600 tracking-wider">
            <Workflow className="w-3 h-3" /> Workflow Runs
          </div>
          <div className="text-xl font-bold text-blue-300 mt-1">
            {workflows.completed}
            <span className="text-sm text-zinc-500 font-normal"> / {workflows.totalRuns}</span>
          </div>
        </div>
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 px-4 py-3">
          <div className="flex items-center gap-1.5 text-[10px] uppercase text-zinc-600 tracking-wider">
            <Timer className="w-3 h-3" /> Avg Task Duration
          </div>
          <div className="text-xl font-bold text-amber-300 mt-1">
            {formatDuration(timing.avgTaskDurationMs)}
          </div>
        </div>
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 px-4 py-3">
          <div className="flex items-center gap-1.5 text-[10px] uppercase text-zinc-600 tracking-wider">
            <Users className="w-3 h-3" /> Active Agents
          </div>
          <div className="text-xl font-bold text-violet-300 mt-1">
            {agents.activeOnProject}
            <span className="text-sm text-zinc-500 font-normal"> / {agents.assigned}</span>
          </div>
        </div>
      </div>

      {/* Charts row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Task status breakdown */}
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
          <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-3">Task Status Breakdown</h3>
          {tasks.total === 0 ? (
            <p className="text-sm text-zinc-600">No tasks yet</p>
          ) : (
            <>
              <div className="flex h-4 rounded-full overflow-hidden mb-3">
                {taskPcts.completed > 0 && <div className="bg-emerald-500 transition-all" style={{ width: `${taskPcts.completed}%` }} title={`Completed: ${tasks.completed}`} />}
                {taskPcts.running > 0 && <div className="bg-amber-500 transition-all" style={{ width: `${taskPcts.running}%` }} title={`Running: ${tasks.running}`} />}
                {taskPcts.pending > 0 && <div className="bg-blue-500 transition-all" style={{ width: `${taskPcts.pending}%` }} title={`Pending: ${tasks.pending}`} />}
                {taskPcts.blocked > 0 && <div className="bg-orange-500 transition-all" style={{ width: `${taskPcts.blocked}%` }} title={`Blocked: ${tasks.blocked}`} />}
                {taskPcts.failed > 0 && <div className="bg-red-500 transition-all" style={{ width: `${taskPcts.failed}%` }} title={`Failed: ${tasks.failed}`} />}
              </div>
              <div className="flex flex-wrap gap-3 text-[11px]">
                <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-emerald-500" /> Completed {tasks.completed}</span>
                <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-amber-500" /> Running {tasks.running}</span>
                <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-blue-500" /> Pending {tasks.pending}</span>
                <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-orange-500" /> Blocked {tasks.blocked}</span>
                <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-red-500" /> Failed {tasks.failed}</span>
              </div>
            </>
          )}
        </div>

        {/* Activity sparkline (last 7 days) */}
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
          <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-3">Activity — Last 7 Days</h3>
          <div className="flex items-end gap-1 h-24">
            {(activity.daily || []).map((day) => (
              <div key={day.date} className="flex-1 flex flex-col items-center gap-1">
                <div className="w-full relative flex items-end justify-center" style={{ height: '80px' }}>
                  <div
                    className="w-full rounded-t bg-violet-500/70 hover:bg-violet-400/80 transition-colors min-h-[2px]"
                    style={{ height: `${maxDaily > 0 ? (day.count / maxDaily) * 100 : 0}%` }}
                    title={`${day.date}: ${day.count} tasks`}
                  />
                </div>
                <span className="text-[9px] text-zinc-600">{day.date.slice(5)}</span>
              </div>
            ))}
          </div>
          <div className="flex justify-between mt-2 text-[10px] text-zinc-500">
            <span>24h: {activity.last24h}</span>
            <span>7d: {activity.last7d}</span>
            <span>30d: {activity.last30d}</span>
          </div>
        </div>
      </div>

      {/* Bottom row: Timing + Issues */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Timing stats */}
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
          <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-3">Timing</h3>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="text-[10px] text-zinc-600 uppercase">Avg Task</div>
              <div className="text-sm font-medium text-zinc-200">{formatDuration(timing.avgTaskDurationMs)}</div>
            </div>
            <div>
              <div className="text-[10px] text-zinc-600 uppercase">Avg Workflow</div>
              <div className="text-sm font-medium text-zinc-200">{formatDuration(timing.avgWorkflowDurationMs)}</div>
            </div>
            <div>
              <div className="text-[10px] text-zinc-600 uppercase">Fastest Task</div>
              <div className="text-sm font-medium text-emerald-300">{formatDuration(timing.fastestTaskMs)}</div>
            </div>
            <div>
              <div className="text-[10px] text-zinc-600 uppercase">Slowest Task</div>
              <div className="text-sm font-medium text-red-300">{formatDuration(timing.slowestTaskMs)}</div>
            </div>
          </div>
        </div>

        {/* Issue label distribution */}
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
          <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-3">
            GitHub Issues
            <span className="text-zinc-600 font-normal ml-2 normal-case">
              {github.totalIssues} total · {github.openIssues} open · {github.triagedIssues} triaged
            </span>
          </h3>
          {labelEntries.length === 0 ? (
            <p className="text-sm text-zinc-600">No labeled issues</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {labelEntries.map(([label, count]) => (
                <span
                  key={label}
                  className={`text-[11px] px-2 py-0.5 rounded-full border ${labelStyle(label)} font-medium`}
                >
                  {label} <span className="opacity-60">{count}</span>
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Settings Tab ──────────────────────────────────── */

function SettingsTab({ project, onUpdated }: { project: Project; onUpdated: (p: Project) => void }) {
  const navigate = useNavigate();
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description || '');
  const [icon, setIcon] = useState(project.icon || '');
  const [color, setColor] = useState(project.color || '#8b5cf6');
  const [contextMd, setContextMd] = useState(project.contextMd || '');
  const [repos, setRepos] = useState<ProjectRepository[]>(project.repositories || []);
  const [showAddRepo, setShowAddRepo] = useState(false);
  const [newRepoUrl, setNewRepoUrl] = useState('');
  const [newRepoBranch, setNewRepoBranch] = useState('');
  const [newRepoDir, setNewRepoDir] = useState('');
  const [wipLimit, setWipLimit] = useState(project.maxConcurrent || 3);
  const [syncInterval, setSyncInterval] = useState(project.githubSyncIntervalMinutes ?? 5);
  const [saving, setSaving] = useState(false);
  const [confirmDialog, setConfirmDialog] = useState<{ title: string; message: string; onConfirm: () => void } | null>(null);
  const [saved, setSaved] = useState(false);
  const [repoSaving, setRepoSaving] = useState(false);

  useEffect(() => {
    setName(project.name);
    setDescription(project.description || '');
    setIcon(project.icon || '');
    setColor(project.color || '#8b5cf6');
    setContextMd(project.contextMd || '');
    setRepos(project.repositories || []);
    setWipLimit(project.maxConcurrent || 3);
    setSyncInterval(project.githubSyncIntervalMinutes ?? 5);
    setSaved(false);
  }, [project.id]);

  async function handleSave() {
    setSaving(true);
    try {
      const updated = await apiFetch<Project>(`/api/projects/${project.id}`, {
        method: 'PUT',
        body: JSON.stringify({ name, description, icon, color, context_md: contextMd, maxConcurrent: wipLimit, githubSyncIntervalMinutes: syncInterval }),
      });
      onUpdated(updated);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch { /* ignore */ }
    setSaving(false);
  }

  async function saveRepos(newRepos: ProjectRepository[]) {
    setRepoSaving(true);
    try {
      const updated = await apiFetch<Project>(`/api/projects/${project.id}`, {
        method: 'PUT',
        body: JSON.stringify({ repositories: newRepos }),
      });
      setRepos(updated.repositories || []);
      onUpdated(updated);
    } catch { /* ignore */ }
    setRepoSaving(false);
  }

  async function handleAddRepo(e: React.FormEvent) {
    e.preventDefault();
    if (!newRepoUrl.trim()) return;
    const repo: ProjectRepository = { url: newRepoUrl.trim() };
    if (newRepoBranch.trim()) repo.defaultBranch = newRepoBranch.trim();
    if (newRepoDir.trim()) repo.cloneDir = newRepoDir.trim();
    await saveRepos([...repos, repo]);
    setNewRepoUrl('');
    setNewRepoBranch('');
    setNewRepoDir('');
    setShowAddRepo(false);
  }

  async function handleArchive() {
    const endpoint = project.archived ? 'unarchive' : 'archive';
    try {
      const updated = await apiFetch<Project>(`/api/projects/${project.id}/${endpoint}`, { method: 'POST' });
      onUpdated(updated);
    } catch { /* ignore */ }
  }

  function handleDelete() {
    setConfirmDialog({
      title: 'Delete Project',
      message: `Delete project "${project.name}"? This cannot be undone.`,
      onConfirm: async () => {
        setConfirmDialog(null);
        try {
          await apiFetch(`/api/projects/${project.id}`, { method: 'DELETE' });
          navigate('/projects');
        } catch { /* ignore */ }
      },
    });
  }

  return (
    <div className="space-y-6 max-w-2xl">
      {/* Basic Details */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-5 space-y-4">
        <h3 className="text-sm font-semibold text-zinc-200">Project Details</h3>
        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="text-[10px] uppercase text-zinc-500 tracking-wider block mb-1">Name</label>
              <Input
                value={name}
                onChange={e => { setName(e.target.value); setSaved(false); }}
                className="w-full rounded-lg bg-zinc-800/50 border border-zinc-800 text-zinc-200 text-sm px-3 py-2 focus:outline-none focus:border-violet-500/50"
              />
            </div>
            <div>
              <label className="text-[10px] uppercase text-zinc-500 tracking-wider block mb-1">Color</label>
            <div className="flex flex-wrap gap-1.5 p-2 rounded-lg bg-zinc-800/50 border border-zinc-800">
              {PROJECT_COLOURS.map(c => (
                <button
                  key={c}
                  type="button"
                  onClick={() => { setColor(c); setSaved(false); }}
                  title={c}
                  className={`w-6 h-6 rounded-full transition-all hover:scale-110 flex items-center justify-center ${
                    color === c
                      ? 'ring-2 ring-offset-2 ring-offset-zinc-900 ring-white scale-110'
                      : ''
                  }`}
                  style={{ backgroundColor: c }}
                >
                  {color === c && (
                    <svg className="w-3 h-3 text-white drop-shadow" viewBox="0 0 12 12" fill="none">
                      <path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  )}
                </button>
              ))}
            </div>
          </div>
          </div>
          <div>
            <label className="text-[10px] uppercase text-zinc-500 tracking-wider block mb-1">Icon</label>
            <div className="flex items-center gap-2 mb-2">
              <span className="text-xl w-6 text-center">{icon || '—'}</span>
              {icon && (
                <button
                  type="button"
                  onClick={() => { setIcon(''); setSaved(false); }}
                  className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors px-2 py-0.5 rounded bg-zinc-800 border border-zinc-700"
                >
                  Clear
                </button>
              )}
            </div>
            <div className="flex flex-wrap gap-0.5 p-1.5 rounded-lg bg-zinc-800/50 border border-zinc-800">
              {PROJECT_EMOJIS.map(emoji => (
                <button
                  key={emoji}
                  type="button"
                  onClick={() => { setIcon(emoji); setSaved(false); }}
                  title={emoji}
                  className={`w-7 h-7 flex items-center justify-center rounded text-base transition-all hover:bg-zinc-700 ${
                    icon === emoji ? 'bg-violet-600/40 ring-1 ring-violet-500' : ''
                  }`}
                >
                  {emoji}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div>
          <label className="text-[10px] uppercase text-zinc-500 tracking-wider block mb-1">Description</label>
          <Input
            value={description}
            onChange={e => { setDescription(e.target.value); setSaved(false); }}
            placeholder="What this project is about..."
            className="w-full rounded-lg bg-zinc-800/50 border border-zinc-800 text-zinc-200 text-sm px-3 py-2 focus:outline-none focus:border-violet-500/50"
          />
        </div>
        <div>
          <label className="text-[10px] uppercase text-zinc-500 tracking-wider block mb-1">WIP Limit</label>
          <div className="flex items-center gap-3">
            <Input
              type="number"
              min={1}
              max={20}
              value={wipLimit}
              onChange={e => { setWipLimit(Number(e.target.value) || 3); setSaved(false); }}
              className="w-20 rounded-lg bg-zinc-800/50 border border-zinc-800 text-zinc-200 text-sm px-3 py-2 focus:outline-none focus:border-violet-500/50"
            />
            <span className="text-xs text-zinc-500">Max concurrent tasks</span>
          </div>
        </div>
      </div>

      {/* GitHub Sync */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-5 space-y-3">
        <h3 className="text-sm font-semibold text-zinc-200">GitHub Sync</h3>
        <div className="flex items-center gap-3">
          <Input
            type="number"
            min={0}
            max={1440}
            value={syncInterval}
            onChange={e => { setSyncInterval(Number(e.target.value)); setSaved(false); }}
            className="w-20 rounded-lg bg-zinc-800/50 border border-zinc-800 text-zinc-200 text-sm px-3 py-2 focus:outline-none focus:border-violet-500/50"
          />
          <span className="text-xs text-zinc-500">Polling interval (minutes). Set to 0 to disable. Uses project integration token if available.</span>
        </div>
      </div>

      {/* Context */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-5 space-y-3">
        <h3 className="text-sm font-semibold text-zinc-200">Project Context (Markdown)</h3>
        <Textarea
          value={contextMd}
          onChange={e => { setContextMd(e.target.value); setSaved(false); }}
          rows={10}
          className="w-full rounded-lg bg-zinc-800/50 border border-zinc-800 text-zinc-200 text-sm px-3 py-2.5 focus:outline-none focus:border-violet-500/50 resize-y font-mono"
          placeholder="Add project context here. Injected into tasks sent with this project..."
        />
      </div>

      {/* Repositories */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-5 space-y-3">
        <h3 className="text-sm font-semibold text-zinc-200 flex items-center gap-1.5">
          <Package className="w-4 h-4" /> Repositories ({repos.length})
        </h3>
        {repos.length > 0 && (
          <div className="space-y-1">
            {repos.map((repo, i) => (
              <div key={i} className="group flex items-center gap-2 text-xs px-2.5 py-2 rounded-lg bg-zinc-900/50 border border-zinc-800">
                <span className="text-zinc-300 font-mono flex-1">
                  {repo.url.startsWith('http') ? (
                    <a href={repo.url} target="_blank" rel="noopener noreferrer" className="hover:text-violet-300 transition-colors">
                      {repo.url.replace(/^https?:\/\/github\.com\//, '')}
                    </a>
                  ) : (
                    <a href={`https://github.com/${repo.url}`} target="_blank" rel="noopener noreferrer" className="hover:text-violet-300 transition-colors">
                      {repo.url}
                    </a>
                  )}
                </span>
                {repo.defaultBranch && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-500/20 border border-blue-500/30 text-blue-300">
                    {repo.defaultBranch}
                  </span>
                )}
                <Button
                  variant="ghost" onClick={() => saveRepos(repos.filter((_, j) => j !== i))}
                  disabled={repoSaving}
                  className="opacity-0 group-hover:opacity-100 text-zinc-600 hover:text-red-400 transition-all"
                >
                  <X className="w-3.5 h-3.5" />
                </Button>
              </div>
            ))}
          </div>
        )}
        {showAddRepo ? (
          <form onSubmit={handleAddRepo} className="space-y-2 p-2.5 rounded-lg bg-zinc-900/50 border border-zinc-800">
            <Input
              value={newRepoUrl}
              onChange={e => setNewRepoUrl(e.target.value)}
              placeholder="owner/repo or https://github.com/..."
              className="w-full rounded-lg bg-zinc-800/50 border border-zinc-800 text-zinc-200 text-xs px-2.5 py-1.5 focus:outline-none focus:border-violet-500/50 font-mono"
              autoFocus
            />
            <div className="grid grid-cols-2 gap-2">
              <Input
                value={newRepoBranch}
                onChange={e => setNewRepoBranch(e.target.value)}
                placeholder="branch (default: main)"
                className="rounded-lg bg-zinc-800/50 border border-zinc-800 text-zinc-200 text-xs px-2.5 py-1.5 focus:outline-none focus:border-violet-500/50"
              />
              <Input
                value={newRepoDir}
                onChange={e => setNewRepoDir(e.target.value)}
                placeholder="clone dir (optional)"
                className="rounded-lg bg-zinc-800/50 border border-zinc-800 text-zinc-200 text-xs px-2.5 py-1.5 focus:outline-none focus:border-violet-500/50 font-mono"
              />
            </div>
            <div className="flex gap-2 justify-end">
              <Button variant="ghost" type="button" onClick={() => setShowAddRepo(false)} className="px-2 py-1 text-xs text-zinc-500 hover:text-zinc-300">Cancel</Button>
              <Button variant="ghost" type="submit" disabled={!newRepoUrl.trim() || repoSaving} className="px-3 py-1 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-white text-xs font-medium">
                {repoSaving ? 'Adding…' : 'Add'}
              </Button>
            </div>
          </form>
        ) : (
          <Button variant="ghost" onClick={() => setShowAddRepo(true)} className="text-xs text-violet-400 hover:text-violet-300 transition-colors">
            + Add Repository
          </Button>
        )}
      </div>

      {/* Save Button */}
      <div className="flex items-center gap-3">
        <Button
          variant="ghost" onClick={handleSave}
          disabled={saving}
          className="px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-white text-sm font-medium transition-colors"
        >
          {saving ? 'Saving…' : 'Save Changes'}
        </Button>
        {saved && <span className="text-sm text-emerald-400">✓ Saved</span>}
      </div>

      {/* Danger Zone */}
      <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-5 space-y-3">
        <h3 className="text-sm font-semibold text-red-300">Danger Zone</h3>
        <div className="flex items-center gap-3">
          <Button
            variant="ghost" onClick={handleArchive}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium ${
              project.archived
                ? 'bg-emerald-500/20 border border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/30'
                : 'bg-orange-500/20 border border-orange-500/30 text-orange-300 hover:bg-orange-500/30'
            }`}
          >
            {project.archived ? 'Unarchive Project' : 'Archive Project'}
          </Button>
          <Button
            variant="ghost" onClick={handleDelete}
            className="px-3 py-1.5 rounded-lg text-xs font-medium bg-red-500/20 border border-red-500/30 text-red-300 hover:bg-red-500/30"
          >
            Delete Project
          </Button>
        </div>
      </div>

      <ConfirmDialog
        open={!!confirmDialog}
        title={confirmDialog?.title ?? ''}
        message={confirmDialog?.message ?? ''}
        confirmLabel="Delete"
        destructive
        onConfirm={() => confirmDialog?.onConfirm()}
        onCancel={() => setConfirmDialog(null)}
      />
    </div>
  );
}

/* ── Main Page ─────────────────────────────────────── */

export default function ProjectDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const { data: projectData, isLoading: projectLoading, refetch: refetchProject } = useProject(id);
  const project = (projectData as Project) ?? null;
  const [issues, setIssues] = useState<GitHubIssue[]>([]);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowInfo[]>([]);
  const [tasks, setTasks] = useState<ArmadaTask[]>([]);
  const [metrics, setMetrics] = useState<ProjectMetrics | null>(null);

  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [lastSynced, setLastSynced] = useState<string | null>(null);
  const [triageModalIssue, setTriageModalIssue] = useState<TriageIssue | null>(null);

  const loadData = useCallback(async () => {
    if (!id || !project) return;
    setLoading(true);
    try {
      const [issueData, memberData, taskData, metricsData] = await Promise.all([
        apiFetch<GitHubIssue[]>(`/api/projects/${id}/issues`).catch(() => []),
        apiFetch<{ members: AgentInfo[] }>(`/api/projects/${id}/members`).catch(() => ({ members: [] })),
        apiFetch<ArmadaTask[]>(`/api/tasks?projectId=${encodeURIComponent(project.name)}&limit=50`).catch(() => []),
        apiFetch<ProjectMetrics>(`/api/projects/${id}/metrics`).catch(() => null),
      ]);
      setMetrics(metricsData);
      setIssues(issueData);
      if (issueData.length > 0) {
        setLastSynced(new Date().toISOString());
      }

      // Members could be strings or objects
      const membersList = memberData.members || [];
      if (membersList.length > 0 && typeof membersList[0] === 'string') {
        // Fetch agent details for string member names
        try {
          const agentsData = await apiFetch<AgentInfo[]>('/api/agents');
          const memberNames = membersList as unknown as string[];
          setAgents(
            agentsData.filter((a: AgentInfo) => memberNames.includes(a.name)),
          );
        } catch {
          setAgents(
            (membersList as unknown as string[]).map((name: string) => ({
              name,
              role: '',
              status: 'unknown',
              healthStatus: 'unknown',
            })),
          );
        }
      } else {
        setAgents(membersList as AgentInfo[]);
      }

      setTasks(taskData);

      // Load workflows
      try {
        const wfData = await apiFetch<WorkflowInfo[]>('/api/workflows');
        const projectWorkflows = wfData.filter((wf) => {
          if (wf.projectIds && wf.projectIds.includes(project.id)) return true;
          if (wf.projectIds && wf.projectIds.includes(project.name)) return true;
          if (wf.projectId === project.id || wf.projectId === project.name) return true;
          return false;
        });
        setWorkflows(projectWorkflows);
      } catch {
        setWorkflows([]);
      }
    } catch (err) {
      console.error('Failed to load project:', err);
    } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, project?.id]);

  useEffect(() => {
    if (project) loadData();
  }, [loadData, project]);

  async function handleSync() {
    if (!project) return;
    setSyncing(true);
    try {
      await apiFetch(`/api/projects/${project.id}/sync`, { method: 'POST' });
      // Reload issues after sync
      const issueData = await apiFetch<GitHubIssue[]>(`/api/projects/${project.id}/issues`);
      setIssues(issueData);
      setLastSynced(new Date().toISOString());
    } catch (err) {
      console.error('Sync failed:', err);
    } finally {
      setSyncing(false);
    }
  }

  if (projectLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-zinc-500 text-sm animate-pulse">Loading project…</div>
      </div>
    );
  }

  if (!project) {
    return (
      <div className="text-center py-12">
        <AlertCircle className="w-10 h-10 text-zinc-600 mx-auto" />
        <p className="text-zinc-400 mt-2">Project not found</p>
        <Link
          to="/projects"
          className="text-sm text-violet-400 hover:text-violet-300 mt-2 inline-block"
        >
          ← Back to Projects
        </Link>
      </div>
    );
  }

  const openIssues = issues.filter((i) => i.state === 'open').length;

  return (
    <div className="space-y-6 max-w-6xl">
      {/* Breadcrumb + Header */}
      <div>
        <Link
          to="/projects"
          className="text-xs text-zinc-500 hover:text-zinc-300 flex items-center gap-1 mb-3 transition-colors"
        >
          <ArrowLeft className="w-3 h-3" />
          Projects
        </Link>

        <PageHeader
          icon={FolderKanban}
          title={project.name}
          subtitle={project.description || undefined}
        >
          {project.archived && (
            <Badge variant="secondary" className="text-[10px] uppercase tracking-wider bg-zinc-500/20 -gray-500/30 text-zinc-400">
              Archived
            </Badge>
          )}
          <Button
            variant="ghost" onClick={handleSync}
            disabled={syncing}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-zinc-800/50 border border-zinc-800 hover:bg-zinc-700/50 text-sm text-zinc-300 transition-colors disabled:opacity-40"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} />
            Sync Issues
          </Button>
        </PageHeader>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 px-4 py-3">
          <div className="text-[10px] uppercase text-zinc-600 tracking-wider">Issues</div>
          <div className="text-xl font-bold text-zinc-100 mt-0.5">{issues.length}</div>
        </div>
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 px-4 py-3">
          <div className="text-[10px] uppercase text-zinc-600 tracking-wider">Open</div>
          <div className="text-xl font-bold text-emerald-300 mt-0.5">{openIssues}</div>
        </div>
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 px-4 py-3">
          <div className="text-[10px] uppercase text-zinc-600 tracking-wider">Agents</div>
          <div className="text-xl font-bold text-violet-300 mt-0.5">{agents.length}</div>
        </div>
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 px-4 py-3">
          <div className="text-[10px] uppercase text-zinc-600 tracking-wider">Workflows</div>
          <div className="text-xl font-bold text-blue-300 mt-0.5">{workflows.length}</div>
        </div>
      </div>

      {/* Tabs */}
      <Tabs defaultValue="metrics">
        <TabsList>
          <TabsTrigger value="metrics" className="flex items-center gap-2 group">
            <BarChart3 className="w-4 h-4" /> Metrics
          </TabsTrigger>
          <TabsTrigger value="issues" className="flex items-center gap-2 group">
            <GitPullRequest className="w-4 h-4" /> Issues
            {issues.length > 0 && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full font-mono bg-zinc-700/50 text-zinc-500 group-data-[state=active]:bg-violet-500/20 group-data-[state=active]:text-violet-300">
                {issues.length}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="workflows" className="flex items-center gap-2 group">
            <Workflow className="w-4 h-4" /> Workflows
            {workflows.length > 0 && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full font-mono bg-zinc-700/50 text-zinc-500 group-data-[state=active]:bg-violet-500/20 group-data-[state=active]:text-violet-300">
                {workflows.length}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="agents" className="flex items-center gap-2 group">
            <Users className="w-4 h-4" /> Agents
            {agents.length > 0 && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full font-mono bg-zinc-700/50 text-zinc-500 group-data-[state=active]:bg-violet-500/20 group-data-[state=active]:text-violet-300">
                {agents.length}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="activity" className="flex items-center gap-2 group">
            <Activity className="w-4 h-4" /> Activity
            {tasks.length > 0 && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full font-mono bg-zinc-700/50 text-zinc-500 group-data-[state=active]:bg-violet-500/20 group-data-[state=active]:text-violet-300">
                {tasks.length}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="assignments" className="flex items-center gap-2">
            <Crown className="w-4 h-4" /> Assignments
          </TabsTrigger>
          <TabsTrigger value="integrations" className="flex items-center gap-2">
            <Plug className="w-4 h-4" /> Integrations
          </TabsTrigger>
          <TabsTrigger value="settings" className="flex items-center gap-2">
            <Settings className="w-4 h-4" /> Settings
          </TabsTrigger>
        </TabsList>

        <TabsContent value="metrics">
          <MetricsTab metrics={metrics} />
        </TabsContent>
        <TabsContent value="issues">
          <IssuesTab
            projectId={project.id}
            issues={issues}
            syncing={syncing}
            lastSynced={lastSynced}
            onSync={handleSync}
            onTriageOne={(issue) => setTriageModalIssue(issue)}
          />
        </TabsContent>
        <TabsContent value="workflows">
          <WorkflowsTab workflows={workflows} />
        </TabsContent>
        <TabsContent value="agents">
          <AgentsTab agents={agents} />
        </TabsContent>
        <TabsContent value="activity">
          <ActivityTab tasks={tasks} />
        </TabsContent>
        <TabsContent value="assignments">
          <ProjectAssignments projectId={project.id} />
        </TabsContent>
        <TabsContent value="integrations">
          <IntegrationsTab projectId={project.id} />
        </TabsContent>
        <TabsContent value="settings">
          <SettingsTab project={project} onUpdated={() => { refetchProject(); loadData(); }} />
        </TabsContent>
      </Tabs>

      {/* Manual triage modal */}
      <TriageModal
        open={!!triageModalIssue}
        issue={triageModalIssue}
        projectId={project.id}
        onSuccess={() => {
          setTriageModalIssue(null);
          loadData();
        }}
        onCancel={() => setTriageModalIssue(null)}
      />
    </div>
  );
}
