import type { ComponentType } from 'react';

interface PageHeaderProps {
  icon: ComponentType<{ className?: string }>;
  title: string;
  subtitle?: string;
  /** Icon badge color — defaults to violet */
  color?: 'violet' | 'emerald' | 'amber' | 'red' | 'blue' | 'purple';
  children?: React.ReactNode;
}

const colorMap = {
  violet: 'bg-violet-500/20 text-violet-400',
  emerald: 'bg-emerald-500/20 text-emerald-400',
  amber: 'bg-amber-500/20 text-amber-400',
  red: 'bg-red-500/20 text-red-400',
  blue: 'bg-blue-500/20 text-blue-400',
  purple: 'bg-purple-500/20 text-purple-400',
};

export function PageHeader({ icon: Icon, title, subtitle, color = 'violet', children }: PageHeaderProps) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      {/* Icon + title: hidden on mobile (top bar shows these) */}
      <div className="hidden md:flex items-center gap-3">
        <span className={`flex items-center justify-center w-9 h-9 rounded-xl shrink-0 ${colorMap[color]}`}>
          <Icon className="w-5 h-5" />
        </span>
        <div>
          <h1 className="text-2xl font-bold text-zinc-100">{title}</h1>
          {subtitle && <p className="text-sm text-zinc-500 mt-0.5">{subtitle}</p>}
        </div>
      </div>
      {/* Subtitle only on mobile */}
      {subtitle && <p className="text-sm text-zinc-500 md:hidden">{subtitle}</p>}
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}
