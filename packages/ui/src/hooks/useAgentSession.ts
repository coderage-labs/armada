import { useQuery } from '@tanstack/react-query';
import { apiFetch } from './useApi';

export interface SessionInfo {
  sessionKey: string;
  sessionId: string;
  kind?: string;
  label?: string;
  displayName?: string;
  model: string;
  modelProvider: string;
  updatedAt: number;
  chatType?: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens?: number;
  contextTokens?: number;
  thinkingLevel?: string;
  channel?: string;
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: any }
  | { type: 'tool_result'; tool_use_id: string; content: any; is_error?: boolean }
  | { type: 'thinking'; text: string };

export interface SessionMessage {
  id: string;
  parentId: string | null;
  role: 'user' | 'assistant' | 'system';
  content: ContentBlock[];
  timestamp: string;
  model?: string;
  provider?: string;
}

export function useAgentSessions(agentName: string) {
  return useQuery({
    queryKey: ['agent-sessions', agentName],
    queryFn: () =>
      apiFetch<{ sessions: SessionInfo[] }>(`/api/agents/${agentName}/session`),
    refetchInterval: 10000,
    enabled: !!agentName,
  });
}

export function useAgentSessionMessages(
  agentName: string,
  sessionKey: string | null,
  after?: string,
) {
  return useQuery({
    queryKey: ['agent-session-messages', agentName, sessionKey, after],
    queryFn: () => {
      const params = new URLSearchParams();
      if (sessionKey) params.set('sessionKey', sessionKey);
      if (after) params.set('after', after);
      params.set('limit', '100');
      return apiFetch<{
        messages: SessionMessage[];
        session: any;
        hasMore: boolean;
        total: number;
      }>(`/api/agents/${agentName}/session/messages?${params}`);
    },
    enabled: !!sessionKey,
    refetchInterval: 3000,
  });
}
