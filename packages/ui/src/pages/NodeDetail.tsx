import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Check, Copy, RefreshCw, Server, ShieldCheck, RotateCcw, Monitor } from 'lucide-react';
import { LoadingState } from '../components/LoadingState';
import { PageHeader } from '../components/PageHeader';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { apiFetch } from '../hooks/useApi';
import { useNode } from '../hooks/queries/useNodes';
import { useAuth } from '../hooks/useAuth';
import StatusDot from '../components/StatusDot';
import Sparkline from '../components/Sparkline';
import ConfirmDialog from '../components/ConfirmDialog';
import NodeInstallModal from '../components/NodeInstallModal';
import { Button } from '../components/ui/button';
import { Table, TableHeader, TableBody, TableHead, TableRow, TableCell } from '../components/ui/table';

interface NodeData {
  id: string;
  hostname: string;
  cores: number;
  memory: number;
  status: 'online' | 'offline' | 'degraded';
  wsStatus: 'online' | 'offline' | 'stale';
  agentCount: number;
  fingerprint?: string | null;
  credentialStatus?: 'active' | 'unregistered';
  credentialRotatedAt?: string | null;
  connectedSince?: string | null;
  lastHeartbeat?: string | null;
  liveStats?: {
    cores: number;
    memory: number;
    hostname: string;
    containers: number;
    cpu?: { cores: number; usage: number; loadAvg: [number, number, number] };
    memoryDetail?: { total: number; used: number; available: number };
    disk?: { total: number; used: number; available: number };
    armada?: { running: number; allocatedMemory: number; allocatedCpu: number };
    capacity?: { canSpawn: boolean; availableMemory: number; reason?: string };
  };
}

interface HistoryPoint {
  timestamp: number;
  cpu?: { cores: number; usage: number; loadAvg: [number, number, number] };
  memory?: { total: number; used: number; available: number };
  armada?: { running: number; allocatedMemory: number; allocatedCpu: number };
}

interface ContainerDetail {
  id: string;
  name: string;
  cpu: number;
  memory: { usage: number; limit: number };
  network: { rx: number; tx: number };
  uptime: number;
}

interface StatsDetail {
  cpu?: { cores: number; usage: number; loadAvg: [number, number, number] };
  memory?: { total: number; used: number; free: number; available?: number };
  disk?: { total: number; used: number; available: number };
  containers?: ContainerDetail[] | { running: number; total: number };
  armada?: any;
}

interface InstanceData {
  id: string;
  name: string;
  nodeId: string;
  status: string;
}

function formatMemory(bytes: number): string {
  if (!bytes) return '0 B';
  const gb = bytes / 1024 / 1024 / 1024;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / 1024 / 1024;
  if (mb >= 1) return `${mb.toFixed(0)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
}

function formatTimestamp(ts: string | null | undefined): string {
  if (!ts) return '—';
  try {
    const d = new Date(ts);
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) + ', ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return ts;
  }
}

function MiniBar({ value, max, color, label }: { value: number; max: number; color: string; label?: string }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="w-full">
      <div className="w-full bg-zinc-700/50 rounded-full h-1.5" title={label}>
        <div className={`h-1.5 rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function CopyInline({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  }
  return (
    <Button
      variant="ghost" onClick={handleCopy}
      className="ml-1.5 text-zinc-500 hover:text-zinc-300 transition"
      title="Copy"
    >
      {copied ? <Check className="w-3.5 h-3.5 text-green-400 inline" /> : <Copy className="w-3.5 h-3.5 inline" />}
    </Button>
  );
}

function WsStatusBadge({ status }: { status: 'online' | 'offline' | 'stale' }) {
  if (status === 'online') {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm text-green-400">
        <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse inline-block" />
        Connected
      </span>
    );
  }
  if (status === 'stale') {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm text-yellow-400">
        <span className="w-2 h-2 rounded-full bg-yellow-500 inline-block" />
        Stale
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-sm text-red-400">
      <span className="w-2 h-2 rounded-full bg-red-500 inline-block" />
      Disconnected
    </span>
  );
}

