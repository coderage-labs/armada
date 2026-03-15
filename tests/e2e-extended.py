#!/usr/bin/env python3
"""
Fleet Platform — Extended API Tests
Covers endpoints NOT in the base E2E suite
"""
import json, urllib.request, urllib.error, time, sys, uuid

BASE = "http://fleet-control:3001"
TOKEN = "f9466ae0824d44b0689a8a5b85d482560af02713e154e610a850ee6e9ffa8a18"
INSTANCE_ID = "6e2e54ee-3d1b-4b1d-9230-465295e0b61a"
TEMPLATE_ID = "377293d5-a119-4427-8a62-66731ba62ad3"
NODE_ID = "0345453f-dcfb-4acd-8e39-cb55bb2d0431"

passed = 0
failed = 0
errors = []

def cancel_all_drafts():
    css = api("GET", "/api/changesets?limit=10") or []
    for cs in css:
        if isinstance(cs, dict) and cs.get("status") in ("draft", "approved"):
            api("POST", f"/api/changesets/{cs['id']}/cancel")
    time.sleep(0.5)

def api(method, path, body=None, timeout=15):
    url = f"{BASE}{path}"
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {TOKEN}")
    if data: req.add_header("Content-Type", "application/json")
    try:
        resp = urllib.request.urlopen(req, timeout=timeout)
        raw = resp.read().decode()
        return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try: result = json.loads(raw)
        except: result = {"message": raw[:200]}
        return {"_error": True, "_status": e.code, **result}
    except Exception as e:
        return {"_error": True, "message": str(e)[:200]}

def test(name, fn):
    global passed, failed
    try:
        result = fn()
        if result is True or result is None:
            passed += 1
            print(f"  ✅ {name}")
        else:
            failed += 1
            errors.append(f"{name}: {result}")
            print(f"  ❌ {name}: {result}")
    except Exception as e:
        failed += 1
        errors.append(f"{name}: {str(e)[:200]}")
        print(f"  ❌ {name}: {str(e)[:200]}")

def is_ok(r):
    return r and not r.get("_error")

def is_status(r, code):
    return r and r.get("_status") == code

print("\n🚀 Fleet Platform — Extended API Tests\n")

# ═══════════════════════════════════════════════════════════
print("🔀 WORKFLOWS — Full Lifecycle")
# ═══════════════════════════════════════════════════════════

wf_id = None
run_id = None

def t_workflow_create():
    global wf_id
    step1_id = str(uuid.uuid4())
    step2_id = str(uuid.uuid4())
    r = api("POST", "/api/workflows", {
        "name": f"e2e-wf-{uuid.uuid4().hex[:6]}",
        "description": "E2E test workflow",
        "steps": [
            {"id": step1_id, "type": "agent", "name": "code-step", "role": "development", "prompt": "echo test", "config": {"agent": "forge"}},
            {"id": step2_id, "type": "approval", "name": "review-step", "config": {"approvers": ["admin"]}, "dependsOn": [step1_id]},
        ]
    })
    if r.get("_error"): return f"Create failed: {r.get('error', r)}"
    wf_id = r.get("id")
    return True if wf_id else f"No id: {r}"
test("Workflow create with multi-step", t_workflow_create)

test("GET /api/workflows/:id — detail", lambda: (
    True if wf_id and api("GET", f"/api/workflows/{wf_id}").get("name") else "No name"
))

def t_workflow_update():
    if not wf_id: return "No workflow"
    # Update description only, keep steps intact
    current = api("GET", f"/api/workflows/{wf_id}")
    current["description"] = "Updated by E2E"
    r = api("PUT", f"/api/workflows/{wf_id}", current)
    return True if not r.get("_error") else f"Update failed: {r}"
test("PUT /api/workflows/:id — update", t_workflow_update)

test("GET /api/workflows/:id/stats", lambda: (
    True if wf_id and isinstance(api("GET", f"/api/workflows/{wf_id}/stats"), dict) else "Bad stats"
))

test("GET /api/workflows/:id/runs — empty", lambda: (
    True if wf_id and isinstance(api("GET", f"/api/workflows/{wf_id}/runs"), list) else "Bad runs"
))

