import { useState, useEffect, useCallback } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { apiFetch } from '../../hooks/useApi';
import { PendingBadge } from '../PendingBadge';
import { Button } from '../ui/button';
import type { DiffNode } from '@coderage-labs/armada-shared';

/* ── Local types ─────────────────────────────────────────────────── */

export interface PendingMutation {
  id: string;
  changesetId: string;
  entityType: string;
  entityId: string | null;
  action: 'create' | 'update' | 'delete';
  payload: Record<string, any>;
  createdAt: string;
}

/** @deprecated Use DiffNode tree instead */
export interface MutationDiffField {
  field: string;
  label: string;
  currentValue: any;
  pendingValue: any;
  changed: boolean;
  truncated?: boolean;
}

export interface MutationDiff {
  mutationId: string;
  entityType: string;
  entityId: string | null;
  entityName: string;
  action: 'create' | 'update' | 'delete';
  changes?: DiffNode[];
  /** @deprecated Use changes tree instead */
  fields?: MutationDiffField[];
}

/* ── Helpers ─────────────────────────────────────────────────────── */

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function formatPayloadFields(payload: Record<string, any>, action: 'create' | 'update' | 'delete'): string {
  if (action === 'delete') return 'Will be removed';
  const SHOW_KEYS = ['name', 'model', 'role', 'image', 'plugin', 'version'];
  const entries = Object.entries(payload).filter(([k]) => SHOW_KEYS.includes(k) && k !== 'name');
  if (entries.length === 0) return '';
  return entries.map(([k, v]) => `${k}: ${v}`).join(', ');
}

export function summarizeItem(item: any): string {
  if (typeof item === 'string') return item;
  if (typeof item !== 'object' || item === null) return String(item);
  return item.name || item.modelId || item.registryId?.slice(0, 8) || JSON.stringify(item).slice(0, 40);
}

export function formatDiffValue(value: any): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) {
    if (value.length === 0) return '(empty)';
    const items = value.slice(0, 5).map(summarizeItem);
    const preview = items.join(', ');
    return value.length > 5 ? `${preview} + ${value.length - 5} more` : preview;
  }
  if (typeof value === 'object') {
    const s = JSON.stringify(value);
    return s.length > 80 ? s.substring(0, 80) + '…' : s;
  }
  const str = String(value);
  if (str.length > 80) return str.substring(0, 60) + '…';
  return str;
}

/* ── Diff Tree Components ────────────────────────────────────────── */

export function DiffTree({ nodes, depth = 0 }: { nodes: DiffNode[]; depth?: number }) {
  return (
    <div className={depth > 0 ? 'ml-4 border-l border-zinc-800 pl-2' : ''}>
      {nodes.map((node, i) => (
        <DiffTreeNode key={node.path || i} node={node} depth={depth} />
      ))}
    </div>
  );
}

export function DiffTreeNode({ node, depth }: { node: DiffNode; depth: number }) {
  const [expanded, setExpanded] = useState(depth < 1);
  const hasChildren = node.children && node.children.length > 0;

  return (
    <div className="py-0.5">
      <div
        className={`flex items-start gap-1.5 text-xs ${hasChildren ? 'cursor-pointer hover:bg-zinc-900/50' : ''}`}
        onClick={hasChildren ? () => setExpanded(!expanded) : undefined}
      >
        {hasChildren && (
          expanded
            ? <ChevronDown className="w-3 h-3 text-zinc-500 mt-0.5 shrink-0" />
            : <ChevronRight className="w-3 h-3 text-zinc-500 mt-0.5 shrink-0" />
        )}
        {!hasChildren && <span className="w-3 shrink-0" />}

        <span className="text-zinc-400 shrink-0">{node.label}</span>

        {!hasChildren && (
          <div className="flex gap-1.5 min-w-0">
            {node.oldValue !== undefined && node.oldValue !== null && (
              <span className="text-red-400/70 line-through truncate">
                {formatDiffValue(node.oldValue)}
              </span>
            )}
            {node.type !== 'remove' && node.newValue !== undefined && node.newValue !== null && (
              <span className="text-emerald-400 truncate">
                {formatDiffValue(node.newValue)}
              </span>
            )}
            {node.truncated && (
              <span className="text-zinc-600 text-[10px]">(truncated)</span>
            )}
          </div>
        )}

        {hasChildren && (
          <span className="text-zinc-600 text-[10px]">
            ({node.children!.length} change{node.children!.length !== 1 ? 's' : ''})
          </span>
        )}
      </div>

      {hasChildren && expanded && (
        <DiffTree nodes={node.children!} depth={depth + 1} />
      )}
    </div>
  );
}

