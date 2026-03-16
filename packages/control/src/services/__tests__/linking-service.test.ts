import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createLinkingCode, verifyLinkingCode, getPendingCode } from '../linking-service.js';

describe('linking-service', () => {
  // Reset module state between tests by re-importing is not straightforward
  // with ES modules; instead we rely on the codes being consumed or expired.

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('createLinkingCode returns a 6-digit string', () => {
    const code = createLinkingCode('telegram', '5059211930');
    expect(code).toMatch(/^\d{6}$/);
  });

  it('verifyLinkingCode returns channel info for a valid code', () => {
    const code = createLinkingCode('telegram', '5059211930');
    const result = verifyLinkingCode(code);
    expect(result).not.toBeNull();
    expect(result!.channelType).toBe('telegram');
    expect(result!.platformId).toBe('5059211930');
  });

  it('verifyLinkingCode returns null for an invalid/unknown code', () => {
    const result = verifyLinkingCode('000000');
    expect(result).toBeNull();
  });

  it('verifyLinkingCode returns null for an expired code', () => {
    const now = Date.now();
    vi.spyOn(Date, 'now')
      .mockReturnValueOnce(now)               // cleanupExpired() inside createLinkingCode
      .mockReturnValueOnce(now)               // createdAt = now
      .mockReturnValue(now + 11 * 60 * 1000); // verifyLinkingCode TTL check (>10min)

    const code = createLinkingCode('telegram', '9999999999');
    const result = verifyLinkingCode(code);
    expect(result).toBeNull();
  });

  it('codes are one-time use — second verify returns null', () => {
    const code = createLinkingCode('slack', 'U12345');
    const first = verifyLinkingCode(code);
    expect(first).not.toBeNull();
    const second = verifyLinkingCode(code);
    expect(second).toBeNull();
  });

  it('getPendingCode finds an existing non-expired code', () => {
    const code = createLinkingCode('telegram', '1234567890');
    const found = getPendingCode('telegram', '1234567890');
    expect(found).toBe(code);
  });

  it('getPendingCode returns null when no code exists for that platform', () => {
    const found = getPendingCode('telegram', 'nonexistent-id');
    expect(found).toBeNull();
  });

  it('getPendingCode returns null for expired code', () => {
    const now = Date.now();
    vi.spyOn(Date, 'now')
      .mockReturnValueOnce(now)               // cleanupExpired() inside createLinkingCode
      .mockReturnValueOnce(now)               // createdAt = now
      .mockReturnValue(now + 11 * 60 * 1000); // getPendingCode TTL check (>10min)

    const _code = createLinkingCode('telegram', '8888888888');
    const found = getPendingCode('telegram', '8888888888');
    expect(found).toBeNull();
  });
});
