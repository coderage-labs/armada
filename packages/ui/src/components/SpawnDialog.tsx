import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiFetch } from '../hooks/useApi';
import type { Template } from '@coderage-labs/armada-shared';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { ResponsiveDialog as Dialog, ResponsiveDialogContent as DialogContent, ResponsiveDialogFooter as DialogFooter, ResponsiveDialogHeader as DialogHeader, ResponsiveDialogTitle as DialogTitle } from './ui/responsive-dialog';
import { Input } from './ui/input';

interface SpawnDialogProps {
  open: boolean;
  onClose: () => void;
  onSpawned: () => void;
}

interface NodeInfo {
  id: string;
  hostname: string;
  status: string;
  liveStats?: {
    memoryDetail?: { total: number; used: number; available: number };
    memory?: number;
    capacity?: { canSpawn: boolean; availableMemory: number; reason?: string };
  };
}

interface InstanceInfo {
  id: string;
  name: string;
  nodeId: string;
  status: string;
}

function formatMemory(bytes: number): string {
  if (!bytes) return '0 B';
  const gb = bytes / 1024 / 1024 / 1024;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / 1024 / 1024;
  return `${mb.toFixed(0)} MB`;
}

function parseMemoryString(mem: string): number {
  const match = mem.match(/^(\d+(?:\.\d+)?)\s*([kmgt])?b?$/i);
  if (!match) return 0;
  const value = parseFloat(match[1]);
  const unit = (match[2] || '').toLowerCase();
  const mult: Record<string, number> = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 };
  return Math.floor(value * (mult[unit] ?? 1));
}

const NAME_RE = /^[a-z][a-z0-9-]*$/;

