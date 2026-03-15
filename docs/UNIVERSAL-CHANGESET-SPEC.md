# Universal Changeset Pipeline

> Every armada mutation flows through the changeset pipeline. The pipeline determines what actions are needed based on what changed.

## Overview

Currently, only agent CRUD, provider, and model mutations go through changesets. This spec extends the pipeline to **all armada state mutations** and introduces **template sync** — the mechanism that propagates template changes to deployed agents.

## Core Principle

**Templates are the source of truth. Agents inherit from templates.**

When a template changes, affected agents don't auto-update. The operator hits **"Sync to agents"**, which:
1. Compares each agent's current config against its template
2. Determines which agents have drifted / need updates
3. Generates a changeset with the right steps per instance

This is explicit, reviewable, and reversible.

## Mutation Flow

```
User makes a change (UI/API)
  → Change written directly to DB (templates, plugin library, etc.)
  → For instance-affecting changes: "Sync" action generates a changeset
  → Changeset: draft → approve → apply (steps execute)
```

### What Changed: Template Sync

Templates are NOT staged as pending mutations. They're saved directly (they're blueprints, not deployed state). The **sync** is what creates the changeset.

```
Template updated (saved to DB immediately)
  → UI shows "X agents out of sync" badge
  → Operator clicks "Sync to agents"
  → System compares each agent's effective config vs template
  → Generates pending mutations for agents that need updating  
  → Creates draft changeset with appropriate steps per instance
  → Standard review flow: approve → apply
```

### What Changed: Everything Else

| Entity | Staging | Needs Sync? | Notes |
|--------|---------|-------------|-------|
| Agent CRUD | Pending mutation | — | Already done. Changeset auto-created. |
| Provider | Pending mutation | — | Already done. Config-affecting. |
| Model registry | Pending mutation | — | Already done. Config-affecting. |
| Template | Direct DB write | Yes (explicit) | Sync compares agents to template |
| Plugin library | Direct DB write | Maybe | If plugin version changes, instances need update |
| Instance settings | Direct DB write | Maybe | Capacity, resources = DB only. Config = needs push |

## Template Sync: Field Classification

When syncing a template to its agents, the system diffs **what actually changed** between the agent's current effective config and the template.

### Config fields (need push_config + restart_gateway)

These fields go into the generated `openclaw.json` and require a gateway restart to take effect:

| Field | Config Impact |
|-------|---------------|
| `models` | All template models available to agent. Default model → `agents.list[].model`. All models added to `models.providers` section so agent can use them. |
| `model` (legacy) | Fallback if `models` is empty — sets `agents.list[].model` |
| `toolsAllow` | `agents.list[].tools.allow` |
| `pluginsList` | `plugins.load.paths`, `plugins.allow`, `plugins.entries` |
| `skillsList` | `agents.list[].skills` |
| `env` | Environment variables (if passed to config) |

### Workspace fields (need file write, NO restart)

These are written to the instance filesystem. The agent picks them up on next session reset — no restart needed:

| Field | File |
|-------|------|
| `soul` | `workspace/agents/{name}/SOUL.md` |
| `agents_md` | `workspace/agents/{name}/AGENTS.md` |

### DB-only fields (no instance action)

These are metadata stored in the armada DB only:

| Field | Notes |
|-------|-------|
| `name` | Template display name |
| `description` | Description text |
| `role` | Role label (e.g. "development") |
| `skills` | Skills description text |
| `image` | Container image (affects next provision, not running instances) |
| `resources` | Memory/CPU (affects next provision) |
| `contacts` | Managed automatically by Armada plugin — NOT part of template sync |

> **Note:** `internalAgents` should be removed from the template schema (deprecated).
> `contacts` are managed by the armada-agent plugin based on mesh/armada topology — they're not a template concern.

## Step Resolution

The changeset step builder examines all pending mutations and builds the minimal set of steps per instance:

```typescript
function buildStepsForInstance(instanceId: string, mutations: PendingMutation[]): Step[] {
  const steps: Step[] = [];
  
  const needsPluginInstall = mutations.some(m => affectsPlugins(m));
  const needsConfigPush = mutations.some(m => affectsConfig(m));
  const needsFileWrite = mutations.some(m => affectsWorkspaceFiles(m));
  const needsRestart = needsConfigPush; // restart only if config changed
  
  // Always flush mutations to DB first
  steps.push({ name: 'flush_mutations' });
  
  if (needsPluginInstall) {
    steps.push({ name: 'install_plugins', metadata: { plugins: resolvePlugins(mutations) } });
  }
  
  if (needsFileWrite) {
    steps.push({ name: 'push_files', metadata: { files: resolveFileWrites(mutations) } });
  }
  
  if (needsConfigPush) {
    steps.push({ name: 'push_config' });
  }
  
  if (needsRestart) {
    steps.push({ name: 'restart_gateway' });
    steps.push({ name: 'health_check' });
  }
  
  return steps;
}
```

