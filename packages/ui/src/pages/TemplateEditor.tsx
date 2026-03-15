import { useEffect, useState, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { Template, PluginEntry, TemplateSkill, TemplatePlugin, TemplateModel, LibrarySkill, LibraryPlugin, ModelRegistryEntry, ProviderApiKey } from '@coderage-labs/armada-shared';
import { apiFetch } from '../hooks/useApi';
import { useTemplate } from '../hooks/queries/useTemplates';
import SyncDialog from '../components/SyncDialog';
import { Package, Plug, Check, Cpu, FileCode } from 'lucide-react';
import { PageHeader } from '../components/PageHeader';
import { toast } from 'sonner';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../components/ui/tabs';
import { Input } from '../components/ui/input';
import { Textarea } from '../components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';

const TABS = ['Basic', 'Models', 'Plugins', 'Skills', 'Contacts', 'Tools', 'SOUL.md', 'AGENTS.md', 'Environment'] as const;
type Tab = (typeof TABS)[number];

const MEMORY_OPTIONS = ['1g', '2g', '4g', '8g', '16g'];
const CPU_OPTIONS = ['1', '2', '4', '8'];

const TOOLS_PROFILE_OPTIONS = ['', 'minimal', 'coding', 'messaging', 'full'];

interface FormData {
  name: string;
  description: string;
  role: string;
  skills: string;
  image: string;
  model: string;
  memory: string;
  cpus: string;
  plugins: PluginEntry[];
  pluginsList: TemplatePlugin[];
  skillsList: TemplateSkill[];
  contacts: { name: string; role: string }[];
  tools: string[];
  toolsAllow: string;
  toolsProfile: string;
  soul: string;
  agents: string;
  env: string[];
  models: TemplateModel[];
}

const emptyForm: FormData = {
  name: '',
  description: '',
  role: '',
  skills: '',
  image: 'openclaw/openclaw:latest',
  model: '',
  memory: '2g',
  cpus: '1',
  plugins: [],
  pluginsList: [],
  skillsList: [],
  contacts: [],
  tools: [],
  toolsAllow: '',
  toolsProfile: '',
  soul: '',
  agents: '',
  env: [],
  models: [],
};

const NAME_PATTERN = /^[a-zA-Z0-9-]+$/;

export default function TemplateEditor() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const isEdit = Boolean(id);

  const [tab, setTab] = useState<Tab>('Basic');
  const [form, setForm] = useState<FormData>({ ...emptyForm });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showSync, setShowSync] = useState(false);
  const [driftData, setDriftData] = useState<any[] | null>(null);
  const [syncLoading, setSyncLoading] = useState(false);
  const [librarySkills, setLibrarySkills] = useState<LibrarySkill[]>([]);
  const [libraryPlugins, setLibraryPlugins] = useState<LibraryPlugin[]>([]);
  const [newToolRepo, setNewToolRepo] = useState('');
  const [availableRoles, setAvailableRoles] = useState<string[]>([]);
  const [registryModels, setRegistryModels] = useState<ModelRegistryEntry[]>([]);
  const [providerKeys, setProviderKeys] = useState<Record<string, ProviderApiKey[]>>({});
  const [armadaVersion, setArmadaVersion] = useState<string | null>(null);
  const [imageMode, setImageMode] = useState<'armada' | 'custom'>('armada');

  const fetchRoles = useCallback(async () => {
    try {
      const data = await apiFetch<{ roles?: { role: string }[]; rules?: Record<string, string[]> }>('/api/hierarchy');
      const roleNames = new Set<string>();
      // From role metadata
      if (data.roles) data.roles.forEach(r => roleNames.add(r.role));
      // From hierarchy rules (keys + values)
      if (data.rules) {
        Object.keys(data.rules).forEach(r => roleNames.add(r));
        Object.values(data.rules).flat().forEach(r => roleNames.add(r));
      }
      setAvailableRoles([...roleNames].sort());
    } catch { /* ignore */ }
  }, []);

  const fetchLibrarySkills = useCallback(async () => {
    try {
      const data = await apiFetch<LibrarySkill[]>('/api/skills/library');
      setLibrarySkills(data);
    } catch { /* ignore */ }
  }, []);

  const fetchLibraryPlugins = useCallback(async () => {
    try {
      const data = await apiFetch<LibraryPlugin[]>('/api/plugins/library');
      setLibraryPlugins(data);
    } catch { /* ignore */ }
  }, []);

  const fetchRegistryModels = useCallback(async () => {
    try {
      const data = await apiFetch<ModelRegistryEntry[]>('/api/models');
      setRegistryModels(data);
    } catch { /* ignore */ }
  }, []);

  const fetchProviderKeys = useCallback(async (providerId: string) => {
    if (!providerId) return;
    setProviderKeys(prev => {
      if (prev[providerId] !== undefined) return prev; // already cached
      return prev;
    });
    try {
      const data = await apiFetch<ProviderApiKey[]>(`/api/providers/${providerId}/keys`);
      setProviderKeys(prev => ({ ...prev, [providerId]: data }));
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { fetchLibrarySkills(); fetchLibraryPlugins(); fetchRoles(); fetchRegistryModels(); }, [fetchLibrarySkills, fetchLibraryPlugins, fetchRoles, fetchRegistryModels]);

  // Pre-fetch keys for all providers when registry models load
  useEffect(() => {
    const providerIds = [...new Set(registryModels.map(rm => rm.providerId).filter((pid): pid is string => !!pid))];
    providerIds.forEach(pid => fetchProviderKeys(pid));
  }, [registryModels, fetchProviderKeys]);

  useEffect(() => {
    apiFetch<{ armada_openclaw_version: string | null; latestVersion: string | null }>('/api/settings')
      .then((s) => setArmadaVersion(s.armada_openclaw_version ?? s.latestVersion ?? null))
      .catch(() => { /* ignore */ });
  }, []);

  const { data: templateData, isError: templateQueryError, error: templateQueryLoadError } = useTemplate(id);

  useEffect(() => {
    if (!templateData) return;
    const t = templateData as Template;
    setForm({
      name: t.name,
      description: t.description ?? '',
      role: t.role,
      skills: t.skills ?? '',
      image: t.image,
      model: t.model ?? '',
      memory: t.resources.memory,
      cpus: t.resources.cpus,
      plugins: t.plugins ?? [],
      pluginsList: t.pluginsList ?? [],
      skillsList: t.skillsList ?? [],
      contacts: (t as any).contacts ?? [],
      tools: (t as any).tools ?? [],
      toolsAllow: (t.toolsAllow ?? []).join(', '),
      toolsProfile: t.toolsProfile ?? '',
      soul: t.soul ?? '',
      agents: t.agents ?? '',
      env: t.env ?? [],
      models: (t as any).models ?? [],
    });
  }, [templateData]);

  useEffect(() => {
    if (templateQueryError) {
      setLoadError((templateQueryLoadError as Error)?.message ?? 'Failed to load template');
    }
  }, [templateQueryError, templateQueryLoadError]);

  // When template loads, sync imageMode based on its image field
  useEffect(() => {
    if (!id) return; // new template → default armada
    if (form.image && form.image !== 'openclaw/openclaw:latest' && form.image !== 'ghcr.io/openclaw/openclaw:latest') {
      setImageMode('custom');
    } else {
      setImageMode('armada');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.image, id]);

  const set = <K extends keyof FormData>(key: K, val: FormData[K]) =>
    setForm((prev) => ({ ...prev, [key]: val }));

  const validate = (): boolean => {
    const errs: Record<string, string> = {};
    if (!form.name.trim()) errs.name = 'Name is required';
    else if (!NAME_PATTERN.test(form.name)) errs.name = 'Only letters, numbers, and hyphens';
    if (!form.role) errs.role = 'Role is required';
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const handleSave = async () => {
    if (!validate()) return;
    setSaving(true);
    try {
      // Auto-derive skills text from skillsList for backward compat
      const derivedSkills = form.skillsList.length > 0
        ? form.skillsList.map(s => s.name).join(', ')
        : form.skills;
      const body = {
        name: form.name,
        description: form.description,
        role: form.role,
        skills: derivedSkills,
        image: imageMode === 'armada' ? '' : form.image,
        model: form.model,
        resources: { memory: form.memory, cpus: form.cpus },
        plugins: form.plugins,
        pluginsList: form.pluginsList.filter((p) => p.name.trim()),
        skillsList: form.skillsList.filter((s) => s.name.trim()),
        contacts: form.contacts.filter((c) => c.name.trim()),
        tools: form.tools.filter(Boolean),
        toolsAllow: form.toolsAllow
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        toolsProfile: form.toolsProfile,
        soul: form.soul,
        agents: form.agents,
        env: form.env,
        models: form.models,
      };
      if (isEdit) {
        await apiFetch(`/api/templates/${id}`, { method: 'PUT', body: JSON.stringify(body) });
        toast.success('Template saved');
      } else {
        const created = await apiFetch<{ id: string }>('/api/templates', { method: 'POST', body: JSON.stringify(body) });
        toast.success('Template created');
        navigate(`/templates/${created.id}/edit`);
      }
    } catch (e: any) {
      setErrors({ _save: e.message ?? 'Save failed' });
    } finally {
      setSaving(false);
    }
  };

  const handleSyncClick = async () => {
    if (!id) return;
    setSyncLoading(true);
    try {
      const data = await apiFetch<any[]>(`/api/templates/${id}/drift`);
      // Adapt new drift format to SyncDialog's expected shape
      const adapted = data.filter((a: any) => a.drifted).map((a: any) => ({
        name: a.agentName,
        agentId: a.agentId,
        containerId: '',
        diffs: {
          config: a.diffs.filter((d: any) => d.category === 'config').map((d: any) => ({
            key: d.field,
            expected: d.templateValue,
            actual: d.agentValue,
          })),
          skills: { missing: [], extra: [] },
          files: {
            changed: a.diffs.filter((d: any) => d.category === 'workspace').map((d: any) => d.field),
          },
        },
      }));
      setDriftData(adapted);
      setShowSync(true);
    } catch (e: any) {
      setErrors({ _save: `Failed to check drift: ${e.message}` });
    } finally {
      setSyncLoading(false);
    }
  };

  const handleSync = async (agents: string[], removeExtraSkills: boolean) => {
    return apiFetch(`/api/templates/${id}/sync`, {
      method: 'POST',
      body: JSON.stringify({ agents, removeExtraSkills }),
    });
  };

  // Plugin helpers
  const addPlugin = () => set('plugins', [...form.plugins, { id: '' }]);
  const removePlugin = (i: number) => set('plugins', form.plugins.filter((_, idx) => idx !== i));
  const updatePlugin = (i: number, field: keyof PluginEntry, val: any) =>
    set(
      'plugins',
      form.plugins.map((p, idx) => (idx === i ? { ...p, [field]: val } : p)),
    );

  // Env helpers
  const addEnv = () => set('env', [...form.env, '']);
  const removeEnv = (i: number) => set('env', form.env.filter((_, idx) => idx !== i));
  const updateEnv = (i: number, val: string) =>
    set(
      'env',
      form.env.map((e, idx) => (idx === i ? val : e)),
    );

  // Skills helpers
  const addSkill = () => set('skillsList', [...form.skillsList, { name: '', source: 'clawhub' }]);
  const removeSkill = (i: number) => set('skillsList', form.skillsList.filter((_, idx) => idx !== i));
  const updateSkill = (i: number, field: keyof TemplateSkill, val: string) =>
    set(
      'skillsList',
      form.skillsList.map((s, idx) => (idx === i ? { ...s, [field]: val } : s)),
    );

  // Contacts helpers
  const addContact = () => set('contacts', [...form.contacts, { name: '', role: '' }]);
  const removeContact = (i: number) => set('contacts', form.contacts.filter((_, idx) => idx !== i));
  const updateContact = (i: number, field: keyof { name: string; role: string }, val: string) =>
    set(
      'contacts',
      form.contacts.map((c, idx) => (idx === i ? { ...c, [field]: val } : c)),
    );

  // Library skill toggle
  const isSkillSelected = (name: string) => form.skillsList.some(s => s.name === name);
  const toggleLibrarySkill = (ls: LibrarySkill) => {
    if (isSkillSelected(ls.name)) {
      set('skillsList', form.skillsList.filter(s => s.name !== ls.name));
    } else {
      set('skillsList', [...form.skillsList, { name: ls.name, source: ls.source, version: ls.version ?? undefined }]);
    }
  };

  // Library plugin toggle
  const isPluginSelected = (name: string) => form.pluginsList.some(p => p.name === name);
  const toggleLibraryPlugin = (lp: LibraryPlugin) => {
    if (isPluginSelected(lp.name)) {
      set('pluginsList', form.pluginsList.filter(p => p.name !== lp.name));
    } else {
      set('pluginsList', [...form.pluginsList, { name: lp.name, source: lp.source, version: lp.version ?? undefined }]);
    }
  };
  const labelCls = 'block text-sm font-medium text-zinc-300 mb-1.5';

  if (loadError) {
    return (
      <div className="space-y-6 max-w-4xl">
        <div className="p-4 rounded-lg bg-red-500/10 border border-red-500/20 text-red-300">
          Failed to load template: {loadError}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-4xl">
      {/* Header */}
      <div className="mb-6">
        <PageHeader icon={FileCode} title={isEdit ? 'Edit Template' : 'Create Template'}>
          <Button
            variant="ghost" onClick={() => navigate('/templates')}
            className="px-4 py-2 rounded-lg bg-zinc-800/50 text-zinc-300 hover:bg-zinc-700/50 transition-colors"
          >
            Cancel
          </Button>
          {isEdit && (
            <Button
              variant="ghost" onClick={handleSyncClick}
              disabled={syncLoading}
              className="px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white font-medium transition-colors"
            >
              {syncLoading ? 'Checking…' : '⟳ Sync to Agents'}
            </Button>
          )}
          <Button
            variant="ghost" onClick={handleSave}
            disabled={saving}
            className="px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-700 disabled:opacity-50 text-white font-medium transition-colors"
          >
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </PageHeader>
      </div>

      {errors._save && (
        <div className="mb-6 p-4 rounded-lg bg-red-500/10 border border-red-500/20 text-red-300 text-sm">
          {errors._save}
        </div>
      )}

      {/* Tabs */}
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList className="mb-6">
          {TABS.map((t) => (
            <TabsTrigger key={t} value={t}>{t}</TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="Basic" className="rounded-lg border border-zinc-800 bg-zinc-800/50 p-6 mt-0">
          <div className="space-y-5">
            <div>
              <label className={labelCls}>Name *</label>
              <Input
                value={form.name}
                onChange={(e) => set('name', e.target.value)}
                placeholder="my-agent-template"
              />
              {errors.name && <p className="text-red-400 text-xs mt-1">{errors.name}</p>}
            </div>
            <div>
              <label className={labelCls}>Description</label>
              <Input
                value={form.description}
                onChange={(e) => set('description', e.target.value)}
                placeholder="What this template is for…"
              />
            </div>
            <div>
              <label className={labelCls}>Role *</label>
              <Select value={form.role || '__none__'} onValueChange={(val) => set('role', val === '__none__' ? '' : val)}>
                <SelectTrigger className="w-full border-zinc-800 bg-zinc-800/50">
                  <SelectValue placeholder="Select role…" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">Select role…</SelectItem>
                  {availableRoles.map((r) => (
                    <SelectItem key={r} value={r}>{r}</SelectItem>
                  ))}
                  {form.role && !availableRoles.includes(form.role) && (
                    <SelectItem value={form.role}>{form.role} (unlisted)</SelectItem>
                  )}
                </SelectContent>
              </Select>
              {errors.role && <p className="text-red-400 text-xs mt-1">{errors.role}</p>}
            </div>
            <div>
              <label className={labelCls}>Skills</label>
              <Input
                className="opacity-60"
                value={form.skillsList.length > 0 ? form.skillsList.map(s => s.name).join(', ') : form.skills}
                readOnly
                placeholder="Select skills in the Skills tab"
              />
              <p className="text-xs text-zinc-500 mt-1">Auto-derived from Skills tab selections</p>
            </div>
            <div>
              <label className={labelCls}>Image</label>
              <div className="space-y-2">
                <div className="flex gap-4">
                  <label className="flex items-center gap-2 cursor-pointer text-sm text-zinc-300">
                    <Input
                      type="radio"
                      checked={imageMode === 'armada'}
                      onChange={() => setImageMode('armada')}
                      className="accent-violet-500"
                    />
                    Armada managed{armadaVersion ? ` (v${armadaVersion})` : ''}
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer text-sm text-zinc-300">
                    <Input
                      type="radio"
                      checked={imageMode === 'custom'}
                      onChange={() => setImageMode('custom')}
                      className="accent-violet-500"
                    />
                    Custom image tag
                  </label>
                </div>
                {imageMode === 'custom' && (
                  <Input
                    value={form.image}
                    onChange={(e) => set('image', e.target.value)}
                    placeholder="ghcr.io/openclaw/openclaw:2026.3.8"
                  />
                )}
                {imageMode === 'armada' && (
                  <p className="text-xs text-zinc-500">
                    Uses the armada-wide version from{' '}
                    <a href="/settings" className="text-violet-400 hover:underline">Settings</a>.
                    {armadaVersion ? ` Currently: ghcr.io/openclaw/openclaw:${armadaVersion}` : ' Falls back to latest if not configured.'}
                  </p>
                )}
              </div>
            </div>
          </div>
        </TabsContent>

        <TabsContent value="Models" className="rounded-lg border border-zinc-800 bg-zinc-800/50 p-6 mt-0">
          <div className="space-y-6">
            {/* Model picker from registry */}
            <div>
              <label className={labelCls}>Model Registry</label>
              <p className="text-sm text-zinc-400 mb-3">Select models from the registry. Use the radio button to set the default.</p>

              {registryModels.length > 0 ? (
                <div className="space-y-2">
                  {registryModels.map((rm) => {
                    const isSelected = form.models.some(m => m.registryId === rm.id);
                    const isDefault = form.models.some(m => m.registryId === rm.id && m.default);
                    const selectedEntry = form.models.find(m => m.registryId === rm.id);
                    const keys = rm.providerId ? (providerKeys[rm.providerId] ?? []) : [];
                    return (
                      <div
                        key={rm.id}
                        onClick={() => {
                          if (isSelected) {
                            set('models', form.models.filter(m => m.registryId !== rm.id));
                          } else {
                            const newEntry: TemplateModel = { registryId: rm.id, default: form.models.length === 0 };
                            set('models', [...form.models, newEntry]);
                            if (rm.providerId) fetchProviderKeys(rm.providerId);
                          }
                        }}
                        className={`px-3 py-2.5 rounded-lg border transition-colors cursor-pointer ${
                          isSelected
                            ? 'border-violet-500/40 bg-violet-500/10'
                            : 'border-zinc-800 bg-zinc-800/50 hover:bg-zinc-700/50'
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          {/* Checkbox */}
                          <div className={`w-4 h-4 rounded flex items-center justify-center shrink-0 ${
                            isSelected ? 'bg-violet-500 text-white' : 'border border-zinc-600'
                          }`}>
                            {isSelected && <Check className="w-3 h-3" />}
                          </div>

                          {/* Radio for default */}
                          {isSelected && (
                            <Button
                              variant="ghost" type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                set('models', form.models.map(m => ({ ...m, default: m.registryId === rm.id })));
                              }}
                              className={`w-3.5 h-3.5 rounded-full border-2 shrink-0 flex items-center justify-center ${
                                isDefault ? 'border-violet-400' : 'border-zinc-600'
                              }`}
                            >
                              {isDefault && <div className="w-1.5 h-1.5 rounded-full bg-violet-400" />}
                            </Button>
                          )}

                          <span className="text-sm text-zinc-100 font-medium truncate">{rm.name}</span>

                          {/* API Key override dropdown — only when selected and provider has keys */}
                          {isSelected && keys.length > 0 && (
                            <div className="ml-auto shrink-0" onClick={(e) => e.stopPropagation()}>
                              <Select
                                value={selectedEntry?.apiKeyId ?? '__default__'}
                                onValueChange={(val) => {
                                  const keyId = val === '__default__' ? undefined : val;
                                  set('models', form.models.map(m =>
                                    m.registryId === rm.id ? { ...m, apiKeyId: keyId } : m
                                  ));
                                }}
                              >
                                <SelectTrigger className="text-xs h-7 border-zinc-800 bg-zinc-800 w-36">
                                  <SelectValue placeholder="Key: Default" />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="__default__">Key: Default</SelectItem>
                                  {keys.map((k: ProviderApiKey) => (
                                    <SelectItem key={k.id} value={k.id}>{k.name}</SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </div>
                          )}

                          {isSelected && isDefault && keys.length === 0 && (
                            <span className="text-[10px] text-violet-300 font-medium ml-auto shrink-0">default</span>
                          )}
                          {isSelected && isDefault && keys.length > 0 && (
                            <span className="text-[10px] text-violet-300 font-medium shrink-0">default</span>
                          )}
                        </div>

                        <div className="flex items-center gap-1.5 mt-1 ml-6 flex-wrap">
                          <span className="text-[11px] text-zinc-500 font-mono truncate">{rm.provider}/{rm.modelId}</span>
                          {rm.capabilities.map((cap: string) => (
                            <span key={cap} className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-violet-500/20 text-violet-300">
                              {cap}
                            </span>
                          ))}
                          <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${
                            rm.costTier === 'cheap' ? 'bg-green-500/20 text-green-300' :
                            rm.costTier === 'premium' ? 'bg-amber-500/20 text-amber-300' :
                            'bg-blue-500/20 text-blue-300'
                          }`}>
                            {rm.costTier}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="text-xs text-zinc-500">No models in registry. Add models via the <span className="text-purple-400">Models</span> page.</p>
              )}
            </div>


          </div>
        </TabsContent>

        <TabsContent value="Plugins" className="rounded-lg border border-zinc-800 bg-zinc-800/50 p-6 mt-0">
          <div className="space-y-6">
            {/* Library plugin picker */}
            <div className="space-y-4">
              <p className="text-sm text-zinc-400 mb-2">Select plugins from the library to auto-install when spawning from this template</p>

              <div className="space-y-2">
                {libraryPlugins.filter(lp => !lp.name.includes('armada-agent')).map((lp) => {
                  const selected = isPluginSelected(lp.name);
                  return (
                    <Button
                      variant="ghost" key={lp.id}
                      type="button"
                      onClick={() => toggleLibraryPlugin(lp)}
                      className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg border transition-colors text-left ${
                        selected
                          ? 'border-violet-500/40 bg-violet-500/10'
                          : 'border-zinc-800 bg-zinc-800/50 hover:bg-zinc-700/50'
                      }`}
                    >
                      <div className={`w-5 h-5 rounded flex items-center justify-center shrink-0 ${
                        selected ? 'bg-violet-500 text-white' : 'border border-zinc-600'
                      }`}>
                        {selected && <Check className="w-3.5 h-3.5" />}
                      </div>
                      <Plug className="w-4 h-4 text-zinc-400 shrink-0" />
                      <span className="text-zinc-100 font-medium flex-1">{lp.name}</span>
                      <Badge className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                        lp.source === 'github' ? 'bg-zinc-500/20 text-zinc-300' :
                        lp.source === 'npm' ? 'bg-red-500/20 text-red-300' :
                        'bg-blue-500/20 text-blue-300'
                      }`}>
                        {lp.source}
                      </Badge>
                      {lp.version && <span className="text-xs text-zinc-500">v{lp.version}</span>}
                    </Button>
                  );
                })}
              </div>

              {libraryPlugins.length === 0 && (
                <p className="text-xs text-zinc-500">
                  No plugins in library yet. Add plugins via the <span className="text-purple-400">Plugin Library</span> page.
                </p>
              )}
            </div>

            {/* Manual plugin entries (legacy) */}
            <div className="border-t border-zinc-800 pt-6">
              <p className="text-sm text-zinc-400 mb-3">Manual plugin entries (advanced)</p>
              {form.plugins.map((p, i) => (
                <div key={i} className="rounded-lg border border-zinc-800 bg-zinc-800/50 p-4 space-y-3 mb-3">
                  <div className="flex items-center gap-3">
                    <Input
                      value={p.id}
                      onChange={(e) => updatePlugin(i, 'id', e.target.value)}
                      placeholder="plugin-id"
                    />
                    <Button
                      variant="ghost" onClick={() => removePlugin(i)}
                      className="shrink-0 text-red-400 hover:text-red-300 text-sm"
                    >
                      Remove
                    </Button>
                  </div>
                  <div>
                    <label className={`${labelCls} text-xs`}>Config (JSON, optional)</label>
                    <Textarea
                      className="font-mono resize-y min-h-[60px]"
                      rows={2}
                      value={p.config ? JSON.stringify(p.config, null, 2) : ''}
                      onChange={(e) => {
                        try {
                          const parsed = e.target.value.trim() ? JSON.parse(e.target.value) : undefined;
                          updatePlugin(i, 'config', parsed);
                        } catch {
                          /* let user keep typing */
                        }
                      }}
                      placeholder='{ "key": "value" }'
                    />
                  </div>
                </div>
              ))}
              <Button
                variant="ghost" onClick={addPlugin}
                className="px-4 py-2 rounded-lg bg-zinc-800/50 text-zinc-300 hover:bg-zinc-700/50 transition-colors text-sm"
              >
                + Add Plugin
              </Button>
            </div>
          </div>
        </TabsContent>

        <TabsContent value="Skills" className="rounded-lg border border-zinc-800 bg-zinc-800/50 p-6 mt-0">
          <div className="space-y-4">
            <p className="text-sm text-zinc-400 mb-2">Select skills from the library to auto-install when spawning from this template</p>



            <div className="space-y-2">
              {librarySkills.map((ls) => {
                const selected = isSkillSelected(ls.name);
                return (
                  <Button
                    variant="ghost" key={ls.id}
                    type="button"
                    onClick={() => toggleLibrarySkill(ls)}
                    className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg border transition-colors text-left ${
                      selected
                        ? 'border-violet-500/40 bg-violet-500/10'
                        : 'border-zinc-800 bg-zinc-800/50 hover:bg-zinc-700/50'
                    }`}
                  >
                    <div className={`w-5 h-5 rounded flex items-center justify-center shrink-0 ${
                      selected ? 'bg-violet-500 text-white' : 'border border-zinc-600'
                    }`}>
                      {selected && <Check className="w-3.5 h-3.5" />}
                    </div>
                    <Package className="w-4 h-4 text-zinc-400 shrink-0" />
                    <span className="text-zinc-100 font-medium flex-1">{ls.name}</span>
                    <Badge className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                      ls.source === 'clawhub' ? 'bg-violet-500/20 text-violet-300' :
                      ls.source === 'github' ? 'bg-zinc-500/20 text-zinc-300' :
                      'bg-blue-500/20 text-blue-300'
                    }`}>
                      {ls.source}
                    </Badge>
                    {ls.version && <span className="text-xs text-zinc-500">v{ls.version}</span>}
                  </Button>
                );
              })}
            </div>

            {librarySkills.length === 0 && (
              <p className="text-xs text-zinc-500">
                No skills in library yet. Add skills via the <span className="text-purple-400">Skills Library</span> page.
              </p>
            )}
          </div>
        </TabsContent>

        <TabsContent value="Contacts" className="rounded-lg border border-zinc-800 bg-zinc-800/50 p-6 mt-0">
          <div className="space-y-4">
            <p className="text-sm text-zinc-400 mb-2">Define which other armada instances this agent can communicate with</p>
            {form.contacts.map((c, i) => (
              <div key={i} className="rounded-lg border border-zinc-800 bg-zinc-800/50 p-4 space-y-3">
                <div className="flex items-center gap-3">
                  <div className="flex-1">
                    <label className={`${labelCls} text-xs`}>Instance Name *</label>
                    <Input
                      value={c.name}
                      onChange={(e) => updateContact(i, 'name', e.target.value)}
                      placeholder="nexus"
                    />
                  </div>
                  <div className="flex-1">
                    <label className={`${labelCls} text-xs`}>Role (optional)</label>
                    <Input
                      value={c.role ?? ''}
                      onChange={(e) => updateContact(i, 'role', e.target.value)}
                      placeholder="project-manager"
                    />
                  </div>
                  <Button
                    variant="ghost" onClick={() => removeContact(i)}
                    className="shrink-0 text-red-400 hover:text-red-300 text-sm mt-6"
                  >
                    Remove
                  </Button>
                </div>
              </div>
            ))}
            <Button
              variant="ghost" onClick={addContact}
              className="px-4 py-2 rounded-lg bg-zinc-800/50 text-zinc-300 hover:bg-zinc-700/50 transition-colors text-sm"
            >
              + Add Contact
            </Button>
          </div>
        </TabsContent>

        <TabsContent value="Tools" className="rounded-lg border border-zinc-800 bg-zinc-800/50 p-6 mt-0">
          <div className="space-y-5">
            <div>
              <label className={labelCls}>Tools Profile</label>
              <Select value={form.toolsProfile || '__none__'} onValueChange={(val) => set('toolsProfile', val === '__none__' ? '' : val)}>
                <SelectTrigger className="w-full border-zinc-800 bg-zinc-800/50">
                  <SelectValue placeholder="None (use allow list)" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">None (use allow list)</SelectItem>
                  {TOOLS_PROFILE_OPTIONS.filter(Boolean).map((p) => (
                    <SelectItem key={p} value={p}>{p}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-zinc-500 mt-1.5">
                OpenClaw preset: minimal, coding, messaging, or full
              </p>
            </div>
            <div>
              <label className={labelCls}>Tool Allow List</label>
              <Input
                value={form.toolsAllow}
                onChange={(e) => set('toolsAllow', e.target.value)}
                placeholder="web_search, exec, Read, Write, …"
              />
              <p className="text-xs text-zinc-500 mt-1.5">
                Comma-separated — only these tools will be available (overrides profile)
              </p>
            </div>
            {/* Binary Tools (eget) */}
            <div className="mt-6 pt-6 border-t border-zinc-800">
              <label className={labelCls}>Binary Tools (GitHub repos)</label>
              <p className="text-xs text-zinc-500 mb-3">
                GitHub repo slugs installed via eget (e.g. cli/cli for GitHub CLI, jqlang/jq)
              </p>
              <div className="flex flex-wrap gap-2 mb-3">
                {form.tools.map((tool, i) => (
                  <span
                    key={i}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 text-sm"
                  >
                    {tool}
                    <Button
                      variant="ghost" type="button"
                      onClick={() => set('tools', form.tools.filter((_, idx) => idx !== i))}
                      className="text-emerald-400 hover:text-red-400 transition-colors ml-1"
                    >
                      ×
                    </Button>
                  </span>
                ))}
              </div>
              <div className="flex gap-2">
                <Input
                  className="flex-1"
                  value={newToolRepo}
                  onChange={(e) => setNewToolRepo(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      const val = newToolRepo.trim();
                      if (val && !form.tools.includes(val)) {
                        set('tools', [...form.tools, val]);
                        setNewToolRepo('');
                      }
                    }
                  }}
                  placeholder="owner/repo (e.g. cli/cli)"
                />
                <Button
                  variant="ghost" type="button"
                  onClick={() => {
                    const val = newToolRepo.trim();
                    if (val && !form.tools.includes(val)) {
                      set('tools', [...form.tools, val]);
                      setNewToolRepo('');
                    }
                  }}
                  className="shrink-0 px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium transition-colors"
                >
                  + Add
                </Button>
              </div>
            </div>
          </div>
        </TabsContent>

        <TabsContent value="SOUL.md" className="rounded-lg border border-zinc-800 bg-zinc-800/50 p-6 mt-0">
          <div>
            <label className={labelCls}>SOUL.md</label>
            <Textarea
              className="font-mono resize-y"
              style={{ minHeight: 200 }}
              rows={10}
              value={form.soul}
              onChange={(e) => set('soul', e.target.value)}
              placeholder="# Soul&#10;&#10;Define the agent's personality…"
            />
          </div>
        </TabsContent>

        <TabsContent value="AGENTS.md" className="rounded-lg border border-zinc-800 bg-zinc-800/50 p-6 mt-0">
          <div>
            <label className={labelCls}>AGENTS.md</label>
            <Textarea
              className="font-mono resize-y"
              style={{ minHeight: 150 }}
              rows={8}
              value={form.agents}
              onChange={(e) => set('agents', e.target.value)}
              placeholder="# Agents&#10;&#10;Define workspace instructions…"
            />
          </div>
        </TabsContent>

        <TabsContent value="Environment" className="rounded-lg border border-zinc-800 bg-zinc-800/50 p-6 mt-0">
          <div className="space-y-3">
            {form.env.map((v, i) => (
              <div key={i} className="flex items-center gap-3">
                <Input
                  value={v}
                  onChange={(e) => updateEnv(i, e.target.value)}
                  placeholder="ENV_VAR_NAME"
                />
                <Button
                  variant="ghost" onClick={() => removeEnv(i)}
                  className="shrink-0 text-red-400 hover:text-red-300 text-sm"
                >
                  Remove
                </Button>
              </div>
            ))}
            <Button
              variant="ghost" onClick={addEnv}
              className="px-4 py-2 rounded-lg bg-zinc-800/50 text-zinc-300 hover:bg-zinc-700/50 transition-colors text-sm"
            >
              + Add Variable
            </Button>
          </div>
        </TabsContent>
      </Tabs>

      {/* Sync Dialog */}
      {showSync && driftData && (
        <SyncDialog
          templateName={form.name}
          agents={driftData}
          onClose={() => { setShowSync(false); setDriftData(null); }}
          onSync={handleSync}
        />
      )}
    </div>
  );
}
