import { useEffect, useState } from 'react';
import { apiFetch } from '../hooks/useApi';
import { useSkills } from '../hooks/queries/useSkills';
import type { LibrarySkill } from '@coderage-labs/armada-shared';
import { Package, Plus, Trash2, RefreshCw, ExternalLink, X, Terminal } from 'lucide-react';
import { PageHeader } from '../components/PageHeader';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Input } from '../components/ui/input';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '../components/ui/select';
import { EmptyState } from '../components/EmptyState';
import { CardGrid, BaseCard } from '../components/shared';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../components/ui/responsive-dialog';

function SourceBadge({ source }: { source: string }) {
  const colors: Record<string, string> = {
    clawhub: 'bg-violet-500/20 text-violet-300 border-violet-500/20',
    github: 'bg-zinc-500/20 text-zinc-300 border-zinc-500/20',
    workspace: 'bg-blue-500/20 text-blue-300 border-blue-500/20',
  };
  return (
    <Badge className={`text-xs font-medium px-2 py-0.5 rounded-full border ${colors[source] || 'bg-zinc-700/50 text-zinc-400 border-zinc-700'}`}>
      {source === 'clawhub' ? 'ClawHub' : source === 'github' ? 'GitHub' : source.charAt(0).toUpperCase() + source.slice(1)}
    </Badge>
  );
}

function sourceAccent(source: string): string {
  if (source === 'clawhub') return 'bg-violet-500';
  if (source === 'github') return 'bg-zinc-500';
  if (source === 'workspace') return 'bg-blue-500';
  return 'bg-zinc-600';
}

interface SkillDetail {
  skill: LibrarySkill;
  templates: string[];
}