export default function SpawnDialog({ open, onClose, onSpawned }: SpawnDialogProps) {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [templateId, setTemplateId] = useState('');
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [loadingTemplates, setLoadingTemplates] = useState(false);
  const [nodes, setNodes] = useState<NodeInfo[]>([]);
  const [instances, setInstances] = useState<InstanceInfo[]>([]);
  const [instanceId, setInstanceId] = useState('');
  const [allProjects, setAllProjects] = useState<Array<{ id: string; name: string; icon: string | null }>>([]);
  const [selectedProjects, setSelectedProjects] = useState<string[]>([]);

  useEffect(() => {
    if (!open) return;
    setError('');
    setName('');
    setTemplateId('');
    setInstanceId('');
    setSelectedProjects([]);
    setLoadingTemplates(true);

    Promise.all([
      apiFetch<Template[]>('/api/templates'),
      apiFetch<NodeInfo[]>('/api/nodes').catch(() => []),
      apiFetch<InstanceInfo[]>('/api/instances').catch(() => []),
      apiFetch<Array<{ id: string; name: string; icon: string | null; archived: boolean }>>('/api/projects').catch(() => []),
    ])
      .then(([t, n, inst, p]) => {
        setTemplates(t);
        setNodes(n);
        const healthyInstances = inst.filter((i: InstanceInfo) => i.status === 'running');
        setInstances(healthyInstances);
        setAllProjects(p.filter(pr => !pr.archived));
        if (t.length > 0) setTemplateId(t[0].id);
        if (healthyInstances.length > 0) setInstanceId(healthyInstances[0].id);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoadingTemplates(false));
  }, [open]);

  const nameValid = name.length >= 2 && NAME_RE.test(name);
  const noInstances = !loadingTemplates && instances.length === 0;
  const selectedTemplate = templates.find((t) => t.id === templateId);
  const templateMemory = selectedTemplate ? parseMemoryString(selectedTemplate.resources.memory) : 0;

  // Check capacity across online nodes
  const onlineNodes = nodes.filter((n) => n.status === 'online');
  const defaultNode = onlineNodes[0];
  const nodeAvailableMemory = defaultNode?.liveStats?.memoryDetail?.available ?? defaultNode?.liveStats?.capacity?.availableMemory ?? 0;
  const capacityOk = defaultNode?.liveStats?.capacity?.canSpawn !== false;
  const memoryExceeds = templateMemory > 0 && nodeAvailableMemory > 0 && templateMemory > nodeAvailableMemory;
  const capacityBlocked = !capacityOk && defaultNode?.liveStats?.capacity?.canSpawn === false;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!nameValid || !templateId || !instanceId || capacityBlocked) return;
    setLoading(true);
    setError('');
    try {
      await apiFetch('/api/agents', {
        method: 'POST',
        body: JSON.stringify({ templateId, name, instanceId, projects: selectedProjects.length > 0 ? selectedProjects : undefined }),
      });
      onSpawned();
      onClose();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg" >
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Spawn Agent</DialogTitle>
          </DialogHeader>

          {error && (
            <div className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-400">
              {error}
            </div>
          )}

          {/* Instance picker */}
          <div className="mt-5">
            <span className="text-sm text-zinc-400">Instance</span>
            {loadingTemplates ? (
              <div className="mt-1 text-sm text-zinc-500">Loading instances…</div>
            ) : noInstances ? (
              <div className="mt-1 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-300">
                No healthy instances available —{' '}
                <Link to="/instances" onClick={onClose} className="underline hover:text-amber-200">
                  create one first
                </Link>
              </div>
            ) : (
              <select
                value={instanceId}
                onChange={(e) => setInstanceId(e.target.value)}
                className="mt-1 block w-full rounded-lg border border-zinc-700 bg-zinc-800/50 px-3 py-2 text-sm text-white focus:border-purple-500 focus:outline-none"
              >
                {instances.map((inst) => (
                  <option key={inst.id} value={inst.id} className="bg-zinc-900">
                    {inst.name}
                  </option>
                ))}
              </select>
            )}
          </div>

          <label className="mt-4 block">
            <span className="text-sm text-zinc-400">Template</span>
            {loadingTemplates ? (
              <div className="mt-1 text-sm text-zinc-500">Loading templates…</div>
            ) : (
              <select
                value={templateId}
                onChange={(e) => setTemplateId(e.target.value)}
                className="mt-1 block w-full rounded-lg border border-zinc-700 bg-zinc-800/50 px-3 py-2 text-sm text-white focus:border-purple-500 focus:outline-none"
              >
                {templates.map((t) => (
                  <option key={t.id} value={t.id} className="bg-zinc-900">
                    {t.name} — {t.role}
                  </option>
                ))}
              </select>
            )}
          </label>

          <label className="mt-4 block">
            <span className="text-sm text-zinc-400">Agent Name</span>
            <Input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value.toLowerCase())}
              placeholder="my-agent"
              className="mt-1 block w-full rounded-lg border border-zinc-700 bg-zinc-800/50 px-3 py-2 text-sm text-white placeholder-gray-600 focus:border-purple-500 focus:outline-none"
            />
            {name.length > 0 && !nameValid && (
              <span className="mt-1 text-xs text-red-400">
                Lowercase letters, numbers, hyphens only. Min 2 chars.
              </span>
            )}
          </label>

          {/* Projects */}
          {allProjects.length > 0 && (
            <div className="mt-4">
              <span className="text-sm text-zinc-400">Projects</span>
              <div className="mt-1 flex flex-wrap gap-2">
                {selectedProjects.map(p => (
                  <Badge key={p} variant="secondary" className="bg-violet-500/20 text-violet-300 border-violet-500/20 gap-1.5">
                    {allProjects.find(ap => ap.name === p)?.icon || '📁'} {p}
                    <Button type="button" variant="ghost" size="icon" onClick={() => setSelectedProjects(selectedProjects.filter(x => x !== p))} className="h-4 w-4 text-violet-400 hover:text-red-400 p-0 hover:bg-transparent">×</Button>
                  </Badge>
                ))}
                <select
                  className="bg-zinc-800/50 border border-zinc-700 text-zinc-300 text-xs rounded-lg px-2 py-1 focus:outline-none focus:border-violet-500/50"
                  value=""
                  onChange={e => {
                    if (e.target.value && !selectedProjects.includes(e.target.value)) {
                      setSelectedProjects([...selectedProjects, e.target.value]);
                    }
                  }}
                >
                  <option value="">+ Add project</option>
                  {allProjects.filter(p => !selectedProjects.includes(p.name)).map(p => (
                    <option key={p.id} value={p.name}>{p.icon || '📁'} {p.name}</option>
                  ))}
                </select>
              </div>
            </div>
          )}

          {/* Resource info */}
          {defaultNode && selectedTemplate && (
            <div className="mt-4 space-y-2">
              {nodeAvailableMemory > 0 && (
                <div className="text-xs text-zinc-500">
                  Node available: {formatMemory(nodeAvailableMemory)} | Template needs: {selectedTemplate.resources.memory}, {selectedTemplate.resources.cpus} CPU
                </div>
              )}
              {memoryExceeds && !capacityBlocked && (
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
                  ⚠️ Template memory ({selectedTemplate.resources.memory}) may exceed available resources ({formatMemory(nodeAvailableMemory)})
                </div>
              )}
              {capacityBlocked && (
                <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
                  🚫 Insufficient resources: {defaultNode.liveStats?.capacity?.reason ?? 'Cannot spawn'}
                </div>
              )}
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={loading}>
              Cancel
            </Button>
            <Button
              type="submit" className="bg-violet-600 hover:bg-violet-700 text-white"
              size="sm"
              disabled={loading || !nameValid || !templateId || !instanceId || noInstances || capacityBlocked}
            >
              {loading ? 'Spawning…' : 'Spawn'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
