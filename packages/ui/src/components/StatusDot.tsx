interface StatusDotProps {
  status: string;
  className?: string;
}

const statusColors: Record<string, string> = {
  running: 'bg-emerald-500 shadow-emerald-500/50',
  stopped: 'bg-red-500 shadow-red-500/50',
  starting: 'bg-amber-500 shadow-amber-500/50',
};

export default function StatusDot({ status, className = '' }: StatusDotProps) {
  const color = statusColors[status] || 'bg-zinc-500 shadow-gray-500/50';
  return (
    <span
      className={`inline-block w-2.5 h-2.5 rounded-full shadow-lg ${color} ${className}`}
      title={status}
    />
  );
}
