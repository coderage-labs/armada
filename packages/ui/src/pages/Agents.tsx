import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { apiFetch } from '../hooks/useApi';
import { useAuth } from '../hooks/useAuth';
import { usePendingStyle } from '../hooks/usePendingStyle';
import type { PendingFields } from '../hooks/usePendingStyle';
import { useAgents } from '../hooks/queries/useAgents';
import SpawnDialog from '../components/SpawnDialog';
import { Hand, Bot, Loader2, Trash2 } from 'lucide-react';
import { PageHeader } from '../components/PageHeader';
import { Link } from 'react-router-dom';
import type { ReactNode } from 'react';
import ConfirmDialog from '../components/ConfirmDialog';
import AgentAvatar from '../components/AgentAvatar';
import { PendingBadge } from '../components/PendingBadge';
import type { Agent } from '@coderage-labs/armada-shared';
import { EmptyState } from '../components/EmptyState';
import { CardGrid, BaseCard } from '../components/shared';
import { Button } from '../components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { toast } from 'sonner';

/* ── Helpers ───────────────────────────────────────── */

function timeAgo(iso: string | null): string {
  if (!iso) return 'never';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 0) return 'just now';
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/* ── Status config ─────────────────────────────────── */

const HEALTH_ACCENT: Record<string, string> = {
  healthy:      'bg-emerald-500',
  degraded:     'bg-amber-500',
  unresponsive: 'bg-red-500',
  offline:      'bg-zinc-600',
  unknown:      'bg-zinc-600',
};

const HEALTH_DOT: Record<string, { color: string; label: string }> = {
  healthy:      { color: 'bg-emerald-400 shadow-[0_0_6px_rgba(16,185,129,0.5)]', label: 'Healthy' },
  degraded:     { color: 'bg-amber-400 shadow-[0_0_6px_rgba(245,158,11,0.5)]', label: 'Degraded' },
  unresponsive: { color: 'bg-red-400 shadow-[0_0_6px_rgba(239,68,68,0.5)]', label: 'Unresponsive' },
  offline:      { color: 'bg-zinc-600', label: 'Offline' },
  unknown:      { color: 'bg-zinc-600', label: 'Unknown' },
};

const STATUS_DOT: Record<string, string> = {
  running:  'bg-emerald-400',
  error:    'bg-red-400',
  starting: 'bg-amber-400',
  stopped:  'bg-zinc-500',
  pending:  'bg-violet-400',
};

/* ── Agent Card ────────────────────────────────────── */

