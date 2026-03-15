/**
 * Tests for inter-agent collaboration — workflow context + dynamic rework (#592)
 *
 * Tests cover:
 * - requestRework() validation (run must be running, target must be completed, etc.)
 * - requestRework() pauses requesting step and resets target
 * - requestRework() injects feedback into context
 * - requestRework() respects max rework iterations
 * - resolveTemplate() supports fallback syntax
 * - buildWorkflowContextBlock() includes completed steps
 * - buildWorkflowContextBlock() includes rework feedback when present
 * - Rework resolution resets waiting steps to pending
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
vi.mock('../../utils/event-bus.js', () => ({ broadcast: vi.fn(), subscribe: vi.fn() }));

// ── Test setup ───────────────────────────────────────────────────────

function initTestDb(workflowId: string, steps: object[], name = 'Test Workflow') {
  const sqlite = new Database(':memory:');
  sqlite.exec(CREATE_TABLES);
  sqlite.prepare(`INSERT INTO workflows (id, name, steps_json) VALUES (?, ?, ?)`).run(
    workflowId, name, JSON.stringify(steps),
  );
  _sqlite = sqlite;
  _testDb = drizzle(sqlite, { schema });
}

function getStepStatus(runId: string) {
  return (_sqlite!.prepare(`SELECT step_id, status, output, agent_name, task_id FROM workflow_step_runs WHERE run_id = ?`).all(runId) as any[]);
}

function getRunContext(runId: string): any {
  const row = _sqlite!.prepare(`SELECT context_json FROM workflow_runs WHERE id = ?`).get(runId) as any;
  return JSON.parse(row?.context_json || '{}');
}

// ── Import engine (after mocks are established) ──────────────────────

const engine = await import('../workflow-engine.js');

// ── Helpers to set up runs in specific states ─────────────────────────

/** Build a two-step workflow: design_api → implement_frontend */
function makeColabSteps() {
  return [
    { id: 'design_api', role: 'architecture', prompt: 'Design the API schema' },
    {
      id: 'implement_frontend',
      role: 'development',
      prompt: 'Implement frontend using {{steps.design_api.output}}',
      waitFor: ['design_api'],
    },
  ];
}

