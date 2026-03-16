import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getDrizzle } from '../../db/drizzle.js';
import * as engine from '../workflow-engine.js';
import { sql } from 'drizzle-orm';

describe('Workflow Dispatch', () => {
  beforeEach(() => {
    const db = getDrizzle();
    db.run(sql`DELETE FROM workflow_runs`);
    db.run(sql`DELETE FROM workflow_step_runs`);
    db.run(sql`DELETE FROM workflows`);
  });

  it('should call node relay when dispatching a step', async () => {
    const dispatchFn = vi.fn().mockResolvedValue({ agentName: 'test-agent', armadaTaskId: 'test-task' });
    
    engine.setWorkflowDispatcher(dispatchFn);

    const steps = [{
      id: 'step1',
      role: 'development',
      prompt: 'Test prompt',
    }];

    // Create workflow in DB first
    const db = getDrizzle();
    const workflow = engine.createWorkflow('wf-dispatch-test', {
      name: 'Test Dispatch',
      description: '',
      steps,
    });

    const run = await engine.startRun(workflow as any, 'manual');

    // Wait a bit for async dispatch
    await new Promise(resolve => setTimeout(resolve, 100));

    // Verify the dispatch function was called
    expect(dispatchFn).toHaveBeenCalled();
    const callArgs = dispatchFn.mock.calls[0][0];
    
    // Verify it was called with correct parameters
    expect(callArgs).toMatchObject({
      role: 'development',
      message: expect.stringContaining('Test prompt'),
      projectId: expect.any(String),
      runId: run.id,
      stepId: 'step1',
      taskId: expect.stringMatching(/^wf-/),
    });

    console.log('[test] Dispatch was called with:', callArgs);
  });

  it('should handle dispatch errors gracefully', async () => {
    const dispatchFn = vi.fn().mockResolvedValue({ error: 'No agent available' });
    
    engine.setWorkflowDispatcher(dispatchFn);

    const steps = [{
      id: 'step1',
      role: 'development',
      prompt: 'Test prompt',
    }];

    const workflow = engine.createWorkflow('wf-dispatch-error', {
      name: 'Test Dispatch Error',
      description: '',
      steps,
    });

    await engine.startRun(workflow as any, 'manual');

    // Wait a bit for async dispatch
    await new Promise(resolve => setTimeout(resolve, 100));

    // Verify dispatch was called
    expect(dispatchFn).toHaveBeenCalled();

    // Check that step is marked as failed
    const db = getDrizzle();
    const stepRuns = db.all(sql`SELECT * FROM workflow_step_runs WHERE step_id = 'step1'`);
    
    // Should either be pending (waiting for retry) or failed
    expect(['pending', 'failed']).toContain((stepRuns[0] as any)?.status);
  });

  it('should include workflow context in dispatch message', async () => {
    const dispatchFn = vi.fn().mockResolvedValue({ agentName: 'test-agent', armadaTaskId: 'test-task' });
    
    engine.setWorkflowDispatcher(dispatchFn);

    const steps = [{
      id: 'step1',
      role: 'development',
      prompt: 'Build the thing',
    }];

    const workflow = engine.createWorkflow('wf-context-test', {
      name: 'Context Test Workflow',
      description: 'Test workflow description',
      steps,
    });

    await engine.startRun(workflow as any, 'manual');
    await new Promise(resolve => setTimeout(resolve, 100));

    expect(dispatchFn).toHaveBeenCalled();
    const message = dispatchFn.mock.calls[0][0].message;
    
    // Verify workflow context block is included
    expect(message).toContain('[WORKFLOW CONTEXT]');
    expect(message).toContain('Context Test Workflow');
    expect(message).toContain('Your step: "step1"');
    expect(message).toContain('Build the thing');
  });
});
