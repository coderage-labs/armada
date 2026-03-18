import { useEffect, useState } from 'react';
import { Crown, Route, CheckCircle, X, Loader2, User, Bot } from 'lucide-react';
import { apiFetch } from '../hooks/useApi';
import { toast } from 'sonner';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from './ui/select';

/* ── Types ─────────────────────────────────────────── */

interface AssigneeUser {
  id: string;
  name: string;
  displayName: string;
  role?: string;
  avatarUrl?: string | null;
}

interface AssigneeAgent {
  id?: string;
  name: string;
  role?: string;
  status?: string;
}

interface Assignment {
  type: 'owner' | 'triager' | 'approver';
  assigneeType?: 'user' | 'agent';
  assigneeId?: string;
  assigneeName?: string;
  assigneeDisplayName?: string;
}

interface AssignmentsResponse {
  owner?: Assignment | null;
  triager?: Assignment | null;
  approver?: Assignment | null;
}

/* ── Config ─────────────────────────────────────────── */

const ASSIGNMENT_CONFIG = [
  {
    type: 'owner' as const,
    label: 'Owner',
    icon: Crown,
    iconClass: 'text-amber-400',
    description: 'Responsible for the project',
  },
  {
    type: 'triager' as const,
    label: 'Triager',
    icon: Route,
    iconClass: 'text-blue-400',
    description: 'Triages incoming issues',
  },
  {
    type: 'approver' as const,
    label: 'Approver',
    icon: CheckCircle,
    iconClass: 'text-emerald-400',
    description: 'Approves work before completion',
  },
];

/* ── Avatar ─────────────────────────────────────────── */

function AssigneeAvatar({
  name,
  displayName,
  assigneeType,
}: {
  name: string;
  displayName: string;
  assigneeType: 'user' | 'agent';
}) {
  if (assigneeType === 'agent') {
    return (
      <div className="w-7 h-7 rounded-full bg-gradient-to-br from-violet-600 to-blue-600 flex items-center justify-center shrink-0">
        <Bot className="w-3.5 h-3.5 text-white" />
      </div>
    );
  }
  return (
    <div className="w-7 h-7 rounded-full bg-gradient-to-br from-violet-500 to-blue-500 flex items-center justify-center text-white text-xs font-medium overflow-hidden shrink-0">
      <img
        src={`/api/users/${name}/avatar?size=sm`}
        alt={displayName}
        className="w-full h-full object-cover"
        onError={(e) => {
          (e.target as HTMLImageElement).style.display = 'none';
        }}
      />
      {displayName?.[0]?.toUpperCase() ?? <User className="w-3.5 h-3.5" />}
    </div>
  );
}

/* ── Main Component ─────────────────────────────────── */

