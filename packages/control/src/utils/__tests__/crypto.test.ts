import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { encrypt, decrypt, isEncrypted, decryptIfNeeded, _resetKeyCache } from '../crypto.js';

describe('crypto utilities', () => {
  beforeEach(() => {
    // Use a fixed test key so we don't hit the filesystem
    process.env.ARMADA_ENCRYPTION_KEY = 'a'.repeat(64); // 32 bytes in hex
    _resetKeyCache();
  });

  afterEach(() => {
    delete process.env.ARMADA_ENCRYPTION_KEY;
    _resetKeyCache();
  });

  describe('encrypt', () => {
    it('returns a string with enc:v1: prefix', () => {
      const result = encrypt('sk-test-key-123');
      expect(result).toMatch(/^enc:v1:/);
    });

    it('produces different ciphertexts for the same input (random IV)', () => {
      const a = encrypt('same-key');
      const b = encrypt('same-key');
      expect(a).not.toBe(b);
    });

    it('handles empty string', () => {
      const result = encrypt('');
      expect(result).toMatch(/^enc:v1:/);
    });

    it('handles long strings', () => {
      const long = 'sk-' + 'x'.repeat(200);
      const result = encrypt(long);
      expect(result).toMatch(/^enc:v1:/);
    });
  });

  describe('decrypt', () => {
    it('round-trips a simple API key', () => {
      const plain = 'sk-test-secret-key-abc123';
      expect(decrypt(encrypt(plain))).toBe(plain);
    });

    it('round-trips an empty string', () => {
      expect(decrypt(encrypt(''))).toBe('');
    });

    it('round-trips a long value', () => {
      const long = 'sk-' + 'a'.repeat(200);
      expect(decrypt(encrypt(long))).toBe(long);
    });

    it('throws on non-prefixed input', () => {
      expect(() => decrypt('plain-text-key')).toThrow('Not an encrypted value');
    });

    it('throws on truncated/corrupted ciphertext', () => {
      expect(() => decrypt('enc:v1:aGVsbG8=')).toThrow();
    });

    it('throws when auth tag is wrong (tampered ciphertext)', () => {
      const enc = encrypt('original');
      // Flip a bit in the base64 payload
      const tampered = enc.replace(/.$/, enc.endsWith('A') ? 'B' : 'A');
      expect(() => decrypt(tampered)).toThrow();
    });
  });

  describe('isEncrypted', () => {
    it('returns true for enc:v1: prefixed values', () => {
      expect(isEncrypted('enc:v1:abc123')).toBe(true);
    });

    it('returns false for plain text', () => {
      expect(isEncrypted('sk-real-api-key')).toBe(false);
      expect(isEncrypted('')).toBe(false);
    });
  });

  describe('decryptIfNeeded', () => {
    it('decrypts an encrypted value', () => {
      const plain = 'sk-my-api-key';
      const enc = encrypt(plain);
      expect(decryptIfNeeded(enc)).toBe(plain);
    });

    it('returns plain text as-is (legacy migration path)', () => {
      expect(decryptIfNeeded('sk-legacy-key')).toBe('sk-legacy-key');
    });

    it('returns empty string as-is', () => {
      expect(decryptIfNeeded('')).toBe('');
    });
  });

  describe('key validation', () => {
    it('throws if ARMADA_ENCRYPTION_KEY is wrong length', () => {
      process.env.ARMADA_ENCRYPTION_KEY = 'tooshort';
      _resetKeyCache();
      expect(() => encrypt('test')).toThrow('ARMADA_ENCRYPTION_KEY must be');
    });
  });
});
