import { useEffect, useState } from 'react';
import { apiFetch } from '../hooks/useApi';
import { useAuth } from '../hooks/useAuth';
import { useSettings } from '../hooks/queries/useSettings';
import { useProviders } from '../hooks/queries/useProviders';
import { useModels } from '../hooks/queries/useModels';
import { useSSEConnection } from '../providers/SSEProvider';
import { Settings as SettingsIcon, Tag, Save, Loader2, CheckCircle2, XCircle, Trash2, Radio, Wifi, WifiOff, Image, Globe } from 'lucide-react';
import { LoadingState } from '../components/LoadingState';
import { PageHeader } from '../components/PageHeader';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select';

interface SettingsData {
  armada_openclaw_version: string | null;
  latestVersion: string | null;
  workspace_retention_days: number;
  avatar_model_id: string | null;
  avatar_prompt: string | null;
}
const labelCls = 'block text-sm font-medium text-zinc-300 mb-1';
const DEFAULT_AVATAR_PROMPT = `Generate an image: A circular avatar icon for {{subject}}. Digital art style, solid black (#09090b) background — NOT transparent, must be fully opaque. Glowing teal/emerald (#10b981) accents, futuristic feel. The design should visually represent the name and role creatively. No text, no letters, no words in the image. Square format, clean edges.`;

