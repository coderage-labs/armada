import { describe, it, expect } from 'vitest';
import { resolveActionCommand, detectCulprit } from '../../services/workflow-engine.js';

describe('action resolution', () => {
  it('resolves action from actions object with command', () => {
    const armadaJson = {
      actions: {
        test: { command: 'npm test', description: 'Run tests' },
      },
    };
    expect(resolveActionCommand(armadaJson, 'test')).toBe('npm test');
  });

  it('resolves action from actions object with string shorthand', () => {
    const armadaJson = {
      actions: {
        lint: 'npm run lint',
      },
    };
    expect(resolveActionCommand(armadaJson, 'lint')).toBe('npm run lint');
  });

  it('falls back to top-level field', () => {
    const armadaJson = {
      test: 'npm run test:unit',
      verify: 'npx tsc --noEmit',
    };
    expect(resolveActionCommand(armadaJson, 'test')).toBe('npm run test:unit');
    expect(resolveActionCommand(armadaJson, 'verify')).toBe('npx tsc --noEmit');
  });

  it('prefers actions object over top-level field', () => {
    const armadaJson = {
      test: 'legacy command',
      actions: {
        test: { command: 'new command', description: 'Better tests' },
      },
    };
    expect(resolveActionCommand(armadaJson, 'test')).toBe('new command');
  });

  it('returns null for unknown action', () => {
    const armadaJson = {
      test: 'npm test',
    };
    expect(resolveActionCommand(armadaJson, 'unknown')).toBeNull();
  });

  it('returns null for empty armada.json', () => {
    const armadaJson = {};
    expect(resolveActionCommand(armadaJson, 'test')).toBeNull();
  });
});

describe('culprit detection', () => {
  it('matches file paths from test output to step diffs', () => {
    const errorOutput = `
      Error: Test failed
        at packages/control/src/services/workflow-engine.ts:123:45
        at Context.<anonymous> (packages/control/src/__tests__/unit/workflow.test.ts:56:12)
    `;
    
    const completedSteps = [
      { 
        stepId: 'implement-feature',
        output: 'Modified files:\n- packages/control/src/services/workflow-engine.ts\n- packages/shared/src/index.ts'
      },
      {
        stepId: 'implement-other',
        output: 'Modified files:\n- packages/node/src/handlers/docker.ts'
      }
    ];
    
    expect(detectCulprit(errorOutput, completedSteps)).toBe('implement-feature');
  });

  it('matches by basename when full path not found', () => {
    const errorOutput = `
      FAIL workflow-engine.ts
      Error: Expected 1 to equal 2
    `;
    
    const completedSteps = [
      {
        stepId: 'step1',
        output: 'Changed: workflow-engine.ts, added new function'
      },
    ];
    
    expect(detectCulprit(errorOutput, completedSteps)).toBe('step1');
  });

  it('returns null when no match found', () => {
    const errorOutput = `
      Error in src/unknown-file.ts:100:20
    `;
    
    const completedSteps = [
      {
        stepId: 'step1',
        output: 'Modified: src/services/other.ts'
      },
    ];
    
    expect(detectCulprit(errorOutput, [])).toBeNull();
    expect(detectCulprit(errorOutput, completedSteps)).toBeNull();
  });

  it('returns null for error output with no file paths', () => {
    const errorOutput = 'Generic error message with no file references';
    
    const completedSteps = [
      {
        stepId: 'step1',
        output: 'Changed: src/file.ts'
      },
    ];
    
    expect(detectCulprit(errorOutput, completedSteps)).toBeNull();
  });

  it('handles multiple file extensions', () => {
    const testCases = [
      { file: 'main.py', ext: 'py' },
      { file: 'server.go', ext: 'go' },
      { file: 'lib.rs', ext: 'rs' },
      { file: 'App.java', ext: 'java' },
      { file: 'script.rb', ext: 'rb' },
      { file: 'index.php', ext: 'php' },
      { file: 'util.c', ext: 'c' },
      { file: 'lib.cpp', ext: 'cpp' },
      { file: 'types.h', ext: 'h' },
    ];
    
    for (const { file, ext } of testCases) {
      const errorOutput = `Error in ${file}:10:5`;
      const completedSteps = [{
        stepId: 'implement',
        output: `Modified ${file}`
      }];
      expect(detectCulprit(errorOutput, completedSteps)).toBe('implement');
    }
  });
});
