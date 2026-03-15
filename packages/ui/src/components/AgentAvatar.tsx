import { useState } from 'react';

interface AgentAvatarProps {
  name: string;
  size?: 'xs' | 'sm' | 'md' | 'lg';
  healthStatus?: string;
  /** Cache-bust key — change to force reload (e.g. timestamp or counter) */
  version?: number | string;
  /** Show spinner overlay when generating */
  generating?: boolean;
}

const SIZE_MAP = {
  xs: 20,
  sm: 32,
  md: 48,
  lg: 96,
} as const;

const HEALTH_GLOW: Record<string, string> = {
  healthy: 'ring-emerald-500/40 shadow-emerald-500/20',
  degraded: 'ring-yellow-500/40 shadow-yellow-500/20',
  unresponsive: 'ring-red-500/40 shadow-red-500/20',
  offline: 'ring-gray-500/30 shadow-gray-500/10',
  unknown: 'ring-gray-500/30 shadow-gray-500/10',
};

const FALLBACK_COLORS = [
  'bg-violet-600', 'bg-blue-600', 'bg-emerald-600', 'bg-orange-600',
  'bg-pink-600', 'bg-teal-600', 'bg-indigo-600', 'bg-cyan-600',
];

function nameToColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return FALLBACK_COLORS[Math.abs(hash) % FALLBACK_COLORS.length];
}

export default function AgentAvatar({ name, size = 'md', healthStatus, version, generating }: AgentAvatarProps) {
  const [imgError, setImgError] = useState(false);
  const px = SIZE_MAP[size];
  const glowClass = HEALTH_GLOW[healthStatus ?? 'unknown'] ?? HEALTH_GLOW.unknown;
  const isHealthy = healthStatus === 'healthy';

  const containerStyle = { width: px, height: px };

  const ringClass = `ring-2 ${glowClass} shadow-lg`;
  const pulseClass = isHealthy ? 'animate-[avatarPulse_3s_ease-in-out_infinite]' : '';

  const spinnerSize = size === 'lg' ? 'w-8 h-8' : size === 'md' ? 'w-5 h-5' : 'w-3 h-3';

  const spinnerOverlay = generating ? (
    <div className="absolute inset-0 rounded-full bg-black/50 flex items-center justify-center">
      <svg className={`${spinnerSize} animate-spin text-teal-400`} viewBox="0 0 24 24" fill="none">
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
      </svg>
    </div>
  ) : null;

  if (imgError) {
    const bgColor = nameToColor(name);
    const fontSize = size === 'lg' ? 'text-3xl' : size === 'md' ? 'text-lg' : size === 'sm' ? 'text-sm' : 'text-[10px]';
    return (
      <div className="relative shrink-0" style={containerStyle}>
        <div
          className={`rounded-full ${bgColor} ${ringClass} ${pulseClass} flex items-center justify-center w-full h-full`}
        >
          <span className={`font-bold text-white/90 ${fontSize} select-none`}>
            {name.charAt(0).toUpperCase()}
          </span>
        </div>
        {spinnerOverlay}
      </div>
    );
  }

  return (
    <div className="relative shrink-0" style={containerStyle}>
      <img
        src={`/api/agents/${name}/avatar?size=${size === 'xs' ? 'sm' : size === 'lg' ? 'md' : size}${version != null ? `&v=${version}` : ''}`}
        alt={`${name} avatar`}
        className={`rounded-full ${ringClass} ${pulseClass} object-cover w-full h-full bg-[#0a0f1e]`}
        onError={() => setImgError(true)}
      />
      {spinnerOverlay}
    </div>
  );
}