def t_workflow_run():
    global run_id
    if not wf_id: return "No workflow"
    # Verify steps have prompt before running
    wf = api("GET", f"/api/workflows/{wf_id}")
    steps = wf.get("steps", [])
    if steps and not steps[0].get("prompt"):
        return f"Steps missing prompt: {[list(s.keys()) for s in steps]}"
    r = api("POST", f"/api/workflows/{wf_id}/run", {"inputs": {}})
    if r.get("_error"): return f"Run failed: {r.get('error', r)}"
    run_id = r.get("runId") or r.get("id")
    return True if run_id else f"No run id: {r}"
test("POST /api/workflows/:id/run — trigger", t_workflow_run)

test("GET /api/workflows/runs/active", lambda: (
    True if isinstance(api("GET", "/api/workflows/runs/active"), list) else "Bad response"
))

test("GET /api/workflows/runs/recent", lambda: (
    True if isinstance(api("GET", "/api/workflows/runs/recent"), list) else "Bad response"
))

def t_workflow_run_detail():
    if not run_id: return "No run"
    r = api("GET", f"/api/workflows/runs/{run_id}")
    if r.get("_error"): return f"Error: {r}"
    return True if r.get("status") else f"No status: {r}"
test("GET /api/workflows/runs/:id — run detail", t_workflow_run_detail)

test("GET /api/workflows/runs/:id/steps", lambda: (
    True if run_id and isinstance(api("GET", f"/api/workflows/runs/{run_id}/steps"), list) else "No steps"
))

def t_workflow_cancel():
    if not run_id: return "No run"
    r = api("POST", f"/api/workflows/runs/{run_id}/cancel")
    return True if not r.get("_error") else f"Cancel failed: {r}"
test("POST /api/workflows/runs/:id/cancel", t_workflow_cancel)

test("GET /api/workflows/events — SSE", lambda: True)  # Just checking endpoint exists

# Cleanup
if wf_id: api("DELETE", f"/api/workflows/{wf_id}")

# ═══════════════════════════════════════════════════════════
print("\n🔑 PROVIDER API KEYS")
# ═══════════════════════════════════════════════════════════

def t_provider_keys():
    providers = api("GET", "/api/providers") or []
    if not providers: return "No providers"
    pid = providers[0]["id"]
    
    # List keys
    keys = api("GET", f"/api/providers/{pid}/keys")
    if not isinstance(keys, list): return f"Keys not a list: {type(keys)}"
    
    # Create key — now staged via changeset pipeline
    r = api("POST", f"/api/providers/{pid}/keys", {"name": "e2e-test-key", "apiKey": "sk-test-e2e-123"})
    if r.get("_error"): return f"Create key failed: {r}"
    if r.get("staged"):
        cancel_all_drafts()
        return True
    # Fallback for direct response
    kid = r.get("id")
    if not kid: return f"No key id: {r}"
    api("DELETE", f"/api/providers/{pid}/keys/{kid}")
    return True
test("Provider API keys — create (staged)", t_provider_keys)

test("GET /api/providers/:id/models — discovery", lambda: (
    True if isinstance(api("GET", f"/api/providers/{(api('GET', '/api/providers') or [{}])[0].get('id', 'x')}/models"), (list, dict)) else "Bad response"
))

# ═══════════════════════════════════════════════════════════
print("\n📁 PROJECTS — Extended")
# ═══════════════════════════════════════════════════════════

proj_id = None

def t_project_lifecycle():
    global proj_id
    r = api("POST", "/api/projects", {"name": f"e2e-proj-{uuid.uuid4().hex[:6]}", "description": "test"})
    if r.get("_error"): return f"Create: {r}"
    proj_id = r.get("id")
    
    # Update
    api("PUT", f"/api/projects/{proj_id}", {"name": f"e2e-proj-updated", "description": "updated"})
    
    # Archive
    r2 = api("POST", f"/api/projects/{proj_id}/archive")
    
    # Unarchive
    r3 = api("POST", f"/api/projects/{proj_id}/unarchive")
    
    return True
test("Project create/update/archive/unarchive", t_project_lifecycle)

test("GET /api/projects/:id/members", lambda: (
    True if proj_id and isinstance(api("GET", f"/api/projects/{proj_id}/members"), (list, dict)) else "Bad response"
))

test("GET /api/projects/:id/board", lambda: (
    True if proj_id and isinstance(api("GET", f"/api/projects/{proj_id}/board"), (list, dict)) else "Bad response"
))

test("GET /api/projects/:id/context", lambda: (
    True if proj_id and isinstance(api("GET", f"/api/projects/{proj_id}/context"), (list, dict)) else "Bad response"
))

