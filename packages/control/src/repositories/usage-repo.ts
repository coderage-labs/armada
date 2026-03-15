import { eq } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { getDrizzle } from '../db/drizzle.js';
import { getDb } from '../db/index.js';
import { apiUsageLog } from '../db/drizzle-schema.js';

// ── Types ────────────────────────────────────────────────────────────

export type UsagePeriod = 'day' | 'week' | 'month' | 'all';

export interface UsageEntry {
  id: string;
  apiKeyId: string | null;
  providerId: string | null;
  agentId: string | null;
  modelId: string | null;
  instanceId: string | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  sessionKey: string | null;
  createdAt: string;
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  requestCount: number;
}

export interface UsageByDimension extends UsageTotals {
  key: string;
  label: string;
}

// ── Helpers ──────────────────────────────────────────────────────────

/** Returns a JS ISO string for the start of the given period, or null for 'all'. */
function periodCutoff(period: UsagePeriod): string | null {
  if (period === 'all') return null;
  const now = new Date();
  if (period === 'day')   now.setDate(now.getDate() - 1);
  else if (period === 'week')  now.setDate(now.getDate() - 7);
  else if (period === 'month') now.setDate(now.getDate() - 30);
  // SQLite stores dates as 'YYYY-MM-DD HH:MM:SS'
  return now.toISOString().replace('T', ' ').slice(0, 19);
}

function rowToEntry(r: typeof apiUsageLog.$inferSelect): UsageEntry {
  return {
    id: r.id,
    apiKeyId: r.apiKeyId ?? null,
    providerId: r.providerId ?? null,
    agentId: r.agentId ?? null,
    modelId: r.modelId ?? null,
    instanceId: r.instanceId ?? null,
    inputTokens: r.inputTokens ?? 0,
    outputTokens: r.outputTokens ?? 0,
    totalTokens: r.totalTokens ?? 0,
    costUsd: r.costUsd ?? 0,
    sessionKey: r.sessionKey ?? null,
    createdAt: r.createdAt,
  };
}

// ── Repository ───────────────────────────────────────────────────────