export default function Settings() {
  const { hasScope } = useAuth();
  const canWrite = hasScope('system:write');

  const sse = useSSEConnection();
  const { data: settingsQueryData, isLoading: loading, refetch: fetchSettings } = useSettings();
  const { data: providers } = useProviders();
  const { data: allModels } = useModels();
  const data = (settingsQueryData as SettingsData) ?? null;
  const [versionInput, setVersionInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<{ ok: boolean; msg: string } | null>(null);

  // Workspace retention state
  const [retentionDays, setRetentionDays] = useState(30);
  const [savingRetention, setSavingRetention] = useState(false);
  const [retentionResult, setRetentionResult] = useState<{ ok: boolean; msg: string } | null>(null);

  // Public URL state
  const [publicUrl, setPublicUrl] = useState('');
  const [savingUrl, setSavingUrl] = useState(false);
  const [urlResult, setUrlResult] = useState<{ ok: boolean; msg: string } | null>(null);

    // Avatar generation state
  const [avatarModelId, setAvatarModelId] = useState<string>('');
  const [avatarPrompt, setAvatarPrompt] = useState<string>('');
  const [savingAvatar, setSavingAvatar] = useState(false);
  const [avatarResult, setAvatarResult] = useState<{ ok: boolean; msg: string } | null>(null);

  // Sync settings data to form fields when loaded
  useEffect(() => {
    if (!settingsQueryData) return;
    const result = settingsQueryData as SettingsData;
    setVersionInput(result.armada_openclaw_version ?? '');
    setRetentionDays(result.workspace_retention_days ?? 30);
    setAvatarModelId(result.avatar_model_id ?? '');
    setAvatarPrompt(result.avatar_prompt ?? '');
    // Fetch public URL from settings
    apiFetch<{ detectedUrl: string; stored: { origin: string } | null }>('/api/auth/detected-url')
      .then(d => setPublicUrl(d.stored?.origin ?? d.detectedUrl ?? ''))
      .catch(() => {});
  }, [settingsQueryData]);

  // Models with image generation capability for the avatar picker
  const avatarModels = (allModels ?? [])
    .filter(m => (m.capabilities ?? []).includes('image-generation'))
    .map(m => {
      const provider = (providers ?? []).find(p => p.id === m.providerId);
      return { ...m, providerName: provider?.name ?? m.providerId ?? 'Unknown' };
    });

  const handleSaveAvatar = async () => {
    if (!canWrite) return;
    setSavingAvatar(true);
    setAvatarResult(null);
    try {
      // Derive provider from selected model
      const selectedModel = avatarModels.find(m => m.modelId === avatarModelId);
      const derivedProviderId = selectedModel?.providerId || null;
      await apiFetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'avatar_provider_id', value: derivedProviderId }),
      });
      await apiFetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'avatar_model_id', value: avatarModelId || null }),
      });
      // Save prompt if set (empty = use default)
      await apiFetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'avatar_prompt', value: avatarPrompt || null }),
      });
      setAvatarResult({ ok: true, msg: avatarModelId ? 'Avatar generation settings saved.' : 'Avatar generation disabled.' });
      await fetchSettings();
    } catch (err: any) {
      setAvatarResult({ ok: false, msg: err.message ?? 'Failed to save.' });
    } finally {
      setSavingAvatar(false);
    }
  };

  const handleSaveVersion = async () => {
    if (!canWrite) return;
    setSaving(true);
    setSaveResult(null);
    try {
      await apiFetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'armada_openclaw_version', value: versionInput.trim() || null }),
      });
      setSaveResult({ ok: true, msg: 'Version saved.' });
      await fetchSettings();
    } catch (err: any) {
      setSaveResult({ ok: false, msg: err.message ?? 'Failed to save.' });
    } finally {
      setSaving(false);
    }
  };

  const handleSaveRetention = async () => {
    if (!canWrite) return;
    setSavingRetention(true);
    setRetentionResult(null);
    try {
      const days = Math.max(1, Math.min(365, retentionDays || 30));
      await apiFetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'workspace_retention_days', value: String(days) }),
      });
      setRetentionResult({ ok: true, msg: `Retention policy saved: ${days} days.` });
      await fetchSettings();
    } catch (err: any) {
      setRetentionResult({ ok: false, msg: err.message ?? 'Failed to save.' });
    } finally {
      setSavingRetention(false);
    }
  };

  const handleSaveUrl = async () => {
    if (!canWrite) return;
    setSavingUrl(true);
    setUrlResult(null);
    try {
      await apiFetch('/api/auth/confirm-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: publicUrl.trim() }),
      });
      setUrlResult({ ok: true, msg: 'Public URL saved. Passkeys will use this domain.' });
    } catch (err: any) {
      setUrlResult({ ok: false, msg: err.message ?? 'Failed to save.' });
    } finally {
      setSavingUrl(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Settings"
        subtitle="Platform configuration"
        icon={SettingsIcon}
      />

      {loading ? (
        <LoadingState message="Loading settings…" />
      ) : (
        <div className="space-y-8">
          {/* Public URL */}
            <section className="bg-zinc-900 border border-zinc-800 rounded-lg p-6 space-y-4">
              <div className="flex items-center gap-2">
                <Globe className="w-4 h-4 text-teal-400" />
                <h2 className="text-base font-semibold text-white">Public URL</h2>
              </div>
              <p className="text-sm text-zinc-400">
                The public URL for this Armada control plane. Used for passkey authentication (WebAuthn),
                notification links, and node agent connections.
              </p>

              <div className="space-y-1">
                <label className={labelCls}>URL</label>
                <Input
                  value={publicUrl}
                  onChange={(e) => setPublicUrl(e.target.value)}
                  placeholder="https://armada.example.com"
                  disabled={!canWrite}
                />
                <p className="text-xs text-zinc-500 mt-1">
                  Changing this will affect passkey authentication. Existing passkeys are bound to the domain they were registered on.
                </p>
              </div>

              {urlResult && (
                <div className={`flex items-center gap-2 text-sm rounded-lg px-3 py-2 ${urlResult.ok ? 'bg-green-500/10 border border-green-500/20 text-green-400' : 'bg-red-500/10 border border-red-500/20 text-red-400'}`}>
                  {urlResult.ok ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <XCircle className="w-4 h-4 shrink-0" />}
                  {urlResult.msg}
                </div>
              )}

              {canWrite && (
                <Button
                  onClick={handleSaveUrl}
                  disabled={savingUrl || !publicUrl.trim()}
                  className="flex items-center gap-2 bg-violet-600 hover:bg-violet-700 disabled:opacity-50 text-white text-sm px-4 h-9"
                >
                  {savingUrl ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                  {savingUrl ? 'Saving…' : 'Save URL'}
                </Button>
              )}
            </section>

          {/* OpenClaw Version */}
            <section className="bg-zinc-900 border border-zinc-800 rounded-lg p-6 space-y-4">
              <div className="flex items-center gap-2">
                <Tag className="w-4 h-4 text-violet-400" />
                <h2 className="text-base font-semibold text-white">OpenClaw Version</h2>
              </div>
              <p className="text-sm text-zinc-400">
                Set the default OpenClaw image tag used armada-wide when provisioning instances.
                Leave blank to use <code className="bg-zinc-800 px-1 rounded text-violet-300">latest</code>.
                Individual templates can pin their own version to override this setting.
              </p>

              {data?.latestVersion && (
                <div className="flex items-center gap-2 text-sm text-green-400 bg-green-500/10 border border-green-500/20 rounded-lg px-3 py-2">
                  <CheckCircle2 className="w-4 h-4 shrink-0" />
                  Latest available version: <span className="font-mono font-semibold">{data.latestVersion}</span>
                  {data.armada_openclaw_version && data.armada_openclaw_version !== data.latestVersion && (
                    <span className="ml-1 text-amber-400">(armada pinned to {data.armada_openclaw_version})</span>
                  )}
                </div>
              )}

              <div className="space-y-1">
                <label className={labelCls}>Version tag</label>
                <Input
                  value={versionInput}
                  onChange={(e) => setVersionInput(e.target.value)}
                  placeholder={data?.latestVersion ? `e.g. ${data.latestVersion}` : 'e.g. 2026.3.8'}
                  disabled={!canWrite}
                />
                <p className="text-xs text-zinc-500 mt-1">
                  Used as: <code className="text-violet-300 break-all">ghcr.io/openclaw/openclaw:{'{version}'}</code>. Clear to use <code className="text-violet-300">latest</code>.
                </p>
              </div>

              {saveResult && (
                <div className={`flex items-center gap-2 text-sm rounded-lg px-3 py-2 ${saveResult.ok ? 'bg-green-500/10 border border-green-500/20 text-green-400' : 'bg-red-500/10 border border-red-500/20 text-red-400'}`}>
                  {saveResult.ok ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <XCircle className="w-4 h-4 shrink-0" />}
                  {saveResult.msg}
                </div>
              )}

              {canWrite && (
                <Button
                  onClick={handleSaveVersion}
                  disabled={saving}
                  className="flex items-center gap-2 bg-violet-600 hover:bg-violet-700 disabled:opacity-50 text-white text-sm px-4 h-9"
                >
                  {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                  {saving ? 'Saving…' : 'Save Version'}
                </Button>
              )}

              {!canWrite && (
                <p className="text-xs text-zinc-500 italic">You need <code>system:write</code> scope to change this setting.</p>
              )}
            </section>

            {/* Workspace Retention */}
            <section className="bg-zinc-900 border border-zinc-800 rounded-lg p-6 space-y-4">
              <div className="flex items-center gap-2">
                <Trash2 className="w-4 h-4 text-amber-400" />
                <h2 className="text-base font-semibold text-white">Workspace Retention</h2>
              </div>
              <p className="text-sm text-zinc-400">
                Automatically clean up workspace data for deleted agents after this period.
                Workspaces for stopped agents are preserved for reuse. Armada checks daily and removes
                unclaimed workspace directories from nodes.
              </p>

              <div className="space-y-1">
                <label className={labelCls}>Retention period (days)</label>
                <div className="flex items-center gap-3">
                  <Input
                    type="number"
                    min={1}
                    max={365}
                    className="max-w-[140px]"
                    value={retentionDays}
                    onChange={(e) => setRetentionDays(parseInt(e.target.value, 10) || 30)}
                    disabled={!canWrite}
                  />
                  <span className="text-sm text-zinc-500">days after agent stopped</span>
                </div>
                <p className="text-xs text-zinc-500 mt-1">
                  Default: 30 days. Set to a higher value to retain workspace data longer.
                  Workspaces for running agents are never removed.
                </p>
              </div>

              {retentionResult && (
                <div className={`flex items-center gap-2 text-sm rounded-lg px-3 py-2 ${retentionResult.ok ? 'bg-green-500/10 border border-green-500/20 text-green-400' : 'bg-red-500/10 border border-red-500/20 text-red-400'}`}>
                  {retentionResult.ok ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <XCircle className="w-4 h-4 shrink-0" />}
                  {retentionResult.msg}
                </div>
              )}

              {canWrite && (
                <Button
                  onClick={handleSaveRetention}
                  disabled={savingRetention}
                  className="flex items-center gap-2 bg-violet-600 hover:bg-violet-700 disabled:opacity-50 text-white text-sm px-4 h-9"
                >
                  {savingRetention ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                  {savingRetention ? 'Saving…' : 'Save Retention Policy'}
                </Button>
              )}

              {!canWrite && (
                <p className="text-xs text-zinc-500 italic">You need <code>system:write</code> scope to change this setting.</p>
              )}
            </section>


            {/* Avatar Generation */}
            <section className="bg-zinc-900 border border-zinc-800 rounded-lg p-6 space-y-4">
              <div className="flex items-center gap-2">
                <Image className="w-4 h-4 text-violet-400" />
                <h2 className="text-base font-semibold text-white">Avatar Generation</h2>
              </div>
              <p className="text-sm text-zinc-400">
                Select a model with image generation capabilities to auto-generate avatars for agents and users.
                Leave unset to disable avatar generation. The model's provider must have an API key configured.
              </p>

              <div className="space-y-4">
                <div className="space-y-1 max-w-md">
                  <label className={labelCls}>Model</label>
                  <Select
                    value={avatarModelId || '__none__'}
                    onValueChange={(v) => setAvatarModelId(v === '__none__' ? '' : v)}
                    disabled={!canWrite}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Disabled — select a model to enable" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">Disabled</SelectItem>
                      {avatarModels.map((m) => (
                        <SelectItem key={m.id} value={m.modelId}>
                          {m.name} ({m.providerName})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {avatarModelId && (
                    <p className="text-xs text-emerald-400 mt-1">✓ Avatar generation enabled</p>
                  )}
                  {!avatarModelId && avatarModels.length > 0 && (
                    <p className="text-xs text-zinc-500 mt-1">No model selected — avatar generation is off</p>
                  )}
                  {avatarModels.length === 0 && (
                    <p className="text-xs text-amber-400 mt-1">No models with image generation capability found. Enable the "image-generation" capability on a model in the Models page.</p>
                  )}
                </div>

                <div className="space-y-1">
                  <label className={labelCls}>Prompt Template</label>
                  <p className="text-xs text-zinc-500 mb-1.5">
                    Use <code className="bg-zinc-800 px-1 rounded text-violet-300">{'{{subject}}'}</code> as a placeholder for the agent/user description.
                  </p>
                  <textarea
                    className="w-full rounded-lg border border-zinc-700 bg-zinc-800/50 px-3 py-2 text-sm text-zinc-200 placeholder-zinc-500 focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500 disabled:opacity-50 resize-y font-mono"
                    style={{ minHeight: '100px' }}
                    rows={4}
                    value={avatarPrompt || DEFAULT_AVATAR_PROMPT}
                    onChange={(e) => setAvatarPrompt(e.target.value)}
                    disabled={!canWrite}
                    placeholder={DEFAULT_AVATAR_PROMPT}
                  />
                  {avatarPrompt && avatarPrompt !== DEFAULT_AVATAR_PROMPT && (
                    <button
                      type="button"
                      onClick={() => setAvatarPrompt('')}
                      className="text-xs text-zinc-500 hover:text-zinc-300 underline"
                    >
                      Reset to default
                    </button>
                  )}
                </div>
              </div>

              {avatarResult && (
                <div className={`flex items-center gap-2 text-sm rounded-lg px-3 py-2 ${avatarResult.ok ? 'bg-green-500/10 border border-green-500/20 text-green-400' : 'bg-red-500/10 border border-red-500/20 text-red-400'}`}>
                  {avatarResult.ok ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <XCircle className="w-4 h-4 shrink-0" />}
                  {avatarResult.msg}
                </div>
              )}

              {canWrite && (
                <Button
                  onClick={handleSaveAvatar}
                  disabled={savingAvatar}
                  className="flex items-center gap-2 bg-violet-600 hover:bg-violet-700 disabled:opacity-50 text-white text-sm px-4 h-9"
                >
                  {savingAvatar ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                  {savingAvatar ? 'Saving…' : 'Save'}
                </Button>
              )}

              {!canWrite && (
                <p className="text-xs text-zinc-500 italic">You need <code>system:write</code> scope to change this setting.</p>
              )}
            </section>
          </div>
        )}

        {/* SSE Diagnostics */}
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-5 space-y-4">
          <div className="flex items-center gap-2">
            <Radio className="w-5 h-5 text-zinc-400" />
            <h2 className="text-lg font-semibold text-zinc-100">Real-Time Connection</h2>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <div className="space-y-1">
              <div className="text-xs text-zinc-500 uppercase tracking-wider">Status</div>
              <div className="flex items-center gap-2">
                {sse.connected
                  ? <><Wifi className="w-4 h-4 text-emerald-400" /><span className="text-sm text-emerald-400 font-medium">Connected</span></>
                  : <><WifiOff className="w-4 h-4 text-red-400" /><span className="text-sm text-red-400 font-medium">Disconnected</span></>
                }
              </div>
            </div>

            <div className="space-y-1">
              <div className="text-xs text-zinc-500 uppercase tracking-wider">Mode</div>
              <div className="text-sm font-medium">
                {sse.polling
                  ? <span className="text-amber-400">Polling (fallback)</span>
                  : <span className="text-emerald-400">SSE (real-time)</span>
                }
              </div>
            </div>

            <div className="space-y-1">
              <div className="text-xs text-zinc-500 uppercase tracking-wider">Events</div>
              <div className="text-sm text-zinc-200 font-medium">{sse.eventCount}</div>
            </div>

            <div className="space-y-1">
              <div className="text-xs text-zinc-500 uppercase tracking-wider">Last Event</div>
              <div className="text-sm text-zinc-200 font-medium">
                {sse.lastEventTime
                  ? `${Math.round((Date.now() - sse.lastEventTime) / 1000)}s ago`
                  : 'Never'
                }
              </div>
            </div>
          </div>

          {sse.polling && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2">
              <WifiOff className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
              <p className="text-xs text-amber-400">
                SSE connection is not delivering events. Fallback polling is active (every 10s).
                This may happen on mobile browsers that suspend background connections.
                Try opening in a desktop browser to confirm SSE works.
              </p>
            </div>
          )}
        </div>
    </div>
  );
}
