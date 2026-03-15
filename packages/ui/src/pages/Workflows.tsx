import { useEffect, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiFetch } from '../hooks/useApi';
import { useAuth } from '../hooks/useAuth';
import { useSSEAll } from '../providers/SSEProvider';
import { Workflow as WorkflowIcon, Plus, Power, PowerOff, Layers, Play, Pencil } from 'lucide-react';
import { PageHeader } from '../components/PageHeader';
import { Checkbox } from '../components/ui/checkbox';
import type { Workflow, WorkflowStep } from '@coderage-labs/armada-shared';
import { EmptyState } from '../components/EmptyState';
import { CardGrid, BaseCard } from '../components/shared';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Input } from '../components/ui/input';
import { Textarea } from '../components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../components/ui/responsive-dialog';

/* ── Types ─────────────────────────────────────────── */

interface Project {
  id: string;
  name: string;
  color: string;
  icon: string | null;
}

/** Runtime workflow shape — API now returns projectIds[] */
type WorkflowWithProjects = Omit<Workflow, 'projectId'> & {
  projectId?: string;
  projectIds?: string[];
};

/* ── Create Workflow Dialog ────────────────────────── */

function CreateWorkflowDialog({
  projects,
  onCreated,
  onCancel,
}: {
  projects: Project[];
  onCreated: (w: WorkflowWithProjects) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [selectedProjectIds, setSelectedProjectIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggleProject(pid: string) {
    setSelectedProjectIds((prev) =>
      prev.includes(pid) ? prev.filter((id) => id !== pid) : [...prev, pid],
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const wf = await apiFetch<WorkflowWithProjects>('/api/workflows', {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim(),
          description,
          projectIds: selectedProjectIds,
          steps: [],
        }),
      });
      onCreated(wf);
    } catch (err: any) {
      setError(err.message || 'Failed to create workflow');
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(isOpen) => !isOpen && onCancel()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create Workflow</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
              {error}
            </div>
          )}

          <div>
            <label className="block text-xs text-zinc-500 uppercase tracking-wider mb-1">Name</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-workflow"
              className="w-full rounded-lg border border-zinc-700 bg-zinc-800/50 px-3 py-2 text-sm text-zinc-200 placeholder-gray-600 focus:outline-none focus:border-violet-500/50"
            />
          </div>

          <div>
            <label className="block text-xs text-zinc-500 uppercase tracking-wider mb-1">Description</label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What does this workflow do?"
              rows={2}
              className="w-full rounded-lg border border-zinc-700 bg-zinc-800/50 px-3 py-2 text-sm text-zinc-200 placeholder-gray-600 focus:outline-none focus:border-violet-500/50 resize-none"
            />
          </div>

          <div>
            <label className="block text-xs text-zinc-500 uppercase tracking-wider mb-1">Projects</label>
            {projects.length === 0 ? (
              <p className="text-xs text-zinc-600">No projects available</p>
            ) : (
              <div className="rounded-lg border border-zinc-700 bg-zinc-800/50 p-2 space-y-1 max-h-40 overflow-y-auto">
                {projects.map((p) => (
                  <Checkbox
                    key={p.id}
                    checked={selectedProjectIds.includes(p.id)}
                    onChange={() => toggleProject(p.id)}
                    className="px-1 py-0.5 rounded hover:bg-zinc-800/50"
                  >
                    <span className="flex items-center gap-2 text-sm text-zinc-300">
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: p.color }} />
                      {p.icon || '📁'} {p.name}
                    </span>
                  </Checkbox>
                ))}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button
              variant="ghost" type="button"
              onClick={onCancel}
              className="rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-700/50 transition"
            >
              Cancel
            </Button>
            <Button
              variant="ghost" type="submit"
              disabled={saving || !name.trim()}
              className="rounded-lg border border-violet-500/30 bg-violet-500/20 px-4 py-2 text-sm font-medium text-violet-300 hover:bg-violet-500/30 transition disabled:opacity-50"
            >
              {saving ? 'Creating…' : 'Create'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ── Workflow Card ─────────────────────────────────── */

function WorkflowCard({
  workflow,
  projectMap,
  onNavigate,
  onToggle,
  onRun,
}: {
  workflow: WorkflowWithProjects;
  projectMap: Map<string, Project>;
  onNavigate: () => void;
  onToggle: (id: string, enabled: boolean) => void;
  onRun: (id: string) => void;
}) {
  // Resolve project IDs — support both old projectId and new projectIds
  const pids = workflow.projectIds?.length
    ? workflow.projectIds
    : workflow.projectId
      ? [workflow.projectId]
      : [];

  // Accent bar color based on enabled status
  const accentColor = workflow.enabled ? 'bg-emerald-500' : 'bg-zinc-600';

  return (
    <BaseCard
      onClick={onNavigate}
      accentColor={accentColor}
      footer={
        <>
          <Button
            variant="outline"
            size="sm"
            onClick={onNavigate}
            className="flex-1 text-xs h-8 gap-1.5 border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50"
          >
            <Pencil className="w-3 h-3" /> Edit
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onRun(workflow.id)}
            className="flex-1 text-xs h-8 gap-1.5 border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50"
          >
            <Play className="w-3 h-3" /> Run
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onToggle(workflow.id, !workflow.enabled)}
            className={`flex-1 text-xs h-8 gap-1.5 ${
              workflow.enabled
                ? 'border-emerald-500/20 text-emerald-400/70 hover:text-emerald-400 hover:bg-emerald-500/10 hover:border-emerald-500/40'
                : 'border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50'
            }`}
            title={workflow.enabled ? 'Disable workflow' : 'Enable workflow'}
          >
            {workflow.enabled ? (
              <><PowerOff className="w-3 h-3" /> Disable</>
            ) : (
              <><Power className="w-3 h-3" /> Enable</>
            )}
          </Button>
        </>
      }
    >
      {/* Header */}
      <div className="p-5 pb-0">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <WorkflowIcon className="w-4 h-4 text-violet-400 shrink-0" />
              <h3 className="text-base font-semibold text-zinc-100 truncate">{workflow.name}</h3>
            </div>
            <div className="flex items-center gap-2 mt-1">
              <span
                className={`inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-md ${
                  workflow.enabled
                    ? 'bg-emerald-500/10 text-emerald-400'
                    : 'bg-zinc-700/50 text-zinc-500'
                }`}
              >
                {workflow.enabled ? (
                  <Power className="w-3 h-3" />
                ) : (
                  <PowerOff className="w-3 h-3" />
                )}
                {workflow.enabled ? 'Enabled' : 'Disabled'}
              </span>
              <span className="flex items-center gap-1 text-[11px] text-zinc-500">
                <Layers className="w-3 h-3" />
                {workflow.steps.length} step{workflow.steps.length !== 1 ? 's' : ''}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Details */}
      <div className="p-5 pt-4 space-y-2.5 flex-1">
        {workflow.description && (
          <p className="text-xs text-zinc-500 line-clamp-2">{workflow.description}</p>
        )}

        {/* Projects */}
        <div>
          <span className="text-xs text-zinc-500 block mb-1">Projects</span>
          <div className="flex items-center gap-1.5 flex-wrap">
            {pids.length === 0 ? (
              <span className="text-zinc-600 text-[11px]">No project</span>
            ) : (
              pids.map((pid) => {
                const proj = projectMap.get(pid);
                const color = proj?.color || '#6b7280';
                return (
                  <span
                    key={pid}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] text-zinc-300"
                    style={{ backgroundColor: color + '20' }}
                  >
                    <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: color }} />
                    {proj?.icon || '📁'} {proj?.name || pid}
                  </span>
                );
              })
            )}
          </div>
        </div>
      </div>
    </BaseCard>
  );
}

