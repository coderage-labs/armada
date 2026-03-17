import { Rocket } from 'lucide-react';

interface LoadingStateProps {
  size?: 'sm' | 'lg';
  message?: string;
  inline?: boolean;
}

export function LoadingState({ size = 'lg', message, inline = false }: LoadingStateProps) {
  if (inline) {
    return (
      <span className="inline-flex items-center gap-1.5">
        <style>{`
          @keyframes rocket-float-inline {
            0%, 100% { transform: translateY(0px); }
            50% { transform: translateY(-2px); }
          }
          .rocket-float-inline {
            animation: rocket-float-inline 1.4s ease-in-out infinite;
          }
        `}</style>
        <Rocket className="rocket-float-inline w-3.5 h-3.5 text-violet-400" />
        {message && <span className="text-zinc-400 text-sm">{message}</span>}
      </span>
    );
  }

  if (size === 'sm') {
    return (
      <div className="flex items-center gap-2">
        <style>{`
          @keyframes rocket-float-sm {
            0%, 100% { transform: translateY(0px) rotate(-45deg); }
            50% { transform: translateY(-3px) rotate(-45deg); }
          }
          .rocket-float-sm {
            animation: rocket-float-sm 1.4s ease-in-out infinite;
          }
          @keyframes trail-fade-sm {
            0%, 100% { opacity: 0.3; }
            50% { opacity: 0.7; }
          }
          .rocket-trail-sm {
            animation: trail-fade-sm 1.4s ease-in-out infinite;
          }
        `}</style>
        <div className="relative">
          <Rocket className="rocket-float-sm w-4 h-4 text-violet-400" />
          <span className="rocket-trail-sm absolute -bottom-1 -right-1 w-1 h-1 bg-violet-400/50 rounded-full blur-sm" />
        </div>
        {message && <span className="text-zinc-400 text-sm">{message}</span>}
      </div>
    );
  }

  // Large (default) — centered in container
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-12">
      <style>{`
        @keyframes rocket-float-lg {
          0%, 100% { transform: translateY(0px) rotate(-45deg); }
          50% { transform: translateY(-8px) rotate(-45deg); }
        }
        .rocket-float-lg {
          animation: rocket-float-lg 1.6s ease-in-out infinite;
        }
        @keyframes trail-pulse {
          0%, 100% { opacity: 0.2; transform: scale(0.8); }
          50% { opacity: 0.5; transform: scale(1.2); }
        }
        .rocket-trail-lg {
          animation: trail-pulse 1.6s ease-in-out infinite;
        }
      `}</style>
      <div className="relative">
        <Rocket className="rocket-float-lg w-8 h-8 text-violet-400" />
        <span className="rocket-trail-lg absolute -bottom-2 left-1/2 -translate-x-1/2 w-3 h-3 bg-violet-500/40 rounded-full blur-md" />
      </div>
      {message && <p className="text-sm text-zinc-400">{message}</p>}
    </div>
  );
}
