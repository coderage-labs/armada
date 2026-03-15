import { useState, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ModelProvider, ProviderApiKey } from '@coderage-labs/armada-shared';
import { apiFetch } from '../hooks/useApi';
import { useAuth } from '../hooks/useAuth';
import { useProviders } from '../hooks/queries/useProviders';
import { useMutationActions } from '../hooks/useMutationActions';
import { PendingBadge } from '../components/PendingBadge';
import { usePendingStyle } from '../hooks/usePendingStyle';
import type { PendingFields } from '../hooks/usePendingStyle';
import { formatDateTime } from '../lib/dates';
import {
  Server, CheckCircle, XCircle, Zap, Plus, Trash2, Star, StarOff,
  ChevronDown, ChevronUp, Eye, EyeOff, Pencil, Save, ArrowUp, ArrowDown,
} from 'lucide-react';
import { PageHeader } from '../components/PageHeader';
import ConfirmDialog from '../components/ConfirmDialog';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Input } from '../components/ui/input';
import { Switch } from '../components/ui/switch';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../components/ui/responsive-dialog';
import { toast } from 'sonner';

const PROVIDER_COLORS: Record<string, string> = {
  anthropic: 'bg-violet-500/20 text-violet-300',
  openai: 'bg-green-500/20 text-green-300',
  google: 'bg-blue-500/20 text-blue-300',
  openrouter: 'bg-orange-500/20 text-orange-300',
  bedrock: 'bg-amber-500/20 text-amber-300',
  ollama: 'bg-cyan-500/20 text-cyan-300',
  'openai-compat': 'bg-emerald-500/20 text-emerald-300',
  'github-copilot': 'bg-zinc-500/20 text-zinc-300',
};

const labelCls = 'block text-sm font-medium text-zinc-400 mb-1';

// ── Add/Edit key form ─────────────────────────────────────────────────

interface KeyFormProps {
  providerId: string;
  existing?: ProviderApiKey;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
  onCancel: () => void;
}

