import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { apiFetch } from '../hooks/useApi';
import { useLogs } from '../hooks/queries/useLogs';
import { Checkbox } from '../components/ui/checkbox';
import { Cable, ChevronDown } from 'lucide-react';
import { PageHeader } from '../components/PageHeader';
import { Button } from '../components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  DropdownMenuCheckboxItem,
  DropdownMenuSeparator,
  DropdownMenuItem,
  DropdownMenuLabel,
} from '../components/ui/dropdown-menu';
import { Input } from '../components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Table, TableHeader, TableBody, TableHead, TableRow, TableCell } from '../components/ui/table';

/* ── types ─────────────────────────────────────────────────────── */

interface Agent {
  id: string;
  name: string;
  status: string;
  instanceId?: string;
}

interface Instance {
  id: string;
  name: string;
}

interface LogLine {
  id: number;
  timestamp: string;
  agent: string;
  level: string;
  message: string;
}

/* ── helpers ────────────────────────────────────────────────────── */

const MAX_LINES = 2000;
let lineSeq = 0;

/** Regex to parse log lines: TIMESTAMP [LEVEL] MESSAGE (or TIMESTAMP LEVEL MESSAGE) */
const LOG_RE = /^(\S+)\s+\[?(\w+)\]?\s+(.*)$/;

/** Strip stray prefix chars before an ISO timestamp (e.g. "A2026-..." → "2026-...") */
function cleanTimestamp(raw: string): string {
  const idx = raw.indexOf('20');
  if (idx > 0) return raw.slice(idx);
  return raw;
}

function parseLogLine(raw: string, agent: string): LogLine | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const m = trimmed.match(LOG_RE);
  if (m) {
    return { id: ++lineSeq, timestamp: cleanTimestamp(m[1]), agent, level: m[2].toLowerCase(), message: m[3] };
  }
  return { id: ++lineSeq, timestamp: new Date().toISOString(), agent, level: 'info', message: trimmed };
}

async function fetchTextWithAuth(path: string): Promise<string> {
  const token = localStorage.getItem('armada_token');
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(path, { headers });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.text();
}

function hashColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
  const colors = [
    'bg-blue-500/30 text-blue-300',
    'bg-emerald-500/30 text-emerald-300',
    'bg-violet-500/30 text-violet-300',
    'bg-amber-500/30 text-amber-300',
    'bg-rose-500/30 text-rose-300',
    'bg-cyan-500/30 text-cyan-300',
    'bg-pink-500/30 text-pink-300',
    'bg-lime-500/30 text-lime-300',
  ];
  return colors[Math.abs(h) % colors.length];
}

function levelClass(level: string) {
  switch (level.toLowerCase()) {
    case 'error': return 'text-red-400';
    case 'warn': case 'warning': return 'text-amber-400';
    default: return 'text-zinc-400';
  }
}

