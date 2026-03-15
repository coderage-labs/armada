/**
 * PendingField — wraps a value and highlights it amber if it has a pending mutation.
 * 
 * Usage:
 *   <PendingField field="name" pendingFields={entity.pendingFields}>
 *     {entity.name}
 *   </PendingField>
 * 
 * If the field is changed, renders with amber text and a subtle left border.
 * If pendingFields is null or the field isn't changed, renders children as-is.
 */

import type { ReactNode } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from './ui/tooltip';

export interface PendingFieldsMap {
  _changed: boolean;
  [key: string]: any;
}

interface PendingFieldProps {
  field: string;
  pendingFields: PendingFieldsMap | null;
  children: ReactNode;
  className?: string;
  /** Show a tooltip with committed → pending values */
  showDiff?: boolean;
}

function getFieldNode(fields: PendingFieldsMap | null, path: string): any {
  if (!fields) return null;
  const parts = path.split('.');
  let cursor: any = fields;
  for (const part of parts) {
    if (!cursor || typeof cursor !== 'object') return null;
    cursor = cursor[part];
  }
  return cursor;
}

export function PendingField({ field, pendingFields, children, className = '', showDiff = true }: PendingFieldProps) {
  const node = getFieldNode(pendingFields, field);
  const isChanged = node && node._changed;

  if (!isChanged) {
    return <span className={className}>{children}</span>;
  }

  const content = (
    <span className={`text-amber-400 border-l-2 border-amber-500/50 pl-1.5 ${className}`}>
      {children}
    </span>
  );

  if (!showDiff || node.committed === undefined) {
    return content;
  }

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          {content}
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-xs">
          <div className="text-xs space-y-1">
            <div className="text-zinc-400">
              <span className="text-zinc-500">Was:</span>{' '}
              <span className="text-red-300 line-through">{String(node.committed ?? '(none)')}</span>
            </div>
            <div className="text-zinc-400">
              <span className="text-zinc-500">Now:</span>{' '}
              <span className="text-amber-300">{String(node.pending ?? '(none)')}</span>
            </div>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/**
 * Helper to check if an entity has any pending changes.
 */
export function isPending(entity: { pendingAction?: string | null }): boolean {
  return entity.pendingAction != null;
}

/**
 * Helper to get the card accent border class based on pending state.
 */
export function pendingCardClass(entity: { pendingAction?: string | null }): string {
  switch (entity.pendingAction) {
    case 'create': return 'border-l-4 border-l-amber-500';
    case 'update': return 'border-l-4 border-l-amber-500/50';
    case 'delete': return 'border-l-4 border-l-red-500 opacity-60';
    default: return '';
  }
}
