import { useState, useMemo, type ReactNode } from 'react';
import { useActivity } from '../hooks/queries/useActivity';
import AgentAvatar from '../components/AgentAvatar';
import {
  Rocket, Bomb, RefreshCw, RotateCw, Square, Play, Zap,
  CheckCircle2, XCircle, GitBranch, Radio, FileCode, Pencil, Trash2, Pin, Activity as ActivityIcon,
} from 'lucide-react';
import { PageHeader } from '../components/PageHeader';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select';
import { RowSkeleton } from '../components/ui/skeleton';
import { EmptyState } from '../components/EmptyState';
import { Table, TableHeader, TableBody, TableHead, TableRow, TableCell } from '../components/ui/table';

/* ── Types ─────────────────────────────────────────── */

interface ActivityEvent {
  id: string;
  eventType: string;
  agentName: string | null;
  detail: string | null;
  metadata: string | null;
  createdAt: string;
}

/* ── Event type config ─────────────────────────────── */

const ic = "w-4 h-4";
const EVENT_CONFIG: Record<string, { icon: ReactNode; color: string; label: string }> = {
  'agent.spawn':     { icon: <Rocket className={ic} />, color: 'text-emerald-400', label: 'Spawned' },
  'agent.destroy':   { icon: <Bomb className={ic} />, color: 'text-red-400',     label: 'Destroyed' },
  'agent.redeploy':  { icon: <RefreshCw className={ic} />, color: 'text-blue-400',    label: 'Redeployed' },
  'agent.restart':   { icon: <RotateCw className={ic} />, color: 'text-amber-400',   label: 'Restarted' },
  'agent.stop':      { icon: <Square className={ic} />, color: 'text-zinc-400',    label: 'Stopped' },
  'agent.start':     { icon: <Play className={ic} />, color: 'text-green-400',   label: 'Started' },
  'task.created':    { icon: <Zap className={ic} />, color: 'text-violet-400',   label: 'Task Created' },
  'task.completed':  { icon: <CheckCircle2 className={ic} />, color: 'text-emerald-400', label: 'Task Completed' },
  'task.failed':     { icon: <XCircle className={ic} />, color: 'text-red-400',     label: 'Task Failed' },
  'hierarchy.updated': { icon: <GitBranch className={ic} />, color: 'text-blue-300',  label: 'Hierarchy Updated' },
  'contacts.synced': { icon: <Radio className={ic} />, color: 'text-cyan-400',    label: 'Contacts Synced' },
  'template.created':  { icon: <FileCode className={ic} />, color: 'text-emerald-300', label: 'Template Created' },
  'template.updated':  { icon: <Pencil className={ic} />, color: 'text-amber-300',  label: 'Template Updated' },
  'template.deleted':  { icon: <Trash2 className={ic} />, color: 'text-red-300',   label: 'Template Deleted' },
};

const DEFAULT_EVENT = { icon: <Pin className="w-4 h-4" />, color: 'text-zinc-400', label: 'Event' };

function getEventConfig(eventType: string) {
  return EVENT_CONFIG[eventType] ?? DEFAULT_EVENT;
}

/* ── Event categories for filtering ──────────────── */

const EVENT_CATEGORIES = [
  { key: 'all', label: 'All Events' },
  { key: 'agent', label: 'Agents' },
  { key: 'task', label: 'Tasks' },
  { key: 'template', label: 'Templates' },
  { key: 'hierarchy', label: 'Hierarchy' },
  { key: 'contacts', label: 'Contacts' },
];

/* ── Relative time ─────────────────────────────────── */

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 5) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/* ── Activity Row ──────────────────────────────────── */

