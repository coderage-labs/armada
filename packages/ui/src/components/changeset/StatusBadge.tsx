import { Loader2 } from 'lucide-react';
import type { Changeset } from '@coderage-labs/armada-shared';

export type ChangesetStatus = Changeset['status'];

export const STATUS_STYLES: Record<ChangesetStatus, string> = {
  draft:       'bg-zinc-500/20 text-zinc-400 border-zinc-500/30',
  approved:    'bg-yellow-500/20 text-yellow-300 border-yellow-500/30',
  applying:    'bg-violet-500/20 text-violet-300 border-violet-500/30',
  completed:   'bg-green-500/20 text-green-300 border-green-500/30',
  failed:      'bg-red-500/20 text-red-300 border-red-500/30',
  rolled_back: 'bg-orange-500/20 text-orange-300 border-orange-500/30',
  cancelled:   'bg-zinc-600/20 text-zinc-500 border-zinc-600/30',
};

export function StatusBadge({ status }: { status: ChangesetStatus }) {
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border font-medium ${STATUS_STYLES[status] ?? ''}`}>
      {status === 'applying' && <Loader2 className="w-2.5 h-2.5 animate-spin" />}
      {status}
    </span>
  );
}