/* ── Main Page ─────────────────────────────────────── */

export default function Workflows() {
  const navigate = useNavigate();
  const { user: authUser, hasScope } = useAuth();
  const canMutate = hasScope('workflows:write');
  const [workflows, setWorkflows] = useState<WorkflowWithProjects[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [filterProject, setFilterProject] = useState<string>('');

  async function load() {
    try {
      const [wfs, projs] = await Promise.all([
        apiFetch<WorkflowWithProjects[]>('/api/workflows'),
        apiFetch<Project[]>('/api/projects'),
      ]);
      setWorkflows(wfs);
      setProjects(projs);
    } catch (err) {
      console.error('Failed to load workflows:', err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  // SSE handled by react-query invalidation in SSEProvider

  const projectMap = useMemo(() => {
    const m = new Map<string, Project>();
    for (const p of projects) {
      m.set(p.id, p);
      m.set(p.name, p);
    }
    return m;
  }, [projects]);

  const filtered = useMemo(() => {
    if (!filterProject) return workflows;
    return workflows.filter((w) => {
      const pids = w.projectIds?.length ? w.projectIds : w.projectId ? [w.projectId] : [];
      return pids.includes(filterProject);
    });
  }, [workflows, filterProject]);

  async function handleToggle(id: string, enabled: boolean) {
    try {
      await apiFetch(`/api/workflows/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ enabled }),
      });
      setWorkflows((prev) =>
        prev.map((w) => (w.id === id ? { ...w, enabled } : w)),
      );
    } catch (err) {
      console.error('Failed to toggle workflow:', err);
    }
  }

  async function handleRun(id: string) {
    try {
      await apiFetch(`/api/workflows/${id}/run`, { method: 'POST' });
    } catch (err) {
      console.error('Failed to run workflow:', err);
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <PageHeader icon={WorkflowIcon} title="Workflows" subtitle="Automate agent task pipelines">
        <Badge variant="secondary" className="text-zinc-500 font-mono bg-zinc-800/50">
          {filtered.length}
        </Badge>
        {projects.length > 1 && (
          <Select value={filterProject || 'all'} onValueChange={(v) => setFilterProject(v === 'all' ? '' : v)}>
            <SelectTrigger className="w-44 rounded-lg border border-zinc-800 bg-zinc-900/50 px-3 py-2 text-sm text-zinc-300 focus:border-violet-500 focus:outline-none transition-colors h-9">
              <SelectValue placeholder="All projects" />
            </SelectTrigger>
            <SelectContent className="bg-zinc-900">
              <SelectItem value="all">All projects</SelectItem>
              {projects.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.icon || '📁'} {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {canMutate && (
          <Button
            onClick={() => setShowCreate(true)}
            className="bg-violet-600 hover:bg-violet-700 text-white text-sm px-4 h-9"
          >
            <Plus className="w-4 h-4 mr-1" />
            New Workflow
          </Button>
        )}
      </PageHeader>

      {/* Loading */}
      {loading && <CardGrid loading skeletonCount={3} />}

      {/* Empty state */}
      {!loading && filtered.length === 0 && (
        <EmptyState
          icon={WorkflowIcon}
          title="No workflows yet"
          description="Create a workflow to automate your agent task pipelines"
          action={canMutate ? { label: 'New Workflow', onClick: () => setShowCreate(true) } : undefined}
        />
      )}

      {/* Grid */}
      {!loading && filtered.length > 0 && (
        <CardGrid>
          {filtered.map((wf) => (
            <WorkflowCard
              key={wf.id}
              workflow={wf}
              projectMap={projectMap}
              onNavigate={() => navigate(`/workflows/${wf.id}`)}
              onToggle={handleToggle}
              onRun={handleRun}
            />
          ))}
        </CardGrid>
      )}

      {/* Create Dialog */}
      {showCreate && (
        <CreateWorkflowDialog
          projects={projects}
          onCreated={(wf) => {
            setWorkflows((prev) => [wf, ...prev]);
            setShowCreate(false);
            navigate(`/workflows/${wf.id}`);
          }}
          onCancel={() => setShowCreate(false)}
        />
      )}
    </div>
  );
}