### Step Types

| Step | Action | When |
|------|--------|------|
| `flush_mutations` | Write pending mutations to real DB tables | Always (first step) |
| `install_plugins` | `npm install` plugins on node | Plugin list changed |
| `push_files` | Write SOUL.md, AGENTS.md etc. to instance via node agent | Workspace fields changed |
| `push_config` | Generate + write openclaw.json | Config fields changed |
| `restart_gateway` | SIGUSR1 to openclaw-gateway | After push_config |
| `health_check` | Wait for plugin heartbeat / HTTP probe | After restart_gateway |

## Template Sync API

### POST /api/templates/:id/sync

Triggers a sync of this template to all agents using it.

**Request:** `{}`  
**Response:**
```json
{
  "changesetId": "uuid",
  "agentsAffected": 3,
  "summary": {
    "configChanges": ["model", "toolsAllow"],
    "fileChanges": ["soul"],
    "dbOnly": ["role"]
  },
  "instanceOps": [
    {
      "instanceId": "uuid",
      "instanceName": "test",
      "agents": ["forge", "scout"],
      "steps": ["flush_mutations", "push_files", "push_config", "restart_gateway", "health_check"]
    }
  ]
}
```

### Sync Algorithm

```
1. Get all agents with templateId = this template
2. For each agent:
   a. Load agent's current effective config (DB + any pending mutations)
   b. Load template's current state
   c. Diff: which fields differ?
   d. Classify diffs into config/workspace/db-only
   e. If any diffs → stage pending mutations for the agent
3. Group affected agents by instance
4. For each instance, build steps based on the union of all mutation types
5. Create draft changeset
```

### Drift Detection

The UI should show drift status per agent:

```
GET /api/templates/:id/drift
→ [
    { agentId: "forge", agentName: "forge", instanceName: "test",
      drifted: true, 
      fields: { model: { template: "claude-4", agent: "claude-3.5" },
                soul: { changed: true } } },
    { agentId: "scout", agentName: "scout", instanceName: "test",
      drifted: false, fields: {} }
  ]
```

## UI Flow

### Template Detail Page

```
┌─────────────────────────────────────────┐
│ Template: dev-agent                     │
│ Role: development                       │
│                                         │
│ ⚠️ 2 of 3 agents out of sync           │
│ [Sync to agents]  [View drift]          │
│                                         │
│ ┌─ Agents using this template ────────┐ │
│ │ ✅ forge (in sync)                  │ │
│ │ ⚠️ scout (model drifted)           │ │  
│ │ ⚠️ nexus (soul + model drifted)    │ │
│ └─────────────────────────────────────┘ │
└─────────────────────────────────────────┘
```

### After "Sync to agents"

Standard changeset review flow — draft appears in PendingChangesBanner, operator reviews the diff (showing exactly which fields change on which agents), approves, applies.

## Implementation Plan

### Phase 1: Template Sync (this issue)
- [ ] `POST /api/templates/:id/sync` endpoint
- [ ] `GET /api/templates/:id/drift` endpoint  
- [ ] Diff engine: compare agent effective config vs template
- [ ] Field classifier: config / workspace / db-only
- [ ] Smart step builder: only include steps that are needed
- [ ] `push_files` step handler (write SOUL.md, AGENTS.md via node agent)
- [ ] UI: drift badges on template detail, "Sync to agents" button
- [ ] UI: sync changeset shows field-level diff in review

### Phase 2: Universal Pipeline
- [ ] Route plugin library changes through staging when they affect running instances
- [ ] Route instance setting changes that affect config through staging
- [ ] `flush_mutations` as explicit first step (currently implicit in apply)

### Phase 3: Auto-Drift Detection
- [ ] Background job checks drift periodically
- [ ] Dashboard widget: "X agents out of sync across Y templates"
- [ ] Optional auto-sync setting per template (dangerous but useful for dev)

## Design Decisions

1. **Template is always the source of truth.** Agents don't have per-agent overrides. The agent's config *is* whatever the template says. Sync overwrites unconditionally. If per-agent overrides are needed in the future, that's a separate feature with explicit "pinned" field tracking.

2. **Template edits don't auto-create changesets.** Explicit sync gives the operator control. You might edit a template multiple times before syncing. Hitting sync again rebuilds the draft changeset from scratch — steps are always recalculated from the current set of pending mutations.

3. **Draft changesets are rebuilt, not appended.** On each sync (or any mutation change), the system re-examines ALL pending mutations and rebuilds the changeset steps from scratch. Steps never go stale — they always reflect exactly what's needed for the current pending state. A restart step only exists if a pending mutation requires it.

4. **Sync is all-or-nothing per template.** No partial field sync for v1.