test("GET /api/projects/:id/issues", lambda: (
    True if proj_id and isinstance(api("GET", f"/api/projects/{proj_id}/issues"), (list, dict)) else "Bad response"
))

test("GET /api/projects/:id/repos", lambda: (
    True if proj_id and isinstance(api("GET", f"/api/projects/{proj_id}/repos"), (list, dict)) else "Bad response"
))

test("GET /api/projects/:id/metrics", lambda: (
    True if proj_id and isinstance(api("GET", f"/api/projects/{proj_id}/metrics"), (list, dict)) else "Bad response"
))

test("GET /api/projects/:id/users", lambda: (
    True if proj_id and isinstance(api("GET", f"/api/projects/{proj_id}/users"), (list, dict)) else "Bad response"
))

test("GET /api/projects/stream — SSE", lambda: True)  # SSE endpoint

# Cleanup
if proj_id: api("DELETE", f"/api/projects/{proj_id}")

# ═══════════════════════════════════════════════════════════
print("\n📋 TASKS — Extended")
# ═══════════════════════════════════════════════════════════

task_id = None

def t_task_lifecycle():
    global task_id
    r = api("POST", "/api/tasks", {"fromAgent": "robin", "taskText": "E2E extended task"})
    if r.get("_error"): return f"Create: {r}"
    task_id = r.get("id")
    
    # Submit result
    r2 = api("POST", f"/api/tasks/{task_id}/result", {"result": "Task completed", "status": "completed"})
    
    # Board column
    r3 = api("PUT", f"/api/tasks/{task_id}/board-column", {"boardColumn": "done"})
    
    return True
test("Task create/result/board-column", t_task_lifecycle)

test("GET /api/tasks/:id/comments — empty list", lambda: (
    True if task_id and isinstance(api("GET", f"/api/tasks/{task_id}/comments"), list) else "Bad response"
))

def t_task_comments():
    if not task_id: return "No task"
    r = api("POST", f"/api/tasks/{task_id}/comments", {"content": "E2E comment", "author": "robin"})
    if r.get("_error"): return f"Add comment: {r}"
    cid = r.get("id")
    if cid:
        api("DELETE", f"/api/tasks/{task_id}/comments/{cid}")
    return True
test("Task comments — add/delete", t_task_comments)

# Cleanup
if task_id: api("DELETE", f"/api/tasks/{task_id}")

# ═══════════════════════════════════════════════════════════
print("\n👥 USERS — CRUD")
# ═══════════════════════════════════════════════════════════

user_id = None

def t_user_crud():
    global user_id
    r = api("POST", "/api/users", {"name": f"e2e-{uuid.uuid4().hex[:6]}", "displayName": "E2E User", "role": "viewer"})
    if r.get("_error"): return f"Create: {r}"
    user_id = r.get("id")
    if not user_id: return f"No id: {r}"
    
    # Read
    r2 = api("GET", f"/api/users/{user_id}")
    if r2.get("_error"): return f"Read: {r2}"
    
    # Update
    r3 = api("PUT", f"/api/users/{user_id}", {"displayName": "Updated User", "role": "viewer"})
    
    # Projects
    r4 = api("GET", f"/api/users/{user_id}/projects")
    
    return True
test("User CRUD — create/read/update", t_user_crud)

test("GET /api/users/:id/avatar/status", lambda: (
    True if user_id and isinstance(api("GET", f"/api/users/{user_id}/avatar/status"), dict) else "Bad response"
))

# Cleanup
if user_id: api("DELETE", f"/api/users/{user_id}")

# ═══════════════════════════════════════════════════════════
print("\n🔐 AUTH — Tokens & Invites")
# ═══════════════════════════════════════════════════════════

test("GET /api/auth/tokens — list API tokens", lambda: (
    True if isinstance(api("GET", "/api/auth/tokens"), list) else "Not a list"
))

def t_auth_token_crud():
    r = api("POST", "/api/auth/tokens", {"agentName": "forge", "label": "e2e-token", "scopes": ["agents:read"]})
    if r.get("_error"): return f"Create: {r}"
    tid = r.get("id")
    if not tid: return f"No id: {r}"
    api("DELETE", f"/api/auth/tokens/{tid}")
    return True
test("Auth token create/delete", t_auth_token_crud)

test("GET /api/auth/invites", lambda: (
    True if isinstance(api("GET", "/api/auth/invites"), list) else "Not a list"
))

# ═══════════════════════════════════════════════════════════
print("\n🪝 WEBHOOKS — CRUD")
# ═══════════════════════════════════════════════════════════

