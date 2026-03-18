/**
 * ImpactBadge — displays the impact level of a changeset (#83)
 *
 * Colour key:
 *   none   → green  (auto-applied, no disruption)
 *   low    → blue   (minor, no restarts)
 *   medium → amber  (config push needed)
 *   high   → red    (restarts required)
 */

import type { ComponentType } from 'react';
import type { ImpactLevel, AffectedResource } from '@coderage-labs/armada-shared';
import { AlertTriangle, CheckCircle, Info, Zap, RefreshCw } from 'lucide-react';

// ── Colour maps ──────────────────────────────────────────────────────

const IMPACT_STYLES: Record<ImpactLevel, { badge: string; dot: string; icon: ComponentType<{ className?: string; title?: string }>; label: string }> = {
  none: {
    badge: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
    dot: 'bg-emerald-500',
    icon: CheckCircle,
    label: 'Zero impact',
  },
  low: {
    badge: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
    dot: 'bg-blue-500',
    icon: Info,
    label: 'Low impact',
  },
  medium: {
    badge: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
    dot: 'bg-amber-500',
    icon: Zap,
    label: 'Medium impact',
  },
  high: {
    badge: 'bg-red-500/15 text-red-400 border-red-500/30',
    dot: 'bg-red-500',
    icon: AlertTriangle,
    label: 'High impact',
  },
};

// ── ImpactBadge ──────────────────────────────────────────────────────

interface ImpactBadgeProps {
  impactLevel: ImpactLevel;
  requiresRestart?: boolean;
  compact?: boolean;
}

export function ImpactBadge({ impactLevel, requiresRestart, compact = false }: ImpactBadgeProps) {
  const style = IMPACT_STYLES[impactLevel] ?? IMPACT_STYLES.low;
  const Icon = style.icon;

  if (compact) {
    return (
      <span
        className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${style.badge}`}
        title={style.label}
      >
        <span className={`w-1.5 h-1.5 rounded-full ${style.dot}`} />
        {style.label}
        {requiresRestart && (
          <RefreshCw className="w-2.5 h-2.5 ml-0.5" aria-label="Requires restart" />
        )}
      </span>
    );
  }

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium ${style.badge}`}
    >
      <Icon className="w-3 h-3" />
      {style.label}
      {requiresRestart && (
        <span className="flex items-center gap-0.5 ml-0.5 opacity-80">
          <RefreshCw className="w-2.5 h-2.5" />
          <span className="text-[10px]">restart</span>
        </span>
      )}
    </span>
  );
}

// ── AffectedResourcesList ────────────────────────────────────────────

interface AffectedResourcesListProps {
  resources: AffectedResource[];
  requiresRestart?: boolean;
}

const RESOURCE_TYPE_ICONS: Record<string, string> = {
  agent: '🤖',
  template: '📋',
  model: '🧠',
  instance: '🖥️',
  provider: '🔌',
  api_key: '🔑',
  plugin: '🧩',
};

export function AffectedResourcesList({ resources, requiresRestart }: AffectedResourcesListProps) {
  if (!resources || resources.length === 0) return null;

  // Group by type
  const grouped = resources.reduce<Record<string, AffectedResource[]>>((acc, r) => {
    const list = acc[r.type] ?? [];
    list.push(r);
    acc[r.type] = list;
    return acc;
  }, {});

  const restartingAgents = resources.filter(r => r.type === 'agent');

  return (
    <div className="space-y-2">
      {/* Restart warning */}
      {requiresRestart && restartingAgents.length > 0 && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2">
          <RefreshCw className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />
          <p className="text-xs text-amber-400">
            This change will restart{' '}
            <strong>{restartingAgents.length} agent{restartingAgents.length !== 1 ? 's' : ''}</strong>
            {': '}
            {restartingAgents.slice(0, 3).map(a => a.name).join(', ')}
            {restartingAgents.length > 3 ? ` and ${restartingAgents.length - 3} more` : ''}
          </p>
        </div>
      )}

      {/* Resource groups */}
      <div className="space-y-1.5">
        {Object.entries(grouped).map(([type, items]) => (
          <div key={type} className="space-y-0.5">
            <div className="text-[10px] text-zinc-500 uppercase tracking-wider flex items-center gap-1">
              <span>{RESOURCE_TYPE_ICONS[type] ?? '📦'}</span>
              <span>{type.replace('_', ' ')}s</span>
              <span className="text-zinc-600">({items.length})</span>
            </div>
            {items.map((r, i) => (
              <div key={i} className="flex items-start gap-2 text-xs text-zinc-400 pl-2">
                <span className="text-zinc-500 shrink-0">·</span>
                <span>
                  <span className="text-zinc-300 font-medium">{r.name}</span>
                  {' — '}
                  <span className="text-zinc-500">{r.reason}</span>
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
