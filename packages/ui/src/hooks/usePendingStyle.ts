/**
 * usePendingStyle — className helpers that highlight pending fields amber.
 *
 * Usage:
 *   const ps = usePendingStyle(entity.pendingFields, entity.pendingAction);
 *
 *   // Text labels — swaps text color to amber, adds left accent
 *   <h3 className={ps.pf('name', 'text-zinc-100')}>{entity.name}</h3>
 *
 *   // Inputs — amber left border when field is pending
 *   <Input className={ps.inputPf('baseUrl')} value={...} />
 *
 *   // Icons representing state — amber icon color when pending
 *   <Star className={ps.iconPf('isDefault', 'w-4 h-4 text-violet-400')} />
 *
 *   // Badges — amber variant when field is pending
 *   <Badge className={ps.badgePf('status', 'bg-emerald-500/20 text-emerald-300')}>OK</Badge>
 *
 *   // Check specific field
 *   ps.isFieldPending('baseUrl') // → boolean
 *
 *   // Card wrapper
 *   <div className={`rounded-lg border ${ps.cardClass}`}>
 *
 *   // Row wrapper (lighter, for table rows)
 *   <tr className={ps.rowClass}>
 */

import { useMemo } from 'react';

export interface PendingFields {
  _changed: boolean;
  [key: string]: any;
}

// Strip existing text color classes
const TEXT_COLOR_RE = /\btext-(zinc|gray|slate|emerald|green|red|blue|violet|white|black|amber|orange|cyan|teal|sky|indigo|purple|pink|rose|yellow|lime|fuchsia)-\d+\b/g;

// Strip existing border-l color classes (for inputs)
const BORDER_L_COLOR_RE = /\bborder-l-(zinc|gray|slate|emerald|green|red|blue|violet|amber|orange)-\d+(?:\/\d+)?\b/g;

// Strip existing bg color classes (for badges)
const BG_COLOR_RE = /\bbg-(zinc|gray|slate|emerald|green|red|blue|violet|amber|orange|cyan|teal|sky|yellow|lime|purple|pink|rose|fuchsia|indigo|white|black)-\d+(?:\/\d+)?\b/g;

const PENDING_TEXT = 'text-amber-400 border-l-2 border-amber-500/50 pl-1.5';
const PENDING_INPUT = 'border-l-2 !border-l-amber-500 ring-1 ring-amber-500/20';
const PENDING_ICON = 'text-amber-400';
const PENDING_BADGE_BG = 'bg-amber-500/20';
const PENDING_BADGE_TEXT = 'text-amber-400';
const PENDING_ROW = 'bg-amber-500/5';

function isFieldChanged(fields: PendingFields | null | undefined, path: string): boolean {
  if (!fields) return false;
  const parts = path.split('.');
  let cursor: any = fields;
  for (const part of parts) {
    if (!cursor || typeof cursor !== 'object') return false;
    cursor = cursor[part];
  }
  return cursor?._changed === true;
}

function getCardClass(action: string | null | undefined): string {
  switch (action) {
    case 'create': return 'ring-1 ring-amber-500/40';
    case 'update': return 'ring-1 ring-amber-500/30';
    case 'delete': return 'ring-1 ring-red-500/40 opacity-60';
    default: return '';
  }
}

function getRowClass(action: string | null | undefined): string {
  switch (action) {
    case 'create': return 'bg-amber-500/5 border-l-2 border-l-amber-500';
    case 'update': return 'bg-amber-500/5';
    case 'delete': return 'bg-red-500/5 opacity-60 line-through';
    default: return '';
  }
}

function getAccentClass(action: string | null | undefined, defaultClass: string): string {
  if (action) return 'bg-amber-500';
  return defaultClass;
}

export function usePendingStyle(
  pendingFields?: PendingFields | null,
  pendingAction?: string | null,
) {
  return useMemo(() => {
    /** Check if a specific field has a pending change */
    const isFieldPending = (field: string): boolean =>
      isFieldChanged(pendingFields, field);

    /** Text labels — swaps text-* colors to amber, adds left accent border */
    const pf = (field: string, baseClasses: string): string => {
      if (!isFieldChanged(pendingFields, field)) return baseClasses;
      const stripped = baseClasses.replace(TEXT_COLOR_RE, '').trim();
      return `${stripped} ${PENDING_TEXT}`.replace(/\s+/g, ' ').trim();
    };

    /** Inputs — adds amber left border + subtle ring when field is pending */
    const inputPf = (field: string, extraClasses?: string): string => {
      if (!isFieldChanged(pendingFields, field)) return extraClasses ?? '';
      return `${PENDING_INPUT} ${extraClasses ?? ''}`.trim();
    };

    /** Icons representing state — swaps to amber when field is pending */
    const iconPf = (field: string, baseClasses: string): string => {
      if (!isFieldChanged(pendingFields, field)) return baseClasses;
      const stripped = baseClasses.replace(TEXT_COLOR_RE, '').trim();
      return `${stripped} ${PENDING_ICON}`.replace(/\s+/g, ' ').trim();
    };

    /** Badges — swaps bg + text to amber when field is pending */
    const badgePf = (field: string, baseClasses: string): string => {
      if (!isFieldChanged(pendingFields, field)) return baseClasses;
      const stripped = baseClasses
        .replace(BG_COLOR_RE, '')
        .replace(TEXT_COLOR_RE, '')
        .trim();
      return `${stripped} ${PENDING_BADGE_BG} ${PENDING_BADGE_TEXT}`.replace(/\s+/g, ' ').trim();
    };

    /** Select/dropdown wrapper — amber left border when field is pending */
    const selectPf = (field: string): string => {
      if (!isFieldChanged(pendingFields, field)) return '';
      return PENDING_INPUT;
    };

    /** Switch/toggle wrapper — amber ring when field is pending */
    const switchPf = (field: string): string => {
      if (!isFieldChanged(pendingFields, field)) return '';
      return 'ring-2 ring-amber-500/40 rounded-full';
    };

    return {
      /** Text labels — swaps text color to amber, adds left accent */
      pf,
      /** Inputs — amber left border + ring */
      inputPf,
      /** Icons — swaps to amber */
      iconPf,
      /** Badges — amber bg + text */
      badgePf,
      /** Select/dropdown — amber left border */
      selectPf,
      /** Switch/toggle — amber ring */
      switchPf,
      /** Check if specific field is pending */
      isFieldPending,
      /** CSS classes for the card/row wrapper */
      cardClass: getCardClass(pendingAction),
      /** CSS classes for table row wrapper */
      rowClass: getRowClass(pendingAction),
      /** Current pending action */
      action: pendingAction ?? null,
      /** Whether entity has any pending changes */
      isPending: pendingAction != null,
      /** Get accent bar class (pass default like 'bg-emerald-500') */
      accentClass: (defaultClass: string) => getAccentClass(pendingAction, defaultClass),
    };
  }, [pendingFields, pendingAction]);
}
