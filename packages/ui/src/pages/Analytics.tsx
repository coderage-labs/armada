import { useState, useEffect, useMemo } from 'react';
import { BarChart3, TrendingUp, TrendingDown, Clock, CheckCircle2, Award, Trophy } from 'lucide-react';
import { apiFetch } from '../hooks/useApi';
import { PageHeader } from '../components/PageHeader';
import { Badge } from '../components/ui/badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../components/ui/tabs';
import {
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';

/* ── Types ─────────────────────────────────────────── */

interface WorkflowAnalytics {
  workflowId: string;
  workflowName: string;
  totalRuns: number;
  completed: number;
  failed: number;
  cancelled: number;
  completionRate: number;
  avgDurationMs: number;
  avgStepDurationMs?: number;
  avgGateWaitMs?: number;
  avgReviewScore?: number;
  runsThisWeek: number;
  trend?: 'up' | 'down' | 'stable';
}

interface AgentAnalytics {
  agent: string;
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  avgDurationMs: number;
  avgReviewScore?: number;
  reviewCount: number;
  rank: string | { name: string; title: string; minScore: number };
  topCategories?: string[];
}

interface RecentRun {
  id: string;
  workflowId: string;
  workflowName: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  triggerRef?: string;
  createdAt: string;
  completedAt?: string;
  durationMs?: number;
  steps?: any[];
}

interface PromptVersion {
  version: number;
  avgScore: number;
  totalUses: number;
  totalReviews: number;
}

interface PromptAnalytics {
  stepId: string;
  versions: PromptVersion[];
}

/* ── Helpers ───────────────────────────────────────── */

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  return `${Math.floor(ms / 3_600_000)}h`;
}

function relativeTime(dateStr: string): string {
  const iso = dateStr.includes('T') ? dateStr : dateStr.replace(' ', 'T');
  const diff = Date.now() - new Date(iso).getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 5) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

/* ── Rank colors ───────────────────────────────────── */

const RANK_COLORS: Record<string, { bg: string; text: string }> = {
  Cadet: { bg: 'bg-zinc-500/20', text: 'text-zinc-400' },
  Lieutenant: { bg: 'bg-blue-500/20', text: 'text-blue-400' },
  Commander: { bg: 'bg-violet-500/20', text: 'text-violet-400' },
  Captain: { bg: 'bg-amber-500/20', text: 'text-amber-400' },
  Admiral: { bg: 'bg-red-500/20', text: 'text-red-400' },
};

/* ── Status colors ─────────────────────────────────── */

const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  completed: { bg: 'bg-emerald-500/20', text: 'text-emerald-400' },
  failed: { bg: 'bg-red-500/20', text: 'text-red-400' },
  cancelled: { bg: 'bg-zinc-500/20', text: 'text-zinc-400' },
  running: { bg: 'bg-blue-500/20', text: 'text-blue-400' },
  pending: { bg: 'bg-amber-500/20', text: 'text-amber-400' },
};

/* ── Stat Card ─────────────────────────────────────── */

function StatCard({
  label,
  value,
  icon: Icon,
  accentColor,
}: {
  label: string;
  value: React.ReactNode;
  icon: typeof Clock;
  accentColor: string;
}) {
  return (
    <div className="relative overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/50 hover:bg-zinc-800/50 transition-all duration-200">
      <div className={`absolute top-0 left-0 right-0 h-[2px] ${accentColor}`} />
      <div className="p-5">
        <div className="flex items-start justify-between mb-2">
          <p className="text-[11px] font-medium text-zinc-500 uppercase tracking-wider">{label}</p>
          <div className="p-2 rounded-lg bg-zinc-800/80">
            <Icon className={`w-5 h-5 ${accentColor.replace('bg-', 'text-').replace('/80', '')}`} />
          </div>
        </div>
        <div className="text-3xl font-bold tracking-tight text-zinc-50">{value}</div>
      </div>
    </div>
  );
}

/* ── Workflows Tab ─────────────────────────────────── */

