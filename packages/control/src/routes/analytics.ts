/**
 * Analytics API routes — workflow metrics and agent performance.
 * Phase 3 of #185 (learning system).
 */

import { Router } from 'express';
import { requireScope } from '../middleware/scopes.js';
import { registerToolDef } from '../utils/tool-registry.js';
import {
  getWorkflowStats,
  getAgentStats,
  getRecentRuns,
} from '../services/workflow-metrics.js';

export const analyticsRouter = Router();

// ── Tool definitions ────────────────────────────────────────────────

const ANALYTICS_TOOLS = [
  {
    category: 'analytics',
    scope: 'workflows:read',
    name: 'armada_workflow_stats',
    description: 'Get overall workflow statistics including runs, completion rates, and timing.',
    method: 'GET',
    path: '/api/analytics/workflows',
    parameters: [],
  },
  {
    category: 'analytics',
    scope: 'workflows:read',
    name: 'armada_workflow_stats_by_id',
    description: 'Get statistics for a specific workflow by ID.',
    method: 'GET',
    path: '/api/analytics/workflows/:id',
    parameters: [
      { name: 'id', type: 'string', description: 'Workflow ID', required: true },
    ],
  },
  {
    category: 'analytics',
    scope: 'workflows:read',
    name: 'armada_agent_stats',
    description: 'Get agent performance statistics including task completion and review scores.',
    method: 'GET',
    path: '/api/analytics/agents',
    parameters: [],
  },
  {
    category: 'analytics',
    scope: 'workflows:read',
    name: 'armada_agent_stats_by_name',
    description: 'Get statistics for a specific agent by name.',
    method: 'GET',
    path: '/api/analytics/agents/:name',
    parameters: [
      { name: 'name', type: 'string', description: 'Agent name', required: true },
    ],
  },
  {
    category: 'analytics',
    scope: 'workflows:read',
    name: 'armada_recent_runs',
    description: 'Get recent workflow run history with timing and step details.',
    method: 'GET',
    path: '/api/analytics/runs/recent',
    parameters: [
      { name: 'limit', type: 'number', description: 'Number of runs to return (default 20)' },
    ],
  },
] as const;

for (const tool of ANALYTICS_TOOLS) {
  registerToolDef(tool as any);
}

// ── Routes ──────────────────────────────────────────────────────────

// GET /api/analytics/workflows — overall workflow stats
analyticsRouter.get('/workflows', requireScope('workflows:read'), (_req, res) => {
  try {
    const stats = getWorkflowStats();
    res.json(stats);
  } catch (error: any) {
    console.error('Error fetching workflow stats:', error);
    res.status(500).json({ error: error.message || 'Failed to fetch workflow stats' });
  }
});

// GET /api/analytics/workflows/:id — stats for a specific workflow
analyticsRouter.get('/workflows/:id', requireScope('workflows:read'), (req, res) => {
  try {
    const { id } = req.params;
    const stats = getWorkflowStats(id);

    if (stats.length === 0) {
      return res.status(404).json({ error: 'Workflow not found or has no runs' });
    }

    res.json(stats[0]);
  } catch (error: any) {
    console.error('Error fetching workflow stats:', error);
    res.status(500).json({ error: error.message || 'Failed to fetch workflow stats' });
  }
});

// GET /api/analytics/agents — agent performance stats
analyticsRouter.get('/agents', requireScope('workflows:read'), (_req, res) => {
  try {
    const stats = getAgentStats();
    res.json(stats);
  } catch (error: any) {
    console.error('Error fetching agent stats:', error);
    res.status(500).json({ error: error.message || 'Failed to fetch agent stats' });
  }
});

// GET /api/analytics/agents/:name — stats for a specific agent
analyticsRouter.get('/agents/:name', requireScope('workflows:read'), (req, res) => {
  try {
    const { name } = req.params;
    const stats = getAgentStats(name);

    if (stats.length === 0) {
      return res.status(404).json({ error: 'Agent not found or has no task history' });
    }

    res.json(stats[0]);
  } catch (error: any) {
    console.error('Error fetching agent stats:', error);
    res.status(500).json({ error: error.message || 'Failed to fetch agent stats' });
  }
});

// GET /api/analytics/runs/recent — recent run history with timing
analyticsRouter.get('/runs/recent', requireScope('workflows:read'), (req, res) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 20;
    const runs = getRecentRuns(limit);
    res.json(runs);
  } catch (error: any) {
    console.error('Error fetching recent runs:', error);
    res.status(500).json({ error: error.message || 'Failed to fetch recent runs' });
  }
});
