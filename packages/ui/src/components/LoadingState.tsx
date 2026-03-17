import { Rocket } from 'lucide-react';

interface LoadingStateProps {
  size?: 'sm' | 'lg';
  message?: string;
  inline?: boolean;
}

/* Matches the splash screen animation exactly */
const styles = `
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
  @keyframes exhaust {
    from { height: 14px; opacity: 0.7; }
    to { height: 22px; opacity: 0.3; }
  }
  @keyframes exhaust-sm {
    from { height: 5px; opacity: 0.6; }
    to { height: 9px; opacity: 0.2; }
  }
`;

/*
 * Mirrors the splash HTML structure exactly:
 *   <div class="rocket-wrap">        ← handles float animation
 *     <span class="rocket">          ← holds SVG + glow
 *       <svg transform=rotate(-45)>  ← rotation on the SVG only
 *     </span>
 *     <div class="exhaust">          ← centered under wrapper, straight down
 *   </div>
 */

export function LoadingState({ size = 'lg', message, inline = false }: LoadingStateProps) {
  if (inline) {
    return (
      <span className="inline-flex items-center gap-1.5">
        <style>{styles}</style>
        <span style={{ animation: 'rocket-float-inline 1.4s ease-in-out infinite' }}>
          <Rocket className="w-3.5 h-3.5 text-violet-400 -rotate-45" />
        </span>
        {message && <span className="text-zinc-400 text-sm">{message}</span>}
      </span>
    );
  }

  const isLg = size === 'lg';
  const wrapSize = isLg ? 48 : 24;
  const iconClass = isLg ? 'w-8 h-8' : 'w-4 h-4';
  const floatAnim = isLg ? 'rocket-float 2s ease-in-out infinite' : 'rocket-float-sm 1.4s ease-in-out infinite';
  const exhaustAnim = isLg ? 'exhaust 0.6s ease-in-out infinite alternate' : 'exhaust-sm 0.6s ease-in-out infinite alternate';
  const exhaustW = isLg ? 4 : 2;
  const exhaustH = isLg ? 12 : 5;

  const rocketWrap = (
    <div className="relative" style={{ width: wrapSize, height: wrapSize, animation: floatAnim }}>
      {/* Rocket icon — rotation on the SVG, glow via filter */}
      <span
        className="flex items-center justify-center"
        style={{ filter: `drop-shadow(0 0 ${isLg ? 12 : 6}px rgba(139,92,246,.5))`, color: '#a78bfa' }}
      >
        <Rocket className={`${iconClass} -rotate-45`} />
      </span>
      {/* Exhaust — centered under the wrapper, straight down */}
      <div
        className="absolute rounded-sm"
        style={{
          bottom: -4,
          left: '50%',
          width: exhaustW,
          height: exhaustH,
          transform: 'translateX(-50%)',
          transformOrigin: 'top center',
          background: 'linear-gradient(to bottom, #8b5cf6, #6d28d9 50%, transparent)',
          animation: exhaustAnim,
          opacity: 0.8,
        }}
      />
    </div>
  );

  if (size === 'sm') {
    return (
      <div className="flex items-center gap-2">
        <style>{styles}</style>
        {rocketWrap}
        {message && <span className="text-zinc-400 text-sm">{message}</span>}
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center gap-4 py-12">
      <style>{styles}</style>
      {rocketWrap}
      {message && <p className="text-sm text-zinc-400">{message}</p>}
    </div>
  );
}
