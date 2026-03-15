# @coderage-labs/armada-plugin-shared

Shared utilities for Armada OpenClaw plugins (agent + control).

## What It Provides

- **Inbound task context** — `createInboundContext()` manages the full lifecycle of a received task: session creation, accumulator, timers, and callback
- **Heartbeat keepalives** — periodic pings to prevent task timeout during long-running work
- **Hard/idle/progress timeouts** — configurable watchdog timers with auto-finalization
- **Subtask tracking** — parent tasks wait for child task completion before finalizing
- **File marker extraction** — `{{file:path}}` markers in agent output are extracted and encoded as base64 attachments
- **Callback handling** — automatic POST of results back to the control plane on task completion

## Usage

```typescript
import { createInboundContext, finalizeInbound } from '@coderage-labs/armada-plugin-shared';
```

This package is consumed by `armada-agent` and `armada-control-plugin`. Not intended for direct end-user installation.
