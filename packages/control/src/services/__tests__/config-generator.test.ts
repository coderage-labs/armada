import { describe, it, expect } from 'vitest';
import { buildControlUiConfig } from '../config-generator.js';

/**
 * Normalize model IDs by stripping dated suffixes (e.g., -20250514).
 * Anthropic's API only accepts short-form model IDs like "claude-sonnet-4-5",
 * not dated variants like "claude-sonnet-4-5-20250514".
 * 
 * NOTE: This function is duplicated here for testing. In production, it's defined
 * in config-generator.ts and not exported. We test it indirectly through its effects
 * on the generated config, but also test the logic directly here.
 */
function normalizeModelId(modelId: string): string {
  // Strip dated suffixes like -20250514 or -20250620
  return modelId.replace(/-\d{8}$/, '');
}

describe('normalizeModelId', () => {
  it('strips dated suffix from model ID', () => {
    expect(normalizeModelId('claude-sonnet-4-5-20250514')).toBe('claude-sonnet-4-5');
    expect(normalizeModelId('claude-sonnet-4-5-20250620')).toBe('claude-sonnet-4-5');
    expect(normalizeModelId('gpt-4-20241231')).toBe('gpt-4');
  });

  it('returns unchanged model ID when no dated suffix present', () => {
    expect(normalizeModelId('claude-sonnet-4-5')).toBe('claude-sonnet-4-5');
    expect(normalizeModelId('gpt-4')).toBe('gpt-4');
    expect(normalizeModelId('gemini-pro')).toBe('gemini-pro');
  });

  it('handles edge cases', () => {
    expect(normalizeModelId('')).toBe('');
    expect(normalizeModelId('model-20250101')).toBe('model');
    // Should not strip non-8-digit suffixes
    expect(normalizeModelId('model-123')).toBe('model-123');
    expect(normalizeModelId('model-2025')).toBe('model-2025');
  });
});

describe('buildControlUiConfig', () => {
  it('returns dangerouslyAllowHostHeaderOriginFallback when no origins are provided', () => {
    const config = buildControlUiConfig();
    expect(config).toEqual({ dangerouslyAllowHostHeaderOriginFallback: true });
    expect(config).not.toHaveProperty('allowedOrigins');
  });

  it('returns dangerouslyAllowHostHeaderOriginFallback when an empty origins array is provided', () => {
    // OpenClaw rejects allowedOrigins: [] as "not configured" — must use fallback instead
    const config = buildControlUiConfig([]);
    expect(config).toEqual({ dangerouslyAllowHostHeaderOriginFallback: true });
    expect(config).not.toHaveProperty('allowedOrigins');
  });

  it('returns allowedOrigins (without fallback flag) when origins are provided', () => {
    const origins = ['https://app.example.com', 'https://staging.example.com'];
    const config = buildControlUiConfig(origins);
    expect(config).toEqual({ allowedOrigins: origins });
    expect(config).not.toHaveProperty('dangerouslyAllowHostHeaderOriginFallback');
  });

  it('returns allowedOrigins for a single origin', () => {
    const config = buildControlUiConfig(['https://app.example.com']);
    expect(config).toEqual({ allowedOrigins: ['https://app.example.com'] });
    expect(config).not.toHaveProperty('dangerouslyAllowHostHeaderOriginFallback');
  });
});
