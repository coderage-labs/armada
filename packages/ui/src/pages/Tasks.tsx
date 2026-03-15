import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { useSSEAll } from '../providers/SSEProvider';
import { apiFetch } from '../hooks/useApi';
import AgentAvatar from '../components/AgentAvatar';
import { useRoles } from '../hooks/useRoles';
import {
  X, CheckCircle2, XCircle, RefreshCw, Hourglass, Ban, HelpCircle, Rocket, Radio, Zap,
  ChevronDown, ChevronRight, Bot, User, Terminal,
  GitBranch, Eye, Search, TestTube, FileText,
} from 'lucide-react';
import { PageHeader } from '../components/PageHeader';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Input } from '../components/ui/input';
import { Textarea } from '../components/ui/textarea';
import { RowSkeleton } from '../components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Table, TableHeader, TableBody, TableHead, TableRow, TableCell } from '../components/ui/table';
import { EmptyState } from '../components/EmptyState';

/* ── Types ─────────────────────────────────────────── */

type TaskType = 'code_change' | 'review' | 'research' | 'deployment' | 'test' | 'generic';

interface ArmadaTask {
  id: string;
  fromAgent: string;
  toAgent: string;
  taskText: string;
  result: string | null;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'blocked';
  createdAt: string;
  completedAt: string | null;
  blockedReason?: string;
  blockedAt?: string;
  projectId?: string;
  workflowRunId?: string;
  taskType?: TaskType;
}

interface ArmadaAgent {
  id: string;
  name: string;
  role: string;
  status: 'running' | 'stopped' | 'starting' | 'error';
}

/* ── Status colours ────────────────────────────────── */

const STATUS_BADGE: Record<string, string> = {
  pending:   'bg-amber-500/20 text-amber-300 border-amber-500/30',
  running:   'bg-blue-500/20 text-blue-300 border-blue-500/30',
  completed: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
  failed:    'bg-red-500/20 text-red-300 border-red-500/30',
  blocked:   'bg-orange-500/20 text-orange-300 border-orange-500/30',
};

/* ── Task type helpers ─────────────────────────────── */

const TASK_TYPE_CONFIG: Record<TaskType, { icon: React.ComponentType<{ className?: string }>; label: string; color: string }> = {
  code_change: { icon: GitBranch, label: 'Code',     color: 'bg-blue-500/20 border-blue-500/30 text-blue-300' },
  review:      { icon: Eye,       label: 'Review',   color: 'bg-purple-500/20 border-purple-500/30 text-purple-300' },
  research:    { icon: Search,    label: 'Research', color: 'bg-cyan-500/20 border-cyan-500/30 text-cyan-300' },
  deployment:  { icon: Rocket,    label: 'Deploy',   color: 'bg-orange-500/20 border-orange-500/30 text-orange-300' },
  test:        { icon: TestTube,  label: 'Test',     color: 'bg-green-500/20 border-green-500/30 text-green-300' },
  generic:     { icon: FileText,  label: 'Generic',  color: 'bg-zinc-500/20 border-zinc-500/30 text-zinc-400' },
};

