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
    from { height: 12px; opacity: 0.7; }
    to { height: 20px; opacity: 0.25; }
  }
  @keyframes exhaust-pulse-sm {
    from { height: 5px; opacity: 0.6; }
    to { height: 9px; opacity: 0.2; }
  }
`;

function ExhaustTrail({ size }: { size: 'sm' | 'lg' }) {
  const isLg = size === 'lg';
  return (
    <span
      className="absolute left-1/2 rounded-sm"
      style={{
        bottom: isLg ? '-4px' : '-2px',
        width: isLg ? '4px' : '2px',
        height: isLg ? '12px' : '5px',
        transform: 'translateX(-50%)',
        background: 'linear-gradient(to bottom, #8b5cf6, #6d28d9 50%, transparent)',
        animation: `${isLg ? 'exhaust-pulse' : 'exhaust-pulse-sm'} 0.6s ease-in-out infinite alternate`,
        opacity: 0.8,
      }}
    />
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
          <ExhaustTrail size="sm" />
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
        <ExhaustTrail size="lg" />
      </div>
      {message && <p className="text-sm text-zinc-400">{message}</p>}
    </div>
  );
}
