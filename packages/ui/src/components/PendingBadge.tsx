import { Plus, Pencil, Trash2 } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip';

const BADGE_STYLES = {
  create: 'text-emerald-400',
  update: 'text-amber-400',
  delete: 'text-red-400',
};

const BADGE_ICONS = {
  create: Plus,
  update: Pencil,
  delete: Trash2,
};

const BADGE_LABELS = {
  create: 'Pending creation',
  update: 'Pending changes',
  delete: 'Pending removal',
};

export function PendingBadge({ action }: { action: 'create' | 'update' | 'delete' }) {
  const Icon = BADGE_ICONS[action];
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className={`inline-flex items-center ${BADGE_STYLES[action]}`}>
            <Icon className="w-3 h-3" />
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs">
          {BADGE_LABELS[action]}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
