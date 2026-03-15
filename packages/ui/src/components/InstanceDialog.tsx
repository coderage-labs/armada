import { useEffect, useState } from 'react';
import { apiFetch } from '../hooks/useApi';
import { Button } from './ui/button';
import { ResponsiveDialog as Dialog, ResponsiveDialogContent as DialogContent, ResponsiveDialogFooter as DialogFooter, ResponsiveDialogHeader as DialogHeader, ResponsiveDialogTitle as DialogTitle } from './ui/responsive-dialog';
import { Input } from './ui/input';

interface NodeOption {
  id: string;
  hostname: string;
  status: string;
  cores: number;
  memory: number; // bytes
}

interface InstanceDialogProps {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}

const MEMORY_OPTIONS: { label: string; value: string; bytes: number }[] = [
  { label: '512 MB', value: '512m', bytes: 512 * 1024 * 1024 },
  { label: '1 GB',   value: '1g',   bytes: 1 * 1024 * 1024 * 1024 },
  { label: '2 GB',   value: '2g',   bytes: 2 * 1024 * 1024 * 1024 },
  { label: '4 GB',   value: '4g',   bytes: 4 * 1024 * 1024 * 1024 },
  { label: '8 GB',   value: '8g',   bytes: 8 * 1024 * 1024 * 1024 },
  { label: '16 GB',  value: '16g',  bytes: 16 * 1024 * 1024 * 1024 },
];

const CPU_OPTIONS: { label: string; value: string; cores: number }[] = [
  { label: '0.5',  value: '0.5', cores: 0.5 },
  { label: '1',    value: '1',   cores: 1 },
  { label: '2',    value: '2',   cores: 2 },
  { label: '4',    value: '4',   cores: 4 },
  { label: '8',    value: '8',   cores: 8 },
];

const DEFAULT_MEMORY = '2g';
const DEFAULT_CPUS = '1';

function getFilteredMemory(node: NodeOption | undefined) {
  if (!node) return MEMORY_OPTIONS;
  return MEMORY_OPTIONS.filter((opt) => opt.bytes <= node.memory);
}

function getFilteredCpus(node: NodeOption | undefined) {
  if (!node) return CPU_OPTIONS;
  return CPU_OPTIONS.filter((opt) => opt.cores <= node.cores);
}

