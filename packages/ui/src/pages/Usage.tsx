import { useState } from 'react';
import { TrendingUp, DollarSign, Zap, Calendar, Bot, Server } from 'lucide-react';
import { PageHeader } from '../components/PageHeader';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '../components/ui/select';
import { RowSkeleton } from '../components/ui/skeleton';
import { Table, TableHeader, TableBody, TableHead, TableRow, TableCell } from '../components/ui/table';
import { EmptyState } from '../components/EmptyState';
import {
  useUsageSummary, useUsageByProvider, useUsageByAgent,
  type UsagePeriod,
} from '../hooks/queries/useUsage';

/* ── Helpers ───────────────────────────────────────── */

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function fmtCost(n: number): string {
  if (n < 0.001) return '$0.000';
  return `$${n.toFixed(4)}`;
}

/* ── StatCard ──────────────────────────────────────── */

interface StatCardProps {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  sub?: string;
  color?: string;
  loading?: boolean;
}

function StatCard({ icon: Icon, label, value, sub, color = 'text-violet-400', loading }: StatCardProps) {
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-zinc-500 uppercase tracking-wider">{label}</span>
        <span className={`p-1.5 rounded-lg bg-zinc-800 ${color}`}>
          <Icon className="w-4 h-4" />
        </span>
      </div>
      {loading ? (
        <div className="h-8 w-24 bg-zinc-800 rounded animate-pulse" />
      ) : (
        <div>
          <span className="text-2xl font-bold text-zinc-100">{value}</span>
          {sub && <p className="text-xs text-zinc-500 mt-1">{sub}</p>}
        </div>
      )}
    </div>
  );
}

/* ── UsageTable ────────────────────────────────────── */

interface TableRow {
  key: string;
  label: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  requestCount: number;
}

interface UsageTableProps {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  rows: TableRow[];
  loading: boolean;
  emptyMessage?: string;
}

