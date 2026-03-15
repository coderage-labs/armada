import { useCallback, useState } from 'react';
import { Check, Copy, X } from 'lucide-react';
import { useSSEAll } from '../providers/SSEProvider';
import { Button } from './ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from './ui/dialog';

interface NodeInstallModalProps {
  nodeId: string;
  installToken: string;
  onClose: () => void;
}

const ARMADA_ORIGIN =
  (typeof window !== 'undefined' && (window as any).__ARMADA_ORIGIN__) ||
  'https://armada.example.com';

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  }

  return (
    <Button
     variant="secondary"
      size="sm"
      onClick={handleCopy}
      className="flex-shrink-0"
      title="Copy to clipboard"
    >
      {copied ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
      {copied ? 'Copied!' : 'Copy'}
    </Button>
  );
}

export default function NodeInstallModal({ nodeId, installToken, onClose }: NodeInstallModalProps) {
  const [connected, setConnected] = useState(false);

  const curlCommand = `curl -fsSL ${ARMADA_ORIGIN}/install | sh -s -- --token ${installToken}`;
  const dockerCommand = `docker run -d --name armada-node --restart unless-stopped \\
  --memory=256m --memory-swap=512m --cpus=0.5 \\
  -v /var/run/docker.sock:/var/run/docker.sock \\
  -v ~/armada-data:/data \\
  -v ~/armada-data/node-credentials:/etc/armada-node \\
  -e ARMADA_CONTROL_URL=wss://${ARMADA_ORIGIN.replace(/^https?:\/\//, '')}/api/nodes/ws \\
  -e ARMADA_NODE_TOKEN=${installToken} \\
  -e HOST_DATA_DIR=\${HOME}/armada-data \\
  ghcr.io/coderage-labs/armada-node:latest`;

  // Listen for SSE — when this node connects, update status
  useSSEAll(useCallback((type: string, data: any) => {
    if (type === 'node.connected' && data.nodeId === nodeId) {
      setConnected(true);
    }
  }, [nodeId]));

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-2xl p-0 overflow-hidden" showClose={false}>
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-700">
          <DialogHeader className="mb-0 space-y-0">
            <DialogTitle>Node Registered</DialogTitle>
            <DialogDescription>Run one of the commands below on your target machine</DialogDescription>
          </DialogHeader>
          <Button variant="ghost" size="icon" onClick={onClose} className="h-8 w-8 flex-shrink-0">
            <X className="w-5 h-5" />
          </Button>
        </div>

        <div className="p-6 space-y-5">
          {/* Connection status */}
          <div className={`flex items-center gap-3 rounded-xl border px-4 py-3 ${
            connected
              ? 'border-green-500/30 bg-green-500/10'
              : 'border-yellow-500/20 bg-yellow-500/5'
          }`}>
            <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${
              connected ? 'bg-green-500' : 'bg-yellow-500 animate-pulse'
            }`} />
            <span className={`text-sm font-medium ${connected ? 'text-green-300' : 'text-yellow-300'}`}>
              {connected ? '✓ Node connected!' : 'Waiting for connection…'}
            </span>
            {connected && (
              <span className="text-xs text-zinc-400 ml-auto">The node agent is online and ready</span>
            )}
          </div>

          {/* Install Token */}
          <div>
            <p className="text-xs text-zinc-500 mb-1.5 font-medium uppercase tracking-wide">Install Token</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 bg-black/40 rounded-lg px-3 py-2 text-xs font-mono text-zinc-300 break-all">
                {installToken}
              </code>
              <CopyButton text={installToken} />
            </div>
          </div>

          {/* Curl install */}
          <div>
            <p className="text-xs text-zinc-500 mb-1.5 font-medium uppercase tracking-wide">Install via Script</p>
            <div className="flex items-start gap-2">
              <pre className="flex-1 bg-black/40 rounded-lg p-4 text-xs font-mono text-zinc-400 overflow-x-auto whitespace-pre-wrap break-all">
                {curlCommand}
              </pre>
              <CopyButton text={curlCommand} />
            </div>
          </div>

          {/* Docker install */}
          <div>
            <p className="text-xs text-zinc-500 mb-1.5 font-medium uppercase tracking-wide">Install via Docker</p>
            <div className="flex items-start gap-2">
              <pre className="flex-1 bg-black/40 rounded-lg p-4 text-xs font-mono text-zinc-400 overflow-x-auto whitespace-pre-wrap">
                {dockerCommand}
              </pre>
              <CopyButton text={dockerCommand} />
            </div>
          </div>

          <p className="text-xs text-zinc-600">
            This token can only be used once. The node will establish a persistent WebSocket connection to the control plane.
          </p>
        </div>

        <div className="flex justify-end px-6 py-4 border-t border-zinc-700">
          <Button variant="outline" size="sm" onClick={onClose}>
            {connected ? 'Done' : 'Close'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
