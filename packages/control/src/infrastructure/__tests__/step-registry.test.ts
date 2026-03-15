import { describe, it, expect } from 'vitest';
import { createStepRegistry } from '../step-registry.js';
import type { StepHandler } from '../step-registry.js';

describe('StepRegistry', () => {
  function makeHandler(name: string): StepHandler {
    return {
      name,
      async execute() { /* noop */ },
    };
  }

  it('registers and retrieves a handler', () => {
    const registry = createStepRegistry();
    const handler = makeHandler('pull_image');
    registry.register(handler);

    expect(registry.get('pull_image')).toBe(handler);
    expect(registry.has('pull_image')).toBe(true);
  });

  it('returns undefined for unregistered handler', () => {
    const registry = createStepRegistry();
    expect(registry.get('nonexistent')).toBeUndefined();
    expect(registry.has('nonexistent')).toBe(false);
  });

  it('overwrites existing handler on re-register', () => {
    const registry = createStepRegistry();
    const handler1 = makeHandler('pull_image');
    const handler2 = makeHandler('pull_image');

    registry.register(handler1);
    registry.register(handler2);

    expect(registry.get('pull_image')).toBe(handler2);
  });

  it('supports multiple different handlers', () => {
    const registry = createStepRegistry();
    registry.register(makeHandler('pull_image'));
    registry.register(makeHandler('health_check'));
    registry.register(makeHandler('start_container'));

    expect(registry.has('pull_image')).toBe(true);
    expect(registry.has('health_check')).toBe(true);
    expect(registry.has('start_container')).toBe(true);
    expect(registry.has('stop_container')).toBe(false);
  });
});
