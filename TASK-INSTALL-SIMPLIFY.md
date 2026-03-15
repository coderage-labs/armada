# Task: Installation Simplification

## Summary
Remove legacy auth tokens, auto-detect WebAuthn config, expand setup wizard.

## Part 1: Remove ARMADA_API_TOKEN + ARMADA_HOOKS_TOKEN

### `packages/control/src/middleware/auth.ts`
1. **Delete** the entire `getToken()` function (lines 28-48) and `apiToken` variable (line 26)
2. **Delete** the `getApiToken()` export function (lines 56-58)
3. **Delete** section 3 "Fallback: legacy ARMADA_API_TOKEN / ARMADA_HOOKS_TOKEN" (lines 170-195) — the entire `if (token === getToken() || ...)` block
4. After these removals, if no auth matches, the existing 401 at the bottom of the function handles it
5. **Remove** imports: `existsSync`, `readFileSync`, `writeFileSync` from `node:fs` and `randomBytes` from `node:crypto` — BUT only if not used elsewhere in the file. Check first.
6. **Remove** the `armada-token.txt` file generation logic entirely

### `packages/control/src/services/config-generator.ts`
- Line 261: Replace `process.env.ARMADA_API_TOKEN || ''` — this is used for agent instance config generation. Agent instances need a token to call back to the control plane. Instead of using the global token, generate a per-instance token in the DB when an instance is created. For NOW, just remove the reference and leave `armadaApiToken: ''` — instances will use their own DB token.

### `packages/control/src/templates/config-generator.ts`
- Line 97: `armadaApiToken: process.env.ARMADA_API_TOKEN || ''` — same as above, set to `''`
- Line 23: `hooksToken` generation is fine — it's per-instance, not the global env var

### `packages/control/src/services/triage.ts`
- Line 23: `const HOOKS_TOKEN = process.env.ARMADA_HOOKS_TOKEN || '';` — DELETE this line. It's never used in this file.

### `docker-compose.yml`
- Remove `ARMADA_API_TOKEN` from environment
- Remove `ARMADA_HOOKS_TOKEN` from environment

### `.env.example`
- Remove `ARMADA_API_TOKEN`
- Remove `ARMADA_HOOKS_TOKEN`

## Part 2: Auto-detect RP ID + Origin

