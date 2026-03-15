import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../hooks/useApi';
import { useSSEAll } from '../providers/SSEProvider';
import { useOperations } from '../contexts/OperationsContext';
import { usePendingStyle } from '../hooks/usePendingStyle';
import type { PendingFields } from '../hooks/usePendingStyle';
import { PendingBadge } from '../components/PendingBadge';
import StatusDot from '../components/StatusDot';
import ConfirmDialog from '../components/ConfirmDialog';
import type { ReactNode } from 'react';
import { ArrowLeft, Layers, RotateCcw, Square, Play, Trash2, Settings, RefreshCw as RefreshIcon } from 'lucide-react';
import { PageHeader } from '../components/PageHeader';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Table, TableHeader, TableBody, TableHead, TableRow, TableCell } from '../components/ui/table';

interface VersionInfo {
  latest: string | null;
  instances: Array<{
    name: string;
    running: string | null;
    target: string | null;
    outdated: boolean;
  }>;
}

function isNewerVersion(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}

interface InstanceAgent {
  name: string;
  role: string;
  status: string;
  healthStatus: string;
  model?: string;
}

interface InstanceDetail {
  id: string;
  name: string;
  nodeId: string;
  nodeName: string;
  status: 'running' | 'stopped' | 'error' | 'starting';
  agentCount: number;
  capacity: number;
  token?: string;
  config?: Record<string, any>;
  agents: InstanceAgent[];
  version?: string;
  targetVersion?: string;
  createdAt: string;
  updatedAt?: string;
  uptime?: number;
  pendingAction?: string | null;
  pendingFields?: PendingFields | null;
}

interface InstanceStats {
  cpuPercent: number;
  memoryUsage: number;
  memoryLimit: number;
  networkRx: number;
  networkTx: number;
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function maskToken(token: string | undefined): string {
  if (!token) return '—';
  if (token.length <= 8) return '••••••••';
  return token.slice(0, 4) + '••••' + token.slice(-4);
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    running: 'border-emerald-500/30 bg-emerald-500/20 text-emerald-400',
    stopped: 'border-zinc-500/30 bg-zinc-500/20 text-zinc-400',
    starting: 'border-yellow-500/30 bg-yellow-500/20 text-yellow-400',
    error: 'border-red-500/30 bg-red-500/20 text-red-400',
  };
  const dotColor: Record<string, string> = {
    running: 'bg-emerald-400',
    stopped: 'bg-zinc-500',
    starting: 'bg-yellow-400',
    error: 'bg-red-400',
  };
  return (
    <span className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-sm font-medium ${styles[status] ?? styles.stopped}`}>
      <span className={`h-2.5 w-2.5 rounded-full ${dotColor[status] ?? dotColor.stopped}`} />
      {status}
    </span>
  );
}

function HealthBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    healthy: 'border-emerald-500/30 bg-emerald-500/20 text-emerald-400',
    degraded: 'border-yellow-500/30 bg-yellow-500/20 text-yellow-400',
    unresponsive: 'border-red-500/30 bg-red-500/20 text-red-400',
    offline: 'border-zinc-500/30 bg-zinc-500/20 text-zinc-400',
    unknown: 'border-zinc-500/30 bg-zinc-500/20 text-zinc-400',
  };
  const dotColor: Record<string, string> = {
    healthy: 'bg-emerald-400',
    degraded: 'bg-yellow-400',
    unresponsive: 'bg-red-400',
    offline: 'bg-zinc-500',
    unknown: 'bg-zinc-500',
  };
  return (
    <span className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-sm font-medium ${styles[status] ?? styles.unknown}`}>
      <span className={`h-2.5 w-2.5 rounded-full ${dotColor[status] ?? dotColor.unknown}`} />
      {status}
    </span>
  );
}

function HealthDot({ healthStatus }: { healthStatus: string }) {
  const map: Record<string, { color: string; label: string }> = {
    healthy: { color: 'bg-emerald-400', label: 'Healthy' },
    degraded: { color: 'bg-yellow-400', label: 'Degraded' },
    unresponsive: { color: 'bg-red-400', label: 'Unresponsive' },
    offline: { color: 'bg-zinc-600', label: 'Offline' },
    unknown: { color: 'bg-zinc-500', label: 'Unknown' },
  };
  const info = map[healthStatus] ?? map.unknown;
  return (
    <span className="inline-flex items-center gap-1.5" title={info.label}>
      <span className={`inline-block h-2 w-2 rounded-full ${info.color}`} />
      <span className="text-xs text-zinc-400">{info.label}</span>
    </span>
  );
}

