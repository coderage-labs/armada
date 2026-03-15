import { useEffect, useState } from 'react';
import { apiFetch } from '../hooks/useApi';
import { Button } from './ui/button';
import { ResponsiveDialog as Dialog, ResponsiveDialogContent as DialogContent, ResponsiveDialogDescription as DialogDescription, ResponsiveDialogFooter as DialogFooter, ResponsiveDialogHeader as DialogHeader, ResponsiveDialogTitle as DialogTitle } from './ui/responsive-dialog';
import { Input } from './ui/input';

interface NodeDialogProps {
  open: boolean;
  node?: {
    id: string;
    hostname: string;
    url?: string;
    token?: string;
  } | null;
  /** Pre-fill the hostname field (e.g. when adding a discovered node) */
  prefillHostname?: string;
  onClose: () => void;
  onSaved: () => void;
  onCreated?: (nodeId: string, installToken: string) => void;
}

export default function NodeDialog({ open, node, prefillHostname, onClose, onSaved, onCreated }: NodeDialogProps) {
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [hostname, setHostname] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const isEdit = !!node;

  useEffect(() => {
    if (open) {
      setUrl(node?.url ?? '');
      setToken(node?.token ?? '');
      setHostname(node?.hostname ?? prefillHostname ?? '');
      setError('');
    }
  }, [open, node, prefillHostname]);

  async function handleSave() {
    setSaving(true);
    setError('');
    try {
      if (isEdit && node) {
        await apiFetch(`/api/nodes/${node.id}`, {
          method: 'PUT',
          body: JSON.stringify({ url: url || undefined, token: token || undefined, hostname: hostname || undefined }),
        });
        onSaved();
        onClose();
      } else {
        const result = await apiFetch<{ id: string; installToken: string }>('/api/nodes', {
          method: 'POST',
          body: JSON.stringify({ hostname: hostname || 'new-node', url: url || undefined, token: token || undefined }),
        });
        onSaved();
        onClose();
        if (onCreated && result.installToken) {
          onCreated(result.id, result.installToken);
        }
      }
    } catch (e: any) {
      setError(e.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg" >
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit Node' : 'Register Node'}</DialogTitle>
          {!isEdit && (
            <DialogDescription>
              Give this node a name. After registration you'll get an install command to run on the target machine.
            </DialogDescription>
          )}
        </DialogHeader>

        <div className="space-y-4">
          {/* Hostname / Label */}
          <div>
            <label className="block text-sm text-zinc-400 mb-1">
              {isEdit ? 'Hostname' : 'Node Name / Label'}
            </label>
            <Input
              type="text"
              value={hostname}
              onChange={(e) => setHostname(e.target.value)}
              placeholder={isEdit ? 'e.g. worker-01' : 'e.g. my-server'}
              className="w-full rounded-lg border border-zinc-700 bg-zinc-800/50 px-3 py-2.5 text-sm text-zinc-100 placeholder-gray-600 focus:border-violet-500/50 focus:outline-none focus:ring-1 focus:ring-violet-500/50"
            />
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
          <Button size="sm" onClick={handleSave} disabled={saving} className="bg-violet-600 hover:bg-violet-700 text-white">
            {saving ? 'Saving…' : isEdit ? 'Update' : 'Register Node'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
