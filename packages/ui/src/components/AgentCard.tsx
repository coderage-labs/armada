import StatusDot from './StatusDot';
import { Button } from './ui/button';
import { Badge } from './ui/badge';

interface AgentCardProps {
  agent: {
    id: string;
    name: string;
    role?: string;
    status: string;
    model?: string;
    uptime?: number;
    cpu?: number;
    memory?: number;
  };
}

function ProgressBar({ value, color }: { value: number; color: string }) {
  return (
    <div className="w-full bg-zinc-700/50 rounded-full h-1.5">
      <div
        className={`h-1.5 rounded-full ${color}`}
        style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
      />
    </div>
  );
}

export default function AgentCard({ agent }: AgentCardProps) {
  const roleBadgeColor =
    agent.role === 'lead'
      ? 'bg-violet-500/20 text-violet-300'
      : agent.role === 'research'
        ? 'bg-blue-500/20 text-blue-300'
        : agent.role === 'development'
          ? 'bg-emerald-500/20 text-emerald-300'
          : 'bg-zinc-500/20 text-zinc-300';

  return (
    <div className="bg-zinc-800/50 rounded-lg border border-zinc-700 p-5 flex flex-col gap-4 hover:border-zinc-600 transition-colors">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <StatusDot status={agent.status} />
          <h3 className="text-zinc-100 font-bold text-lg">{agent.name}</h3>
        </div>
        {agent.role && (
          <Badge className={`text-xs font-medium px-2.5 py-1 rounded-full ${roleBadgeColor}`}>
            {agent.role}
          </Badge>
        )}
      </div>

      {/* Info */}
      <div className="space-y-1.5 text-sm">
        {agent.model && (
          <div className="flex justify-between">
            <span className="text-zinc-400">Model</span>
            <span className="text-zinc-300 font-mono text-xs">{agent.model}</span>
          </div>
        )}
      </div>

      {/* Resource bars */}
      <div className="space-y-2.5">
        <div>
          <div className="flex justify-between text-xs text-zinc-400 mb-1">
            <span>CPU</span>
            <span>{agent.cpu ?? 0}%</span>
          </div>
          <ProgressBar value={agent.cpu ?? 0} color="bg-violet-500" />
        </div>
        <div>
          <div className="flex justify-between text-xs text-zinc-400 mb-1">
            <span>Memory</span>
            <span>{agent.memory ?? 0}%</span>
          </div>
          <ProgressBar value={agent.memory ?? 0} color="bg-purple-500" />
        </div>
      </div>

      {/* Actions */}
      <div className="flex gap-2 pt-1">
        <Button variant="ghost" size="sm" className="flex-1">
          Logs
        </Button>
      </div>
    </div>
  );
}