function fmtTime(ts: string) {
  try {
    const d = new Date(ts);
    if (isNaN(d.getTime())) return ts;
    return d.toLocaleTimeString('en-GB', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return ts;
  }
}

/* ── component ─────────────────────────────────────────────────── */

export default function Logs() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [instances, setInstances] = useState<Instance[]>([]);
  const [selectedInstance, setSelectedInstance] = useState<string>('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [levelFilter, setLevelFilter] = useState<string>('all');
  const [timeFilter, setTimeFilter] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [liveTail, setLiveTail] = useState(false);
  const [lines, setLines] = useState<LogLine[]>([]);

  const logRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);
  const esRef = useRef<EventSource[]>([]);

  /* fetch instances */
  useEffect(() => {
    apiFetch<Instance[]>('/api/instances')
      .then((data) => setInstances(data))
      .catch(() => {});
  }, []);

  /* fetch agent list */
  useEffect(() => {
    apiFetch<Agent[]>('/api/agents')
      .then((data) => setAgents(data))
      .catch(() => {});
  }, []);

  /* derive visible agents based on selected instance */
  const visibleAgents = selectedInstance === 'all'
    ? agents
    : agents.filter((a) => a.instanceId === selectedInstance);

  /* when instance filter changes, clear agent selection */
  useEffect(() => {
    setSelected(new Set());
  }, [selectedInstance]);

  /* toggle agent selection */
  const toggleAgent = (name: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });
  };

  const selectAll = () => setSelected(new Set(visibleAgents.map((a) => a.name)));
  const selectNone = () => setSelected(new Set());

  /* Build params for useLogs from filter state */
  const logsParams = useMemo<Record<string, string> | undefined>(() => {
    if (selected.size === 0) return undefined;
    const p: Record<string, string> = { agents: [...selected].join(',') };
    if (levelFilter !== 'all') p.level = levelFilter;
    if (timeFilter !== 'all') p.since = timeFilter;
    if (search) p.q = search;
    return p;
  }, [selected, levelFilter, timeFilter, search]);

  const { data: logsData } = useLogs(logsParams);

  /* Sync structured log data from hook into lines state */
  useEffect(() => {
    if (!logsData) return;
    const converted: LogLine[] = (logsData as any[]).map(d => ({
      id: ++lineSeq,
      timestamp: d.timestamp || new Date().toISOString(),
      agent: d.agent || '',
      level: (d.level || 'info').toLowerCase(),
      message: d.message || '',
    }));
    setLines(converted);
  }, [logsData]);

  /* auto-scroll logic */
  const handleScroll = useCallback(() => {
    const el = logRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    autoScrollRef.current = atBottom;
  }, []);

  useEffect(() => {
    if (!autoScrollRef.current || !liveTail) return;
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines, liveTail]);

  /* live tail SSE */
  useEffect(() => {
    // clean up previous
    esRef.current.forEach((es) => es.close());
    esRef.current = [];

    if (!liveTail || selected.size === 0) return;

    const token = localStorage.getItem('armada_token');

    selected.forEach((agentName) => {
      const url = `/api/agents/${encodeURIComponent(agentName)}/logs/stream${token ? `?token=${encodeURIComponent(token)}` : ''}`;
      const es = new EventSource(url);

      es.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data);
          const line: LogLine = {
            id: ++lineSeq,
            timestamp: data.timestamp || new Date().toISOString(),
            agent: data.agent || agentName,
            level: data.level || 'info',
            message: data.message || ev.data,
          };
          setLines((prev) => {
            const next = [...prev, line];
            return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
          });
        } catch {
          // plain text fallback
          setLines((prev) => {
            const next = [...prev, {
              id: ++lineSeq,
              timestamp: new Date().toISOString(),
              agent: agentName,
              level: 'info',
              message: ev.data,
            }];
            return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
          });
        }
      };

      esRef.current.push(es);
    });

    return () => {
      esRef.current.forEach((es) => es.close());
      esRef.current = [];
    };
  }, [liveTail, selected]);

  /* filter lines */
  const filtered = lines.filter((l) => {
    if (selected.size > 0 && !selected.has(l.agent)) return false;
    if (levelFilter !== 'all' && l.level.toLowerCase() !== levelFilter) return false;
    if (timeFilter !== 'all') {
      const mins = timeFilter === '5m' ? 5 : timeFilter === '15m' ? 15 : 60;
      const cutoff = Date.now() - mins * 60_000;
      if (new Date(l.timestamp).getTime() < cutoff) return false;
    }
    if (search && !l.message.toLowerCase().includes(search.toLowerCase()) && !l.agent.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const clearLogs = () => { setLines([]); lineSeq = 0; };

  /* filter button helper */
  const FilterBtn = ({ label, value, current, onClick }: { label: string; value: string; current: string; onClick: (v: string) => void }) => (
    <Button
      variant="ghost" onClick={() => onClick(value)}
      className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-all ${
        current === value
          ? 'bg-violet-500/20 border-violet-500 text-violet-300'
          : 'border-zinc-800 text-zinc-400 hover:border-zinc-700 hover:text-zinc-300'
      }`}
    >
      {label}
    </Button>
  );

  return (
    <div className="space-y-4">
      {/* header */}
      <PageHeader icon={Cable} title="Logs" subtitle="System and agent logs">
        {/* live tail */}
        <Button
          variant="ghost" onClick={() => setLiveTail((p) => !p)}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg border text-sm font-medium transition-all ${
            liveTail
              ? 'bg-green-500/10 border-green-500/50 text-green-400'
              : 'border-zinc-800 text-zinc-400 hover:border-zinc-700'
          }`}
        >
          {liveTail && (
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
            </span>
          )}
          Live Tail
        </Button>
        {/* clear */}
        <Button
          variant="ghost" onClick={clearLogs}
          className="px-4 py-2 rounded-lg border border-zinc-800 text-sm text-zinc-400 hover:border-zinc-700 hover:text-zinc-300 transition-all"
        >
          Clear
        </Button>
      </PageHeader>

      {/* filters row */}
      <div className="flex flex-wrap items-center gap-4 rounded-lg bg-zinc-900/50 border border-zinc-800 p-3">
        {/* instance filter */}
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] text-zinc-500 uppercase tracking-wider">Instance</span>
          <Select value={selectedInstance} onValueChange={setSelectedInstance}>
            <SelectTrigger className="h-7 text-xs min-w-[100px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              {instances.map((inst) => (
                <SelectItem key={inst.id} value={inst.id}>{inst.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* agent selector */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded-lg border border-zinc-800 text-zinc-400 hover:border-zinc-700 hover:text-zinc-300 transition-all min-w-[140px]">
              <span>Agents{selected.size > 0 ? ` (${selected.size})` : ''}</span>
              <ChevronDown className="w-3 h-3 ml-auto" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            <DropdownMenuLabel className="flex gap-2">
              <button onClick={selectAll} className="text-[10px] text-violet-400 hover:text-violet-300">All</button>
              <button onClick={selectNone} className="text-[10px] text-zinc-500 hover:text-zinc-400">None</button>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            {visibleAgents.map((a) => (
              <DropdownMenuCheckboxItem
                key={a.name}
                checked={selected.has(a.name)}
                onCheckedChange={() => toggleAgent(a.name)}
                onSelect={(e) => e.preventDefault()}
              >
                <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${hashColor(a.name)}`}>{a.name}</span>
              </DropdownMenuCheckboxItem>
            ))}
            {visibleAgents.length === 0 && (
              <DropdownMenuItem disabled>No agents found</DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* level filter */}
        <div className="flex gap-1">
          {[['All', 'all'], ['Info', 'info'], ['Warn', 'warn'], ['Error', 'error']].map(([label, value]) => (
            <FilterBtn key={value} label={label} value={value} current={levelFilter} onClick={setLevelFilter} />
          ))}
        </div>

        {/* time filter */}
        <div className="flex gap-1">
          {[['Last 5m', '5m'], ['15m', '15m'], ['1h', '1h'], ['All', 'all']].map(([label, value]) => (
            <FilterBtn key={`t-${value}`} label={label} value={value} current={timeFilter} onClick={setTimeFilter} />
          ))}
        </div>

        {/* search */}
        <div className="flex-1 min-w-[180px]">
          <Input
            type="text"
            placeholder="Search logs..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full px-3 py-1.5 text-xs rounded-lg border border-zinc-800 bg-black/20 text-zinc-300 placeholder-gray-600 focus:outline-none focus:border-violet-500/50 transition-all"
          />
        </div>
      </div>

      {/* log display */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 overflow-hidden">
        <div
          ref={logRef}
          onScroll={handleScroll}
          className="overflow-y-auto max-h-[calc(100vh-280px)]"
        >
          <Table className="font-mono text-xs">
            <TableHeader className="sticky top-0 bg-zinc-900/95 backdrop-blur z-10">
              <TableRow className="border-b border-zinc-800">
                <TableHead className="text-left text-[11px] text-zinc-500 uppercase tracking-wider whitespace-nowrap w-20">Time</TableHead>
                <TableHead className="text-left text-[11px] text-zinc-500 uppercase tracking-wider w-28">Agent</TableHead>
                <TableHead className="text-left text-[11px] text-zinc-500 uppercase tracking-wider w-14">Level</TableHead>
                <TableHead className="text-left text-[11px] text-zinc-500 uppercase tracking-wider">Message</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="py-16 text-center">
                    <div className="flex flex-col items-center justify-center text-zinc-600">
                      <Cable className="w-10 h-10 mb-3 opacity-40" />
                      <p className="text-sm text-zinc-500">
                        {selected.size > 0
                          ? (liveTail ? 'Waiting for log events…' : 'No recent logs. Enable Live Tail for real-time streaming.')
                          : selectedInstance !== 'all'
                            ? 'Select agents from this instance to view logs'
                            : 'Select agents to view recent logs'}
                      </p>
                    </div>
                  </TableCell>
                </TableRow>
              ) : (
                filtered.map((l) => (
                  <TableRow key={l.id} className="border-b border-zinc-800/50 hover:bg-zinc-800/40 transition-colors">
                    <TableCell className="px-4 py-1 text-zinc-500 whitespace-nowrap">{fmtTime(l.timestamp)}</TableCell>
                    <TableCell className="px-4 py-1">
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium leading-none ${hashColor(l.agent)}`}>
                        {l.agent}
                      </span>
                    </TableCell>
                    <TableCell className="px-4 py-1">
                      <span className={`uppercase text-[10px] font-bold ${levelClass(l.level)}`}>
                        {l.level.slice(0, 4)}
                      </span>
                    </TableCell>
                    <TableCell className="px-4 py-1 text-zinc-300 break-all">{l.message}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      {/* status bar */}
      <div className="flex items-center justify-between text-[10px] text-zinc-600 px-1">
        <span>{filtered.length} / {lines.length} lines</span>
        <span>
          {liveTail && selected.size > 0 && (
            <span className="text-green-500/70">● streaming from {selected.size} agent{selected.size > 1 ? 's' : ''}</span>
          )}
        </span>
      </div>
    </div>
  );
}
