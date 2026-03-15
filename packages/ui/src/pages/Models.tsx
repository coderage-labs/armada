import { useEffect, useState, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ModelRegistryEntryWithUsage, ModelProvider } from '@coderage-labs/armada-shared';
import { apiFetch } from '../hooks/useApi';
import { useAuth } from '../hooks/useAuth';
import { useModels } from '../hooks/queries/useModels';
import { useModelUsage } from '../hooks/queries/useModelUsage';
import { usePendingStyle } from '../hooks/usePendingStyle';
import type { PendingFields } from '../hooks/usePendingStyle';
import { PendingBadge } from '../components/PendingBadge';
import { Plus, Pencil, Trash2, Cpu, Search, Loader2, Server, BarChart2 } from 'lucide-react';
import { PageHeader } from '../components/PageHeader';
import ConfirmDialog from '../components/ConfirmDialog';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Input } from '../components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { RowSkeleton } from '../components/ui/skeleton';
import { EmptyState } from '../components/EmptyState';
import { Table, TableHeader, TableBody, TableHead, TableRow, TableCell } from '../components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../components/ui/responsive-dialog';
import type { UsagePeriod } from '../hooks/queries/useUsage';

interface DiscoveredModel {
  modelId: string;
  name: string;
  description?: string;
  maxTokens?: number;
  capabilities?: string[];
}

type ModelWithPending = ModelRegistryEntryWithUsage & {
  pendingAction?: 'create' | 'update' | 'delete' | null;
  pendingFields?: PendingFields | null;
};

const COST_TIER_COLORS: Record<string, string> = {
  cheap: 'bg-green-500/20 text-green-300',
  standard: 'bg-blue-500/20 text-blue-300',
  premium: 'bg-amber-500/20 text-amber-300',
};

const CAPABILITY_COLORS: Record<string, string> = {
  tools: 'bg-violet-500/20 text-violet-300',
  thinking: 'bg-cyan-500/20 text-cyan-300',
  vision: 'bg-pink-500/20 text-pink-300',
};

const PROVIDER_COLORS: Record<string, string> = {
  anthropic: 'bg-violet-500/20 text-violet-300',
  openai: 'bg-green-500/20 text-green-300',
  google: 'bg-blue-500/20 text-blue-300',
  openrouter: 'bg-orange-500/20 text-orange-300',
};

interface FormData {
  name: string;
  providerId: string;
  modelId: string;
  description: string;
  apiKeyEnvVar: string;
  capabilities: string[];
  maxTokens: string;
  costTier: string;
}

const emptyForm: FormData = {
  name: '',
  providerId: '',
  modelId: '',
  description: '',
  apiKeyEnvVar: '',
  capabilities: [],
  maxTokens: '',
  costTier: 'standard',
};

const CAPABILITIES = ['tools', 'thinking', 'vision', 'image-generation'];

// ── Helpers ───────────────────────────────────────────────────────────

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}

function formatRelativeDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso.replace(' ', 'T'));
  const now = Date.now();
  const diff = now - d.getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(diff / 3_600_000);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(diff / 86_400_000);
  return `${days}d ago`;
}

// ── UsageBar ─────────────────────────────────────────────────────────

interface UsageBarProps {
  value: number;
  max: number;
}

