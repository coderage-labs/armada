import { useEffect, useState, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiFetch } from '../hooks/useApi';
import { useAuth } from '../hooks/useAuth';
import { useSSEAll } from '../providers/SSEProvider';
import EmojiPickerButton from '../components/EmojiPickerButton';
import {
  FolderKanban, X, Package, ChevronDown, ChevronRight,
  Pencil, Archive, ArchiveRestore,
} from 'lucide-react';
import { PageHeader } from '../components/PageHeader';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { EmptyState } from '../components/EmptyState';
import { CardGrid, BaseCard } from '../components/shared';
import { Input } from '../components/ui/input';
import { Textarea } from '../components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../components/ui/responsive-dialog';

/* ── Types ─────────────────────────────────────────── */

interface ProjectRepository {
  url: string;
  defaultBranch?: string;
  cloneDir?: string;
}

interface Project {
  id: string;
  name: string;
  description: string;
  contextMd: string;
  color: string;
  icon: string | null;
  archived: boolean;
  configJson: string;
  repositories: ProjectRepository[];
  maxConcurrent: number;
  createdAt: string;
}

interface ArmadaTask {
  id: string;
  fromAgent: string;
  toAgent: string;
  taskText: string;
  status: string;
  projectId?: string;
  createdAt: string;
}

/* ── Helpers ───────────────────────────────────────── */