function getWorstHealth(agents: InstanceAgent[]): string {
  if (!agents || agents.length === 0) return 'unknown';
  const priority = ['unresponsive', 'degraded', 'offline', 'unknown', 'healthy'];
  let worst = 'healthy';
  for (const agent of agents) {
    const idx = priority.indexOf(agent.healthStatus);
    if (idx !== -1 && idx < priority.indexOf(worst)) {
      worst = agent.healthStatus;
    }
  }
  return worst;
}

export default function InstanceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [instance, setInstance] = useState<InstanceDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [confirmAction, setConfirmAction] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [stats, setStats] = useState<InstanceStats | null>(null);
  const [logs, setLogs] = useState('');
  const [liveLogs, setLiveLogs] = useState(false);
  const logRef = useRef<HTMLPreElement>(null);
  const logEsRef = useRef<EventSource | null>(null);
  const [versionInfo, setVersionInfo] = useState<VersionInfo | null>(null);
  const [upgradeLoading, setUpgradeLoading] = useState(false);
  const [upgradeResult, setUpgradeResult] = useState<{ ok: boolean; message: string } | null>(null);
  const { subscribe: subscribeOp } = useOperations();
  const { pf, cardClass } = usePendingStyle(instance?.pendingFields, instance?.pendingAction);

  const fetchInstance = useCallback(async () => {
    if (!id) return;
    try {
      const data = await apiFetch<InstanceDetail>(`/api/instances/${id}`);
      setInstance(data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [id]);

  const fetchStats = useCallback(async () => {
    if (!id) return;
    try {
      const data = await apiFetch<InstanceStats>(`/api/instances/${id}/stats`);
      setStats(data);
    } catch {
      // stats may not be available
    }
  }, [id]);

  const fetchLogs = useCallback(async () => {
    if (!id) return;
    try {
      const text = await apiFetch<string>(`/api/instances/${id}/logs?tail=200`);
      setLogs(typeof text === 'string' ? text : String(text));
    } catch {
      // logs may not be available
    }
  }, [id]);

  const fetchVersions = useCallback(async () => {
    try {
      const data = await apiFetch<VersionInfo>('/api/system/versions');
      setVersionInfo(data);
    } catch {
      // silent
    }
  }, []);

  async function handleUpgrade(version: string) {
    if (!id) return;
    setUpgradeLoading(true);
    setUpgradeResult(null);
    try {
      const result = await apiFetch<{ ok: boolean; operationId?: string; version?: string; status?: string; message?: string }>(
        `/api/instances/${id}/upgrade`,
        { method: 'POST', body: JSON.stringify({ version }) },
      );
      if (result.operationId) {
        // New async operation flow
        subscribeOp(result.operationId);
        setUpgradeResult({ ok: true, message: 'Upgrade started — check operations bar' });
      } else if (result.ok) {
        setUpgradeResult({ ok: true, message: `Upgraded to v${result.version ?? version}` });
      } else {
        setUpgradeResult({ ok: false, message: result.message ?? `Upgrade to v${version} failed: ${result.status ?? 'unknown error'}` });
      }
      queryClient.invalidateQueries();
      await fetchVersions();
    } catch (err: any) {
      setUpgradeResult({ ok: false, message: err.message ?? 'Upgrade failed' });
    } finally {
      setUpgradeLoading(false);
      // Auto-clear success message after 5s
      setTimeout(() => setUpgradeResult(null), 8000);
    }
  }

  useEffect(() => {
    fetchInstance();
    fetchStats();
    fetchLogs();
    fetchVersions();
  }, [fetchInstance, fetchStats, fetchLogs, fetchVersions]);

  useSSEAll(useCallback((type: string, data: any) => {
    if (type === 'agent.health' && data?.instanceId === id) {
      queryClient.invalidateQueries();
      fetchStats();
    } else if (type.startsWith('agent.') && data?.instanceId === id) {
      queryClient.invalidateQueries();
      fetchStats();
    } else if (type === 'mutation.staged' || type === 'operation.completed' || type === 'operation.failed') {
      queryClient.invalidateQueries();
    }
  }, [id, queryClient, fetchStats]));

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logs]);

  // Live log streaming via SSE
  useEffect(() => {
    if (!liveLogs || !id) {
      logEsRef.current?.close();
      logEsRef.current = null;
      return;
    }
    const token = localStorage.getItem('armada_token');
    const url = `/api/instances/${encodeURIComponent(id)}/logs/stream${token ? `?token=${encodeURIComponent(token)}` : ''}`;
    const es = new EventSource(url);
    logEsRef.current = es;

    es.addEventListener('log', (ev) => {
      try {
        const data = JSON.parse(ev.data) as { line: string };
        setLogs((prev) => {
          const lines = prev ? prev.split('\n') : [];
          lines.push(data.line);
          // Keep last 1000 lines
          if (lines.length > 1000) lines.splice(0, lines.length - 1000);
          return lines.join('\n');
        });
      } catch {
        setLogs((prev) => prev ? `${prev}\n${ev.data}` : ev.data);
      }
    });

    return () => {
      es.close();
      logEsRef.current = null;
    };
  }, [liveLogs, id]);

  async function handleAction(action: string) {
    if (!id) return;
    setActionLoading(true);
    try {
      if (action === 'destroy') {
        await apiFetch(`/api/instances/${id}`, { method: 'DELETE' });
        queryClient.invalidateQueries();
        navigate('/instances');
        return;
      }
      await apiFetch(`/api/instances/${id}/${action}`, { method: 'POST' });
      queryClient.invalidateQueries();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setActionLoading(false);
      setConfirmAction(null);
    }
  }

  if (loading) {
    return <div className="py-12 text-center text-zinc-500">Loading…</div>;
  }

  if (error && !instance) {
    return (
      <div className="py-12 text-center">
        <p className="text-red-400">{error}</p>
        <Button variant="ghost" onClick={() => navigate('/instances')} className="mt-4 text-sm text-purple-400 hover:underline">
          ← Back to Instances
        </Button>
      </div>
    );
  }

  if (!instance) return null;

  const memPercent = stats?.memoryLimit
    ? ((stats.memoryUsage / stats.memoryLimit) * 100).toFixed(1)
    : null;

  const worstHealth = getWorstHealth(instance.agents);



  return (
    <div className="space-y-6">
      {/* Back link */}
      <Button variant="ghost" onClick={() => navigate('/instances')} className="text-zinc-400 hover:text-zinc-100 text-sm flex items-center gap-1">
        <ArrowLeft className="w-4 h-4" />
        Back
      </Button>

      {/* Header */}
      <PageHeader icon={Layers} title={instance.name}>
        {instance.status === 'running' ? (
          <>
            <ActionBtn label={<><Settings className="w-3.5 h-3.5" /> Maintain</>} onClick={() => handleAction('maintain')} />
            <ActionBtn label={<><RotateCcw className="w-3.5 h-3.5" /> Restart</>} onClick={() => setConfirmAction('restart')} />
            <ActionBtn label={<><Square className="w-3.5 h-3.5" /> Stop</>} onClick={() => setConfirmAction('stop')} />
          </>
        ) : instance.status === 'error' ? (
          <>
            <ActionBtn label={<><RefreshIcon className="w-3.5 h-3.5" /> Retry</>} onClick={() => handleAction('retry')} />
          </>
        ) : (
          <ActionBtn label={<><Play className="w-3.5 h-3.5" /> Start</>} onClick={() => handleAction('start')} />
        )}
        <ActionBtn label={<><Trash2 className="w-3.5 h-3.5" /> Destroy</>} destructive onClick={() => setConfirmAction('destroy')} />
      </PageHeader>

      {/* Instance status info */}
      <div className="flex items-center gap-3 flex-wrap">
        <StatusBadge status={instance.status} />
        <HealthBadge status={worstHealth} />
        {instance.pendingAction && (
          <PendingBadge action={instance.pendingAction as 'create' | 'update' | 'delete'} />
        )}
        {instance.version && (
          <span className={`text-xs font-mono px-2 py-0.5 rounded-full ${
            instance.targetVersion && instance.version !== instance.targetVersion
              ? 'bg-amber-500/20 text-amber-400'
              : 'bg-zinc-700/50 text-zinc-400'
          }`}>
            v{instance.version}
            {instance.targetVersion && instance.version !== instance.targetVersion && (
              <span className="text-amber-500 ml-1">→ v{instance.targetVersion}</span>
            )}
          </span>
        )}
        {versionInfo?.latest && instance.version && isNewerVersion(versionInfo.latest, instance.version) && (
          <Button
            variant="ghost" onClick={() => handleUpgrade(versionInfo.latest!)}
            disabled={upgradeLoading}
            className="text-xs font-medium px-2.5 py-1 rounded-full border border-blue-500/30 bg-blue-500/20 text-blue-300 hover:bg-blue-500/30 transition-colors disabled:opacity-50 inline-flex items-center gap-1.5"
          >
            {upgradeLoading && (
              <svg className="animate-spin h-3 w-3" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            )}
            {upgradeLoading ? 'Upgrading…' : `Upgrade to v${versionInfo.latest}`}
          </Button>
        )}
        {upgradeResult && (
          <Badge className={`text-xs font-medium px-2.5 py-1 rounded-full border ${
            upgradeResult.ok
              ? 'border-emerald-500/30 bg-emerald-500/20 text-emerald-400'
              : 'border-red-500/30 bg-red-500/20 text-red-400'
          }`}>
            {upgradeResult.message}
          </Badge>
        )}
        <Link
          to={`/nodes`}
          className="text-sm text-violet-400 hover:text-violet-300 transition"
        >
          Node: {instance.nodeName}
        </Link>
        {instance.uptime != null && (
          <span className="text-sm text-zinc-500">
            Uptime: {formatUptime(instance.uptime)}
          </span>
        )}
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-400">{error}</div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="CPU" value={stats?.cpuPercent != null ? `${stats.cpuPercent.toFixed(1)}%` : '—'} />
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
          <div className="text-xs text-zinc-500 uppercase tracking-wider">Memory</div>
          <div className="mt-1 text-lg font-semibold text-white">
            {stats ? formatBytes(stats.memoryUsage) : '—'}
          </div>
          {stats?.memoryLimit && memPercent && (
            <>
              <div className="mt-2 h-1.5 w-full rounded-full bg-zinc-700/50 overflow-hidden">
                <div
                  className="h-full rounded-full bg-purple-500 transition-all"
                  style={{ width: `${Math.min(Number(memPercent), 100)}%` }}
                />
              </div>
              <div className="mt-1 text-xs text-zinc-500">
                {memPercent}% of {formatBytes(stats.memoryLimit)}
              </div>
            </>
          )}
        </div>
        <StatCard
          label="Network RX"
          value={stats?.networkRx != null ? formatBytes(stats.networkRx) : '—'}
        />
        <StatCard
          label="Network TX"
          value={stats?.networkTx != null ? formatBytes(stats.networkTx) : '—'}
        />
      </div>

      {/* Agents section */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-5">
        <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider mb-3">
          Agents ({instance.agents?.length ?? 0})
        </h2>
        {(!instance.agents || instance.agents.length === 0) ? (
          <p className="text-sm text-zinc-500">No agents in this instance.</p>
        ) : (
          <Table className="text-sm">
            <TableHeader>
              <TableRow className="text-zinc-500 text-xs uppercase tracking-wider">
                <TableHead className="text-left pb-2 pr-4 font-medium">Name</TableHead>
                <TableHead className="text-left pb-2 pr-4 font-medium">Role</TableHead>
                <TableHead className="text-left pb-2 pr-4 font-medium">Status</TableHead>
                <TableHead className="text-left pb-2 font-medium">Health</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {instance.agents.map((agent) => (
                <TableRow key={agent.name} className="border-t border-zinc-800 hover:bg-zinc-800/50">
                  <TableCell className="py-2.5 pr-4">
                    <Link
                      to={`/agents/${agent.name}`}
                      className="text-violet-400 hover:text-violet-300 font-medium transition"
                    >
                      {agent.name}
                    </Link>
                  </TableCell>
                  <TableCell className="py-2.5 pr-4 text-zinc-400 capitalize">{agent.role}</TableCell>
                  <TableCell className="py-2.5 pr-4">
                    <span className="flex items-center gap-2 text-zinc-300">
                      <StatusDot status={agent.status} />
                      {agent.status}
                    </span>
                  </TableCell>
                  <TableCell className="py-2.5">
                    <HealthDot healthStatus={agent.healthStatus} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      {/* Config section */}
      <div className={`rounded-lg border border-zinc-800 bg-zinc-900/50 p-5 ${cardClass}`}>
        <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider mb-3">Configuration</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-2 text-sm">
          <ConfigRow label="Capacity" value={String(instance.capacity)} valueClassName={pf('capacity', 'text-zinc-300')} />
          <ConfigRow label="Version" value={instance.version || 'unknown'} mono valueClassName={pf('version', 'text-zinc-300 font-mono text-xs')} />
          {instance.targetVersion && (
            <ConfigRow label="Target Version" value={instance.targetVersion} mono valueClassName={pf('targetVersion', 'text-zinc-300 font-mono text-xs')} />
          )}
          <ConfigRow label="Agent Count" value={String(instance.agentCount)} valueClassName={pf('agentCount', 'text-zinc-300')} />
          <ConfigRow label="Token" value={maskToken(instance.token)} mono valueClassName={pf('token', 'text-zinc-300 font-mono text-xs')} />
          <ConfigRow label="Node ID" value={instance.nodeId} mono valueClassName={pf('nodeId', 'text-zinc-300 font-mono text-xs')} />
          <ConfigRow label="Instance ID" value={instance.id} mono />
          <ConfigRow label="Created" value={new Date(instance.createdAt).toLocaleString()} />
          {instance.updatedAt && (
            <ConfigRow label="Updated" value={new Date(instance.updatedAt).toLocaleString()} />
          )}
        </div>
      </div>

      {/* Logs */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-5">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider">Logs</h2>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost" onClick={() => setLiveLogs((p) => !p)}
              className={`flex items-center gap-1.5 rounded-lg border px-3 py-1 text-xs font-medium transition ${
                liveLogs
                  ? 'bg-green-500/10 border-green-500/50 text-green-400'
                  : 'border-zinc-700 text-zinc-400 hover:bg-zinc-700/50'
              }`}
            >
              {liveLogs && (
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
                </span>
              )}
              Live
            </Button>
            {!liveLogs && (
              <Button
                variant="ghost" onClick={fetchLogs}
                className="rounded-lg border border-zinc-700 px-3 py-1 text-xs text-zinc-400 hover:bg-zinc-700/50 transition"
              >
                Refresh
              </Button>
            )}
          </div>
        </div>
        <pre
          ref={logRef}
          className="max-h-96 overflow-auto rounded-lg bg-black/40 p-4 text-xs leading-relaxed text-zinc-400 font-mono whitespace-pre-wrap"
        >
          {logs || 'No logs available.'}
        </pre>
      </div>

      {/* Confirm dialog */}
      <ConfirmDialog
        open={!!confirmAction}
        title={
          confirmAction === 'restart' ? 'Restart Instance'
          : confirmAction === 'stop' ? 'Stop Instance'
          : 'Destroy Instance'
        }
        message={
          confirmAction === 'restart'
            ? `This will restart instance "${instance.name}". All agents will briefly go offline.`
            : confirmAction === 'stop'
              ? `This will stop instance "${instance.name}". All agents will go offline.`
              : instance.agentCount > 0
                ? `"${instance.name}" has ${instance.agentCount} agent(s). Destroying will stop all agents in this instance. This cannot be undone.`
                : `Destroy instance "${instance.name}"? This cannot be undone.`
        }
        confirmLabel={
          confirmAction === 'restart' ? 'Restart'
          : confirmAction === 'stop' ? 'Stop'
          : 'Destroy'
        }
        destructive={confirmAction === 'destroy'}
        loading={actionLoading}
        onConfirm={() => confirmAction && handleAction(confirmAction)}
        onCancel={() => setConfirmAction(null)}
      />
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
      <div className="text-xs text-zinc-500 uppercase tracking-wider">{label}</div>
      <div className="mt-1 text-lg font-semibold text-white">{value}</div>
    </div>
  );
}

function ConfigRow({ label, value, mono = false, valueClassName }: { label: string; value: string; mono?: boolean; valueClassName?: string }) {
  return (
    <div className="flex justify-between py-1 border-b border-zinc-800">
      <span className="text-zinc-500">{label}</span>
      <span className={`${valueClassName ?? `text-zinc-300 ${mono ? 'font-mono text-xs' : ''}`}`}>{value}</span>
    </div>
  );
}

function ActionBtn({
  label,
  onClick,
  destructive = false,
  disabled = false,
}: {
  label: ReactNode;
  onClick: () => void;
  destructive?: boolean;
  disabled?: boolean;
}) {
  return (
    <Button
      variant="ghost" onClick={onClick}
      disabled={disabled}
      className={`rounded-lg border px-4 py-2 text-sm font-medium transition inline-flex items-center gap-1.5 ${
        disabled
          ? 'border-zinc-800 text-zinc-500 cursor-not-allowed'
          : destructive
            ? 'border-red-500/20 text-red-400 hover:bg-red-500/10'
            : 'border-zinc-700 text-zinc-300 hover:bg-zinc-700/50'
      }`}
    >
      {label}
    </Button>
  );
}
