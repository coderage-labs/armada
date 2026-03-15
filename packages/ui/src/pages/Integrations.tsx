import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../hooks/useApi';
import { useAuth } from '../hooks/useAuth';
import { useIntegrations } from '../hooks/queries/useIntegrations';
import { usePendingStyle } from '../hooks/usePendingStyle';
import type { PendingFields } from '../hooks/usePendingStyle';
import { PendingBadge } from '../components/PendingBadge';
import {
  Plug, CheckCircle2, XCircle, Pencil, Trash2, FlaskConical, Hourglass,
  AlertCircle, GitBranch, GitPullRequest,
} from 'lucide-react';
import { PageHeader } from '../components/PageHeader';
import { Checkbox } from '../components/ui/checkbox';
import ConfirmDialog from '../components/ConfirmDialog';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Input } from '../components/ui/input';
import { Textarea } from '../components/ui/textarea';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '../components/ui/select';
import { EmptyState } from '../components/EmptyState';
import { CardGrid, BaseCard } from '../components/shared';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../components/ui/dialog';

/* ── Types ─────────────────────────────────────────── */

interface Integration {
  id: string;
  name: string;
  provider: string; // 'github' | 'jira' | 'bitbucket'
  authType: string; // 'api-token' | 'ssh-key'
  authConfig: any; // Encrypted/masked in responses
  capabilities: string[]; // ['issues', 'vcs']
  status: string; // 'active' | 'error' | 'expired'
  statusMessage: string | null;
  createdAt: string;
  updatedAt: string;
  pendingAction?: string | null;
  pendingFields?: PendingFields | null;
}

/* ── Helpers ───────────────────────────────────────── */

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function providerIcon(provider: string): string {
  if (provider === 'github') return '🐙';
  if (provider === 'atlassian') return '🔷';
  if (provider === 'jira') return '🔵';
  if (provider === 'bitbucket') return '🪣';
  return '🔌';
}

function providerName(provider: string): string {
  if (provider === 'github') return 'GitHub';
  if (provider === 'atlassian') return 'Atlassian';
  if (provider === 'jira') return 'Jira';
  if (provider === 'bitbucket') return 'Bitbucket';
  return provider;
}

function statusAccent(status: string): string {
  if (status === 'active') return 'bg-emerald-500';
  if (status === 'error') return 'bg-red-500';
  if (status === 'expired') return 'bg-amber-500';
  return 'bg-zinc-500';
}

const PROVIDER_DEFAULTS: Record<string, { url: string; hint: string }> = {
  github: { url: 'https://api.github.com', hint: 'https://api.github.com' },
  atlassian: { url: '', hint: 'https://yourcompany.atlassian.net' },
  jira: { url: '', hint: 'https://yourcompany.atlassian.net' },
  bitbucket: { url: 'https://api.bitbucket.org', hint: 'https://api.bitbucket.org' },
};

/* ── Integration Form ──────────────────────────────── */

