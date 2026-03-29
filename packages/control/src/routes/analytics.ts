/**
 * Analytics API routes — workflow metrics and agent performance.
 * Phase 3 of #185 (learning system).
 * Cost tracking added in #242.
 */

import { Router } from 'express';
import { requireScope } from '../middleware/scopes.js';
import { registerToolDef } from '../utils/tool-registry.js';
import {
  getWorkflowStats,
  getAgentStats,
  getRecentRuns,
} from '../services/workflow-metrics.js';
import {
  getPromptPerformance,
  getAllStepPromptPerformance,
} from '../services/prompt-performance.js';
import { getDrizzle } from '../db/drizzle.js';
import { workflowRunCosts } from '../db/drizzle-schema.js';
import { eq, sql } from 'drizzle-orm';

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
  {
    category: 'analytics',
    scope: 'workflows:read',
    name: 'armada_prompt_performance',
    description: 'Get prompt version performance for all steps in a workflow. Shows which prompt versions correlate with higher review scores.',
    method: 'GET',
    path: '/api/analytics/prompts/:workflowId',
    parameters: [
      { name: 'workflowId', type: 'string', description: 'Workflow ID', required: true },
    ],
  },
  {
    category: 'analytics',
    scope: 'workflows:read',
    name: 'armada_prompt_performance_step',
    description: 'Get detailed prompt version performance for a specific workflow step.',
    method: 'GET',
    path: '/api/analytics/prompts/:workflowId/:stepId',
    parameters: [
      { name: 'workflowId', type: 'string', description: 'Workflow ID', required: true },
      { name: 'stepId', type: 'string', description: 'Step ID', required: true },
    ],
  },
  {
    category: 'analytics',
    scope: 'workflows:read',
    name: 'armada_workflow_costs',
    description: 'Get token usage and cost summary for all workflow runs, grouped by workflow or agent.',
    method: 'GET',
    path: '/api/analytics/costs',
    parameters: [],
  },
  {
    category: 'analytics',
    scope: 'workflows:read',
    name: 'armada_workflow_run_costs',
    description: 'Get detailed cost breakdown for a specific workflow run, showing per-step token usage and estimated costs.',
    method: 'GET',
    path: '/api/analytics/costs/:runId',
    parameters: [
      { name: 'runId', type: 'string', description: 'Workflow run ID', required: true },
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

// GET /api/analytics/prompts/:workflowId — prompt version performance for all steps
analyticsRouter.get('/prompts/:workflowId', requireScope('workflows:read'), (req, res) => {
  try {
    const { workflowId } = req.params;
    const stats = getAllStepPromptPerformance(workflowId);
    res.json(stats);
  } catch (error: any) {
    console.error('Error fetching prompt performance:', error);
    res.status(500).json({ error: error.message || 'Failed to fetch prompt performance' });
  }
});

// GET /api/analytics/prompts/:workflowId/:stepId — detailed performance for a specific step
analyticsRouter.get('/prompts/:workflowId/:stepId', requireScope('workflows:read'), (req, res) => {
  try {
    const { workflowId, stepId } = req.params;
    const stats = getPromptPerformance(workflowId, stepId);
    res.json(stats);
  } catch (error: any) {
    console.error('Error fetching step prompt performance:', error);
    res.status(500).json({ error: error.message || 'Failed to fetch step prompt performance' });
  }
});

// ── Cost tracking routes (#242) ─────────────────────────────────────

// GET /api/analytics/costs — total costs, per-workflow, per-agent
analyticsRouter.get('/costs', requireScope('workflows:read'), (_req, res) => {
  try {
    const db = getDrizzle();

    // Total cost across all runs
    const totalRow = db.get(sql`
      SELECT 
        SUM(input_tokens) as total_input_tokens,
        SUM(output_tokens) as total_output_tokens,
        SUM(total_tokens) as total_tokens,
        SUM(estimated_cost_usd) as total_cost_usd,
        COUNT(DISTINCT run_id) as run_count
      FROM workflow_run_costs
    `) as any;

    // Cost per workflow (via run_id → workflow_runs → workflow_id)
    const perWorkflow = db.all(sql`
      SELECT 
        w.name as workflow_name,
        w.id as workflow_id,
        COUNT(DISTINCT wrc.run_id) as run_count,
        SUM(wrc.input_tokens) as total_input_tokens,
        SUM(wrc.output_tokens) as total_output_tokens,
        SUM(wrc.total_tokens) as total_tokens,
        SUM(wrc.estimated_cost_usd) as total_cost_usd,
        AVG(wrc.estimated_cost_usd) as avg_cost_per_step
      FROM workflow_run_costs wrc
      JOIN workflow_runs wr ON wr.id = wrc.run_id
      JOIN workflows w ON w.id = wr.workflow_id
      GROUP BY w.id, w.name
      ORDER BY total_cost_usd DESC
    `) as any[];

    // Cost per agent
    const perAgent = db.all(sql`
      SELECT 
        agent_name,
        COUNT(*) as step_count,
        SUM(input_tokens) as total_input_tokens,
        SUM(output_tokens) as total_output_tokens,
        SUM(total_tokens) as total_tokens,
        SUM(estimated_cost_usd) as total_cost_usd,
        AVG(estimated_cost_usd) as avg_cost_per_step
      FROM workflow_run_costs
      WHERE agent_name IS NOT NULL
      GROUP BY agent_name
      ORDER BY total_cost_usd DESC
    `) as any[];

    res.json({
      total: {
        inputTokens: totalRow?.total_input_tokens ?? 0,
        outputTokens: totalRow?.total_output_tokens ?? 0,
        totalTokens: totalRow?.total_tokens ?? 0,
        totalCostUsd: totalRow?.total_cost_usd ?? 0,
        runCount: totalRow?.run_count ?? 0,
      },
      byWorkflow: perWorkflow,
      byAgent: perAgent,
    });
  } catch (error: any) {
    console.error('Error fetching workflow costs:', error);
    res.status(500).json({ error: error.message || 'Failed to fetch workflow costs' });
  }
});

// GET /api/analytics/costs/:runId — cost breakdown for a specific run
analyticsRouter.get('/costs/:runId', requireScope('workflows:read'), (req, res) => {
  try {
    const { runId } = req.params;
    const db = getDrizzle();

    // Get all cost entries for this run
    const costs = db.select().from(workflowRunCosts).where(eq(workflowRunCosts.runId, runId)).all();

    if (costs.length === 0) {
      return res.status(404).json({ error: 'No cost data found for this run' });
    }

    // Calculate total
    const total = costs.reduce(
      (acc, c) => ({
        inputTokens: acc.inputTokens + (c.inputTokens ?? 0),
        outputTokens: acc.outputTokens + (c.outputTokens ?? 0),
        totalTokens: acc.totalTokens + (c.totalTokens ?? 0),
        totalCostUsd: acc.totalCostUsd + (c.estimatedCostUsd ?? 0),
      }),
      { inputTokens: 0, outputTokens: 0, totalTokens: 0, totalCostUsd: 0 },
    );

    res.json({
      runId,
      total,
      steps: costs.map(c => ({
        stepId: c.stepId,
        agentName: c.agentName,
        inputTokens: c.inputTokens,
        outputTokens: c.outputTokens,
        totalTokens: c.totalTokens,
        model: c.model,
        estimatedCostUsd: c.estimatedCostUsd,
        createdAt: c.createdAt,
      })),
    });
  } catch (error: any) {
    console.error('Error fetching run costs:', error);
    res.status(500).json({ error: error.message || 'Failed to fetch run costs' });
  }
});