### `packages/control/src/services/auth-service.ts`
Replace the module-level constants:
```typescript
// BEFORE (lines 36-37):
export const rpID = process.env.ARMADA_RP_ID || 'localhost';
export const origin = process.env.ARMADA_ORIGIN || 'http://localhost:3001';

// AFTER:
import { settingsRepo } from '../repositories/settings-repo.js';
import type { Request } from 'express';

export function getRpId(req?: Request): string {
  // Env override always wins (for reverse proxy edge cases)
  if (process.env.ARMADA_RP_ID) return process.env.ARMADA_RP_ID;
  // Single env var that derives both
  if (process.env.ARMADA_PUBLIC_URL) {
    try { return new URL(process.env.ARMADA_PUBLIC_URL).hostname; } catch {}
  }
  // DB setting (set during setup wizard or auto-detected)
  const stored = settingsRepo.get('rp_id');
  if (stored) return stored;
  // Auto-detect from request
  if (req) {
    const host = (req.headers['x-forwarded-host'] as string || req.hostname || '').split(':')[0];
    if (host && host !== 'localhost' && host !== '127.0.0.1') {
      settingsRepo.set('rp_id', host);
      return host;
    }
    return host || 'localhost';
  }
  return 'localhost';
}

export function getOrigin(req?: Request): string {
  if (process.env.ARMADA_ORIGIN) return process.env.ARMADA_ORIGIN;
  if (process.env.ARMADA_PUBLIC_URL) return process.env.ARMADA_PUBLIC_URL.replace(/\/+$/, '');
  const stored = settingsRepo.get('origin');
  if (stored) return stored;
  if (req) {
    const proto = req.headers['x-forwarded-proto'] as string || req.protocol || 'http';
    const host = req.headers['x-forwarded-host'] as string || req.get('host') || 'localhost:3001';
    const origin = `${proto}://${host}`;
    if (!host.startsWith('localhost') && !host.startsWith('127.0.0.1')) {
      settingsRepo.set('origin', origin);
    }
    return origin;
  }
  return 'http://localhost:3001';
}
```

### Update all call sites of `rpID` and `origin` in auth-service.ts
The functions that use these are:
- `createPasskeyRegisterOptions` — receives `req` already? Check. If not, add `req: Request` parameter.
- `verifyPasskeyRegistration` — same
- `createPasskeyLoginOptions` — same  
- `verifyPasskeyLogin` — same
- `createInviteLink` — uses `origin` for URL building

For each, replace `rpID` with `getRpId(req)` and `origin` with `getOrigin(req)`. 

Then update the ROUTE callers in `packages/control/src/routes/auth.ts` to pass `req` to these functions.

### `packages/control/src/app.ts` — CORS
Replace the hardcoded origin array with a dynamic check:
```typescript
app.use(cors({
  origin: (requestOrigin, callback) => {
    // Always allow localhost dev
    if (!requestOrigin || requestOrigin.startsWith('http://localhost')) {
      callback(null, true);
      return;
    }
    const allowed = getOrigin();
    callback(null, requestOrigin === allowed);
  },
  credentials: true,
}));
```
Import `getOrigin` from auth-service.

### Setup cookie secure flag
In `routes/auth.ts`, the setup endpoint sets cookie with `secure: origin.startsWith('https')`. Change to `secure: getOrigin(req).startsWith('https')`.

## Part 3: Setup Wizard — Add URL Check + AI Provider Steps

### Backend: New endpoints in `routes/auth.ts`

```typescript
// GET /api/auth/setup-status — expand to include new status fields
router.get('/setup-status', (req, res) => {
  const hasHumanUsers = !checkSetupNeeded();
  const urlConfirmed = !!settingsRepo.get('rp_id');
  const hasProvider = modelProvidersHaveKeys(); // check if any provider has an API key
  res.json({
    needsSetup: !hasHumanUsers,
    urlConfirmed,
    hasProvider,
  });
});

// GET /api/auth/detected-url — returns auto-detected URL info (public, no auth during setup)
router.get('/detected-url', (req, res) => {
  const proto = req.headers['x-forwarded-proto'] as string || req.protocol;
  const host = req.headers['x-forwarded-host'] as string || req.get('host');
  const detectedUrl = `${proto}://${host}`;
  const storedRpId = settingsRepo.get('rp_id');
  const storedOrigin = settingsRepo.get('origin');
  res.json({
    detectedUrl,
    detectedHost: (host || '').split(':')[0],
    isLocalhost: !host || host.startsWith('localhost') || host.startsWith('127.0.0.1'),
    stored: storedRpId ? { rpId: storedRpId, origin: storedOrigin } : null,
  });
});

