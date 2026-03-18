import { describe, it, expect } from 'vitest';
import { normaliseSteps } from '../../utils/normalise-steps.js';

describe('normaliseSteps', () => {
  it('converts manualGate: true to gate: "manual"', () => {
    const steps: any[] = [{ id: 'step-1', type: 'approval', manualGate: true }];
    normaliseSteps(steps);
    expect(steps[0].gate).toBe('manual');
    expect(steps[0]).not.toHaveProperty('manualGate');
  });

  it('does not override an existing gate when manualGate is also set', () => {
    const steps = [{ id: 'step-1', gate: 'manual', manualGate: true }];
    normaliseSteps(steps);
    expect(steps[0].gate).toBe('manual');
    expect(steps[0]).not.toHaveProperty('manualGate');
  });

  it('removes manualGate: false without setting gate', () => {
    const steps = [{ id: 'step-1', manualGate: false }];
    normaliseSteps(steps);
    expect(steps[0]).not.toHaveProperty('manualGate');
    expect(steps[0]).not.toHaveProperty('gate');
  });

  it('leaves steps without manualGate untouched', () => {
    const steps = [{ id: 'step-1', type: 'job' }];
    normaliseSteps(steps);
    expect(steps[0]).not.toHaveProperty('gate');
    expect(steps[0]).not.toHaveProperty('manualGate');
  });

  it('normalises only steps with manualGate: true in a mixed array', () => {
    const steps: any[] = [
      { id: 'a', manualGate: true },
      { id: 'b', type: 'job' },
      { id: 'c', manualGate: false },
    ];
    normaliseSteps(steps);
    expect(steps[0].gate).toBe('manual');
    expect(steps[1]).not.toHaveProperty('gate');
    expect(steps[2]).not.toHaveProperty('gate');
  });

  it('returns the mutated array', () => {
    const steps = [{ id: 'step-1', manualGate: true }];
    const result = normaliseSteps(steps);
    expect(result).toBe(steps);
  });
});
