import { useEffect, useState, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../hooks/useApi';
import { useSSEAll } from '../providers/SSEProvider';
import { useAuth } from '../hooks/useAuth';
import StatusDot from '../components/StatusDot';
import ConfirmDialog from '../components/ConfirmDialog';
import InstanceDialog from '../components/InstanceDialog';
import { PendingBadge } from '../components/PendingBadge';
import { usePendingStyle } from '../hooks/usePendingStyle';
import type { PendingFields } from '../hooks/usePendingStyle';
import { Layers, Loader2, Lock, Play, Square, RotateCcw, Activity, Trash2 } from 'lucide-react';
import { EmptyState } from '../components/EmptyState';
import { CardGrid, BaseCard } from '../components/shared';
import { PageHeader } from '../components/PageHeader';
import { Button } from '../components/ui/button';

interface VersionInfo {
  latest: string | null;
  instances: Array<{
    name: string;
    running: string | null;
    target: string | null;
    outdated: boolean;
  }>;
}

interface PluginDriftEntry {
  name: string;
  libraryVersion: string | null;
  instances: Array<{
    name: string;
    installedVersion: string;
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

interface InstanceData {
  id: string;
  name: string;
  nodeId: string;
  nodeName: string;
  status: 'running' | 'stopped' | 'error' | 'starting' | 'provisioning';
  agentCount: number;
  capacity: number;
  version?: string;
  targetVersion?: string;
  createdAt: string;
  updatedAt?: string;
  lockedByOperation?: string | null; // operationId if locked
  pendingAction?: string | null;
  pendingFields?: PendingFields | null;
}

const PROVISION_STEPS: Record<string, string> = {
  pulling_image: 'Pulling image…',
  pull_warning: 'Pull warning (continuing)…',
  creating_container: 'Creating container…',
  starting_container: 'Starting container…',
  health_check: 'Waiting for healthy…',
};

interface HealthResult {
  ok: boolean;
  msg: string;
}

/* ── Status accent bar colour ──────────────────────── */

function statusAccentColor(status: InstanceData['status']): string {
  switch (status) {
    case 'running':      return 'bg-emerald-500';
    case 'stopped':      return 'bg-zinc-600';
    case 'error':        return 'bg-red-500';
    case 'starting':
    case 'provisioning': return 'bg-violet-500';
    default:             return 'bg-zinc-600';
  }
}

/* ── Instance Card ─────────────────────────────────── */

function InstanceCard({
  instance,
  health,
  healthChecking,
  provisionSteps,
  provisionErrors,
  canMutate,
  onNavigate,
  onStart,
  onStop,
  onRestart,
  onHealthCheck,
  onDestroy,
}: {
  instance: InstanceData;
  health?: HealthResult;
  healthChecking: boolean;
  provisionSteps: Record<string, string>;
  provisionErrors: Record<string, string>;
  canMutate: boolean;
  onNavigate: () => void;
  onStart: () => void;
  onStop: () => void;
  onRestart: () => void;
  onHealthCheck: () => void;
  onDestroy: () => void;
}) {
  const isProvisioning = instance.status === 'provisioning' || provisionSteps[instance.id] !== undefined;
  const currentStep = provisionSteps[instance.id];
  const provisionError = provisionErrors[instance.id];
  const accentColor = statusAccentColor(isProvisioning ? 'provisioning' : instance.status);
  const { cardClass } = usePendingStyle(instance.pendingFields, instance.pendingAction);

  const footerButtons = !isProvisioning ? (
    <>
      {instance.status === 'stopped' && canMutate && (
        <Button
          variant="outline"
          size="sm"
          onClick={onStart}
          className="flex-1 text-xs h-8 gap-1.5 border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50"
        >
          <Play className="w-3 h-3" /> Start
        </Button>
      )}
      {instance.status === 'running' && canMutate && (
        <Button
          variant="outline"
          size="sm"
          onClick={onStop}
          className="flex-1 text-xs h-8 gap-1.5 border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50"
        >
          <Square className="w-3 h-3" /> Stop
        </Button>
      )}
      {instance.status === 'running' && canMutate && (
        <Button
          variant="outline"
          size="sm"
          onClick={onRestart}
          className="flex-1 text-xs h-8 gap-1.5 border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50"
        >
          <RotateCcw className="w-3 h-3" /> Restart
        </Button>
      )}
      <Button
        variant="outline"
        size="sm"
        onClick={onHealthCheck}
        disabled={healthChecking}
        className="flex-1 text-xs h-8 gap-1.5 border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50 disabled:opacity-50"
      >
        {healthChecking
          ? <><Loader2 className="w-3 h-3 animate-spin" /> Checking…</>
          : <><Activity className="w-3 h-3" /> Health</>}
      </Button>
      {canMutate && (
        <Button
          variant="outline"
          size="sm"
          onClick={onDestroy}
          className="flex-1 text-xs h-8 gap-1.5 border-red-500/20 text-red-400/70 hover:text-red-400 hover:bg-red-500/10 hover:border-red-500/40"
        >
          <Trash2 className="w-3 h-3" /> Destroy
        </Button>
      )}
    </>
  ) : undefined;

  return (
    <BaseCard
      onClick={onNavigate}
      accentColor={accentColor}
      className={cardClass || undefined}
      footer={footerButtons}
      footerClassName="flex flex-wrap gap-2"
    >

      {/* Header */}
      <div className="p-5 pb-0">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-2.5">
            <StatusDot status={isProvisioning ? 'starting' : instance.status} />
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base font-semibold text-zinc-100">{instance.name}</h3>
                {instance.pendingAction && (
                  <PendingBadge action={instance.pendingAction as 'create' | 'update' | 'delete'} />
                )}
              </div>
              <p className="text-[11px] text-zinc-500 mt-0.5">{instance.nodeName}</p>
            </div>
          </div>
          <span className="text-[11px] px-2 py-1 rounded-md bg-zinc-800/80 text-zinc-400 tabular-nums">
            {instance.agentCount} / {instance.capacity}
          </span>
        </div>
      </div>

      {/* Details */}
      <div className="p-5 pt-4 space-y-2.5 flex-1">

        {/* Provisioning progress */}
        {isProvisioning && (
          <div className="rounded-lg border border-violet-500/20 bg-violet-500/10 px-3 py-2.5 space-y-2">
            <div className="flex items-center gap-2">
              <Loader2 className="w-3.5 h-3.5 text-violet-400 animate-spin flex-shrink-0" />
              <span className="text-xs font-medium text-violet-300">Provisioning</span>
            </div>
            <div className="flex gap-1.5 flex-wrap">
              {(['pulling_image', 'creating_container', 'starting_container', 'health_check'] as const).map(step => {
                const stepLabels: Record<string, string> = {
                  pulling_image: 'Pull image',
                  creating_container: 'Create container',
                  starting_container: 'Start',
                  health_check: 'Health check',
                };
                const stepOrder = ['pulling_image', 'creating_container', 'starting_container', 'health_check'];
                const currentIdx = stepOrder.indexOf(currentStep ?? '');
                const thisIdx = stepOrder.indexOf(step);
                const isDone = currentIdx > thisIdx;
                const isActive = currentStep === step;
                return (
                  <span
                    key={step}
                    className={`text-[10px] px-2 py-0.5 rounded-full ${
                      isDone
                        ? 'bg-emerald-500/20 text-emerald-400'
                        : isActive
                        ? 'bg-violet-500/30 text-violet-300'
                        : 'bg-zinc-800/50 text-zinc-500'
                    }`}
                  >
                    {isDone ? '✓ ' : isActive ? '⟳ ' : ''}{stepLabels[step]}
                  </span>
                );
              })}
            </div>
            {currentStep && PROVISION_STEPS[currentStep] && (
              <p className="text-xs text-violet-400/80">{PROVISION_STEPS[currentStep]}</p>
            )}
          </div>
        )}

        {/* Provision error */}
        {provisionError && (
          <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-400">
            ✗ {provisionError}
          </div>
        )}

        {/* Operation lock indicator */}
        {!isProvisioning && instance.lockedByOperation && (
          <div className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-800/40 px-3 py-1.5">
            <Loader2 className="w-3.5 h-3.5 text-zinc-400 animate-spin shrink-0" />
            <span className="text-xs text-zinc-400">Operation in progress</span>
            <Lock className="w-3 h-3 text-zinc-600 ml-auto shrink-0" />
          </div>
        )}

        {/* Key-value details */}
        {!isProvisioning && (
          <>
            <div className="flex justify-between text-xs">
              <span className="text-zinc-500">Status</span>
              <span className="text-zinc-300 capitalize">{instance.status}</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-zinc-500">Agents</span>
              <span className="text-zinc-300">{instance.agentCount} / {instance.capacity}</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-zinc-500">Version</span>
              <span className={`font-mono ${
                instance.targetVersion && instance.version !== instance.targetVersion
                  ? 'text-amber-400' : 'text-zinc-300'
              }`}>
                {instance.version || 'unknown'}
                {instance.targetVersion && instance.version !== instance.targetVersion && (
                  <span className="text-amber-500 ml-1">→ {instance.targetVersion}</span>
                )}
              </span>
            </div>
          </>
        )}

        {/* Health result */}
        {health && !isProvisioning && (
          <p className={`text-xs ${health.ok ? 'text-emerald-400' : 'text-red-400'}`}>
            {health.msg}
          </p>
        )}
      </div>

    </BaseCard>
  );
}

/* ── Page Component ────────────────────────────────── */

export default function Instances() {
  const navigate = useNavigate();
  const { user: _user, hasScope } = useAuth();
  const canMutate = hasScope('instances:write');
  const queryClient = useQueryClient();
  const [instances, setInstances] = useState<InstanceData[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [confirmTarget, setConfirmTarget] = useState<{ instance: InstanceData; action: string } | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [healthResults, setHealthResults] = useState<Record<string, HealthResult>>({});
  const [healthChecking, setHealthChecking] = useState<string | null>(null);
  const [versionInfo, setVersionInfo] = useState<VersionInfo | null>(null);
  const [pluginDrift, setPluginDrift] = useState<PluginDriftEntry[]>([]);
  const [provisionSteps, setProvisionSteps] = useState<Record<string, string>>({});
  const [provisionErrors, setProvisionErrors] = useState<Record<string, string>>({});
  const sseRef = useRef<EventSource | null>(null);

  const fetchVersions = useCallback(async () => {
    try {
      const data = await apiFetch<VersionInfo>('/api/system/versions');
      setVersionInfo(data);
    } catch {
      // silent
    }
  }, []);

  const fetchPluginDrift = useCallback(async () => {
    try {
      const data = await apiFetch<{ plugins: PluginDriftEntry[] }>('/api/system/plugin-versions');
      setPluginDrift(data.plugins.filter(p => p.instances.some(i => i.outdated)));
    } catch {
      // silent
    }
  }, []);

  const fetchInstances = useCallback(async () => {
    try {
      const data = await apiFetch<InstanceData[]>('/api/instances');
      setInstances(data);
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchInstances();
    fetchVersions();
    fetchPluginDrift();
  }, [fetchInstances, fetchVersions, fetchPluginDrift]);

  useSSEAll(useCallback((type: string) => {
    if (type.startsWith('agent.') || type === 'mutation.staged' ||
        type === 'operation.completed' || type === 'operation.failed' ||
        type === 'changeset.discarded' || type === 'draft.updated' || type === 'draft.discarded') {
      fetchInstances();
      fetchVersions();
      fetchPluginDrift();
    }
  }, [fetchInstances, fetchVersions, fetchPluginDrift]));

  // SSE subscription for real-time instance status updates
  useEffect(() => {
    const token = localStorage.getItem('armada_token');
    const url = `/api/events/stream?topics=instance${token ? `&token=${encodeURIComponent(token)}` : ''}`;
    const es = new EventSource(url);
    sseRef.current = es;

    const handleEvent = (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        const instanceId = data.instanceId as string | undefined;
        if (!instanceId) return;

        if (e.type === 'instance.provisioning') {
          const step = data.step as string;
          setProvisionSteps(prev => ({ ...prev, [instanceId]: step }));
          setInstances(prev => prev.map(inst =>
            inst.id === instanceId ? { ...inst, status: 'provisioning' } : inst,
          ));
        } else if (e.type === 'instance.provisioned') {
          setProvisionSteps(prev => {
            const next = { ...prev };
            delete next[instanceId];
            return next;
          });
          fetchInstances();
        } else if (e.type === 'instance.provision_failed') {
          const errorMsg = data.error as string | undefined;
          setProvisionSteps(prev => {
            const next = { ...prev };
            delete next[instanceId];
            return next;
          });
          if (errorMsg) {
            setProvisionErrors(prev => ({ ...prev, [instanceId]: errorMsg }));
          }
          fetchInstances();
        } else if (
          e.type === 'instance.started' ||
          e.type === 'instance.stopped' ||
          e.type === 'instance.restarted'
        ) {
          fetchInstances();
        }
      } catch {
        // ignore parse errors
      }
    };

    es.addEventListener('instance.provisioning', handleEvent as EventListener);
    es.addEventListener('instance.provisioned', handleEvent as EventListener);
    es.addEventListener('instance.provision_failed', handleEvent as EventListener);
    es.addEventListener('instance.started', handleEvent as EventListener);
    es.addEventListener('instance.stopped', handleEvent as EventListener);
    es.addEventListener('instance.restarted', handleEvent as EventListener);

    return () => {
      es.close();
      sseRef.current = null;
    };
  }, [fetchInstances]);

  async function handleAction(instance: InstanceData, action: string) {
    setActionLoading(true);
    try {
      if (action === 'destroy') {
        await apiFetch(`/api/instances/${instance.id}`, { method: 'DELETE' });
        await queryClient.invalidateQueries();
      } else {
        await apiFetch(`/api/instances/${instance.id}/${action}`, { method: 'POST' });
        await queryClient.invalidateQueries();
      }
    } catch {
      // could show error
    } finally {
      setActionLoading(false);
      setConfirmTarget(null);
    }
  }

  async function handleHealthCheck(instance: InstanceData) {
    setHealthChecking(instance.id);
    try {
      const res = await apiFetch<{ status: string; error?: string }>(
        `/api/instances/${instance.id}/health`,
      );
      setHealthResults(prev => ({
        ...prev,
        [instance.id]: { ok: res.status === 'healthy', msg: res.status === 'healthy' ? '✓ Healthy' : `✗ ${res.error || res.status}` },
      }));
    } catch (e: any) {
      setHealthResults(prev => ({
        ...prev,
        [instance.id]: { ok: false, msg: `✗ ${e.message}` },
      }));
    } finally {
      setHealthChecking(null);
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <PageHeader icon={Layers} title="Instances" subtitle="OpenClaw containers hosting your armada agents">
        {canMutate && (
          <Button
            onClick={() => setDialogOpen(true)}
            className="bg-violet-600 hover:bg-violet-700 text-white text-sm px-4 h-9"
          >
            + New Instance
          </Button>
        )}
      </PageHeader>

      {/* Update available banner */}
      {versionInfo?.latest && (() => {
        const outdatedCount = instances.filter(
          i => i.version && isNewerVersion(versionInfo.latest!, i.version)
        ).length;
        if (outdatedCount === 0) return null;
        return (
          <div className="rounded-lg border border-blue-500/30 bg-blue-500/10 px-4 py-3 flex items-center gap-3">
            <span className="text-blue-400 text-lg">ℹ️</span>
            <p className="text-sm text-blue-300">
              OpenClaw <span className="font-mono font-medium">v{versionInfo.latest}</span> is available.{' '}
              {outdatedCount} instance{outdatedCount !== 1 ? 's' : ''} running older versions.
            </p>
          </div>
        );
      })()}

      {/* Plugin drift banner */}
      {pluginDrift.length > 0 && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className="text-amber-400 text-lg">⚠️</span>
            <p className="text-sm font-medium text-amber-300">Plugin drift detected</p>
          </div>
          {pluginDrift.map(plugin => (
            plugin.instances.filter(i => i.outdated).map(inst => (
              <p key={`${plugin.name}-${inst.name}`} className="text-xs text-amber-400/80 ml-7">
                <span className="font-mono">{plugin.name}</span>{' '}
                (v{inst.installedVersion} → v{plugin.libraryVersion}) on{' '}
                <span className="font-medium">{inst.name}</span>
              </p>
            ))
          ))}
        </div>
      )}

      {/* Loading */}
      {loading && <CardGrid loading skeletonCount={3} />}

      {/* Empty state */}
      {!loading && instances.length === 0 && (
        <EmptyState
          icon={Layers}
          title="No instances yet"
          description="Create an instance to start hosting agents"
          action={canMutate ? { label: '+ New Instance', onClick: () => setDialogOpen(true) } : undefined}
        />
      )}

      {/* Instance grid */}
      {!loading && instances.length > 0 && (
        <CardGrid>
          {instances.map((instance) => (
            <InstanceCard
              key={instance.id}
              instance={instance}
              health={healthResults[instance.id]}
              healthChecking={healthChecking === instance.id}
              provisionSteps={provisionSteps}
              provisionErrors={provisionErrors}
              canMutate={canMutate}
              onNavigate={() => navigate(`/instances/${instance.id}`)}
              onStart={() => handleAction(instance, 'start')}
              onStop={() => handleAction(instance, 'stop')}
              onRestart={() => handleAction(instance, 'restart')}
              onHealthCheck={() => handleHealthCheck(instance)}
              onDestroy={() => setConfirmTarget({ instance, action: 'destroy' })}
            />
          ))}
        </CardGrid>
      )}

      {/* Dialogs */}
      <InstanceDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onSaved={fetchInstances}
      />

      <ConfirmDialog
        open={!!confirmTarget}
        title="Destroy Instance"
        message={
          confirmTarget
            ? confirmTarget.instance.agentCount > 0
              ? `"${confirmTarget.instance.name}" has ${confirmTarget.instance.agentCount} agent(s). Destroying will stop all agents in this instance.`
              : `Destroy instance "${confirmTarget.instance.name}"? This cannot be undone.`
            : ''
        }
        confirmLabel="Destroy"
        destructive
        loading={actionLoading}
        onConfirm={() => confirmTarget && handleAction(confirmTarget.instance, confirmTarget.action)}
        onCancel={() => setConfirmTarget(null)}
      />
    </div>
  );
}