function TaskTypeBadge({ taskType }: { taskType?: TaskType }) {
  const type = taskType ?? 'generic';
  const cfg = TASK_TYPE_CONFIG[type] ?? TASK_TYPE_CONFIG.generic;
  const Icon = cfg.icon;
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full border font-medium ${cfg.color}`}>
      <Icon className="w-3 h-3" />
      {cfg.label}
    </span>
  );
}

/* ── Helpers ───────────────────────────────────────── */

function truncate(s: string, max: number) {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function msBetween(start: string, end: string | null): number | null {
  if (!end) return null;
  return new Date(end).getTime() - new Date(start).getTime();
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
  return `${Math.floor(ms / 3_600_000)}h ${Math.floor((ms % 3_600_000) / 60_000)}m`;
}

/* ── Topology Graph (SVG) ──────────────────────────── */

interface NodePosition {
  x: number;
  y: number;
  agent: ArmadaAgent;
}

function computeLayout(agents: ArmadaAgent[], width: number, height: number, getTier: (role?: string) => number): NodePosition[] {
  // Group by tier
  const tiers: Map<number, ArmadaAgent[]> = new Map();
  for (const agent of agents) {
    const tier = getTier(agent.role);
    if (!tiers.has(tier)) tiers.set(tier, []);
    tiers.get(tier)!.push(agent);
  }

  const tierKeys = Array.from(tiers.keys()).sort();
  const tierCount = tierKeys.length || 1;
  const positions: NodePosition[] = [];

  tierKeys.forEach((tier, tierIdx) => {
    const agentsInTier = tiers.get(tier)!;
    const y = 60 + ((height - 120) * tierIdx) / Math.max(tierCount - 1, 1);
    const padding = 80;
    const availWidth = width - padding * 2;

    agentsInTier.forEach((agent, idx) => {
      const x = agentsInTier.length === 1
        ? width / 2
        : padding + (availWidth * idx) / (agentsInTier.length - 1);
      positions.push({ x, y: tierCount === 1 ? height / 2 : y, agent });
    });
  });

  return positions;
}

interface TopologyProps {
  agents: ArmadaAgent[];
  tasks: ArmadaTask[];
  onTaskClick?: (task: ArmadaTask) => void;
  roleColor: (role?: string) => { bg: string; stroke: string; glow: string; text: string };
  getTier: (role?: string) => number;
}

function TopologyGraph({ agents, tasks, roleColor, getTier }: TopologyProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(800);
  const [avatarLoaded, setAvatarLoaded] = useState<Record<string, boolean>>({});

  // Preload avatar images to know which ones are available
  useEffect(() => {
    for (const agent of agents) {
      const img = new Image();
      img.onload = () => setAvatarLoaded(prev => ({ ...prev, [agent.name]: true }));
      img.onerror = () => setAvatarLoaded(prev => ({ ...prev, [agent.name]: false }));
      img.src = `/api/agents/${agent.name}/avatar?size=sm`;
    }
  }, [agents]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(entries => {
      const entry = entries[0];
      if (entry) {
        setContainerWidth(entry.contentRect.width);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Compute height based on number of tiers — enough to show all nodes + labels
  const tierCount = useMemo(() => {
    const tiers = new Set<number>();
    for (const a of agents) tiers.add(getTier(a.role));
    return Math.max(tiers.size, 1);
  }, [agents, getTier]);
  const svgHeight = Math.max(tierCount * 120 + 80, 200);

  const positions = useMemo(() => computeLayout(agents, containerWidth, svgHeight, getTier), [agents, containerWidth, svgHeight, getTier]);
  const posMap = useMemo(() => {
    const m: Record<string, NodePosition> = {};
    for (const p of positions) m[p.agent.name] = p;
    return m;
  }, [positions]);

  // Build hierarchy edges — always visible as dim connections
  const hierarchyEdges = useMemo(() => {
    const edges: { from: string; to: string }[] = [];
    const agentNames = new Set(agents.map(a => a.name));
    // Infer hierarchy from roles: higher tier → lower tier
    for (const a of agents) {
      for (const b of agents) {
        if (a.name === b.name) continue;
        const tierA = getTier(a.role);
        const tierB = getTier(b.role);
        // Connect adjacent tiers (parent → child)
        if (tierA < tierB && Math.abs(tierA - tierB) === 1) {
          edges.push({ from: a.name, to: b.name });
        }
      }
    }
    return edges;
  }, [agents, getTier]);

  // Compute active edges from tasks (running/pending/just-completed)
  const activeEdges = useMemo(() => {
    const tenSecsAgo = Date.now() - 10 * 1000;
    const edgeMap = new Map<string, { from: string; to: string; count: number }>();
    for (const t of tasks) {
      const isActive = t.status === 'pending' || t.status === 'running';
      const justFinished = (t.status === 'completed' || t.status === 'failed')
        && t.completedAt && new Date(t.completedAt).getTime() >= tenSecsAgo;
      if (!isActive && !justFinished) continue;
      const key = `${t.fromAgent}→${t.toAgent}`;
      const existing = edgeMap.get(key);
      if (existing) {
        existing.count++;
      } else {
        edgeMap.set(key, { from: t.fromAgent, to: t.toAgent, count: 1 });
      }
    }
    return edgeMap;
  }, [tasks]);

  // Active tasks per agent
  const activeTaskMap = useMemo(() => {
    const m: Record<string, { text: string; count: number }> = {};
    for (const t of tasks) {
      if (t.status === 'running' || t.status === 'pending') {
        const existing = m[t.toAgent];
        if (existing) {
          existing.count++;
        } else {
          m[t.toAgent] = { text: truncate(t.taskText, 30), count: 1 };
        }
      }
    }
    return m;
  }, [tasks]);

  const nodeRadius = containerWidth < 500 ? 22 : 28;
  const isCompact = containerWidth < 500;

  return (
    <div ref={containerRef} className="w-full relative">
      <svg width={containerWidth} height={svgHeight} className="block">
        <defs>
          {/* Grid pattern */}
          <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
            <path d="M 40 0 L 0 0 0 40" fill="none" stroke="rgba(255,255,255,0.03)" strokeWidth="1" />
          </pattern>

          {/* Glow filter */}
          <filter id="glow">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>

          {/* Active edge glow */}
          <filter id="edgeGlow">
            <feGaussianBlur stdDeviation="2" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>

          {/* Animated dash for active edges */}
          <style>{`
            @keyframes dashFlow {
              to { stroke-dashoffset: -20; }
            }
            @keyframes pulseNode {
              0%, 100% { opacity: 0.6; }
              50% { opacity: 1; }
            }
            @keyframes particleFlow {
              0% { offset-distance: 0%; opacity: 0; }
              10% { opacity: 1; }
              90% { opacity: 1; }
              100% { offset-distance: 100%; opacity: 0; }
            }
          `}</style>
        </defs>

        {/* Background grid */}
        <rect width="100%" height="100%" fill="url(#grid)" />

        {/* Hierarchy edges — always visible as dim connections */}
        {hierarchyEdges.map((edge) => {
          const from = posMap[edge.from];
          const to = posMap[edge.to];
          if (!from || !to) return null;
          const key = `${edge.from}→${edge.to}`;
          const reverseKey = `${edge.to}→${edge.from}`;
          const isActive = activeEdges.has(key) || activeEdges.has(reverseKey);

          return (
            <g key={key}>
              {/* Glow for active edges */}
              {isActive && (
                <line
                  x1={from.x} y1={from.y}
                  x2={to.x} y2={to.y}
                  stroke={roleColor(from.agent.role).glow}
                  strokeWidth="6"
                  strokeOpacity="0.3"
                  filter="url(#edgeGlow)"
                />
              )}
              {/* Main line — dim when idle, bright when active */}
              <line
                x1={from.x} y1={from.y}
                x2={to.x} y2={to.y}
                stroke={isActive ? roleColor(from.agent.role).stroke : 'rgba(255,255,255,0.08)'}
                strokeWidth={isActive ? 2 : 1}
                strokeDasharray={isActive ? '6 4' : undefined}
                style={isActive ? { animation: 'dashFlow 1s linear infinite' } : undefined}
              />
              {/* Particle dot on active edges */}
              {isActive && (
                <circle r="3" fill={roleColor(from.agent.role).stroke} opacity="0.8">
                  <animateMotion
                    dur="2s"
                    repeatCount="indefinite"
                    path={`M${from.x},${from.y} L${to.x},${to.y}`}
                  />
                </circle>
              )}
            </g>
          );
        })}

        {/* Agent nodes */}
        {positions.map((pos) => {
          const rc = roleColor(pos.agent.role);
          const running = pos.agent.status === 'running';
          const activeInfo = activeTaskMap[pos.agent.name];
          const activeCount = activeInfo?.count ?? 0;

          return (
            <g key={pos.agent.name} transform={`translate(${pos.x},${pos.y})`}>
              {/* Outer glow for running agents */}
              {running && (
                <circle
                  r={nodeRadius + 8}
                  fill="none"
                  stroke={rc.stroke}
                  strokeWidth="1"
                  opacity="0.3"
                  style={{ animation: 'pulseNode 2s ease-in-out infinite' }}
                />
              )}

              {/* Node: avatar fills the circle when available, otherwise show coloured bg + letter */}
              {avatarLoaded[pos.agent.name] ? (
                <>
                  <clipPath id={`clip-${pos.agent.name}`}>
                    <circle r={nodeRadius} />
                  </clipPath>
                  <image
                    href={`/api/agents/${pos.agent.name}/avatar?size=sm`}
                    x={-nodeRadius}
                    y={-nodeRadius}
                    width={nodeRadius * 2}
                    height={nodeRadius * 2}
                    clipPath={`url(#clip-${pos.agent.name})`}
                    preserveAspectRatio="xMidYMid slice"
                  />
                  {/* Subtle border ring */}
                  <circle
                    r={nodeRadius}
                    fill="none"
                    stroke={rc.stroke}
                    strokeWidth="1.5"
                    strokeOpacity="0.5"
                  />
                </>
              ) : (
                <>
                  <circle
                    r={nodeRadius}
                    fill={rc.bg}
                    fillOpacity="0.2"
                    stroke={rc.stroke}
                    strokeWidth="2"
                    filter="url(#glow)"
                  />
                  <text
                    textAnchor="middle"
                    dominantBaseline="central"
                    fill={rc.stroke}
                    fontSize={isCompact ? 13 : 16}
                    fontWeight="bold"
                    className="select-none"
                    style={{ pointerEvents: 'none' }}
                  >
                    {pos.agent.name.charAt(0).toUpperCase()}
                  </text>
                </>
              )}

              {/* Status dot */}
              <circle
                cx={nodeRadius - 4}
                cy={-nodeRadius + 4}
                r="5"
                fill={running ? '#34d399' : '#4b5563'}
                stroke="rgba(0,0,0,0.5)"
                strokeWidth="1.5"
              />
              {running && (
                <circle
                  cx={nodeRadius - 4}
                  cy={-nodeRadius + 4}
                  r="5"
                  fill="#34d399"
                  opacity="0.5"
                  style={{ animation: 'pulseNode 1.5s ease-in-out infinite' }}
                />
              )}

              {/* Name label */}
              <text
                y={nodeRadius + 18}
                textAnchor="middle"
                fill="white"
                fontSize={isCompact ? 10 : 12}
                fontWeight="600"
                className="select-none"
              >
                {pos.agent.name}
              </text>

              {/* Role label */}
              {pos.agent.role && (
                <text
                  y={nodeRadius + (isCompact ? 30 : 32)}
                  textAnchor="middle"
                  fill={rc.stroke}
                  fontSize={isCompact ? 7 : 9}
                  fontWeight="500"
                  opacity="0.7"
                  className="select-none"
                >
                  {pos.agent.role.toUpperCase()}
                </text>
              )}

              {/* Active task count badge */}
              {activeCount > 0 && (
                <g transform={`translate(${-nodeRadius + 4},${-nodeRadius + 4})`}>
                  <circle r="8" fill="#3b82f6" stroke="rgba(0,0,0,0.5)" strokeWidth="1.5" />
                  <text
                    textAnchor="middle"
                    dominantBaseline="central"
                    fill="white"
                    fontSize="9"
                    fontWeight="bold"
                    className="select-none"
                  >
                    {activeCount}
                  </text>
                </g>
              )}

              {/* Active task text — hidden on compact */}
              {activeInfo && !isCompact && (
                <text
                  y={nodeRadius + 40}
                  textAnchor="middle"
                  fill="rgba(255,255,255,0.4)"
                  fontSize="9"
                  className="select-none"
                >
                  {activeInfo.text}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/* ── Types (comments) ──────────────────────────────── */

interface TaskComment {
  id: string;
  taskId: string;
  author: string;
  content: string;
  createdAt: string;
}

interface SessionTurn {
  sessionId: string;
  role: string;
  content: string;
  timestamp?: string;
}

/* ── Session Turns Component ───────────────────────── */

function SessionTurns({ agentName }: { agentName: string }) {
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<SessionTurn[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch<{ turns: SessionTurn[]; error?: string }>(`/api/agents/${agentName}/turns`);
      setTurns(data.turns ?? []);
      if (data.error) setError(data.error);
    } catch (err: any) {
      setError(err.message ?? 'Failed to load turns');
    } finally {
      setLoading(false);
    }
  }

  function handleToggle() {
    const next = !open;
    setOpen(next);
    if (next && turns.length === 0 && !error) {
      load();
    }
  }

  const roleIcon = (role: string) => {
    if (role === 'user') return <User className="w-3.5 h-3.5 shrink-0 mt-0.5" />;
    if (role === 'assistant') return <Bot className="w-3.5 h-3.5 shrink-0 mt-0.5" />;
    return <Terminal className="w-3.5 h-3.5 shrink-0 mt-0.5" />;
  };

  const roleColor = (role: string) => {
    if (role === 'user') return 'bg-blue-500/10 border-blue-500/20 text-blue-300';
    if (role === 'assistant') return 'bg-violet-500/10 border-violet-500/20 text-violet-300';
    return 'bg-zinc-500/10 border-zinc-500/20 text-zinc-400';
  };

  return (
    <div className="border-t border-zinc-700 pt-4">
      <Button
        variant="ghost" onClick={handleToggle}
        className="flex items-center gap-2 text-[10px] uppercase text-zinc-500 tracking-wider hover:text-zinc-300 transition-colors w-full text-left"
      >
        {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        Session Turns
        {turns.length > 0 && (
          <span className="ml-auto text-[10px] bg-zinc-700/50 px-1.5 py-0.5 rounded-full">{turns.length}</span>
        )}
      </Button>

      {open && (
        <div className="mt-3 space-y-2 max-h-80 overflow-auto">
          {loading && (
            <p className="text-xs text-zinc-500">Loading…</p>
          )}
          {!loading && error && (
            <p className="text-xs text-amber-400">{error}</p>
          )}
          {!loading && !error && turns.length === 0 && (
            <p className="text-xs text-zinc-600">No session turns found.</p>
          )}
          {turns.map((turn, i) => (
            <div key={i} className={`rounded-lg border px-3 py-2 text-xs ${roleColor(turn.role)}`}>
              <div className="flex items-center gap-1.5 mb-1 font-medium capitalize">
                {roleIcon(turn.role)}
                {turn.role}
                {turn.timestamp && (
                  <span className="ml-auto text-[10px] opacity-50 font-normal">
                    {new Date(turn.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                )}
              </div>
              <p className="whitespace-pre-wrap leading-relaxed opacity-90">{turn.content}</p>
            </div>
          ))}
          {turns.length > 0 && (
            <Button
              variant="ghost" onClick={load}
              disabled={loading}
              className="text-[10px] text-zinc-500 hover:text-zinc-300 transition-colors"
            >
              ↻ Refresh
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

/* ── Task Detail Panel ─────────────────────────────── */

function TaskDetailPanel({ task, onClose, onUnblock, onCommentEvent }: { task: ArmadaTask; onClose: () => void; onUnblock?: (id: string) => void; onCommentEvent?: React.MutableRefObject<((data: { taskId: string; comment: TaskComment }) => void) | null> }) {
  const duration = msBetween(task.createdAt, task.completedAt);
  const [comments, setComments] = useState<TaskComment[]>([]);
  const [newComment, setNewComment] = useState('');
  const [commentAuthor, setCommentAuthor] = useState(() => localStorage.getItem('armada_comment_author') || 'user');
  const [submitting, setSubmitting] = useState(false);
  const commentsEndRef = useRef<HTMLDivElement>(null);

  // Fetch comments when task changes
  useEffect(() => {
    apiFetch<TaskComment[]>(`/api/tasks/${task.id}/comments`).then(setComments).catch(() => {});
  }, [task.id]);

  // Register SSE comment handler
  useEffect(() => {
    if (onCommentEvent) {
      onCommentEvent.current = (data) => {
        if (data.taskId === task.id) {
          setComments(prev => [...prev, data.comment]);
        }
      };
      return () => { onCommentEvent.current = null; };
    }
  }, [task.id, onCommentEvent]);

  // Scroll to bottom when new comments arrive
  useEffect(() => {
    commentsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [comments.length]);

  async function handleAddComment(e: React.FormEvent) {
    e.preventDefault();
    if (!newComment.trim() || submitting) return;
    setSubmitting(true);
    localStorage.setItem('armada_comment_author', commentAuthor);
    try {
      const comment = await apiFetch<TaskComment>(`/api/tasks/${task.id}/comments`, {
        method: 'POST',
        body: JSON.stringify({ author: commentAuthor, content: newComment.trim() }),
      });
      setComments(prev => [...prev, comment]);
      setNewComment('');
    } catch { /* ignore */ }
    setSubmitting(false);
  }

  return (
    <>
      {/* Backdrop overlay for mobile */}
      <div className="fixed inset-0 bg-black/50 z-40 sm:hidden" onClick={onClose} />
      <div className="fixed inset-y-0 right-0 w-full sm:w-96 bg-zinc-900/95 border-l border-zinc-700 shadow-2xl z-50 flex flex-col">
      <div className="flex items-center justify-between p-4 border-b border-zinc-700">
        <h3 className="text-sm font-semibold text-zinc-100">Task Detail</h3>
        <Button variant="ghost" onClick={onClose} className="text-zinc-400 hover:text-zinc-200"><X className="w-5 h-5" /></Button>
      </div>
      <div className="flex-1 overflow-auto p-4 space-y-4">
        <div className="flex items-center gap-2 flex-wrap">
          <Badge className={`text-xs uppercase tracking-wider font-semibold px-2 py-1 rounded-full border ${STATUS_BADGE[task.status] ?? ''}`}>
            {task.status}
          </Badge>
          <TaskTypeBadge taskType={task.taskType} />
          <Badge className={`text-xs px-2 py-1 rounded-full border ${task.workflowRunId ? 'bg-violet-500/20 border-violet-500/30 text-violet-300' : 'bg-zinc-500/20 border-zinc-500/30 text-zinc-300'}`}>
            {task.workflowRunId ? 'Workflow' : 'Standalone'}
          </Badge>
          {task.status === 'blocked' && onUnblock && (
            <Button
              variant="ghost" onClick={() => onUnblock(task.id)}
              className="text-xs px-3 py-1 rounded-full bg-orange-500/20 border border-orange-500/30 text-orange-300 hover:bg-orange-500/30 transition-colors font-medium"
            >
              Unblock
            </Button>
          )}
        </div>

        {task.status === 'blocked' && task.blockedReason && (
          <div className="rounded-xl bg-orange-500/10 border border-orange-500/20 px-3 py-2 text-sm text-orange-300">
            <span className="font-medium">Blocked:</span> {task.blockedReason}
          </div>
        )}

        <div className="space-y-3">
          <div>
            <label className="text-[10px] uppercase text-zinc-500 tracking-wider">From → To</label>
            <div className="flex items-center gap-2 mt-1">
              <AgentAvatar name={task.fromAgent} size="sm" />
              <span className="text-sm text-violet-300">{task.fromAgent}</span>
              <span className="text-zinc-600 mx-1">→</span>
              <AgentAvatar name={task.toAgent} size="sm" />
              <span className="text-sm text-blue-300">{task.toAgent}</span>
            </div>
          </div>

          <div>
            <label className="text-[10px] uppercase text-zinc-500 tracking-wider">Started</label>
            <p className="text-sm text-zinc-300 mt-0.5 font-mono">{new Date(task.createdAt).toLocaleString()}</p>
          </div>

          {task.completedAt && (
            <div>
              <label className="text-[10px] uppercase text-zinc-500 tracking-wider">Completed</label>
              <p className="text-sm text-zinc-300 mt-0.5 font-mono">{new Date(task.completedAt).toLocaleString()}</p>
            </div>
          )}

          {task.blockedAt && (
            <div>
              <label className="text-[10px] uppercase text-zinc-500 tracking-wider">Blocked At</label>
              <p className="text-sm text-zinc-300 mt-0.5 font-mono">{new Date(task.blockedAt).toLocaleString()}</p>
            </div>
          )}

          {duration !== null && (
            <div>
              <label className="text-[10px] uppercase text-zinc-500 tracking-wider">Duration</label>
              <p className="text-sm text-zinc-300 mt-0.5">{formatDuration(duration)}</p>
            </div>
          )}

          <div>
            <label className="text-[10px] uppercase text-zinc-500 tracking-wider">Task</label>
            <p className="text-sm text-zinc-300 mt-1 whitespace-pre-wrap leading-relaxed bg-zinc-800/50 rounded-lg p-3 border border-zinc-800">
              {task.taskText}
            </p>
          </div>

          {task.result && (
            <div>
              <label className="text-[10px] uppercase text-zinc-500 tracking-wider">Result</label>
              <p className="text-sm text-zinc-300 mt-1 whitespace-pre-wrap leading-relaxed bg-zinc-800/50 rounded-lg p-3 border border-zinc-800 max-h-64 overflow-auto">
                {task.result}
              </p>
            </div>
          )}
        </div>

        {/* Comments Section */}
        <div className="border-t border-zinc-700 pt-4">
          <label className="text-[10px] uppercase text-zinc-500 tracking-wider">Comments</label>
          <div className="mt-2 space-y-3 max-h-48 overflow-auto">
            {comments.length === 0 && (
              <p className="text-xs text-zinc-600">No comments yet</p>
            )}
            {comments.map(c => (
              <div key={c.id} className="rounded-lg bg-zinc-800/50 border border-zinc-800 px-3 py-2">
                <div className="flex items-center gap-2 text-[11px]">
                  <span className="text-violet-400 font-medium">{c.author}</span>
                  <span className="text-zinc-600">·</span>
                  <span className="text-zinc-500">{relativeTime(c.createdAt)}</span>
                </div>
                <p className="text-sm text-zinc-300 mt-1 whitespace-pre-wrap">{c.content}</p>
              </div>
            ))}
            <div ref={commentsEndRef} />
          </div>

          {/* Add comment form */}
          <form onSubmit={handleAddComment} className="mt-3 space-y-2">
            <Input
              type="text"
              value={commentAuthor}
              onChange={e => setCommentAuthor(e.target.value)}
              placeholder="Your name"
              className="w-full rounded-lg bg-zinc-800/50 border border-zinc-700 text-zinc-300 text-xs px-3 py-1.5 focus:outline-none focus:border-violet-500/50"
            />
            <div className="flex gap-2">
              <Input
                type="text"
                value={newComment}
                onChange={e => setNewComment(e.target.value)}
                placeholder="Add a comment…"
                className="flex-1 rounded-lg bg-zinc-800/50 border border-zinc-700 text-zinc-300 text-sm px-3 py-2 focus:outline-none focus:border-violet-500/50"
              />
              <Button
                variant="ghost" type="submit"
                disabled={!newComment.trim() || submitting}
                className="px-3 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors shrink-0"
              >
                Add
              </Button>
            </div>
          </form>
        </div>

        {/* Session Turns Section */}
        <SessionTurns agentName={task.toAgent} />
      </div>
    </div>
    </>
  );
}

/* ── Live Task Feed ────────────────────────────────── */

const statusIcon = (status: string) => {
  if (status === 'completed') return <CheckCircle2 className="w-4 h-4 text-emerald-400" />;
  if (status === 'failed') return <XCircle className="w-4 h-4 text-red-400" />;
  if (status === 'running') return <RefreshCw className="w-4 h-4 text-blue-400" />;
  if (status === 'pending') return <Hourglass className="w-4 h-4 text-amber-400" />;
  if (status === 'blocked') return <Ban className="w-4 h-4 text-orange-400" />;
  return <HelpCircle className="w-4 h-4 text-zinc-400" />;
};

function LiveTaskFeed({ tasks, loading, onTaskClick, onUnblock }: { tasks: ArmadaTask[]; loading?: boolean; onTaskClick: (t: ArmadaTask) => void; onUnblock: (id: string) => void }) {
  // Sort by most recently updated first (newest at top)
  const sortedTasks = useMemo(() => {
    return [...tasks].sort((a, b) => {
      const aTime = new Date(a.completedAt ?? a.createdAt).getTime();
      const bTime = new Date(b.completedAt ?? b.createdAt).getTime();
      return bTime - aTime;
    });
  }, [tasks]);

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50">
      <Table>
        <TableHeader>
          <TableRow className="border-b border-zinc-800">
            <TableHead className="px-4 py-3 text-left text-[11px] text-zinc-500 uppercase tracking-wider hidden sm:table-cell">Time</TableHead>
            <TableHead className="px-4 py-3 text-left text-[11px] text-zinc-500 uppercase tracking-wider">From → To</TableHead>
            <TableHead className="px-4 py-3 text-left text-[11px] text-zinc-500 uppercase tracking-wider">Task</TableHead>
            <TableHead className="px-4 py-3 text-left text-[11px] text-zinc-500 uppercase tracking-wider hidden sm:table-cell">Type</TableHead>
            <TableHead className="px-4 py-3 text-left text-[11px] text-zinc-500 uppercase tracking-wider">Status</TableHead>
            <TableHead className="px-4 py-3 text-[11px] text-zinc-500 uppercase tracking-wider hidden sm:table-cell"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading ? (
            <>
              <RowSkeleton cols={6} />
              <RowSkeleton cols={6} />
              <RowSkeleton cols={6} />
              <RowSkeleton cols={6} />
              <RowSkeleton cols={6} />
            </>
          ) : sortedTasks.length === 0 ? (
            <TableRow>
              <TableCell colSpan={6}>
                <EmptyState
                  icon={Radio}
                  title="No tasks yet"
                  description="Tasks will appear here as agents communicate"
                />
              </TableCell>
            </TableRow>
          ) : (
            sortedTasks.map((t) => (
              <TableRow
                key={t.id}
                onClick={() => onTaskClick(t)}
                className="border-b border-zinc-800/50 hover:bg-zinc-800/40 transition-colors cursor-pointer"
              >
                {/* Timestamp — hidden on mobile */}
                <TableCell className="px-4 py-3 text-[11px] text-zinc-500 font-mono hidden sm:table-cell whitespace-nowrap">
                  {formatTime(t.createdAt)}
                </TableCell>
                {/* Agent flow */}
                <TableCell className="px-4 py-3">
                  <span className="flex items-center gap-1.5">
                    <AgentAvatar name={t.fromAgent} size="xs" />
                    <span className="hidden sm:inline text-xs text-violet-300">{t.fromAgent}</span>
                    <span className="text-zinc-600 text-xs">→</span>
                    <AgentAvatar name={t.toAgent} size="xs" />
                    <span className="hidden sm:inline text-xs text-blue-300">{t.toAgent}</span>
                  </span>
                </TableCell>
                {/* Task text */}
                <TableCell className="px-4 py-3 max-w-[240px]">
                  <div className="flex items-center gap-1.5 min-w-0">
                    {t.projectId && (
                      <span className="hidden sm:inline text-[9px] px-1.5 py-0.5 rounded-full bg-zinc-800/50 border border-zinc-700 text-zinc-400 shrink-0">
                        {t.projectId}
                      </span>
                    )}
                    <span className="text-xs text-zinc-400 truncate">{truncate(t.taskText, 80)}</span>
                  </div>
                </TableCell>
                {/* Type badge */}
                <TableCell className="px-4 py-3 hidden sm:table-cell">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <TaskTypeBadge taskType={t.taskType} />
                    {t.workflowRunId && (
                      <Badge className="text-[10px] px-2 py-0.5 rounded-full border bg-violet-500/20 border-violet-500/30 text-violet-300">
                        Workflow
                      </Badge>
                    )}
                  </div>
                </TableCell>
                {/* Status */}
                <TableCell className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <span className="sm:hidden" title={t.status}>
                      {statusIcon(t.status)}
                    </span>
                    <Badge className={`hidden sm:inline text-[10px] uppercase tracking-wider font-semibold px-2 py-0.5 rounded-full border ${STATUS_BADGE[t.status] ?? 'bg-zinc-500/20 text-zinc-300 border-zinc-500/30'}`}>
                      {t.status}
                    </Badge>
                  </div>
                </TableCell>
                {/* Actions */}
                <TableCell className="px-4 py-3 hidden sm:table-cell">
                  {t.status === 'blocked' && (
                    <span
                      role="button"
                      onClick={(e) => { e.stopPropagation(); onUnblock(t.id); }}
                      className="text-[10px] px-2 py-0.5 rounded-full bg-orange-500/20 border border-orange-500/30 text-orange-300 hover:bg-orange-500/30 transition-colors cursor-pointer shrink-0"
                    >
                      Unblock
                    </span>
                  )}
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}

/* ── Stats Panel ───────────────────────────────────── */

function StatsPanel({ tasks }: { tasks: ArmadaTask[] }) {
  const stats = useMemo(() => {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const todayTasks = tasks.filter(t => new Date(t.createdAt).getTime() >= todayStart);
    const completed = todayTasks.filter(t => t.status === 'completed');
    const failed = todayTasks.filter(t => t.status === 'failed');
    const active = tasks.filter(t => t.status === 'running' || t.status === 'pending');
    const blocked = tasks.filter(t => t.status === 'blocked');

    // Average completion time
    const durations = completed
      .map(t => msBetween(t.createdAt, t.completedAt))
      .filter((d): d is number => d !== null);
    const avgDuration = durations.length > 0
      ? durations.reduce((a, b) => a + b, 0) / durations.length
      : 0;

    // Success rate
    const finishedCount = completed.length + failed.length;
    const successRate = finishedCount > 0 ? (completed.length / finishedCount) * 100 : 100;

    // Tasks per agent
    const agentCounts: Record<string, number> = {};
    for (const t of todayTasks) {
      agentCounts[t.toAgent] = (agentCounts[t.toAgent] || 0) + 1;
    }
    const topAgents = Object.entries(agentCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6);
    const maxAgentCount = topAgents.length > 0 ? topAgents[0][1] : 1;

    return {
      totalToday: todayTasks.length,
      successRate,
      avgDuration,
      active: active.length,
      blocked: blocked.length,
      topAgents,
      maxAgentCount,
    };
  }, [tasks]);

  return (
    <div className="space-y-4">
      {/* Stat cards */}
      <div className="grid grid-cols-3 sm:grid-cols-5 gap-3">
        <div className="rounded-xl bg-zinc-900/50 border border-zinc-800 p-3">
          <div className="text-[10px] uppercase text-zinc-500 tracking-wider">Today</div>
          <div className="text-2xl font-bold text-zinc-100 mt-1">{stats.totalToday}</div>
        </div>
        <div className="rounded-xl bg-zinc-900/50 border border-zinc-800 p-3">
          <div className="text-[10px] uppercase text-zinc-500 tracking-wider">Success</div>
          <div className="text-2xl font-bold text-emerald-400 mt-1">{stats.successRate.toFixed(0)}%</div>
        </div>
        <div className="rounded-xl bg-zinc-900/50 border border-zinc-800 p-3">
          <div className="text-[10px] uppercase text-zinc-500 tracking-wider">Avg Time</div>
          <div className="text-lg font-bold text-zinc-100 mt-1">
            {stats.avgDuration > 0 ? formatDuration(stats.avgDuration) : '—'}
          </div>
        </div>
        <div className="rounded-xl bg-zinc-900/50 border border-zinc-800 p-3 relative">
          <div className="text-[10px] uppercase text-zinc-500 tracking-wider">Active</div>
          <div className="text-2xl font-bold text-blue-400 mt-1">{stats.active}</div>
          {stats.active > 0 && (
            <span className="absolute top-2 right-2 h-2 w-2 rounded-full bg-blue-400 animate-pulse" />
          )}
        </div>
        <div className="rounded-xl bg-zinc-900/50 border border-zinc-800 p-3 relative">
          <div className="text-[10px] uppercase text-zinc-500 tracking-wider">Blocked</div>
          <div className="text-2xl font-bold text-orange-400 mt-1">{stats.blocked}</div>
          {stats.blocked > 0 && (
            <span className="absolute top-2 right-2 h-2 w-2 rounded-full bg-orange-400 animate-pulse" />
          )}
        </div>
      </div>

      {/* Tasks per agent bar chart */}
      <div className="rounded-xl bg-zinc-900/50 border border-zinc-800 p-3">
        <div className="text-[10px] uppercase text-zinc-500 tracking-wider mb-3">Tasks by Agent</div>
        {stats.topAgents.length === 0 ? (
          <p className="text-xs text-zinc-600">No data yet</p>
        ) : (
          <div className="space-y-2">
            {stats.topAgents.map(([name, count]) => (
              <div key={name} className="flex items-center gap-2">
                <span className="text-xs text-zinc-400 w-16 sm:w-20 truncate shrink-0">{name}</span>
                <div className="flex-1 h-4 rounded-full bg-zinc-800/50 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-violet-500/60 to-blue-500/60 transition-all duration-500"
                    style={{ width: `${(count / stats.maxAgentCount) * 100}%` }}
                  />
                </div>
                <span className="text-xs text-zinc-500 w-6 text-right shrink-0">{count}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ── SSE Hook ──────────────────────────────────────── */

function useTaskSSE(onEvent: (type: string, task: ArmadaTask) => void) {
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    let es: EventSource | null = null;
    let retryMs = 1000;

    function connect() {
      const token = localStorage.getItem('armada_token');
      const url = token ? `/api/tasks/stream?token=${encodeURIComponent(token)}` : '/api/tasks/stream';
      es = new EventSource(url);

      es.addEventListener('task:created', (e) => {
        try {
          onEventRef.current('task:created', JSON.parse(e.data));
        } catch { /* ignore parse errors */ }
      });

      es.addEventListener('task:updated', (e) => {
        try {
          onEventRef.current('task:updated', JSON.parse(e.data));
        } catch { /* ignore parse errors */ }
      });

      es.addEventListener('task:comment', (e) => {
        try {
          onEventRef.current('task:comment', JSON.parse(e.data));
        } catch { /* ignore parse errors */ }
      });

      es.onopen = () => {
        retryMs = 1000;
      };

      es.onerror = () => {
        es?.close();
        setTimeout(connect, retryMs);
        retryMs = Math.min(retryMs * 2, 30_000);
      };
    }

    connect();
    return () => { es?.close(); };
  }, []);
}

/* ── Send Task Modal ───────────────────────────────── */

function SendTaskModal({
  agents,
  onClose,
  onSent,
}: {
  agents: ArmadaAgent[];
  onClose: () => void;
  onSent: (taskId: string) => void;
}) {
  const [target, setTarget] = useState('');
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [reachableRoles, setReachableRoles] = useState<string[] | null>(null);

  // Fetch hierarchy to determine which roles operator can reach
  useEffect(() => {
    apiFetch<{ rules: Record<string, string[]> }>('/api/hierarchy')
      .then(h => setReachableRoles(h.rules?.operator ?? []))
      .catch(() => setReachableRoles(null)); // fallback: show all
  }, []);

  const runningAgents = useMemo(
    () => agents.filter(a => {
      if (a.status !== 'running') return false;
      // If we have hierarchy info, only show agents with reachable roles
      if (reachableRoles) return reachableRoles.includes(a.role ?? '');
      return true;
    }),
    [agents, reachableRoles],
  );

  // Focus textarea on mount
  useEffect(() => {
    const t = setTimeout(() => textareaRef.current?.focus(), 100);
    return () => clearTimeout(t);
  }, []);

  // Pre-select first running agent
  useEffect(() => {
    if (!target && runningAgents.length > 0) {
      setTarget(runningAgents[0].name);
    }
  }, [runningAgents, target]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!target || !message.trim()) return;

    setSending(true);
    setError(null);

    try {
      const res = await apiFetch<{ taskId: string }>('/api/tasks/send', {
        method: 'POST',
        body: JSON.stringify({ target, message: message.trim() }),
      });
      onSent(res.taskId);
    } catch (err: any) {
      setError(err.message || 'Failed to send task');
      setSending(false);
    }
  }

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/60 z-40" onClick={onClose} />

      {/* Modal */}
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <form
          onSubmit={handleSubmit}
          className="w-full max-w-lg rounded-lg border border-zinc-700 bg-zinc-900/95 shadow-2xl flex flex-col max-h-[90vh]"
        >
          {/* Header */}
          <div className="flex items-center justify-between p-4 border-b border-zinc-700 shrink-0">
            <h3 className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
              <Rocket className="w-4 h-4" /> Send Task
            </h3>
            <Button
              variant="ghost" type="button"
              onClick={onClose}
              className="text-zinc-400 hover:text-zinc-200"
            >
              <X className="w-5 h-5" />
            </Button>
          </div>

          {/* Body */}
          <div className="p-4 space-y-4 overflow-auto flex-1">
            {/* Target agent */}
            <div>
              <label className="text-[10px] uppercase text-zinc-500 tracking-wider block mb-1.5">
                Target Agent
              </label>
              {runningAgents.length === 0 ? (
                <p className="text-sm text-zinc-500">No running agents available</p>
              ) : (
                <div className="flex items-center gap-3">
                  {target && <AgentAvatar name={target} size="sm" />}
                  <Select value={target} onValueChange={setTarget}>
                    <SelectTrigger className="flex-1 rounded-xl bg-zinc-800/50 border border-zinc-700 text-zinc-200 text-sm focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/30">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {runningAgents.map(a => (
                        <SelectItem key={a.name} value={a.name}>
                          {a.name} ({a.role || 'unknown'})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>

            {/* Message */}
            <div>
              <label className="text-[10px] uppercase text-zinc-500 tracking-wider block mb-1.5">
                Message
              </label>
              <Textarea
                ref={textareaRef}
                value={message}
                onChange={e => setMessage(e.target.value)}
                placeholder="Describe the task for the agent…"
                rows={6}
                className="w-full rounded-xl bg-zinc-800/50 border border-zinc-700 text-zinc-200 text-sm px-3 py-2.5 focus:outline-none focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/30 resize-y placeholder-gray-600"
              />
            </div>

            {/* Error */}
            {error && (
              <div className="rounded-xl bg-red-500/10 border border-red-500/20 px-3 py-2 text-sm text-red-300">
                {error}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-end gap-3 p-4 border-t border-zinc-700 shrink-0">
            <Button
              variant="ghost" type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
            >
              Cancel
            </Button>
            <Button
              variant="ghost" type="submit"
              disabled={sending || !target || !message.trim() || runningAgents.length === 0}
              className="px-4 py-2 rounded-xl bg-violet-600 hover:bg-violet-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors flex items-center gap-2"
            >
              {sending ? (
                <>
                  <span className="h-3.5 w-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  Sending…
                </>
              ) : (
                'Send Task'
              )}
            </Button>
          </div>
        </form>
      </div>
    </>
  );
}

/* ── Toast Notification ────────────────────────────── */

function Toast({ message, onDone }: { message: string; onDone: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDone, 4000);
    return () => clearTimeout(t);
  }, [onDone]);

  return (
    <div className="fixed bottom-6 right-6 z-50 animate-[slideUp_0.3s_ease-out]">
      <div className="rounded-xl bg-emerald-500/20 border border-emerald-500/30 px-4 py-3 text-sm text-emerald-300 shadow-2xl flex items-center gap-2">
        <span>✓</span> {message}
      </div>
    </div>
  );
}

/* ── Main Page ─────────────────────────────────────── */

export default function Tasks() {
  const { getRoleColor, getRoleTier } = useRoles();
  const [agents, setAgents] = useState<ArmadaAgent[]>([]);
  const [tasks, setTasks] = useState<ArmadaTask[]>([]);
  const [selectedTask, setSelectedTask] = useState<ArmadaTask | null>(null);
  const [showSendModal, setShowSendModal] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const commentEventRef = useRef<((data: { taskId: string; comment: TaskComment }) => void) | null>(null);

  // Unblock handler
  const handleUnblock = useCallback(async (taskId: string) => {
    try {
      const updated = await apiFetch<ArmadaTask>(`/api/tasks/${taskId}/unblock`, { method: 'POST' });
      setTasks(prev => prev.map(t => t.id === taskId ? updated : t));
      setSelectedTask(prev => prev?.id === taskId ? updated : prev);
      setToast(`Task ${taskId.slice(0, 12)}… unblocked`);
    } catch (err: any) {
      setToast(`Failed to unblock: ${err.message}`);
    }
  }, []);

  // Initial fetch
  useEffect(() => {
    async function load() {
      try {
        const [agentData, taskData] = await Promise.all([
          apiFetch<ArmadaAgent[]>('/api/agents'),
          apiFetch<ArmadaTask[]>('/api/tasks?limit=200'),
        ]);
        setAgents(agentData);
        setTasks(taskData);
      } catch (err) {
        console.error('Failed to load tasks:', err);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  // Refresh agents on SSE agent events
  useSSEAll(useCallback((type: string) => {
    if (type.startsWith('agent.')) {
      apiFetch<ArmadaAgent[]>('/api/agents')
        .then(data => setAgents(data))
        .catch(() => { /* ignore */ });
    }
  }, []));

  // SSE for real-time task updates
  useTaskSSE(useCallback((type: string, data: any) => {
    if (type === 'task:comment') {
      commentEventRef.current?.(data);
      return;
    }
    const task = data as ArmadaTask;
    setTasks(prev => {
      if (type === 'task:created') {
        if (prev.some(t => t.id === task.id)) return prev.map(t => t.id === task.id ? task : t);
        const next = [...prev, task];
        return next.length > 200 ? next.slice(-200) : next;
      }
      if (type === 'task:updated') {
        return prev.map(t => t.id === task.id ? task : t);
      }
      return prev;
    });

    // Update selected task if viewing it
    if (type === 'task:updated') {
      setSelectedTask(prev => prev?.id === task.id ? task : prev);
    }
  }, []));

  return (
    <div className="space-y-6 h-full flex flex-col">
      {/* Header */}
      <div className="shrink-0">
        <PageHeader icon={Zap} title="Task Activity" subtitle="Real-time Armada task monitoring & network topology">
          <Button
            onClick={() => setShowSendModal(true)}
            className="bg-violet-600 hover:bg-violet-700 text-white text-sm px-4 h-9 flex items-center gap-2"
          >
            <Rocket className="w-4 h-4" />
            <span className="hidden sm:inline">Send Task</span>
            <span className="sm:hidden">Send</span>
          </Button>
        </PageHeader>
      </div>

      {/* Topology Graph - Hero Section */}
      <div className="shrink-0 rounded-lg border border-zinc-800 bg-zinc-950 backdrop-blur overflow-visible relative">
        {/* Subtle gradient overlay */}
        <div className="absolute inset-0 bg-gradient-to-b from-violet-500/[0.02] to-blue-500/[0.02] pointer-events-none" />
        <div className="absolute top-4 left-5 z-10">
          <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">Network Topology</h3>
        </div>
        {agents.length === 0 ? (
          <div className="flex items-center justify-center h-full text-zinc-600 text-sm">
            No agents registered
          </div>
        ) : (
          <TopologyGraph agents={agents} tasks={tasks} onTaskClick={setSelectedTask} roleColor={getRoleColor} getTier={getRoleTier} />
        )}
      </div>

      {/* Bottom section: Feed + Stats */}
      <div className="flex flex-col lg:flex-row gap-4 flex-1 min-h-0">
        {/* Stats Panel - shown first on mobile */}
        <div className="order-1 lg:order-2 lg:flex-[2] rounded-lg border border-zinc-800 bg-zinc-900/50 backdrop-blur p-4 overflow-auto">
          <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-3">Statistics</h3>
          <StatsPanel tasks={tasks} />
        </div>

        {/* Live Task Feed */}
        <div className="order-2 lg:order-1 lg:flex-[3] flex flex-col min-h-[300px] lg:min-h-0">
          <div className="flex items-center justify-between mb-3 shrink-0">
            <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">Live Feed</h3>
            <span className="text-[10px] text-zinc-600">{tasks.length} tasks</span>
          </div>
          <div className="flex-1 min-h-0 overflow-auto">
            <LiveTaskFeed tasks={tasks} loading={loading} onTaskClick={setSelectedTask} onUnblock={handleUnblock} />
          </div>
        </div>
      </div>

      {/* Task Detail Slide-out */}
      {selectedTask && (
        <TaskDetailPanel task={selectedTask} onClose={() => setSelectedTask(null)} onUnblock={handleUnblock} onCommentEvent={commentEventRef} />
      )}

      {/* Send Task Modal */}
      {showSendModal && (
        <SendTaskModal
          agents={agents}
          onClose={() => setShowSendModal(false)}
          onSent={(taskId) => {
            setShowSendModal(false);
            setToast(`Task ${taskId} sent successfully`);
          }}
        />
      )}

      {/* Toast */}
      {toast && <Toast message={toast} onDone={() => setToast(null)} />}
    </div>
  );
}
