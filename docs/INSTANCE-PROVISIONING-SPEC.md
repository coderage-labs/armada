# Instance Provisioning — Specification

## Overview

When a user creates an instance, it should immediately begin provisioning on the target node with real-time progress visible in the UI. No separate "Start" button needed for first-time creation.

## User Flow

1. User clicks "New Instance" → dialog opens (node pre-selected if only one)
2. User fills in: name, template, resource limits → clicks "Create"
3. Dialog closes, instance card appears immediately in **Provisioning** state
4. Card shows live progress steps with spinners/checkmarks:
   - ☐ Creating instance record
   - ☐ Pulling image (`ghcr.io/openclaw/openclaw:<version>`)
   - ☐ Creating container
   - ☐ Starting container
   - ☐ Health check
   - ✅ Running
5. If any step fails, card shows error with retry button
6. Once running, card shows normal stats (CPU/memory/containers)

## States

```
creating → pulling → starting → running
                                    ↓
              stopped ← ─── stopping
                 ↓
              removed
```

Error can occur at any transition. Failed state preserves the last successful step.

## Backend

### POST /api/instances (create)

Current: Creates DB record, returns immediately.

New:
1. Create DB record with `status: 'creating'`
2. Create an **Operation** to track provisioning (existing operations system)
3. Kick off async provisioning pipeline (don't await — return 201 immediately)
4. Emit SSE event: `instance.creating`

### Provisioning Pipeline (async)

Runs after the HTTP response is sent:

```typescript
async function provisionInstance(instance: Instance): Promise<void> {
  const op = operationsService.create({
    type: 'instance.provision',
    targetId: instance.id,
    targetType: 'instance',
    steps: ['pull', 'create', 'start', 'health'],
  });

  try {
    // Step 1: Pull image
    operationsService.updateStep(op.id, 'pull', 'running');
    emitSSE('instance.provision.step', { instanceId: instance.id, step: 'pull', status: 'running' });
    
    const image = resolveImage(instance); // Armada-managed version or template override
    await nodeClient.sendCommand(instance.nodeId, 'container.pull', { image });
    
    operationsService.updateStep(op.id, 'pull', 'completed');
    emitSSE('instance.provision.step', { instanceId: instance.id, step: 'pull', status: 'completed' });

    // Step 2: Create container
    operationsService.updateStep(op.id, 'create', 'running');
    emitSSE('instance.provision.step', { instanceId: instance.id, step: 'create', status: 'running' });
    
    const containerId = await nodeClient.sendCommand(instance.nodeId, 'container.create', {
      image,
      name: `fleet-${instance.name}`,
      env: buildEnvVars(instance),
      resources: { memory: instance.memory, cpus: instance.cpus },
      volumes: buildVolumeMounts(instance),
      networks: ['armada-net'],
    });
    
    instancesRepo.update(instance.id, { containerId, status: 'created' });
    operationsService.updateStep(op.id, 'create', 'completed');
    emitSSE('instance.provision.step', { instanceId: instance.id, step: 'create', status: 'completed' });

    // Step 3: Start container
    operationsService.updateStep(op.id, 'start', 'running');
    emitSSE('instance.provision.step', { instanceId: instance.id, step: 'start', status: 'running' });
    
    await nodeClient.sendCommand(instance.nodeId, 'container.start', { containerId });
    
    instancesRepo.update(instance.id, { status: 'starting' });
    operationsService.updateStep(op.id, 'start', 'completed');
    emitSSE('instance.provision.step', { instanceId: instance.id, step: 'start', status: 'completed' });

    // Step 4: Health check (poll until healthy or timeout)
    operationsService.updateStep(op.id, 'health', 'running');
    emitSSE('instance.provision.step', { instanceId: instance.id, step: 'health', status: 'running' });
    
    await waitForHealthy(instance.id, { timeoutMs: 60_000 });
    
    instancesRepo.update(instance.id, { status: 'running' });
    operationsService.updateStep(op.id, 'health', 'completed');
    operationsService.complete(op.id);
    emitSSE('instance.status', { instanceId: instance.id, status: 'running' });

  } catch (err) {
    instancesRepo.update(instance.id, { status: 'failed', error: err.message });
    operationsService.fail(op.id, err.message);
    emitSSE('instance.provision.failed', { instanceId: instance.id, error: err.message });
  }
}
```

### Image Resolution

```typescript
function resolveImage(instance: Instance): string {
  const template = templatesRepo.get(instance.templateId);
  
  // Template-level pin takes priority
  if (template?.imageTag) return `ghcr.io/openclaw/openclaw:${template.imageTag}`;
  
  // Otherwise use system-level fleet version
  const fleetVersion = settingsRepo.get('fleet_openclaw_version');
  if (fleetVersion) return `ghcr.io/openclaw/openclaw:${fleetVersion}`;
  
  // Fallback to latest known
  return `ghcr.io/openclaw/openclaw:latest`;
}
```

### Node Agent Commands Needed

The node agent (`packages/node/src/handlers/`) needs these commands:

| Command | Params | Returns | Notes |
|---------|--------|---------|-------|
| `container.pull` | `{ image }` | `{ status }` | Pull image, stream progress if possible |
| `container.create` | `{ image, name, env, resources, volumes, networks }` | `{ containerId }` | Create but don't start |
| `container.start` | `{ containerId }` | `{ status }` | Start existing container |
| `container.stop` | `{ containerId, timeoutMs? }` | `{ status }` | Graceful stop |
| `container.remove` | `{ containerId, force? }` | `{ status }` | Remove container |
| `container.inspect` | `{ containerId }` | `{ state, health, ... }` | Get container details |

Check which of these already exist in the node agent handlers. Add any missing ones.

### POST /api/instances/:id/start (restart stopped instance)

For instances that were previously stopped:
1. Set status to `starting`
2. Send `container.start` to node
3. Wait for health check
4. Update to `running`

### POST /api/instances/:id/stop

1. Set status to `stopping`
2. Send `container.stop` to node
3. Update to `stopped`

### DELETE /api/instances/:id

1. Stop container if running
2. Remove container from node
3. Delete DB record

## Frontend

### Instance Card States

```
creating  → Pulsing border, "Creating..." text
pulling   → Progress bar (if image pull reports progress), "Pulling image..."
starting  → Spinner, "Starting..."
running   → Green dot, normal stats display
stopped   → Gray dot, "Stopped" badge, Start button
failed    → Red dot, error message, Retry button
removing  → Fade out animation
```

### SSE Subscription

The Instances page subscribes to SSE events:

```typescript
useSSE('instance.provision.step', (data) => {
  // Update the specific instance card's progress
  setInstances(prev => prev.map(inst => 
    inst.id === data.instanceId 
      ? { ...inst, provisionStep: data.step, provisionStatus: data.status }
      : inst
  ));
});

useSSE('instance.status', (data) => {
  // Update instance status
  setInstances(prev => prev.map(inst =>
    inst.id === data.instanceId
      ? { ...inst, status: data.status }
      : inst
  ));
});
```

### Provision Progress Component

```tsx
function ProvisionProgress({ instance }: { instance: Instance }) {
  const steps = [
    { key: 'pull', label: 'Pulling image' },
    { key: 'create', label: 'Creating container' },
    { key: 'start', label: 'Starting container' },
    { key: 'health', label: 'Health check' },
  ];
  
  return (
    <div className="space-y-2 mt-3">
      {steps.map(step => (
        <div key={step.key} className="flex items-center gap-2 text-sm">
          <StepIcon status={getStepStatus(instance, step.key)} />
          <span className={stepTextClass(instance, step.key)}>{step.label}</span>
        </div>
      ))}
    </div>
  );
}
```

## Error Handling

- **Image pull fails**: Show error, offer retry. Don't delete the instance.
- **Container create fails**: Show error with details (port conflict, resource limit, etc.)
- **Start fails**: Show error, offer retry or inspect logs
- **Health check timeout**: Show warning — container is running but not responding. Offer to view logs.
- **Node offline**: Can't provision. Show "Node offline" state, auto-retry when node reconnects.

## Operations Integration

Every provision/start/stop/remove creates an Operation entry visible on the Operations page. This gives a full audit trail of what happened and when.