function UsageBar({ value, max }: UsageBarProps) {
  if (max === 0) return <div className="h-1 w-16 bg-zinc-800 rounded-full" />;
  const pct = Math.min(100, (value / max) * 100);
  return (
    <div className="h-1 w-16 bg-zinc-800 rounded-full overflow-hidden">
      <div
        className="h-full bg-violet-500/70 rounded-full transition-all"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

// ── Model detail dialog ───────────────────────────────────────────────

interface ModelDetailDialogProps {
  model: ModelWithPending | null;
  period: UsagePeriod;
  open: boolean;
  onClose: () => void;
}

function ModelDetailDialog({ model, period, open, onClose }: ModelDetailDialogProps) {
  const { data: usage, isLoading } = useModelUsage(model?.id ?? null, period);

  if (!model) return null;

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Cpu className="w-4 h-4 text-violet-400" />
            {model.name}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Model info */}
          <div className="rounded-lg bg-zinc-800/50 border border-zinc-700/50 p-4 space-y-2.5">
            <div className="flex justify-between text-sm">
              <span className="text-zinc-500">Provider</span>
              <Badge className={`text-xs px-2 py-0.5 rounded-full ${PROVIDER_COLORS[model.provider] ?? 'bg-zinc-500/20 text-zinc-300'}`}>
                {model.provider}
              </Badge>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-zinc-500">Model ID</span>
              <span className="text-zinc-300 font-mono text-xs">{model.modelId}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-zinc-500">Cost Tier</span>
              <Badge className={`text-xs px-2 py-0.5 rounded-full ${COST_TIER_COLORS[model.costTier] ?? 'bg-zinc-500/20 text-zinc-300'}`}>
                {model.costTier}
              </Badge>
            </div>
            {model.maxTokens && (
              <div className="flex justify-between text-sm">
                <span className="text-zinc-500">Max Tokens</span>
                <span className="text-zinc-300">{model.maxTokens.toLocaleString()}</span>
              </div>
            )}
            {model.capabilities.length > 0 && (
              <div className="flex justify-between text-sm">
                <span className="text-zinc-500">Capabilities</span>
                <div className="flex gap-1">
                  {model.capabilities.map((cap: string) => (
                    <span key={cap} className={`text-xs px-1.5 py-0.5 rounded-full ${CAPABILITY_COLORS[cap] ?? 'bg-zinc-500/20 text-zinc-300'}`}>
                      {cap}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {model.description && (
              <p className="text-xs text-zinc-500 pt-1">{model.description}</p>
            )}
          </div>

          {/* Usage stats */}
          <div>
            <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2 flex items-center gap-1.5">
              <BarChart2 className="w-3.5 h-3.5" />
              Usage ({period === 'all' ? 'all time' : `last ${period}`})
            </h3>
            {isLoading ? (
              <div className="flex items-center gap-2 text-sm text-zinc-500 py-2">
                <Loader2 className="w-4 h-4 animate-spin" /> Loading…
              </div>
            ) : (
              <div className="rounded-lg bg-zinc-800/50 border border-zinc-700/50 p-4 grid grid-cols-2 gap-4">
                <div>
                  <p className="text-xs text-zinc-500 mb-0.5">Total Tokens</p>
                  <p className="text-lg font-semibold text-zinc-200">{formatTokens(usage?.totalTokens ?? 0)}</p>
                </div>
                <div>
                  <p className="text-xs text-zinc-500 mb-0.5">Requests</p>
                  <p className="text-lg font-semibold text-zinc-200">{(usage?.requestCount ?? 0).toLocaleString()}</p>
                </div>
                <div>
                  <p className="text-xs text-zinc-500 mb-0.5">Input Tokens</p>
                  <p className="text-sm font-medium text-zinc-300">{formatTokens(usage?.inputTokens ?? 0)}</p>
                </div>
                <div>
                  <p className="text-xs text-zinc-500 mb-0.5">Output Tokens</p>
                  <p className="text-sm font-medium text-zinc-300">{formatTokens(usage?.outputTokens ?? 0)}</p>
                </div>
                <div>
                  <p className="text-xs text-zinc-500 mb-0.5">Estimated Cost</p>
                  <p className="text-sm font-medium text-zinc-300">${(usage?.costUsd ?? 0).toFixed(4)}</p>
                </div>
                <div>
                  <p className="text-xs text-zinc-500 mb-0.5">Last Used</p>
                  <p className="text-sm font-medium text-zinc-300">{formatRelativeDate(usage?.lastUsed ?? null)}</p>
                </div>
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Model row ─────────────────────────────────────────────────────────

interface ModelRowProps {
  m: ModelWithPending;
  maxTokens: number;
  onEdit: (m: ModelWithPending) => void;
  onDelete: (m: ModelWithPending) => void;
  onViewDetail: (m: ModelWithPending) => void;
}

function ModelRow({ m, maxTokens, onEdit, onDelete, onViewDetail }: ModelRowProps) {
  const { pf, rowClass } = usePendingStyle(m.pendingFields, m.pendingAction);

  return (
    <TableRow className={`border-b border-zinc-800/50 hover:bg-zinc-800/40 transition-colors ${rowClass}`}>
      <TableCell>
        <div className="flex items-center gap-2">
          <span className={pf('name', 'text-sm font-medium text-zinc-200')}>{m.name}</span>
          {m.pendingAction && <PendingBadge action={m.pendingAction} />}
        </div>
        {m.description && (
          <p className={pf('description', 'text-xs text-zinc-500 mt-0.5 truncate max-w-[200px]')}>{m.description}</p>
        )}
      </TableCell>
      <TableCell>
        <Badge className={`text-xs font-medium px-2 py-0.5 rounded-full ${PROVIDER_COLORS[m.provider] ?? 'bg-zinc-500/20 text-zinc-300'}`}>
          {m.provider}
        </Badge>
      </TableCell>
      <TableCell className="hidden md:table-cell">
        <span className={`text-xs font-mono ${pf('modelId', 'text-zinc-400')}`}>{m.modelId}</span>
      </TableCell>
      <TableCell className="hidden sm:table-cell">
        <Badge className={`text-xs font-medium px-2 py-0.5 rounded-full ${COST_TIER_COLORS[m.costTier] ?? 'bg-zinc-500/20 text-zinc-300'}`}>
          {m.costTier}
        </Badge>
      </TableCell>
      <TableCell className="hidden lg:table-cell">
        <div className="flex flex-wrap gap-1">
          {m.capabilities.map((cap: string) => (
            <span
              key={cap}
              className={`text-xs font-medium px-1.5 py-0.5 rounded-full ${CAPABILITY_COLORS[cap] ?? 'bg-zinc-500/20 text-zinc-300'}`}
            >
              {cap}
            </span>
          ))}
          {m.source === 'discovered' && (
            <Badge className="bg-teal-500/20 text-teal-300 text-xs">auto</Badge>
          )}
        </div>
      </TableCell>
      {/* Usage columns */}
      <TableCell className="hidden xl:table-cell">
        <div className="space-y-1">
          <span className="text-sm text-zinc-300">{formatTokens(m.usage.totalTokens)}</span>
          <UsageBar value={m.usage.totalTokens} max={maxTokens} />
        </div>
      </TableCell>
      <TableCell className="hidden xl:table-cell text-sm text-zinc-400">
        {m.usage.requestCount > 0 ? m.usage.requestCount.toLocaleString() : <span className="text-zinc-600">—</span>}
      </TableCell>
      <TableCell className="hidden xl:table-cell text-sm text-zinc-400">
        {formatRelativeDate(m.usage.lastUsed)}
      </TableCell>
      <TableCell>
        <div className="flex items-center justify-end gap-1">
          <Button
            variant="ghost"
            onClick={() => onViewDetail(m)}
            className="p-1.5 rounded-lg text-zinc-500 hover:text-violet-400 hover:bg-violet-500/10 transition-colors"
            title="View usage details"
          >
            <BarChart2 className="w-3.5 h-3.5" />
          </Button>
          <Button
            variant="ghost"
            onClick={() => onEdit(m)}
            className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-200 hover:bg-zinc-700/50 transition-colors"
          >
            <Pencil className="w-3.5 h-3.5" />
          </Button>
          <Button
            variant="ghost"
            onClick={() => onDelete(m)}
            className="p-1.5 rounded-lg text-zinc-500 hover:text-red-400 hover:bg-red-500/10 transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

// ── Main page ─────────────────────────────────────────────────────────

export default function Models() {
  const { hasScope } = useAuth();
  const canMutate = hasScope('models:write');
  const queryClient = useQueryClient();

  const [period, setPeriod] = useState<UsagePeriod>('week');
  const { data: models = [], isLoading: loading } = useModels(period);

  const [providers, setProviders] = useState<ModelProvider[]>([]);
  const [showDialog, setShowDialog] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState<FormData>({ ...emptyForm });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<{ title: string; message: string; onConfirm: () => void } | null>(null);

  // Detail dialog state
  const [detailModel, setDetailModel] = useState<ModelWithPending | null>(null);
  const [showDetail, setShowDetail] = useState(false);

  // Model discovery state
  const [discoveredModels, setDiscoveredModels] = useState<DiscoveredModel[]>([]);
  const [discoverLoading, setDiscoverLoading] = useState(false);
  const [discoverError, setDiscoverError] = useState<string | null>(null);
  const [modelSearch, setModelSearch] = useState('');
  const [useManualId, setUseManualId] = useState(false);

  const fetchProviders = useCallback(async () => {
    try {
      const data = await apiFetch<ModelProvider[]>('/api/providers');
      setProviders(data.filter(p => p.enabled));
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    fetchProviders();
  }, [fetchProviders]);

  // Compute max tokens across all models for sparkbar scaling
  const maxTokens = Math.max(...(models as ModelWithPending[]).map(m => m.usage?.totalTokens ?? 0), 1);

  // When provider changes, fetch full model list once
  const onProviderChange = useCallback(async (providerId: string) => {
    setForm(f => ({ ...f, providerId, modelId: '', name: '', description: '' }));
    setDiscoveredModels([]);
    setDiscoverError(null);
    setModelSearch('');
    setUseManualId(false);

    if (!providerId) return;

    setDiscoverLoading(true);
    try {
      const discovered = await apiFetch<DiscoveredModel[]>(`/api/providers/${providerId}/models`);
      setDiscoveredModels(discovered);
    } catch (e: any) {
      setDiscoverError(e.message || 'Failed to fetch models');
      setUseManualId(true);
    } finally {
      setDiscoverLoading(false);
    }
  }, []);

  const onModelSelect = (dm: DiscoveredModel) => {
    setForm(f => ({
      ...f,
      modelId: dm.modelId,
      name: f.name || dm.name,
      description: f.description || (dm.description ?? ''),
      maxTokens: f.maxTokens || (dm.maxTokens?.toString() ?? ''),
      capabilities: f.capabilities.length > 0 ? f.capabilities : (dm.capabilities ?? []),
    }));
  };

  const openCreate = () => {
    setForm({ ...emptyForm });
    setEditId(null);
    setError(null);
    setDiscoveredModels([]);
    setDiscoverError(null);
    setModelSearch('');
    setUseManualId(false);
    setShowDialog(true);
  };

  const openEdit = (m: ModelWithPending) => {
    setForm({
      name: m.name,
      providerId: m.providerId ?? '',
      modelId: m.modelId,
      description: m.description,
      apiKeyEnvVar: m.apiKeyEnvVar ?? '',
      capabilities: m.capabilities,
      maxTokens: m.maxTokens?.toString() ?? '',
      costTier: m.costTier,
    });
    setEditId(m.id);
    setError(null);
    setDiscoveredModels([]);
    setDiscoverError(null);
    setModelSearch('');
    setUseManualId(true); // Edit mode: show manual input by default
    setShowDialog(true);
  };

  const openDetail = (m: ModelWithPending) => {
    setDetailModel(m);
    setShowDetail(true);
  };

  const handleDelete = (m: ModelWithPending) => {
    setConfirmDialog({
      title: 'Delete Model',
      message: `Delete model "${m.name}"?`,
      onConfirm: async () => {
        setConfirmDialog(null);
        try {
          await apiFetch(`/api/models/${m.id}`, { method: 'DELETE' });
          queryClient.invalidateQueries();
        } catch (e: any) {
          alert(e.message);
        }
      },
    });
  };

  const handleSave = async () => {
    if (!form.name || !form.modelId) {
      setError('Name and model ID are required');
      return;
    }
    setSaving(true);
    setError(null);

    // Derive provider string from selected provider
    const selectedProvider = providers.find(p => p.id === form.providerId);
    const providerType = selectedProvider?.type ?? form.providerId;

    try {
      const body = {
        name: form.name,
        provider: providerType,
        modelId: form.modelId,
        description: form.description,
        apiKeyEnvVar: form.apiKeyEnvVar || null,
        capabilities: form.capabilities,
        maxTokens: form.maxTokens ? parseInt(form.maxTokens, 10) : null,
        costTier: form.costTier,
        providerId: form.providerId || null,
      };

      if (editId) {
        await apiFetch(`/api/models/${editId}`, {
          method: 'PUT',
          body: JSON.stringify(body),
        });
      } else {
        await apiFetch('/api/models', {
          method: 'POST',
          body: JSON.stringify(body),
        });
      }
      queryClient.invalidateQueries();
      setShowDialog(false);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const toggleCapability = (cap: string) => {
    setForm(prev => ({
      ...prev,
      capabilities: prev.capabilities.includes(cap)
        ? prev.capabilities.filter(c => c !== cap)
        : [...prev.capabilities, cap],
    }));
  };

  const filteredModels = discoveredModels.filter(dm =>
    !modelSearch ||
    dm.modelId.toLowerCase().includes(modelSearch.toLowerCase()) ||
    dm.name.toLowerCase().includes(modelSearch.toLowerCase())
  );
  const labelCls = 'block text-sm font-medium text-zinc-300 mb-1.5';

  return (
    <div className="space-y-6">
      <PageHeader icon={Cpu} title="Model Registry" subtitle="Manage AI models available for Armada agents">
        <div className="flex items-center gap-2">
          <Select value={period} onValueChange={(v) => setPeriod(v as UsagePeriod)}>
            <SelectTrigger className="w-28 h-9 text-sm bg-zinc-800 border-zinc-700">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="day">24h</SelectItem>
              <SelectItem value="week">7 days</SelectItem>
              <SelectItem value="month">30 days</SelectItem>
              <SelectItem value="all">All time</SelectItem>
            </SelectContent>
          </Select>
          {canMutate && (
            <Button
              onClick={openCreate}
              className="bg-violet-600 hover:bg-violet-700 text-white text-sm px-4 h-9"
            >
              <Plus className="w-4 h-4 mr-1.5" /> Add Model
            </Button>
          )}
        </div>
      </PageHeader>

      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50">
        <Table>
          <TableHeader>
            <TableRow className="border-b border-zinc-800">
              <TableHead className="text-left text-[11px] text-zinc-500 uppercase tracking-wider">Model</TableHead>
              <TableHead className="text-left text-[11px] text-zinc-500 uppercase tracking-wider">Provider</TableHead>
              <TableHead className="text-left text-[11px] text-zinc-500 uppercase tracking-wider hidden md:table-cell">Model ID</TableHead>
              <TableHead className="text-left text-[11px] text-zinc-500 uppercase tracking-wider hidden sm:table-cell">Cost</TableHead>
              <TableHead className="text-left text-[11px] text-zinc-500 uppercase tracking-wider hidden lg:table-cell">Capabilities</TableHead>
              <TableHead className="text-left text-[11px] text-zinc-500 uppercase tracking-wider hidden xl:table-cell">Tokens</TableHead>
              <TableHead className="text-left text-[11px] text-zinc-500 uppercase tracking-wider hidden xl:table-cell">Requests</TableHead>
              <TableHead className="text-left text-[11px] text-zinc-500 uppercase tracking-wider hidden xl:table-cell">Last Used</TableHead>
              <TableHead className="text-[11px] text-zinc-500 uppercase tracking-wider"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <>
                <RowSkeleton cols={9} />
                <RowSkeleton cols={9} />
                <RowSkeleton cols={9} />
                <RowSkeleton cols={9} />
                <RowSkeleton cols={9} />
              </>
            ) : models.length === 0 ? (
              <TableRow>
                <TableCell colSpan={9}>
                  <EmptyState
                    icon={Cpu}
                    title="No models in registry"
                    description="Add a model to get started"
                    action={canMutate ? { label: 'Add Model', onClick: openCreate } : undefined}
                  />
                </TableCell>
              </TableRow>
            ) : (
              (models as ModelWithPending[]).map((m) => (
                <ModelRow
                  key={m.id}
                  m={m}
                  maxTokens={maxTokens}
                  onEdit={openEdit}
                  onDelete={handleDelete}
                  onViewDetail={openDetail}
                />
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Model detail / usage dialog */}
      <ModelDetailDialog
        model={detailModel}
        period={period}
        open={showDetail}
        onClose={() => setShowDetail(false)}
      />

      {/* Create/Edit Dialog */}
      <Dialog open={showDialog} onOpenChange={(open) => !open && setShowDialog(false)}>
        <DialogContent className="sm:max-w-lg sm:max-h-[90vh] sm:overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editId ? 'Edit Model' : 'Add Model'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {error && (
              <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-300 text-sm">{error}</div>
            )}

            {providers.filter(p => p.enabled && (p as any).configured).length === 0 ? (
              <div className="py-8 text-center space-y-3">
                <Server className="w-10 h-10 mx-auto text-zinc-600" />
                <p className="text-sm text-zinc-400">No providers configured yet.</p>
                <p className="text-xs text-zinc-500">Add an API key to at least one provider before creating models.</p>
                <a href="/providers" className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-sm font-medium transition-colors">
                  Go to Providers
                </a>
              </div>
            ) : (<>
            {/* Provider dropdown */}
            <div>
              <label className={labelCls}>Provider *</label>
              <Select value={form.providerId || undefined} onValueChange={onProviderChange}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a provider…" />
                </SelectTrigger>
                <SelectContent>
                  {providers.filter(p => p.enabled && (p as any).configured).map(p => (
                    <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Model selection */}
            {form.providerId && (
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-sm font-medium text-zinc-300">Model *</label>
                  {!useManualId && discoveredModels.length > 0 && (
                    <Button
                      variant="ghost" type="button"
                      onClick={() => setUseManualId(true)}
                      className="text-xs text-zinc-500 hover:text-zinc-300 underline"
                    >
                      Enter ID manually
                    </Button>
                  )}
                  {useManualId && !discoverLoading && (
                    <Button
                      variant="ghost" type="button"
                      onClick={() => { setUseManualId(false); if (form.providerId && discoveredModels.length === 0) onProviderChange(form.providerId); }}
                      className="text-xs text-zinc-500 hover:text-zinc-300 underline"
                    >
                      Pick from list
                    </Button>
                  )}
                </div>

                {useManualId || discoverError ? (
                  <>
                    {discoverError && (
                      <div className="text-xs text-amber-400 mb-1.5">{discoverError} — enter model ID manually</div>
                    )}
                    <Input
                      value={form.modelId}
                      onChange={(e) => setForm(f => ({ ...f, modelId: e.target.value }))}
                      placeholder="claude-sonnet-4-5"
                    />
                  </>
                ) : (
                  <div className="space-y-2">
                    <div className="relative">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
                      <Input
                        className="w-full bg-zinc-800 border border-zinc-800 focus:border-violet-500 focus:outline-none rounded-lg py-2 pl-9 pr-3 text-white placeholder-gray-500 text-sm transition-colors"
                        placeholder="Search models…"
                        value={modelSearch}
                        onChange={(e) => setModelSearch(e.target.value)}
                      />
                    </div>
                    <div className="max-h-48 overflow-y-auto rounded-lg border border-zinc-800 divide-y divide-white/5">
                      {discoverLoading ? (
                        <div className="flex items-center gap-2 px-3 py-3 text-sm text-zinc-400">
                          <Loader2 className="w-4 h-4 animate-spin" />
                          Loading models…
                        </div>
                      ) : filteredModels.length === 0 ? (
                        <div className="px-3 py-2 text-sm text-zinc-500">{modelSearch ? 'No models found' : 'Type to search…'}</div>
                      ) : filteredModels.map(dm => (
                        <Button
                          variant="ghost" key={dm.modelId}
                          type="button"
                          onClick={() => onModelSelect(dm)}
                          className={`w-full text-left px-3 py-2 hover:bg-zinc-800/50 transition-colors ${form.modelId === dm.modelId ? 'bg-violet-500/10' : ''}`}
                        >
                          <div className="text-sm text-zinc-200 font-mono">{dm.modelId}</div>
                          {dm.name !== dm.modelId && (
                            <div className="text-xs text-zinc-500">{dm.name}</div>
                          )}
                        </Button>
                      ))}
                    </div>
                    {form.modelId && (
                      <div className="text-xs text-violet-400">Selected: {form.modelId}</div>
                    )}
                  </div>
                )}
              </div>
            )}

            <div>
              <label className={labelCls}>Name *</label>
              <Input value={form.name} onChange={(e) => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Claude Sonnet 4.5" />
            </div>

            <div>
              <label className={labelCls}>Description</label>
              <Input value={form.description} onChange={(e) => setForm(f => ({ ...f, description: e.target.value }))} placeholder="Brief description" />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className={labelCls}>Cost Tier</label>
                <Select value={form.costTier} onValueChange={(v) => setForm(f => ({ ...f, costTier: v }))}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="cheap">Cheap</SelectItem>
                    <SelectItem value="standard">Standard</SelectItem>
                    <SelectItem value="premium">Premium</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div>
              <label className={labelCls}>Capabilities</label>
              <div className="flex gap-2">
                {CAPABILITIES.map((cap) => (
                  <Button
                    variant="ghost" key={cap}
                    type="button"
                    onClick={() => toggleCapability(cap)}
                    className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                      form.capabilities.includes(cap)
                        ? 'bg-violet-500/20 text-violet-300 border border-violet-500/40'
                        : 'bg-zinc-800/50 text-zinc-400 border border-zinc-800 hover:bg-zinc-700/50'
                    }`}
                  >
                    {cap}
                  </Button>
                ))}
              </div>
            </div>

            <div>
              <label className={labelCls}>Max Tokens (optional)</label>
              <Input type="number" value={form.maxTokens} onChange={(e) => setForm(f => ({ ...f, maxTokens: e.target.value }))} placeholder="200000" />
            </div>

            <div className="flex justify-end gap-3 pt-2">
              <Button variant="outline" onClick={() => setShowDialog(false)}>
                Cancel
              </Button>
              <Button variant="ghost" onClick={handleSave} disabled={saving} className="px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white font-medium transition-colors">
                {saving ? 'Saving…' : 'Save'}
              </Button>
            </div>
            </>)}
          </div>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!confirmDialog}
        title={confirmDialog?.title ?? ''}
        message={confirmDialog?.message ?? ''}
        confirmLabel="Delete"
        destructive
        onConfirm={() => confirmDialog?.onConfirm()}
        onCancel={() => setConfirmDialog(null)}
      />
    </div>
  );
}