function AgentCard({
  agent,
  nudging,
  onNavigate,
  onNudge,
  onDelete,
}: {
  agent: Agent & { pendingAction?: string | null; pendingFields?: PendingFields | null };
  nudging: boolean;
  onNavigate: () => void;
  onNudge: () => void;
  onDelete: () => void;
}) {
  const health = HEALTH_DOT[agent.healthStatus] ?? HEALTH_DOT.unknown;
  const accent = HEALTH_ACCENT[agent.healthStatus] ?? HEALTH_ACCENT.unknown;
  const statusDot = STATUS_DOT[agent.status] ?? 'bg-zinc-500';
  const activeTasks = agent.heartbeatMeta?.activeTasks ?? 0;
  const { cardClass } = usePendingStyle(agent.pendingFields, agent.pendingAction);

  return (
    <BaseCard
      onClick={onNavigate}
      accentColor={accent}
      className={cardClass || undefined}
      footer={
        <>
          {agent.status === 'running' && (
            <Button
              variant="outline"
              size="sm"
              onClick={onNudge}
              disabled={nudging}
              className="flex-1 text-xs h-8 gap-1.5 border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50"
            >
              {nudging ? <Loader2 className="w-3 h-3 animate-spin" /> : <Hand className="w-3.5 h-3.5" />}
              Nudge
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={onDelete}
            className="flex-1 text-xs h-8 gap-1.5 border-red-500/20 text-red-400/70 hover:text-red-400 hover:bg-red-500/10 hover:border-red-500/40"
          >
            <Trash2 className="w-3 h-3" /> Delete
          </Button>
        </>
      }
    >
      {/* Header */}
      <div className="p-5 pb-0">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <AgentAvatar
              name={agent.name}
              size="sm"
              healthStatus={agent.healthStatus}
              version={(agent as any).avatarVersion || 0}
              generating={agent.avatarGenerating}
            />
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base font-semibold text-zinc-100">{agent.name}</h3>
                {agent.pendingAction && <PendingBadge action={agent.pendingAction as 'create' | 'update' | 'delete'} />}
              </div>
              <div className="flex items-center gap-3 mt-1">
                <span className="inline-flex items-center gap-1.5 text-[11px] text-zinc-400">
                  <span className={`w-1.5 h-1.5 rounded-full ${statusDot}`} />
                  {agent.status}
                </span>
                {agent.role && (
                  <span className="text-[11px] text-zinc-500 capitalize">{agent.role}</span>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Details */}
      <div className="p-5 pt-4 space-y-2.5 flex-1">
        {/* Health + Last seen */}
        <div className="flex items-center justify-between">
          <span className="inline-flex items-center gap-1.5 text-xs">
            <span className={`w-2 h-2 rounded-full ${health.color}`} />
            <span className="text-zinc-400">{health.label}</span>
          </span>
          <span className="text-[11px] text-zinc-600 tabular-nums">
            {timeAgo(agent.lastHeartbeat)}
          </span>
        </div>

        {/* Model */}
        {agent.model && (
          <div className="flex items-center justify-between text-xs">
            <span className="text-zinc-500">Model</span>
            <span className="text-zinc-400 font-mono text-[11px] truncate max-w-[180px]">{agent.model}</span>
          </div>
        )}

        {/* Instance */}
        {agent.instanceName && (
          <div className="flex items-center justify-between text-xs">
            <span className="text-zinc-500">Instance</span>
            <Link
              to={`/instances/${agent.instanceId}`}
              onClick={(e) => e.stopPropagation()}
              className="text-zinc-400 hover:text-zinc-200 transition-colors"
            >
              {agent.instanceName}
            </Link>
          </div>
        )}

        {/* Active tasks */}
        {agent.status === 'running' && (
          <div className="flex items-center justify-between text-xs">
            <span className="text-zinc-500">Tasks</span>
            <span className={`inline-flex items-center gap-1 text-[11px] font-medium px-1.5 py-0.5 rounded ${
              activeTasks === 0
                ? 'bg-emerald-500/10 text-emerald-400'
                : activeTasks <= 2
                  ? 'bg-amber-500/10 text-amber-400'
                  : 'bg-red-500/10 text-red-400'
            }`}>
              {activeTasks} active
            </span>
          </div>
        )}
      </div>
    </BaseCard>
  );
}

/* ── Page Component ────────────────────────────────── */

export default function Agents() {
  const navigate = useNavigate();
  const { hasScope } = useAuth();
  const canMutate = hasScope('agents:write');
  const queryClient = useQueryClient();
  const { data: agentsRaw = [], isLoading: loading } = useAgents();
  const agents = agentsRaw as Agent[];
  const [statusFilter, setStatusFilter] = useState('all');
  const [roleFilter, setRoleFilter] = useState('all');
  const [spawnOpen, setSpawnOpen] = useState(false);
  const [confirmTarget, setConfirmTarget] = useState<{ name: string; action: string } | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [nudgingAgent, setNudgingAgent] = useState<string | null>(null);

  const displayAgents = agents;

  const filtered = useMemo(() => {
    let list = displayAgents;
    if (statusFilter !== 'all') list = list.filter((a) => a.status === statusFilter);
    if (roleFilter !== 'all') list = list.filter((a) => a.role === roleFilter);
    return [...list].sort((a, b) => a.name.localeCompare(b.name));
  }, [displayAgents, statusFilter, roleFilter]);

  async function agentAction(name: string, action: string) {
    setActionLoading(true);
    try {
      if (action === 'delete') {
        await apiFetch(`/api/agents/${name}`, { method: 'DELETE' });
      } else {
        await apiFetch(`/api/agents/${name}/${action}`, { method: 'POST' });
      }
      await queryClient.invalidateQueries();
    } catch {
      // could show error toast
    } finally {
      setActionLoading(false);
      setConfirmTarget(null);
    }
  }

  async function handleNudge(name: string) {
    setNudgingAgent(name);
    try {
      const data = await apiFetch<{ status: string; response?: string | null; error?: string; duration?: number }>(
        `/api/agents/${name}/nudge`,
        { method: 'POST' },
      );
      if (data.status === 'ok' && data.response) {
        const truncated = data.response.length > 200 ? data.response.slice(0, 200) + '…' : data.response;
        toast.success(`${name}: ${truncated}`);
      } else if (data.status === 'timeout') {
        toast.warning(`Agent "${name}" didn't respond within 30s`);
      } else {
        toast.error(data.error || `Nudge failed for "${name}"`);
      }
    } catch (err: any) {
      toast.error(err.message || 'Nudge request failed');
    } finally {
      setNudgingAgent(null);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader icon={Bot} title="Agents" subtitle="Agents and their status">
        {canMutate && (
          <Button
            onClick={() => setSpawnOpen(true)}
            className="bg-violet-600 hover:bg-violet-700 text-white text-sm px-4 h-9"
          >
            + Spawn Agent
          </Button>
        )}
      </PageHeader>

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-36 border-zinc-800 bg-zinc-900/50">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Status</SelectItem>
            <SelectItem value="running">Running</SelectItem>
            <SelectItem value="stopped">Stopped</SelectItem>
          </SelectContent>
        </Select>
        <Select value={roleFilter} onValueChange={setRoleFilter}>
          <SelectTrigger className="w-44 border-zinc-800 bg-zinc-900/50">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Roles</SelectItem>
            <SelectItem value="development">Development</SelectItem>
            <SelectItem value="research">Research</SelectItem>
            <SelectItem value="project-manager">Project Manager</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Loading */}
      {loading && <CardGrid loading skeletonCount={3} />}

      {/* Empty */}
      {!loading && filtered.length === 0 && (
        <EmptyState
          icon={Bot}
          title={agents.length === 0 ? 'No agents yet' : 'No agents match filters'}
          description={agents.length === 0 ? 'Spawn an agent to get started' : 'Try adjusting your filters'}
          action={agents.length === 0 && canMutate ? { label: 'Spawn Agent', onClick: () => setSpawnOpen(true) } : undefined}
        />
      )}

      {/* Agent cards */}
      {!loading && filtered.length > 0 && (
        <CardGrid>
          {filtered.map((agent) => (
            <AgentCard
              key={agent.id}
              agent={agent}
              nudging={nudgingAgent === agent.name}
              onNavigate={() => navigate(`/agents/${agent.name}`)}
              onNudge={() => handleNudge(agent.name)}
              onDelete={() => setConfirmTarget({ name: agent.name, action: 'delete' })}
            />
          ))}
        </CardGrid>
      )}

      <SpawnDialog open={spawnOpen} onClose={() => setSpawnOpen(false)} onSpawned={() => { queryClient.invalidateQueries(); }} />

      <ConfirmDialog
        open={!!confirmTarget}
        title={confirmTarget?.action === 'delete' ? 'Delete Agent' : 'Confirm Action'}
        message={
          confirmTarget
            ? `Are you sure you want to ${confirmTarget.action} agent "${confirmTarget.name}"? This cannot be undone.`
            : ''
        }
        confirmLabel={confirmTarget?.action === 'delete' ? 'Delete' : 'Confirm'}
        destructive={confirmTarget?.action === 'delete'}
        loading={actionLoading}
        onConfirm={() => confirmTarget && agentAction(confirmTarget.name, confirmTarget.action)}
        onCancel={() => setConfirmTarget(null)}
      />
    </div>
  );
}
