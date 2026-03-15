# Inter-Agent Collaboration — Design Spec (#592)

## Core Vision

Every agent in a workflow has **full visibility** of the workflow it's 
executing in — who did what step, what their role was, what they produced.
Any agent can **dynamically choose to send any previous step back** with 
specific feedback. The agent decides at runtime, not the workflow schema.

This is NOT a messaging/chat system. It's the workflow looping back on 
itself based on agent judgment.

## Examples

**Research gap**: Agent C (implementing frontend) realises the API schema 
from Agent A doesn't cover a use case. C uses `fleet_request_rework` to 
send step "Design API" back to Agent A with: "The schema doesn't handle 
bulk operations. I need a POST /api/tasks/bulk endpoint."

**Design decision**: Agent B (building backend) hits an ambiguity. Instead 
of guessing, it flags `fleet_escalate` to surface the decision to a human: 
"Should deleted tasks be soft-deleted or hard-deleted?"

**Missing context**: Agent D (writing tests) can't find the auth flow docs.
It checks `fleet_workflow_context`, sees Agent B produced auth docs in 
step 2, reads them, and continues. No loop-back needed.

## Agent Tools

### `fleet_workflow_context`

Returns the full workflow state. The agent gets this automatically in its 
system prompt when dispatched, AND can call it on-demand for updates.

```json
{
  "workflow": {
    "id": "wf-123",
    "name": "Build Tasks Module",
    "status": "running"
  },
  "myStep": {
    "id": "implement_frontend",
    "role": "development",
    "iteration": 1
  },
  "steps": [
    {
      "id": "research",
      "name": "Research Requirements",
      "role": "research",
      "agent": "scout",
      "status": "completed",
      "output": "Requirements analysis: ...",
      "completedAt": "2026-03-15T04:00:00Z"
    },
    {
      "id": "design_api",
      "name": "Design API Schema",
      "role": "development",
      "agent": "forge",
      "status": "completed",
      "output": "API schema: POST /tasks, GET /tasks/:id ...",
      "completedAt": "2026-03-15T04:15:00Z"
    },
    {
      "id": "implement_frontend",
      "name": "Implement Frontend",
      "role": "development",
      "agent": "forge",
      "status": "running",
      "output": null,
      "iteration": 1
    }
  ],
  "reworkHistory": []
}
```

### `fleet_request_rework`

Any agent can send any previous step back with feedback. The workflow 
engine resets that step and everything downstream, injects the feedback, 
and re-dispatches.

```
fleet_request_rework({
  targetStepId: "design_api",
  feedback: "The schema doesn't handle bulk operations. I need a POST /api/tasks/bulk endpoint with batch validation."
})
```

**What happens:**
1. Current step is paused (status → `waiting_for_rework`)
2. Target step + all downstream steps are reset to `pending`
3. Target step is re-dispatched with:
   - Its original prompt
   - The feedback injected: "Rework requested by [agent] at step [step]: [feedback]"
   - Its previous output available as `{{previousOutput}}`
4. When the target step completes, the workflow DAG re-executes naturally
5. The requesting step eventually gets re-dispatched with the updated context

**Guards:**
- Can only target steps that have already completed
- Max rework iterations per step (configurable, default 3)
- Can't target your own current step (that's just a retry)
- Rework chain depth limit (A sends back B, B sends back C — max depth 3)

### `fleet_escalate`

Surface a decision to a human (operator or control plane admin). Pauses 
the step until a human responds.

```
fleet_escalate({
  question: "Should deleted tasks be soft-deleted or hard-deleted?",
  options: ["soft-delete", "hard-delete"],
  context: "This affects the API contract and DB schema"
})
```

**What happens:**
1. Step pauses (status → `awaiting_escalation`)
2. Notification sent (Telegram, SSE, etc.)
3. Human responds via UI or Telegram
4. Step resumes with the decision injected into context

## Workflow Engine Changes

### New step statuses
- `waiting_for_rework` — step paused because it requested rework on another step
- `awaiting_escalation` — step paused waiting for human decision
- `rework` — step was sent back and is re-executing with feedback

### Rework tracking

```sql
-- No new table needed. Track in workflow_runs.context_json:
{
  "steps": { ... },
  "reworks": [
    {
      "requestedBy": { "stepId": "implement_frontend", "agent": "forge" },
      "targetStepId": "design_api",
      "feedback": "Need bulk operations endpoint",
      "iteration": 1,
      "requestedAt": "2026-03-15T04:30:00Z",
      "resolvedAt": null
    }
  ]
}
```

### Escalation tracking

```sql
-- New table for human-in-the-loop decisions
CREATE TABLE escalations (
  id TEXT PRIMARY KEY,
  workflow_run_id TEXT NOT NULL,
  step_run_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  question TEXT NOT NULL,
  options TEXT,           -- JSON array of suggested options
  context TEXT,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | resolved | timed_out
  response TEXT,
  responded_by TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
```

### Feedback injection

When a step is re-dispatched after rework, the prompt includes:

```
[REWORK FEEDBACK]
Requested by: forge (step: implement_frontend)
Feedback: The schema doesn't handle bulk operations. I need a POST /api/tasks/bulk endpoint.
Your previous output: {{previousOutput}}
[END REWORK FEEDBACK]
```

## Implementation Plan

### Phase 1: Workflow context visibility
1. `fleet_workflow_context` tool in armada-agent plugin
2. Auto-inject workflow context into step dispatch prompt
3. API endpoint: `GET /api/workflow-runs/:id/context`

### Phase 2: Dynamic rework
1. `fleet_request_rework` tool in armada-agent plugin
2. Backend: `POST /api/workflow-runs/:id/rework` endpoint
3. Workflow engine: handle rework — pause requester, reset target, inject feedback
4. New step statuses: `waiting_for_rework`, `rework`
5. Rework history in context JSON
6. Guards: max iterations, depth limit, can't self-target

### Phase 3: Human escalation
1. `fleet_escalate` tool in armada-agent plugin
2. Backend: `POST /api/escalations` + `POST /api/escalations/:id/respond`
3. Escalations table (migration)
4. Notification dispatch (Telegram, SSE)
5. Telegram inline keyboard for quick responses
6. UI: escalation banner + response form

### Phase 4: UI
1. Workflow execution view with rework arrows
2. Conversation-style thread showing outputs + rework feedback
3. Escalation panel
4. Real-time via SSE events

## What This Replaces

The hardcoded `loopUntilApproved` / `loopBackToStep` mechanism becomes 
a special case of dynamic rework. Existing workflows still work — the 
schema fields remain but the engine now also supports agent-initiated 
rework at runtime.