export const usageRepo = {
  /** Insert a new usage record. */
  log(entry: {
    apiKeyId?: string | null;
    providerId?: string | null;
    agentId?: string | null;
    modelId?: string | null;
    instanceId?: string | null;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    costUsd?: number;
    sessionKey?: string | null;
  }): UsageEntry {
    const id = uuidv4();
    getDrizzle().insert(apiUsageLog).values({
      id,
      apiKeyId: entry.apiKeyId ?? null,
      providerId: entry.providerId ?? null,
      agentId: entry.agentId ?? null,
      modelId: entry.modelId ?? null,
      instanceId: entry.instanceId ?? null,
      inputTokens: entry.inputTokens ?? 0,
      outputTokens: entry.outputTokens ?? 0,
      totalTokens: entry.totalTokens ?? 0,
      costUsd: entry.costUsd ?? 0,
      sessionKey: entry.sessionKey ?? null,
    }).run();
    return rowToEntry(getDrizzle().select().from(apiUsageLog).where(eq(apiUsageLog.id, id)).get()!);
  },

  /** Overall usage totals, optionally filtered by period. */
  getSummary(period: UsagePeriod = 'all'): UsageTotals {
    const db = getDb();
    const cutoff = periodCutoff(period);
    const whereClause = cutoff ? `WHERE created_at >= '${cutoff}'` : '';
    const row = db.prepare<[], {
      input_tokens: number | null;
      output_tokens: number | null;
      total_tokens: number | null;
      cost_usd: number | null;
      request_count: number;
    }>(`
      SELECT
        SUM(input_tokens)  AS input_tokens,
        SUM(output_tokens) AS output_tokens,
        SUM(total_tokens)  AS total_tokens,
        SUM(cost_usd)      AS cost_usd,
        COUNT(*)           AS request_count
      FROM api_usage_log
      ${whereClause}
    `).get();
    return {
      inputTokens:  Number(row?.input_tokens  ?? 0),
      outputTokens: Number(row?.output_tokens ?? 0),
      totalTokens:  Number(row?.total_tokens  ?? 0),
      costUsd:      Number(row?.cost_usd      ?? 0),
      requestCount: Number(row?.request_count ?? 0),
    };
  },

  /** Usage grouped by provider, optionally filtered by period. */
  getByProvider(period: UsagePeriod = 'all'): UsageByDimension[] {
    const db = getDb();
    const cutoff = periodCutoff(period);
    const whereClause = cutoff
      ? `WHERE provider_id IS NOT NULL AND created_at >= '${cutoff}'`
      : 'WHERE provider_id IS NOT NULL';
    const rows = db.prepare<[], {
      provider_id: string;
      input_tokens: number;
      output_tokens: number;
      total_tokens: number;
      cost_usd: number;
      request_count: number;
    }>(`
      SELECT
        provider_id,
        SUM(input_tokens)  AS input_tokens,
        SUM(output_tokens) AS output_tokens,
        SUM(total_tokens)  AS total_tokens,
        SUM(cost_usd)      AS cost_usd,
        COUNT(*)           AS request_count
      FROM api_usage_log
      ${whereClause}
      GROUP BY provider_id
      ORDER BY total_tokens DESC
    `).all();
    return rows.map(r => ({
      key:          r.provider_id,
      label:        r.provider_id,
      inputTokens:  Number(r.input_tokens  ?? 0),
      outputTokens: Number(r.output_tokens ?? 0),
      totalTokens:  Number(r.total_tokens  ?? 0),
      costUsd:      Number(r.cost_usd      ?? 0),
      requestCount: Number(r.request_count ?? 0),
    }));
  },

  /** Usage grouped by agent, optionally filtered by period. */
  getByAgent(period: UsagePeriod = 'all'): UsageByDimension[] {
    const db = getDb();
    const cutoff = periodCutoff(period);
    const whereClause = cutoff
      ? `WHERE agent_id IS NOT NULL AND created_at >= '${cutoff}'`
      : 'WHERE agent_id IS NOT NULL';
    const rows = db.prepare<[], {
      agent_id: string;
      input_tokens: number;
      output_tokens: number;
      total_tokens: number;
      cost_usd: number;
      request_count: number;
    }>(`
      SELECT
        agent_id,
        SUM(input_tokens)  AS input_tokens,
        SUM(output_tokens) AS output_tokens,
        SUM(total_tokens)  AS total_tokens,
        SUM(cost_usd)      AS cost_usd,
        COUNT(*)           AS request_count
      FROM api_usage_log
      ${whereClause}
      GROUP BY agent_id
      ORDER BY total_tokens DESC
    `).all();
    return rows.map(r => ({
      key:          r.agent_id,
      label:        r.agent_id,
      inputTokens:  Number(r.input_tokens  ?? 0),
      outputTokens: Number(r.output_tokens ?? 0),
      totalTokens:  Number(r.total_tokens  ?? 0),
      costUsd:      Number(r.cost_usd      ?? 0),
      requestCount: Number(r.request_count ?? 0),
    }));
  },

  /** Usage totals for a specific model, optionally filtered by period. */
  getByModel(modelId: string, period: UsagePeriod = 'all'): UsageTotals & { lastUsed: string | null } {
    const db = getDb();
    const cutoff = periodCutoff(period);
    const whereClause = cutoff
      ? `WHERE model_id = ? AND created_at >= '${cutoff}'`
      : 'WHERE model_id = ?';
    const row = db.prepare<[string], {
      input_tokens: number | null;
      output_tokens: number | null;
      total_tokens: number | null;
      cost_usd: number | null;
      request_count: number;
      last_used: string | null;
    }>(`
      SELECT
        SUM(input_tokens)  AS input_tokens,
        SUM(output_tokens) AS output_tokens,
        SUM(total_tokens)  AS total_tokens,
        SUM(cost_usd)      AS cost_usd,
        COUNT(*)           AS request_count,
        MAX(created_at)    AS last_used
      FROM api_usage_log
      ${whereClause}
    `).get(modelId);
    return {
      inputTokens:  Number(row?.input_tokens  ?? 0),
      outputTokens: Number(row?.output_tokens ?? 0),
      totalTokens:  Number(row?.total_tokens  ?? 0),
      costUsd:      Number(row?.cost_usd      ?? 0),
      requestCount: Number(row?.request_count ?? 0),
      lastUsed:     row?.last_used ?? null,
    };
  },

  /** Lightweight usage summary for all models (for model list endpoint). */
  getAllModelsSummary(period: UsagePeriod = 'all'): Map<string, { totalTokens: number; requestCount: number; lastUsed: string | null }> {
    const db = getDb();
    const cutoff = periodCutoff(period);
    const whereClause = cutoff
      ? `WHERE model_id IS NOT NULL AND created_at >= '${cutoff}'`
      : 'WHERE model_id IS NOT NULL';
    const rows = db.prepare<[], {
      model_id: string;
      total_tokens: number;
      request_count: number;
      last_used: string | null;
    }>(`
      SELECT
        model_id,
        SUM(total_tokens) AS total_tokens,
        COUNT(*)          AS request_count,
        MAX(created_at)   AS last_used
      FROM api_usage_log
      ${whereClause}
      GROUP BY model_id
    `).all();
    const map = new Map<string, { totalTokens: number; requestCount: number; lastUsed: string | null }>();
    for (const r of rows) {
      map.set(r.model_id, {
        totalTokens:  Number(r.total_tokens  ?? 0),
        requestCount: Number(r.request_count ?? 0),
        lastUsed:     r.last_used ?? null,
      });
    }
    return map;
  },

  /** Usage for a specific API key, optionally filtered by period. */
  getByKey(keyId: string, period: UsagePeriod = 'all'): UsageTotals & { entries: UsageEntry[] } {
    const db = getDb();
    const cutoff = periodCutoff(period);
    const whereClause = cutoff
      ? `WHERE api_key_id = ? AND created_at >= '${cutoff}'`
      : 'WHERE api_key_id = ?';
    const rows = db.prepare<[string], {
      id: string;
      api_key_id: string | null;
      provider_id: string | null;
      agent_id: string | null;
      model_id: string | null;
      instance_id: string | null;
      input_tokens: number;
      output_tokens: number;
      total_tokens: number;
      cost_usd: number;
      session_key: string | null;
      created_at: string;
    }>(`
      SELECT * FROM api_usage_log
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT 500
    `).all(keyId);

    const entries: UsageEntry[] = rows.map(r => ({
      id: r.id,
      apiKeyId:     r.api_key_id,
      providerId:   r.provider_id,
      agentId:      r.agent_id,
      modelId:      r.model_id,
      instanceId:   r.instance_id,
      inputTokens:  Number(r.input_tokens  ?? 0),
      outputTokens: Number(r.output_tokens ?? 0),
      totalTokens:  Number(r.total_tokens  ?? 0),
      costUsd:      Number(r.cost_usd      ?? 0),
      sessionKey:   r.session_key,
      createdAt:    r.created_at,
    }));

    const totals = entries.reduce((acc, r) => ({
      inputTokens:  acc.inputTokens  + r.inputTokens,
      outputTokens: acc.outputTokens + r.outputTokens,
      totalTokens:  acc.totalTokens  + r.totalTokens,
      costUsd:      acc.costUsd      + r.costUsd,
      requestCount: acc.requestCount + 1,
    }), { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, requestCount: 0 });

    return { ...totals, entries };
  },
};
