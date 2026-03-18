import { eq, and, asc } from 'drizzle-orm';
import { getDrizzle } from '../db/drizzle.js';
import { providerApiKeys } from '../db/drizzle-schema.js';
import type { ProviderApiKey } from '@coderage-labs/armada-shared';
import { encrypt, decryptIfNeeded, isEncrypted } from '../utils/crypto.js';

type KeyRow = typeof providerApiKeys.$inferSelect;

/**
 * Convert a DB row to a ProviderApiKey domain object.
 * Decrypts the apiKey value transparently (handles both legacy plain text
 * and encrypted enc:v1:… values).
 */
function rowToKey(r: KeyRow): ProviderApiKey {
  return {
    id: r.id,
    providerId: r.providerId,
    name: r.name,
    apiKey: r.apiKey ? decryptIfNeeded(r.apiKey) : r.apiKey,
    isDefault: r.isDefault,
    priority: r.priority,
    createdAt: r.createdAt,
  };
}

/**
 * Mask an API key for display: show first 3 + last 3 characters.
 * Accepts the already-decrypted plain text value.
 */
export function maskApiKey(key: string | null): string | null {
  if (!key) return null;
  if (key.length <= 6) return '••••••';
  return key.slice(0, 3) + '...' + key.slice(-3);
}

export const providerApiKeyRepo = {
  getById(id: string): ProviderApiKey | null {
    const row = getDrizzle().select().from(providerApiKeys).where(eq(providerApiKeys.id, id)).get();
    return row ? rowToKey(row) : null;
  },

  getByProvider(providerId: string): ProviderApiKey[] {
    return getDrizzle()
      .select()
      .from(providerApiKeys)
      .where(eq(providerApiKeys.providerId, providerId))
      .orderBy(asc(providerApiKeys.priority), asc(providerApiKeys.createdAt))
      .all()
      .map(rowToKey);
  },

  getByProviderMasked(providerId: string): ProviderApiKey[] {
    return providerApiKeyRepo.getByProvider(providerId).map(k => ({ ...k, apiKey: maskApiKey(k.apiKey) }));
  },

  getDefault(providerId: string): ProviderApiKey | null {
    // First try the explicitly marked default
    const rows = getDrizzle()
      .select()
      .from(providerApiKeys)
      .where(and(eq(providerApiKeys.providerId, providerId), eq(providerApiKeys.isDefault, 1)))
      .all();
    if (rows.length > 0) return rowToKey(rows[0]);

    // Fall back to first by priority
    const all = getDrizzle()
      .select()
      .from(providerApiKeys)
      .where(eq(providerApiKeys.providerId, providerId))
      .orderBy(asc(providerApiKeys.priority), asc(providerApiKeys.createdAt))
      .all();
    return all.length > 0 ? rowToKey(all[0]) : null;
  },

  create(data: { providerId: string; name: string; apiKey: string; isDefault?: number; priority?: number }): ProviderApiKey {
    const id = crypto.randomUUID();
    const isDefault = data.isDefault ?? 0;
    // If this is the first key for provider, auto-set as default
    const existing = providerApiKeyRepo.getByProvider(data.providerId);
    const effectiveDefault = existing.length === 0 ? 1 : isDefault;

    // If setting as default, unset others
    if (effectiveDefault === 1) {
      getDrizzle()
        .update(providerApiKeys)
        .set({ isDefault: 0 })
        .where(eq(providerApiKeys.providerId, data.providerId))
        .run();
    }

    getDrizzle().insert(providerApiKeys).values({
      id,
      providerId: data.providerId,
      name: data.name,
      apiKey: encrypt(data.apiKey),
      isDefault: effectiveDefault,
      priority: data.priority ?? 0,
    }).run();

    return providerApiKeyRepo.getByProvider(data.providerId).find(k => k.id === id)!;
  },

  update(id: string, data: Partial<{ name: string; apiKey: string; isDefault: number; priority: number }>): ProviderApiKey {
    const row = getDrizzle().select().from(providerApiKeys).where(eq(providerApiKeys.id, id)).get();
    if (!row) throw new Error(`Provider API key not found: ${id}`);

    const updateData: Record<string, any> = {};
    if (data.name !== undefined) updateData.name = data.name;
    if (data.apiKey !== undefined) updateData.apiKey = encrypt(data.apiKey);
    if (data.priority !== undefined) updateData.priority = data.priority;

    // If setting as default, unset others first
    if (data.isDefault === 1) {
      getDrizzle()
        .update(providerApiKeys)
        .set({ isDefault: 0 })
        .where(eq(providerApiKeys.providerId, row.providerId))
        .run();
      updateData.isDefault = 1;
    } else if (data.isDefault === 0) {
      updateData.isDefault = 0;
    }

    if (Object.keys(updateData).length > 0) {
      getDrizzle().update(providerApiKeys).set(updateData).where(eq(providerApiKeys.id, id)).run();
    }

    return rowToKey(getDrizzle().select().from(providerApiKeys).where(eq(providerApiKeys.id, id)).get()!);
  },

  delete(id: string): void {
    const existing = providerApiKeyRepo.getById(id);
    getDrizzle().delete(providerApiKeys).where(eq(providerApiKeys.id, id)).run();
    // Auto-promote if deleted key was default
    if (existing?.isDefault === 1 && existing.providerId) {
      const remaining = providerApiKeyRepo.getByProvider(existing.providerId);
      if (remaining.length > 0) {
        // Sort by priority (lower first), then pick first
        remaining.sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999));
        getDrizzle()
          .update(providerApiKeys)
          .set({ isDefault: 1 })
          .where(eq(providerApiKeys.id, remaining[0].id))
          .run();
      }
    }
  },

  setDefault(id: string, providerId: string): ProviderApiKey {
    // Unset all defaults for provider
    getDrizzle()
      .update(providerApiKeys)
      .set({ isDefault: 0 })
      .where(eq(providerApiKeys.providerId, providerId))
      .run();
    // Set this one
    getDrizzle()
      .update(providerApiKeys)
      .set({ isDefault: 1 })
      .where(eq(providerApiKeys.id, id))
      .run();

    return rowToKey(getDrizzle().select().from(providerApiKeys).where(eq(providerApiKeys.id, id)).get()!);
  },

  /**
   * Migrate all legacy plain-text API keys to encrypted form.
   * Safe to run multiple times (idempotent — already-encrypted keys are skipped).
   * Returns the number of keys that were migrated.
   */
  migrateEncryption(): number {
    const db = getDrizzle();
    const allRows = db.select().from(providerApiKeys).all();
    let migrated = 0;
    for (const row of allRows) {
      if (row.apiKey && !isEncrypted(row.apiKey)) {
        db.update(providerApiKeys)
          .set({ apiKey: encrypt(row.apiKey) })
          .where(eq(providerApiKeys.id, row.id))
          .run();
        migrated++;
      }
    }
    return migrated;
  },
};