export default function Skills() {
  const { data: skills = [], isLoading: loading, refetch: fetchSkills } = useSkills();
  const [usageCounts, setUsageCounts] = useState<Record<string, number>>({});
  const [showAdd, setShowAdd] = useState(false);
  const [detail, setDetail] = useState<SkillDetail | null>(null);

  // Add form
  const [newName, setNewName] = useState('');
  const [newSource, setNewSource] = useState<'clawhub' | 'github' | 'workspace'>('clawhub');
  const [newUrl, setNewUrl] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [adding, setAdding] = useState(false);

  // Fetch usage counts whenever the skills list changes
  useEffect(() => {
    if (skills.length === 0) return;
    const counts: Record<string, number> = {};
    Promise.all(
      skills.map(async (s: LibrarySkill) => {
        try {
          const usage = await apiFetch<{ templates: string[] }>(`/api/skills/library/${s.id}/usage`);
          counts[s.id] = usage.templates.length;
        } catch {
          counts[s.id] = 0;
        }
      }),
    ).then(() => setUsageCounts({ ...counts }));
  }, [skills]);

  const handleAdd = async () => {
    if (!newName.trim()) return;
    setAdding(true);
    try {
      await apiFetch('/api/skills/library', {
        method: 'POST',
        body: JSON.stringify({
          name: newName.trim(),
          source: newSource,
          url: newUrl.trim() || undefined,
          description: newDesc.trim() || undefined,
        }),
      });
      setNewName('');
      setNewUrl('');
      setNewDesc('');
      setShowAdd(false);
      fetchSkills();
    } catch {
      // silent
    } finally {
      setAdding(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await apiFetch(`/api/skills/library/${id}`, { method: 'DELETE' });
      setDetail(null);
      fetchSkills();
    } catch {
      // silent
    }
  };

  const handleUpdate = async (id: string) => {
    try {
      await apiFetch(`/api/skills/library/${id}/update`, { method: 'POST' });
      fetchSkills();
    } catch {
      // silent
    }
  };

  const openDetail = async (skill: LibrarySkill) => {
    try {
      const usage = await apiFetch<{ templates: string[] }>(`/api/skills/library/${skill.id}/usage`);
      setDetail({ skill, templates: usage.templates });
    } catch {
      setDetail({ skill, templates: [] });
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <PageHeader icon={Terminal} title="Skill Library" subtitle="Manage armada-wide skills — templates pick from this library">
        <Button
          onClick={() => setShowAdd(true)}
          className="bg-violet-600 hover:bg-violet-700 text-white text-sm px-4 h-9"
        >
          <Plus className="w-4 h-4 mr-1.5" /> Add Skill
        </Button>
      </PageHeader>

      {/* Add dialog */}
      <Dialog open={showAdd} onOpenChange={setShowAdd}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Add Skill to Library</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-zinc-400 mb-1.5">Name <span className="text-red-400">*</span></label>
                <Input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="skill-name"
                  autoFocus
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-zinc-400 mb-1.5">Source</label>
                <Select value={newSource} onValueChange={(v) => setNewSource(v as typeof newSource)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="clawhub">ClawHub</SelectItem>
                    <SelectItem value="github">GitHub</SelectItem>
                    <SelectItem value="workspace">Workspace</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            {newSource === 'github' && (
              <div>
                <label className="block text-xs font-medium text-zinc-400 mb-1.5">URL</label>
                <Input
                  value={newUrl}
                  onChange={(e) => setNewUrl(e.target.value)}
                  placeholder="https://github.com/user/skill-repo"
                />
              </div>
            )}
            <div>
              <label className="block text-xs font-medium text-zinc-400 mb-1.5">Description</label>
              <Input
                value={newDesc}
                onChange={(e) => setNewDesc(e.target.value)}
                placeholder="What this skill does…"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowAdd(false)}
              className="text-xs h-9 border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50"
            >
              Cancel
            </Button>
            <Button
              onClick={handleAdd}
              disabled={adding || !newName.trim()}
              className="bg-violet-600 hover:bg-violet-700 text-white text-sm px-4 h-9 disabled:opacity-50"
            >
              {adding ? 'Adding…' : 'Add to Library'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Loading */}
      {loading && <CardGrid loading skeletonCount={3} />}

      {/* Empty */}
      {!loading && skills.length === 0 && !showAdd && (
        <EmptyState
          icon={Package}
          title="No skills in library"
          description="Add a skill to get started"
          action={{ label: '+ Add Skill', onClick: () => setShowAdd(true) }}
        />
      )}

      {/* Grid */}
      {!loading && skills.length > 0 && (
        <CardGrid>
          {skills.map((skill) => (
            <BaseCard
              key={skill.id}
              onClick={() => openDetail(skill)}
              accentColor={sourceAccent(skill.source)}
              footer={
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleUpdate(skill.id)}
                    className="flex-1 text-xs h-8 gap-1.5 border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50"
                  >
                    <RefreshCw className="w-3 h-3" /> Update
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleDelete(skill.id)}
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
                  <div>
                    <h3 className="text-base font-semibold text-zinc-100">{skill.name}</h3>
                    <div className="flex items-center gap-2 mt-1">
                      <SourceBadge source={skill.source} />
                      {skill.version && (
                        <span className="text-[11px] text-zinc-500">v{skill.version}</span>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              {/* Details */}
              <div className="p-5 pt-4 space-y-2.5 flex-1">
                <p className="text-xs text-zinc-400 line-clamp-2">
                  {skill.description || 'No description'}
                </p>
                <div className="flex justify-between text-xs">
                  <span className="text-zinc-500">Templates</span>
                  <span className="text-zinc-400 tabular-nums">{usageCounts[skill.id] ?? 0}</span>
                </div>
              </div>
            </BaseCard>
          ))}
        </CardGrid>
      )}

      {/* Detail Dialog */}
      <Dialog open={!!detail} onOpenChange={(open) => { if (!open) setDetail(null); }}>
        <DialogContent showClose={false} className="max-w-lg space-y-4">
          {detail && (
            <>
              <DialogHeader>
                <div className="flex items-start justify-between">
                  <div>
                    <DialogTitle>{detail.skill.name}</DialogTitle>
                    <div className="flex items-center gap-2 mt-1">
                      <SourceBadge source={detail.skill.source} />
                      {detail.skill.version && <span className="text-xs text-zinc-500">v{detail.skill.version}</span>}
                    </div>
                  </div>
                  <Button variant="ghost" onClick={() => setDetail(null)} className="text-zinc-400 hover:text-zinc-200">
                    <X className="w-5 h-5" />
                  </Button>
                </div>
              </DialogHeader>

              <p className="text-sm text-zinc-400">{detail.skill.description || 'No description'}</p>

              {detail.skill.url && (
                <a href={detail.skill.url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 text-sm text-blue-400 hover:text-blue-300">
                  <ExternalLink className="w-3.5 h-3.5" /> {detail.skill.url}
                </a>
              )}

              <div>
                <h3 className="text-sm font-medium text-zinc-300 mb-2">Used by Templates</h3>
                {detail.templates.length === 0 ? (
                  <p className="text-sm text-zinc-500">Not used by any templates</p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {detail.templates.map((t) => (
                      <span key={t} className="text-xs bg-zinc-800/50 text-zinc-300 px-2 py-1 rounded-lg">{t}</span>
                    ))}
                  </div>
                )}
              </div>

              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => { handleUpdate(detail.skill.id); setDetail(null); }}
                  className="flex-1 text-xs h-9 gap-1.5 border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50"
                >
                  <RefreshCw className="w-3.5 h-3.5" /> Update Version
                </Button>
                <Button
                  variant="outline"
                  onClick={() => handleDelete(detail.skill.id)}
                  className="flex-1 text-xs h-9 gap-1.5 border-red-500/20 text-red-400/70 hover:text-red-400 hover:bg-red-500/10 hover:border-red-500/40"
                >
                  <Trash2 className="w-3.5 h-3.5" /> Remove
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
