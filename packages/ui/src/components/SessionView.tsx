import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Terminal,
  Brain,
  CheckCircle2,
  XCircle,
  ChevronDown,
  ChevronRight,
  MessageSquare,
  ArrowDown,
  Bot,
  User,
} from 'lucide-react';
import { apiFetch } from '../hooks/useApi';
import { useSSEAll } from '../providers/SSEProvider';
import { cn } from '../lib/utils';
import { Button } from './ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { EmptyState } from './EmptyState';
import type { SessionInfo, SessionMessage, ContentBlock } from '../hooks/useAgentSession';

interface SessionViewProps {
  agentName: string;
}

// ── Collapsible block helper ────────────────────────────────────────────────

function CollapsibleBlock({
  header,
  children,
  defaultOpen = false,
}: {
  header: React.ReactNode;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="bg-zinc-900 border border-zinc-700 rounded-md p-2 my-1">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 w-full text-left"
        type="button"
      >
        {open ? (
          <ChevronDown className="w-3 h-3 text-zinc-500 shrink-0" />
        ) : (
          <ChevronRight className="w-3 h-3 text-zinc-500 shrink-0" />
        )}
        {header}
      </button>
      {open && <div className="mt-2">{children}</div>}
    </div>
  );
}

// ── Content block renderers ─────────────────────────────────────────────────

function ToolUseBlock({ block }: { block: Extract<ContentBlock, { type: 'tool_use' }> }) {
  return (
    <CollapsibleBlock
      header={
        <span className="flex items-center gap-2">
          <Terminal className="w-3.5 h-3.5 text-violet-400" />
          <span className="font-mono text-sm text-violet-400">{block.name}</span>
        </span>
      }
    >
      <pre className="bg-zinc-950 text-zinc-300 text-xs font-mono p-2 rounded overflow-x-auto whitespace-pre-wrap break-words">
        {JSON.stringify(block.input, null, 2)}
      </pre>
    </CollapsibleBlock>
  );
}

function ToolResultBlock({
  block,
}: {
  block: Extract<ContentBlock, { type: 'tool_result' }>;
}) {
  const content = typeof block.content === 'string'
    ? block.content
    : JSON.stringify(block.content, null, 2);

  const truncated = content.length > 500 ? content.slice(0, 500) + '\n…(truncated)' : content;

  return (
    <div
      className={cn(
        'bg-zinc-900 border rounded-md p-2 my-1',
        block.is_error ? 'border-red-500/50' : 'border-zinc-700',
      )}
    >
      <CollapsibleBlock
        header={
          <span className="flex items-center gap-2">
            {block.is_error ? (
              <XCircle className="w-3.5 h-3.5 text-red-400" />
            ) : (
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
            )}
            <span className={cn('text-xs font-medium', block.is_error ? 'text-red-400' : 'text-zinc-400')}>
              Result
            </span>
          </span>
        }
      >
        <pre className="bg-zinc-950 text-zinc-300 text-xs font-mono p-2 rounded overflow-x-auto whitespace-pre-wrap break-words">
          {truncated}
        </pre>
      </CollapsibleBlock>
    </div>
  );
}

function ThinkingBlock({ block }: { block: Extract<ContentBlock, { type: 'thinking' }> }) {
  return (
    <div className="bg-zinc-900/50 border border-zinc-600 rounded-md p-2 my-1">
      <CollapsibleBlock
        header={
          <span className="flex items-center gap-2">
            <Brain className="w-3.5 h-3.5 text-zinc-500" />
            <span className="text-xs text-zinc-500 italic">Thinking…</span>
          </span>
        }
      >
        <pre className="text-xs text-zinc-500 font-mono whitespace-pre-wrap break-words">
          {block.text}
        </pre>
      </CollapsibleBlock>
    </div>
  );
}

function renderContentBlock(block: ContentBlock, idx: number) {
  if (block.type === 'text') {
    return (
      <p key={idx} className="text-sm text-zinc-200 whitespace-pre-wrap break-words leading-relaxed">
        {block.text}
      </p>
    );
  }
  if (block.type === 'tool_use') {
    return <ToolUseBlock key={idx} block={block} />;
  }
  if (block.type === 'tool_result') {
    return <ToolResultBlock key={idx} block={block} />;
  }
  if (block.type === 'thinking') {
    return <ThinkingBlock key={idx} block={block} />;
  }
  return null;
}

// ── Message bubble ──────────────────────────────────────────────────────────