function WorkflowsTab() {
  const [workflows, setWorkflows] = useState<WorkflowAnalytics[]>([]);
  const [expandedWorkflow, setExpandedWorkflow] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiFetch<WorkflowAnalytics[]>('/api/analytics/workflows')
      .then(setWorkflows)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const stats = useMemo(() => {
    const totalRuns = workflows.reduce((sum, w) => sum + w.totalRuns, 0);
    const completed = workflows.reduce((sum, w) => sum + w.completed, 0);
    const failed = workflows.reduce((sum, w) => sum + w.failed, 0);
    const avgCompletionRate = workflows.length > 0
      ? Math.round(workflows.reduce((sum, w) => sum + w.completionRate, 0) / workflows.length)
      : 0;
    const avgDuration = workflows.length > 0
      ? workflows.reduce((sum, w) => sum + w.avgDurationMs, 0) / workflows.length
      : 0;
    const avgReviewScore = workflows.filter(w => w.avgReviewScore).length > 0
      ? workflows.reduce((sum, w) => sum + (w.avgReviewScore || 0), 0) / workflows.filter(w => w.avgReviewScore).length
      : 0;

    return { totalRuns, completed, failed, avgCompletionRate, avgDuration, avgReviewScore };
  }, [workflows]);

  // Chart data
  const completionChartData = workflows.map(w => ({
    name: w.workflowName.length > 20 ? w.workflowName.slice(0, 20) + '…' : w.workflowName,
    rate: Math.round(w.completionRate),
  }));

  const statusPieData = [
    { name: 'Completed', value: stats.completed, color: '#10b981' },
    { name: 'Failed', value: stats.failed, color: '#ef4444' },
  ];

  if (loading) {
    return <div className="text-center py-12 text-zinc-500">Loading workflows...</div>;
  }

  return (
    <div className="space-y-6">
      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="Total Runs" value={stats.totalRuns} icon={TrendingUp} accentColor="bg-violet-500" />
        <StatCard label="Completion Rate" value={`${stats.avgCompletionRate}%`} icon={CheckCircle2} accentColor="bg-emerald-500" />
        <StatCard label="Avg Duration" value={formatDuration(stats.avgDuration)} icon={Clock} accentColor="bg-blue-500" />
        <StatCard
          label="Avg Review Score"
          value={stats.avgReviewScore > 0 ? stats.avgReviewScore.toFixed(1) : '—'}
          icon={Award}
          accentColor="bg-amber-500"
        />
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-5">
          <h3 className="text-sm font-semibold text-zinc-300 mb-4">Completion Rate by Workflow</h3>
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={completionChartData}>
              <XAxis dataKey="name" stroke="#71717a" fontSize={11} />
              <YAxis stroke="#71717a" fontSize={11} />
              <RechartsTooltip
                contentStyle={{ backgroundColor: '#18181b', border: '1px solid #3f3f46', borderRadius: '8px' }}
                labelStyle={{ color: '#e4e4e7' }}
              />
              <Bar dataKey="rate" fill="#8b5cf6" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-5">
          <h3 className="text-sm font-semibold text-zinc-300 mb-4">Status Distribution</h3>
          <ResponsiveContainer width="100%" height={250}>
            <PieChart>
              <Pie
                data={statusPieData}
                cx="50%"
                cy="50%"
                outerRadius={80}
                fill="#8884d8"
                dataKey="value"
                label={(entry) => `${entry.name}: ${entry.value}`}
              >
                {statusPieData.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={entry.color} />
                ))}
              </Pie>
              <RechartsTooltip
                contentStyle={{ backgroundColor: '#18181b', border: '1px solid #3f3f46', borderRadius: '8px' }}
              />
            </PieChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Workflow table */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-5">
        <h3 className="text-sm font-semibold text-zinc-300 mb-3">Workflows</h3>
        <div className="space-y-1">
          {workflows.map(workflow => (
            <div key={workflow.workflowId} className="border border-zinc-800 rounded-lg overflow-hidden">
              <div
                onClick={() => setExpandedWorkflow(expandedWorkflow === workflow.workflowId ? null : workflow.workflowId)}
                className="flex items-center gap-3 p-3 hover:bg-zinc-800/40 cursor-pointer transition-colors"
              >
                <span className="text-sm text-zinc-300 font-medium flex-1">{workflow.workflowName}</span>
                <span className="text-xs text-zinc-500">{workflow.totalRuns} runs</span>
                <span className="text-xs text-zinc-500">{Math.round(workflow.completionRate)}%</span>
                <span className="text-xs text-zinc-500">{formatDuration(workflow.avgDurationMs)}</span>
                {workflow.trend === 'up' && <TrendingUp className="w-4 h-4 text-emerald-400" />}
                {workflow.trend === 'down' && <TrendingDown className="w-4 h-4 text-red-400" />}
              </div>
              {expandedWorkflow === workflow.workflowId && (
                <div className="border-t border-zinc-800 p-3 bg-zinc-900/30 text-xs text-zinc-500 space-y-1">
                  <p>Avg step duration: {formatDuration(workflow.avgStepDurationMs || 0)}</p>
                  <p>Avg gate wait: {formatDuration(workflow.avgGateWaitMs || 0)}</p>
                  {workflow.avgReviewScore && <p>Avg review score: {workflow.avgReviewScore.toFixed(1)}</p>}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ── Agents Tab ────────────────────────────────────── */

function AgentsTab() {
  const [agents, setAgents] = useState<AgentAnalytics[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiFetch<AgentAnalytics[]>('/api/analytics/agents')
      .then(data => {
        // Sort by totalTasks desc
        setAgents(data.sort((a, b) => b.totalTasks - a.totalTasks));
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <div className="text-center py-12 text-zinc-500">Loading agents...</div>;
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {agents.map(agent => {
          const rankStyle = RANK_COLORS[typeof agent.rank === 'object' ? agent.rank.title : agent.rank] || RANK_COLORS.Cadet;
          return (
            <div key={agent.agent} className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-5 hover:bg-zinc-800/50 transition-colors">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-lg font-semibold text-zinc-200">{agent.agent}</h3>
                <Badge className={`${rankStyle.bg} ${rankStyle.text} text-xs font-bold`}>
                  {typeof agent.rank === 'object' ? agent.rank.title : agent.rank}
                </Badge>
              </div>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-zinc-500">Total tasks:</span>
                  <span className="text-zinc-300 font-medium">{agent.totalTasks}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-zinc-500">Completed:</span>
                  <span className="text-emerald-400 font-medium">{agent.completedTasks}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-zinc-500">Failed:</span>
                  <span className="text-red-400 font-medium">{agent.failedTasks}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-zinc-500">Avg duration:</span>
                  <span className="text-zinc-300 font-medium">{formatDuration(agent.avgDurationMs)}</span>
                </div>
                {agent.avgReviewScore !== undefined && (
                  <div className="flex justify-between">
                    <span className="text-zinc-500">Avg score:</span>
                    <span className="text-amber-400 font-medium">{agent.avgReviewScore.toFixed(1)}</span>
                  </div>
                )}
                {agent.topCategories && agent.topCategories.length > 0 && (
                  <div className="mt-3 pt-3 border-t border-zinc-800">
                    <p className="text-xs text-zinc-600 mb-1">Top categories:</p>
                    <div className="flex flex-wrap gap-1">
                      {agent.topCategories.slice(0, 3).map(cat => (
                        <Badge key={cat} className="bg-violet-500/20 text-violet-400 text-[10px]">
                          {cat}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ── Recent Runs Tab ───────────────────────────────── */

function RecentRunsTab() {
  const [runs, setRuns] = useState<RecentRun[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiFetch<RecentRun[]>('/api/analytics/runs/recent?limit=20')
      .then(setRuns)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <div className="text-center py-12 text-zinc-500">Loading recent runs...</div>;
  }

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-5">
      <h3 className="text-sm font-semibold text-zinc-300 mb-3">Recent Runs</h3>
      <div className="space-y-1">
        {runs.map(run => {
          const statusStyle = STATUS_COLORS[run.status] || STATUS_COLORS.pending;
          return (
            <div
              key={run.id}
              className="flex items-center gap-3 p-3 rounded-lg hover:bg-zinc-800/40 transition-colors border border-zinc-800"
            >
              <Badge className={`${statusStyle.bg} ${statusStyle.text} text-xs capitalize shrink-0`}>
                {run.status}
              </Badge>
              <span className="text-sm text-zinc-300 flex-1 truncate">{run.workflowName}</span>
              {run.durationMs !== undefined && (
                <span className="text-xs text-zinc-500">{formatDuration(run.durationMs)}</span>
              )}
              {run.triggerRef && (
                <span className="text-xs text-zinc-600 font-mono">{run.triggerRef.slice(0, 8)}</span>
              )}
              <span className="text-xs text-zinc-600">{relativeTime(run.createdAt)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ── Prompt Performance Tab ────────────────────────── */

function PromptPerformanceTab() {
  const [workflows, setWorkflows] = useState<WorkflowAnalytics[]>([]);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(null);
  const [prompts, setPrompts] = useState<PromptAnalytics[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiFetch<WorkflowAnalytics[]>('/api/analytics/workflows')
      .then(data => {
        setWorkflows(data);
        if (data.length > 0) setSelectedWorkflowId(data[0].workflowId);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!selectedWorkflowId) return;
    apiFetch<PromptAnalytics[]>(`/api/analytics/prompts/${selectedWorkflowId}`)
      .then(setPrompts)
      .catch(() => {});
  }, [selectedWorkflowId]);

  if (loading) {
    return <div className="text-center py-12 text-zinc-500">Loading workflows...</div>;
  }

  return (
    <div className="space-y-6">
      {/* Workflow selector */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
        <label className="text-xs text-zinc-500 uppercase tracking-wider mb-2 block">Select Workflow</label>
        <select
          value={selectedWorkflowId || ''}
          onChange={e => setSelectedWorkflowId(e.target.value)}
          className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-300 focus:outline-none focus:ring-2 focus:ring-violet-500"
        >
          {workflows.map(w => (
            <option key={w.workflowId} value={w.workflowId}>
              {w.workflowName}
            </option>
          ))}
        </select>
      </div>

      {/* Prompt versions */}
      {prompts.length === 0 ? (
        <div className="text-center py-12 text-zinc-500">No prompt performance data available</div>
      ) : (
        <div className="space-y-4">
          {prompts.map(prompt => (
            <div key={prompt.stepId} className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-5">
              <h3 className="text-sm font-semibold text-zinc-300 mb-3">Step: {prompt.stepId}</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                {prompt.versions.map(version => {
                  const isBest = version.avgScore === Math.max(...prompt.versions.map(v => v.avgScore));
                  return (
                    <div
                      key={version.version}
                      className={`p-4 rounded-lg border ${
                        isBest ? 'border-emerald-500 bg-emerald-500/10' : 'border-zinc-800 bg-zinc-800/30'
                      }`}
                    >
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs text-zinc-500">Version {version.version}</span>
                        {isBest && <Trophy className="w-4 h-4 text-emerald-400" />}
                      </div>
                      <div className="space-y-1 text-sm">
                        <div className="flex justify-between">
                          <span className="text-zinc-500">Avg score:</span>
                          <span className={`font-medium ${isBest ? 'text-emerald-400' : 'text-zinc-300'}`}>
                            {version.avgScore.toFixed(1)}
                          </span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-zinc-500">Uses:</span>
                          <span className="text-zinc-400">{version.totalUses}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-zinc-500">Reviews:</span>
                          <span className="text-zinc-400">{version.totalReviews}</span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Main Analytics Component ──────────────────────── */

export default function Analytics() {
  return (
    <div className="space-y-6">
      <PageHeader icon={BarChart3} title="Analytics" subtitle="Workflow and agent performance metrics" />

      <Tabs defaultValue="workflows" className="w-full">
        <TabsList className="grid w-full grid-cols-4 mb-6">
          <TabsTrigger value="workflows">Workflows</TabsTrigger>
          <TabsTrigger value="agents">Agents</TabsTrigger>
          <TabsTrigger value="runs">Recent Runs</TabsTrigger>
          <TabsTrigger value="prompts">Prompt Performance</TabsTrigger>
        </TabsList>

        <TabsContent value="workflows">
          <WorkflowsTab />
        </TabsContent>

        <TabsContent value="agents">
          <AgentsTab />
        </TabsContent>

        <TabsContent value="runs">
          <RecentRunsTab />
        </TabsContent>

        <TabsContent value="prompts">
          <PromptPerformanceTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