function KeyForm({ providerId, existing, open, onOpenChange, onDone, onCancel }: KeyFormProps) {
  const [name, setName] = useState(existing?.name ?? '');
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    if (!name.trim()) { setError('Name is required'); return; }
    if (!existing && !apiKey.trim()) { setError('API key is required'); return; }
    setSaving(true);
    setError(null);
    try {
      if (existing) {
        const body: any = { name };
        if (apiKey.trim()) body.apiKey = apiKey;
        await apiFetch(`/api/providers/${providerId}/keys/${existing.id}`, {
          method: 'PUT', body: JSON.stringify(body),
        });
      } else {
        await apiFetch(`/api/providers/${providerId}/keys`, {
          method: 'POST', body: JSON.stringify({ name, apiKey }),
        });
      }
      onDone();
    } catch (e: any) {
      setError(e.message || 'Failed to save');
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{existing ? 'Edit Key' : 'Add API Key'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <label className={labelCls}>Name</label>
            <Input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. Personal, Work - Fixli"
              autoFocus
            />
          </div>
          <div>
            <label className={labelCls}>{existing ? 'New API Key (leave blank to keep existing)' : 'API Key'}</label>
            <div className="relative">
              <Input
                className="pr-10"
                type={showKey ? 'text' : 'password'}
                value={apiKey}
                onChange={e => setApiKey(e.target.value)}
                placeholder={existing ? '••••••••' : 'sk-…'}
                autoComplete="new-password"
              />
              <Button
                variant="ghost" type="button"
                onClick={() => setShowKey(v => !v)}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300"
              >
                {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </Button>
            </div>
          </div>
          {error && <div className="text-xs px-3 py-2 rounded-lg bg-red-500/10 text-red-300">{error}</div>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={saving}
            className="bg-violet-600 hover:bg-violet-700 text-white"
          >
            <Save className="w-3.5 h-3.5 mr-1.5" />
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Priority badge helper ─────────────────────────────────────────────

const PRIORITY_LABELS: Record<number, string> = { 0: '1st', 1: '2nd', 2: '3rd' };
function priorityLabel(index: number): string {
  return PRIORITY_LABELS[index] ?? `${index + 1}th`;
}

// ── Key row ───────────────────────────────────────────────────────────

interface KeyRowProps {
  k: ProviderApiKey & { pendingAction?: string | null; pendingFields?: PendingFields | null };
  keyIndex: number;
  totalKeys: number;
  providerId: string;
  canMutate: boolean;
  onRefresh: () => void;
}

function KeyRow({ k, keyIndex, totalKeys, providerId, canMutate, onRefresh }: KeyRowProps) {
  const { pf, iconPf, isFieldPending, cardClass } = usePendingStyle(k.pendingFields, k.pendingAction);
  const [editing, setEditing] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [settingDefault, setSettingDefault] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [reordering, setReordering] = useState(false);

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await apiFetch<{ ok: boolean; message: string }>(`/api/providers/${providerId}/keys/${k.id}/test`, { method: 'POST' });
      setTestResult(result);
    } catch (e: any) {
      setTestResult({ ok: false, message: e.message || 'Test failed' });
    }
    setTesting(false);
  };

  const handleSetDefault = async () => {
    setSettingDefault(true);
    try {
      await apiFetch(`/api/providers/${providerId}/keys/${k.id}/default`, { method: 'POST' });
      onRefresh();
    } catch { /* ignore */ }
    setSettingDefault(false);
  };

  const handleDelete = async () => {
    try {
      await apiFetch(`/api/providers/${providerId}/keys/${k.id}`, { method: 'DELETE' });
      onRefresh();
    } catch { /* ignore */ }
  };

  const handleMovePriority = async (direction: 'up' | 'down') => {
    setReordering(true);
    try {
      const newPriority = direction === 'up' ? Math.max(0, keyIndex - 1) : keyIndex + 1;
      await apiFetch(`/api/providers/${providerId}/keys/${k.id}/priority`, {
        method: 'PUT',
        body: JSON.stringify({ priority: newPriority }),
      });
      onRefresh();
      toast.success(`Key "${k.name}" moved ${direction}`);
    } catch (e: any) {
      toast.error(e.message || 'Failed to update priority');
    }
    setReordering(false);
  };

  return (
    <>
      <KeyForm
        providerId={providerId}
        existing={k}
        open={editing}
        onOpenChange={setEditing}
        onDone={() => { setEditing(false); onRefresh(); }}
        onCancel={() => setEditing(false)}
      />
      <div className={`flex items-center gap-3 py-2 px-3 rounded-lg bg-zinc-800/50 hover:bg-zinc-800/50 transition-colors group ${cardClass}`}>
        {/* Priority badge */}
        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-zinc-700/60 text-zinc-400 shrink-0 w-7 text-center">
          {priorityLabel(keyIndex)}
        </span>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className={pf('name', 'text-sm text-zinc-200 font-medium truncate')}>{k.name}</span>
            {k.pendingAction && <PendingBadge action={k.pendingAction as 'create' | 'update' | 'delete'} />}
            {k.isDefault === 1 && (
              <span className={isFieldPending('isDefault')
                ? 'text-xs px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-400 font-medium shrink-0'
                : 'text-xs px-1.5 py-0.5 rounded-full bg-violet-500/20 text-violet-300 font-medium shrink-0'
              }>
                default
              </span>
            )}
          </div>
          <div className="text-xs text-zinc-500 font-mono">{k.apiKey ?? '••••••'}</div>
        </div>
        {canMutate && (
          <div className="flex items-center gap-1">
            {/* Priority reorder */}
            {totalKeys > 1 && (
              <>
                <Button
                  variant="ghost" onClick={() => handleMovePriority('up')}
                  disabled={reordering || keyIndex === 0}
                  title="Move up (higher priority)"
                  className="p-1.5 rounded hover:bg-zinc-700/50 text-zinc-600 hover:text-zinc-300 disabled:opacity-30 transition-colors"
                >
                  <ArrowUp className="w-3.5 h-3.5" />
                </Button>
                <Button
                  variant="ghost" onClick={() => handleMovePriority('down')}
                  disabled={reordering || keyIndex === totalKeys - 1}
                  title="Move down (lower priority)"
                  className="p-1.5 rounded hover:bg-zinc-700/50 text-zinc-600 hover:text-zinc-300 disabled:opacity-30 transition-colors"
                >
                  <ArrowDown className="w-3.5 h-3.5" />
                </Button>
              </>
            )}
            {k.isDefault !== 1 && (
              <Button
                variant="ghost" onClick={handleSetDefault}
                disabled={settingDefault}
                title="Set as default"
                className="p-1.5 rounded hover:bg-zinc-700/50 text-zinc-500 hover:text-violet-400 transition-colors"
              >
                <Star className={iconPf('isDefault', 'w-3.5 h-3.5')} />
              </Button>
            )}
            {k.isDefault === 1 && (
              <span className={`p-1.5 ${isFieldPending('isDefault') ? 'text-amber-400' : 'text-violet-400'}`} title="Default key">
                <StarOff className="w-3.5 h-3.5" />
              </span>
            )}
            <Button
              variant="ghost" onClick={handleTest}
              disabled={testing}
              title="Test key"
              className="p-1.5 rounded hover:bg-zinc-700/50 text-zinc-500 hover:text-emerald-400 transition-colors"
            >
              <Zap className={`w-3.5 h-3.5 ${testing ? 'animate-pulse' : ''}`} />
            </Button>
            <Button
              variant="ghost" onClick={() => setEditing(true)}
              title="Edit"
              className="p-1.5 rounded hover:bg-zinc-700/50 text-zinc-500 hover:text-zinc-300 transition-colors"
            >
              <Pencil className="w-3.5 h-3.5" />
            </Button>
            <Button
              variant="ghost" onClick={() => setDeleteOpen(true)}
              title="Delete"
              className="p-1.5 rounded hover:bg-zinc-700/50 text-zinc-500 hover:text-red-400 transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </Button>
          </div>
        )}
      </div>
      {testResult && (
        <div className={`mx-3 mb-1 text-xs px-2 py-1 rounded ${testResult.ok ? 'bg-green-500/10 text-green-300' : 'bg-red-500/10 text-red-300'}`}>
          {testResult.ok ? '✓ ' : '✗ '}{testResult.message}
        </div>
      )}
      <ConfirmDialog
        open={deleteOpen}
        title="Delete API Key"
        message={`Delete key "${k.name}"? This cannot be undone.`}
        confirmLabel="Delete"
        destructive
        onConfirm={() => { setDeleteOpen(false); handleDelete(); }}
        onCancel={() => setDeleteOpen(false)}
      />
    </>
  );
}

// ── Provider edit dialog ──────────────────────────────────────────────

interface ProviderEditDialogProps {
  p: ModelProvider & { configured: boolean; pendingAction?: 'create' | 'update' | 'delete' | null; pendingFields?: PendingFields | null };
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRefresh: () => void;
  canMutate: boolean;
  stageMutation: (action: 'create' | 'update' | 'delete', payload: Record<string, any>, entityId?: string) => Promise<void>;
}

function ProviderEditDialog({ p, open, onOpenChange, onRefresh, canMutate, stageMutation }: ProviderEditDialogProps) {
  const [keysOpen, setKeysOpen] = useState(true);
  const [showAddForm, setShowAddForm] = useState(false);
  const [baseUrl, setBaseUrl] = useState(p.baseUrl ?? '');
  const [savingBase, setSavingBase] = useState(false);
  const [savingFallback, setSavingFallback] = useState(false);
  const { inputPf, isFieldPending } = usePendingStyle(p.pendingFields, p.pendingAction);

  const handleSaveBase = async () => {
    setSavingBase(true);
    try {
      await apiFetch(`/api/providers/${p.id}`, {
        method: 'PUT',
        body: JSON.stringify({ baseUrl: baseUrl || null }),
      });
      onRefresh();
    } catch { /* ignore */ }
    setSavingBase(false);
  };

  const handleToggleFallback = async (enabled: boolean) => {
    setSavingFallback(true);
    try {
      await apiFetch(`/api/providers/${p.id}`, {
        method: 'PUT',
        body: JSON.stringify({ fallbackEnabled: enabled }),
      });
      onRefresh();
      toast.success(enabled ? 'Automatic failover enabled' : 'Automatic failover disabled');
    } catch (e: any) {
      toast.error(e.message || 'Failed to update fallback setting');
    }
    setSavingFallback(false);
  };

  const handleChangeFallbackBehavior = async (behavior: 'immediate' | 'backoff') => {
    try {
      await apiFetch(`/api/providers/${p.id}`, {
        method: 'PUT',
        body: JSON.stringify({ fallbackBehavior: behavior }),
      });
      onRefresh();
      toast.success(`Failover behavior set to "${behavior}"`);
    } catch (e: any) {
      toast.error(e.message || 'Failed to update fallback behavior');
    }
  };

  // Sort keys by priority for display
  const keys = [...(p.keys ?? [])].sort((a, b) => a.priority - b.priority);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg sm:max-h-[90vh] sm:overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit {p.name}</DialogTitle>
        </DialogHeader>
        <div className="space-y-6">
          {/* Base URL section */}
          {canMutate && (
            <div>
              <label className={labelCls}>Base URL (optional — for proxies)</label>
              <div className="flex gap-2">
                <Input
                  className={inputPf('baseUrl')}
                  value={baseUrl}
                  onChange={e => setBaseUrl(e.target.value)}
                  placeholder={`https://api.${p.type}.com`}
                />
                <Button
                  variant="outline" onClick={handleSaveBase}
                  disabled={savingBase}
                  title="Save base URL"
                  className="px-3 py-2 rounded-lg bg-zinc-800/50 hover:bg-zinc-700/50 disabled:opacity-50 text-zinc-300 transition-colors shrink-0"
                >
                  <Save className="w-4 h-4" />
                </Button>
              </div>
            </div>
          )}

          {/* Fallback / automatic failover section */}
          {canMutate && (
            <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-zinc-200">Automatic Failover</p>
                  <p className="text-xs text-zinc-500 mt-0.5">
                    When enabled, Armada generates fallback config so OpenClaw switches to the next-priority key on rate-limit or billing errors.
                  </p>
                </div>
                <Switch
                  checked={p.fallbackEnabled === 1}
                  onCheckedChange={handleToggleFallback}
                  disabled={savingFallback || keys.length < 2}
                  aria-label="Toggle automatic failover"
                />
              </div>
              {keys.length < 2 && (
                <p className="text-[11px] text-amber-400/80">Add at least 2 API keys to enable failover.</p>
              )}
              {p.fallbackEnabled === 1 && keys.length >= 2 && (
                <div className="flex items-center gap-3 pt-1">
                  <span className="text-xs text-zinc-400">Behavior</span>
                  <div className="flex gap-2">
                    {(['immediate', 'backoff'] as const).map(b => (
                      <button
                        key={b}
                        onClick={() => handleChangeFallbackBehavior(b)}
                        className={`text-xs px-2.5 py-1 rounded-md border transition-colors ${
                          p.fallbackBehavior === b
                            ? 'bg-violet-600/20 border-violet-500/50 text-violet-300'
                            : 'border-zinc-700 text-zinc-500 hover:text-zinc-300 hover:border-zinc-600'
                        }`}
                      >
                        {b === 'immediate' ? 'Immediate' : 'Backoff'}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* API Keys section */}
          <div className="space-y-3">
            <Button
              variant="ghost"
              className="flex items-center justify-between w-full text-sm font-medium text-zinc-300 hover:text-white transition-colors"
              onClick={() => setKeysOpen(v => !v)}
            >
              <span className="flex items-center gap-2">
                API Keys
                {keys.length > 0 ? (
                  <span className="text-xs px-1.5 py-0.5 rounded-full bg-green-500/20 text-green-300">{keys.length}</span>
                ) : (
                  <span className="text-xs px-1.5 py-0.5 rounded-full bg-yellow-500/20 text-yellow-300">none</span>
                )}
              </span>
              {keysOpen ? <ChevronUp className="w-4 h-4 text-zinc-500" /> : <ChevronDown className="w-4 h-4 text-zinc-500" />}
            </Button>

            {keysOpen && (
              <div className="space-y-2">
                {keys.map((k, idx) => (
                  <KeyRow
                    key={k.id}
                    k={k}
                    keyIndex={idx}
                    totalKeys={keys.length}
                    providerId={p.id}
                    canMutate={canMutate}
                    onRefresh={onRefresh}
                  />
                ))}
                {keys.length === 0 && !showAddForm && (
                  <div className="text-xs text-zinc-600 text-center py-2">No keys configured</div>
                )}
                <KeyForm
                  providerId={p.id}
                  open={showAddForm}
                  onOpenChange={setShowAddForm}
                  onDone={() => { setShowAddForm(false); onRefresh(); }}
                  onCancel={() => setShowAddForm(false)}
                />
                {canMutate && (
                  <Button
                    onClick={() => setShowAddForm(true)}
                    className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-zinc-800/50 hover:bg-zinc-700/50 text-zinc-400 hover:text-zinc-200 transition-colors w-full justify-center border border-dashed border-zinc-800"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    Add Key
                  </Button>
                )}
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Provider card ─────────────────────────────────────────────────────

interface ProviderCardProps {
  p: ModelProvider & { configured: boolean; pendingAction?: 'create' | 'update' | 'delete' | null; pendingFields?: PendingFields | null };
  canMutate: boolean;
  onRefresh: () => void;
  stageMutation: (action: 'create' | 'update' | 'delete', payload: Record<string, any>, entityId?: string) => Promise<void>;
  removeMutation: (mutationId: string) => Promise<void>;
}

function ProviderCard({ p, canMutate, onRefresh, stageMutation, removeMutation }: ProviderCardProps) {
  const [editOpen, setEditOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const { pf, cardClass, accentClass } = usePendingStyle(p.pendingFields, p.pendingAction);

  const handleDelete = async () => {
    try {
      await apiFetch(`/api/providers/${p.id}`, { method: 'DELETE' });
      onRefresh();
    } catch { /* ignore */ }
  };

  const handleToggleEnabled = async () => {
    try {
      const newEnabled = p.enabled ? 0 : 1;
      await apiFetch(`/api/providers/${p.id}`, {
        method: 'PUT',
        body: JSON.stringify({ enabled: newEnabled }),
      });
      onRefresh();
    } catch { /* ignore */ }
  };

  const formatSync = () => {
    if (!p.lastSyncAt) return 'Never synced';
    return `Synced ${formatDateTime(p.lastSyncAt)}`;
  };

  const keys = p.keys ?? [];

  return (
    <div className={`relative overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/50 hover:border-zinc-700 transition-all duration-200 flex flex-col ${cardClass}`}>
      {/* Accent bar */}
      <div className={`absolute top-0 left-0 right-0 h-[2px] ${accentClass(p.enabled ? 'bg-emerald-500' : 'bg-zinc-600')}`} />

      {/* Header */}
      <div className="p-5 pb-0">
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-2">
              <h3 className={pf('name', 'text-base font-semibold text-zinc-100')}>{p.name}</h3>
              {p.pendingAction && <PendingBadge action={p.pendingAction} />}
            </div>
            <div className="flex items-center gap-2 mt-1">
              <Badge className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${PROVIDER_COLORS[p.type] || 'bg-zinc-500/20 text-zinc-400'}`}>
                {p.type}
              </Badge>
              <span className={pf('enabled', `inline-flex items-center gap-1 text-[11px] ${p.enabled ? 'text-emerald-400' : 'text-zinc-500'}`)}>
                {p.enabled ? <CheckCircle className="w-3 h-3" /> : <XCircle className="w-3 h-3" />}
                {p.enabled ? 'Enabled' : 'Disabled'}
              </span>
            </div>
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={deleteConfirm}
        title="Delete Provider"
        message={`Delete "${p.name}"? This will remove all associated API keys.`}
        confirmLabel="Delete"
        destructive
        onConfirm={handleDelete}
        onCancel={() => setDeleteConfirm(false)}
      />

      <ProviderEditDialog
        p={p}
        open={editOpen}
        onOpenChange={setEditOpen}
        onRefresh={onRefresh}
        canMutate={canMutate}
        stageMutation={stageMutation}
      />

      {/* Details */}
      <div className="p-5 pt-4 space-y-2.5 flex-1">
        <div className="flex items-center justify-between text-xs">
          <span className="text-zinc-500">Status</span>
          <span className="text-zinc-400">{formatSync()}</span>
        </div>
        <div className="flex items-center justify-between text-xs">
          <span className="text-zinc-500">Configured</span>
          <span className={p.configured ? 'text-emerald-400' : 'text-zinc-600'}>{p.configured ? 'Yes' : 'No'}</span>
        </div>
        <div className="flex items-center justify-between text-xs">
          <span className="text-zinc-500">API Keys</span>
          <span className={keys.length > 0 ? 'text-emerald-400' : 'text-zinc-600'}>
            {keys.length > 0 ? `${keys.length} key${keys.length !== 1 ? 's' : ''}` : 'None'}
          </span>
        </div>
        <div className="flex items-center justify-between text-xs">
          <span className="text-zinc-500">Failover</span>
          <span className={p.fallbackEnabled ? 'text-violet-400' : 'text-zinc-600'}>
            {p.fallbackEnabled ? `On · ${p.fallbackBehavior ?? 'immediate'}` : 'Off'}
          </span>
        </div>
      </div>

      {/* Actions footer */}
      <div className="border-t border-zinc-800/50 px-5 py-3 flex flex-wrap gap-2">
        {canMutate && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setEditOpen(true)}
            className="flex-1 text-xs h-8 gap-1.5 border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50"
          >
            <Pencil className="w-3 h-3" /> Edit
          </Button>
        )}
        {canMutate && (
          <Button
            variant="outline"
            size="sm"
            onClick={handleToggleEnabled}
            className="flex-1 text-xs h-8 gap-1.5 border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50"
          >
            {p.enabled ? <XCircle className="w-3 h-3" /> : <CheckCircle className="w-3 h-3" />}
            {p.enabled ? 'Disable' : 'Enable'}
          </Button>
        )}
        {canMutate && p.type === 'openai-compat' && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setDeleteConfirm(true)}
            className="flex-1 text-xs h-8 gap-1.5 border-red-500/20 text-red-400/70 hover:text-red-400 hover:bg-red-500/10 hover:border-red-500/40"
          >
            <Trash2 className="w-3 h-3" /> Delete
          </Button>
        )}
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────

export default function Providers() {
  const { hasScope } = useAuth();
  const canMutate = hasScope('system:write');
  const queryClient = useQueryClient();
  const { data: providers = [], isLoading: loading } = useProviders();
  /** Invalidate all caches — providers, changesets, bottom bar, everything */
  const fetchProviders = useCallback(() => queryClient.invalidateQueries(), [queryClient]);
  const [showAddCustom, setShowAddCustom] = useState(false);
  const [customName, setCustomName] = useState('');
  const [customUrl, setCustomUrl] = useState('');
  const [customSaving, setCustomSaving] = useState(false);
  const [customError, setCustomError] = useState<string | null>(null);

  const { stage: stageMutation, remove: removeMutation } = useMutationActions('provider');

  const handleAddCustom = useCallback(async () => {
    if (!customName.trim()) { setCustomError('Name is required'); return; }
    if (!customUrl.trim()) { setCustomError('Base URL is required'); return; }
    setCustomSaving(true);
    setCustomError(null);
    try {
      await stageMutation('create', { name: customName.trim(), baseUrl: customUrl.trim(), type: 'openai-compat' });
      setShowAddCustom(false);
      setCustomName('');
      setCustomUrl('');
    } catch (e: any) {
      setCustomError(e.message || 'Failed to create provider');
    } finally {
      setCustomSaving(false);
    }
  }, [customName, customUrl]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-2 border-violet-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Providers"
        subtitle="Configure API credentials for each AI provider."
        icon={Server}
      >
        {canMutate && (
          <Button
            onClick={() => setShowAddCustom(true)}
            className="bg-violet-600 hover:bg-violet-700 text-white text-sm px-4 h-9 gap-1.5"
          >
            <Plus className="w-4 h-4" />
            Add Custom Provider
          </Button>
        )}
      </PageHeader>

      <Dialog open={showAddCustom} onOpenChange={setShowAddCustom}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>New OpenAI-Compatible Provider</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className={labelCls}>Name *</label>
              <Input value={customName} onChange={e => setCustomName(e.target.value)} placeholder="e.g. Together AI, Groq, Fireworks" />
            </div>
            <div>
              <label className={labelCls}>Base URL *</label>
              <Input value={customUrl} onChange={e => setCustomUrl(e.target.value)} placeholder="https://api.together.xyz/v1" />
            </div>
            {customError && <div className="text-xs text-red-300 bg-red-500/10 px-3 py-2 rounded-lg">{customError}</div>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setShowAddCustom(false); setCustomError(null); }}>
              Cancel
            </Button>
            <Button
              onClick={handleAddCustom}
              disabled={customSaving}
              className="bg-violet-600 hover:bg-violet-700 text-white"
            >
              {customSaving ? 'Creating…' : 'Create'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-stretch">
        {providers.map(p => (
          <ProviderCard
            key={p.id}
            p={p as any}
            canMutate={canMutate}
            onRefresh={fetchProviders}
            stageMutation={stageMutation}
            removeMutation={removeMutation}
          />
        ))}
      </div>
    </div>
  );
}
