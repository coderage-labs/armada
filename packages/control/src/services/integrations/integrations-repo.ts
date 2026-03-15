import { v4 as uuidv4 } from 'uuid';
import { eq, asc, sql } from 'drizzle-orm';
import { getDrizzle } from '../../db/drizzle.js';
import { integrations } from '../../db/drizzle-schema.js';
import type { AuthConfig } from './types.js';

export interface Integration {
  id: string;
  name: string;
  provider: string;
  authType: string;
  authConfig: AuthConfig;
  capabilities: string[];
  status: 'active' | 'error' | 'expired';
  statusMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

type IntegrationRow = typeof integrations.$inferSelect;

function rowToIntegration(r: IntegrationRow): Integration {
  let authConfig: AuthConfig = {};
  try { authConfig = JSON.parse(r.authConfig); } catch { console.warn('[integrations-repo] Failed to parse JSON field'); }
  let capabilities: string[] = [];
  try { capabilities = JSON.parse(r.capabilities); } catch { console.warn('[integrations-repo] Failed to parse JSON field'); }
  return {
    id: r.id,
    name: r.name,
    provider: r.provider,
    authType: r.authType,
    authConfig,
    capabilities,
    status: (r.status ?? 'active') as Integration['status'],
    statusMessage: r.statusMessage ?? null,
    createdAt: r.createdAt ?? '',
    updatedAt: r.updatedAt ?? '',
  };
}

/**
 * Mask sensitive auth config values for API responses.
 * Replaces token values with ****...last4chars
 */
export function maskAuthConfig(config: AuthConfig): AuthConfig {
  const masked: AuthConfig = { ...config };
  
  if (masked.token && masked.token.length > 4) {
    const last4 = masked.token.slice(-4);
    masked.token = `****${last4}`;
  }
  
  if (masked.accessToken && masked.accessToken.length > 4) {
    const last4 = masked.accessToken.slice(-4);
    masked.accessToken = `****${last4}`;
  }
  
  if (masked.refreshToken && masked.refreshToken.length > 4) {
    const last4 = masked.refreshToken.slice(-4);
    masked.refreshToken = `****${last4}`;
  }
  
  if (masked.privateKey) {
    masked.privateKey = '****[masked]';
  }
  
  return masked;
}

export const integrationsRepo = {
  getAll(): Integration[] {
    return getDrizzle().select().from(integrations).orderBy(asc(integrations.name)).all().map(rowToIntegration);
  },

  getById(id: string): Integration | null {
    const row = getDrizzle().select().from(integrations).where(eq(integrations.id, id)).get();
    return row ? rowToIntegration(row) : null;
  },

  getByName(name: string): Integration | null {
    const row = getDrizzle().select().from(integrations).where(eq(integrations.name, name)).get();
    return row ? rowToIntegration(row) : null;
  },

  getByProvider(provider: string): Integration[] {
    return getDrizzle().select().from(integrations).where(eq(integrations.provider, provider)).orderBy(asc(integrations.name)).all().map(rowToIntegration);
  },

  create(data: {
    name: string;
    provider: string;
    authType: string;
    authConfig: AuthConfig;
    capabilities: string[];
    status?: string;
    statusMessage?: string;
  }): Integration {
    const id = uuidv4();
    getDrizzle().insert(integrations).values({
      id,
      name: data.name,
      provider: data.provider,
      authType: data.authType,
      authConfig: JSON.stringify(data.authConfig),
      capabilities: JSON.stringify(data.capabilities),
      status: data.status ?? 'active',
      statusMessage: data.statusMessage ?? null,
    }).run();
    return integrationsRepo.getById(id)!;
  },

  update(id: string, data: Partial<{
    name: string;
    provider: string;
    authType: string;
    authConfig: AuthConfig;
    capabilities: string[];
    status: string;
    statusMessage: string | null;
  }>): Integration {
    const existing = integrationsRepo.getById(id);
    if (!existing) throw new Error(`Integration not found: ${id}`);

    const updateData: Record<string, any> = { updatedAt: sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))` };
    if (data.name !== undefined) updateData.name = data.name;
    if (data.provider !== undefined) updateData.provider = data.provider;
    if (data.authType !== undefined) updateData.authType = data.authType;
    if (data.authConfig !== undefined) updateData.authConfig = JSON.stringify(data.authConfig);
    if (data.capabilities !== undefined) updateData.capabilities = JSON.stringify(data.capabilities);
    if (data.status !== undefined) updateData.status = data.status;
    if (data.statusMessage !== undefined) updateData.statusMessage = data.statusMessage;

    if (Object.keys(updateData).length > 1) { // more than just updatedAt
      getDrizzle().update(integrations).set(updateData).where(eq(integrations.id, id)).run();
    }

    return integrationsRepo.getById(id)!;
  },

  delete(id: string): void {
    getDrizzle().delete(integrations).where(eq(integrations.id, id)).run();
  },
};
