/**
 * Tests for workflow engine retry/loop mechanism (#400)
 *
 * Tests cover:
 * - retryOnFailure: step is re-dispatched after dispatch failure
 * - maxRetries: workflow step fails after exhausting retries
 * - loopUntilApproved: review step loops back when output needs revision
 * - loopUntilApproved: workflow fails when max loop iterations exceeded
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../../db/drizzle-schema.js';

// ── Minimal schema setup ─────────────────────────────────────────────

const CREATE_TABLES = `
  CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);
  CREATE TABLE IF NOT EXISTS workflows (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
    steps_json TEXT NOT NULL DEFAULT '[]', enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS workflow_runs (
    id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, project_id TEXT NOT NULL DEFAULT '',
    trigger_type TEXT NOT NULL DEFAULT 'manual', trigger_ref TEXT,
    status TEXT NOT NULL DEFAULT 'running', current_step TEXT,
    context_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')), completed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS workflow_step_runs (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL, step_id TEXT NOT NULL,
    step_index INTEGER NOT NULL DEFAULT 0, role TEXT NOT NULL DEFAULT '',
    agent_name TEXT, task_id TEXT, status TEXT NOT NULL DEFAULT 'pending',
    input_json TEXT NOT NULL DEFAULT '{}', output TEXT,
    shared_refs_json TEXT NOT NULL DEFAULT '[]',
    started_at TEXT, completed_at TEXT,
    telegram_notifications_json TEXT,
    retry_config TEXT
  );
  CREATE TABLE IF NOT EXISTS workflow_projects (
    workflow_id TEXT NOT NULL, project_id TEXT NOT NULL,
    PRIMARY KEY (workflow_id, project_id)
  );
`;

// ── Module mocking ───────────────────────────────────────────────────

let _testDb: ReturnType<typeof drizzle> | null = null;
let _sqlite: Database.Database | null = null;

vi.mock('../../db/drizzle.js', () => ({
  getDrizzle: () => {
    if (!_testDb) throw new Error('DB not initialised in test');
    return _testDb;
  },
}));

vi.mock('../webhook-dispatcher.js', () => ({ dispatchWebhook: vi.fn() }));
vi.mock('../utils/event-bus.js', () => ({ broadcast: vi.fn() }));

// ── Test setup ───────────────────────────────────────────────────────

function initTestDb(workflowId: string, steps: object[]) {
  const sqlite = new Database(':memory:');
  sqlite.exec(CREATE_TABLES);
  sqlite.prepare(`INSERT INTO workflows (id, name, steps_json) VALUES (?, ?, ?)`).run(
    workflowId, 'Test Workflow', JSON.stringify(steps)
  );
  _sqlite = sqlite;
  _testDb = drizzle(sqlite, { schema });
}

function getStepStatus(runId: string) {
  return (_sqlite!.prepare(`SELECT step_id, status, retry_config FROM workflow_step_runs WHERE run_id = ?`).all(runId) as any[]);
}

function getRunStatus(runId: string) {
  return (_sqlite!.prepare(`SELECT status FROM workflow_runs WHERE id = ?`).get(runId) as any)?.status;
}

// ── Import engine (after mocks are established) ──────────────────────

const engine = await import('../workflow-engine.js');

// ── Tests ────────────────────────────────────────────────────────────

describe('retryOnFailure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('re-dispatches step on dispatch failure when retryOnFailure is set', async () => {
    const steps = [{
      id: 'write-code',
      role: 'dev',
      prompt: 'Write code',
      retryOnFailure: true,
      maxRetries: 2,
      retryDelayMs: 0,
    }];
    initTestDb('wf-retry-1', steps);

    let callCount = 0;
    engine.setWorkflowDispatcher(async ({ taskId }) => {
      callCount++;
      if (callCount === 1) return { error: 'network timeout' };
      return { agentName: 'dev-agent', fleetTaskId: taskId };
    });

    const run = await engine.startRun({
      id: 'wf-retry-1', name: 'Test', description: '', steps, enabled: true, createdAt: new Date().toISOString()
    } as any, 'manual');

    // Should have dispatched twice (1 failure + 1 retry success)
    expect(callCount).toBe(2);

    // Step should be in 'running' state (dispatch succeeded on retry)
    const stepRows = getStepStatus(run.id);
    expect(stepRows[0]?.status).toBe('running');
  });

  it('marks step as failed after exhausting max retries', { timeout: 30000 }, async () => {
    const steps = [{
      id: 'flaky',
      role: 'dev',
      prompt: 'Do work',
      retryOnFailure: true,
      maxRetries: 2,
      retryDelayMs: 0,
    }];
    initTestDb('wf-retry-2', steps);

    engine.setWorkflowDispatcher(async () => ({ error: 'always fails' }));
    engine.setWorkflowNotifier(vi.fn());

    const run = await engine.startRun({
      id: 'wf-retry-2', name: 'Test', description: '', steps, enabled: true, createdAt: new Date().toISOString()
    } as any, 'manual');

    // Step should be failed after 3 attempts (1 initial + 2 retries)
    const stepRows = getStepStatus(run.id);
    expect(stepRows[0]?.status).toBe('failed');
  });

  it('retries when agent reports failure via onStepCompleted', async () => {
    const steps = [{
      id: 'task',
      role: 'dev',
      prompt: 'Do work',
      retryOnFailure: true,
      maxRetries: 1,
      retryDelayMs: 0,
    }];
    initTestDb('wf-retry-3', steps);

    let dispatchCount = 0;
    engine.setWorkflowDispatcher(async ({ taskId }) => {
      dispatchCount++;
      return { agentName: 'dev-agent', fleetTaskId: taskId };
    });

    const run = await engine.startRun({
      id: 'wf-retry-3', name: 'Test', description: '', steps, enabled: true, createdAt: new Date().toISOString()
    } as any, 'manual');

    const taskId = `wf-${run.id.slice(0, 8)}-task`;

    // Agent reports failure
    await engine.onStepCompleted(taskId, 'failed', 'Agent crashed');

    // Should have re-dispatched (retryCount=1 < maxRetries=1 is false... wait)
    // Actually maxRetries: 1 means 1 retry allowed. After the first failure, retryCount becomes 1
    // which equals maxRetries, so no further retry. Let me check:
    // On failure: currentState.retryCount (0) < maxRetries (1) → retry once
    // Step is reset to pending and then dispatched again → dispatchCount = 2
    expect(dispatchCount).toBe(2);
  });
});

describe('loopUntilApproved', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loops back to target step when review output indicates needs revision', async () => {
    const steps = [
      { id: 'write-code', role: 'dev', prompt: 'Write code' },
      {
        id: 'review',
        role: 'reviewer',
        prompt: 'Review code',
        waitFor: ['write-code'],
        loopUntilApproved: true,
        loopBackToStep: 'write-code',
        maxLoopIterations: 3,
      },
    ];
    initTestDb('wf-loop-1', steps);

    const dispatched: string[] = [];
    engine.setWorkflowDispatcher(async ({ stepId, taskId }) => {
      dispatched.push(stepId);
      return { agentName: `agent-${stepId}`, fleetTaskId: taskId };
    });

    const run = await engine.startRun({
      id: 'wf-loop-1', name: 'Test', description: '', steps, enabled: true, createdAt: new Date().toISOString()
    } as any, 'manual');

    const prefix = `wf-${run.id.slice(0, 8)}`;

    // write-code completes → review dispatched
    await engine.onStepCompleted(`${prefix}-write-code`, 'completed', 'Initial code');

    // review says "needs revision" → should loop back to write-code
    await engine.onStepCompleted(`${prefix}-review`, 'completed', 'This needs revision: missing error handling');

    // write-code should be dispatched again
    const writeCodeCount = dispatched.filter(s => s === 'write-code').length;
    expect(writeCodeCount).toBeGreaterThanOrEqual(2);
  });

  it('approves and continues workflow when output does not need revision', async () => {
    const steps = [
      { id: 'write-code', role: 'dev', prompt: 'Write code' },
      {
        id: 'review',
        role: 'reviewer',
        prompt: 'Review code',
        waitFor: ['write-code'],
        loopUntilApproved: true,
        loopBackToStep: 'write-code',
        maxLoopIterations: 3,
      },
    ];
    initTestDb('wf-loop-2', steps);

    engine.setWorkflowDispatcher(async ({ stepId, taskId }) => ({
      agentName: `agent-${stepId}`, fleetTaskId: taskId,
    }));
    const notifyFn = vi.fn();
    engine.setWorkflowNotifier(notifyFn);

    const run = await engine.startRun({
      id: 'wf-loop-2', name: 'Test', description: '', steps, enabled: true, createdAt: new Date().toISOString()
    } as any, 'manual');

    const prefix = `wf-${run.id.slice(0, 8)}`;

    await engine.onStepCompleted(`${prefix}-write-code`, 'completed', 'Perfect code');
    // review approves (no "needs revision" language)
    await engine.onStepCompleted(`${prefix}-review`, 'completed', 'LGTM — approved!');

    // Workflow should complete normally
    expect(notifyFn).toHaveBeenCalledWith(expect.objectContaining({ type: 'completed' }));
  });

  it('fails workflow when max loop iterations are exceeded', async () => {
    // maxLoopIterations: 2 means allow 1 loop (iteration 1 loops, iteration 2 fails)
    const steps = [
      { id: 'code', role: 'dev', prompt: 'Write code' },
      {
        id: 'review',
        role: 'reviewer',
        prompt: 'Review',
        waitFor: ['code'],
        loopUntilApproved: true,
        loopBackToStep: 'code',
        maxLoopIterations: 2,
      },
    ];
    initTestDb('wf-loop-3', steps);

    engine.setWorkflowDispatcher(async ({ stepId, taskId }) => ({
      agentName: `agent-${stepId}`, fleetTaskId: taskId,
    }));
    const notifyFn = vi.fn();
    engine.setWorkflowNotifier(notifyFn);

    const run = await engine.startRun({
      id: 'wf-loop-3', name: 'Test', description: '', steps, enabled: true, createdAt: new Date().toISOString()
    } as any, 'manual');

    const prefix = `wf-${run.id.slice(0, 8)}`;

    // First pass: code completes, review needs revision → loop 1 (loopIteration=1, 1 < 2 → loops back)
    await engine.onStepCompleted(`${prefix}-code`, 'completed', 'code v1');
    await engine.onStepCompleted(`${prefix}-review`, 'completed', 'needs revision: add tests');

    // Second pass: code completes, review needs revision again → loop 2 (loopIteration=2, 2 >= 2 → FAIL)
    await engine.onStepCompleted(`${prefix}-code`, 'completed', 'code v2');
    await engine.onStepCompleted(`${prefix}-review`, 'completed', 'still needs revision');

    // Workflow should be failed
    expect(notifyFn).toHaveBeenCalledWith(expect.objectContaining({ type: 'failed' }));
  });

  it('detects various "needs revision" output patterns', async () => {
    // Test the detection patterns by running a review step and checking if loop-back occurs
    const revisionPhrases = [
      'needs revision',
      'NEEDS_REVISION',
      'not approved',
      '"approved": false',
      '"approved":false',
      'changes required',
    ];

    for (const phrase of revisionPhrases) {
      const wfId = `wf-det-${phrase.slice(0, 5).replace(/[^a-z0-9]/gi, 'x')}`;
      const steps = [
        { id: 'code', role: 'dev', prompt: 'Code' },
        {
          id: 'review',
          role: 'reviewer',
          prompt: 'Review',
          waitFor: ['code'],
          loopUntilApproved: true,
          loopBackToStep: 'code',
          maxLoopIterations: 3,
        },
      ];
      initTestDb(wfId, steps);

      const dispatched: string[] = [];
      engine.setWorkflowDispatcher(async ({ stepId, taskId }) => {
        dispatched.push(stepId);
        return { agentName: `a`, fleetTaskId: taskId };
      });

      const run = await engine.startRun({
        id: wfId, name: 'det', description: '', steps, enabled: true, createdAt: new Date().toISOString()
      } as any, 'manual');

      const prefix = `wf-${run.id.slice(0, 8)}`;
      await engine.onStepCompleted(`${prefix}-code`, 'completed', 'code');
      await engine.onStepCompleted(`${prefix}-review`, 'completed', `Output: ${phrase} please fix`);

      // If detection worked, code should be dispatched again
      expect(dispatched.filter(s => s === 'code').length).toBeGreaterThanOrEqual(2);
    }
  });
});