function truncate(s: string, max: number) {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/* ── Create Project Form ───────────────────────────── */

const COLORS = ['#6b7280', '#ef4444', '#f97316', '#eab308', '#22c55e', '#3b82f6', '#8b5cf6', '#ec4899', '#14b8a6'];

function CreateProjectForm({ onCreated, onCancel }: { onCreated: (p: Project) => void; onCancel: () => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [color, setColor] = useState('#3b82f6');
  const [icon, setIcon] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const project = await apiFetch<Project>('/api/projects', {
        method: 'POST',
        body: JSON.stringify({ name: name.trim(), description, color, icon: icon || undefined }),
      });
      onCreated(project);
    } catch (err: any) {
      setError(err.message || 'Failed to create project');
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="text-[10px] uppercase text-zinc-500 tracking-wider block mb-1">Name</label>
          <Input
            value={name}
            onChange={e => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
            placeholder="project-name"
            className="w-full rounded-lg bg-zinc-800/50 border border-zinc-700 text-zinc-200 text-sm px-3 py-2 focus:outline-none focus:border-violet-500/50"
          />
        </div>
        <div>
          <label className="text-[10px] uppercase text-zinc-500 tracking-wider block mb-1">Icon</label>
          <EmojiPickerButton
            value={icon || null}
            onChange={(emoji) => setIcon(emoji || '')}
            placeholder="📋"
            size="sm"
          />
        </div>
      </div>

      <div>
        <label className="text-[10px] uppercase text-zinc-500 tracking-wider block mb-1">Description</label>
        <Input
          value={description}
          onChange={e => setDescription(e.target.value)}
          placeholder="What is this project about?"
          className="w-full rounded-lg bg-zinc-800/50 border border-zinc-700 text-zinc-200 text-sm px-3 py-2 focus:outline-none focus:border-violet-500/50"
        />
      </div>

      <div>
        <label className="text-[10px] uppercase text-zinc-500 tracking-wider block mb-1">Colour</label>
        <div className="flex gap-2 flex-wrap">
          {COLORS.map(c => (
            <Button
              variant="ghost" key={c}
              type="button"
              onClick={() => setColor(c)}
              className={`w-7 h-7 rounded-full transition-transform ${color === c ? 'ring-2 ring-white/50 scale-110' : 'hover:scale-105'}`}
              style={{ backgroundColor: c }}
            />
          ))}
        </div>
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}

      <div className="flex gap-2 justify-end">
        <Button variant="outline" type="button" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="submit"
          disabled={saving || !name.trim()}
          className="bg-violet-600 hover:bg-violet-700 text-white text-sm px-4 h-9 disabled:opacity-40"
        >
          {saving ? 'Creating…' : 'Create'}
        </Button>
      </div>
    </form>
  );
}

/* ── Project Detail Panel ──────────────────────────── */

function ProjectDetailPanel({
  project,
  onClose,
  onUpdated,
  onArchiveToggle,
}: {
  project: Project;
  onClose: () => void;
  onUpdated: (p: Project) => void;
  onArchiveToggle: (p: Project) => void;
}) {
  const [contextMd, setContextMd] = useState(project.contextMd);
  const [repos, setRepos] = useState<ProjectRepository[]>(project.repositories || []);
  const [showAddRepo, setShowAddRepo] = useState(false);
  const [newRepoUrl, setNewRepoUrl] = useState('');
  const [newRepoBranch, setNewRepoBranch] = useState('');
  const [newRepoDir, setNewRepoDir] = useState('');
  const [repoSaving, setRepoSaving] = useState(false);
  const [members, setMembers] = useState<string[]>([]);
  const [tasks, setTasks] = useState<ArmadaTask[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [wipLimit, setWipLimit] = useState(project.maxConcurrent || 3);
  const [wipSaving, setWipSaving] = useState(false);

  useEffect(() => {
    setContextMd(project.contextMd);
    setRepos(project.repositories || []);
    setWipLimit(project.maxConcurrent || 3);
    setSaved(false);
    apiFetch<{ members: string[] }>(`/api/projects/${project.id}/members`).then(d => setMembers(d.members)).catch(() => {});
    apiFetch<ArmadaTask[]>(`/api/tasks?limit=20`).then(all => {
      setTasks(all.filter(t => t.projectId === project.name || t.projectId === project.id));
    }).catch(() => {});
  }, [project.id]);

  async function handleSaveContext() {
    setSaving(true);
    try {
      const updated = await apiFetch<Project>(`/api/projects/${project.id}`, {
        method: 'PUT',
        body: JSON.stringify({ context_md: contextMd }),
      });
      onUpdated(updated);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch { /* ignore */ }
    setSaving(false);
  }

  async function saveRepos(newRepos: ProjectRepository[]) {
    setRepoSaving(true);
    try {
      const updated = await apiFetch<Project>(`/api/projects/${project.id}`, {
        method: 'PUT',
        body: JSON.stringify({ repositories: newRepos }),
      });
      setRepos(updated.repositories || []);
      onUpdated(updated);
    } catch { /* ignore */ }
    setRepoSaving(false);
  }

  async function handleAddRepo(e: React.FormEvent) {
    e.preventDefault();
    if (!newRepoUrl.trim()) return;
    const repo: ProjectRepository = { url: newRepoUrl.trim() };
    if (newRepoBranch.trim()) repo.defaultBranch = newRepoBranch.trim();
    if (newRepoDir.trim()) repo.cloneDir = newRepoDir.trim();
    const newRepos = [...repos, repo];
    await saveRepos(newRepos);
    setNewRepoUrl('');
    setNewRepoBranch('');
    setNewRepoDir('');
    setShowAddRepo(false);
  }

  async function handleRemoveRepo(index: number) {
    const newRepos = repos.filter((_, i) => i !== index);
    await saveRepos(newRepos);
  }

  async function handleSaveWipLimit(value: number) {
    const clamped = Math.max(1, Math.min(20, value));
    setWipLimit(clamped);
    setWipSaving(true);
    try {
      const updated = await apiFetch<Project>(`/api/projects/${project.id}`, {
        method: 'PUT',
        body: JSON.stringify({ maxConcurrent: clamped }),
      });
      onUpdated(updated);
    } catch { /* ignore */ }
    setWipSaving(false);
  }

  return (
    <>
      <div className="fixed inset-0 bg-black/50 z-40" onClick={onClose} />
      <div className="fixed inset-y-0 right-0 w-full sm:w-[480px] bg-zinc-900/95 border-l border-zinc-800 shadow-2xl z-50 flex flex-col">
        <div className="flex items-center justify-between p-4 border-b border-zinc-800">
          <div className="flex items-center gap-2">
            <span className="w-3 h-3 rounded-full" style={{ backgroundColor: project.color }} />
            <span className="text-lg">{project.icon || '📁'}</span>
            <h3 className="text-sm font-semibold text-zinc-100">{project.name}</h3>
            {project.archived && (
              <Badge variant="secondary" className="text-[10px] uppercase tracking-wider bg-zinc-500/20 text-zinc-400">
                Archived
              </Badge>
            )}
          </div>
          <Button variant="ghost" onClick={onClose} className="text-zinc-400 hover:text-zinc-200"><X className="w-5 h-5" /></Button>
        </div>

        <div className="flex-1 overflow-auto p-4 space-y-5">
          {/* Description */}
          {project.description && (
            <p className="text-sm text-zinc-400">{project.description}</p>
          )}

          {/* Context Editor */}
          <div>
            <label className="text-[10px] uppercase text-zinc-500 tracking-wider block mb-1.5">
              Project Context (Markdown)
            </label>
            <Textarea
              value={contextMd}
              onChange={e => { setContextMd(e.target.value); setSaved(false); }}
              rows={12}
              className="w-full rounded-lg bg-zinc-800/50 border border-zinc-700 text-zinc-200 text-sm px-3 py-2.5 focus:outline-none focus:border-violet-500/50 resize-y font-mono"
              placeholder="Add project context here. This will be injected into tasks sent with this project tag…"
            />
            <div className="flex items-center gap-2 mt-2">
              <Button
                onClick={handleSaveContext}
                disabled={saving || contextMd === project.contextMd}
                className="bg-violet-600 hover:bg-violet-700 text-white text-xs px-3 h-8 disabled:opacity-40"
              >
                {saving ? 'Saving…' : 'Save Context'}
              </Button>
              {saved && <span className="text-xs text-emerald-400">✓ Saved</span>}
            </div>
          </div>

          {/* Repositories */}
          <div>
            <label className="text-[10px] uppercase text-zinc-500 tracking-wider block mb-1.5">
              <span className="inline-flex items-center gap-1"><Package className="w-3.5 h-3.5" /> Repositories ({repos.length})</span>
            </label>
            {repos.length === 0 && !showAddRepo ? (
              <p className="text-xs text-zinc-600">No repositories linked to this project</p>
            ) : (
              <div className="space-y-1">
                {repos.map((repo, i) => (
                  <div key={i} className="group flex items-center gap-2 text-xs px-2.5 py-2 rounded-lg bg-zinc-900/50 border border-zinc-800">
                    <span className="text-zinc-300 font-mono flex-1">
                      {repo.url.startsWith('http') ? (
                        <a href={repo.url} target="_blank" rel="noopener noreferrer" className="hover:text-violet-300 transition-colors">{repo.url.replace(/^https?:\/\/github\.com\//, '')}</a>
                      ) : (
                        <a href={`https://github.com/${repo.url}`} target="_blank" rel="noopener noreferrer" className="hover:text-violet-300 transition-colors">{repo.url}</a>
                      )}
                    </span>
                    {repo.defaultBranch && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-500/20 border border-blue-500/30 text-blue-300">
                        {repo.defaultBranch}
                      </span>
                    )}
                    {repo.cloneDir && (
                      <span className="text-[10px] text-zinc-600 font-mono">{repo.cloneDir}</span>
                    )}
                    <Button
                      variant="ghost" onClick={() => handleRemoveRepo(i)}
                      disabled={repoSaving}
                      className="opacity-0 group-hover:opacity-100 text-zinc-600 hover:text-red-400 transition-all text-sm"
                      title="Remove repository"
                    >
                      ×
                    </Button>
                  </div>
                ))}
              </div>
            )}

            {showAddRepo ? (
              <form onSubmit={handleAddRepo} className="mt-2 space-y-2 p-2.5 rounded-lg bg-zinc-900/50 border border-zinc-800">
                <Input
                  value={newRepoUrl}
                  onChange={e => setNewRepoUrl(e.target.value)}
                  placeholder="owner/repo or https://github.com/..."
                  className="w-full rounded-lg bg-zinc-800/50 border border-zinc-700 text-zinc-200 text-xs px-2.5 py-1.5 focus:outline-none focus:border-violet-500/50 font-mono"
                  autoFocus
                />
                <div className="grid grid-cols-2 gap-2">
                  <Input
                    value={newRepoBranch}
                    onChange={e => setNewRepoBranch(e.target.value)}
                    placeholder="branch (default: main)"
                    className="rounded-lg bg-zinc-800/50 border border-zinc-700 text-zinc-200 text-xs px-2.5 py-1.5 focus:outline-none focus:border-violet-500/50"
                  />
                  <Input
                    value={newRepoDir}
                    onChange={e => setNewRepoDir(e.target.value)}
                    placeholder="clone dir (optional)"
                    className="rounded-lg bg-zinc-800/50 border border-zinc-700 text-zinc-200 text-xs px-2.5 py-1.5 focus:outline-none focus:border-violet-500/50 font-mono"
                  />
                </div>
                <div className="flex gap-2 justify-end">
                  <Button variant="ghost" type="button" onClick={() => setShowAddRepo(false)} className="px-2 py-1 text-xs text-zinc-500 hover:text-zinc-300">
                    Cancel
                  </Button>
                  <Button
                    type="submit"
                    disabled={!newRepoUrl.trim() || repoSaving}
                    className="bg-violet-600 hover:bg-violet-700 text-white text-xs px-3 h-7 disabled:opacity-40"
                  >
                    {repoSaving ? 'Adding…' : 'Add'}
                  </Button>
                </div>
              </form>
            ) : (
              <Button
                variant="ghost" onClick={() => setShowAddRepo(true)}
                className="mt-2 text-xs text-violet-400 hover:text-violet-300 transition-colors"
              >
                + Add Repository
              </Button>
            )}
          </div>

          {/* WIP Limit */}
          <div>
            <label className="text-[10px] uppercase text-zinc-500 tracking-wider block mb-1.5">
              WIP Limit (Max In Progress)
            </label>
            <div className="flex items-center gap-3">
              <Input
                type="number"
                min={1}
                max={20}
                value={wipLimit}
                onChange={e => setWipLimit(Number(e.target.value) || 3)}
                onBlur={e => handleSaveWipLimit(Number(e.target.value) || 3)}
                className="w-20 rounded-lg bg-zinc-800/50 border border-zinc-700 text-zinc-200 text-sm px-3 py-2 focus:outline-none focus:border-violet-500/50"
              />
              <span className="text-xs text-zinc-500">
                {wipSaving ? 'Saving…' : 'Max concurrent tasks dispatched to the project manager'}
              </span>
            </div>
          </div>

          {/* Members */}
          <div>
            <label className="text-[10px] uppercase text-zinc-500 tracking-wider block mb-1.5">
              Members ({members.length})
            </label>
            {members.length === 0 ? (
              <p className="text-xs text-zinc-600">No agents assigned to this project yet</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {members.map(m => (
                  <Badge key={m} variant="secondary">
                    {m}
                  </Badge>
                ))}
              </div>
            )}
          </div>

          {/* Recent Tasks */}
          <div>
            <label className="text-[10px] uppercase text-zinc-500 tracking-wider block mb-1.5">
              Recent Tasks ({tasks.length})
            </label>
            {tasks.length === 0 ? (
              <p className="text-xs text-zinc-600">No tasks tagged with this project</p>
            ) : (
              <div className="space-y-1">
                {tasks.slice(0, 10).map(t => (
                  <div key={t.id} className="flex items-center gap-2 text-xs px-2 py-1.5 rounded-lg bg-zinc-900/50 border border-zinc-800">
                    <span className="text-zinc-500 font-mono w-14 shrink-0">
                      {new Date(t.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                    <span className="text-violet-300 shrink-0">{t.fromAgent}</span>
                    <span className="text-zinc-600">→</span>
                    <span className="text-blue-300 shrink-0">{t.toAgent}</span>
                    <span className="text-zinc-500 truncate flex-1">{truncate(t.taskText, 40)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Archive/Unarchive */}
          <div className="pt-2 border-t border-zinc-800">
            <Button
              variant="outline"
              onClick={() => onArchiveToggle(project)}
              className={`text-xs h-8 gap-1.5 ${
                project.archived
                  ? 'border-emerald-500/20 text-emerald-400/70 hover:text-emerald-400 hover:bg-emerald-500/10 hover:border-emerald-500/40'
                  : 'border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50'
              }`}
            >
              {project.archived
                ? <><ArchiveRestore className="w-3 h-3" /> Unarchive Project</>
                : <><Archive className="w-3 h-3" /> Archive Project</>
              }
            </Button>
          </div>
        </div>
      </div>
    </>
  );
}

/* ── Project Card ──────────────────────────────────── */

function ProjectCard({ project, onEdit, onArchiveToggle, memberCount, taskCount }: {
  project: Project;
  onEdit: () => void;
  onArchiveToggle: () => void;
  memberCount: number;
  taskCount: number;
}) {
  const navigate = useNavigate();

  return (
    <BaseCard
      onClick={() => navigate(`/projects/${project.id}`)}
      accentStyle={{ backgroundColor: project.archived ? '#71717a' : project.color }}
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
            onClick={onArchiveToggle}
            className={`flex-1 text-xs h-8 gap-1.5 ${
              project.archived
                ? 'border-emerald-500/20 text-emerald-400/70 hover:text-emerald-400 hover:bg-emerald-500/10 hover:border-emerald-500/40'
                : 'border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50'
            }`}
          >
            {project.archived
              ? <><ArchiveRestore className="w-3 h-3" /> Unarchive</>
              : <><Archive className="w-3 h-3" /> Archive</>
            }
          </Button>
        </>
      }
    >
      {/* Header */}
      <div className="p-5 pb-0">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="text-xl leading-none shrink-0">{project.icon || '📁'}</span>
            <div className="min-w-0">
              <h3 className="text-base font-semibold text-zinc-100 truncate">{project.name}</h3>
              <div className="flex items-center gap-2 mt-0.5">
                {project.archived ? (
                  <span className="text-[10px] uppercase tracking-wider text-zinc-500">Archived</span>
                ) : (
                  <span
                    className="inline-block w-2 h-2 rounded-full"
                    style={{ backgroundColor: project.color }}
                  />
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Details */}
      <div className="p-5 pt-4 space-y-2.5 flex-1">
        {project.description && (
          <p className="text-xs text-zinc-400 line-clamp-2">{project.description}</p>
        )}
        <div className="space-y-1.5">
          <div className="flex justify-between text-xs">
            <span className="text-zinc-500">Members</span>
            <span className="text-zinc-400 tabular-nums">{memberCount}</span>
          </div>
          <div className="flex justify-between text-xs">
            <span className="text-zinc-500">Tasks</span>
            <span className="text-zinc-400 tabular-nums">{taskCount}</span>
          </div>
        </div>
      </div>
    </BaseCard>
  );
}

/* ── Main Page ─────────────────────────────────────── */

export default function Projects() {
  const { hasScope } = useAuth();
  const canMutate = hasScope('projects:write');
  const [projects, setProjects] = useState<Project[]>([]);
  const [tasks, setTasks] = useState<ArmadaTask[]>([]);
  const [memberCounts, setMemberCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  useEffect(() => {
    async function load() {
      try {
        const [projectData, taskData] = await Promise.all([
          apiFetch<Project[]>('/api/projects?includeArchived=true'),
          apiFetch<ArmadaTask[]>('/api/tasks?limit=200'),
        ]);
        setProjects(projectData);
        setTasks(taskData);

        // Fetch member counts for each project
        const counts: Record<string, number> = {};
        for (const p of projectData) {
          try {
            const data = await apiFetch<{ members: string[] }>(`/api/projects/${p.id}/members`);
            counts[p.id] = data.members.length;
          } catch { counts[p.id] = 0; }
        }
        setMemberCounts(counts);
      } catch (err) {
        console.error('Failed to load projects:', err);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  useSSEAll(useCallback((type: string, data: any) => {
    if (type === 'project.created') {
      setProjects(prev => [...prev, data]);
    } else if (type === 'project.updated') {
      setProjects(prev => prev.map(p => p.id === data.id ? { ...p, ...data } : p));
      setSelectedProject(prev => prev?.id === data.id ? { ...prev, ...data } : prev);
    } else if (type === 'project.deleted') {
      setProjects(prev => prev.filter(p => p.id !== data.id));
      setSelectedProject(prev => prev?.id === data.id ? null : prev);
    }
  }, []));

  const taskCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const p of projects) {
      counts[p.id] = tasks.filter(t => t.projectId === p.name || t.projectId === p.id).length;
    }
    return counts;
  }, [projects, tasks]);

  const activeProjects = projects.filter(p => !p.archived);
  const archivedProjects = projects.filter(p => p.archived);

  async function handleArchiveToggle(project: Project) {
    const endpoint = project.archived ? 'unarchive' : 'archive';
    try {
      const updated = await apiFetch<Project>(`/api/projects/${project.id}/${endpoint}`, { method: 'POST' });
      setProjects(prev => prev.map(p => p.id === updated.id ? updated : p));
      setSelectedProject(prev => prev?.id === updated.id ? updated : prev);
    } catch { /* ignore */ }
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <PageHeader icon={FolderKanban} title="Projects" subtitle="Scoped teams with shared context for workstreams" />
        <CardGrid loading skeletonCount={3} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <PageHeader icon={FolderKanban} title="Projects" subtitle="Scoped teams with shared context for workstreams">
        {canMutate && (
          <Button
            onClick={() => setShowCreate(true)}
            className="bg-violet-600 hover:bg-violet-700 text-white text-sm px-4 h-9"
          >
            + New Project
          </Button>
        )}
      </PageHeader>

      {/* Create dialog */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Create Project</DialogTitle>
          </DialogHeader>
          <CreateProjectForm
            onCreated={(p) => {
              setProjects(prev => [...prev, p]);
              setShowCreate(false);
            }}
            onCancel={() => setShowCreate(false)}
          />
        </DialogContent>
      </Dialog>

      {/* Active Projects Grid */}
      {activeProjects.length === 0 ? (
        <EmptyState
          icon={FolderKanban}
          title="No projects yet"
          description="Create a project to give your agents shared context"
          action={canMutate ? { label: '+ New Project', onClick: () => setShowCreate(true) } : undefined}
        />
      ) : (
        <CardGrid>
          {activeProjects.map(p => (
            <ProjectCard
              key={p.id}
              project={p}
              onEdit={() => setSelectedProject(p)}
              onArchiveToggle={() => handleArchiveToggle(p)}
              memberCount={memberCounts[p.id] ?? 0}
              taskCount={taskCounts[p.id] ?? 0}
            />
          ))}
        </CardGrid>
      )}

      {/* Archived Projects */}
      {archivedProjects.length > 0 && (
        <div>
          <Button
            variant="ghost" onClick={() => setShowArchived(!showArchived)}
            className="text-xs text-zinc-500 hover:text-zinc-300 flex items-center gap-1"
          >
            {showArchived ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
            Archived ({archivedProjects.length})
          </Button>
          {showArchived && (
            <CardGrid className="mt-3">
              {archivedProjects.map(p => (
                <ProjectCard
                  key={p.id}
                  project={p}
                  onEdit={() => setSelectedProject(p)}
                  onArchiveToggle={() => handleArchiveToggle(p)}
                  memberCount={memberCounts[p.id] ?? 0}
                  taskCount={taskCounts[p.id] ?? 0}
                />
              ))}
            </CardGrid>
          )}
        </div>
      )}

      {/* Detail Panel */}
      {selectedProject && (
        <ProjectDetailPanel
          project={selectedProject}
          onClose={() => setSelectedProject(null)}
          onUpdated={(p) => {
            setProjects(prev => prev.map(pp => pp.id === p.id ? p : pp));
            setSelectedProject(p);
          }}
          onArchiveToggle={handleArchiveToggle}
        />
      )}
    </div>
  );
}