function ActivityRow({ event }: { event: ActivityEvent }) {
  const config = getEventConfig(event.eventType);

  return (
    <TableRow className="border-b border-zinc-800/50 hover:bg-zinc-800/40 transition-colors cursor-pointer">
      {/* Event type */}
      <TableCell>
        <div className={`flex items-center gap-2 ${config.color}`}>
          <span className="shrink-0">{config.icon}</span>
          <span className="text-sm font-medium">{config.label}</span>
        </div>
      </TableCell>

      {/* Agent */}
      <TableCell>
        {event.agentName ? (
          <Badge className="bg-violet-500/15 text-violet-300 border-violet-500/20 gap-1.5">
            <AgentAvatar name={event.agentName} size="xs" />
            {event.agentName}
          </Badge>
        ) : (
          <span className="text-xs text-zinc-600">—</span>
        )}
      </TableCell>

      {/* Detail */}
      <TableCell className="max-w-xs">
        {event.detail ? (
          <span className="text-sm text-zinc-400 break-words line-clamp-2">{event.detail}</span>
        ) : (
          <span className="text-xs text-zinc-600">—</span>
        )}
      </TableCell>

      {/* Timestamp */}
      <TableCell className="text-right">
        <span className="text-[11px] text-zinc-600 font-mono whitespace-nowrap">{relativeTime(event.createdAt)}</span>
      </TableCell>
    </TableRow>
  );
}

/* ── Main Page ─────────────────────────────────────── */

export default function Activity() {
  const { data: events = [], isLoading: loading } = useActivity();
  const [category, setCategory] = useState('all');
  const [agentFilter, setAgentFilter] = useState('');

  const agentNames = useMemo(
    () => [...new Set((events as ActivityEvent[]).filter(e => e.agentName).map(e => e.agentName!))].sort(),
    [events],
  );

  // Filtered events
  const filtered = useMemo(() => {
    return events.filter(e => {
      if (category !== 'all' && !e.eventType.startsWith(category)) return false;
      if (agentFilter && agentFilter !== '__all__' && e.agentName !== agentFilter) return false;
      return true;
    });
  }, [events, category, agentFilter]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <PageHeader icon={ActivityIcon} title="Activity Feed" subtitle="System-wide event log & audit trail" />

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center">
        {/* Category tabs */}
        <div className="flex flex-wrap gap-1.5">
          {EVENT_CATEGORIES.map(cat => (
            <Button
              variant="ghost"
              key={cat.key}
              onClick={() => setCategory(cat.key)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                category === cat.key
                  ? 'bg-violet-500/20 text-violet-300 border border-violet-500/30'
                  : 'bg-zinc-800/50 text-zinc-400 border border-zinc-800 hover:bg-zinc-700/50 hover:text-zinc-200'
              }`}
            >
              {cat.label}
            </Button>
          ))}
        </div>

        {/* Agent dropdown */}
        <div className="sm:ml-auto">
          <Select value={agentFilter || '__all__'} onValueChange={v => setAgentFilter(v === '__all__' ? '' : v)}>
            <SelectTrigger className="w-48 rounded-lg border border-zinc-800 bg-zinc-900/50 text-zinc-300 text-xs h-8 focus:border-violet-500 focus:outline-none transition-colors">
              <SelectValue placeholder="All agents" />
            </SelectTrigger>
            <SelectContent className="bg-zinc-900">
              <SelectItem value="__all__">All agents</SelectItem>
              {agentNames.map(name => (
                <SelectItem key={name} value={name}>{name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Table */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-0">
        <Table>
          <TableHeader>
            <TableRow className="border-b border-zinc-800">
              <TableHead className="text-left text-[11px] text-zinc-500 uppercase tracking-wider">Event</TableHead>
              <TableHead className="text-left text-[11px] text-zinc-500 uppercase tracking-wider">Agent</TableHead>
              <TableHead className="text-left text-[11px] text-zinc-500 uppercase tracking-wider">Detail</TableHead>
              <TableHead className="text-right text-[11px] text-zinc-500 uppercase tracking-wider">Time</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <>
                <RowSkeleton cols={4} />
                <RowSkeleton cols={4} />
                <RowSkeleton cols={4} />
                <RowSkeleton cols={4} />
                <RowSkeleton cols={4} />
              </>
            ) : filtered.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4}>
                  <EmptyState
                    icon={ActivityIcon}
                    title="No activity events found"
                    description="Events will appear here as fleet operations occur"
                  />
                </TableCell>
              </TableRow>
            ) : (
              filtered.map(event => (
                <ActivityRow key={event.id} event={event} />
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Spacer for fixed live indicator */}
      <div className="h-12" />

      {/* Live indicator */}
      <div className="fixed bottom-6 right-6 z-30">
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-zinc-900/80 backdrop-blur border border-zinc-700 text-xs text-zinc-400">
          <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
          Live
        </div>
      </div>
    </div>
  );
}
