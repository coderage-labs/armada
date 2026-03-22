/**
 * Prompt Performance Tracking Service (#185 Phase 4)
 * 
 * Track which prompt versions correlate with higher review scores,
 * enabling data-driven prompt improvement.
 */

import { getDb } from '../db/index.js';
import { createHash } from 'node:crypto';
import { nanoid } from 'nanoid';

/**
 * Hash a prompt template to detect changes.
 * Returns the first 16 characters of the SHA-256 hash.
 */
export function hashPrompt(promptTemplate: string): string {
  return createHash('sha256').update(promptTemplate).digest('hex').slice(0, 16);
}

/**
 * Snapshot the current prompt template as a new version.
 * Called when a workflow step's prompt changes.
 * 
 * @param workflowId - The workflow ID
 * @param stepId - The step ID
 * @param promptTemplate - The full prompt template text
 */
export function snapshotPromptVersion(
  workflowId: string,
  stepId: string,
  promptTemplate: string
): void {
  const db = getDb();
  const promptHash = hashPrompt(promptTemplate);

  // Check if this exact prompt already exists
  const existing = db
    .prepare(
      `SELECT id FROM prompt_versions 
       WHERE workflow_id = ? AND step_id = ? AND prompt_template = ?`
    )
    .get(workflowId, stepId, promptTemplate) as { id: string } | undefined;

  if (existing) {
    // Prompt hasn't changed, no need to create a new version
    return;
  }

  // Get the next version number
  const latestVersion = db
    .prepare(
      `SELECT MAX(version) as maxVer FROM prompt_versions 
       WHERE workflow_id = ? AND step_id = ?`
    )
    .get(workflowId, stepId) as { maxVer: number | null } | undefined;

  const nextVersion = (latestVersion?.maxVer ?? 0) + 1;

  // Insert new version
  db.prepare(
    `INSERT INTO prompt_versions (id, workflow_id, step_id, version, prompt_template, created_at)
     VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`
  ).run(nanoid(), workflowId, stepId, nextVersion, promptTemplate);
}

/**
 * Record which prompt version was used for a step run.
 * Called when a step is dispatched.
 * 
 * @param runId - The workflow run ID
 * @param stepId - The step ID
 * @param workflowId - The workflow ID
 * @param promptHash - Hash of the prompt template used
 */
export function recordPromptUsage(
  runId: string,
  stepId: string,
  workflowId: string,
  promptHash: string
): void {
  const db = getDb();

  // Update the step run with the prompt hash
  db.prepare(
    `UPDATE workflow_step_runs 
     SET prompt_hash = ? 
     WHERE run_id = ? AND step_id = ?`
  ).run(promptHash, runId, stepId);
}

/**
 * Performance stats for a single prompt version
 */
export interface PromptVersionPerformance {
  version: number;
  promptHash: string;
  avgScore: number;
  totalUses: number;
  totalReviews: number;
  retiredAt: string | null;
}

/**
 * Get performance stats for each prompt version of a step.
 * Correlates prompt versions with review scores.
 * 
 * @param workflowId - The workflow ID
 * @param stepId - The step ID
 * @returns Array of performance stats per version
 */
export function getPromptPerformance(
  workflowId: string,
  stepId: string
): PromptVersionPerformance[] {
  const db = getDb();

  // First, get all prompt versions for this step
  const versions = db
    .prepare(
      `SELECT version, prompt_template, retired_at 
       FROM prompt_versions 
       WHERE workflow_id = ? AND step_id = ? 
       ORDER BY version DESC`
    )
    .all(workflowId, stepId) as Array<{
    version: number;
    prompt_template: string;
    retired_at: string | null;
  }>;

  // For each version, compute the hash and get stats
  return versions.map(v => {
    const promptHash = hashPrompt(v.prompt_template);

    // Get usage and review stats for this prompt hash
    const stats = db
      .prepare(
        `SELECT 
           COUNT(DISTINCT wsr.id) as total_uses,
           COUNT(DISTINCT rr.id) as total_reviews,
           COALESCE(AVG(rr.score), 0) as avg_score
         FROM workflow_step_runs wsr
         LEFT JOIN review_records rr 
           ON rr.run_id = wsr.run_id 
           AND rr.step_id = wsr.step_id
         WHERE wsr.prompt_hash = ? 
           AND wsr.step_id = ?`
      )
      .get(promptHash, stepId) as {
      total_uses: number;
      total_reviews: number;
      avg_score: number;
    } | undefined;

    return {
      version: v.version,
      promptHash,
      avgScore: stats?.avg_score ?? 0,
      totalUses: stats?.total_uses ?? 0,
      totalReviews: stats?.total_reviews ?? 0,
      retiredAt: v.retired_at,
    };
  });
}

/**
 * Get performance stats for all steps in a workflow.
 * Returns a map of stepId -> performance stats.
 * 
 * @param workflowId - The workflow ID
 * @returns Map of step ID to performance stats
 */
export function getAllStepPromptPerformance(
  workflowId: string
): Record<string, PromptVersionPerformance[]> {
  const db = getDb();

  // Get all unique step IDs for this workflow
  const steps = db
    .prepare(
      `SELECT DISTINCT step_id FROM prompt_versions WHERE workflow_id = ?`
    )
    .all(workflowId) as Array<{ step_id: string }>;

  const result: Record<string, PromptVersionPerformance[]> = {};

  for (const step of steps) {
    result[step.step_id] = getPromptPerformance(workflowId, step.step_id);
  }

  return result;
}