function MessageBubble({ message }: { message: SessionMessage }) {
  const roleStyles: Record<string, string> = {
    user: 'bg-violet-600/20 border border-violet-500/30 rounded-lg p-3',
    assistant: 'bg-zinc-800 border border-zinc-700 rounded-lg p-3',
    system: 'bg-amber-500/10 border border-amber-500/30 rounded-lg p-2 text-sm italic',
  };

  const roleLabel: Record<string, { icon: React.ReactNode; label: string; color: string }> = {
    user: { icon: <User className="w-3.5 h-3.5" />, label: 'User', color: 'text-violet-400' },
    assistant: { icon: <Bot className="w-3.5 h-3.5" />, label: 'Assistant', color: 'text-zinc-400' },
    system: { icon: <Terminal className="w-3.5 h-3.5" />, label: 'System', color: 'text-amber-400' },
  };

  const meta = roleLabel[message.role] ?? roleLabel.system;

  const ts = new Date(message.timestamp);
  const timeStr = ts.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  return (
    <div className="flex flex-col gap-1">
      {/* Role label + timestamp */}
      <div className={cn('flex items-center gap-1.5 text-xs', meta.color)}>
        {meta.icon}
        <span className="font-medium">{meta.label}</span>
        {message.model && (
          <span className="text-zinc-600 font-mono">· {message.model}</span>
        )}
        <span className="text-zinc-600 ml-auto">{timeStr}</span>
      </div>

      {/* Bubble */}
      <div className={roleStyles[message.role] ?? roleStyles.system}>
        {Array.isArray(message.content)
          ? message.content.map((block, i) => renderContentBlock(block, i))
          : <p className="text-sm text-zinc-200">{String(message.content)}</p>}
      </div>
    </div>
  );
}

// ── Session picker ──────────────────────────────────────────────────────────

function formatSessionOption(s: SessionInfo): string {
  const updated = new Date(s.updatedAt).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  // Show a friendly label: displayName, label, or last segment of sessionKey
  const name = s.displayName || s.label || s.sessionKey.split(':').slice(-1)[0];
  const tokens = s.totalTokens ? ` · ${s.totalTokens.toLocaleString()}t` : '';
  return `${name} · ${s.model} · ${updated}${tokens}`;
}

// ── Main component ──────────────────────────────────────────────────────────

