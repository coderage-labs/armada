# Armada Installation Simplification

> **Goal:** Reduce the friction of installing the Armada control plane from "copy `.env`, fill in 10+ variables, run docker-compose" to "one command, answer a few questions in the browser."

---

## Table of Contents

1. [Current Environment Variable Inventory](#1-current-environment-variable-inventory)
2. [Recommendations per Variable](#2-recommendations-per-variable)
3. [Auto-Detection Opportunities](#3-auto-detection-opportunities)
4. [Expanded Setup Wizard Spec](#4-expanded-setup-wizard-spec)
5. [Simplified Installation Commands](#5-simplified-installation-commands)
6. [Competitor Approach Comparison](#6-competitor-approach-comparison)
7. [Migration Path](#7-migration-path)

---

## 1. Current Environment Variable Inventory

### Control Plane (`packages/control`)

All `process.env` references found via audit:

| Variable | Where Used | Default | Boot Required? | Category |
|---|---|---|---|---|
| `PORT` | `index.ts`, `ws/gateway-handler.ts` | `3001` | ✅ Yes | Infrastructure |
| `NODE_ENV` | `index.ts`, `app.ts` | — | ✅ Yes | Infrastructure |
| `ARMADA_API_TOKEN` | `middleware/auth.ts`, `services/config-generator.ts`, `templates/config-generator.ts` | Auto-generated | ❌ No (auto-generates) | Auth |
| `ARMADA_HOOKS_TOKEN` | `middleware/auth.ts`, `services/triage.ts` | Falls back to `ARMADA_API_TOKEN` | ❌ No | Auth |
| `ARMADA_NODE_TOKEN` | docker-compose → node env | — | ❌ No | Auth |
| `ARMADA_API_URL` | Multiple services (agent-message, task-dispatcher, triage, workflow-dispatcher, config-generator) | `http://armada-control:3001` | ❌ No (good default) | Networking |
| `ARMADA_UI_URL` | `services/user-notifier.ts` | `http://localhost:3001` | ❌ No | Networking |
| `ARMADA_DEFAULT_NODE_URL` | `docker-compose` → node env | `http://armada-node:8080` | ❌ No | Networking |
| `ARMADA_DEFAULT_NODE_ID` | `infrastructure/node-client.ts` | `default` | ❌ No | Networking |
| `ARMADA_AGENT_GATEWAY_URL` | `services/config-generator.ts` | `http://armada-node-agent:3002` | ❌ No | Networking |
| `ARMADA_CONTROL_URL` | `templates/config-generator.ts` | Alias for `ARMADA_API_URL` | ❌ No | Networking |
| `ARMADA_AGENT_PROXY_URL` | `templates/config-generator.ts` | `''` | ❌ No | Networking |
| `ARMADA_RP_ID` | `services/auth-service.ts` | `localhost` | ⚠️ Pre-DB (but auto-detectable) | WebAuthn |
| `ARMADA_RP_NAME` | `services/auth-service.ts` | `Armada Control` | ⚠️ Pre-DB (but moveable) | WebAuthn |
| `ARMADA_ORIGIN` | `services/auth-service.ts`, `app.ts` CORS | `http://localhost:3001` | ⚠️ Pre-DB (but auto-detectable) | WebAuthn |
| `ARMADA_OPERATOR_NAME` | `middleware/auth.ts`, `routes/tasks.ts`, `services/agent-message-service.ts` | `operator` | ❌ No | Auth |
| `ARMADA_DB_PATH` | `db/index.ts`, `services/avatar-generator.ts` | `./armada.db` | ✅ Yes | Storage |
| `ARMADA_PLUGINS_PATH` | `routes/plugins.ts` | `/data/armada/plugins` | ✅ Yes (dir creation) | Storage |
| `GITHUB_TOKEN` | `services/github-sync.ts`, `services/version-checker.ts` | — | ❌ No (optional) | Integration |
| `TELEGRAM_BOT_TOKEN` | `services/telegram-bot.ts` | — | ❌ No (optional, skipped if unset) | Integration |
| `ANTHROPIC_API_KEY` | `services/credential-sync.ts` | — | ❌ No (for agent credential injection) | Integration |
| `GATEWAY_LOOPBACK_HOST` | `ws/gateway-handler.ts` | `localhost` | ❌ No | Networking |
| `ARMADA_AVATAR_MODEL` | `docker-compose` → app env | `openai/dall-e-3` | ❌ No | Config |

### Node Agent (docker-compose / node container)

| Variable | Purpose | Default |
|---|---|---|
| `ARMADA_NODE_TOKEN` | Auth token for connecting to control plane | — |
| `ARMADA_CONTROL_URL` | WebSocket URL for control plane | `ws://armada-control:3001/api/nodes/ws` |

---

## 2. Recommendations per Variable

### 🟢 Keep as Env Var (infrastructure / boot-time only)

| Variable | Reason |
|---|---|
| `PORT` | Container infrastructure — must be known before the app can listen |
| `NODE_ENV` | Build/runtime mode affects which code paths run |
| `ARMADA_DB_PATH` | DB location needed before DB exists |
| `ARMADA_PLUGINS_PATH` | Directory created at startup |

### 🔵 Auto-Generate / Auto-Detect (remove from required env)

| Variable | Strategy |
|---|---|
| `ARMADA_API_TOKEN` | **Already auto-generates** into `armada-token.txt` if not set. Document this and make it the default path. Never require it in `.env`. |
| `ARMADA_HOOKS_TOKEN` | Already defaults to `ARMADA_API_TOKEN`. Keep as-is. |
| `ARMADA_NODE_TOKEN` | Auto-generate on first boot, store in DB, expose via UI for node registration. Remove from `.env`. |
| `ARMADA_RP_ID` | **Auto-detect from `req.hostname`** on first passkey operation (see §3). Store in `settings` table once detected. Fall back to env if explicitly set. |
| `ARMADA_ORIGIN` | **Auto-detect from `req.protocol + '://' + req.get('host')`**. Same strategy as RP ID. |
| `ARMADA_RP_NAME` | Move to DB settings. Default to `"Armada"`. Configurable in UI. |
| `ARMADA_UI_URL` | Auto-detect from origin. Store in settings if overridden. |
| `ARMADA_API_URL` | Default `http://armada-control:3001` is correct for docker-compose. Remove from `.env`. |
| `ARMADA_AVATAR_MODEL` | Move to DB settings. Already partially supported via `settings.avatar_model_id`. |

### 🟡 Move to DB / Setup Wizard (configure post-first-boot via UI)

| Variable | Wizard Step | Priority |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | "Integrations" step or post-setup Settings | Medium |
| `GITHUB_TOKEN` | "Integrations" step or post-setup Settings | Medium |
| `ANTHROPIC_API_KEY` | "Model Providers" step | High — needed to run agents |
| `ARMADA_OPERATOR_NAME` | Auto-set to the first user's username | Low |

### 🔴 Remove Entirely

| Variable | Reason |
|---|---|
| `ARMADA_DEFAULT_NODE_URL` | Node registers itself via WebSocket; no need to pre-configure URL |
| `ARMADA_AGENT_GATEWAY_URL` | Internal routing detail — hardcode sensible default |
| `ARMADA_CONTROL_URL` | Alias/duplicate — collapse into `ARMADA_API_URL` |
| `ARMADA_AGENT_PROXY_URL` | Only used in template generation — default to empty |

### Minimal `.env` after simplification

```dotenv
# Armada — Minimal Configuration
# For advanced overrides only. Armada works out of the box without this file.

# Uncomment to override the auto-detected public URL (used for WebAuthn + links):
# ARMADA_PUBLIC_URL=https://armada.example.com

# Uncomment to pin the API token (default: auto-generated into armada-token.txt):
# ARMADA_API_TOKEN=your-secret-token
```

That's it. Two optional variables for power users.

---

## 3. Auto-Detection Opportunities

### 3.1 RP ID and Origin from Request

WebAuthn `rpID` must match the domain the browser is on. Currently this requires `ARMADA_RP_ID` and `ARMADA_ORIGIN` to be set correctly — a common install failure point.

**Proposed approach:**

```typescript
// In auth-service.ts

// Lazy-detected values — populated on first passkey operation
let _detectedRpId: string | null = null;
let _detectedOrigin: string | null = null;

export function getRpId(req?: Request): string {
  // 1. Explicit env override (power users / reverse proxy situations)
  if (process.env.ARMADA_RP_ID) return process.env.ARMADA_RP_ID;
  
  // 2. DB-stored value (set on first passkey registration)
  const stored = settingsRepo.get('rp_id');
  if (stored) return stored;
  
  // 3. Auto-detect from request hostname
  if (req) {
    const host = req.hostname; // Express strips port
    settingsRepo.set('rp_id', host); // Store for subsequent calls
    return host;
  }
  
  return 'localhost';
}

export function getOrigin(req?: Request): string {
  if (process.env.ARMADA_ORIGIN) return process.env.ARMADA_ORIGIN;
  
  const stored = settingsRepo.get('origin');
  if (stored) return stored;
  
  if (req) {
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers['x-forwarded-host'] || req.get('host');
    const origin = `${protocol}://${host}`;
    settingsRepo.set('origin', origin);
    return origin;
  }
  
  return 'http://localhost:3001';
}
```

Pass `req` to these functions from the passkey registration/login routes.

**Reset path:** If the domain changes, user can clear `rp_id`/`origin` from settings, or set env vars to override.

### 3.2 Auto-Generate Node Token on First Boot

Instead of requiring `ARMADA_NODE_TOKEN` in the env:

```typescript
// In a boot-time setup step (before the server starts listening)
async function ensureNodeToken() {
  const existing = settingsRepo.get('default_node_token');
  if (!existing) {
    const token = randomBytes(32).toString('hex');
    settingsRepo.set('default_node_token', token);
    console.log('🔑 Generated default node token (see Settings → Nodes)');
  }
}
```

The node container then fetches its token from the control plane on first registration, rather than needing it pre-configured.

### 3.3 Single `ARMADA_PUBLIC_URL` Replaces Three Variables

Instead of `ARMADA_UI_URL`, `ARMADA_RP_ID`, `ARMADA_ORIGIN` as separate vars:

```dotenv
# One variable to rule them all
ARMADA_PUBLIC_URL=https://armada.example.com
```

The app derives all three from this single URL:
- `rpID` = hostname from `ARMADA_PUBLIC_URL`
- `origin` = `ARMADA_PUBLIC_URL` (no trailing slash)
- `ui_url` = `ARMADA_PUBLIC_URL`

When `ARMADA_PUBLIC_URL` is not set, auto-detect from the first request.

---

## 4. Expanded Setup Wizard Spec

The current wizard covers: **Welcome → Account → Passkey → Done** (4 steps).

### Proposed Expanded Wizard

**Philosophy:** Keep the "happy path" short (3 steps to get a working install), then offer optional configuration post-setup. Don't block on optional integrations.

```
Welcome → Account → Passkey → URL Check → AI Provider → Done
                                  ↑                ↑
                             (new step)        (new step)
```

---

### Step 1: Welcome *(unchanged)*

Current implementation is fine.

---

### Step 2: Create Owner Account *(unchanged)*

Username + display name. Already good.

---

### Step 3: Secure with Passkey *(unchanged)*

Keep passkey registration. Skip option preserved.

---

### Step 4: URL Check *(new — required for production)*

**Purpose:** Verify (or set) the public URL — needed for WebAuthn to work outside localhost.

```
┌─────────────────────────────────────────────────────┐
│  🌐  Your Control Plane URL                          │
│                                                     │
│  Auto-detected: https://armada.coderage.co.uk       │
│  ┌─────────────────────────────────────────────┐    │
│  │ https://armada.coderage.co.uk               │    │
│  └─────────────────────────────────────────────┘    │
│                                                     │
│  ✅ This URL is used for:                            │
│  • Passkey authentication (WebAuthn)                │
│  • Links in notifications                           │
│  • Node agent connections                           │
│                                                     │
│  ⚠️  Wrong URL = passkeys won't work on other devices │
│                                                     │
│  [ Confirm URL ]    [ I'll set this later ]         │
└─────────────────────────────────────────────────────┘
```

**Backend action:** Stores `ARMADA_PUBLIC_URL` in settings table. Updates `rp_id`, `origin`, `ui_url` from it.

**Skip:** If running on localhost, auto-skip this step.

---

### Step 5: Add Your First AI Provider *(new — recommended)*

**Purpose:** Without a model provider, agents can't run. This should be done before the user hits the dashboard.

```
┌─────────────────────────────────────────────────────┐
│  🤖  Add an AI Provider                             │
│                                                     │
│  Choose your primary AI provider:                   │
│                                                     │
│  ┌──────────────────┐  ┌──────────────────┐         │
│  │  🟣 Anthropic    │  │  🟢 OpenAI       │         │
│  │  Claude models   │  │  GPT models      │         │
│  └──────────────────┘  └──────────────────┘         │
│                                                     │
│  ┌──────────────────┐  ┌──────────────────┐         │
│  │  🌐 OpenRouter   │  │  🏠 Ollama       │         │
│  │  100+ models     │  │  Local models    │         │
│  └──────────────────┘  └──────────────────┘         │
│                                                     │
│  API Key: [_____________________________]           │
│                                                     │
│  [ Add Provider ]    [ Skip for now ]               │
└─────────────────────────────────────────────────────┘
```

**Backend action:** Creates a `model_providers` record with the API key in `provider_api_keys`. Sets a default model.

**Skip:** Allowed. User can add via Settings → Providers later.

---

### Step 6: Done *(enhanced)*

Currently just "Go to Dashboard". Enhance to show next steps:

```
┌─────────────────────────────────────────────────────┐
│  ✅  Armada is Ready!                               │
│                                                     │
│  Welcome, Chris. Here's what to do next:            │
│                                                     │
│  ◻  Add a node agent         → Nodes → Add Node    │
│  ◻  Create your first agent  → Agents → New        │
│  ◼  Add a Telegram bot       → Settings → Telegram │
│                                                     │
│  [ Go to Dashboard → ]                              │
└─────────────────────────────────────────────────────┘
```

---

### Post-Wizard: Settings Sections (not blocking setup)

These don't belong in the wizard — too much friction. Put them in **Settings** with clear status indicators:

| Integration | Settings Location | Status Indicator |
|---|---|---|
| Telegram Bot | Settings → Notifications → Telegram | 🔴 Not configured / 🟢 Connected |
| SMTP / Email | Settings → Notifications → Email | 🔴 Not configured / 🟢 Connected |
| GitHub | Settings → Integrations → GitHub | Via OAuth or personal token |
| Avatar generation | Settings → Appearance | Shows model picker if provider exists |
| Workspace retention | Settings → Storage | Default 30 days |

---

## 5. Simplified Installation Commands

### Option A: Single `docker run` (simplest possible)

```bash
docker run -d \
  --name armada \
  -p 3001:3001 \
  -v armada-data:/data \
  -v /var/run/docker.sock:/var/run/docker.sock \
  --restart unless-stopped \
  ghcr.io/coderage-labs/armada:latest
```

Then open `http://localhost:3001` and complete the setup wizard.

**What this gives you:**
- Control plane + embedded node agent in one container
- Auto-generated API token (printed to logs on first boot)
- SQLite database at `/data/armada.db`
- WebAuthn works on localhost out of the box

**Limitations vs docker-compose:** The embedded node runs in the same container (fine for single-machine setups). Add remote nodes later via the UI.

---

### Option B: Docker Compose (current, simplified)

```yaml
# docker-compose.yml — copy this file, nothing else needed
services:
  armada:
    image: ghcr.io/coderage-labs/armada:latest
    ports:
      - "3001:3001"
    volumes:
      - armada-data:/data
      - /var/run/docker.sock:/var/run/docker.sock
    restart: unless-stopped
    # Optional: set your public URL for production
    # environment:
    #   - ARMADA_PUBLIC_URL=https://armada.example.com

volumes:
  armada-data:
```

```bash
curl -fsSL https://armada.example.com/install/compose | docker-compose -f - up -d
```

Or the absolute minimal:

```bash
docker-compose up -d
# Open http://localhost:3001
```

---

### Option C: curl install script (for VPS / bare Docker host)

```bash
curl -fsSL https://get.armada.sh | bash
```

Script logic:
1. Check Docker is installed
2. Pull `ghcr.io/coderage-labs/armada:latest`
3. Start with minimal options (port 3001, data volume)
4. Print the URL and "open your browser to complete setup"
5. Optionally: detect if a reverse proxy is running (nginx, caddy) and offer to configure it

---

### Node Agent Install *(already good, minor tweak)*

Current:
```bash
curl https://armada.example.com/install | bash -s -- --token <token>
```

Improvement: Token can be a one-time install token generated in the UI (Nodes → Add Node → Generate Install Token), not the main API token. This already looks like it's the intent based on the install script wording.

---

## 6. Competitor Approach Comparison

### Portainer

```bash
docker run -d \
  -p 8000:8000 \
  -p 9443:9443 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v portainer_data:/data \
  portainer/portainer-ce:latest
```

**What we can steal:**
- Single `docker run` with minimal flags — works on any Docker host
- Data volume for persistence
- No env vars required on first run
- Setup wizard completes initial admin account creation in the browser
- TLS handled by the app itself (self-signed cert on 9443)

**Lesson:** Zero required configuration. Everything deferred to the browser UI.

---

### Coolify

```bash
curl -fsSL https://cdn.coollabs.io/coolify/install.sh | bash
```

**What we can steal:**
- Single curl command is the primary install path
- Script handles: Docker install check, pull, start, Traefik proxy setup, SSL via Let's Encrypt
- "Server" concept allows multi-node management from day one
- First-run setup wizard in the browser handles all remaining config

**Lesson:** The curl script should be smart — check prerequisites, offer to install them, then open the browser. The browser wizard handles the rest.

---

### Dokku

```bash
wget -NP . https://dokku.com/install/v0.35.2/bootstrap.sh
sudo DOKKU_TAG=v0.35.2 bash bootstrap.sh
```

**What we can steal:**
- Bash-only install, no Docker required for the install script itself
- Post-install web setup for SSH key configuration
- Versioned install scripts (good for upgrades)

**Lesson:** Provide versioned install scripts. Pin to a release, don't always `latest`.

---

### n8n

```bash
docker run -it --rm \
  --name n8n \
  -p 5678:5678 \
  -v ~/.n8n:/home/node/.n8n \
  docker.n8n.io/n8nio/n8n
```

**What we can steal:**
- Home directory volume is intuitive (`~/.n8n` vs `/data/armada`)
- Works without any env vars for local dev
- `N8N_BASIC_AUTH_USER` / `N8N_BASIC_AUTH_PASSWORD` optional for remote deploy
- First run creates admin account in browser

**Lesson:** Use `~/.armada` as the default data directory for local installs. More intuitive than `/data`.

---

### Summary: What Armada Should Adopt

| Feature | Portainer | Coolify | Dokku | n8n | Armada Now | Armada Target |
|---|---|---|---|---|---|---|
| Zero required env vars | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ |
| Single docker run | ✅ | ❌ | ❌ | ✅ | ❌ | ✅ |
| curl install script | ❌ | ✅ | ✅ | ❌ | ❌ (planned) | ✅ |
| Browser setup wizard | ✅ | ✅ | ✅ | ✅ | ✅ (4 steps) | ✅ (6 steps) |
| Auto-detect domain/URL | ❌ | ✅ | N/A | ❌ | ❌ | ✅ |
| Model provider setup | N/A | N/A | N/A | ✅ | ❌ | ✅ |
| Single container option | ✅ | ✅ | N/A | ✅ | ❌ | ✅ |

---

## 7. Migration Path

### Phase 1: Auto-generation (low risk, no breaking changes)

**Changes required:**

1. **`ARMADA_API_TOKEN` — already done.** Auth middleware auto-generates into `armada-token.txt`. Document this clearly. Remove it from `.env.example` as a required field.

2. **`ARMADA_NODE_TOKEN` — generate on boot.**
   - In `index.ts` startup, call `ensureNodeToken()` before starting services
   - Store in `settings` table under key `default_node_token`
   - Pass to node container via `ARMADA_CONTROL_URL` on first connect (node can request a token in its registration handshake)
   - Remove from `.env.example`

3. **Update `.env.example`** — strip to the 2-variable minimal version shown in §2.

---

### Phase 2: Auto-detect RP ID + Origin (medium risk — affects WebAuthn)

**Changes required:**

1. **`services/auth-service.ts`** — Replace module-level constants with lazy functions:
   ```typescript
   // BEFORE
   export const rpID = process.env.ARMADA_RP_ID || 'localhost';
   export const origin = process.env.ARMADA_ORIGIN || 'http://localhost:3001';
   
   // AFTER
   export function getRpId(req?: Request): string { /* see §3.1 */ }
   export function getOrigin(req?: Request): string { /* see §3.1 */ }
   ```

2. **All call sites of `rpID` and `origin`** — pass `req` where available:
   - `createPasskeyRegisterOptions(caller, req)`
   - `verifyPasskeyRegistration(caller, body, req)`
   - `createPasskeyLoginOptions(req)`
   - `verifyPasskeyLogin(body, req)`
   - `createInviteLink(...)` uses `origin` for invite URL

3. **`app.ts` CORS** — update to use auto-detected origin:
   ```typescript
   // BEFORE
   origin: ['http://localhost:5173', process.env.ARMADA_ORIGIN || '...']
   
   // AFTER
   origin: (origin, callback) => {
     const allowedOrigin = getOrigin(); // from settings or env
     callback(null, [allowedOrigin, 'http://localhost:5173'].includes(origin));
   }
   ```

4. **Setup wizard Step 4 (URL Check)** — new API endpoint:
   - `GET /api/auth/detected-url` — returns `{ url, rpId, origin, source: 'auto'|'env'|'db' }`
   - `POST /api/auth/confirm-url` — saves to settings, no auth required during setup
   - Add to setup-status check: wizard not complete until URL confirmed (or explicitly skipped)

5. **Remove from `docker-compose.yml`:**
   ```yaml
   # Remove these lines:
   - ARMADA_RP_ID=${ARMADA_RP_ID:-localhost}
   - ARMADA_ORIGIN=${ARMADA_ORIGIN:-http://localhost:3001}
   ```

---

### Phase 3: Single container option (medium effort)

**Changes required:**

1. **New Dockerfile: `docker/Dockerfile.all-in-one`**
   - Base: control plane Dockerfile
   - Add node agent binary
   - Entrypoint starts both: `supervisord` or simple shell script

2. **Embedded node registration** — on startup, control plane checks if `ARMADA_EMBEDDED_NODE=true`, registers a local node pointing to `localhost:8080` automatically.

3. **Published as `armada:latest`** (all-in-one) vs `armada-control:latest` + `armada-node:latest` (separate).

4. **`/install` script** — detect embedded vs separate mode, adjust instructions.

---

### Phase 4: Expanded setup wizard (UI changes)

**Files to modify:**
- `packages/ui/src/pages/SetupWizard.tsx` — add Step 4 (URL Check) and Step 5 (AI Provider)
- `packages/control/src/routes/auth.ts` — add `/api/auth/detected-url` and `/api/auth/confirm-url` endpoints
- `packages/control/src/routes/settings.ts` — ensure `rp_id`, `origin`, `ui_url` are settable

**New API endpoints needed:**
```
GET  /api/auth/detected-url          → { url, rpId, origin, confirmed: bool }
POST /api/auth/confirm-url           → { url }  — saves to settings
GET  /api/auth/setup-status          → add { urlConfirmed, hasProvider } fields
```

**Setup status evolution:**
```typescript
// Currently
{ needsSetup: boolean }

// After expansion
{
  needsSetup: boolean,      // no human users exist
  urlConfirmed: boolean,    // ARMADA_PUBLIC_URL stored in settings (skip on localhost)
  hasProvider: boolean,     // at least one model provider configured
}
```

The wizard shows steps based on `setup-status`. If `urlConfirmed` is false and we're not on localhost, show the URL step. If `hasProvider` is false, show the AI provider step.

---

### Breaking Changes Summary

| Change | Breaking? | Mitigation |
|---|---|---|
| Remove `ARMADA_RP_ID`/`ARMADA_ORIGIN` from required env | No | Auto-detect; env still works as override |
| `rpID`/`origin` become functions instead of constants | Internal only | No public API change |
| Auto-generate `ARMADA_NODE_TOKEN` | No | Env still supported; auto-gen kicks in if unset |
| Single container image | No | Separate images still published |
| `.env.example` simplification | No | Old env vars still work |

No changes are breaking for existing deployments. All env vars continue to work as overrides.

---

## Appendix: Ideal First-Run Experience (Target State)

```bash
# Install Armada (< 30 seconds)
curl -fsSL https://get.armada.sh | bash

# Output:
# ✅ Docker detected
# 📦 Pulling armada...
# 🚀 Starting Armada on http://localhost:3001
# 
# → Open http://localhost:3001 to complete setup
# → Your API token is in ~/.armada/token.txt
```

```
Browser: http://localhost:3001

Step 1/5: Welcome
  [Get Started →]

Step 2/5: Create Owner Account  
  Username: chris
  Display Name: Chris
  [Create Account →]

Step 3/5: Secure with Passkey
  [Register Passkey] [Skip →]

Step 4/5: Your URL
  Detected: http://localhost:3001
  ✅ Looks good for local use
  [Confirm →]

Step 5/5: Add AI Provider
  [Anthropic] [OpenAI] [OpenRouter] [Ollama]
  API Key: sk-ant-...
  [Add Provider] [Skip →]

Done! ✅
  Your Armada control plane is ready.
  [Go to Dashboard →]
```

Total setup time: **< 2 minutes** from curl command to working dashboard, with zero env var configuration.
