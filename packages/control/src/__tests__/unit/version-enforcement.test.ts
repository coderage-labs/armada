import { describe, it, expect } from 'vitest';
import { isVersionCompatible, ARMADA_MIN_VERSION } from '@coderage-labs/armada-shared';

describe('Version Enforcement', () => {
  describe('isVersionCompatible', () => {
    it('should return true for equal versions', () => {
      expect(isVersionCompatible('0.2.0', '0.2.0')).toBe(true);
      expect(isVersionCompatible('1.0.0', '1.0.0')).toBe(true);
    });

    it('should return true when current version is higher', () => {
      expect(isVersionCompatible('0.3.0', '0.2.0')).toBe(true);
      expect(isVersionCompatible('1.0.0', '0.2.0')).toBe(true);
      expect(isVersionCompatible('0.2.1', '0.2.0')).toBe(true);
    });

    it('should return false when current version is lower', () => {
      expect(isVersionCompatible('0.1.0', '0.2.0')).toBe(false);
      expect(isVersionCompatible('0.1.9', '0.2.0')).toBe(false);
      expect(isVersionCompatible('1.2.0', '1.3.0')).toBe(false);
    });

    it('should handle patch versions correctly', () => {
      expect(isVersionCompatible('0.2.5', '0.2.0')).toBe(true);
      expect(isVersionCompatible('0.2.0', '0.2.1')).toBe(false);
    });

    it('should handle major version changes', () => {
      expect(isVersionCompatible('2.0.0', '1.0.0')).toBe(true);
      expect(isVersionCompatible('1.0.0', '2.0.0')).toBe(false);
    });
  });

  describe('ARMADA_MIN_VERSION', () => {
    it('should be a valid semver string', () => {
      expect(ARMADA_MIN_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    });

    it('should be compatible with itself', () => {
      expect(isVersionCompatible(ARMADA_MIN_VERSION, ARMADA_MIN_VERSION)).toBe(true);
    });
  });
});
