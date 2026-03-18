/**
 * Normalises legacy `manualGate: true` field to the canonical `gate: 'manual'`.
 * Mutates the array in-place and returns it.
 */
export function normaliseSteps(steps: any[]): any[] {
  for (const step of steps) {
    if (step.manualGate === true && !step.gate) {
      step.gate = 'manual';
    }
    delete step.manualGate;
  }
  return steps;
}
