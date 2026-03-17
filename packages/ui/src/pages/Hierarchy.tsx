import { useEffect, useState, useRef } from 'react';
import { apiFetch } from '../hooks/useApi';
import { useHierarchy } from '../hooks/queries/useHierarchy';
import type { RoleMetadata } from '@coderage-labs/armada-shared';
import EmojiPickerButton from '../components/EmojiPickerButton';
import { X, GitBranch as GitBranchIcon } from 'lucide-react';
import { LoadingState } from '../components/LoadingState';
import { PageHeader } from '../components/PageHeader';
import ConfirmDialog from '../components/ConfirmDialog';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Textarea } from '../components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../components/ui/responsive-dialog';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../components/ui/tabs';

interface HierarchyData {
  rules: Record<string, string[]>;
  roles: RoleMetadata[];
}

const PRESET_COLOURS = [
  '#a855f7', // purple
  '#3b82f6', // blue
  '#06b6d4', // cyan
  '#10b981', // emerald
  '#f59e0b', // amber
  '#ef4444', // red
  '#ec4899', // pink
  '#8b5cf6', // violet
  '#f97316', // orange
  '#6366f1', // indigo
];

const TIER_LABELS: Record<number, string> = {
  0: 'Operator / Lead',
  1: 'Manager',
  2: 'Worker',
};

const DEFAULT_META: Omit<RoleMetadata, 'role'> = {
  color: '#a855f7',
  description: '',
  tier: 2,
  icon: null,
};

/* ── colour picker inline ── */
function ColourPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (hex: string) => void;
}) {
  const [hexInput, setHexInput] = useState(value);
  useEffect(() => setHexInput(value), [value]);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {PRESET_COLOURS.map((c) => (
          <Button
            variant="ghost" key={c}
            onClick={() => { onChange(c); setHexInput(c); }}
            className="w-7 h-7 rounded-lg border-2 transition-all hover:scale-110"
            style={{
              backgroundColor: c,
              borderColor: value === c ? '#fff' : 'rgba(255,255,255,0.15)',
            }}
            title={c}
          />
        ))}
      </div>
      <Input
        type="text"
        value={hexInput}
        onChange={(e) => {
          setHexInput(e.target.value);
          if (/^#[0-9a-fA-F]{6}$/.test(e.target.value)) onChange(e.target.value);
        }}
        placeholder="#a855f7"
        className="w-28 px-2 py-1 text-xs rounded-lg border border-zinc-800 bg-black/20 text-zinc-300 placeholder-gray-600 focus:outline-none focus:border-purple-500/50 font-mono"
      />
    </div>
  );
}