export default function SessionView({ agentName }: SessionViewProps) {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [messages, setMessages] = useState<SessionMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [newMessagesWhileScrolledUp, setNewMessagesWhileScrolledUp] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Fetch session list ────────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;
    async function fetchSessions(isInitial = false) {
      if (isInitial) setSessionsLoading(true);
      try {
        const data = await apiFetch<{ sessions: SessionInfo[] }>(
          `/api/agents/${agentName}/session`,
        );
        if (cancelled) return;
        const list = data?.sessions ?? [];
        setSessions(list);
        if (list.length > 0) {
          setSelectedKey((prev) => {
            if (prev) return prev;
            // Prefer a session with actual token usage (not empty)
            const withActivity = list.find((s) => (s.totalTokens || 0) > 0);
            return withActivity?.sessionKey ?? list[0].sessionKey;
          });
        }
      } catch {
        // silently ignore — session endpoint may not exist yet
      } finally {
        if (!cancelled) setSessionsLoading(false);
      }
    }
    fetchSessions(true);
    const interval = setInterval(() => fetchSessions(false), 10000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [agentName]);

  // ── Fetch messages (reusable) ─────────────────────────────────────────────

  const fetchMessages = useCallback(async () => {
    if (!selectedKey) return;
    try {
      const params = new URLSearchParams({ sessionKey: selectedKey, limit: '200' });
      const data = await apiFetch<{ messages: SessionMessage[] }>(
        `/api/agents/${agentName}/session/messages?${params}`,
      );
      const msgs = data?.messages ?? [];
      setMessages((prev) => {
        if (prev.length === msgs.length) return prev;
        if (!autoScroll && msgs.length > prev.length) {
          setNewMessagesWhileScrolledUp(true);
        }
        return msgs;
      });
    } catch {
      // silently ignore
    }
  }, [agentName, selectedKey, autoScroll]);

  // ── Fetch initial messages when session key changes ───────────────────────

  useEffect(() => {
    if (!selectedKey) return;
    let cancelled = false;
    setMessages([]);
    setMessagesLoading(true);

    async function fetchInitial() {
      try {
        const params = new URLSearchParams({ sessionKey: selectedKey!, limit: '200' });
        const data = await apiFetch<{ messages: SessionMessage[] }>(
          `/api/agents/${agentName}/session/messages?${params}`,
        );
        if (cancelled) return;
        const msgs = data?.messages ?? [];
        setMessages(msgs);
      } catch {
        // silently ignore
      } finally {
        if (!cancelled) setMessagesLoading(false);
      }
    }
    fetchInitial();
    return () => { cancelled = true; };
  }, [agentName, selectedKey]);

  // ── Real-time updates via SSE ─────────────────────────────────────────────

  // Subscribe to session events — refetch when this agent's sessions update
  useSSEAll(useCallback((eventType: string, _data: any) => {
    if (eventType === 'agent.session.updated') {
      fetchMessages();
    }
  }, [fetchMessages]));

  // ── Fallback polling (30s) — resilience when SSE is disconnected ──────────

  useEffect(() => {
    if (!selectedKey) return;

    async function poll() {
      if (document.hidden) return;
      await fetchMessages();
    }

    pollingRef.current = setInterval(poll, 30_000);
    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current);
    };
  }, [selectedKey, fetchMessages]);

  // ── Auto-scroll ───────────────────────────────────────────────────────────

  useEffect(() => {
    if (autoScroll && messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
      setNewMessagesWhileScrolledUp(false);
    }
  }, [messages, autoScroll]);

  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distFromBottom > 100) {
      setAutoScroll(false);
    } else {
      setAutoScroll(true);
      setNewMessagesWhileScrolledUp(false);
    }
  }, []);

  function scrollToBottom() {
    setAutoScroll(true);
    setNewMessagesWhileScrolledUp(false);
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }

  // ── Render ────────────────────────────────────────────────────────────────

  if (sessionsLoading) {
    return (
      <div className="flex items-center justify-center py-16 text-zinc-500 text-sm">
        Loading sessions…
      </div>
    );
  }

  if (!sessionsLoading && sessions.length === 0) {
    return (
      <EmptyState
        icon={MessageSquare}
        title="No active sessions"
        description="This agent hasn't started any sessions yet."
      />
    );
  }

  return (
    <div className="flex flex-col gap-4 h-full">
      {/* Session picker */}
      {sessions.length > 1 && (
        <div className="flex items-center gap-3">
          <span className="text-xs text-zinc-500 shrink-0">Session</span>
          <Select value={selectedKey ?? ''} onValueChange={setSelectedKey}>
            <SelectTrigger className="w-full max-w-sm text-xs">
              <SelectValue placeholder="Select session" />
            </SelectTrigger>
            <SelectContent>
              {sessions.map((s) => (
                <SelectItem key={s.sessionKey} value={s.sessionKey} className="text-xs">
                  {formatSessionOption(s)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {/* Token / stats strip */}
      {selectedKey && (() => {
        const session = sessions.find((s) => s.sessionKey === selectedKey);
        if (!session) return null;
        return (
          <div className="flex flex-wrap gap-3 text-[11px] text-zinc-500">
            <span>
              <span className="text-zinc-400 font-medium">{messages.length}</span> messages
            </span>
            <span>
              <span className="text-zinc-400 font-medium">{(session.totalTokens || 0).toLocaleString()}</span> tokens
            </span>
            <span className="font-mono text-zinc-600">{session.model}</span>
            {session.displayName && (
              <span className="text-zinc-600">· {session.displayName}</span>
            )}
          </div>
        );
      })()}

      {/* Messages container */}
      <div className="relative flex-1 min-h-0">
        <div
          ref={containerRef}
          onScroll={handleScroll}
          className="overflow-y-auto rounded-lg border border-zinc-800 bg-zinc-950 p-4 space-y-4"
          style={{ maxHeight: 'calc(100vh - 380px)', minHeight: '300px' }}
        >
          {messagesLoading && (
            <div className="text-center text-zinc-500 text-sm py-4">Loading messages…</div>
          )}

          {!messagesLoading && messages.length === 0 && (
            <div className="text-center text-zinc-600 text-sm py-8">No messages in this session.</div>
          )}

          {messages.map((msg) => (
            <MessageBubble key={msg.id} message={msg} />
          ))}

          <div ref={messagesEndRef} />
        </div>

        {/* New messages button */}
        {newMessagesWhileScrolledUp && (
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2">
            <Button
              onClick={scrollToBottom}
              size="sm"
              className="bg-violet-600 hover:bg-violet-700 text-white shadow-lg flex items-center gap-1.5 text-xs transition-all duration-200"
            >
              <ArrowDown className="w-3.5 h-3.5" />
              New messages
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
