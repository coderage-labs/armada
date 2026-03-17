import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiFetch } from '../hooks/useApi';
import { useAuth } from '../hooks/useAuth';
import { useNodes } from '../hooks/queries/useNodes';
import { CheckCircle2, XCircle, Monitor, Cpu, HardDrive, MemoryStick, Box, Loader2, Pencil, Zap, Trash2, Plus } from 'lucide-react';
import { PageHeader } from '../components/PageHeader';
import ConfirmDialog from '../components/ConfirmDialog';
import NodeDialog from '../components/NodeDialog';
import NodeInstallModal from '../components/NodeInstallModal';
import { Button } from '../components/ui/button';
import { EmptyState } from '../components/EmptyState';
import { CardGrid, BaseCard } from '../components/shared';

interface NodeData {
  id: string;
  hostname: string;
  cores: number;
  memory: number;
  status: 'online' | 'offline' | 'degraded';
  wsStatus: 'online' | 'offline' | 'stale';
  agentCount: number;
  version?: string;
  versionCompatible?: boolean;
  url?: string;
  token?: string;
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

function formatMemory(bytes: number): string {
  if (!bytes) return '0 B';
  const gb = bytes / 1024 / 1024 / 1024;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / 1024 / 1024;
  if (mb >= 1) return `${mb.toFixed(0)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

/* ── Resource Bar ──────────────────────────────────── */

function ResourceBar({ label, value, detail, pct, color }: {
  label: string;
  value: string;
  detail?: string;
  pct: number;
  color: string;
}) {
  return (
    <div>
      <div className="flex justify-between text-xs mb-1.5">
        <span className="text-zinc-500">{label}</span>
        <span className="text-zinc-400 tabular-nums">{value}</span>
      </div>
      <div className="w-full bg-zinc-800 rounded-full h-2" title={detail}>
        <div
          className={`h-2 rounded-full transition-all duration-500 ${color}`}
          style={{ width: `${Math.max(pct, 2)}%` }}
        />
      </div>
    </div>
  );
}

/* ── Connection Status ─────────────────────────────── */

function ConnectionBadge({ status }: { status: 'online' | 'offline' | 'stale' }) {
  const config = {
    online: { dot: 'bg-emerald-500', text: 'text-emerald-400', label: 'Connected', pulse: true },
    stale:  { dot: 'bg-amber-500', text: 'text-amber-400', label: 'Stale', pulse: false },
    offline: { dot: 'bg-red-500', text: 'text-red-400', label: 'Disconnected', pulse: false },
  }[status];

  return (
    <span className={`inline-flex items-center gap-1.5 text-[11px] ${config.text}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${config.dot} ${config.pulse ? 'animate-pulse' : ''}`} />
      {config.label}
    </span>
  );
}

/* ── Version Badge ─────────────────────────────────── */

function VersionBadge({ version, compatible }: { version?: string; compatible?: boolean }) {
  if (!version) return null;

  const isCompatible = compatible ?? true;
  const chipClass = isCompatible
    ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
    : 'bg-red-500/10 text-red-400 border-red-500/20';

  return (
    <span
      className={`inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded border ${chipClass}`}
      title={isCompatible ? `Version ${version} (compatible)` : `Version ${version} (incompatible — requires >= 0.1.0)`}
    >
      {isCompatible ? <CheckCircle2 className="w-3 h-3" /> : <XCircle className="w-3 h-3" />}
      v{version}
    </span>
  );
}

/* ── Node Card ─────────────────────────────────────── */

function NodeCard({
  node,
  testResult,
  testing,
  onNavigate,
  onEdit,
  onTest,
  onRemove,
}: {
  node: NodeData;
  testResult?: { ok: boolean; msg: string };
  testing: boolean;
  onNavigate: () => void;
  onEdit: () => void;
  onTest: () => void;
  onRemove: () => void;
}) {
  const hasResources = !!node.liveStats?.cpu;
  const cores = node.liveStats?.cpu?.cores ?? node.liveStats?.cores ?? node.cores;
  const cpuUsage = node.liveStats?.cpu?.usage ?? 0;
  const memTotal = node.liveStats?.memoryDetail?.total ?? node.liveStats?.memory ?? node.memory;
  const memUsed = node.liveStats?.memoryDetail?.used ?? 0;
  const memAvailable = node.liveStats?.memoryDetail?.available ?? memTotal;
  const canSpawn = node.liveStats?.capacity?.canSpawn;
  const wsStatus = node.wsStatus ?? 'offline';
  const disk = node.liveStats?.disk;

  // Health accent
  const healthColor = wsStatus === 'online'
    ? 'bg-emerald-500'
    : wsStatus === 'stale' ? 'bg-amber-500' : 'bg-red-500';

  return (
    <BaseCard
      onClick={onNavigate}
      accentColor={healthColor}
      footer={
        <>
          <Button
            variant="outline"
            size="sm"
            onClick={onEdit}
            className="flex-1 text-xs h-8 gap-1.5 border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50"
          >
            <Pencil className="w-3 h-3" /> Edit
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={onTest}
            disabled={testing}
            className="flex-1 text-xs h-8 gap-1.5 border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50"
          >
            {testing ? <Loader2 className="w-3 h-3 animate-spin" /> : <><Zap className="w-3 h-3" /> Test</>}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={onRemove}
            className="flex-1 text-xs h-8 gap-1.5 border-red-500/20 text-red-400/70 hover:text-red-400 hover:bg-red-500/10 hover:border-red-500/40"
          >
            <Trash2 className="w-3 h-3" /> Remove
          </Button>
        </>
      }
    >

      {/* Header */}
      <div className="p-5 pb-0">
        <div className="flex items-start justify-between">
          <div>
            <h3 className="text-base font-semibold text-zinc-100">{node.hostname}</h3>
            <div className="flex items-center gap-3 mt-1">
              <ConnectionBadge status={wsStatus} />
              <VersionBadge version={node.version} compatible={node.versionCompatible} />
              {node.agentCount > 0 && (
                <span className="text-[11px] text-zinc-500">
                  {node.agentCount} agent{node.agentCount !== 1 ? 's' : ''}
                </span>
              )}
            </div>
          </div>
          {canSpawn !== undefined && (
            <span
              className={`inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-md ${
                canSpawn
                  ? 'bg-emerald-500/10 text-emerald-400'
                  : 'bg-red-500/10 text-red-400'
              }`}
              title={canSpawn ? 'Can spawn agents' : node.liveStats?.capacity?.reason}
            >
              {canSpawn ? <CheckCircle2 className="w-3 h-3" /> : <XCircle className="w-3 h-3" />}
              {canSpawn ? 'Ready' : 'Full'}
            </span>
          )}
        </div>
      </div>

      {/* Resources */}
      <div className="p-5 pt-4 space-y-3 flex-1">
        <ResourceBar
          label="CPU"
          value={hasResources ? `${cpuUsage.toFixed(1)}% · ${cores} cores` : `${cores} cores`}
          pct={hasResources ? cpuUsage : 0}
          color="bg-violet-500"
        />
        <ResourceBar
          label="Memory"
          value={hasResources ? `${formatMemory(memUsed)} / ${formatMemory(memTotal)}` : formatMemory(memTotal)}
          detail={hasResources ? `${formatMemory(memAvailable)} available` : undefined}
          pct={hasResources && memTotal > 0 ? (memUsed / memTotal) * 100 : 0}
          color="bg-blue-500"
        />
        {disk && (() => {
          const diskPct = disk.total > 0 ? (disk.used / disk.total) * 100 : 0;
          return (
            <ResourceBar
              label="Disk"
              value={`${diskPct.toFixed(0)}% · ${formatMemory(disk.available)} free`}
              pct={diskPct}
              color={diskPct > 85 ? 'bg-red-500' : diskPct > 65 ? 'bg-amber-500' : 'bg-emerald-500'}
            />
          );
        })()}

        {/* Containers row */}
        <div className="flex justify-between text-xs pt-1">
          <span className="text-zinc-500">Containers</span>
          <span className="text-zinc-300 tabular-nums">{node.liveStats?.containers ?? 0}</span>
        </div>
      </div>

      {/* Test result */}
      {testResult && (
        <div className={`mx-5 mb-2 text-xs ${testResult.ok ? 'text-emerald-400' : 'text-red-400'}`}>
          {testResult.msg}
        </div>
      )}

    </BaseCard>
  );
}

/* ── Page Component ────────────────────────────────── */

export default function Nodes() {
  const navigate = useNavigate();
  const { hasScope } = useAuth();
  const canMutate = hasScope('nodes:write');
  const { data: nodes = [], isLoading: loading, refetch: fetchNodes } = useNodes();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editNode, setEditNode] = useState<NodeData | null>(null);

  const [confirmRemove, setConfirmRemove] = useState<NodeData | null>(null);
  const [removeImpact, setRemoveImpact] = useState<{
    instances: Array<{ id: string; name: string; status: string }>;
    agents: Array<{ id: string; name: string; status: string }>;
  } | null>(null);
  const [removing, setRemoving] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; msg: string }>>({});
  const [installModal, setInstallModal] = useState<{ nodeId: string; installToken: string } | null>(null);

  async function handleTest(node: NodeData) {
    setTestingId(node.id);
    try {
      const res = await apiFetch<{ success: boolean; error?: string; health?: any }>(
        `/api/nodes/${node.id}/test`,
        { method: 'POST' },
      );
      setTestResults(prev => ({
        ...prev,
        [node.id]: res.success
          ? { ok: true, msg: `✓ ${res.health?.hostname ?? 'Connected'}` }
          : { ok: false, msg: `✗ ${res.error ?? 'Failed'}` },
      }));
      fetchNodes();
    } catch (e: any) {
      setTestResults(prev => ({ ...prev, [node.id]: { ok: false, msg: `✗ ${e.message}` } }));
    } finally {
      setTestingId(null);
    }
  }

  async function handleRemove() {
    if (!confirmRemove) return;
    setRemoving(true);
    try {
      await apiFetch(`/api/nodes/${confirmRemove.id}?confirm=true`, { method: 'DELETE' });
      setConfirmRemove(null);
      fetchNodes();
    } catch {
      // stay open
    } finally {
      setRemoving(false);
    }
  }

  function handleEdit(node: NodeData) {
    setEditNode(node);
    setDialogOpen(true);
  }

  function handleAdd() {
    setEditNode(null);
    setDialogOpen(true);
  }

  function handleNodeCreated(nodeId: string, installToken: string) {
    setInstallModal({ nodeId, installToken });
    fetchNodes();
  }

  return (
    <div className="space-y-6">
      <PageHeader icon={Monitor} title="Nodes" subtitle="Compute nodes in your Armada">
        {canMutate && (
          <Button
            onClick={handleAdd}
            className="bg-violet-600 hover:bg-violet-700 text-white text-sm px-4 h-9"
          >
            + Add Node
          </Button>
        )}
      </PageHeader>

      {loading && <CardGrid loading skeletonCount={3} />}

      {!loading && nodes.length === 0 && (
        <EmptyState
          icon={Monitor}
          title="No nodes registered"
          description="Add a compute node to start deploying agents"
          action={canMutate ? { label: '+ Add Node', onClick: handleAdd } : undefined}
        />
      )}

      {!loading && nodes.length > 0 && (
        <CardGrid>
          {nodes.map((node) => (
            <NodeCard
              key={node.id}
              node={node}
              testResult={testResults[node.id]}
              testing={testingId === node.id}
              onNavigate={() => navigate(`/nodes/${node.id}`)}
              onEdit={() => handleEdit(node)}
              onTest={() => handleTest(node)}
              onRemove={async () => {
                setConfirmRemove(node);
                setRemoveImpact(null);
                try {
                  // DELETE without ?confirm=true returns 400 with impact assessment
                  const token = localStorage.getItem('armada_token');
                  const res = await fetch(`/api/nodes/${node.id}`, {
                    method: 'DELETE',
                    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
                  });
                  const body = await res.json().catch(() => null);
                  if (body?.impact) setRemoveImpact(body.impact);
                } catch { /* non-fatal — dialog still shows without impact */ }
              }}
            />
          ))}
        </CardGrid>
      )}

      <NodeDialog
        open={dialogOpen}
        node={editNode}
        onClose={() => setDialogOpen(false)}
        onSaved={fetchNodes}
        onCreated={handleNodeCreated}
      />

      {installModal && (
        <NodeInstallModal
          nodeId={installModal.nodeId}
          installToken={installModal.installToken}
          onClose={() => setInstallModal(null)}
        />
      )}

      <ConfirmDialog
        open={!!confirmRemove}
        title="Remove Node"
        message=""
        confirmLabel="Remove"
        destructive
        loading={removing}
        onConfirm={handleRemove}
        onCancel={() => { setConfirmRemove(null); setRemoveImpact(null); }}
      >
        <div className="space-y-3 text-sm">
          <p className="text-zinc-300">
            Remove <span className="font-medium text-zinc-100">"{confirmRemove?.hostname}"</span> from the Armada?
          </p>
          {removeImpact && (removeImpact.instances.length > 0 || removeImpact.agents.length > 0) ? (
            <div className="space-y-2">
              <p className="text-zinc-400 text-xs">The following resources on this node will become unmanaged:</p>
              {removeImpact.instances.length > 0 && (
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">Instances ({removeImpact.instances.length})</p>
                  <ul className="space-y-0.5">
                    {removeImpact.instances.map(i => (
                      <li key={i.id} className="flex items-center gap-2 text-xs text-zinc-300">
                        <span className={`w-1.5 h-1.5 rounded-full ${i.status === 'running' ? 'bg-green-500' : i.status === 'stopped' ? 'bg-zinc-600' : 'bg-amber-500'}`} />
                        {i.name} <span className="text-zinc-600">({i.status})</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {removeImpact.agents.length > 0 && (
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">Agents ({removeImpact.agents.length})</p>
                  <ul className="space-y-0.5">
                    {removeImpact.agents.map(a => (
                      <li key={a.id} className="flex items-center gap-2 text-xs text-zinc-300">
                        <span className={`w-1.5 h-1.5 rounded-full ${a.status === 'online' ? 'bg-green-500' : 'bg-zinc-600'}`} />
                        {a.name} <span className="text-zinc-600">({a.status})</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          ) : removeImpact ? (
            <p className="text-zinc-500 text-xs">No instances or agents on this node.</p>
          ) : null}
        </div>
      </ConfirmDialog>
    </div>
  );
}