export default function NodeDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { hasScope } = useAuth();
  const canMutate = hasScope('nodes:write');

  const { data: nodeQueryData, isLoading: loading, isError: nodeQueryError, refetch: fetchNode } = useNode(id ?? '');
  const node = nodeQueryData as NodeData | undefined ?? null;
  const error = nodeQueryError ? 'Failed to load node' : '';
  const [stats, setStats] = useState<StatsDetail | null>(null);
  const [history, setHistory] = useState<HistoryPoint[]>([]);

  // Credential management
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [rotateResult, setRotateResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  const [regeneratedToken, setRegeneratedToken] = useState<{ nodeId: string; installToken: string } | null>(null);

  // Logs state
  const [instances, setInstances] = useState<InstanceData[]>([]);
  const [selectedInstance, setSelectedInstance] = useState<string>('');
  const [logSource, setLogSource] = useState<'instance' | 'node-agent'>('instance');
  const [logs, setLogs] = useState('');
  const [nodeLogs, setNodeLogs] = useState<Array<{ timestamp: string; level: string; message: string }>>([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const logRef = useRef<HTMLPreElement>(null);

  const fetchStats = useCallback(async () => {
    if (!id) return;
    try {
      const [s, h] = await Promise.all([
        apiFetch<StatsDetail>(`/api/nodes/${id}/stats`).catch(() => null),
        apiFetch<HistoryPoint[] | { history: HistoryPoint[] }>(`/api/nodes/${id}/stats/history`).catch(() => []),
      ]);
      setStats(s);
      setHistory(Array.isArray(h) ? h : (h as any)?.history ?? []);
    } catch {
      // silent
    }
  }, [id]);

  const fetchInstances = useCallback(async () => {
    if (!id) return;
    try {
      const all = await apiFetch<InstanceData[]>('/api/instances');
      const nodeInstances = all.filter((inst) => inst.nodeId === id);
      setInstances(nodeInstances);
      if (nodeInstances.length > 0 && !selectedInstance) {
        setSelectedInstance(nodeInstances[0].id);
      }
    } catch {
      // silent
    }
  }, [id, selectedInstance]);

  const fetchLogs = useCallback(async (instanceId?: string) => {
    const target = instanceId || selectedInstance;
    if (!target) return;
    setLogsLoading(true);
    try {
      const text = await apiFetch<string>(`/api/instances/${target}/logs?tail=200`);
      setLogs(typeof text === 'string' ? text : String(text));
    } catch {
      setLogs('Failed to fetch logs.');
    } finally {
      setLogsLoading(false);
    }
  }, [selectedInstance]);

  const fetchNodeLogs = useCallback(async () => {
    if (!id) return;
    setLogsLoading(true);
    try {
      const result = await apiFetch<{ logs: Array<{ timestamp: string; level: string; message: string }> }>(`/api/nodes/${id}/logs?limit=200`);
      setNodeLogs(result?.logs ?? []);
    } catch {
      setNodeLogs([]);
    } finally {
      setLogsLoading(false);
    }
  }, [id]);

  // Initial data fetch
  useEffect(() => {
    fetchStats();
    fetchInstances();
  }, [fetchStats, fetchInstances]);

  // Stats refresh via SSE (node events) — polling removed

  // Fetch logs when instance selected or log source changes
  useEffect(() => {
    if (logSource === 'node-agent') {
      fetchNodeLogs();
    } else if (selectedInstance) {
      fetchLogs(selectedInstance);
    }
  }, [logSource, selectedInstance]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-refresh logs every 10s
  useEffect(() => {
    if (logSource === 'node-agent') {
      const interval = setInterval(fetchNodeLogs, 10000);
      return () => clearInterval(interval);
    }
    if (!selectedInstance) return;
    const interval = setInterval(() => fetchLogs(selectedInstance), 10000);
    return () => clearInterval(interval);
  }, [logSource, selectedInstance, fetchLogs, fetchNodeLogs]);

  // Auto-scroll logs
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logs]);

  async function handleRotateCredential() {
    if (!id) return;
    setRotating(true);
    setRotateResult(null);
    try {
      await apiFetch(`/api/nodes/${id}/rotate-credential`, { method: 'POST' });
      setRotateResult({ ok: true, msg: 'Credential rotated successfully' });
      fetchNode();
    } catch (e: any) {
      setRotateResult({ ok: false, msg: e.message || 'Failed to rotate credential' });
    } finally {
      setRotating(false);
      setConfirmRotate(false);
    }
  }

  async function handleRegenerateToken() {
    if (!id) return;
    setRegenerating(true);
    try {
      const result = await apiFetch<{ installToken: string }>(`/api/nodes/${id}/regenerate-token`, { method: 'POST' });
      setRegeneratedToken({ nodeId: id, installToken: result.installToken });
      fetchNode();
    } catch (e: any) {
      // silent — show error inline
    } finally {
      setRegenerating(false);
    }
  }

  if (loading) {
    return <LoadingState />;
  }

  if (error && !node) {
    return (
      <div className="py-12 text-center">
        <p className="text-red-400">{error}</p>
        <Button variant="ghost" onClick={() => navigate('/nodes')} className="mt-4 text-sm text-purple-400 hover:underline">
          ← Back to Nodes
        </Button>
      </div>
    );
  }

  if (!node) return null;

  const wsStatus = node.wsStatus ?? 'offline';
  const cpuHistory = history.map((h) => h.cpu?.usage ?? 0);
  const memHistory = history.map((h) => h.memory && h.memory.total > 0 ? (h.memory.used / h.memory.total) * 100 : 0);
  const containerHistory = history.map((h) => h.armada?.running ?? 0);

  return (
    <div className="space-y-6">
      {/* Back + Header */}
      <Button
        variant="ghost" onClick={() => navigate('/nodes')}
        className="text-zinc-400 hover:text-zinc-100 text-sm flex items-center gap-1"
      >
        <ArrowLeft className="w-4 h-4" />
        Back
      </Button>
      <PageHeader icon={Monitor} title={node.liveStats?.hostname ?? node.hostname}>
        <div className="flex items-center gap-3">
          <WsStatusBadge status={wsStatus} />
        </div>
      </PageHeader>

      {/* Connection Info */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-5">
        <h3 className="text-sm font-medium text-zinc-300 mb-4 flex items-center gap-2">
          <ShieldCheck className="w-4 h-4" />
          Connection Info
        </h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div>
            <p className="text-xs text-zinc-500 mb-1">Status</p>
            <WsStatusBadge status={wsStatus} />
          </div>
          <div>
            <p className="text-xs text-zinc-500 mb-1">Connected Since</p>
            <p className="text-sm text-zinc-300">{formatTimestamp(node.connectedSince)}</p>
          </div>
          <div>
            <p className="text-xs text-zinc-500 mb-1">Last Heartbeat</p>
            <p className="text-sm text-zinc-300">{formatTimestamp(node.lastHeartbeat)}</p>
          </div>
          <div>
            <p className="text-xs text-zinc-500 mb-1">Session Credential</p>
            <span className={`text-sm ${node.credentialStatus === 'active' ? 'text-green-400' : 'text-yellow-400'}`}>
              {node.credentialStatus === 'active' ? 'Active' : 'Not registered'}
            </span>
          </div>
        </div>
        {node.credentialRotatedAt && (
          <p className="text-xs text-zinc-600 mt-3">
            Credential last rotated: {formatTimestamp(node.credentialRotatedAt)}
          </p>
        )}
      </div>

      {/* Credentials / Registration */}
      {canMutate && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-5">
          <h3 className="text-sm font-medium text-zinc-300 mb-4 flex items-center gap-2">
            <RotateCcw className="w-4 h-4" />
            Credentials
          </h3>

          <div className="space-y-4">
            {/* Fingerprint */}
            {node.fingerprint && (
              <div>
                <p className="text-xs text-zinc-500 mb-1">Machine Fingerprint</p>
                <div className="flex items-center gap-1 min-w-0">
                  <code className="text-xs font-mono text-zinc-400 bg-black/30 px-2 py-1 rounded truncate min-w-0">
                    {node.fingerprint}
                  </code>
                  <CopyInline text={node.fingerprint} />
                </div>
              </div>
            )}

            {/* Action buttons */}
            <div className="flex flex-wrap gap-3">
              {/* Rotate credential */}
              <Button
                variant="ghost" onClick={() => setConfirmRotate(true)}
                disabled={rotating || wsStatus !== 'online'}
                className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm font-medium text-amber-300 hover:bg-amber-500/20 transition disabled:opacity-50 flex items-center gap-2"
                title={wsStatus !== 'online' ? 'Node must be online to rotate credential' : undefined}
              >
                <RotateCcw className="w-3.5 h-3.5" />
                Rotate Credential
              </Button>

              {/* Regenerate install token */}
              <Button
                variant="ghost" onClick={handleRegenerateToken}
                disabled={regenerating}
                className="rounded-lg border border-violet-500/30 bg-violet-500/10 px-4 py-2 text-sm font-medium text-violet-300 hover:bg-violet-500/20 transition disabled:opacity-50 flex items-center gap-2"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${regenerating ? 'animate-spin' : ''}`} />
                {regenerating ? 'Generating…' : 'Regenerate Install Token'}
              </Button>
            </div>

            {/* Rotate result */}
            {rotateResult && (
              <p className={`text-sm ${rotateResult.ok ? 'text-green-400' : 'text-red-400'}`}>
                {rotateResult.ok ? '✓' : '✗'} {rotateResult.msg}
              </p>
            )}
          </div>
        </div>
      )}

      {/* Sparkline charts */}
      {history.length > 1 && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
            <p className="text-xs text-zinc-400 mb-2">CPU Usage (1h)</p>
            <Sparkline data={cpuHistory} width={280} height={40} color="#a78bfa" />
            <p className="text-xs text-zinc-500 mt-1">
              Current: {cpuHistory[cpuHistory.length - 1]?.toFixed(1)}%
            </p>
          </div>
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
            <p className="text-xs text-zinc-400 mb-2">Memory Usage (1h)</p>
            <Sparkline data={memHistory} width={280} height={40} color="#c084fc" />
            <p className="text-xs text-zinc-500 mt-1">
              Current: {memHistory[memHistory.length - 1]?.toFixed(1)}%
            </p>
          </div>
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
            <p className="text-xs text-zinc-400 mb-2">Containers (1h)</p>
            <Sparkline data={containerHistory} width={280} height={40} color="#5eead4" />
            <p className="text-xs text-zinc-500 mt-1">
              Current: {containerHistory[containerHistory.length - 1]}
            </p>
          </div>
        </div>
      )}

      {/* Host stats summary */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
            <p className="text-xs text-zinc-400">CPU</p>
            <p className="text-xl font-bold text-zinc-100">{stats.cpu?.cores ?? '—'} cores</p>
            <p className="text-xs text-zinc-500">{stats.cpu?.usage ?? '—'}% used</p>
          </div>
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
            <p className="text-xs text-zinc-400">Memory</p>
            <p className="text-xl font-bold text-zinc-100">
              {formatMemory(stats.memory?.used ?? 0)} / {formatMemory(stats.memory?.total ?? 0)}
            </p>
            <p className="text-xs text-zinc-500">{formatMemory((stats.memory?.available ?? stats.memory?.free) ?? 0)} available</p>
          </div>
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
            <p className="text-xs text-zinc-400">Disk</p>
            <p className="text-xl font-bold text-zinc-100">
              {formatMemory(stats.disk?.used ?? 0)} / {formatMemory(stats.disk?.total ?? 0)}
            </p>
            <p className="text-xs text-zinc-500">{formatMemory(stats.disk?.available ?? 0)} available</p>
          </div>
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
            <p className="text-xs text-zinc-400">Load Average</p>
            <p className="text-xl font-bold text-zinc-100">
              {stats.cpu?.loadAvg?.map((v: number) => v.toFixed(2)).join(' ') ?? '—'}
            </p>
            <p className="text-xs text-zinc-500">1m / 5m / 15m</p>
          </div>
        </div>
      )}

      {/* Container breakdown */}
      {stats && Array.isArray(stats.containers) && stats.containers.length > 0 && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50">
          <div className="px-5 py-3 border-b border-zinc-800">
            <h3 className="text-sm font-medium text-zinc-300">
              Containers ({(stats.containers as ContainerDetail[]).length})
            </h3>
          </div>
          <Table className="text-sm">
            <TableHeader>
              <TableRow className="text-zinc-500 text-xs">
                <TableHead className="text-left px-5 py-2 font-medium">Name</TableHead>
                <TableHead className="text-right px-5 py-2 font-medium">CPU %</TableHead>
                <TableHead className="text-right px-5 py-2 font-medium">Memory</TableHead>
                <TableHead className="text-right px-5 py-2 font-medium">Network</TableHead>
                <TableHead className="text-right px-5 py-2 font-medium">Uptime</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(Array.isArray(stats.containers) ? stats.containers as ContainerDetail[] : []).map((c) => (
                <TableRow key={c.id} className="border-t border-zinc-800 hover:bg-zinc-800/50">
                  <TableCell className="px-5 py-2.5 text-zinc-200 font-mono text-xs">{c.name}</TableCell>
                  <TableCell className="px-5 py-2.5 text-right text-zinc-300">{c.cpu}%</TableCell>
                  <TableCell className="px-5 py-2.5 text-right text-zinc-300">
                    {formatMemory(c.memory.usage)} / {formatMemory(c.memory.limit)}
                  </TableCell>
                  <TableCell className="px-5 py-2.5 text-right text-zinc-400 text-xs">
                    ↓{formatMemory(c.network.rx)} ↑{formatMemory(c.network.tx)}
                  </TableCell>
                  <TableCell className="px-5 py-2.5 text-right text-zinc-400">{formatUptime(c.uptime)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {stats && (!stats.containers || (Array.isArray(stats.containers) && stats.containers.length === 0)) && (
        <div className="text-center py-8 text-zinc-500 text-sm">
          No Armada containers running on this node
        </div>
      )}

      {/* Logs Section */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium text-zinc-300 flex items-center gap-2">
            <Server className="w-4 h-4" />
            Logs
          </h3>
          <div className="flex items-center gap-2">
            {/* Log source selector */}
            <Select value={logSource} onValueChange={(val) => setLogSource(val as 'instance' | 'node-agent')}>
              <SelectTrigger className="w-36 h-7 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="instance">Instance Logs</SelectItem>
                <SelectItem value="node-agent">Node Agent</SelectItem>
              </SelectContent>
            </Select>
            {/* Instance selector (only when viewing instance logs) */}
            {logSource === 'instance' && instances.length > 0 && (
              <Select value={selectedInstance} onValueChange={setSelectedInstance}>
                <SelectTrigger className="w-40 h-7 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {instances.map((inst) => (
                    <SelectItem key={inst.id} value={inst.id}>
                      {inst.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <Button
              variant="ghost" onClick={() => logSource === 'node-agent' ? fetchNodeLogs() : fetchLogs()}
              disabled={(logSource === 'instance' && !selectedInstance) || logsLoading}
              className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 hover:bg-zinc-700/50 transition disabled:opacity-50 flex items-center gap-1"
            >
              <RefreshCw className={`w-3 h-3 ${logsLoading ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
          </div>
        </div>

        {/* Instance logs */}
        {logSource === 'instance' && (
          instances.length === 0 ? (
            <p className="text-sm text-zinc-500">No instances on this node</p>
          ) : (
            <pre
              ref={logRef}
              className="max-h-96 overflow-auto rounded-lg bg-black/40 p-4 text-xs leading-relaxed text-zinc-400 font-mono whitespace-pre-wrap"
            >
              {logs || 'No logs available.'}
            </pre>
          )
        )}

        {/* Node agent logs */}
        {logSource === 'node-agent' && (
          <div
            ref={logRef as any}
            className="max-h-96 overflow-auto rounded-lg bg-black/40 p-4 text-xs leading-relaxed font-mono space-y-0.5"
          >
            {nodeLogs.length === 0 ? (
              <p className="text-zinc-500">No node agent logs available.</p>
            ) : (
              nodeLogs.map((entry, i) => (
                <div key={i} className="flex gap-2">
                  <span className="text-zinc-600 shrink-0 select-none">
                    {new Date(entry.timestamp).toLocaleTimeString()}
                  </span>
                  <span className={`shrink-0 w-10 font-semibold ${
                    entry.level === 'error' ? 'text-red-400' :
                    entry.level === 'warn'  ? 'text-yellow-400' :
                    'text-green-400'
                  }`}>
                    {entry.level.toUpperCase()}
                  </span>
                  <span className="text-zinc-300 break-all">{entry.message}</span>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {/* Dialogs */}
      <ConfirmDialog
        open={confirmRotate}
        title="Rotate Session Credential"
        message="This will issue a new session credential to the connected node. The node must be online. Are you sure?"
        confirmLabel="Rotate"
        destructive
        loading={rotating}
        onConfirm={handleRotateCredential}
        onCancel={() => setConfirmRotate(false)}
      />

      {regeneratedToken && (
        <NodeInstallModal
          nodeId={regeneratedToken.nodeId}
          installToken={regeneratedToken.installToken}
          onClose={() => setRegeneratedToken(null)}
        />
      )}
    </div>
  );
}