/* ── role card editor ── */
function RoleCard({
  role,
  targets,
  meta,
  allRoles,
  roleMetaMap,
  onSave,
  onDelete,
}: {
  role: string;
  targets: string[];
  meta: Omit<RoleMetadata, 'role'>;
  allRoles: string[];
  roleMetaMap: Record<string, Omit<RoleMetadata, 'role'>>;
  onSave: (role: string, targets: string[], meta: Omit<RoleMetadata, 'role'>) => void;
  onDelete: (role: string) => void;
}) {
  const [editOpen, setEditOpen] = useState(false);
  const [draft, setDraft] = useState<string[]>(targets);
  const [draftMeta, setDraftMeta] = useState<Omit<RoleMetadata, 'role'>>(meta);
  const [newTarget, setNewTarget] = useState('');
  const [showConfirm, setShowConfirm] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // sync draft when targets/meta change externally (e.g. after save)
  useEffect(() => {
    if (!editOpen) {
      setDraft(targets);
      setDraftMeta(meta);
    }
  }, [targets, meta, editOpen]);

  function openEdit() {
    setDraft([...targets]);
    setDraftMeta({ ...meta });
    setEditOpen(true);
    setTimeout(() => inputRef.current?.focus(), 50);
  }

  function cancelEdit() {
    setDraft([...targets]);
    setDraftMeta({ ...meta });
    setNewTarget('');
    setEditOpen(false);
  }

  function saveEdit() {
    onSave(role, draft, draftMeta);
    setNewTarget('');
    setEditOpen(false);
  }

  function addTarget(t: string) {
    const clean = t.trim().toLowerCase().replace(/\s+/g, '-');
    if (!clean || draft.includes(clean)) return;
    setDraft([...draft, clean]);
    setNewTarget('');
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  function removeTarget(idx: number) {
    setDraft(draft.filter((_, i) => i !== idx));
  }

  const hasChanges =
    JSON.stringify(draft) !== JSON.stringify(targets) ||
    JSON.stringify(draftMeta) !== JSON.stringify(meta);

  const availableRoles = allRoles.filter(
    (r) => r !== role && !draft.includes(r),
  );

  return (
    <>
      <ConfirmDialog
        open={showConfirm}
        title={`Delete role "${role}"?`}
        message="This role and all its targets will be removed. Other roles targeting this role won't be affected. You'll need to save to apply the change."
        confirmLabel="Delete"
        destructive
        onConfirm={() => {
          setShowConfirm(false);
          onDelete(role);
        }}
        onCancel={() => setShowConfirm(false)}
      />

      {/* Edit dialog */}
      <Dialog open={editOpen} onOpenChange={(open) => { if (!open) cancelEdit(); }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit Role: {role}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {/* ── metadata fields ── */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {/* colour */}
              <div>
                <label className="text-[10px] text-zinc-500 uppercase tracking-wider block mb-1">
                  Colour
                </label>
                <ColourPicker
                  value={draftMeta.color}
                  onChange={(c) => setDraftMeta({ ...draftMeta, color: c })}
                />
              </div>

              {/* icon */}
              <div>
                <label className="text-[10px] text-zinc-500 uppercase tracking-wider block mb-1">
                  Icon
                </label>
                <EmojiPickerButton
                  value={draftMeta.icon ?? null}
                  onChange={(emoji) => setDraftMeta({ ...draftMeta, icon: emoji })}
                  placeholder="🔧"
                  size="sm"
                />
              </div>

              {/* description */}
              <div className="sm:col-span-2">
                <label className="text-[10px] text-zinc-500 uppercase tracking-wider block mb-1">
                  Description
                </label>
                <Input
                  type="text"
                  value={draftMeta.description}
                  onChange={(e) =>
                    setDraftMeta({ ...draftMeta, description: e.target.value })
                  }
                  placeholder="What does this role do?"
                  className="w-full px-3 py-1.5 text-sm rounded-lg border border-zinc-800 bg-black/20 text-zinc-300 placeholder-gray-600 focus:outline-none focus:border-purple-500/50 transition-all"
                />
              </div>

              {/* tier */}
              <div>
                <label className="text-[10px] text-zinc-500 uppercase tracking-wider block mb-1">
                  Tier
                </label>
                <Select
                  value={String(draftMeta.tier)}
                  onValueChange={(v) => setDraftMeta({ ...draftMeta, tier: Number(v) })}
                >
                  <SelectTrigger className="w-full text-sm rounded-lg border border-zinc-800 bg-black/20 text-zinc-300 focus:border-purple-500/50 transition-all">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-zinc-900 border-zinc-800">
                    {Object.entries(TIER_LABELS).map(([v, label]) => (
                      <SelectItem key={v} value={v} className="text-zinc-300">
                        {v} — {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* ── task routing targets ── */}
            <div>
              <label className="text-[10px] text-zinc-500 uppercase tracking-wider block mb-1">
                Can assign tasks to
              </label>
              {/* current targets as removable chips */}
              {draft.length > 0 && (
                <div className="flex flex-wrap gap-2 mb-2">
                  {draft.map((target, tIdx) => (
                    <div
                      key={tIdx}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium"
                      style={{
                        backgroundColor: `${roleMetaMap[target]?.color ?? '#6b7280'}20`,
                        borderColor: `${roleMetaMap[target]?.color ?? '#6b7280'}40`,
                        color: roleMetaMap[target]?.color ?? '#9ca3af',
                      }}
                    >
                      <span className="text-zinc-500">→</span>
                      <span>{target}</span>
                      <Button
                        variant="ghost" onClick={() => removeTarget(tIdx)}
                        className="ml-1 text-red-400/60 hover:text-red-400 transition-colors"
                        title={`Remove ${target}`}
                      >
                        <X className="w-3 h-3" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
              {/* quick-add existing roles */}
              {availableRoles.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {availableRoles.map((r) => {
                    const rMeta = roleMetaMap[r];
                    return (
                      <Button
                        variant="ghost" key={r}
                        onClick={() => addTarget(r)}
                        className="px-2.5 py-1 rounded-lg text-[11px] border border-zinc-800 text-zinc-400 hover:border-purple-500/30 hover:text-purple-300 transition-all flex items-center gap-1"
                      >
                        {rMeta?.color && (
                          <span
                            className="w-2.5 h-2.5 rounded-full inline-block"
                            style={{ backgroundColor: rMeta.color }}
                          />
                        )}
                        + {r}
                      </Button>
                    );
                  })}
                </div>
              )}

              {draft.length === 0 && (
                <p className="text-xs text-zinc-500 italic">
                  No targets yet — click a role above to add it.
                </p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={cancelEdit}>
              Cancel
            </Button>
            <Button
              onClick={saveEdit}
              disabled={!hasChanges}
              className="bg-violet-600 hover:bg-violet-700 text-white disabled:opacity-40"
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Read-only card */}
      <div
        className="rounded-lg border bg-gradient-to-br backdrop-blur-sm p-4 transition-all"
        style={{
          borderColor: `${meta.color}33`,
          background: `linear-gradient(to bottom right, ${meta.color}20, ${meta.color}08)`,
        }}
      >
        {/* header */}
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2 min-w-0">
            <span
              className="w-4 h-4 rounded-full shrink-0 border border-zinc-600"
              style={{ backgroundColor: meta.color }}
              title={meta.color}
            />
            {meta.icon && <span className="text-lg shrink-0">{meta.icon}</span>}
            <span className="text-lg font-bold truncate">{role}</span>
            {meta.tier !== undefined && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full border border-zinc-800 text-zinc-500 shrink-0">
                {TIER_LABELS[meta.tier] ?? `Tier ${meta.tier}`}
              </span>
            )}
            <span className="text-xs text-zinc-500 shrink-0">
              {targets.length} target{targets.length !== 1 ? 's' : ''}
            </span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button
              variant="ghost" onClick={openEdit}
              className="px-3 py-1 rounded-lg text-xs font-medium border border-zinc-800 text-zinc-400 hover:text-zinc-300 hover:border-zinc-700 transition-all"
            >
              Edit
            </Button>
            <Button
              variant="ghost" onClick={() => setShowConfirm(true)}
              className="px-2 py-1 rounded-lg text-xs text-red-400/60 hover:text-red-400 hover:bg-red-500/10 transition-all"
              title="Delete role"
            >
              <X className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>

        {/* chips */}
        {targets.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-2">
            {targets.map((target, tIdx) => (
              <div
                key={tIdx}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium"
                style={{
                  backgroundColor: `${roleMetaMap[target]?.color ?? '#6b7280'}20`,
                  borderColor: `${roleMetaMap[target]?.color ?? '#6b7280'}40`,
                  color: roleMetaMap[target]?.color ?? '#9ca3af',
                }}
              >
                <span className="text-zinc-500">→</span>
                <span>{target}</span>
              </div>
            ))}
          </div>
        )}

        {/* description */}
        {meta.description && (
          <p className="text-xs text-zinc-400 mt-1 mb-2">{meta.description}</p>
        )}

        {targets.length === 0 && (
          <p className="text-xs text-zinc-500 italic">
            No targets — this role cannot assign tasks to other roles
          </p>
        )}
      </div>
    </>
  );
}

/* ── main page ── */
export default function Hierarchy() {
  const { data: hierarchyQueryData, isLoading: loading, refetch: refetchHierarchy } = useHierarchy();
  const [hierarchy, setHierarchy] = useState<HierarchyData>({ rules: {}, roles: [] });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [jsonInput, setJsonInput] = useState('');
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [tab, setTab] = useState<'visual' | 'json'>('visual');

  // add-role inline form
  const [showAddRole, setShowAddRole] = useState(false);
  const [newRoleName, setNewRoleName] = useState('');
  const [addRoleError, setAddRoleError] = useState<string | null>(null);

  // build a lookup map: role name → metadata (excluding the role key)
  const roleMetaMap: Record<string, Omit<RoleMetadata, 'role'>> = {};
  for (const rm of hierarchy.roles) {
    roleMetaMap[rm.role] = { color: rm.color, description: rm.description, tier: rm.tier, icon: rm.icon ?? null };
  }

  // Sync query data to local hierarchy state
  useEffect(() => {
    if (!hierarchyQueryData) return;
    const data = hierarchyQueryData as HierarchyData;
    setHierarchy({ rules: data.rules ?? {}, roles: data.roles ?? [] });
    setJsonInput(JSON.stringify(data, null, 2));
    setError(null);
  }, [hierarchyQueryData]);

  async function loadHierarchy() {
    const result = await refetchHierarchy();
    if (result.error) {
      setError((result.error as Error).message);
    }
  }

  async function saveHierarchy(data?: Pick<HierarchyData, 'rules'>) {
    try {
      setJsonError(null);
      setSaving(true);

      const toSave = data ?? (tab === 'json' ? JSON.parse(jsonInput) : { rules: hierarchy.rules });

      if (!toSave.rules || typeof toSave.rules !== 'object') {
        throw new Error('Invalid format: must have a "rules" object');
      }

      await apiFetch('/api/hierarchy', {
        method: 'PUT',
        body: JSON.stringify({ rules: toSave.rules }),
      });

      setHierarchy((prev) => ({ ...prev, rules: toSave.rules }));
      setJsonInput(JSON.stringify({ rules: toSave.rules, roles: hierarchy.roles }, null, 2));
      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
    } catch (err: any) {
      setJsonError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function saveRoleMeta(role: string, meta: Omit<RoleMetadata, 'role'>) {
    await apiFetch(`/api/hierarchy/roles/${encodeURIComponent(role)}`, {
      method: 'PUT',
      body: JSON.stringify(meta),
    });
    // update local state
    setHierarchy((prev) => {
      const existing = prev.roles.filter((r) => r.role !== role);
      return { ...prev, roles: [...existing, { role, ...meta }] };
    });
  }

  async function handleRoleSave(role: string, targets: string[], meta: Omit<RoleMetadata, 'role'>) {
    try {
      setSaving(true);
      setJsonError(null);

      // save rules
      const updatedRules = { ...hierarchy.rules, [role]: targets };
      await apiFetch('/api/hierarchy', {
        method: 'PUT',
        body: JSON.stringify({ rules: updatedRules }),
      });

      // save metadata
      await saveRoleMeta(role, meta);

      setHierarchy((prev) => ({ ...prev, rules: updatedRules }));
      setJsonInput(JSON.stringify({ rules: updatedRules, roles: hierarchy.roles }, null, 2));
      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
    } catch (err: any) {
      setJsonError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleRoleDelete(role: string) {
    try {
      setSaving(true);
      setJsonError(null);

      // delete rules entry
      const updatedRules = { ...hierarchy.rules };
      delete updatedRules[role];
      await apiFetch('/api/hierarchy', {
        method: 'PUT',
        body: JSON.stringify({ rules: updatedRules }),
      });

      // delete role metadata
      await apiFetch(`/api/hierarchy/roles/${encodeURIComponent(role)}`, {
        method: 'DELETE',
      }).catch(() => {}); // ignore if no metadata existed

      setHierarchy((prev) => ({
        rules: updatedRules,
        roles: prev.roles.filter((r) => r.role !== role),
      }));
      setJsonInput(JSON.stringify({ rules: updatedRules, roles: hierarchy.roles.filter((r) => r.role !== role) }, null, 2));
      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
    } catch (err: any) {
      setJsonError(err.message);
    } finally {
      setSaving(false);
    }
  }

  function handleAddRole() {
    const sanitized = newRoleName.trim().toLowerCase().replace(/\s+/g, '-');
    if (!sanitized) {
      setAddRoleError('Role name cannot be empty');
      return;
    }
    if (hierarchy.rules[sanitized] !== undefined) {
      setAddRoleError(`Role "${sanitized}" already exists`);
      return;
    }
    // save rules with new empty role + default metadata
    handleRoleSave(sanitized, [], { ...DEFAULT_META });
    setNewRoleName('');
    setShowAddRole(false);
    setAddRoleError(null);
  }

  function handleJsonChange(value: string) {
    setJsonInput(value);
    setJsonError(null);
  }

  function syncJsonToVisual() {
    try {
      const parsed = JSON.parse(jsonInput);
      if (parsed.rules && typeof parsed.rules === 'object') {
        setHierarchy((prev) => ({
          rules: parsed.rules,
          roles: parsed.roles ?? prev.roles,
        }));
      }
    } catch {
      // ignore parse errors during editing
    }
  }

  if (loading) {
    return <LoadingState message="Loading hierarchy..." />;
  }

  const allRoles = Object.keys(hierarchy.rules);

  return (
    <div className="space-y-4 max-w-4xl mx-auto">
      {/* header */}
      <PageHeader icon={GitBranchIcon} title="Role Hierarchy" subtitle="Define which roles can assign tasks to other roles.">
        {tab === 'json' && (
          <>
            <Button
              onClick={() => saveHierarchy()}
              disabled={saving}
              className="bg-violet-600 hover:bg-violet-700 text-white text-sm px-4 h-9 disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save JSON'}
            </Button>
            <Button
              variant="ghost" onClick={loadHierarchy}
              className="px-4 py-2 rounded-lg border border-zinc-800 text-zinc-400 text-sm hover:border-zinc-700 hover:text-zinc-300 transition-all"
            >
              Reset
            </Button>
          </>
        )}
      </PageHeader>

      {error && (
        <div className="rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 p-3 text-sm">
          {error}
        </div>
      )}

      {success && (
        <div className="rounded-lg bg-green-500/10 border border-green-500/30 text-green-400 p-3 text-sm">
          Hierarchy saved successfully!
        </div>
      )}

      {jsonError && (
        <div className="rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 p-3 text-sm">
          {jsonError}
        </div>
      )}

      {/* Tab switcher */}
      <Tabs
        value={tab}
        onValueChange={(v) => {
          const newTab = v as 'visual' | 'json';
          if (newTab === 'visual') syncJsonToVisual();
          if (newTab === 'json') setJsonInput(JSON.stringify(hierarchy, null, 2));
          setTab(newTab);
        }}
      >
        <TabsList>
          <TabsTrigger value="visual">Visual</TabsTrigger>
          <TabsTrigger value="json">JSON</TabsTrigger>
        </TabsList>

        {/* Visual tab */}
        <TabsContent value="visual">
          <div className="space-y-3">
            {/* Add role */}
            <Button
              variant="ghost"
              onClick={() => {
                setShowAddRole(true);
                setAddRoleError(null);
              }}
              className="w-full sm:w-auto px-4 py-2 rounded-lg border border-dashed border-zinc-700 text-zinc-400 text-sm hover:border-purple-500/40 hover:text-purple-300 transition-all"
            >
              + Add Role
            </Button>

            <Dialog
              open={showAddRole}
              onOpenChange={(open) => {
                if (!open) { setShowAddRole(false); setNewRoleName(''); setAddRoleError(null); }
              }}
            >
              <DialogContent className="sm:max-w-md">
                <DialogHeader>
                  <DialogTitle>Add Role</DialogTitle>
                </DialogHeader>
                <div className="space-y-3">
                  <Input
                    autoFocus
                    type="text"
                    placeholder="Role name (e.g. qa-engineer)"
                    value={newRoleName}
                    onChange={(e) => {
                      setNewRoleName(e.target.value);
                      setAddRoleError(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleAddRole();
                      if (e.key === 'Escape') { setShowAddRole(false); setNewRoleName(''); setAddRoleError(null); }
                    }}
                    className="flex-1 min-w-0 px-3 py-2 text-sm rounded-lg border border-zinc-800 bg-black/20 text-zinc-300 placeholder-gray-600 focus:outline-none focus:border-purple-500/50 transition-all"
                  />
                  {addRoleError && (
                    <p className="text-xs text-red-400">{addRoleError}</p>
                  )}
                </div>
                <DialogFooter>
                  <Button
                    variant="ghost"
                    onClick={() => { setShowAddRole(false); setNewRoleName(''); setAddRoleError(null); }}
                    className="px-4 py-2 rounded-lg border border-zinc-800 text-zinc-400 text-sm hover:border-zinc-700 hover:text-zinc-300 transition-all"
                  >
                    Cancel
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={handleAddRole}
                    disabled={!newRoleName.trim()}
                    className="px-4 py-2 rounded-lg bg-purple-500/20 border border-purple-500/30 text-purple-300 text-sm font-medium hover:bg-purple-500/30 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    Create
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>

            {/* empty state */}
            {allRoles.length === 0 && (
              <div className="flex flex-col items-center justify-center py-16 text-zinc-600">
                <svg
                  className="w-10 h-10 mb-3 opacity-40"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z"
                  />
                </svg>
                <p className="text-sm">No roles defined. Add one to get started.</p>
              </div>
            )}

            {/* role cards */}
            {Object.entries(hierarchy.rules).map(([role, targets]) => (
              <RoleCard
                key={role}
                role={role}
                targets={targets}
                meta={roleMetaMap[role] ?? { ...DEFAULT_META }}
                allRoles={allRoles}
                roleMetaMap={roleMetaMap}
                onSave={handleRoleSave}
                onDelete={handleRoleDelete}
              />
            ))}
          </div>
        </TabsContent>

        {/* JSON tab */}
        <TabsContent value="json">
          <div className="rounded-lg bg-zinc-800/50 border border-zinc-800 backdrop-blur-sm p-4">
            <Textarea
              value={jsonInput}
              onChange={(e) => handleJsonChange(e.target.value)}
              className="w-full h-[500px] bg-black/30 text-zinc-300 font-mono text-sm p-4 rounded-lg border border-zinc-800 focus:border-purple-500/50 focus:outline-none resize-none transition-all"
              spellCheck={false}
            />
          </div>
        </TabsContent>
      </Tabs>

      {/* info panel */}
      <div className="rounded-lg bg-zinc-800/50 border border-zinc-800 backdrop-blur-sm p-4">
        <h3 className="font-semibold text-sm text-zinc-300 mb-2">
          How it works
        </h3>
        <ul className="list-disc list-inside space-y-1 text-xs text-zinc-400">
          <li>Define which roles can assign tasks to other roles</li>
          <li>
            A role can only spawn or delegate work to roles listed as its targets
          </li>
          <li>
            Use &quot;operator&quot; as a target to allow escalation back to the top-level role
          </li>
          <li>
            Click <strong>Edit</strong> on any role to modify its targets, then{' '}
            <strong>Save</strong> to apply
          </li>
        </ul>
      </div>
    </div>
  );
}
