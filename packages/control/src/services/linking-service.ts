/**
 * linking-service.ts
 *
 * In-memory store for channel linking codes. Generates 6-digit one-time codes
 * with a 10-minute TTL that allow users to link their platform identities
 * (e.g. Telegram user ID) to their Armada account.
 */

interface LinkingCode {
  code: string;
  channelType: string;
  platformId: string;
  createdAt: number;
}

const TTL_MS = 10 * 60 * 1000; // 10 minutes
const pendingCodes = new Map<string, LinkingCode>();

/** Remove expired codes from the store. */
function cleanupExpired(): void {
  const now = Date.now();
  for (const [key, entry] of pendingCodes) {
    if (now - entry.createdAt > TTL_MS) pendingCodes.delete(key);
  }
}

/**
 * Generate a 6-digit linking code for a channel identity.
 * Cleans up expired codes before generating a new one.
 */
export function createLinkingCode(channelType: string, platformId: string): string {
  cleanupExpired();
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  pendingCodes.set(code, { code, channelType, platformId, createdAt: Date.now() });
  return code;
}

/**
 * Verify a linking code.
 * Returns { channelType, platformId } on success, or null if invalid/expired.
 * Codes are one-time use — deleted on successful verification.
 */
export function verifyLinkingCode(code: string): { channelType: string; platformId: string } | null {
  const entry = pendingCodes.get(code);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > TTL_MS) {
    pendingCodes.delete(code);
    return null;
  }
  pendingCodes.delete(code); // One-time use
  return { channelType: entry.channelType, platformId: entry.platformId };
}

/**
 * Find a pending (non-expired) code for a given platform identity.
 * Used by bots to resend the code if the user asks again.
 */
export function getPendingCode(channelType: string, platformId: string): string | null {
  for (const [, entry] of pendingCodes) {
    if (entry.channelType === channelType && entry.platformId === platformId) {
      if (Date.now() - entry.createdAt <= TTL_MS) return entry.code;
    }
  }
  return null;
}