/* ── MutationRow ─────────────────────────────────────────────────── */

export function MutationRow({ mutation, changesetId }: { mutation: PendingMutation; changesetId: string }) {
  const [expanded, setExpanded] = useState(false);
  const [diff, setDiff] = useState<MutationDiff | null>(null);
  const [loading, setLoading] = useState(false);

  const entityName = mutation.payload?.name ?? mutation.entityId ?? '—';
  const detail = formatPayloadFields(mutation.payload, mutation.action);

  const loadDiff = useCallback(async () => {
    if (diff) return;
    setLoading(true);
    try {
      const diffs = await apiFetch<MutationDiff[]>(`/api/pending-mutations/changeset/${changesetId}/diff`);
      const myDiff = diffs.find(d => d.mutationId === mutation.id);
      if (myDiff) setDiff(myDiff);
    } catch (err) {
      console.error('Failed to load diff:', err);
    } finally {
      setLoading(false);
    }
  }, [changesetId, mutation.id, diff]);

  const handleToggle = () => {
    if (!expanded) loadDiff();
    setExpanded(!expanded);
  };

  const hasChanges = diff?.changes && diff.changes.length > 0;
  const hasFields = diff?.fields && diff.fields.length > 0;

  return (
    <div className="border-b border-zinc-800 last:border-0">
      <Button
       variant="ghost"
        className="w-full flex items-start gap-2 py-1.5 text-xs text-left hover:bg-zinc-900/50 h-auto justify-start"
        onClick={handleToggle}
      >
        <div className="shrink-0 mt-0.5">
          {expanded ? (
            <ChevronDown className="w-3 h-3 text-zinc-500" />
          ) : (
            <ChevronRight className="w-3 h-3 text-zinc-500" />
          )}
        </div>
        <div className="shrink-0 mt-0.5">
          <PendingBadge action={mutation.action} />
        </div>
        <div className="flex-1 min-w-0">
          <span className="text-zinc-300 font-medium">{capitalize(mutation.entityType)}: </span>
          <span className={`text-zinc-200 ${mutation.action === 'delete' ? 'line-through text-zinc-500' : ''}`}>
            {entityName}
          </span>
          {detail && (
            <span className="text-zinc-500 ml-2">— {detail}</span>
          )}
        </div>
      </Button>

      {expanded && (
        <div className="ml-8 mb-2 space-y-1 text-xs">
          {loading && (
            <div className="text-zinc-600 animate-pulse">Loading diff…</div>
          )}
          {!loading && hasChanges && (
            <DiffTree nodes={diff!.changes!} />
          )}
          {!loading && !hasChanges && hasFields && (
            diff!.fields!.map(f => (
              <div key={f.field} className="flex gap-2">
                <span className="text-zinc-500 w-24 shrink-0">{f.label}</span>
                <div className="flex gap-2 flex-1 min-w-0">
                  {f.currentValue !== null && f.currentValue !== undefined && (
                    <span className="text-red-400/70 line-through truncate">
                      {formatDiffValue(f.currentValue)}
                    </span>
                  )}
                  {f.pendingValue !== null && f.pendingValue !== undefined && (
                    <span className="text-emerald-400 truncate">
                      {formatDiffValue(f.pendingValue)}
                    </span>
                  )}
                  {f.truncated && (
                    <span className="text-zinc-600 text-[10px]">(truncated)</span>
                  )}
                </div>
              </div>
            ))
          )}
          {!loading && !hasChanges && !hasFields && (
            <div className="text-zinc-600">No field changes</div>
          )}
        </div>
      )}
    </div>
  );
}

/* ── MutationsList ───────────────────────────────────────────────── */

export function MutationsList({ changesetId }: { changesetId: string }) {
  const [mutations, setMutations] = useState<PendingMutation[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    apiFetch<PendingMutation[]>(`/api/pending-mutations/changeset/${changesetId}`)
      .then(data => { if (!cancelled) setMutations(data); })
      .catch(() => { if (!cancelled) setMutations([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [changesetId]);

  if (loading) {
    return <div className="text-[11px] text-zinc-600 animate-pulse">Loading pending changes…</div>;
  }

  if (mutations.length === 0) {
    return <div className="text-[11px] text-zinc-600">No pending changes recorded.</div>;
  }

  return (
    <div className="space-y-0">
      {mutations.map(m => <MutationRow key={m.id} mutation={m} changesetId={changesetId} />)}
    </div>
  );
}