async function startRunAndComplete(
  wfId: string,
  steps: object[],
  completeSteps: Array<{ stepId: string; output: string }>,
  wfName = 'Test Workflow',
): Promise<{ run: any; prefix: string }> {
  initTestDb(wfId, steps, wfName);

  engine.setWorkflowDispatcher(async ({ stepId, taskId }) => ({
    agentName: `agent-${stepId}`,
    armadaTaskId: taskId,
  }));

  const run = await engine.startRun(
    { id: wfId, name: 'Test', description: '', steps, enabled: true, createdAt: new Date().toISOString() } as any,
    'manual',
  );

  const prefix = `wf-${run.id.slice(0, 8)}`;

  for (const { stepId, output } of completeSteps) {
    await engine.onStepCompleted(`${prefix}-${stepId}`, 'completed', output);
  }

  return { run, prefix };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('requestRework() validates — run must be running', () => {
  it('throws if run does not exist', async () => {
    initTestDb('wf-rw-val-1', makeColabSteps());
    await expect(engine.requestRework('nonexistent', 'implement_frontend', 'design_api', 'Fix it')).rejects.toThrow('not found');
  });

  it('throws if run is not running', async () => {
    const steps = makeColabSteps();
    initTestDb('wf-rw-val-2', steps);
    engine.setWorkflowDispatcher(async ({ taskId }) => ({ agentName: 'a', armadaTaskId: taskId }));
    const run = await engine.startRun(
      { id: 'wf-rw-val-2', name: 'T', description: '', steps, enabled: true, createdAt: new Date().toISOString() } as any,
      'manual',
    );
    // Cancel the run to change status
    engine.cancelRun(run.id);
    await expect(engine.requestRework(run.id, 'implement_frontend', 'design_api', 'Fix it')).rejects.toThrow('not running');
  });
});

describe('requestRework() validates — target must be completed', () => {
  it('throws if target step is not completed', async () => {
    const steps = makeColabSteps();
    // design_api won't be completed yet (implement_frontend is waiting for it)
    const { run } = await startRunAndComplete('wf-rw-val-3', steps, []);
    // design_api is still pending/running — implement_frontend hasn't started
    await expect(engine.requestRework(run.id, 'design_api', 'implement_frontend', 'Fix it')).rejects.toThrow();
  });

  it('succeeds when target step is completed', async () => {
    const steps = makeColabSteps();
    const { run } = await startRunAndComplete('wf-rw-val-4', steps, [
      { stepId: 'design_api', output: 'POST /tasks' },
    ]);
    // implement_frontend is now running, design_api is completed
    // requestRework should succeed without throwing
    await expect(engine.requestRework(run.id, 'implement_frontend', 'design_api', 'Need bulk ops')).resolves.not.toThrow();
  });
});

describe('requestRework() validates — can\'t target own step', () => {
  it('throws if requestingStepId === targetStepId', async () => {
    const steps = makeColabSteps();
    const { run } = await startRunAndComplete('wf-rw-val-5', steps, [
      { stepId: 'design_api', output: 'API schema' },
    ]);
    await expect(engine.requestRework(run.id, 'implement_frontend', 'implement_frontend', 'Self-rework')).rejects.toThrow('own step');
  });
});

describe('requestRework() pauses requesting step and resets target', () => {
  it('sets requesting step to waiting_for_rework and re-dispatches target', async () => {
    const steps = makeColabSteps();
    const { run } = await startRunAndComplete('wf-rw-pause-1', steps, [
      { stepId: 'design_api', output: 'Original schema' },
    ]);

    await engine.requestRework(run.id, 'implement_frontend', 'design_api', 'Need bulk ops');

    const statuses = getStepStatus(run.id);
    const designApi = statuses.find((s: any) => s.step_id === 'design_api');
    const frontend = statuses.find((s: any) => s.step_id === 'implement_frontend');

    // design_api was reset then immediately re-dispatched by advanceRun → 'running'
    expect(designApi?.status).toBe('running');
    expect(frontend?.status).toBe('waiting_for_rework');
  });

  it('clears output of reset step (task_id is re-assigned on re-dispatch)', async () => {
    const steps = makeColabSteps();
    const { run } = await startRunAndComplete('wf-rw-pause-2', steps, [
      { stepId: 'design_api', output: 'Original schema' },
    ]);

    await engine.requestRework(run.id, 'implement_frontend', 'design_api', 'Fix it');

    const statuses = getStepStatus(run.id);
    const designApi = statuses.find((s: any) => s.step_id === 'design_api');
    // Output is cleared when step is reset (and not set again until step completes)
    expect(designApi?.output).toBeNull();
    // task_id is re-assigned when the step is re-dispatched
    expect(designApi?.task_id).toBeTruthy();
    expect(designApi?.task_id).toMatch(/^wf-/);
  });
});

describe('requestRework() injects feedback into context', () => {
  it('stores rework entry in context.reworks', async () => {
    const steps = makeColabSteps();
    const { run } = await startRunAndComplete('wf-rw-ctx-1', steps, [
      { stepId: 'design_api', output: 'POST /tasks' },
    ]);

    await engine.requestRework(run.id, 'implement_frontend', 'design_api', 'Need POST /api/tasks/bulk');

    const ctx = getRunContext(run.id);
    expect(ctx.reworks).toBeDefined();
    expect(ctx.reworks).toHaveLength(1);
    expect(ctx.reworks[0].targetStepId).toBe('design_api');
    expect(ctx.reworks[0].feedback).toBe('Need POST /api/tasks/bulk');
    expect(ctx.reworks[0].requestedBy.stepId).toBe('implement_frontend');
    expect(ctx.reworks[0].resolvedAt).toBeNull();
  });

  it('stores rework feedback and previous output in context', async () => {
    const steps = makeColabSteps();
    const { run } = await startRunAndComplete('wf-rw-ctx-2', steps, [
      { stepId: 'design_api', output: 'POST /tasks' },
    ]);

    await engine.requestRework(run.id, 'implement_frontend', 'design_api', 'Add bulk endpoint');

    const ctx = getRunContext(run.id);
    expect(ctx['design_api_reworkFeedback']).toBe('Add bulk endpoint');
    expect(ctx['design_api_previousOutput']).toBe('POST /tasks');
  });
});

describe('requestRework() respects max rework iterations', () => {
  it('throws when max iterations reached (default 3)', async () => {
    const steps = makeColabSteps();
    const { run } = await startRunAndComplete('wf-rw-max-1', steps, [
      { stepId: 'design_api', output: 'v1' },
    ]);

    // First rework
    await engine.requestRework(run.id, 'implement_frontend', 'design_api', 'Fix 1');

    // Re-complete design_api to allow implement_frontend to run again
    const prefix = `wf-${run.id.slice(0, 8)}`;
    await engine.onStepCompleted(`${prefix}-design_api`, 'completed', 'v2');

    // Second rework — implement_frontend is running again after rework
    await engine.requestRework(run.id, 'implement_frontend', 'design_api', 'Fix 2');
    await engine.onStepCompleted(`${prefix}-design_api`, 'completed', 'v3');

    // Third rework
    await engine.requestRework(run.id, 'implement_frontend', 'design_api', 'Fix 3');
    await engine.onStepCompleted(`${prefix}-design_api`, 'completed', 'v4');

    // Fourth attempt — should exceed limit (max 3)
    await expect(engine.requestRework(run.id, 'implement_frontend', 'design_api', 'Fix 4')).rejects.toThrow('maximum rework iterations');
  });
});

describe('resolveTemplate() supports fallback syntax', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses fallback when path is undefined', async () => {
    const steps = [{
      id: 'step1',
      role: 'dev',
      prompt: 'Use {{steps.missing_step.output|no output yet}}',
    }];
    initTestDb('wf-tmpl-1', steps);

    const dispatched: Array<{ message: string }> = [];
    engine.setWorkflowDispatcher(async ({ message, taskId }) => {
      dispatched.push({ message });
      return { agentName: 'agent', armadaTaskId: taskId };
    });

    await engine.startRun(
      { id: 'wf-tmpl-1', name: 'T', description: '', steps, enabled: true, createdAt: new Date().toISOString() } as any,
      'manual',
    );

    // The prompt should have 'no output yet' where the missing step was
    expect(dispatched[0].message).toContain('no output yet');
  });

  it('uses empty string fallback when just | with no default', async () => {
    const steps = [{
      id: 'step1',
      role: 'dev',
      prompt: 'Context: {{steps.missing.output|}}',
    }];
    initTestDb('wf-tmpl-2', steps);

    const dispatched: Array<{ message: string }> = [];
    engine.setWorkflowDispatcher(async ({ message, taskId }) => {
      dispatched.push({ message });
      return { agentName: 'agent', armadaTaskId: taskId };
    });

    await engine.startRun(
      { id: 'wf-tmpl-2', name: 'T', description: '', steps, enabled: true, createdAt: new Date().toISOString() } as any,
      'manual',
    );

    // Should replace with empty string (not leave {{...}})
    expect(dispatched[0].message).not.toContain('{{');
    expect(dispatched[0].message).toContain('Context: ');
  });

  it('leaves template unresolved when no fallback and path missing', async () => {
    const steps = [{
      id: 'step1',
      role: 'dev',
      prompt: 'Use {{steps.missing.output}}',
    }];
    initTestDb('wf-tmpl-3', steps);

    const dispatched: Array<{ message: string }> = [];
    engine.setWorkflowDispatcher(async ({ message, taskId }) => {
      dispatched.push({ message });
      return { agentName: 'agent', armadaTaskId: taskId };
    });

    await engine.startRun(
      { id: 'wf-tmpl-3', name: 'T', description: '', steps, enabled: true, createdAt: new Date().toISOString() } as any,
      'manual',
    );

    // Should leave template as-is
    expect(dispatched[0].message).toContain('{{steps.missing.output}}');
  });

  it('resolves normally when path exists', async () => {
    const steps = [
      { id: 'step1', role: 'dev', prompt: 'Write code' },
      { id: 'step2', role: 'dev', prompt: 'Review {{steps.step1.output|fallback}}', waitFor: ['step1'] },
    ];
    initTestDb('wf-tmpl-4', steps);

    const dispatched: Array<{ stepId: string; message: string }> = [];
    engine.setWorkflowDispatcher(async ({ stepId, message, taskId }) => {
      dispatched.push({ stepId, message });
      return { agentName: 'agent', armadaTaskId: taskId };
    });

    const run = await engine.startRun(
      { id: 'wf-tmpl-4', name: 'T', description: '', steps, enabled: true, createdAt: new Date().toISOString() } as any,
      'manual',
    );

    const prefix = `wf-${run.id.slice(0, 8)}`;
    await engine.onStepCompleted(`${prefix}-step1`, 'completed', 'My code output');

    const step2Dispatch = dispatched.find(d => d.stepId === 'step2');
    expect(step2Dispatch?.message).toContain('My code output');
    expect(step2Dispatch?.message).not.toContain('fallback');
  });
});

