import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Loader2, Palette, Hand, Bot, RefreshCw, Trash2, MessageSquare, Settings2 } from 'lucide-react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../hooks/useApi';
import { useAgent } from '../hooks/queries/useAgents';
import ConfirmDialog from '../components/ConfirmDialog';
import { PageHeader } from '../components/PageHeader';
import type { ReactNode } from 'react';
import AgentAvatar from '../components/AgentAvatar';
import type { Agent, HeartbeatMeta } from '@coderage-labs/armada-shared';
import { PendingBadge } from '../components/PendingBadge';
import { usePendingStyle, PendingFields } from '../hooks/usePendingStyle';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Switch } from '../components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../components/ui/responsive-dialog';
import SessionView from '../components/SessionView';
import { useSSEEvent } from '../providers/SSEProvider';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../components/ui/tabs';
import { Table, TableHeader, TableBody, TableHead, TableRow, TableCell } from '../components/ui/table';

interface ConfigDiff {
  key: string;
  expected: any;
  actual: any;
}

interface AgentDrift {
  name: string;
  agentId: string;
  containerId: string;
  diffs: {
    config: ConfigDiff[];
    skills: { missing: string[]; extra: string[] };
    files: { changed: string[] };
  };
}

type AgentWithPending = Agent & {
  pendingAction?: string | null;
  pendingFields?: PendingFields | null;
};

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

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
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

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    running: 'border-emerald-500/30 bg-emerald-500/20 text-emerald-400',
    stopped: 'border-zinc-500/30 bg-zinc-500/20 text-zinc-400',
    starting: 'border-yellow-500/30 bg-yellow-500/20 text-yellow-400',
    error: 'border-red-500/30 bg-red-500/20 text-red-400',
  };
  return (
    <span className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-sm font-medium ${styles[status] ?? styles.stopped}`}>
      <span className={`h-2.5 w-2.5 rounded-full ${
        status === 'running' ? 'bg-emerald-400' : status === 'error' ? 'bg-red-400' : status === 'starting' ? 'bg-yellow-400' : 'bg-zinc-500'
      }`} />
      {status}
    </span>
  );
}

export default function AgentDetail() {
  const { name } = useParams<{ name: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: agentQueryData, isLoading: agentQueryLoading, refetch: refetchAgent } = useAgent(name ?? '');
  const agent: AgentWithPending | null = (agentQueryData as AgentWithPending) ?? null;
  const loading = agentQueryLoading;
  const [error, setError] = useState('');
  const [confirmAction, setConfirmAction] = useState<string | null>(null);
  const [deleteWorkspaceNow, setDeleteWorkspaceNow] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [drift, setDrift] = useState<AgentDrift | null | undefined>(undefined); // undefined = loading, null = no drift
  const [driftLoading, setDriftLoading] = useState(false);
  const [syncLoading, setSyncLoading] = useState(false);
  const [nudgeLoading, setNudgeLoading] = useState(false);

  const [avatarLoading, setAvatarLoading] = useState(false);

  // Init avatar loading state from server-persisted flag (survives page reload)
  useEffect(() => {
    if (agent?.avatarGenerating) {
      setAvatarLoading(true);
    }
  }, [agent?.avatarGenerating]);
  const [avatarKey, setAvatarKey] = useState(0);

  // Listen for SSE avatar events to update spinner and refresh image in real-time
  const agentNameRef = useRef(name);
  agentNameRef.current = name;

  useSSEEvent('agent.avatar.generating', useCallback((data: any) => {
    if (data.agentName === agentNameRef.current) setAvatarLoading(true);
  }, []));

  useSSEEvent('agent.avatar.completed', useCallback((data: any) => {
    if (data.agentName === agentNameRef.current) {
      setAvatarLoading(false);
      setAvatarKey(k => k + 1);
    }
  }, []));

  useSSEEvent('agent.avatar.failed', useCallback((data: any) => {
    if (data.agentName === agentNameRef.current) setAvatarLoading(false);
  }, []));

  const [agentProjects, setAgentProjects] = useState<string[]>([]);
  const [allProjects, setAllProjects] = useState<Array<{ id: string; name: string; icon: string | null; archived: boolean }>>([]);
  const [editProjectsOpen, setEditProjectsOpen] = useState(false);
  const [draftProjects, setDraftProjects] = useState<string[]>([]);
  const [projectManagers, setProjectManagers] = useState<Record<string, string>>({});

  const { pf, cardClass: pendingCardClass } = usePendingStyle(agent?.pendingFields, agent?.pendingAction);

  const fetchAgent = useCallback(async () => {
    const result = await refetchAgent();
    return result.data as Agent | undefined;
  }, [refetchAgent]);

  const fetchDrift = useCallback(async (templateId: string) => {
    try {
      const data = await apiFetch<{ template: string; agents: AgentDrift[] }>(
        `/api/templates/${templateId}/drift`,
      );
      const agentDrift = data.agents.find((a) => a.name === name);
      if (agentDrift) {
        const hasDiffs =
          agentDrift.diffs.config.length > 0 ||
          agentDrift.diffs.skills.missing.length > 0 ||
          agentDrift.diffs.skills.extra.length > 0 ||
          agentDrift.diffs.files.changed.length > 0;
        setDrift(hasDiffs ? agentDrift : null);
      } else {
        setDrift(null);
      }
    } catch {
      setDrift(null);
    }
  }, [name]);

  const fetchProjects = useCallback(async (templateId: string) => {
    try {
      const template = await apiFetch<{ projects?: string[] }>(
        `/api/templates/${templateId}`,
      );
      setAgentProjects(template.projects ?? []);
    } catch {
      // not critical
    }
  }, []);

  // Trigger drift + projects fetch when agent templateId becomes available
  useEffect(() => {
    if (!agent?.templateId) return;
    fetchDrift(agent.templateId);
    fetchProjects(agent.templateId);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent?.templateId]);

  // Load all projects + project managers on mount
  useEffect(() => {
    (async () => {
      try {
        const projects = await apiFetch<Array<{ id: string; name: string; icon: string | null; archived: boolean }>>('/api/projects');
        setAllProjects(projects);

        // Fetch project managers for manager-warning checks
        try {
          const [agents, hierarchy] = await Promise.all([
            apiFetch<Array<{ name: string; role?: string; templateId?: string }>>('/api/agents'),
            apiFetch<{ roles: Array<{ role: string; tier: number }> }>('/api/hierarchy'),
          ]);
          const roles = hierarchy.roles;
          const templates = await Promise.all(
            [...new Set(agents.filter(a => a.templateId).map(a => a.templateId!))]
              .map(tid => apiFetch<{ id: string; projects?: string[] }>(`/api/templates/${tid}`).catch(() => null))
          );
          const templateMap = new Map<string, string[]>();
          for (const t of templates) {
            if (t) templateMap.set(t.id, t.projects || []);
          }
          const managerRoles = new Set(roles.filter(r => r.tier === 1).map(r => r.role));
          const managers: Record<string, string> = {};
          for (const a of agents) {
            if (a.name === name) continue; // skip current agent
            if (!a.role || !managerRoles.has(a.role) || !a.templateId) continue;
            const projs = templateMap.get(a.templateId) || [];
            for (const p of projs) {
              if (!managers[p]) managers[p] = a.name;
            }
          }
          setProjectManagers(managers);
        } catch { /* not critical */ }
      } catch { /* not critical */ }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name]);

  async function handleSaveProjects() {
    if (!agent?.templateId) return;
    try {
      await apiFetch(`/api/templates/${agent.templateId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projects: draftProjects }),
      });
      setAgentProjects(draftProjects);
      setEditProjectsOpen(false);
    } catch (err: any) {
      console.error('Failed to save projects:', err);
    }
  }

  async function handleNudge() {
    if (!name) return;
    setNudgeLoading(true);
    try {
      const data = await apiFetch<{ status: string; response?: string | null; error?: string; duration?: number }>(
        `/api/agents/${name}/nudge`,
        { method: 'POST' },
      );
      if (data.status === 'ok' && data.response) {
        const truncated = data.response.length > 200 ? data.response.slice(0, 200) + '…' : data.response;
        toast.success(truncated);
      } else if (data.status === 'timeout') {
        toast.warning(`Agent didn't respond within 30s`);
      } else {
        toast.error(data.error || 'Nudge failed');
      }
    } catch (err: any) {
      toast.error(err.message || 'Nudge request failed');
    } finally {
      setNudgeLoading(false);
    }
  }


  function handleRegenerateAvatar() {
    setConfirmAction('avatar');
  }

  async function doRegenerateAvatar() {
    if (!name) return;
    setAvatarLoading(true);
    try {
      await apiFetch<{ status: string }>(`/api/agents/${name}/avatar/generate`, { method: 'POST' });
      toast.success('Generating avatar…');
      // SSE agent.updated handles completion — no polling needed
    } catch (err: any) {
      setAvatarLoading(false);
      if (err.message?.includes('already in progress')) {
        toast.warning('Avatar generation already in progress');
      } else {
        toast.error(err.message || 'Avatar generation failed');
      }
    }
  }

  async function handleAction(action: string) {
    if (!name) return;
    setActionLoading(true);
    try {
      if (action === 'delete') {
        const qs = deleteWorkspaceNow ? '?deleteWorkspace=true' : '';
        await apiFetch(`/api/agents/${name}${qs}`, { method: 'DELETE' });
        queryClient.invalidateQueries();
        navigate('/agents');
        return;
      }
      await apiFetch(`/api/agents/${name}/${action}`, { method: 'POST' });
      const data = await fetchAgent();
      if (data?.templateId) fetchDrift(data.templateId);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setActionLoading(false);
      setConfirmAction(null);
    }
  }

  async function handleSync() {
    if (!agent?.templateId) return;
    setSyncLoading(true);
    try {
      await apiFetch(`/api/templates/${agent.templateId}/sync`, {
        method: 'POST',
        body: JSON.stringify({ agents: [agent.name] }),
      });
      setDrift(null);
      await fetchAgent();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSyncLoading(false);
    }
  }

  if (loading) {
    return <div className="py-12 text-center text-zinc-500">Loading…</div>;
  }

  if (error && !agent) {
    return (
      <div className="py-12 text-center">
        <p className="text-red-400">{error}</p>
        <Button variant="ghost" onClick={() => navigate('/agents')} className="mt-4 text-sm text-purple-400 hover:underline">
          ← Back to Agents
        </Button>
      </div>
    );
  }

  if (!agent) return null;

  return (
    <div className="space-y-6">
      {/* Back link */}
      <Button variant="ghost" onClick={() => navigate('/agents')} className="text-zinc-400 hover:text-zinc-100 text-sm flex items-center gap-1">
        <ArrowLeft className="w-4 h-4" />
        Back
      </Button>

      {/* Header */}
      <PageHeader icon={Bot} title={agent.name}>
        {agent.pendingAction && (
          <PendingBadge action={agent.pendingAction as 'create' | 'update' | 'delete'} />
        )}
        <>
          <ActionBtn
            label={avatarLoading ? 'Generating…' : <><Palette className="w-4 h-4" /> Avatar</>}
            onClick={handleRegenerateAvatar}
            disabled={avatarLoading}
          />
          {agent.status === 'running' && (
            <ActionBtn
              label={nudgeLoading ? 'Nudging…' : <><Hand className="w-4 h-4" /> Nudge</>}
              onClick={handleNudge}
              disabled={nudgeLoading}
            />
          )}
          <ActionBtn label={<><RefreshCw className="w-4 h-4" /> Redeploy</>} onClick={() => setConfirmAction('redeploy')} />
        </>
        <ActionBtn label={<><Trash2 className="w-4 h-4" /> Delete</>} destructive onClick={() => setConfirmAction('delete')} />
      </PageHeader>

      {/* Agent status info */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3">
        <div className="flex items-center gap-3">
          <AgentAvatar name={agent.name} size="lg" healthStatus={agent.healthStatus ?? 'unknown'} version={avatarKey} generating={avatarLoading} />
          <h2 className="text-xl font-semibold text-zinc-100 sm:hidden">{agent.name}</h2>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={agent.status} />
          <HealthBadge status={agent.healthStatus ?? 'unknown'} />
          {agent.instanceName && (
            <Link
              to={`/instances/${agent.instanceId}`}
              className="inline-flex items-center gap-1 rounded-full border border-zinc-700 bg-zinc-900/50 px-2.5 py-0.5 text-xs text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700/50 transition"
            >
              {agent.instanceName}
            </Link>
          )}
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-400">{error}</div>
      )}

      {/* Tabs */}
      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview" className="flex items-center gap-2">
            <Settings2 className="w-4 h-4" />
            Overview
          </TabsTrigger>
          <TabsTrigger value="session" className="flex items-center gap-2">
            <MessageSquare className="w-4 h-4" />
            Session
          </TabsTrigger>
        </TabsList>

        <TabsContent value="session">
          <SessionView agentName={agent.name} />
        </TabsContent>

        <TabsContent value="overview"><>

      {/* Health */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-5">
        <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider mb-3">Health</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard
            label="Health Status"
            value={agent.healthStatus ?? 'unknown'}
          />
          <StatCard
            label="Last Heartbeat"
            value={agent.lastHeartbeat ? timeAgo(agent.lastHeartbeat) : 'never'}
          />
          {agent.heartbeatMeta?.taskCount !== undefined && (
            <StatCard label="Active Tasks" value={String(agent.heartbeatMeta.taskCount)} />
          )}
          {agent.heartbeatMeta?.memoryMb !== undefined && (
            <StatCard label="Agent Memory" value={`${agent.heartbeatMeta.memoryMb.toFixed(0)} MB`} />
          )}
          {agent.heartbeatMeta?.uptime !== undefined && (
            <StatCard label="Agent Uptime" value={formatUptime(Math.floor(agent.heartbeatMeta.uptime as number))} />
          )}
        </div>
      </div>

      {/* Plugin & Skill Versions */}
      {(agent.heartbeatMeta?.pluginVersions || agent.heartbeatMeta?.skillVersions) && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-5">
          <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider mb-3">Installed Versions</h2>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {agent.heartbeatMeta?.pluginVersions && Object.keys(agent.heartbeatMeta.pluginVersions).length > 0 && (
              <div>
                <h3 className="text-xs font-medium text-zinc-500 uppercase tracking-wider mb-2">Plugins</h3>
                <div className="flex flex-wrap gap-2">
                  {Object.entries(agent.heartbeatMeta.pluginVersions as Record<string, string>).sort(([a], [b]) => a.localeCompare(b)).map(([name, version]) => (
                    <span
                      key={name}
                      className="inline-flex items-center gap-1.5 rounded-full border border-zinc-700 bg-zinc-900/50 px-3 py-1 text-xs"
                    >
                      <span className="text-zinc-300">{name}</span>
                      <span className="font-mono text-violet-400">{version}</span>
                    </span>
                  ))}
                </div>
              </div>
            )}
            {agent.heartbeatMeta?.skillVersions && Object.keys(agent.heartbeatMeta.skillVersions).length > 0 && (
              <div>
                <h3 className="text-xs font-medium text-zinc-500 uppercase tracking-wider mb-2">Skills</h3>
                <div className="flex flex-wrap gap-2">
                  {Object.entries(agent.heartbeatMeta.skillVersions as Record<string, string>).sort(([a], [b]) => a.localeCompare(b)).map(([name, version]) => (
                    <span
                      key={name}
                      className="inline-flex items-center gap-1.5 rounded-full border border-zinc-700 bg-zinc-900/50 px-3 py-1 text-xs"
                    >
                      <span className="text-zinc-300">{name}</span>
                      <span className={`font-mono ${version === 'installed' ? 'text-zinc-500' : 'text-emerald-400'}`}>{version}</span>
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Config */}
      <div className={`rounded-lg border border-zinc-800 bg-zinc-900/50 p-5 ${pendingCardClass}`}>
        <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider mb-3">Configuration</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-2 text-sm">
          <ConfigRow label="Model" value={agent.model} mono valueClassName={pf('model', 'text-zinc-300 font-mono text-xs')} />
          <ConfigRow label="Role" value={agent.role} valueClassName={pf('role', 'text-zinc-300')} />
          <ConfigRow label="Skills" value={agent.skills || '—'} valueClassName={pf('skills', 'text-zinc-300')} />
          <div className="sm:col-span-2">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-zinc-500 text-xs uppercase tracking-wider">Projects</span>
              <Button variant="ghost" onClick={() => { setDraftProjects([...agentProjects]); setEditProjectsOpen(true); }} className="text-[10px] text-violet-400 hover:text-violet-300 cursor-pointer">edit</Button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {agentProjects.length > 0 ? agentProjects.map(p => (
                <Badge key={p} className="bg-violet-500/10 text-violet-300 border-violet-500/10">
                  {allProjects.find(ap => ap.name === p)?.icon || '📁'} {p}
                </Badge>
              )) : <span className="text-zinc-600 text-xs">No projects</span>}
            </div>
          </div>
          <ConfigRow label="Template" value={agent.templateId} mono />
          {agent.instanceName && (
            <div className="flex justify-between py-1 border-b border-zinc-800">
              <span className="text-zinc-500">Instance</span>
              <Link to={`/instances/${agent.instanceId}`} className="text-zinc-300 text-xs hover:text-zinc-100 transition">
                {agent.instanceName}
              </Link>
            </div>
          )}
          <ConfigRow label="Created" value={new Date(agent.createdAt).toLocaleString()} />
        </div>
      </div>

      {/* Template Drift */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-5">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider">Template Drift</h2>
          {drift !== undefined && drift !== null && (
            <Button
              variant="ghost" onClick={handleSync}
              disabled={syncLoading}
              className="rounded-lg border border-purple-500/30 px-3 py-1 text-xs text-purple-400 hover:bg-purple-500/10 transition disabled:opacity-50"
            >
              {syncLoading ? 'Syncing…' : 'Sync'}
            </Button>
          )}
        </div>
        {drift === undefined ? (
          <p className="text-sm text-zinc-500">Checking…</p>
        ) : drift === null ? (
          <p className="text-sm text-emerald-400">In sync ✓</p>
        ) : (
          <div className="space-y-3">
            {drift.diffs.config.length > 0 && (
              <Table className="text-sm">
                <TableHeader>
                  <TableRow className="text-left text-zinc-500 text-xs uppercase tracking-wider">
                    <TableHead className="pb-2 pr-4">Key</TableHead>
                    <TableHead className="pb-2 pr-4">Expected</TableHead>
                    <TableHead className="pb-2">Actual</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {drift.diffs.config.map((d) => (
                    <TableRow key={d.key} className="border-t border-zinc-800">
                      <TableCell className="py-1.5 pr-4 font-mono text-xs text-zinc-300">{d.key}</TableCell>
                      <TableCell className="py-1.5 pr-4 font-mono text-xs text-emerald-400/70">
                        {typeof d.expected === 'object' ? JSON.stringify(d.expected) : String(d.expected)}
                      </TableCell>
                      <TableCell className="py-1.5 font-mono text-xs text-red-400/70">
                        {typeof d.actual === 'object' ? JSON.stringify(d.actual) : String(d.actual)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            {(drift.diffs.skills.missing.length > 0 || drift.diffs.skills.extra.length > 0) && (
              <div className="text-sm text-zinc-400">
                {drift.diffs.skills.missing.length > 0 && (
                  <p>Missing skills: <span className="text-yellow-400">{drift.diffs.skills.missing.join(', ')}</span></p>
                )}
                {drift.diffs.skills.extra.length > 0 && (
                  <p>Extra skills: <span className="text-yellow-400">{drift.diffs.skills.extra.join(', ')}</span></p>
                )}
              </div>
            )}
            {drift.diffs.files.changed.length > 0 && (
              <p className="text-sm text-zinc-400">
                Changed files: <span className="text-yellow-400">{drift.diffs.files.changed.join(', ')}</span>
              </p>
            )}
          </div>
        )}
      </div>

      {/* end overview tab */}
      </>
        </TabsContent>
      </Tabs>

      {/* Edit Projects dialog */}
      <Dialog open={editProjectsOpen} onOpenChange={(open) => { if (!open) setEditProjectsOpen(false); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Edit Projects</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              {draftProjects.map(p => (
                <Badge key={p} className="bg-violet-500/20 text-violet-300 border-violet-500/20">
                  {allProjects.find(ap => ap.name === p)?.icon || '📁'} {p}
                  <Button variant="ghost" onClick={() => setDraftProjects(draftProjects.filter(x => x !== p))} className="ml-1 text-violet-400 hover:text-red-400 cursor-pointer">×</Button>
                </Badge>
              ))}
            </div>
            <Select
              onValueChange={(val) => {
                if (val && !draftProjects.includes(val)) {
                  setDraftProjects([...draftProjects, val]);
                }
              }}
            >
              <SelectTrigger className="w-full text-xs">
                <SelectValue placeholder="+ Add project" />
              </SelectTrigger>
              <SelectContent>
                {allProjects.filter(p => !p.archived && !draftProjects.includes(p.name)).map(p => (
                  <SelectItem key={p.id} value={p.name}>{p.icon || '📁'} {p.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {/* Manager conflict warnings */}
            {agent.role && draftProjects.filter(p => projectManagers[p]).map(p => (
              <div key={p} className="text-[10px] text-amber-400">
                ⚠️ {p} already has a manager: {projectManagers[p]}
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditProjectsOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleSaveProjects}
              className="bg-violet-600 hover:bg-violet-700 text-white"
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!confirmAction}
        title={
          confirmAction === 'delete' ? 'Delete Agent'
          : confirmAction === 'redeploy' ? 'Redeploy Agent'
          : confirmAction === 'avatar' ? 'Regenerate Avatar'
          : 'Confirm'
        }
        message={
          confirmAction === 'delete'
            ? `Are you sure you want to delete agent "${agent.name}"? This cannot be undone.`
            : confirmAction === 'redeploy'
              ? `Redeploy will regenerate config, SOUL.md, and AGENTS.md from the template, then restart "${agent.name}". Continue?`
              : confirmAction === 'avatar'
                ? `Generate a new AI avatar for "${agent.name}"? This will replace the current avatar and costs ~$0.02.`
                : `Are you sure you want to ${confirmAction} agent "${agent.name}"?`
        }
        confirmLabel={confirmAction === 'avatar' ? 'Generate' : confirmAction === 'delete' ? 'Delete' : confirmAction === 'redeploy' ? 'Redeploy' : 'Confirm'}
        destructive={confirmAction === 'delete'}
        loading={confirmAction === 'avatar' ? avatarLoading : actionLoading}
        onConfirm={() => {
          if (confirmAction === 'avatar') {
            doRegenerateAvatar();
            setConfirmAction(null);
          } else if (confirmAction) {
            handleAction(confirmAction);
          }
        }}
        onCancel={() => {
          setConfirmAction(null);
          setDeleteWorkspaceNow(false);
        }}
      >
        {confirmAction === 'delete' && (
          <label className="flex flex-col gap-1 cursor-pointer select-none">
            <div className="flex items-center gap-2">
              <Switch
                checked={deleteWorkspaceNow}
                onCheckedChange={setDeleteWorkspaceNow}
                className="data-[state=checked]:bg-red-500"
              />
              <span className="text-sm text-zinc-300">Also delete workspace data immediately</span>
            </div>
            <p className="ml-6 text-xs text-zinc-500">
              If unchecked, workspace data will be automatically cleaned after the retention period.
            </p>
          </label>
        )}
      </ConfirmDialog>
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
      <span className={valueClassName ?? `text-zinc-300 ${mono ? 'font-mono text-xs' : ''}`}>{value}</span>
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
