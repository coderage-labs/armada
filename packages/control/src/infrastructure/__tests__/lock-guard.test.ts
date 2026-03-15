import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setupTestDb, teardownTestDb } from '../../test/helpers.js';
import { createLockManager } from '../lock-manager.js';
import { requireUnlocked } from '../../middleware/lock-guard.js';

// We mock the lockManager singleton so our tests control lock state
vi.mock('../../infrastructure/lock-manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lock-manager.js')>();
  // Replace the singleton with a fresh one per test via beforeEach
  return {
    ...actual,
    // Override lockManager export to use our test instance
    get lockManager() {
      return testLockManager;
    },
  };
});

// Test-controlled lock manager
let testLockManager: ReturnType<typeof createLockManager>;

// Helper: build a minimal mock Express request
function makeReq(params: Record<string, string> = {}): any {
  return { params };
}

// Helper: build a mock response with status + json tracking
function makeRes() {
  const res: any = {
    _status: 200,
    _body: undefined,
    status(code: number) { this._status = code; return this; },
    json(body: any) { this._body = body; return this; },
  };
  return res;
}

describe('requireUnlocked middleware', () => {
  beforeEach(() => {
    setupTestDb();
    testLockManager = createLockManager();
  });

  afterEach(() => {
    teardownTestDb();
  });

  it('unlocked target passes through (calls next)', () => {
    const next = vi.fn();
    const mw = requireUnlocked(req => ({ type: 'instance', id: req.params.id }));
    const req = makeReq({ id: 'inst-1' });
    const res = makeRes();

    mw(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res._body).toBeUndefined();
  });

  it('locked target returns 409 with operation details', () => {
    testLockManager.acquire('instance', 'inst-1', 'op-active');

    const next = vi.fn();
    const mw = requireUnlocked(req => ({ type: 'instance', id: req.params.id }));
    const req = makeReq({ id: 'inst-1' });
    const res = makeRes();

    mw(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(409);
    expect(res._body.error).toMatch(/locked/i);
    expect(res._body.operationId).toBe('op-active');
  });

  it('global lock blocks requests to all targets', () => {
    testLockManager.acquire('global', 'armada', 'op-global');

    const next = vi.fn();
    const mw = requireUnlocked(req => ({ type: 'instance', id: req.params.id }));
    const req = makeReq({ id: 'inst-unlocked' });
    const res = makeRes();

    mw(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(409);
    expect(res._body.error).toMatch(/armada/i);
    expect(res._body.operationId).toBe('op-global');
  });

  it('null target (no target extraction) passes through', () => {
    testLockManager.acquire('global', 'armada', 'op-global');

    const next = vi.fn();
    const mw = requireUnlocked(() => null);
    const req = makeReq();
    const res = makeRes();

    mw(req, res, next);

    // Should pass through even with global lock, because target is null
    expect(next).toHaveBeenCalledOnce();
    expect(res._body).toBeUndefined();
  });

  it('released lock allows subsequent requests', () => {
    testLockManager.acquire('instance', 'inst-1', 'op-1');
    testLockManager.release('instance', 'inst-1', 'op-1');

    const next = vi.fn();
    const mw = requireUnlocked(req => ({ type: 'instance', id: req.params.id }));
    const req = makeReq({ id: 'inst-1' });
    const res = makeRes();

    mw(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res._body).toBeUndefined();
  });
});
