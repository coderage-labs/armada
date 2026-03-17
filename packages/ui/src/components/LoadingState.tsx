import { Rocket } from 'lucide-react';

interface LoadingStateProps {
  size?: 'sm' | 'lg';
  message?: string;
  inline?: boolean;
}

const sharedStyles = `
  @keyframes rocket-float {
    0%, 100% { transform: translateY(0); }
    50% { transform: translateY(-8px); }
  }
  @keyframes rocket-float-sm {
    0%, 100% { transform: translateY(0); }
    50% { transform: translateY(-3px); }
  }
  @keyframes rocket-float-inline {
    0%, 100% { transform: translateY(0); }
    50% { transform: translateY(-2px); }
  }
  @keyframes exhaust-pulse {
    from { height: 14px; opacity: 0.7; }
    to { height: 22px; opacity: 0.3; }
  }
  @keyframes exhaust-pulse-sm {
    from { height: 6px; opacity: 0.6; }
    to { height: 10px; opacity: 0.2; }
  }
`;

function ExhaustTrails({ size }: { size: 'sm' | 'lg' }) {
  const isLg = size === 'lg';
  const w = isLg ? '3px' : '2px';
  const anim = isLg ? 'exhaust-pulse' : 'exhaust-pulse-sm';
  const bottom = isLg ? '-6px' : '-3px';
  const dur = '0.6s';

  return (
    <>
      <span
        className="absolute rounded-sm opacity-80"
        style={{
          bottom,
          left: '50%',
          width: w,
          height: isLg ? '14px' : '6px',
          transform: 'translateX(-50%)',
          transformOrigin: 'top center',
          background: 'linear-gradient(to bottom, #8b5cf6, #6d28d9 40%, transparent)',
          animation: `${anim} ${dur} ease-in-out infinite alternate`,
        }}
      />
      <span
        className="absolute rounded-sm opacity-50"
        style={{
          bottom,
          left: 'calc(50% - 5px)',
          width: w,
          height: isLg ? '10px' : '5px',
          transformOrigin: 'top center',
          background: 'linear-gradient(to bottom, #8b5cf6, #6d28d9 40%, transparent)',
          animation: `${anim} ${dur} ease-in-out infinite alternate`,
          animationDelay: '0.15s',
        }}
      />
      <span
        className="absolute rounded-sm opacity-40"
        style={{
          bottom,
          left: 'calc(50% + 5px)',
          width: w,
          height: isLg ? '8px' : '4px',
          transformOrigin: 'top center',
          background: 'linear-gradient(to bottom, #8b5cf6, #6d28d9 40%, transparent)',
          animation: `${anim} ${dur} ease-in-out infinite alternate`,
          animationDelay: '0.3s',
        }}
      />
    </>
  );
}

export function LoadingState({ size = 'lg', message, inline = false }: LoadingStateProps) {
  if (inline) {
    return (
      <span className="inline-flex items-center gap-1.5">
        <style>{sharedStyles}</style>
        <Rocket
          className="w-3.5 h-3.5 text-violet-400"
          style={{ animation: 'rocket-float-inline 1.4s ease-in-out infinite' }}
        />
        {message && <span className="text-zinc-400 text-sm">{message}</span>}
      </span>
    );
  }

  if (size === 'sm') {
    return (
      <div className="flex items-center gap-2">
        <style>{sharedStyles}</style>
        <div className="relative" style={{ width: 24, height: 24 }}>
          <Rocket
            className="w-4 h-4 text-violet-400 -rotate-45"
            style={{
              animation: 'rocket-float-sm 1.4s ease-in-out infinite',
              filter: 'drop-shadow(0 0 6px rgba(139,92,246,.4))',
            }}
          />
          <ExhaustTrails size="sm" />
        </div>
        {message && <span className="text-zinc-400 text-sm">{message}</span>}
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center gap-4 py-12">
      <style>{sharedStyles}</style>
      <div className="relative" style={{ width: 48, height: 48 }}>
        <Rocket
          className="w-8 h-8 text-violet-400 -rotate-45"
          style={{
            animation: 'rocket-float 1.6s ease-in-out infinite',
            filter: 'drop-shadow(0 0 12px rgba(139,92,246,.5))',
          }}
        />
        <ExhaustTrails size="lg" />
      </div>
      {message && <p className="text-sm text-zinc-400">{message}</p>}
    </div>
  );
}