export default function ProjectAssignments({ projectId }: { projectId: string }) {
  const [assignments, setAssignments] = useState<AssignmentsResponse>({});
  const [users, setUsers] = useState<AssigneeUser[]>([]);
  const [agents, setAgents] = useState<AssigneeAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState<string | null>(null);

  useEffect(() => {
    loadAll();
  }, [projectId]);

  async function loadAll() {
    setLoading(true);
    try {
      const [assignmentsData, usersData, agentsData] = await Promise.all([
        apiFetch<AssignmentsResponse>(`/api/projects/${projectId}/assignments`).catch(() => ({})),
        apiFetch<AssigneeUser[]>('/api/users').catch(() => []),
        apiFetch<AssigneeAgent[]>('/api/agents').catch(() => []),
      ]);
      setAssignments(assignmentsData);
      setUsers(Array.isArray(usersData) ? usersData : []);
      setAgents(Array.isArray(agentsData) ? agentsData : []);
    } catch (err) {
      console.error('Failed to load assignments:', err);
    } finally {
      setLoading(false);
    }
  }

  async function handleAssign(type: 'owner' | 'triager' | 'approver', value: string) {
    // value format: "user:<id>" or "agent:<name>"
    if (!value || value === '__none__') return;
    const [assigneeType, assigneeId] = value.split(':') as ['user' | 'agent', string];
    setUpdating(type);
    try {
      const updated = await apiFetch<AssignmentsResponse>(
        `/api/projects/${projectId}/assignments/${type}`,
        {
          method: 'PUT',
          body: JSON.stringify({ assigneeType, assigneeId }),
        },
      );
      setAssignments((prev) => ({ ...prev, [type]: updated[type] ?? { type, assigneeType, assigneeId } }));
      // Reload to get fresh display names
      loadAll();
      toast.success(`${type.charAt(0).toUpperCase() + type.slice(1)} updated`);
    } catch (err: any) {
      toast.error(`Failed to update ${type}: ${err.message}`);
    } finally {
      setUpdating(null);
    }
  }

  async function handleRemove(type: 'owner' | 'triager' | 'approver') {
    setUpdating(type);
    try {
      await apiFetch(`/api/projects/${projectId}/assignments/${type}`, { method: 'DELETE' });
      setAssignments((prev) => ({ ...prev, [type]: null }));
      toast.success(`${type.charAt(0).toUpperCase() + type.slice(1)} removed`);
    } catch (err: any) {
      toast.error(`Failed to remove ${type}: ${err.message}`);
    } finally {
      setUpdating(null);
    }
  }

  if (loading) {
    return (
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4 flex items-center gap-2 text-sm text-zinc-500">
        <Loader2 className="w-4 h-4 animate-spin" />
        Loading assignments…
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4 space-y-1">
      <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-3">
        Assignments
      </h3>

      <div className="divide-y divide-zinc-800/60">
        {ASSIGNMENT_CONFIG.map(({ type, label, icon: Icon, iconClass }) => {
          const assignment = assignments[type];
          const isUpdating = updating === type;
          const hasAssignee = !!assignment?.assigneeId;

          const currentValue = hasAssignee
            ? `${assignment!.assigneeType}:${assignment!.assigneeId}`
            : '__none__';

          return (
            <div
              key={type}
              className="flex items-center gap-3 py-3 first:pt-0 last:pb-0"
            >
              {/* Type label */}
              <div className="flex items-center gap-2 w-28 shrink-0">
                <Icon className={`w-4 h-4 shrink-0 ${iconClass}`} />
                <span className="text-sm font-medium text-zinc-300">{label}</span>
              </div>

              {/* Current assignee */}
              <div className="flex items-center gap-2 flex-1 min-w-0">
                {hasAssignee ? (
                  <>
                    <AssigneeAvatar
                      name={assignment!.assigneeId!}
                      displayName={assignment!.assigneeDisplayName || assignment!.assigneeId!}
                      assigneeType={assignment!.assigneeType!}
                    />
                    <span className="text-sm text-zinc-200 truncate">
                      {assignment!.assigneeDisplayName || assignment!.assigneeName || assignment!.assigneeId}
                    </span>
                    <Badge
                      variant="secondary"
                      className={`text-[10px] px-1.5 py-0 shrink-0 ${
                        assignment!.assigneeType === 'agent'
                          ? 'bg-violet-500/20 text-violet-300 border-violet-500/30'
                          : 'bg-zinc-700/50 text-zinc-400 border-zinc-600'
                      }`}
                    >
                      {assignment!.assigneeType}
                    </Badge>
                  </>
                ) : (
                  <span className="text-sm text-zinc-600 italic">Unassigned</span>
                )}
              </div>

              {/* Select dropdown */}
              <div className="w-48 shrink-0">
                <Select
                  value={currentValue}
                  onValueChange={(val) => handleAssign(type, val)}
                  disabled={isUpdating}
                >
                  <SelectTrigger className="w-full border-zinc-800 bg-zinc-800/50 text-sm h-8">
                    {isUpdating ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <SelectValue placeholder="Assign…" />
                    )}
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">
                      <span className="text-zinc-500 italic">Unassigned</span>
                    </SelectItem>

                    {users.length > 0 && (
                      <SelectGroup>
                        <SelectLabel className="text-[10px] uppercase text-zinc-500 tracking-wider px-2 py-1">
                          Users
                        </SelectLabel>
                        {users.map((u) => (
                          <SelectItem key={`user:${u.id}`} value={`user:${u.id}`}>
                            <div className="flex items-center gap-2">
                              <User className="w-3 h-3 text-zinc-400 shrink-0" />
                              <span>{u.displayName || u.name}</span>
                              {u.role && (
                                <span className="text-[10px] text-zinc-500">({u.role})</span>
                              )}
                            </div>
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    )}

                    {agents.length > 0 && (
                      <SelectGroup>
                        <SelectLabel className="text-[10px] uppercase text-zinc-500 tracking-wider px-2 py-1">
                          Agents
                        </SelectLabel>
                        {agents.map((a) => (
                          <SelectItem
                            key={`agent:${a.name}`}
                            value={`agent:${a.name}`}
                          >
                            <div className="flex items-center gap-2">
                              <Bot className="w-3 h-3 text-violet-400 shrink-0" />
                              <span>{a.name}</span>
                              {a.role && (
                                <span className="text-[10px] text-zinc-500">({a.role})</span>
                              )}
                            </div>
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    )}
                  </SelectContent>
                </Select>
              </div>

              {/* Remove button */}
              <Button
                variant="ghost"
                size="icon"
                onClick={() => handleRemove(type)}
                disabled={!hasAssignee || isUpdating}
                className="w-7 h-7 shrink-0 text-zinc-600 hover:text-red-400 hover:bg-red-500/10 disabled:opacity-30 disabled:cursor-not-allowed"
                title={`Remove ${label}`}
              >
                {isUpdating ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <X className="w-3.5 h-3.5" />
                )}
              </Button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
