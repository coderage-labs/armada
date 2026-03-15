import { useState } from 'react';
import { apiFetch } from '../hooks/useApi';
import { Button } from './ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import { Input } from './ui/input';

interface Props {
  open: boolean;
  agents: string[];
  onClose: () => void;
  onInstalled: () => void;
}

type Source = 'clawhub' | 'github' | 'library';
type Target = 'library' | 'agent';

export default function SkillDialog({ open, agents, onClose, onInstalled }: Props) {
  const [name, setName] = useState('');
  const [source, setSource] = useState<Source>('clawhub');
  const [target, setTarget] = useState<Target>('library');
  const [selectedAgent, setSelectedAgent] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleInstall() {
    if (!name.trim()) {
      setError('Skill name is required');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      if (target === 'library') {
        await apiFetch('/api/skills/install', {
          method: 'POST',
          body: JSON.stringify({ name: name.trim(), source }),
        });
      } else if (target === 'agent' && selectedAgent) {
        await apiFetch(`/api/agents/${encodeURIComponent(selectedAgent)}/skills`, {
          method: 'POST',
          body: JSON.stringify({ name: name.trim(), source }),
        });
      } else {
        setError('Select an agent');
        setLoading(false);
        return;
      }

      setName('');
      setSource('clawhub');
      setTarget('library');
      setSelectedAgent('');
      onInstalled();
      onClose();
    } catch (e: any) {
      setError(e.message ?? 'Install failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Install Skill</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Name */}
          <div>
            <label className="block text-sm text-zinc-400 mb-1">Skill Name</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. weather"
              className="w-full rounded-lg bg-zinc-800/50 border border-zinc-700 px-3 py-2 text-zinc-100 text-sm focus:border-violet-500 focus:outline-none"
            />
          </div>

          {/* Source */}
          <div>
            <label className="block text-sm text-zinc-400 mb-1">Source</label>
            <div className="flex gap-2">
              {(['clawhub', 'github', 'library'] as Source[]).map((s) => (
                <Button
                  key={s}
                  size="sm"
                  variant={source === s ? 'default' : 'ghost'}
                  onClick={() => setSource(s)}
                >
                  {s === 'clawhub' ? 'ClawHub' : s === 'github' ? 'GitHub' : 'Library'}
                </Button>
              ))}
            </div>
          </div>

          {/* Target */}
          <div>
            <label className="block text-sm text-zinc-400 mb-1">Install To</label>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant={target === 'library' ? 'default' : 'ghost'}
                onClick={() => setTarget('library')}
              >
                Shared Library
              </Button>
              <Button
                size="sm"
                variant={target === 'agent' ? 'default' : 'ghost'}
                onClick={() => setTarget('agent')}
              >
                Specific Agent
              </Button>
            </div>
          </div>

          {/* Agent selector */}
          {target === 'agent' && (
            <div>
              <label className="block text-sm text-zinc-400 mb-1">Agent</label>
              <select
                value={selectedAgent}
                onChange={(e) => setSelectedAgent(e.target.value)}
                className="w-full rounded-lg bg-zinc-800/50 border border-zinc-700 px-3 py-2 text-zinc-100 text-sm focus:border-violet-500 focus:outline-none"
              >
                <option value="">Select agent…</option>
                {agents.map((a) => (
                  <option key={a} value={a}>{a}</option>
                ))}
              </select>
            </div>
          )}

          {/* Error */}
          {error && (
            <p className="text-sm text-red-400">{error}</p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" onClick={handleInstall} disabled={loading}>
            {loading ? 'Installing…' : 'Install'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