function UsageTable({ title, icon: Icon, rows, loading, emptyMessage }: UsageTableProps) {
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
      <div className="flex items-center gap-2 px-5 py-3.5 border-b border-zinc-800">
        <Icon className="w-4 h-4 text-zinc-400" />
        <h3 className="text-sm font-semibold text-zinc-200">{title}</h3>
      </div>
      <Table className="text-sm">
        <TableHeader>
          <TableRow className="border-b border-zinc-800">
            <TableHead className="text-left px-5 py-3 text-xs font-medium text-zinc-500 uppercase tracking-wider">Name</TableHead>
            <TableHead className="text-right px-4 py-3 text-xs font-medium text-zinc-500 uppercase tracking-wider">Requests</TableHead>
            <TableHead className="text-right px-4 py-3 text-xs font-medium text-zinc-500 uppercase tracking-wider">Input</TableHead>
            <TableHead className="text-right px-4 py-3 text-xs font-medium text-zinc-500 uppercase tracking-wider">Output</TableHead>
            <TableHead className="text-right px-4 py-3 text-xs font-medium text-zinc-500 uppercase tracking-wider">Total</TableHead>
            <TableHead className="text-right px-5 py-3 text-xs font-medium text-zinc-500 uppercase tracking-wider">Cost</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading ? (
            Array.from({ length: 3 }).map((_, i) => (
              <TableRow key={i} className="border-b border-zinc-800/50">
                <TableCell colSpan={6} className="px-5 py-2"><RowSkeleton /></TableCell>
              </TableRow>
            ))
          ) : rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={6} className="px-5 py-10 text-center text-zinc-500 text-sm">
                {emptyMessage ?? 'No usage data for this period'}
              </TableCell>
            </TableRow>
          ) : (
            rows.map((row, idx) => {
              // Progress bar relative to max in list
              const maxTokens = rows[0]?.totalTokens || 1;
              const pct = Math.max(2, Math.round((row.totalTokens / maxTokens) * 100));
              return (
                <TableRow key={row.key ?? idx} className="border-b border-zinc-800/50 hover:bg-zinc-800/30 transition-colors">
                  <TableCell className="px-5 py-3">
                    <div className="flex flex-col gap-1">
                      <span className="font-medium text-zinc-200 truncate max-w-xs">{row.label}</span>
                      <div className="h-1 bg-zinc-800 rounded-full overflow-hidden w-32">
                        <div
                          className="h-full bg-violet-500/70 rounded-full"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="px-4 py-3 text-right text-zinc-400 tabular-nums">{row.requestCount.toLocaleString()}</TableCell>
                  <TableCell className="px-4 py-3 text-right text-zinc-400 tabular-nums">{fmtTokens(row.inputTokens)}</TableCell>
                  <TableCell className="px-4 py-3 text-right text-zinc-400 tabular-nums">{fmtTokens(row.outputTokens)}</TableCell>
                  <TableCell className="px-4 py-3 text-right font-medium text-zinc-200 tabular-nums">{fmtTokens(row.totalTokens)}</TableCell>
                  <TableCell className="px-5 py-3 text-right font-medium text-emerald-400 tabular-nums">{fmtCost(row.costUsd)}</TableCell>
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>
    </div>
  );
}

/* ── Page ──────────────────────────────────────────── */

const PERIOD_LABELS: Record<string, string> = {
  day: 'Last 24h',
  week: 'Last 7 days',
  month: 'Last 30 days',
  all: 'All time',
};

export default function Usage() {
  const [period, setPeriod] = useState<UsagePeriod>('month');

  const { data: summary, isLoading: summaryLoading } = useUsageSummary(period);
  const { data: byProvider, isLoading: providerLoading } = useUsageByProvider(period);
  const { data: byAgent, isLoading: agentLoading } = useUsageByAgent(period);

  const tokensToday = summary?.totalTokens ?? 0;

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      {/* Header */}
      <PageHeader
        icon={TrendingUp}
        title="Usage"
        subtitle="Token consumption and cost tracking by provider, agent, and API key"
        color="violet"
      >
        <Select value={period} onValueChange={v => setPeriod(v as UsagePeriod)}>
          <SelectTrigger className="w-40 h-8 text-sm bg-zinc-900 border-zinc-700">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="day">Last 24h</SelectItem>
            <SelectItem value="week">Last 7 days</SelectItem>
            <SelectItem value="month">Last 30 days</SelectItem>
            <SelectItem value="all">All time</SelectItem>
          </SelectContent>
        </Select>
      </PageHeader>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard
          icon={Zap}
          label="Total Tokens"
          value={summaryLoading ? '—' : fmtTokens(summary?.totalTokens ?? 0)}
          sub={PERIOD_LABELS[period]}
          color="text-violet-400"
          loading={summaryLoading}
        />
        <StatCard
          icon={DollarSign}
          label="Total Cost"
          value={summaryLoading ? '—' : fmtCost(summary?.costUsd ?? 0)}
          sub={PERIOD_LABELS[period]}
          color="text-emerald-400"
          loading={summaryLoading}
        />
        <StatCard
          icon={Calendar}
          label="Requests"
          value={summaryLoading ? '—' : (summary?.requestCount ?? 0).toLocaleString()}
          sub={PERIOD_LABELS[period]}
          color="text-blue-400"
          loading={summaryLoading}
        />
        <StatCard
          icon={TrendingUp}
          label="Input / Output"
          value={summaryLoading ? '—' : `${fmtTokens(summary?.inputTokens ?? 0)} / ${fmtTokens(summary?.outputTokens ?? 0)}`}
          sub="Input / Output tokens"
          color="text-amber-400"
          loading={summaryLoading}
        />
      </div>

      {/* Breakdown tables */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <UsageTable
          title="By Provider"
          icon={Server}
          rows={byProvider?.rows ?? []}
          loading={providerLoading}
          emptyMessage="No provider usage data yet — agents will report usage after each turn"
        />
        <UsageTable
          title="By Agent"
          icon={Bot}
          rows={byAgent?.rows ?? []}
          loading={agentLoading}
          emptyMessage="No agent usage data yet — usage is reported automatically by the armada-agent plugin"
        />
      </div>
    </div>
  );
}
