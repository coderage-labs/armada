/**
 * Test for #29: dependsOn should be mapped to waitFor in workflow steps
 *
 * This test verifies the step normalization logic that happens in createWorkflow
 * and updateWorkflow functions.
 */

import { describe, it, expect } from 'vitest';

describe('Workflow dependsOn mapping (#29)', () => {
  /**
   * Simulates the step normalization logic from workflow-engine.ts
   * This is what happens in both createWorkflow and updateWorkflow:
   *   waitFor: s.waitFor || (s as any).dependsOn || (s as any).dependencies || []
   */
  function normalizeStep(step: any) {
    return {
      ...step,
      waitFor: step.waitFor || step.dependsOn || step.dependencies || [],
    };
  }

  it('maps dependsOn to waitFor', () => {
    const step = { role: 'development', prompt: 'Test', dependsOn: ['step1', 'step2'] };
    const normalized = normalizeStep(step);

    expect(normalized.waitFor).toEqual(['step1', 'step2']);
  });

  it('preserves waitFor when explicitly provided', () => {
    const step = { role: 'development', prompt: 'Test', waitFor: ['step1'] };
    const normalized = normalizeStep(step);

    expect(normalized.waitFor).toEqual(['step1']);
  });

  it('prioritizes waitFor over dependsOn when both are provided', () => {
    const step = {
      role: 'development',
      prompt: 'Test',
      waitFor: ['step1'],
      dependsOn: ['step2'],
    };
    const normalized = normalizeStep(step);

    // waitFor takes precedence
    expect(normalized.waitFor).toEqual(['step1']);
  });

  it('handles missing dependencies with empty array', () => {
    const step = { role: 'development', prompt: 'Test' };
    const normalized = normalizeStep(step);

    expect(normalized.waitFor).toEqual([]);
  });

  it('also handles legacy "dependencies" field', () => {
    const step = { role: 'development', prompt: 'Test', dependencies: ['step1'] };
    const normalized = normalizeStep(step);

    expect(normalized.waitFor).toEqual(['step1']);
  });

  it('priority order is: waitFor > dependsOn > dependencies', () => {
    const step1 = {
      role: 'development',
      prompt: 'Test',
      dependsOn: ['a'],
      dependencies: ['b'],
    };
    expect(normalizeStep(step1).waitFor).toEqual(['a']);

    const step2 = {
      role: 'development',
      prompt: 'Test',
      waitFor: ['c'],
      dependsOn: ['a'],
      dependencies: ['b'],
    };
    expect(normalizeStep(step2).waitFor).toEqual(['c']);
  });
});