function IntegrationForm({
  initial,
  onSubmit,
  onCancel,
  loading,
}: {
  initial?: Integration;
  onSubmit: (data: {
    name: string;
    provider: string;
    authType: string;
    authConfig: any;
    capabilities: string[];
  }) => void;
  onCancel: () => void;
  loading: boolean;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [provider, setProvider] = useState(initial?.provider ?? 'github');
  const [authType, setAuthType] = useState(initial?.authType ?? 'api-token');
  const [url, setUrl] = useState(PROVIDER_DEFAULTS[initial?.provider ?? 'github']?.url ?? '');
  const [token, setToken] = useState('');
  const [email, setEmail] = useState('');
  const [host, setHost] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [capabilities, setCapabilities] = useState<Set<string>>(
    new Set(initial?.capabilities ?? ['issues']),
  );
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string } | null>(null);

  function handleProviderChange(newProvider: string) {
    setProvider(newProvider);
    setUrl(PROVIDER_DEFAULTS[newProvider]?.url ?? '');
    setTestResult(null);
  }

  function toggleCapability(cap: string) {
    const newSet = new Set(capabilities);
    if (newSet.has(cap)) newSet.delete(cap);
    else newSet.add(cap);
    setCapabilities(newSet);
  }

  function buildAuthConfig() {
    if (authType === 'api-token') {
      const config: any = { token, url };
      if ((provider === 'jira' || provider === 'atlassian' || provider === 'bitbucket') && email) config.email = email;
      return config;
    }
    if (authType === 'ssh-key') {
      return { privateKey, host };
    }
    return {};
  }

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const authConfig = buildAuthConfig();
      void authConfig;
      if (!initial?.id) {
        setTestResult({ ok: false, error: 'Save the integration first, then test' });
        return;
      }
      const result = await apiFetch<{ ok: boolean; error?: string }>(`/api/integrations/${initial.id}/test`, {
        method: 'POST',
      });
      setTestResult(result);
    } catch (err: any) {
      setTestResult({ ok: false, error: err.message ?? 'Connection failed' });
    } finally {
      setTesting(false);
    }
  }

  function handleSubmit() {
    onSubmit({
      name,
      provider,
      authType,
      authConfig: buildAuthConfig(),
      capabilities: Array.from(capabilities),
    });
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-xs font-medium text-zinc-400 mb-1.5">Name</label>
          <Input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g., Work GitHub"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-zinc-400 mb-1.5">Provider</label>
          <Select value={provider} onValueChange={handleProviderChange}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="github">GitHub</SelectItem>
              <SelectItem value="atlassian">Atlassian (Jira + Bitbucket)</SelectItem>
              <SelectItem value="jira">Jira (standalone)</SelectItem>
              <SelectItem value="bitbucket">Bitbucket (standalone)</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div>
        <label className="block text-xs font-medium text-zinc-400 mb-1.5">Auth Type</label>
        <Select value={authType} onValueChange={setAuthType}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="api-token">API Token</SelectItem>
            <SelectItem value="ssh-key">SSH Key</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {authType === 'api-token' && (
        <>
          <div>
            <label className="block text-xs font-medium text-zinc-400 mb-1.5">URL</label>
            <Input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={PROVIDER_DEFAULTS[provider]?.hint ?? 'https://...'}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-zinc-400 mb-1.5">Token</label>
            <Input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={initial ? '••••••' : 'Enter API token'}
            />
          </div>
          {(provider === 'jira' || provider === 'atlassian' || provider === 'bitbucket') && (
            <div>
              <label className="block text-xs font-medium text-zinc-400 mb-1.5">
                Email <span className="text-zinc-600">(Atlassian account email)</span>
              </label>
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="your-email@example.com"
              />
            </div>
          )}
        </>
      )}

      {authType === 'ssh-key' && (
        <>
          <div>
            <label className="block text-xs font-medium text-zinc-400 mb-1.5">Host</label>
            <Input
              type="text"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="bitbucket.org"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-zinc-400 mb-1.5">Private Key</label>
            <Textarea
              value={privateKey}
              onChange={(e) => setPrivateKey(e.target.value)}
              placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
              rows={6}
              className="font-mono resize-y"
            />
          </div>
        </>
      )}

      <div>
        <label className="block text-xs font-medium text-zinc-400 mb-1.5">Capabilities</label>
        <div className="flex gap-4">
          <Checkbox
            checked={capabilities.has('issues')}
            onChange={() => toggleCapability('issues')}
            label="Issues"
          />
          <Checkbox
            checked={capabilities.has('vcs')}
            onChange={() => toggleCapability('vcs')}
            label="Version Control"
          />
        </div>
      </div>

      {testResult && (
        <div
          className={`rounded-lg px-4 py-3 text-sm ${
            testResult.ok
              ? 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-300'
              : 'bg-red-500/10 border border-red-500/20 text-red-300'
          }`}
        >
          {testResult.ok ? (
            <span className="flex items-center gap-1">
              <CheckCircle2 className="w-4 h-4" /> Connection successful
            </span>
          ) : (
            <span className="flex items-center gap-1">
              <XCircle className="w-4 h-4" /> {testResult.error || 'Connection failed'}
            </span>
          )}
        </div>
      )}

      <div className="flex justify-end gap-2 pt-2">
        <Button
          variant="outline" onClick={onCancel}
          className="px-4 py-2 rounded-lg text-sm text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700/50 transition-colors"
        >
          Cancel
        </Button>
        {initial?.id && (
          <Button
            variant="outline"
            onClick={handleTest}
            disabled={testing || !name}
            className="text-xs h-9 gap-1.5 border-blue-500/30 text-blue-300 hover:text-blue-200 hover:bg-blue-500/10 disabled:opacity-50"
          >
            {testing ? (
              <><Hourglass className="w-3.5 h-3.5 animate-spin" /> Testing...</>
            ) : (
              <><FlaskConical className="w-3.5 h-3.5" /> Test Connection</>
            )}
          </Button>
        )}
        <Button
          onClick={handleSubmit}
          disabled={loading || !name}
          className="bg-violet-600 hover:bg-violet-700 text-white text-sm px-4 h-9 disabled:opacity-50"
        >
          {loading ? 'Saving…' : initial ? 'Update' : 'Create'}
        </Button>
      </div>
    </div>
  );
}