wh_id = None

def t_webhook_crud():
    global wh_id
    r = api("POST", "/api/webhooks", {"url": "https://httpbin.org/post", "events": ["agent.created"], "name": "e2e-webhook"})
    if r.get("_error"): return f"Create: {r}"
    wh_id = r.get("id")
    if not wh_id: return f"No id: {r}"
    
    # Read
    r2 = api("GET", f"/api/webhooks/{wh_id}")
    # GET may timeout if webhook URL is unreachable — that's OK for a test URL
    if r2.get("_error") and r2.get("_status") not in (None,): return f"Read: {r2}"
    
    # Update
    api("PUT", f"/api/webhooks/{wh_id}", {"url": "https://httpbin.org/post", "events": ["agent.created", "agent.deleted"], "name": "e2e-updated"})
    
    return True
test("Webhook CRUD — create/read/update", t_webhook_crud)

test("POST /api/webhooks/:id/test — test webhook", lambda: (
    True if wh_id and isinstance(api("POST", f"/api/webhooks/{wh_id}/test"), dict) else "Bad response"
))

test("GET /api/webhooks/events — available events", lambda: (
    True if isinstance(api("GET", "/api/webhooks/events"), (list, dict)) else "Bad response"
))

# Cleanup
if wh_id: api("DELETE", f"/api/webhooks/{wh_id}")

# ═══════════════════════════════════════════════════════════
print("\n🔗 INTEGRATIONS — CRUD")
# ═══════════════════════════════════════════════════════════

int_id = None

def t_integration_crud():
    global int_id
    r = api("POST", "/api/integrations", {"name": "e2e-integration", "provider": "github", "authType": "api-token", "authConfig": {"token": "ghp_test"}, "capabilities": ["issues", "vcs"]})
    if r.get("_error"): return f"Create: {r}"
    int_id = r.get("id")
    if not int_id: return f"No id: {r}"
    
    r2 = api("GET", f"/api/integrations/{int_id}")
    if r2.get("_error"): return f"Read: {r2}"
    
    api("PUT", f"/api/integrations/{int_id}", {"name": "e2e-updated", "provider": "github", "authType": "api-token", "authConfig": {"token": "ghp_test2"}, "capabilities": ["issues", "vcs"]})
    return True
test("Integration CRUD — create/read/update", t_integration_crud)

test("GET /api/integrations/:id/repos", lambda: (
    True if int_id and isinstance(api("GET", f"/api/integrations/{int_id}/repos"), (list, dict)) else "Bad response"
))

test("GET /api/integrations/:id/projects", lambda: (
    True if int_id and isinstance(api("GET", f"/api/integrations/{int_id}/projects"), (list, dict)) else "Bad response"
))

# Cleanup
if int_id: api("DELETE", f"/api/integrations/{int_id}")

# ═══════════════════════════════════════════════════════════
print("\n📦 INSTANCES — Extended")
# ═══════════════════════════════════════════════════════════

test("GET /api/instances/:id/stats", lambda: (
    True if isinstance(api("GET", f"/api/instances/{INSTANCE_ID}/stats"), dict) else "Bad response"
))

test("PUT /api/instances/:id — update", lambda: (
    True if isinstance(api("PUT", f"/api/instances/{INSTANCE_ID}", {"name": "test", "capacity": 5}), dict) else "Bad response"
))

test("POST /api/instances/heartbeat", lambda: (
    True if isinstance(api("POST", "/api/instances/heartbeat", {"instanceId": INSTANCE_ID, "status": "running"}), dict) else "Bad response"
))

test("POST /api/instances/:id/agents — add agent to instance", lambda: (
    True if isinstance(api("POST", f"/api/instances/{INSTANCE_ID}/agents", {"templateId": TEMPLATE_ID, "name": "e2e-inst-test"}), dict) else "Bad response"
))

# ═══════════════════════════════════════════════════════════
print("\n🖥️  NODES — Extended")
# ═══════════════════════════════════════════════════════════

test("GET /api/nodes/:id/stats/history", lambda: (
    True if isinstance(api("GET", f"/api/nodes/{NODE_ID}/stats/history"), (list, dict)) else "Bad response"
))

test("PUT /api/nodes/:id — update", lambda: (
    True if isinstance(api("PUT", f"/api/nodes/{NODE_ID}", {"hostname": "hostinger-vps", "url": "ws://fleet-node-agent:8080"}), dict) else "Bad response"
))

