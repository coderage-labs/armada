# OpenClaw Plugin Development Guide

> Practical guide based on hard-won lessons from building the armada-agent and armada-control plugins.

## Table of Contents

1. [File Structure](#1-file-structure)
2. [Plugin Manifest](#2-plugin-manifest-openclawpluginjson)
3. [Plugin Entry Point](#3-plugin-entry-point)
4. [registerTool](#4-registertool)
5. [registerHttpRoute](#5-registerhttproute)
6. [registerHook](#6-registerhook)
7. [registerService](#7-registerservice)
8. [Gateway Communication](#8-gateway-communication)
9. [Common Gotchas](#9-common-gotchas)
10. [Config in openclaw.json](#10-config-in-openclawjson)
11. [GlobalThis Persistence](#11-globalthis-persistence)

---

## 1. File Structure

```
my-plugin/
├── openclaw.plugin.json    ← manifest (MUST exist here AND in dist/)
├── package.json
├── src/
│   └── index.ts
├── dist/
│   ├── index.js
│   └── openclaw.plugin.json  ← copy of manifest
└── tsconfig.json
```

The manifest must exist in **both** the plugin root and `dist/` directory. OpenClaw looks for it in the directory where the compiled entry point lives, so forgetting the `dist/` copy is a common source of "plugin not found" errors.

---

## 2. Plugin Manifest (`openclaw.plugin.json`)

### Required Fields

| Field         | Description                                          | Example                  |
|---------------|------------------------------------------------------|--------------------------|
| `id`          | Unique plugin identifier                             | `"armada-agent"` |
| `kind`        | Plugin type                                          | `"tools"`                |
| `name`        | Human-readable name                                  | `"Armada Agent"`          |
| `description` | What the plugin does                                 | `"Fleet agent plugin"`   |
| `version`     | Semver version                                       | `"1.0.0"`                |

### Optional Fields

| Field          | Description                                                        |
|----------------|--------------------------------------------------------------------|
| `configSchema` | JSON Schema for plugin config (see warning below)                  |

### ⚠️ configSchema Warning

If your `configSchema` uses `additionalProperties: false`, **every** config field your plugin reads must be declared in the schema. Missing fields cause startup crashes with "invalid config" errors. Learned the hard way.

### Example

```json
{
  "id": "my-plugin",
  "kind": "tools",
  "name": "My Plugin",
  "description": "Does useful things",
  "version": "1.0.0",
  "configSchema": {
    "type": "object",
    "properties": {
      "apiKey": { "type": "string" },
      "enabled": { "type": "boolean", "default": true }
    },
    "additionalProperties": false
  }
}
```

---

## 3. Plugin Entry Point

Export a default function that receives the plugin API:

```typescript
export default function(api: PluginAPI) {
  // Register tools, hooks, routes, services, etc.
}
```

### Available API Methods

| Method                    | Purpose                              |
|---------------------------|--------------------------------------|
| `registerTool`            | Register a tool callable by the LLM  |
| `registerHook`            | Hook into agent lifecycle events     |
| `registerHttpRoute`       | Add HTTP endpoints to the gateway    |
| `registerChannel`         | Register a messaging channel         |
| `registerProvider`        | Register an LLM provider             |
| `registerGatewayMethod`   | Register a gateway RPC method        |
| `registerCli`             | Register CLI commands                |
| `registerService`         | Register a background service        |
| `registerCommand`         | Register a slash command             |
| `resolvePath`             | Resolve paths relative to plugin dir |
| `on`                      | Listen for plugin events             |

### Important Limitations

- `runtime.system` exposes `enqueueSystemEvent` for injecting system events
- There is **no generic tool execution API** — plugins cannot call other tools directly

---

## 4. registerTool

```typescript
api.registerTool({
  name: 'my_tool',
  description: 'Does something useful',
  parameters: {
    type: 'object',
    properties: {
      input: { type: 'string', description: 'The input to process' }
    },
    required: ['input']
  },
  execute: async (id, args, context) => {
    // id: tool call ID
    // args: parsed parameters
    // context: execution context
    
    // context.sessionKey — current session (may be undefined)
    
    return { result: 'success' }; // sent back to the LLM
  }
});
```

- `context.sessionKey` identifies the current session but may be `undefined` in some contexts
- The return value is serialized and sent back to the LLM as the tool result

---

## 5. registerHttpRoute

```typescript
api.registerHttpRoute({
  method: 'POST',
  path: '/my-plugin/endpoint',
  auth: 'gateway',
  handler: async (req, res) => {
    const body = req.body;
    res.json({ ok: true });
  }
});
```

### Auth Modes

| Mode      | Description                                |
|-----------|--------------------------------------------|
| `gateway` | Requires the gateway auth token            |
| `plugin`  | Requires plugin-specific authentication    |
| `none`    | No authentication — use with extreme care  |

---

## 6. registerHook

```typescript
api.registerHook(
  ['beforeAgentTurn', 'afterAgentTurn'],
  async (event) => {
    // Handle lifecycle event
  },
  { priority: 10 }
);
```

- Hook into agent lifecycle events (`beforeAgentTurn`, `afterAgentTurn`, etc.)
- `priority` controls execution order (lower = earlier)

---

## 7. registerService

```typescript
api.registerService({
  name: 'my-service',
  start: async () => {
    // Runs on plugin load
    // Keep this FAST — it blocks gateway startup
  },
  stop: async () => {
    // Runs on shutdown — clean up resources
  },
});
```

### ⚠️ Critical Warning

`start()` **blocks gateway startup**. If it takes too long, the entire gateway hangs.

Rules:
- Keep init under **1 second**
- Do heavy work in the background (fire-and-forget with error handling)
- jiti compilation of TypeScript plugins can take **27+ seconds** — never await heavy imports in `start()`

```typescript
// ❌ BAD — blocks startup
start: async () => {
  const bigModule = await import('./heavy-module');
  await bigModule.initialize(); // 30 seconds...
}

// ✅ GOOD — non-blocking
start: async () => {
  setImmediate(async () => {
    try {
      const bigModule = await import('./heavy-module');
      await bigModule.initialize();
    } catch (err) {
      console.error('Background init failed:', err);
    }
  });
}
```

---

## 8. Gateway Communication

Plugins can communicate with the gateway via dynamic imports:

```typescript
const { callGateway } = await import(
  new URL('../../src/gateway/call-gateway-dynamic.mjs', api.resolvePath('.'))
);

// Inject a message into an agent session
await callGateway('agent', {
  sessionKey,
  message: 'Hello from plugin',
  deliver: true
}, token);

// Send a message via a channel (e.g. Telegram)
await callGateway('send', {
  channel: 'telegram',
  to: '123456789',
  threadId: '42',
  message: 'Hello from plugin'
}, token);
```

### Key Points

| Method               | Purpose                              | Notes                                           |
|----------------------|--------------------------------------|-------------------------------------------------|
| `callGateway('agent')` | Inject message into session        | Needs `sessionKey`, `message`, `deliver`         |
| `callGateway('send')`  | Send via messaging channel         | Needs explicit `channel`, `to`, `threadId`       |

- `callGateway('send')` does **NOT** support `sessionKey` routing — you must pass explicit delivery params (`channel`, `to`, `threadId`)
- Token must be passed explicitly for unpaired peers

---

## 9. Common Gotchas

### Manifest in `dist/`
`openclaw.plugin.json` must exist in **both** the plugin root and `dist/` directory. If it's missing from `dist/`, the plugin won't load. Add a build step to copy it.

### `additionalProperties: false` in configSchema
If your configSchema uses this, **every single config field** must be declared in the schema. Miss one? Startup crash with "invalid config". Either declare everything or don't use `additionalProperties: false`.

### jiti Cache
After deploying new plugin code, clear `/tmp/jiti/*`. Stale compiled modules persist across restarts and you'll wonder why your changes aren't taking effect.

```bash
rm -rf /tmp/jiti/*
```

### ESM Only
Plugins run in an ESM context. **Do not use `require()`.**

```typescript
// ❌ BAD
const { v4 } = require('uuid');

// ✅ GOOD
import { v4 } from 'uuid';
// Or use built-in:
const id = crypto.randomUUID();
```

### Memory Requirements
Plugins compile via jiti at startup. Agents need **2GB+ RAM** — 512MB instances will OOM during plugin compilation.

### Extensions Directory Must Be Writable
OpenClaw `chown`s the extensions directory at startup. Never mount it as read-only (`:ro` in Docker).

### Plugin Loading Config
Two things must be set in `openclaw.json`:
1. `plugins.load.paths` must point to the extension directory
2. `plugins.allow` must include the plugin name

### Non-blocking Service Init
`registerService.start()` should **never** await heavy async work. It blocks the gateway event loop. See [registerService](#7-registerservice) for the correct pattern.

---

## 10. Config in `openclaw.json`

```json
{
  "plugins": {
    "allow": ["my-plugin"],
    "load": {
      "paths": ["/path/to/extensions"]
    },
    "entries": {
      "my-plugin": {
        "enabled": true,
        "config": {
          "apiKey": "...",
          "enabled": true
        }
      }
    }
  }
}
```

- `allow` — whitelist of plugin IDs that are permitted to load
- `load.paths` — directories to scan for plugins
- `entries.<id>.enabled` — toggle individual plugins
- `entries.<id>.config` — plugin-specific configuration (validated against `configSchema`)

---

## 11. GlobalThis Persistence

Plugin state **does not survive gateway restarts**. However, `globalThis` persists across `SIGUSR1` reloads (hot reloads):

```typescript
const MY_MAP = Symbol.for('my-plugin-state');

function getState(): Map<string, any> {
  if (!(globalThis as any)[MY_MAP]) {
    (globalThis as any)[MY_MAP] = new Map();
  }
  return (globalThis as any)[MY_MAP];
}
```

Use this for in-memory caches and state that should survive config reloads but doesn't need to persist across full restarts. For durable state, write to disk.

---

## Quick Checklist

Before shipping a plugin:

- [ ] `openclaw.plugin.json` exists in both root and `dist/`
- [ ] All config fields declared in `configSchema` (if using `additionalProperties: false`)
- [ ] Entry point uses `export default function`
- [ ] No `require()` calls — ESM only
- [ ] `registerService.start()` completes in < 1s
- [ ] Plugin name is in `plugins.allow` config
- [ ] Extension path is in `plugins.load.paths`
- [ ] Host has 2GB+ RAM for jiti compilation
- [ ] Extensions directory is writable (not mounted `:ro`)