/* ── Integration Card ──────────────────────────────── */

function IntegrationCard({
  integration,
  onEdit,
  onDelete,
  onTest,
  testResult,
  testing,
}: {
  integration: Integration;
  onEdit: () => void;
  onDelete: () => void;
  onTest: () => void;
  testResult: { ok: boolean; error?: string } | null;
  testing: boolean;
}) {
  const { pf, cardClass, accentClass, badgePf } = usePendingStyle(integration.pendingFields, integration.pendingAction);

  const statusBadge: Record<string, string> = {
    active: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/20',
    error: 'bg-red-500/20 text-red-300 border-red-500/20',
    expired: 'bg-amber-500/20 text-amber-300 border-amber-500/20',
  };

  return (
    <BaseCard
      onClick={onEdit}
      accentColor={accentClass(statusAccent(integration.status))}
      className={cardClass || undefined}
      footer={
        <>
          <Button
            variant="outline"
            size="sm"
            onClick={onTest}
            disabled={testing}
            className="flex-1 text-xs h-8 gap-1.5 border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50 disabled:opacity-50"
          >
            {testing ? <Hourglass className="w-3 h-3" /> : <><FlaskConical className="w-3 h-3" /> Test</>}
          </Button>
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
            onClick={onDelete}
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
            <div className="flex items-center gap-2">
              <span className="text-xl" title={providerName(integration.provider)}>
                {providerIcon(integration.provider)}
              </span>
              <h3 className={pf('name', 'text-base font-semibold text-zinc-100')}>{integration.name}</h3>
              {integration.pendingAction && (
                <PendingBadge action={integration.pendingAction as 'create' | 'update' | 'delete'} />
              )}
            </div>
            <div className="flex items-center gap-2 mt-1.5 flex-wrap">
              <Badge className={`text-xs font-medium px-2 py-0.5 rounded-full border ${
                badgePf('status', statusBadge[integration.status] || statusBadge.active)
              }`}>
                {integration.status}
              </Badge>
              {integration.capabilities.map((cap) => (
                <span
                  key={cap}
                  className="px-2 py-0.5 rounded-full text-xs bg-zinc-800/50 text-zinc-400 border border-zinc-800 inline-flex items-center gap-0.5"
                >
                  {cap === 'issues' && <GitPullRequest className="w-3 h-3" />}
                  {cap === 'vcs' && <GitBranch className="w-3 h-3" />}
                  {cap}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Details */}
      <div className="p-5 pt-4 space-y-2.5 flex-1">
        <div className="flex justify-between text-xs">
          <span className="text-zinc-500">Provider</span>
          <span className={pf('provider', 'text-zinc-400')}>{providerName(integration.provider)}</span>
        </div>
        <div className="flex justify-between text-xs">
          <span className="text-zinc-500">Auth</span>
          <span className={pf('authType', 'text-zinc-400')}>{integration.authType}</span>
        </div>
        <div className="flex justify-between text-xs">
          <span className="text-zinc-500">Added</span>
          <span className="text-zinc-600">{relativeTime(integration.createdAt)}</span>
        </div>

        {testResult && (
          <div className={`text-xs ${testResult.ok ? 'text-emerald-400' : 'text-red-400'}`}>
            <span className="inline-flex items-center gap-1">
              {testResult.ok ? (
                <><CheckCircle2 className="w-3 h-3" /> Test passed</>
              ) : (
                <><XCircle className="w-3 h-3" /> {testResult.error || 'Test failed'}</>
              )}
            </span>
          </div>
        )}

        {integration.status === 'error' && integration.statusMessage && (
          <div className="text-xs text-red-400 flex items-center gap-1">
            <AlertCircle className="w-3 h-3" /> {integration.statusMessage}
          </div>
        )}
      </div>

    </BaseCard>
  );
}

/* ── Main Page ─────────────────────────────────────── */

export default function Integrations() {
  const { user: authUser, hasScope } = useAuth();
  const canMutate = hasScope('integrations:write');
  const queryClient = useQueryClient();
  const { data: integrations = [], isLoading: loading } = useIntegrations();
  const [showForm, setShowForm] = useState(false);
  const [editingIntegration, setEditingIntegration] = useState<Integration | null>(null);
  const [saving, setSaving] = useState(false);
  const [testResults, setTestResults] = useState<
    Record<string, { ok: boolean; error?: string }>
  >({});
  const [testingId, setTestingId] = useState<string | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<{ title: string; message: string; onConfirm: () => void } | null>(null);

  // suppress unused warning — kept for auth context consistency
  void authUser;

  const handleCreate = async (data: {
    name: string;
    provider: string;
    authType: string;
    authConfig: any;
    capabilities: string[];
  }) => {
    setSaving(true);
    try {
      await apiFetch('/api/integrations', {
        method: 'POST',
        body: JSON.stringify(data),
      });
      setShowForm(false);
      await queryClient.invalidateQueries();
    } catch (err) {
      console.error('Failed to create integration:', err);
    } finally {
      setSaving(false);
    }
  };

  const handleUpdate = async (
    data: {
      name: string;
      provider: string;
      authType: string;
      authConfig: any;
      capabilities: string[];
    },
  ) => {
    if (!editingIntegration) return;
    setSaving(true);
    try {
      await apiFetch(`/api/integrations/${editingIntegration.id}`, {
        method: 'POST',
        body: JSON.stringify(data),
      });
      setEditingIntegration(null);
      await queryClient.invalidateQueries();
    } catch (err) {
      console.error('Failed to update integration:', err);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = (id: string) => {
    setConfirmDialog({
      title: 'Delete Integration',
      message: 'Delete this integration? Projects using it will lose access.',
      onConfirm: async () => {
        setConfirmDialog(null);
        try {
          await apiFetch(`/api/integrations/${id}`, { method: 'DELETE' });
          await queryClient.invalidateQueries();
        } catch (err) {
          console.error('Failed to delete integration:', err);
        }
      },
    });
  };

  const handleTest = async (id: string) => {
    setTestingId(id);
    try {
      const result = await apiFetch<{ ok: boolean; error?: string }>(
        `/api/integrations/${id}/test`,
        { method: 'POST' },
      );
      setTestResults((prev) => ({ ...prev, [id]: result }));
    } catch (err: any) {
      setTestResults((prev) => ({
        ...prev,
        [id]: { ok: false, error: err.message ?? 'Failed' },
      }));
    } finally {
      setTestingId(null);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <PageHeader icon={Plug} title="Integrations" subtitle="Connect external services (GitHub, Jira, Bitbucket) to your projects">
        {canMutate && (
          <Button
            onClick={() => setShowForm(true)}
            className="bg-violet-600 hover:bg-violet-700 text-white text-sm px-4 h-9"
          >
            + Add Integration
          </Button>
        )}
      </PageHeader>

      {/* Create dialog */}
      <Dialog open={showForm} onOpenChange={setShowForm}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Add Integration</DialogTitle>
          </DialogHeader>
          <IntegrationForm
            onSubmit={handleCreate}
            onCancel={() => setShowForm(false)}
            loading={saving}
          />
        </DialogContent>
      </Dialog>

      {/* Edit dialog */}
      <Dialog open={!!editingIntegration} onOpenChange={(open) => { if (!open) setEditingIntegration(null); }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit Integration</DialogTitle>
          </DialogHeader>
          {editingIntegration && (
            <IntegrationForm
              initial={editingIntegration}
              onSubmit={handleUpdate}
              onCancel={() => setEditingIntegration(null)}
              loading={saving}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* Loading skeleton */}
      {loading && <CardGrid loading skeletonCount={3} />}

      {/* Empty state */}
      {!loading && integrations.length === 0 && (
        <EmptyState
          icon={Plug}
          title="No integrations configured"
          description="Add an integration to connect external services to your projects"
          action={canMutate ? { label: '+ Add Integration', onClick: () => setShowForm(true) } : undefined}
        />
      )}

      {/* Integrations grid */}
      {!loading && integrations.length > 0 && (
        <CardGrid>
          {integrations.map((integration) => (
            <IntegrationCard
              key={integration.id}
              integration={integration}
              onEdit={() => setEditingIntegration(integration)}
              onDelete={() => handleDelete(integration.id)}
              onTest={() => handleTest(integration.id)}
              testResult={testResults[integration.id] ?? null}
              testing={testingId === integration.id}
            />
          ))}
        </CardGrid>
      )}

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
