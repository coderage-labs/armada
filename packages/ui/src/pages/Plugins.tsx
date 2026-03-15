import { useEffect, useMemo, useState } from 'react';
import { apiFetch } from '../hooks/useApi';
import { usePlugins } from '../hooks/queries/usePlugins';
import { usePluginVersions } from '../hooks/queries/usePluginVersions';
import type { LibraryPlugin } from '@coderage-labs/armada-shared';
import { ArrowRight, ExternalLink, Plug, Plus, Puzzle, RefreshCw, Sparkles, Trash2, X } from 'lucide-react';
import { PageHeader } from '../components/PageHeader';
import ConfirmDialog from '../components/ConfirmDialog';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Checkbox } from '../components/ui/checkbox';
import { Input } from '../components/ui/input';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '../components/ui/select';
import { EmptyState } from '../components/EmptyState';
import { CardGrid, BaseCard } from '../components/shared';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../components/ui/dialog';
import { toast } from 'sonner';

function SourceBadge({ source }: { source: string }) {
  const colors: Record<string, string> = {
    github: 'bg-zinc-500/20 text-zinc-300 border-zinc-500/20',
    npm: 'bg-red-500/20 text-red-300 border-red-500/20',
    workspace: 'bg-blue-500/20 text-blue-300 border-blue-500/20',
  };
  return (
    <Badge className={`text-xs font-medium px-2 py-0.5 rounded-full border ${colors[source] || 'bg-zinc-700/50 text-zinc-400 border-zinc-700'}`}>
      {source === 'github' ? 'GitHub' : source === 'npm' ? 'npm' : source.charAt(0).toUpperCase() + source.slice(1)}
    </Badge>
  );
}

function sourceAccent(source: string, isSystem: boolean): string {
  if (isSystem) return 'bg-blue-500';
  if (source === 'npm') return 'bg-red-500';
  if (source === 'github') return 'bg-zinc-500';
  if (source === 'workspace') return 'bg-blue-500';
  return 'bg-zinc-600';
}

/** Inline version drift display: dimmed old → highlighted new */
function VersionDrift({ from, to }: { from: string; to: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-[11px] font-mono">
      <span className="text-zinc-500">{from}</span>
      <ArrowRight className="w-3 h-3 text-zinc-600" />
      <span className="text-violet-400 font-medium">{to}</span>
    </span>
  );
}

interface PluginDetail {
  plugin: LibraryPlugin;
  templates: string[];
  instances?: string[];
  system?: boolean;
  loading?: boolean;
}

// System plugins that should never appear in cleanup
const SYSTEM_PLUGINS = new Set(['armada-agent', 'armada-shared']);

