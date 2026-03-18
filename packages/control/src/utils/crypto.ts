/**
 * Encryption utilities for API keys at rest.
 *
 * Uses AES-256-GCM with a random IV per value.
 * Encrypted format: enc:v1:<base64(iv + ciphertext + authTag)>
 *
 * Key source (in priority order):
 *   1. ARMADA_ENCRYPTION_KEY env var (32-byte hex string)
 *   2. Auto-generated key stored in /data/encryption.key
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const PREFIX = 'enc:v1:';
const KEY_FILE = process.env.ARMADA_KEY_FILE ?? '/data/encryption.key';

let _cachedKey: Buffer | null = null;

/**
 * Load or generate the encryption key.
 * Cached after first call so we don't hit disk on every encrypt/decrypt.
 */
export function getEncryptionKey(): Buffer {
  if (_cachedKey) return _cachedKey;

  // 1. Try env var first
  const envKey = process.env.ARMADA_ENCRYPTION_KEY;
  if (envKey) {
    const buf = Buffer.from(envKey, 'hex');
    if (buf.length !== KEY_BYTES) {
      throw new Error(
        `ARMADA_ENCRYPTION_KEY must be a ${KEY_BYTES * 2}-character hex string (${KEY_BYTES} bytes). ` +
        `Got ${buf.length} bytes.`
      );
    }
    _cachedKey = buf;
    return _cachedKey;
  }

  // 2. Try key file
  if (fs.existsSync(KEY_FILE)) {
    const content = fs.readFileSync(KEY_FILE, 'utf8').trim();
    const buf = Buffer.from(content, 'hex');
    if (buf.length !== KEY_BYTES) {
      throw new Error(`Key file ${KEY_FILE} contains an invalid key (expected ${KEY_BYTES} bytes).`);
    }
    _cachedKey = buf;
    return _cachedKey;
  }

  // 3. Auto-generate and persist
  const newKey = crypto.randomBytes(KEY_BYTES);
  const keyHex = newKey.toString('hex');
  try {
    fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true });
    fs.writeFileSync(KEY_FILE, keyHex, { mode: 0o600 });
    console.log(`[crypto] Generated new encryption key at ${KEY_FILE}`);
  } catch (err: any) {
    console.warn(`[crypto] Could not persist encryption key to ${KEY_FILE}: ${err.message}`);
    console.warn('[crypto] Key will be ephemeral — set ARMADA_ENCRYPTION_KEY to make it permanent.');
  }
  _cachedKey = newKey;
  return _cachedKey;
}

/**
 * Encrypt a plaintext string. Returns an opaque string starting with "enc:v1:".
 */
export function encrypt(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Pack: iv (12) + ciphertext (var) + authTag (16)
  const packed = Buffer.concat([iv, ciphertext, authTag]);
  return PREFIX + packed.toString('base64');
}

/**
 * Decrypt a ciphertext string produced by `encrypt()`.
 * Throws if the format is invalid or authentication fails.
 */
export function decrypt(ciphertext: string): string {
  if (!ciphertext.startsWith(PREFIX)) {
    throw new Error('Not an encrypted value (missing enc:v1: prefix)');
  }
  const key = getEncryptionKey();
  const packed = Buffer.from(ciphertext.slice(PREFIX.length), 'base64');
  if (packed.length < IV_BYTES + TAG_BYTES) {
    throw new Error('Encrypted value too short to be valid');
  }
  const iv = packed.subarray(0, IV_BYTES);
  const authTag = packed.subarray(packed.length - TAG_BYTES);
  const data = packed.subarray(IV_BYTES, packed.length - TAG_BYTES);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(data) + decipher.final('utf8');
}

/**
 * Returns true if the value looks like an encrypted payload.
 */
export function isEncrypted(value: string): boolean {
  return value.startsWith(PREFIX);
}

/**
 * Decrypt a value that may or may not be encrypted (handles legacy plain text).
 * If not encrypted, returns the value as-is.
 */
export function decryptIfNeeded(value: string): string {
  if (isEncrypted(value)) {
    return decrypt(value);
  }
  return value;
}

/**
 * Reset the cached key (for testing purposes only).
 * @internal
 */
export function _resetKeyCache(): void {
  _cachedKey = null;
}