describe('buildWorkflowContextBlock() includes completed steps', () => {
  it('includes step outputs from context in the dispatched prompt', async () => {
    const steps = [
      { id: 'research', role: 'scout', prompt: 'Do research' },
      { id: 'implement', role: 'development', prompt: 'Implement based on research', waitFor: ['research'] },
    ];
    initTestDb('wf-ctx-block-1', steps, 'Build Tasks Module');

    const dispatched: Array<{ stepId: string; message: string }> = [];
    engine.setWorkflowDispatcher(async ({ stepId, message, taskId }) => {
      dispatched.push({ stepId, message });
      return { agentName: `agent-${stepId}`, armadaTaskId: taskId };
    });

    const run = await engine.startRun(
      { id: 'wf-ctx-block-1', name: 'Build Tasks Module', description: '', steps, enabled: true, createdAt: new Date().toISOString() } as any,
      'manual',
    );

    const prefix = `wf-${run.id.slice(0, 8)}`;
    await engine.onStepCompleted(`${prefix}-research`, 'completed', 'Requirements: tasks need CRUD');

    const implementDispatch = dispatched.find(d => d.stepId === 'implement');
    expect(implementDispatch?.message).toContain('[WORKFLOW CONTEXT]');
    expect(implementDispatch?.message).toContain('Build Tasks Module');
    expect(implementDispatch?.message).toContain('Completed steps:');
    expect(implementDispatch?.message).toContain('Requirements: tasks need CRUD');
    expect(implementDispatch?.message).toContain('[END WORKFLOW CONTEXT]');
  });

  it('includes workflow name and step role in context block', async () => {
    const steps = [
      { id: 'design', role: 'architect', prompt: 'Design schema' },
      { id: 'code', role: 'developer', prompt: 'Write code', waitFor: ['design'] },
    ];
    initTestDb('wf-ctx-block-2', steps, 'My Workflow');

    const dispatched: Array<{ stepId: string; message: string }> = [];
    engine.setWorkflowDispatcher(async ({ stepId, message, taskId }) => {
      dispatched.push({ stepId, message });
      return { agentName: `a`, armadaTaskId: taskId };
    });

    const run = await engine.startRun(
      { id: 'wf-ctx-block-2', name: 'My Workflow', description: '', steps, enabled: true, createdAt: new Date().toISOString() } as any,
      'manual',
    );
    const prefix = `wf-${run.id.slice(0, 8)}`;
    await engine.onStepCompleted(`${prefix}-design`, 'completed', 'Schema: ...');

    const codeDispatch = dispatched.find(d => d.stepId === 'code');
    expect(codeDispatch?.message).toContain('My Workflow');
    expect(codeDispatch?.message).toContain('developer');
  });
});