// POST /api/auth/confirm-url — save the public URL (public during setup only)
router.post('/confirm-url', (req, res) => {
  // Only allow during setup or by authenticated owner
  if (!checkSetupNeeded() && (!req.caller || req.caller.role !== 'owner')) {
    res.status(403).json({ error: 'Only owner can change URL after setup' });
    return;
  }
  const { url } = req.body;
  if (!url) { res.status(400).json({ error: 'url is required' }); return; }
  try {
    const parsed = new URL(url);
    settingsRepo.set('rp_id', parsed.hostname);
    settingsRepo.set('origin', `${parsed.protocol}//${parsed.host}`);
    settingsRepo.set('ui_url', url.replace(/\/+$/, ''));
    res.json({ ok: true, rpId: parsed.hostname, origin: `${parsed.protocol}//${parsed.host}` });
  } catch {
    res.status(400).json({ error: 'Invalid URL' });
  }
});
```

Add `/api/auth/detected-url` and `/api/auth/confirm-url` to the auth skip list in the auth middleware (same as setup-status).

### Backend: Helper to check if any provider has keys
In providers route or a shared helper:
```typescript
function modelProvidersHaveKeys(): boolean {
  // Check provider_api_keys table for any rows
  const count = getDrizzle().select({ id: providerApiKeys.id }).from(providerApiKeys).limit(1).all();
  return count.length > 0;
}
```
Import `providerApiKeys` from drizzle schema. Export this from somewhere accessible by auth routes.

### Backend: Quick provider setup endpoint
We need a simplified endpoint for the wizard to create a provider + key in one call.

```typescript
// POST /api/auth/setup-provider — quick provider setup (during setup only)
router.post('/setup-provider', (req, res) => {
  // Must be authenticated (wizard creates account first)
  if (!req.caller) { res.status(401).json({ error: 'Auth required' }); return; }
  
  const { providerId, apiKey } = req.body;
  if (!providerId || !apiKey) { res.status(400).json({ error: 'providerId and apiKey required' }); return; }
  
  // Find the seeded provider
  const provider = getDrizzle().select().from(modelProviders).where(eq(modelProviders.id, providerId)).get();
  if (!provider) { res.status(404).json({ error: 'Provider not found' }); return; }
  
  // Insert API key — schema: id, providerId, name, apiKey, isDefault, priority, createdAt
  getDrizzle().insert(providerApiKeys).values({
    id: randomUUID(),
    providerId,
    name: `${provider.name} key`,
    apiKey: apiKey,
    isDefault: 1,
    priority: 1,
    createdAt: sql`strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
  }).run();
  
  res.status(201).json({ ok: true });
});
```

### Frontend: `packages/ui/src/pages/SetupWizard.tsx`

Expand steps from 4 to 6:
```typescript
type Step = 'welcome' | 'account' | 'passkey' | 'url-check' | 'provider' | 'complete';
const STEPS: Step[] = ['welcome', 'account', 'passkey', 'url-check', 'provider', 'complete'];
```

Update `StepIndicator` labels to: `['Welcome', 'Account', 'Passkey', 'URL', 'AI Provider', 'Done']`

**Step 4: URL Check** (after passkey):
- On mount, fetch `GET /api/auth/detected-url`
- Show detected URL in an input field (editable)
- If `isLocalhost`, show green checkmark "Localhost detected — works out of the box"  
- If not localhost, show the URL and a "Confirm" button
- "Confirm" calls `POST /api/auth/confirm-url` with the URL
- Skip button: "I'll set this later →"

**Step 5: AI Provider** (after URL):
- Show 4 provider cards: Anthropic, OpenAI, OpenRouter, Ollama
- Clicking one reveals an API key input
- "Add Provider" calls `POST /api/auth/setup-provider` with `{ providerId, apiKey }`
- Skip button: "Skip for now →"
- Provider IDs come from the seeded providers — fetch them: need to know the IDs. Check the seed data.

**Step 6: Done** (enhanced):
- Show a checklist of what was configured
- "Go to Dashboard →"

### Seeded provider IDs
Check what providers are seeded:
```bash
grep -A5 "anthropic\|openai\|openrouter\|ollama" packages/control/src/db/seed.ts
```
Use the actual IDs from the seed.

## Part 4: Cleanup

### `docker-compose.yml`
Remove these env vars:
- `ARMADA_API_TOKEN`
- `ARMADA_HOOKS_TOKEN` 
- `ARMADA_RP_ID`
- `ARMADA_ORIGIN`
- `ARMADA_UI_URL`
- `ARMADA_OPERATOR_NAME`

Add optional:
- `# ARMADA_PUBLIC_URL=https://armada.example.com`

### `.env.example`
Strip to minimal:
```
# Armada Configuration
# All settings are configured via the browser setup wizard.
# These env vars are optional overrides for advanced setups.

# Public URL (auto-detected from first request if not set)
# ARMADA_PUBLIC_URL=https://armada.example.com

# Database path (default: ./armada.db)
# ARMADA_DB_PATH=./armada.db
```

### `.env` file (the actual one)
Update to match — remove all the tokens and RP vars.

## Rules
- Do NOT rewrite files from scratch — surgical edits only
- Run `npx tsc --noEmit` in both `packages/control` and `packages/ui` before committing
- Keep all existing env vars working as overrides (backwards compat)
- The setup wizard styling should match the existing gradient/card style (inline styles, not tailwind — match what's there)
- Commit message: `feat: simplify installation — remove legacy tokens, auto-detect URL, expand setup wizard`
- Do NOT push to git
