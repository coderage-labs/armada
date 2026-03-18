/**
 * Zod schemas for JSON columns stored in SQLite.
 * Use these instead of `JSON.parse(x) as any` for type-safe, validated parsing.
 */
import { z } from 'zod';

// ── HeartbeatMeta ──────────────────────────────────────────────────

export const heartbeatMetaSchema = z.object({
  taskCount: z.number().optional(),
  memoryMb: z.number().optional(),
  uptimeMs: z.number().optional(),
  uptime: z.number().optional(),
  activeTasks: z.number().optional(),
  status: z.string().optional(),
  instanceName: z.string().optional(),
  contacts: z.number().optional(),
  pluginVersions: z.record(z.string(), z.string()).optional(),
  skillVersions: z.record(z.string(), z.string()).optional(),
}).passthrough();

export type HeartbeatMetaParsed = z.infer<typeof heartbeatMetaSchema>;

// ── Instance config ────────────────────────────────────────────────

export const instanceConfigSchema = z.record(z.string(), z.unknown());

// ── Template JSON fields ───────────────────────────────────────────

export const resourcesSchema = z.object({
  memory: z.string(),
  cpus: z.string(),
});

export const pluginEntrySchema = z.object({
  id: z.string(),
  config: z.record(z.string(), z.unknown()).optional(),
});

export const templatePluginSchema = z.object({
  name: z.string(),
  source: z.enum(['github', 'npm', 'workspace']),
  version: z.string().optional(),
});

export const templateSkillSchema = z.object({
  name: z.string(),
  source: z.enum(['clawhub', 'github', 'workspace']),
  version: z.string().optional(),
});

export const templateAgentSchema = z.object({
  name: z.string(),
  model: z.string().optional(),
  toolsProfile: z.string().optional(),
  toolsAllow: z.array(z.string()).optional(),
  soul: z.string().optional(),
});

export const templateModelSchema = z.object({
  registryId: z.string(),
  default: z.boolean(),
  apiKeyId: z.string().optional(),
});

export const stringArraySchema = z.array(z.string());

// ── Channel identity (linking) ─────────────────────────────────────

export const channelIdentitySchema = z.object({
  platformId: z.string(),
  verified: z.boolean(),
  linkedAt: z.string(),
});

export const userChannelsSchema = z.record(z.string(), channelIdentitySchema);

// ── User JSON fields ───────────────────────────────────────────────

export const linkedAccountsSchema = z.object({
  telegram: z.string().optional(),
  github: z.string().optional(),
  email: z.string().optional(),
  callbackUrl: z.string().optional(),
  hooksToken: z.string().optional(),
}).passthrough();

export const notificationsSchema = z.object({
  channels: z.array(z.string()).optional().default([]),
  email: z.object({ address: z.string() }).optional(),
  webhook: z.object({ url: z.string() }).optional(),
  preferences: z.object({
    gates: z.boolean(),
    completions: z.boolean(),
    failures: z.boolean(),
    quietHours: z.object({ start: z.string(), end: z.string() }).optional(),
  }),
});

export const defaultNotifications = (): z.infer<typeof notificationsSchema> => ({
  channels: [],
  preferences: { gates: false, completions: false, failures: false },
});

// ── Project JSON fields ────────────────────────────────────────────

export const projectRepositorySchema = z.object({
  url: z.string(),
  defaultBranch: z.string().optional(),
  cloneDir: z.string().optional(),
});

export const projectConfigSchema = z.object({
  repositories: z.array(projectRepositorySchema).optional(),
}).passthrough();

// ── Safe parse helper ──────────────────────────────────────────────

/**
 * Parse a JSON string with a Zod schema.
 * Falls back to `fallback` on parse or validation error, logging a warning.
 */
export function parseJsonWithSchema<T>(
  label: string,
  json: string | null | undefined,
  schema: z.ZodType<T>,
  fallback: T,
): T {
  if (!json) return fallback;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e: any) {
    console.warn(`[${label}] Failed to JSON.parse: ${e.message}`);
    return fallback;
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    console.warn(`[${label}] Schema validation failed:`, result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', '));
    // Return the raw value cast — better than losing data entirely
    return raw as T;
  }
  return result.data;
}