describe('buildWorkflowContextBlock() includes rework feedback when present', () => {
  it('includes rework feedback section in prompt when step is being reworked', async () => {
    const steps = makeColabSteps();
    const { run } = await startRunAndComplete('wf-ctx-rw-1', steps, [
      { stepId: 'design_api', output: 'POST /tasks' },
    ]);

    // Now implement_frontend is running — request rework
    const dispatchedMessages: string[] = [];
    engine.setWorkflowDispatcher(async ({ message, taskId }) => {
      dispatchedMessages.push(message);
      return { agentName: 'agent', armadaTaskId: taskId };
    });

    await engine.requestRework(run.id, 'implement_frontend', 'design_api', 'Need bulk operations endpoint');

    // design_api should be re-dispatched — check the message contains rework feedback
    const lastMessage = dispatchedMessages[dispatchedMessages.length - 1];
    expect(lastMessage).toContain('[REWORK FEEDBACK]');
    expect(lastMessage).toContain('Need bulk operations endpoint');
    expect(lastMessage).toContain('[END REWORK FEEDBACK]');
  });

  it('includes previous output in rework feedback', async () => {
    const steps = makeColabSteps();
    const { run } = await startRunAndComplete('wf-ctx-rw-2', steps, [
      { stepId: 'design_api', output: 'Original API schema: GET /tasks' },
    ]);

    const dispatchedMessages: string[] = [];
    engine.setWorkflowDispatcher(async ({ message, taskId }) => {
      dispatchedMessages.push(message);
      return { agentName: 'agent', armadaTaskId: taskId };
    });

    await engine.requestRework(run.id, 'implement_frontend', 'design_api', 'Add POST /tasks/bulk');

    const lastMessage = dispatchedMessages[dispatchedMessages.length - 1];
    expect(lastMessage).toContain('Original API schema: GET /tasks');
    expect(lastMessage).toContain('previous output');
  });
});

