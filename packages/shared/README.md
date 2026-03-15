# @coderage-labs/armada-shared

Shared TypeScript types and utilities for the Armada platform.

## Contents

- `ArmadaNode`, `ArmadaInstance`, `ArmadaUser`, `ArmadaTask` — core entity types
- `Agent`, `Template`, `Workflow`, `WorkflowRun` — domain types
- Protocol version constants
- Shared utility functions

## Usage

```typescript
import type { Agent, ArmadaInstance, ArmadaTask } from '@coderage-labs/armada-shared';
```

## Building

```bash
npm run build
```

This package is consumed by `armada-control`, `armada-ui`, `armada-node`, and all plugins.
