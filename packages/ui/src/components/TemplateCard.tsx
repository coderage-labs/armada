import type { Template } from '@coderage-labs/armada-shared';
import { Pencil, Copy, Trash2 } from 'lucide-react';
import { Button } from './ui/button';
import { BaseCard } from './shared';

interface Props {
  template: Template;
  hasDrift?: boolean;
  onEdit: (id: string) => void;
  onClone: (t: Template) => void;
  onDelete: (id: string) => void;
}

const roleBadgeColor: Record<string, string> = {
  lead: 'bg-purple-500/20 text-purple-300',
  developer: 'bg-blue-500/20 text-blue-300',
  researcher: 'bg-green-500/20 text-green-300',
  reviewer: 'bg-yellow-500/20 text-yellow-300',
};

export default function TemplateCard({ template, hasDrift, onEdit, onClone, onDelete }: Props) {
  const badge = roleBadgeColor[template.role] ?? 'bg-zinc-700/50 text-zinc-300';

  return (
    <BaseCard
      accentColor="bg-violet-500"
      footer={
        <>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onEdit(template.id)}
            className="flex-1 text-xs h-8 gap-1.5 border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50"
          >
            <Pencil className="w-3 h-3" /> Edit
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onClone(template)}
            className="flex-1 text-xs h-8 gap-1.5 border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50"
          >
            <Copy className="w-3 h-3" /> Clone
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onDelete(template.id)}
            className="flex-1 text-xs h-8 gap-1.5 border-red-500/20 text-red-400/70 hover:text-red-400 hover:bg-red-500/10 hover:border-red-500/40"
          >
            <Trash2 className="w-3 h-3" /> Delete
          </Button>
        </>
      }
    >
      {/* Header */}
      <div className="p-5 pb-0">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="text-base font-semibold text-zinc-100 truncate">{template.name}</h3>
              {hasDrift && (
                <span
                  className="w-2 h-2 rounded-full bg-amber-400 shrink-0 animate-pulse"
                  title="Agents have drifted from this template"
                />
              )}
            </div>
            {template.role && (
              <span className={`inline-block mt-1 text-[11px] px-2 py-0.5 rounded-md font-medium ${badge}`}>
                {template.role}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Details */}
      <div className="p-5 pt-4 space-y-2.5 flex-1">
        {template.description && (
          <p className="text-xs text-zinc-400 line-clamp-2">{template.description}</p>
        )}
        <div className="space-y-2 pt-1">
          {template.model && (
            <div className="flex justify-between text-xs">
              <span className="text-zinc-500">Model</span>
              <span className="text-zinc-400 truncate max-w-[60%] text-right">{template.model}</span>
            </div>
          )}
          <div className="flex justify-between text-xs">
            <span className="text-zinc-500">Resources</span>
            <span className="text-zinc-400">{template.resources.memory} · {template.resources.cpus} CPU{Number(template.resources.cpus) !== 1 ? 's' : ''}</span>
          </div>
          {template.plugins.length > 0 && (
            <div className="flex justify-between text-xs">
              <span className="text-zinc-500">Plugins</span>
              <span className="text-zinc-400">{template.plugins.length} plugin{template.plugins.length !== 1 ? 's' : ''}</span>
            </div>
          )}
          {template.internalAgents?.length > 0 && (
            <div className="flex justify-between text-xs">
              <span className="text-zinc-500">Internal agents</span>
              <span className="text-zinc-400">{template.internalAgents.length}</span>
            </div>
          )}
        </div>
      </div>
    </BaseCard>
  );
}