export default function InstanceDialog({ open, onClose, onSaved }: InstanceDialogProps) {
  const [name, setName] = useState('');
  const [nodeId, setNodeId] = useState('');
  const [capacity, setCapacity] = useState('5');
  const [memory, setMemory] = useState(DEFAULT_MEMORY);
  const [cpus, setCpus] = useState(DEFAULT_CPUS);
  const [nodes, setNodes] = useState<NodeOption[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const selectedNode = nodes.find((n) => n.id === nodeId);
  const memoryOptions = getFilteredMemory(selectedNode);
  const cpuOptions = getFilteredCpus(selectedNode);

  // Reset form on open
  useEffect(() => {
    if (open) {
      setName('');
      setNodeId('');
      setCapacity('5');
      setMemory(DEFAULT_MEMORY);
      setCpus(DEFAULT_CPUS);
      setError('');
      apiFetch<NodeOption[]>('/api/nodes')
        .then((data) => {
          setNodes(data);
          if (data.length === 1) setNodeId(data[0].id);
        })
        .catch(() => {});
    }
  }, [open]);

  // Re-filter options when node changes; reset values if they exceed new limits
  useEffect(() => {
    if (!selectedNode) return;
    const filteredMem = getFilteredMemory(selectedNode);
    const filteredCpu = getFilteredCpus(selectedNode);

    const memValid = filteredMem.some((o) => o.value === memory);
    if (!memValid) {
      const best = filteredMem.find((o) => o.value === DEFAULT_MEMORY) ?? filteredMem[filteredMem.length - 1];
      setMemory(best?.value ?? DEFAULT_MEMORY);
    }

    const cpuValid = filteredCpu.some((o) => o.value === cpus);
    if (!cpuValid) {
      const best = filteredCpu.find((o) => o.value === DEFAULT_CPUS) ?? filteredCpu[filteredCpu.length - 1];
      setCpus(best?.value ?? DEFAULT_CPUS);
    }
  }, [nodeId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSave() {
    if (!name.trim()) {
      setError('Name is required');
      return;
    }
    if (!nodeId) {
      setError('Please select a node');
      return;
    }
    setSaving(true);
    setError('');
    try {
      await apiFetch('/api/instances', {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim(),
          nodeId,
          capacity: parseInt(capacity, 10) || 5,
          memory,
          cpus,
        }),
      });
      onSaved();
      onClose();
    } catch (e: any) {
      setError(e.message || 'Failed to create instance');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg" >
        <DialogHeader>
          <DialogTitle>New Instance</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Name */}
          <div>
            <label className="block text-sm text-zinc-400 mb-1">Instance Name *</label>
            <Input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-instance"
              className="w-full rounded-lg border border-zinc-700 bg-zinc-800/50 px-3 py-2.5 text-sm text-zinc-100 placeholder-gray-600 focus:border-violet-500/50 focus:outline-none focus:ring-1 focus:ring-violet-500/50"
            />
          </div>

          {/* Node */}
          <div>
            <label className="block text-sm text-zinc-400 mb-1">Node *</label>
            {nodes.length === 1 ? (
              <div className="w-full rounded-lg border border-zinc-700 bg-zinc-800/50 px-3 py-2.5 text-sm text-zinc-100">
                {nodes[0].hostname} <span className="text-zinc-500">({nodes[0].status})</span>
              </div>
            ) : (
              <select
                value={nodeId}
                onChange={(e) => setNodeId(e.target.value)}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-800/50 px-3 py-2.5 text-sm text-zinc-100 focus:border-violet-500/50 focus:outline-none focus:ring-1 focus:ring-violet-500/50"
              >
                <option value="" className="bg-zinc-900">Select a node…</option>
                {nodes.map((node) => (
                  <option key={node.id} value={node.id} className="bg-zinc-900">
                    {node.hostname} ({node.status})
                  </option>
                ))}
              </select>
            )}
          </div>

          {/* Capacity */}
          <div>
            <label className="block text-sm text-zinc-400 mb-1">Agent Capacity</label>
            <Input
              type="number"
              min={1}
              max={50}
              value={capacity}
              onChange={(e) => setCapacity(e.target.value)}
              className="w-full rounded-lg border border-zinc-700 bg-zinc-800/50 px-3 py-2.5 text-sm text-zinc-100 placeholder-gray-600 focus:border-violet-500/50 focus:outline-none focus:ring-1 focus:ring-violet-500/50"
            />
            <p className="text-xs text-zinc-600 mt-1">Maximum number of agents this instance can host</p>
          </div>

          {/* Resources */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm text-zinc-400 mb-1">Memory</label>
              <select
                value={memory}
                onChange={(e) => setMemory(e.target.value)}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2.5 text-sm text-white focus:border-violet-500/50 focus:outline-none focus:ring-1 focus:ring-violet-500/50"
              >
                {memoryOptions.map((opt) => (
                  <option key={opt.value} value={opt.value} className="bg-zinc-800">
                    {opt.label}
                  </option>
                ))}
                {memoryOptions.length === 0 && (
                  <option value={DEFAULT_MEMORY} className="bg-zinc-800">2 GB</option>
                )}
              </select>
              {selectedNode && (
                <p className="text-xs text-zinc-600 mt-1">Node total: {(selectedNode.memory / 1024 / 1024 / 1024).toFixed(0)} GB</p>
              )}
            </div>
            <div>
              <label className="block text-sm text-zinc-400 mb-1">CPUs</label>
              <select
                value={cpus}
                onChange={(e) => setCpus(e.target.value)}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2.5 text-sm text-white focus:border-violet-500/50 focus:outline-none focus:ring-1 focus:ring-violet-500/50"
              >
                {cpuOptions.map((opt) => (
                  <option key={opt.value} value={opt.value} className="bg-zinc-800">
                    {opt.label}
                  </option>
                ))}
                {cpuOptions.length === 0 && (
                  <option value={DEFAULT_CPUS} className="bg-zinc-800">1</option>
                )}
              </select>
              {selectedNode && (
                <p className="text-xs text-zinc-600 mt-1">Node cores: {selectedNode.cores}</p>
              )}
            </div>
          </div>

          {/* Error */}
          {error && (
            <p className="text-sm text-red-400">{error}</p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            size="sm" className="bg-violet-600 hover:bg-violet-700 text-white"
            onClick={handleSave}
            disabled={saving || !name.trim() || !nodeId}
          >
            {saving ? 'Creating…' : 'Create Instance'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
