import { useState, useMemo, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useRoles } from '../hooks/useRoles';
import { useAgents } from '../hooks/queries/useAgents';
import { useTasks } from '../hooks/queries/useTasks';
import { useActivity } from '../hooks/queries/useActivity';
import type { Agent, MeshTask, ActivityEvent } from '@coderage-labs/armada-shared';
import {
  Rocket, Bomb, RefreshCw, RotateCw, Square, Play, Zap, Clock,
  CheckCircle2, XCircle, GitBranch, Radio, FileCode, Pencil, Trash2, Pin, Home,
  CircleDot, AlertCircle, ShieldAlert, Loader2, Users, Activity, ArrowRight,
  TrendingUp, TrendingDown, Minus,
} from 'lucide-react';
import { PageHeader } from '../components/PageHeader';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
// Card component available but using inline divs for consistent padding control
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../components/ui/tooltip';

/* ── Helpers ───────────────────────────────────────── */

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

function parseDate(dateStr: string): Date {
  const iso = dateStr.includes('T') ? dateStr : dateStr.replace(' ', 'T');
  return new Date(iso);
}

function isToday(dateStr: string): boolean {
  const d = parseDate(dateStr);
  const now = new Date();
  return d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
}

function isWithinDays(dateStr: string, days: number): boolean {
  const d = parseDate(dateStr);
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return d.getTime() >= cutoff;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
  return `${Math.floor(ms / 3_600_000)}h ${Math.floor((ms % 3_600_000) / 60_000)}m`;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/* ── Status config ─────────────────────────────────── */

const STATUS_ICON: Record<string, { icon: typeof CheckCircle2; color: string }> = {
  pending:   { icon: Clock, color: 'text-amber-400' },
  running:   { icon: Loader2, color: 'text-blue-400' },
  completed: { icon: CheckCircle2, color: 'text-emerald-400' },
  failed:    { icon: XCircle, color: 'text-red-400' },
  blocked:   { icon: ShieldAlert, color: 'text-orange-400' },
};

const HEALTH_DOT: Record<string, string> = {
  healthy:      'bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.5)]',
  degraded:     'bg-amber-500 shadow-[0_0_6px_rgba(245,158,11,0.5)]',
  unresponsive: 'bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.5)]',
  offline:      'bg-zinc-600',
  unknown:      'bg-zinc-600',
};

/* ── Activity event icons ──────────────────────────── */

const ic = "w-3.5 h-3.5";
const EVENT_ICONS: Record<string, ReactNode> = {
  'agent.spawn':     <Rocket className={ic} />,
  'agent.destroy':   <Bomb className={ic} />,
  'agent.redeploy':  <RefreshCw className={ic} />,
  'agent.restart':   <RotateCw className={ic} />,
  'agent.stop':      <Square className={ic} />,
  'agent.start':     <Play className={ic} />,
  'task.created':    <Zap className={ic} />,
  'task.completed':  <CheckCircle2 className={ic} />,
  'task.failed':     <XCircle className={ic} />,
  'hierarchy.updated': <GitBranch className={ic} />,
  'contacts.synced': <Radio className={ic} />,
  'template.created':  <FileCode className={ic} />,
  'template.updated':  <Pencil className={ic} />,
  'template.deleted':  <Trash2 className={ic} />,
};

/* ── Stat Card ─────────────────────────────────────── */

function StatCard({
  label,
  value,
  sub,
  icon: Icon,
  accentColor,
  onClick,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  icon: typeof Clock;
  accentColor: string;
  onClick?: () => void;
}) {
  return (
    <div
      className={`group relative overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/50 hover:bg-zinc-800/50 transition-all duration-200 h-full ${onClick ? 'cursor-pointer' : ''}`}
      onClick={onClick}
    >
      {/* Accent top bar */}
      <div className={`absolute top-0 left-0 right-0 h-[2px] ${accentColor}`} />
      <div className="p-5 flex flex-col justify-between h-full">
        <div className="flex items-start justify-between mb-2">
          <p className="text-[11px] font-medium text-zinc-500 uppercase tracking-wider">{label}</p>
          <div className="p-2 rounded-lg bg-zinc-800/80 shrink-0">
            <Icon className={`w-5 h-5 ${accentColor.replace('bg-', 'text-').replace('/80', '').replace('/60', '')}`} />
          </div>
        </div>
        <div>
          <div className="text-3xl font-bold tracking-tight text-zinc-50">{value}</div>
          <div className="text-xs text-zinc-500 mt-1 min-h-[1rem]">{sub || '\u00A0'}</div>
        </div>
      </div>
    </div>
  );
}

/* ── Section Header ────────────────────────────────── */

function SectionHeader({ title, actionLabel, onAction }: { title: string; actionLabel?: string; onAction?: () => void }) {
  return (
    <div className="flex items-center justify-between mb-1">
      <h3 className="text-sm font-semibold text-zinc-300">{title}</h3>
      {actionLabel && onAction && (
        <Button
          variant="ghost"
          size="sm"
          onClick={onAction}
          className="text-xs text-violet-400 hover:text-violet-300 gap-1 h-7 px-2"
        >
          {actionLabel}
          <ArrowRight className="w-3 h-3" />
        </Button>
      )}
    </div>
  );
}

/* ── Dashboard Component ───────────────────────────── */

export default function Dashboard() {
  const navigate = useNavigate();
  const { getRoleColor } = useRoles();
  const { data: agents = [] } = useAgents();
  const { data: tasks = [] } = useTasks();
  const { data: activity = [] } = useActivity();
  const [successRateRange, setSuccessRateRange] = useState<'all' | '7d'>('7d');

  /* ── Stats calculations ──────────────────────────── */

  const stats = useMemo(() => {
    const runningAgents = agents.filter((a: Agent) => a.status === 'running').length;
    const totalAgents = agents.length;

    const healthRatio = totalAgents > 0 ? runningAgents / totalAgents : 0;

    const todayTasks = tasks.filter((t: MeshTask) => isToday(t.createdAt));
    const todayCompleted = todayTasks.filter((t: MeshTask) => t.status === 'completed').length;
    const todayTotal = todayTasks.length;

    const rateTasks = successRateRange === '7d'
      ? tasks.filter((t: MeshTask) => isWithinDays(t.createdAt, 7))
      : tasks;
    const rateCompleted = rateTasks.filter((t: MeshTask) => t.status === 'completed').length;
    const rateFailed = rateTasks.filter((t: MeshTask) => t.status === 'failed').length;
    const rateTotal = rateCompleted + rateFailed;
    const successRate = rateTotal > 0 ? Math.round((rateCompleted / rateTotal) * 100) : 100;

    const completedTasks = tasks.filter((t: MeshTask) => t.status === 'completed' && t.completedAt);
    const durations = completedTasks.map((t: MeshTask) => {
      const start = parseDate(t.createdAt).getTime();
      const end = parseDate(t.completedAt!).getTime();
      return end - start;
    }).filter((d: number) => d > 0);
    const avgMs = durations.length > 0
      ? durations.reduce((a: number, b: number) => a + b, 0) / durations.length
      : 0;

    return {
      runningAgents, totalAgents, healthRatio,
      todayCompleted, todayTotal,
      successRate, rateTotal,
      avgMs,
    };
  }, [agents, tasks, successRateRange]);

  const recentTasks = useMemo(() => {
    return [...tasks]
      .sort((a: MeshTask, b: MeshTask) => parseDate(b.createdAt).getTime() - parseDate(a.createdAt).getTime())
      .slice(0, 8);
  }, [tasks]);

  const agentsList = useMemo(() => {
    const activeCounts: Record<string, number> = {};
    for (const t of tasks) {
      if (t.status === 'running' || t.status === 'pending') {
        activeCounts[t.toAgent] = (activeCounts[t.toAgent] || 0) + 1;
      }
    }
    return agents.map((a: Agent) => ({
      ...a,
      activeTaskCount: activeCounts[a.name] || 0,
    }));
  }, [agents, tasks]);

  const recentActivity = useMemo(() => activity.slice(0, 12), [activity]);

  /* ── Derived colours ─────────────────────────────── */

  const agentAccent = stats.healthRatio >= 0.8 ? 'bg-emerald-500' : stats.healthRatio >= 0.5 ? 'bg-amber-500' : 'bg-red-500';
  const rateColor = stats.successRate >= 80 ? 'text-emerald-400' : stats.successRate >= 50 ? 'text-amber-400' : 'text-red-400';
  const rateAccent = stats.successRate >= 80 ? 'bg-emerald-500' : stats.successRate >= 50 ? 'bg-amber-500' : 'bg-red-500';

  return (
    <div className="space-y-6">
      <PageHeader icon={Home} title="Dashboard" subtitle="Armada overview" />

      {/* ── KPI Row ──────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 items-stretch">
        <StatCard
          label="Active Agents"
          icon={Users}
          accentColor={agentAccent}
          value={
            <>
              <span className={stats.healthRatio >= 0.8 ? 'text-emerald-400' : stats.healthRatio >= 0.5 ? 'text-amber-400' : 'text-red-400'}>
                {stats.runningAgents}
              </span>
              <span className="text-lg text-zinc-600 font-normal ml-1">/ {stats.totalAgents}</span>
            </>
          }
          sub={stats.healthRatio >= 0.8 ? 'All healthy' : `${stats.totalAgents - stats.runningAgents} offline`}
          onClick={() => navigate('/agents')}
        />

        <StatCard
          label="Tasks Today"
          icon={Zap}
          accentColor="bg-violet-500"
          value={
            <>
              {stats.todayTotal}
              {stats.todayCompleted > 0 && (
                <span className="text-lg text-zinc-600 font-normal ml-1">
                  ({stats.todayCompleted} done)
                </span>
              )}
            </>
          }
          sub={stats.todayTotal === 0 ? 'No tasks dispatched' : `${stats.todayCompleted} completed`}
          onClick={() => navigate('/tasks')}
        />

        <StatCard
          label="Success Rate"
          icon={stats.successRate >= 80 ? TrendingUp : stats.successRate >= 50 ? Minus : TrendingDown}
          accentColor={rateAccent}
          value={<span className={rateColor}>{stats.successRate}%</span>}
          sub={
            <div className="flex items-center gap-2">
              <span>{stats.rateTotal > 0 ? `${stats.rateTotal} tasks` : 'No completed tasks'}</span>
              <span className="flex gap-0.5">
                {(['7d', 'all'] as const).map(range => (
                  <button
                    key={range}
                    onClick={(e) => { e.stopPropagation(); setSuccessRateRange(range); }}
                    className={`text-[10px] px-1.5 py-0.5 rounded transition-colors ${
                      successRateRange === range
                        ? 'bg-violet-500/30 text-violet-300'
                        : 'text-zinc-600 hover:text-zinc-400'
                    }`}
                  >
                    {range}
                  </button>
                ))}
              </span>
            </div>
          }
        />

        <StatCard
          label="Avg Time"
          icon={Clock}
          accentColor="bg-blue-500"
          value={stats.avgMs > 0 ? formatDuration(stats.avgMs) : <span className="text-zinc-600 text-xl">—</span>}
          sub={stats.avgMs > 0 ? 'Across all tasks' : 'No completed tasks yet'}
        />
      </div>

      {/* ── Content Grid ─────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">

        {/* Recent Tasks — 2/3 width */}
        <div className="lg:col-span-2 rounded-lg border border-zinc-800 bg-zinc-900/50 p-5">
            <SectionHeader title="Recent Tasks" actionLabel="View all" onAction={() => navigate('/tasks')} />
            {recentTasks.length === 0 ? (
              <div className="py-12 text-center">
                <Zap className="w-8 h-8 text-zinc-700 mx-auto mb-3" />
                <p className="text-sm text-zinc-500">No tasks yet</p>
                <p className="text-xs text-zinc-600 mt-1">Tasks will appear here when agents start working</p>
              </div>
            ) : (
              <div className="mt-2 divide-y divide-zinc-800/50">
                {recentTasks.map(task => {
                  const s = STATUS_ICON[task.status] ?? { icon: CircleDot, color: 'text-zinc-400' };
                  const Icon = s.icon;
                  return (
                    <div
                      key={task.id}
                      onClick={() => navigate('/tasks')}
                      className="flex items-center gap-3 py-2.5 px-2 -mx-2 rounded-md hover:bg-zinc-800/40 transition-colors cursor-pointer group"
                    >
                      <TooltipProvider delayDuration={200}>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="shrink-0 w-5 flex items-center justify-center">
                              <Icon className={`w-4 h-4 ${s.color} ${task.status === 'running' ? 'animate-spin' : ''}`} />
                            </span>
                          </TooltipTrigger>
                          <TooltipContent side="right" className="text-xs capitalize">{task.status}</TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                      <span className="text-sm text-zinc-300 group-hover:text-zinc-100 truncate flex-1 min-w-0 transition-colors">
                        {truncate(task.taskText, 60)}
                      </span>
                      <span className="text-[11px] text-zinc-600 font-mono shrink-0">
                        {task.toAgent}
                      </span>
                      <span className="text-[11px] text-zinc-600 shrink-0 w-14 text-right tabular-nums">
                        {relativeTime(task.createdAt)}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

        {/* Agent Status — 1/3 width */}
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-5">
            <SectionHeader title="Agents" actionLabel="View all" onAction={() => navigate('/agents')} />
            {agentsList.length === 0 ? (
              <div className="py-12 text-center">
                <Users className="w-8 h-8 text-zinc-700 mx-auto mb-3" />
                <p className="text-sm text-zinc-500">No agents registered</p>
              </div>
            ) : (
              <div className="mt-2 space-y-1">
                {agentsList.map((agent: Agent & { activeTaskCount: number }) => {
                  const rc = getRoleColor(agent.role);
                  return (
                    <div
                      key={agent.id}
                      onClick={() => navigate(`/agents/${agent.name}`)}
                      className="flex items-center gap-3 py-2.5 px-3 -mx-1 rounded-lg hover:bg-zinc-800/40 transition-colors cursor-pointer group"
                    >
                      {/* Health dot */}
                      <span
                        className={`inline-block w-2 h-2 rounded-full shrink-0 ${HEALTH_DOT[agent.healthStatus] ?? HEALTH_DOT.unknown}`}
                      />
                      {/* Name */}
                      <span className="text-sm text-zinc-300 group-hover:text-zinc-100 font-medium flex-1 min-w-0 truncate transition-colors">
                        {agent.name}
                      </span>
                      {/* Role badge */}
                      {agent.role && (
                        <span
                          className="text-[10px] font-medium px-2 py-0.5 rounded-full shrink-0"
                          style={{
                            backgroundColor: `${rc.bg}33`,
                            color: rc.stroke,
                          }}
                        >
                          {agent.role}
                        </span>
                      )}
                      {/* Active task count */}
                      {agent.activeTaskCount > 0 && (
                        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-400 shrink-0">
                          {agent.activeTaskCount}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
      </div>

      {/* ── Activity Feed ────────────────────────────── */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-5">
          <SectionHeader title="Activity" actionLabel="View all" onAction={() => navigate('/activity')} />
          {recentActivity.length === 0 ? (
            <div className="py-8 text-center">
              <Activity className="w-8 h-8 text-zinc-700 mx-auto mb-3" />
              <p className="text-sm text-zinc-500">No recent activity</p>
            </div>
          ) : (
            <div className="mt-2 space-y-0">
              {recentActivity.map((event: ActivityEvent) => (
                <div
                  key={event.id}
                  className="flex items-center gap-2.5 py-2 border-b border-zinc-800/30 last:border-0"
                >
                  <span className="shrink-0 text-zinc-600">
                    {EVENT_ICONS[event.eventType] ?? <Pin className="w-3.5 h-3.5" />}
                  </span>
                  <span className="text-sm text-zinc-400 flex-1 min-w-0 truncate">
                    {event.agentName && (
                      <span className="text-violet-400 font-medium">{event.agentName}</span>
                    )}
                    {event.agentName && event.detail ? ' · ' : ''}
                    {event.detail ?? event.eventType}
                  </span>
                  <span className="text-[11px] text-zinc-700 shrink-0 tabular-nums">
                    {relativeTime(event.createdAt)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
    </div>
  );
}