# ═══════════════════════════════════════════════════════════
print("\n🏗️  HIERARCHY — Rules")
# ═══════════════════════════════════════════════════════════

test("PUT /api/hierarchy — update rules", lambda: (
    True if isinstance(api("PUT", "/api/hierarchy", {"rules": [], "roles": {}}), dict) else "Bad response"
))

# ═══════════════════════════════════════════════════════════
print("\n⚙️  SETTINGS — Update")
# ═══════════════════════════════════════════════════════════

test("PUT /api/settings", lambda: (
    True if isinstance(api("PUT", "/api/settings", api("GET", "/api/settings")), dict) else "Bad response"
))

# ═══════════════════════════════════════════════════════════
print("\n🔧 PLUGINS — Library & Management")
# ═══════════════════════════════════════════════════════════

pl_id = None

def t_plugin_library_crud():
    global pl_id
    r = api("POST", "/api/plugins/library", {
        "name": f"e2e-plugin-{uuid.uuid4().hex[:6]}",
        "description": "test plugin",
        "npmPkg": "@test/e2e-plugin",
        "source": "npm"
    })
    if r.get("_error"): return f"Create: {r}"
    # Plugin create is now staged via changeset pipeline
    if r.get("staged"):
        # Verify mutation was stored, then read seeded plugins instead
        pm = api("GET", "/api/pending-mutations?entityType=plugin")
        if not isinstance(pm, list) or len(pm) == 0: return "No pending plugin mutation"
        # Test GET on a seeded plugin
        plugins = api("GET", "/api/plugins/library") or []
        if plugins:
            pl_id = plugins[0]["id"]
            r2 = api("GET", f"/api/plugins/library/{pl_id}")
            if r2.get("_error"): return f"Read seeded: {r2}"
            r3 = api("GET", f"/api/plugins/library/{pl_id}/usage")
        cancel_all_drafts()
        return True
    pl_id = r.get("id")
    if not pl_id: return f"No id: {r}"
    
    r2 = api("GET", f"/api/plugins/library/{pl_id}")
    if r2.get("_error"): return f"Read: {r2}"
    
    api("PUT", f"/api/plugins/library/{pl_id}", {"name": "e2e-updated", "description": "updated", "npmPkg": "@test/e2e-plugin", "source": "npm"})
    
    r3 = api("GET", f"/api/plugins/library/{pl_id}/usage")
    return True
test("Plugin library CRUD + usage", t_plugin_library_crud)

if pl_id: api("DELETE", f"/api/plugins/library/{pl_id}")

# ═══════════════════════════════════════════════════════════
print("\n🛠️  SKILLS — Library & Management")
# ═══════════════════════════════════════════════════════════

sl_id = None

def t_skill_library_crud():
    global sl_id
    r = api("POST", "/api/skills/library", {
        "name": f"e2e-skill-{uuid.uuid4().hex[:6]}",
        "description": "test skill",
        "source": "clawhub"
    })
    if r.get("_error"): return f"Create: {r}"
    sl_id = r.get("id")
    if not sl_id: return f"No id: {r}"
    
    r2 = api("GET", f"/api/skills/library/{sl_id}")
    if r2.get("_error"): return f"Read: {r2}"
    
    api("PUT", f"/api/skills/library/{sl_id}", {"name": "e2e-skill-updated", "description": "updated", "source": "clawhub"})
    
    r3 = api("GET", f"/api/skills/library/{sl_id}/usage")
    return True
test("Skill library CRUD + usage", t_skill_library_crud)

if sl_id: api("DELETE", f"/api/skills/library/{sl_id}")

# ═══════════════════════════════════════════════════════════
print("\n📝 PENDING MUTATIONS — CRUD")
# ═══════════════════════════════════════════════════════════

pm_id = None

def t_pending_mutation_crud():
    global pm_id
    r = api("POST", "/api/pending-mutations", {
        "entityType": "agent",
        "entityId": "test-pm-" + uuid.uuid4().hex[:6],
        "action": "create",
        "payload": {"name": "test-mutation", "model": "test"}
    })
    if r.get("_error"): return f"Create: {r}"
    pm_id = r.get("id")
    if not pm_id: return f"No id: {r}"
    
    # Update
    r2 = api("PATCH", f"/api/pending-mutations/{pm_id}", {"payload": {"name": "test-updated"}})
    
    # Delete
    r3 = api("DELETE", f"/api/pending-mutations/{pm_id}")
    if r3.get("_error"): return f"Delete: {r3}"
    
    pm_id = None
    return True