export default function Plugins() {
  const { data: plugins = [], isLoading: loading, refetch: fetchPlugins } = usePlugins();
  const { data: versionData, refetch: refetchVersions } = usePluginVersions();
  const [usageCounts, setUsageCounts] = useState<Record<string, number>>({});
  const [showAdd, setShowAdd] = useState(false);
  const [detail, setDetail] = useState<PluginDetail | null>(null);

  // Add form
  const [newName, setNewName] = useState('');
  const [newSource, setNewSource] = useState<'github' | 'npm' | 'workspace'>('github');
  const [newUrl, setNewUrl] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [newVersion, setNewVersion] = useState('');
  const [adding, setAdding] = useState(false);

  // Cleanup state
  const [cleaningUp, setCleaningUp] = useState(false);
  const [cleanupResult, setCleanupResult] = useState<{ removed: string[]; removedCount: number } | null>(null);

  // Update selection state
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [updatingSelected, setUpdatingSelected] = useState(false);

  // Confirm dialog (used by cleanup and delete)
  const [confirmDialog, setConfirmDialog] = useState<{ title: string; message: string; confirmLabel: string; onConfirm: () => void } | null>(null);

  // Build a map of pluginName → { outdated: boolean, installedVersion: string | null }
  const versionMap = useMemo(() => {
    const map = new Map<string, { outdated: boolean; installedVersion: string | null; libraryVersion: string | null }>();
    if (!versionData?.plugins) return map;
    for (const entry of versionData.plugins) {
      const outdatedInstances = entry.instances.filter(i => i.outdated);
      if (outdatedInstances.length > 0) {
        // Show the lowest installed version as the "from" version
        const sorted = [...outdatedInstances].sort((a, b) => a.installedVersion.localeCompare(b.installedVersion));
        map.set(entry.name, {
          outdated: true,
          installedVersion: sorted[0]?.installedVersion ?? null,
          libraryVersion: entry.libraryVersion,
        });
      }
    }
    return map;
  }, [versionData]);

  // IDs of plugins that are outdated on at least one agent
  const outdatedPluginIds = useMemo(() => {
    return plugins
      .filter((p: LibraryPlugin) => versionMap.has(p.name))
      .map((p: LibraryPlugin) => p.id);
  }, [plugins, versionMap]);

  // Fetch usage counts whenever the plugins list changes
  useEffect(() => {
    if (plugins.length === 0) return;
    const counts: Record<string, number> = {};
    Promise.all(
      plugins.map(async (p: LibraryPlugin) => {
        try {
          const usage = await apiFetch<{ templates: string[] }>(`/api/plugins/library/${p.id}/usage`);
          counts[p.id] = usage.templates.length;
        } catch {
          counts[p.id] = 0;
        }
      }),
    ).then(() => setUsageCounts({ ...counts }));
  }, [plugins]);

  const handleAdd = async () => {
    if (!newName.trim()) return;
    setAdding(true);
    try {
      await apiFetch('/api/plugins/library', {
        method: 'POST',
        body: JSON.stringify({
          name: newName.trim(),
          source: newSource,
          url: newUrl.trim() || undefined,
          version: newVersion.trim() || undefined,
          description: newDesc.trim() || undefined,
        }),
      });
      setNewName('');
      setNewUrl('');
      setNewDesc('');
      setNewVersion('');
      setShowAdd(false);
      fetchPlugins();
    } catch {
      // silent
    } finally {
      setAdding(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await apiFetch(`/api/plugins/library/${id}`, { method: 'DELETE' });
      setDetail(null);
      fetchPlugins();
    } catch {
      // silent
    }
  };

  const handleDelete_confirm = (id: string, name: string) => {
    setConfirmDialog({
      title: 'Remove Plugin',
      message: `Remove "${name}" from the library? This cannot be undone.`,
      confirmLabel: 'Remove',
      onConfirm: async () => {
        setConfirmDialog(null);
        await handleDelete(id);
      },
    });
  };

  const handleUpdateSelected = async (ids: string[]) => {
    if (ids.length === 0) return;
    setUpdatingSelected(true);
    try {
      await apiFetch('/api/plugins/library/batch-rollout', {
        method: 'POST',
        body: JSON.stringify({ pluginIds: ids }),
      });
      setSelected(new Set());
      toast.success(`${ids.length} plugin update${ids.length !== 1 ? 's' : ''} staged — review in Changesets`);
      fetchPlugins();
      refetchVersions();
    } catch (err: any) {
      toast.error(err?.message || 'Update failed');
    } finally {
      setUpdatingSelected(false);
    }
  };

  const handleCleanup = () => {
    setConfirmDialog({
      title: 'Cleanup Unused Plugins',
      message: 'This will remove all plugins not used by any template. System plugins are always kept.\n\nContinue?',
      confirmLabel: 'Clean Up',
      onConfirm: async () => {
        setConfirmDialog(null);
        setCleaningUp(true);
        setCleanupResult(null);
        try {
          const result = await apiFetch<{ removed: string[]; removedCount: number }>('/api/plugins/library/cleanup', { method: 'POST' });
          setCleanupResult(result);
          if (result.removedCount > 0) {
            toast.success(`Removed ${result.removedCount} unused plugin(s): ${result.removed.join(', ')}`);
          } else {
            toast.success('No unused plugins to remove');
          }
          fetchPlugins();
        } catch {
          toast.error('Cleanup failed');
        } finally {
          setCleaningUp(false);
        }
      },
    });
  };

  const openDetail = (plugin: LibraryPlugin) => {
    // Show modal immediately with loading state — don't block on API call
    setDetail({ plugin, templates: [], loading: true });
    apiFetch<{ templates: string[]; instances?: string[]; system?: boolean }>(`/api/plugins/library/${plugin.id}/usage`)
      .then((usage) => setDetail({ plugin, templates: usage.templates, instances: usage.instances, system: usage.system }))
      .catch(() => setDetail({ plugin, templates: [] }));
  };

  const toggleSelect = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const hasOutdated = outdatedPluginIds.length > 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <PageHeader icon={Puzzle} title="Plugin Library" subtitle="Manage armada-wide plugins — templates pick from this library">
        {hasOutdated && outdatedPluginIds.length > 1 && (
          <Button
            variant="outline"
            onClick={() => handleUpdateSelected(outdatedPluginIds)}
            disabled={updatingSelected}
            className="text-xs h-9 gap-1.5 border-violet-500/30 text-violet-300 hover:text-violet-200 hover:bg-violet-500/10 hover:border-violet-500/50 disabled:opacity-50"
          >
            <RefreshCw className="w-4 h-4" />
            Update All ({outdatedPluginIds.length})
          </Button>
        )}
        <Button
          variant="outline"
          onClick={handleCleanup}
          disabled={cleaningUp}
          className="text-xs h-9 gap-1.5 border-amber-500/30 text-amber-300 hover:text-amber-200 hover:bg-amber-500/10 hover:border-amber-500/50 disabled:opacity-50"
        >
          <Sparkles className="w-4 h-4" />
          {cleaningUp ? 'Cleaning…' : 'Cleanup Unused'}
        </Button>
        <Button
          onClick={() => setShowAdd(true)}
          className="bg-violet-600 hover:bg-violet-700 text-white text-sm px-4 h-9"
        >
          <Plus className="w-4 h-4 mr-1.5" /> Add Plugin
        </Button>
      </PageHeader>

      {/* Cleanup result banner */}
      {cleanupResult && cleanupResult.removedCount > 0 && (
        <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-300 flex items-center justify-between">
          <span>Removed {cleanupResult.removedCount} unused plugin(s): {cleanupResult.removed.join(', ')}</span>
          <Button variant="ghost" onClick={() => setCleanupResult(null)} className="text-amber-400/60 hover:text-amber-400">
            <X className="w-4 h-4" />
          </Button>
        </div>
      )}

      {/* Add dialog */}
      <Dialog open={showAdd} onOpenChange={setShowAdd}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Add Plugin to Library</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-zinc-400 mb-1.5">Name <span className="text-red-400">*</span></label>
                <Input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="plugin-name"
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
                    <SelectItem value="github">GitHub</SelectItem>
                    <SelectItem value="npm">npm</SelectItem>
                    <SelectItem value="workspace">Workspace</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            {(newSource === 'github' || newSource === 'npm') && (
              <div>
                <label className="block text-xs font-medium text-zinc-400 mb-1.5">URL</label>
                <Input
                  value={newUrl}
                  onChange={(e) => setNewUrl(e.target.value)}
                  placeholder={newSource === 'github' ? 'https://github.com/user/plugin-repo' : 'https://www.npmjs.com/package/plugin-name'}
                />
              </div>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-zinc-400 mb-1.5">Description</label>
                <Input
                  value={newDesc}
                  onChange={(e) => setNewDesc(e.target.value)}
                  placeholder="What this plugin does…"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-zinc-400 mb-1.5">Version</label>
                <Input
                  value={newVersion}
                  onChange={(e) => setNewVersion(e.target.value)}
                  placeholder="1.0.0"
                />
              </div>
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
      {!loading && plugins.length === 0 && !showAdd && (
        <EmptyState
          icon={Plug}
          title="No plugins in library"
          description="Add a plugin to get started"
          action={{ label: '+ Add Plugin', onClick: () => setShowAdd(true) }}
        />
      )}

      {/* Grid */}
      {!loading && plugins.length > 0 && (
        <CardGrid>
          {plugins.map((plugin: LibraryPlugin) => {
            const isSystem = plugin.system || SYSTEM_PLUGINS.has(plugin.name);
            const isSelected = selected.has(plugin.id);
            const drift = versionMap.get(plugin.name);
            const isOutdated = !!drift;

            return (
              <BaseCard
                key={plugin.id}
                onClick={() => openDetail(plugin)}
                accentColor={sourceAccent(plugin.source, isSystem)}
                className={isSelected
                  ? 'border-violet-600/50 bg-violet-950/20 hover:bg-violet-950/30'
                  : undefined}
                footer={
                  <>
                    {!isSystem && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleDelete_confirm(plugin.id, plugin.name)}
                        className="flex-1 text-xs h-8 gap-1.5 border-red-500/20 text-red-400/70 hover:text-red-400 hover:bg-red-500/10 hover:border-red-500/40"
                      >
                        <Trash2 className="w-3 h-3" /> Remove
                      </Button>
                    )}
                    {isOutdated && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleUpdateSelected([plugin.id])}
                        disabled={updatingSelected}
                        className="flex-1 text-xs h-8 gap-1.5 bg-violet-600/10 border-violet-500/40 text-violet-300 hover:bg-violet-600/20 hover:border-violet-500/60 hover:text-violet-200 disabled:opacity-50"
                      >
                        <RefreshCw className="w-3 h-3" /> Update
                      </Button>
                    )}
                  </>
                }
              >
                {/* Checkbox — top-right, stops card click */}
                <div
                  className="absolute top-3 right-3 z-10"
                  onClick={(e) => e.stopPropagation()}
                >
                  <Checkbox
                    checked={isSelected}
                    onCheckedChange={() => toggleSelect(plugin.id)}
                  />
                </div>

                {/* Header */}
                <div className="p-5 pb-0 pr-10">
                  <div className="flex items-start justify-between">
                    <div className="min-w-0">
                      <h3 className="text-base font-semibold text-zinc-100">{plugin.name}</h3>
                      <div className="flex items-center gap-2 mt-1 flex-wrap">
                        <SourceBadge source={plugin.source} />
                        {plugin.system && (
                          <Badge className="bg-blue-500/20 text-blue-400 border-blue-500/30 text-[11px] px-2 py-0.5 rounded-full border">System</Badge>
                        )}
                        {/* Version: show drift if outdated, otherwise show library version */}
                        {isOutdated && drift.installedVersion && drift.libraryVersion ? (
                          <VersionDrift from={drift.installedVersion} to={drift.libraryVersion} />
                        ) : plugin.version ? (
                          <span className="text-[11px] text-zinc-500">v{plugin.version}</span>
                        ) : null}
                        {isOutdated && (
                          <Badge className="bg-amber-500/20 text-amber-400 border-amber-500/30 text-[11px] px-2 py-0.5 rounded-full border">
                            Update available
                          </Badge>
                        )}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Details */}
                <div className="p-5 pt-4 space-y-2.5 flex-1">
                  <p className="text-xs text-zinc-400 line-clamp-2">
                    {plugin.description || 'No description'}
                  </p>
                  {plugin.npmPkg && (
                    <div className="flex justify-between text-xs">
                      <span className="text-zinc-500">Package</span>
                      <code className="text-zinc-400">{plugin.npmPkg}</code>
                    </div>
                  )}
                  <div className="flex justify-between text-xs">
                    <span className="text-zinc-500">Templates</span>
                    <span className="text-zinc-400 tabular-nums">
                      {isSystem ? 'All instances' : `${usageCounts[plugin.id] ?? 0}`}
                    </span>
                  </div>
                </div>
              </BaseCard>
            );
          })}
        </CardGrid>
      )}

      {/* Update Selected bottom bar */}
      {selected.size > 0 && (
        <div className="fixed bottom-0 left-0 right-0 z-40 border-t border-zinc-800 bg-zinc-950/95 px-6 py-4">
          <div className="max-w-7xl mx-auto flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="text-sm text-zinc-300">
                <span className="font-medium text-violet-400">{selected.size}</span> plugin{selected.size !== 1 ? 's' : ''} selected
              </span>
              <Button variant="ghost" onClick={() => setSelected(new Set())} className="text-xs text-zinc-500 hover:text-zinc-300">
                Clear
              </Button>
            </div>
            <Button
              onClick={() => handleUpdateSelected([...selected])}
              disabled={updatingSelected}
              className="bg-violet-600 hover:bg-violet-700 text-white text-sm px-5 h-9 disabled:opacity-50"
            >
              {updatingSelected ? 'Staging…' : `Update Selected (${selected.size})`}
            </Button>
          </div>
        </div>
      )}

      {/* Detail Dialog */}
      <Dialog open={!!detail} onOpenChange={(open) => { if (!open) setDetail(null); }}>
        <DialogContent showClose={false} className="max-w-lg space-y-4">
          {detail && (
            <>
              <DialogHeader>
                <div className="flex items-start justify-between">
                  <div>
                    <DialogTitle>{detail.plugin.name}</DialogTitle>
                    <div className="flex items-center gap-2 mt-1 flex-wrap">
                      <SourceBadge source={detail.plugin.source} />
                      {detail.plugin.system && (
                        <Badge className="bg-blue-500/20 text-blue-400 border-blue-500/30 text-[11px] px-2 py-0.5 rounded-full border">System</Badge>
                      )}
                      {(() => {
                        const drift = versionMap.get(detail.plugin.name);
                        if (drift?.installedVersion && drift?.libraryVersion) {
                          return <VersionDrift from={drift.installedVersion} to={drift.libraryVersion} />;
                        }
                        if (detail.plugin.version) {
                          return <span className="text-xs text-zinc-500">v{detail.plugin.version}</span>;
                        }
                        return null;
                      })()}
                    </div>
                  </div>
                  <Button variant="ghost" onClick={() => setDetail(null)} className="text-zinc-400 hover:text-zinc-200">
                    <X className="w-5 h-5" />
                  </Button>
                </div>
              </DialogHeader>

              <p className="text-sm text-zinc-400">{detail.plugin.description || 'No description'}</p>

              {/* Package info */}
              <div className="space-y-2">
                {detail.plugin.npmPkg && (
                  <div className="flex items-center gap-2 text-sm">
                    <span className="text-zinc-500">Package:</span>
                    <code className="text-zinc-300 bg-zinc-800/50 px-2 py-0.5 rounded text-xs">{detail.plugin.npmPkg}</code>
                  </div>
                )}
                {detail.plugin.url && (
                  <a href={detail.plugin.url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 text-sm text-blue-400 hover:text-blue-300">
                    <ExternalLink className="w-3.5 h-3.5" /> {detail.plugin.url}
                  </a>
                )}
              </div>

              {/* Usage */}
              <div>
                {detail.loading ? (
                  <div className="space-y-2">
                    <div className="h-4 w-32 bg-zinc-800/50 rounded animate-pulse" />
                    <div className="flex gap-2">
                      <div className="h-6 w-20 bg-zinc-800/50 rounded-lg animate-pulse" />
                      <div className="h-6 w-16 bg-zinc-800/50 rounded-lg animate-pulse" />
                    </div>
                  </div>
                ) : detail.system ? (
                  <>
                    <h3 className="text-sm font-medium text-zinc-300 mb-2">Deployed to</h3>
                    <div className="flex flex-wrap gap-2">
                      {(detail.instances || []).map((name) => (
                        <span key={name} className="text-xs bg-blue-500/10 text-blue-400 px-2 py-1 rounded-lg border border-blue-500/20">{name}</span>
                      ))}
                    </div>
                    <p className="text-xs text-zinc-500 mt-1.5">System plugin — automatically injected into all instances</p>
                  </>
                ) : (
                  <>
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
                  </>
                )}
              </div>

              <DialogFooter className="flex flex-wrap gap-3">
                {versionMap.has(detail.plugin.name) && (
                  <Button
                    onClick={() => { handleUpdateSelected([detail.plugin.id]); setDetail(null); }}
                    disabled={updatingSelected}
                    className="flex-1 text-xs h-9 gap-1.5 bg-violet-600 hover:bg-violet-700 text-white disabled:opacity-50"
                  >
                    <RefreshCw className="w-3.5 h-3.5" /> Stage Update
                  </Button>
                )}
                {!(detail.plugin.system || SYSTEM_PLUGINS.has(detail.plugin.name)) && (
                  <Button
                    variant="outline"
                    onClick={() => { handleDelete_confirm(detail.plugin.id, detail.plugin.name); setDetail(null); }}
                    className="flex-1 text-xs h-9 gap-1.5 border-red-500/20 text-red-400/70 hover:text-red-400 hover:bg-red-500/10 hover:border-red-500/40"
                  >
                    <Trash2 className="w-3.5 h-3.5" /> Remove
                  </Button>
                )}
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!confirmDialog}
        title={confirmDialog?.title ?? ''}
        message={confirmDialog?.message ?? ''}
        confirmLabel={confirmDialog?.confirmLabel ?? 'Confirm'}
        destructive
        onConfirm={() => confirmDialog?.onConfirm()}
        onCancel={() => setConfirmDialog(null)}
      />
    </div>
  );
}
