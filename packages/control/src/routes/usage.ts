/**
 * Usage & cost tracking routes (#302)
 *
 * Public (auth-guarded) endpoints:
 *   GET /api/usage/summary?period=week
 *   GET /api/usage/by-provider?period=month
 *   GET /api/usage/by-agent?period=month
 *   GET /api/usage/by-key/:keyId?period=month
 *
 * Internal ingestion endpoint (armada-agent plugin → control plane):
 *   POST /api/internal/usage
 */

import { Router } from 'express';
import { usageRepo, type UsagePeriod } from '../repositories/usage-repo.js';

// ── Helpers ───────────────────────────────────────────────────────────

const VALID_PERIODS = new Set<string>(['day', 'week', 'month', 'all']);

function parsePeriod(raw: unknown): UsagePeriod {
  if (typeof raw === 'string' && VALID_PERIODS.has(raw)) return raw as UsagePeriod;
  return 'all';
}

// ── Authenticated usage routes ────────────────────────────────────────

export const usageRoutes = Router();

/** GET /api/usage/summary?period=week */
usageRoutes.get('/summary', (req, res) => {
  const period = parsePeriod(req.query.period);
  const summary = usageRepo.getSummary(period);
  res.json({ period, ...summary });
});

/** GET /api/usage/by-provider?period=month */
usageRoutes.get('/by-provider', (req, res) => {
  const period = parsePeriod(req.query.period);
  const rows = usageRepo.getByProvider(period);
  res.json({ period, rows });
});

/** GET /api/usage/by-agent?period=month */
usageRoutes.get('/by-agent', (req, res) => {
  const period = parsePeriod(req.query.period);
  const rows = usageRepo.getByAgent(period);
  res.json({ period, rows });
});

/** GET /api/usage/by-key/:keyId?period=month */
usageRoutes.get('/by-key/:keyId', (req, res) => {
  const period = parsePeriod(req.query.period);
  const result = usageRepo.getByKey(req.params.keyId, period);
  res.json({ period, keyId: req.params.keyId, ...result });
});

// ── Internal ingestion router (fleet token auth only) ─────────────────

export const internalUsageRouter = Router();

/**
 * POST /api/internal/usage
 *
 * Called by armada-agent plugin after each turn to report token usage.
 * Authenticated by the same fleet token that protects all /api routes.
 */
internalUsageRouter.post('/', (req, res) => {
  const {
    apiKeyId,
    providerId,
    agentId,
    modelId,
    instanceId,
    inputTokens,
    outputTokens,
    totalTokens,
    costUsd,
    sessionKey,
  } = req.body ?? {};

  // Basic validation — at least one dimension must be present
  if (!apiKeyId && !providerId && !agentId && !sessionKey) {
    res.status(400).json({ error: 'At least one of apiKeyId, providerId, agentId, or sessionKey is required' });
    return;
  }

  try {
    const entry = usageRepo.log({
      apiKeyId: apiKeyId ?? null,
      providerId: providerId ?? null,
      agentId: agentId ?? null,
      modelId: modelId ?? null,
      instanceId: instanceId ?? null,
      inputTokens: Number(inputTokens ?? 0),
      outputTokens: Number(outputTokens ?? 0),
      totalTokens: Number(totalTokens ?? 0),
      costUsd: Number(costUsd ?? 0),
      sessionKey: sessionKey ?? null,
    });
    res.status(201).json({ ok: true, id: entry.id });
  } catch (err: any) {
    console.error('[usage] Failed to log usage entry:', err.message);
    res.status(500).json({ error: 'Failed to log usage entry' });
  }
});