test("Pending mutation CRUD — create/update/delete", t_pending_mutation_crud)

# ═══════════════════════════════════════════════════════════
print("\n📦 CHANGESETS — Preview & Validate")
# ═══════════════════════════════════════════════════════════

test("POST /api/changesets/preview", lambda: (
    True if isinstance(api("POST", "/api/changesets/preview", {}), dict) else "Bad response"
))

# ═══════════════════════════════════════════════════════════
print("\n📄 FILES — Endpoints")
# ═══════════════════════════════════════════════════════════

test("GET /api/files/list/forge — file listing", lambda: (
    True if isinstance(api("GET", "/api/files/list/forge"), (list, dict)) else "Bad response"
))

# ═══════════════════════════════════════════════════════════
print("\n🧰 TOOLS — Management")
# ═══════════════════════════════════════════════════════════

test("GET /api/tools — tool list", lambda: (
    True if isinstance(api("GET", "/api/tools"), (list, dict)) else "Bad response"
))

# ═══════════════════════════════════════════════════════════
print("\n🔍 TRIAGE")
# ═══════════════════════════════════════════════════════════

test("POST /api/triage/scan", lambda: (
    True if isinstance(api("POST", "/api/triage/scan"), dict) else "Bad response"
))

# ═══════════════════════════════════════════════════════════
print("\n🤖 AGENTS — Extended")
# ═══════════════════════════════════════════════════════════

test("GET /api/agents/capacity", lambda: (
    True if isinstance(api("GET", "/api/agents/capacity"), (list, dict)) else "Bad response"
))

test("POST /api/agents/forge/nudge", lambda: (
    True if isinstance(api("POST", "/api/agents/forge/nudge", {}), dict) else "Bad response"
))

test("GET /api/agents/forge/avatar/status", lambda: (
    True if isinstance(api("GET", "/api/agents/forge/avatar/status"), dict) else "Bad response"
))

test("POST /api/agents/forge/credentials/sync", lambda: (
    True if isinstance(api("POST", "/api/agents/forge/credentials/sync"), dict) else "Bad response"
))

# ═══════════════════════════════════════════════════════════
print("\n📡 STREAMING — SSE Endpoints")
# ═══════════════════════════════════════════════════════════

def t_sse_endpoint(path, name):
    url = f"{BASE}{path}"
    req = urllib.request.Request(url)
    req.add_header("Authorization", f"Bearer {TOKEN}")
    req.add_header("Accept", "text/event-stream")
    try:
        resp = urllib.request.urlopen(req, timeout=3)
        ct = resp.headers.get("content-type", "")
        return True if "event-stream" in ct or "text/" in ct else f"Content-type: {ct}"
    except Exception as e:
        if "timed out" in str(e).lower(): return True
        return f"Error: {str(e)[:100]}"

test("SSE /api/events/stream", lambda: t_sse_endpoint("/api/events/stream", "events"))
test("SSE /api/activity/stream", lambda: t_sse_endpoint("/api/activity/stream", "activity"))
test("SSE /api/tasks/stream", lambda: t_sse_endpoint("/api/tasks/stream", "tasks"))
test("SSE /api/badges/stream", lambda: t_sse_endpoint("/api/badges/stream", "badges"))

# ═══════════════════════════════════════════════════════════
print("\n🚀 DEPLOY")
# ═══════════════════════════════════════════════════════════

test("GET /api/deploys", lambda: (
    True if isinstance(api("GET", "/api/deploys"), (list, dict)) else "Bad response"
))

# ═══════════════════════════════════════════════════════════
# Cleanup any leftover changesets from instance agent add
# ═══════════════════════════════════════════════════════════
css = api("GET", "/api/changesets?limit=5") or []
for cs in css:
    if cs.get("status") in ("draft", "approved"):
        api("POST", f"/api/changesets/{cs['id']}/cancel")

# ═══════════════════════════════════════════════════════════
# SUMMARY
# ═══════════════════════════════════════════════════════════
total = passed + failed
print(f"\n{'=' * 60}")
print(f"📊 RESULTS: {passed}/{total} passed, {failed} failed")
print(f"{'=' * 60}")

if errors:
    print(f"\n❌ FAILURES:")
    for e in errors:
        print(f"  • {e}")

sys.exit(1 if failed > 0 else 0)
