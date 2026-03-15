import { writeFile, mkdir, unlink, access, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import sharp from 'sharp';

/**
 * Generate a deterministic DiceBear avatar URL based on a user ID.
 * Uses the "thumbs" style which has a friendly, distinct look.
 */
export function getDefaultAvatarUrl(userId: string): string {
  return `https://api.dicebear.com/7.x/thumbs/svg?seed=${encodeURIComponent(userId)}`;
}

function getAvatarDir(): string {
  const dbPath = process.env.FLEET_DB_PATH || './fleet.db';
  return join(dirname(dbPath), 'avatars');
}

export type AvatarKind = 'agent' | 'user';

/** Get the path for a given avatar at a specific size variant. */
function getAvatarPath(name: string, size: 'sm' | 'md' | 'lg' = 'lg', kind: AvatarKind = 'agent'): string {
  const prefix = kind === 'user' ? 'user-' : '';
  const suffix = size === 'lg' ? '' : `-${size}`;
  return join(getAvatarDir(), `${prefix}${name}${suffix}.png`);
}

export async function avatarExists(name: string, size: 'sm' | 'md' | 'lg' = 'lg', kind: AvatarKind = 'agent'): Promise<boolean> {
  try {
    await access(getAvatarPath(name, size, kind));
    return true;
  } catch (err: any) {
    console.warn('[avatar-generator] avatarExists check failed:', err.message);
    return false;
  }
}

export async function deleteAvatar(name: string, kind: AvatarKind = 'agent'): Promise<boolean> {
  let deleted = false;
  for (const size of ['lg', 'md', 'sm'] as const) {
    try {
      await unlink(getAvatarPath(name, size, kind));
      deleted = true;
    } catch (err: any) {
      console.warn('[avatar-generator] deleteAvatar unlink failed:', err.message);
    }
  }
  return deleted;
}

export async function readAvatar(name: string, size: 'sm' | 'md' | 'lg' = 'lg', kind: AvatarKind = 'agent'): Promise<Buffer | null> {
  try {
    return await readFile(getAvatarPath(name, size, kind));
  } catch (err: any) {
    console.warn('[avatar-generator] readAvatar failed:', err.message);
    return null;
  }
}

export interface AvatarOpts {
  name: string;
  role: string;
  kind?: AvatarKind;
  /** Extra context for the prompt (e.g. "human user", "operator AI") */
  description?: string;
}

/** Default avatar prompt — seeded into settings on first use */
export const DEFAULT_AVATAR_PROMPT = `Generate an image: A circular avatar icon for {{subject}}. Digital art style, solid black (#09090b) background — NOT transparent, must be fully opaque. Glowing teal/emerald (#10b981) accents, futuristic feel. The design should visually represent the name and role creatively. No text, no letters, no words in the image. Square format, clean edges.`;

export async function generateAvatar(nameOrOpts: string | AvatarOpts, role?: string): Promise<Buffer> {
  const opts: AvatarOpts = typeof nameOrOpts === 'string'
    ? { name: nameOrOpts, role: role || 'agent', kind: 'agent' }
    : nameOrOpts;
  const { name, kind = 'agent' } = opts;

  const { modelProviderRepo } = await import('../repositories/model-provider-repo.js');
  const { providerApiKeyRepo } = await import('../repositories/provider-api-key-repo.js');
  const { settingsRepo } = await import('../repositories/settings-repo.js');
  const { modelRegistryRepo } = await import('../repositories/model-repo.js');

  // Check if avatar generation is configured (no model = disabled)
  const avatarModelId = settingsRepo.get('avatar_model_id');
  if (!avatarModelId) {
    throw new Error('Avatar generation is disabled — select a model in Settings → Avatar Generation');
  }

  // Look up the model in the registry to find its provider
  const modelEntry = modelRegistryRepo.getByModelId(avatarModelId);
  if (!modelEntry?.providerId) {
    throw new Error(`Avatar model "${avatarModelId}" not found in model registry or has no provider`);
  }

  const provider = modelProviderRepo.getById(modelEntry.providerId);
  if (!provider || !provider.enabled) {
    throw new Error(`Provider for avatar model is disabled or not found`);
  }

  // Get API key from the model's provider
  const defaultKey = providerApiKeyRepo.getDefault(provider.id);
  const apiKey = defaultKey?.apiKey ?? provider.apiKey;
  if (!apiKey) {
    throw new Error(`No API key configured for provider "${provider.name}" — add one in Providers`);
  }

  // Resolve base URL
  let apiBase: string;
  if (provider.baseUrl) {
    apiBase = provider.baseUrl.replace(/\/$/, '');
  } else if (provider.type === 'openai') {
    apiBase = 'https://api.openai.com/v1';
  } else if (provider.type === 'openrouter') {
    apiBase = 'https://openrouter.ai/api/v1';
  } else if (provider.type === 'anthropic') {
    apiBase = 'https://api.anthropic.com/v1';
  } else {
    apiBase = 'https://openrouter.ai/api/v1';
  }

  // Build prompt from settings (with {{subject}} placeholder)
  const promptTemplate = settingsRepo.get('avatar_prompt') || DEFAULT_AVATAR_PROMPT;
  const subjectDesc = kind === 'user'
    ? `a ${opts.description || 'human user'} named "${name}" with the role "${opts.role}"`
    : `an AI agent named "${name}" whose role is ${opts.role}`;
  const prompt = promptTemplate.replace(/\{\{subject\}\}/g, subjectDesc);

  const response = await fetch(`${apiBase}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: avatarModelId,
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(120_000),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`OpenRouter API error ${response.status}: ${text}`);
  }

  const data = await response.json() as {
    choices?: Array<{
      message?: {
        content?: string | null;
      };
    }>;
    images?: Array<{ type: string; image_url: { url: string } }>;
  };

  // Check for images in the response (top-level or in choices)
  let base64Data: string | null = null;

  // Check top-level images array
  if (data.images && Array.isArray(data.images) && data.images.length > 0) {
    const imgUrl = data.images[0].image_url?.url;
    if (imgUrl) {
      const match = imgUrl.match(/^data:image\/[^;]+;base64,(.+)$/);
      if (match) base64Data = match[1];
    }
  }

  // Check choices for images (message.images array or inline content)
  if (!base64Data && data.choices) {
    for (const choice of data.choices) {
      // Check message.images array (GPT-5 Image format)
      const msgImages = (choice.message as any)?.images;
      if (Array.isArray(msgImages) && msgImages.length > 0) {
        const imgUrl = msgImages[0].image_url?.url;
        if (imgUrl) {
          const m = imgUrl.match(/^data:image\/[^;]+;base64,(.+)$/);
          if (m) { base64Data = m[1]; break; }
        }
      }

      const content = choice.message?.content;
      if (typeof content === 'string') {
        const match = content.match(/data:image\/[^;]+;base64,([A-Za-z0-9+/=]+)/);
        if (match) {
          base64Data = match[1];
          break;
        }
      }
      // Check if content is an array with image parts (multimodal response)
      if (Array.isArray(content)) {
        for (const part of content as any[]) {
          if (part.type === 'image_url' && part.image_url?.url) {
            const m = part.image_url.url.match(/^data:image\/[^;]+;base64,(.+)$/);
            if (m) { base64Data = m[1]; break; }
          }
        }
        if (base64Data) break;
      }
    }
  }

  if (!base64Data) {
    throw new Error('No image data found in API response');
  }

  const original = Buffer.from(base64Data, 'base64');

  // Generate resized variants
  const md = await sharp(original).resize(256, 256).png().toBuffer();
  const sm = await sharp(original).resize(64, 64).png().toBuffer();

  // Ensure avatar directory exists and write all sizes
  const avatarDir = getAvatarDir();
  await mkdir(avatarDir, { recursive: true });
  await Promise.all([
    writeFile(getAvatarPath(name, 'lg', kind), original),
    writeFile(getAvatarPath(name, 'md', kind), md),
    writeFile(getAvatarPath(name, 'sm', kind), sm),
  ]);

  return original;
}
