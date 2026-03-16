/**
 * Test: workflow step output propagation (#36)
 * 
 * Verifies that when an agent completes a task, the result text
 * is properly propagated to the workflow_step_runs.output field.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { getDrizzle } from '../../db/drizzle.js';
import { tasks, workflowStepRuns, workflowRuns, workflows as workflowsTable } from '../../db/drizzle-schema.js';
import { eq } from 'drizzle-orm';
import { checkWorkflowStep } from '../workflow-dispatcher.js';
import { randomUUID } from 'node:crypto';
import { tasksRepo } from '../../repositories/index.js';

describe('workflow output propagation', () => {
  const db = getDrizzle();

  beforeEach(() => {
    // Clean up test data
    db.delete(tasks).run();
    db.delete(workflowStepRuns).run();
    db.delete(workflowRuns).run();
    db.delete(workflowsTable).run();
  });

  it('should propagate task result to workflow step output even when parameter is empty', async () => {
    // 1. Create a workflow
    const workflowId = randomUUID();
    db.insert(workflowsTable).values({
      id: workflowId,
      name: 'Test Workflow',
      description: 'Test workflow for output propagation',
      stepsJson: JSON.stringify([
        { id: 'step1', role: 'dev', prompt: 'Do something' }
      ]),
    }).run();

    // 2. Create a workflow run
    const runId = randomUUID();
    db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      projectId: 'test-project',
      triggerType: 'manual',
      status: 'running',
      contextJson: JSON.stringify({}),
    }).run();

    // 3. Create a step run
    const stepRunId = randomUUID();
    const taskId = `wf-${runId.slice(0, 8)}-step1`;
    db.insert(workflowStepRuns).values({
      id: stepRunId,
      runId,
      stepId: 'step1',
      stepIndex: 0,
      role: 'dev',
      status: 'running',
      taskId,
    }).run();

    // 4. Create a task with result text
    const resultText = 'This is the agent output that should appear in step output';
    tasksRepo.create({
      id: taskId,
      fromAgent: 'workflow-engine',
      toAgent: 'dev-agent',
      taskText: 'Do something',
      result: resultText,
      status: 'completed',
      workflowRunId: runId,
    });

    // 5. Call checkWorkflowStep with empty string parameter (simulating bug scenario)
    // The function should read the result from the database instead
    checkWorkflowStep(taskId, 'completed', '');

    // Wait for async completion
    await new Promise(resolve => setTimeout(resolve, 100));

    // 6. Verify that the step run output has the correct result
    const updatedStepRun = db.select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.id, stepRunId))
      .get();

    expect(updatedStepRun).toBeDefined();
    expect(updatedStepRun?.output).toBe(resultText);
    expect(updatedStepRun?.status).toBe('completed');
  });

  it('should extract shared refs from task result', async () => {
    // 1. Create a workflow
    const workflowId = randomUUID();
    db.insert(workflowsTable).values({
      id: workflowId,
      name: 'Test Workflow',
      description: 'Test workflow for shared refs',
      stepsJson: JSON.stringify([
        { id: 'step1', role: 'dev', prompt: 'Do something' }
      ]),
    }).run();

    // 2. Create a workflow run
    const runId = randomUUID();
    db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      projectId: 'test-project',
      triggerType: 'manual',
      status: 'running',
      contextJson: JSON.stringify({}),
    }).run();

    // 3. Create a step run
    const stepRunId = randomUUID();
    const taskId = `wf-${runId.slice(0, 8)}-step1`;
    db.insert(workflowStepRuns).values({
      id: stepRunId,
      runId,
      stepId: 'step1',
      stepIndex: 0,
      role: 'dev',
      status: 'running',
      taskId,
    }).run();

    // 4. Create a task with result containing shared refs
    const resultText = 'Output with {{shared:file:path/to/file.txt}} and {{shared:url:https://example.com}}';
    tasksRepo.create({
      id: taskId,
      fromAgent: 'workflow-engine',
      toAgent: 'dev-agent',
      taskText: 'Do something',
      result: resultText,
      status: 'completed',
      workflowRunId: runId,
    });

    // 5. Call checkWorkflowStep
    checkWorkflowStep(taskId, 'completed', '');

    // Wait for async completion
    await new Promise(resolve => setTimeout(resolve, 100));

    // 6. Verify that shared refs are extracted
    const updatedStepRun = db.select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.id, stepRunId))
      .get();

    expect(updatedStepRun).toBeDefined();
    expect(updatedStepRun?.output).toBe(resultText);
    
    const sharedRefs = JSON.parse(updatedStepRun?.sharedRefsJson || '[]');
    expect(sharedRefs).toHaveLength(2);
    expect(sharedRefs).toContain('{{shared:file:path/to/file.txt}}');
    expect(sharedRefs).toContain('{{shared:url:https://example.com}}');
  });
});
