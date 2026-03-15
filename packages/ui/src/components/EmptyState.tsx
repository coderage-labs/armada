import type { ComponentType } from 'react';
import { Button } from './ui/button';

interface EmptyStateProps {
  icon: ComponentType<{ className?: string }>;
  title: string;
  description?: string;
  action?: {
    label: string;
    onClick: () => void;
  };
}

export function EmptyState({ icon: Icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="flex items-center justify-center w-12 h-12 rounded-xl bg-zinc-800/50 text-zinc-500 mb-4">
        <Icon className="w-6 h-6" />
      </div>
      <h3 className="text-sm font-medium text-zinc-300 mb-1">{title}</h3>
      {description && <p className="text-xs text-zinc-500 max-w-xs">{description}</p>}
      {action && (
        <Button
          variant="default"
          size="sm"
          onClick={action.onClick}
          className="mt-4"
        >
          {action.label}
        </Button>
      )}
    </div>
  );
}