describe('Rework resolution resets waiting steps to pending', () => {
  it('marks waiting_for_rework step as pending (then running) when reworked step completes', async () => {
    const steps = makeColabSteps();
    const { run, prefix } = await startRunAndComplete('wf-rw-res-1', steps, [
      { stepId: 'design_api', output: 'POST /tasks' },
    ]);

    // implement_frontend is running, request rework on design_api
    await engine.requestRework(run.id, 'implement_frontend', 'design_api', 'Need bulk ops');

    // design_api is now pending and should be dispatched; complete it with new output
    await engine.onStepCompleted(`${prefix}-design_api`, 'completed', 'POST /tasks + POST /tasks/bulk');

    // implement_frontend should have been unblocked — advanceRun will re-dispatch it so it's 'running'
    // The key invariant: it's no longer 'waiting_for_rework'
    const statuses = getStepStatus(run.id);
    const frontend = statuses.find((s: any) => s.step_id === 'implement_frontend');
    expect(frontend?.status).not.toBe('waiting_for_rework');
    expect(['pending', 'running']).toContain(frontend?.status);
  });

  it('marks rework as resolved (resolvedAt set) after target step completes', async () => {
    const steps = makeColabSteps();
    const { run, prefix } = await startRunAndComplete('wf-rw-res-2', steps, [
      { stepId: 'design_api', output: 'v1' },
    ]);

    await engine.requestRework(run.id, 'implement_frontend', 'design_api', 'Needs more detail');
    await engine.onStepCompleted(`${prefix}-design_api`, 'completed', 'v2 detailed');

    const ctx = getRunContext(run.id);
    expect(ctx.reworks[0].resolvedAt).not.toBeNull();
    expect(typeof ctx.reworks[0].resolvedAt).toBe('string');
  });

  it('cleans up rework context keys after resolution', async () => {
    const steps = makeColabSteps();
    const { run, prefix } = await startRunAndComplete('wf-rw-res-3', steps, [
      { stepId: 'design_api', output: 'original' },
    ]);

    await engine.requestRework(run.id, 'implement_frontend', 'design_api', 'Fix feedback');
    await engine.onStepCompleted(`${prefix}-design_api`, 'completed', 'revised');

    const ctx = getRunContext(run.id);
    expect(ctx['design_api_reworkFeedback']).toBeUndefined();
    expect(ctx['design_api_previousOutput']).toBeUndefined();
  });
});
