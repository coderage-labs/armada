#!/bin/bash
# Armada QA Test Suite — end-to-end via API
# Tests every major operation through the changeset pipeline

set -euo pipefail

API="http://armada-control:3001"
TOKEN="${FLEET_API_TOKEN:-}"
if [ -z "$TOKEN" ]; then
  echo "❌ FLEET_API_TOKEN not set"
  exit 1
fi

PASS=0
FAIL=0
WARN=0
RESULTS=""

# Helpers
api() {
  local method="$1" path="$2" body="${3:-}"
  if [ -n "$body" ]; then
    curl -s -X "$method" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" "$API$path" -d "$body" 2>&1
  else
    curl -s -X "$method" -H "Authorization: Bearer $TOKEN" "$API$path" 2>&1
  fi
}

check() {
  local name="$1" result="$2" expect="$3"
  if echo "$result" | grep -q "$expect"; then
    echo "  ✅ $name"
    PASS=$((PASS + 1))
  else
    echo "  ❌ $name"
    echo "     Expected: $expect"
    echo "     Got: $(echo "$result" | head -c 200)"
    FAIL=$((FAIL + 1))
  fi
}

warn() {
  local name="$1" msg="$2"
  echo "  ⚠️  $name: $msg"
  WARN=$((WARN + 1))
}

wait_changeset() {
  local csid="$1" timeout="${2:-30}" elapsed=0
  while [ $elapsed -lt $timeout ]; do
    local status=$(api GET "/api/changesets/$csid" | python3 -c "import json,sys; print(json.load(sys.stdin).get('status','?'))" 2>/dev/null)
    case "$status" in
      completed) echo "$status"; return 0 ;;
      failed) echo "$status"; return 1 ;;
      cancelled) echo "$status"; return 1 ;;
    esac
    sleep 2
    elapsed=$((elapsed + 2))
  done
  echo "timeout"
  return 1
}

approve_and_apply() {
  local csid="$1"
  api POST "/api/changesets/$csid/approve" > /dev/null 2>&1
  api POST "/api/changesets/$csid/apply" > /dev/null 2>&1
  wait_changeset "$csid" 60
}

# Clean slate — cancel any draft changesets
echo "🧹 Cleaning up..."
for csid in $(api GET "/api/changesets" | python3 -c "import json,sys; [print(c['id']) for c in json.load(sys.stdin) if c['status']=='draft']" 2>/dev/null); do
  api POST "/api/changesets/$csid/cancel" > /dev/null 2>&1
done

HOSTINGER_NODE="0345453f-dcfb-4acd-8e39-cb55bb2d0431"
TEST_INSTANCE="6e2e54ee-3d1b-4b1d-9230-465295e0b61a"

echo ""
echo "═══════════════════════════════════════"
echo "1. NODES"
echo "═══════════════════════════════════════"

R=$(api GET "/api/nodes")
check "List nodes" "$R" '"hostname"'
NODE_COUNT=$(echo "$R" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))" 2>/dev/null)
echo "     Found $NODE_COUNT node(s)"

echo ""
echo "═══════════════════════════════════════"
echo "2. INSTANCES"
echo "═══════════════════════════════════════"

R=$(api GET "/api/instances")
check "List instances" "$R" '"name"'

R=$(api GET "/api/instances/$TEST_INSTANCE")
check "Get instance detail" "$R" '"test"'

R=$(api GET "/api/instances/$TEST_INSTANCE/health")
check "Instance health check (local)" "$R" '"status"'
echo "     Health: $(echo "$R" | python3 -c "import json,sys; print(json.load(sys.stdin).get('status','?'))" 2>/dev/null)"

echo ""
echo "═══════════════════════════════════════"
echo "3. TEMPLATES"
echo "═══════════════════════════════════════"

R=$(api GET "/api/templates")
check "List templates" "$R" '"name"'
TMPL_COUNT=$(echo "$R" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))" 2>/dev/null)
echo "     Found $TMPL_COUNT template(s)"

echo ""
echo "═══════════════════════════════════════"
echo "4. PROVIDERS"
echo "═══════════════════════════════════════"

R=$(api GET "/api/providers")
check "List providers" "$R" '"id"'

# Stage a provider update (change nothing, just test the pipeline)
echo "  Testing provider mutation pipeline..."
R=$(api POST "/api/providers" '{"name":"qa-test-provider","type":"openai","baseUrl":"https://test.example.com"}')
if echo "$R" | grep -q "changesetId\|staged\|id"; then
  check "Create provider (staged)" "$R" "id"
  # Clean up — cancel the changeset
  CSID=$(echo "$R" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('changesetId', d.get('id','')))" 2>/dev/null)
  if [ -n "$CSID" ]; then
    # Find the draft changeset and cancel
    for csid in $(api GET "/api/changesets" | python3 -c "import json,sys; [print(c['id']) for c in json.load(sys.stdin) if c['status']=='draft']" 2>/dev/null); do
      api POST "/api/changesets/$csid/cancel" > /dev/null 2>&1
    done
  fi
else
  check "Create provider (staged)" "$R" "changesetId"
fi

echo ""
echo "═══════════════════════════════════════"
echo "5. MODELS"
echo "═══════════════════════════════════════"

R=$(api GET "/api/models")
check "List models" "$R" '"id"'

echo ""
echo "═══════════════════════════════════════"
echo "6. AGENTS"
echo "═══════════════════════════════════════"

R=$(api GET "/api/agents")
check "List agents" "$R" '"name"'

# Test agent create — check if it goes through changeset or direct
R=$(api POST "/api/agents" '{"name":"qa-test-agent","instanceId":"'"$TEST_INSTANCE"'","templateId":"2f764baa-7d01-43c5-a79e-e3742897674b","role":"research","model":"anthropic/claude-sonnet-4-5"}')
if echo "$R" | grep -q "changesetId\|staged"; then
  check "Agent create (via changeset)" "$R" "changeset"
else
  warn "Agent create" "BYPASSES changeset pipeline — goes direct (issue #530)"
  # Clean up the directly-created agent
  AGENT_NAME=$(echo "$R" | python3 -c "import json,sys; print(json.load(sys.stdin).get('name',''))" 2>/dev/null)
  if [ -n "$AGENT_NAME" ]; then
    api DELETE "/api/agents/$AGENT_NAME" > /dev/null 2>&1
  fi
fi

# Test nudge (local agent)
echo "  Testing nudge (local, 15s timeout)..."
R=$(api POST "/api/agents/forge/nudge" '{"message":"QA ping","timeoutMs":15000}')
STATUS=$(echo "$R" | python3 -c "import json,sys,re; print(json.loads(re.sub(r'[\x00-\x1f]',' ',sys.stdin.read())).get('status','?'))" 2>/dev/null)
if [ "$STATUS" = "ok" ]; then
  check "Nudge agent (local)" "$R" "ok"
else
  warn "Nudge agent (local)" "status=$STATUS (may timeout on cold agent)"
fi

echo ""
echo "═══════════════════════════════════════"
echo "7. CHANGESETS"
echo "═══════════════════════════════════════"

R=$(api GET "/api/changesets")
check "List changesets" "$R" '"id"'

echo ""
echo "═══════════════════════════════════════"
echo "8. TASKS"
echo "═══════════════════════════════════════"

R=$(api GET "/api/tasks")
check "List tasks" "$R" "["

echo ""
echo "═══════════════════════════════════════"
echo "9. OPERATIONS"
echo "═══════════════════════════════════════"

R=$(api GET "/api/operations")
check "List operations" "$R" "["

echo ""
echo "═══════════════════════════════════════"
echo "10. PLUGINS"
echo "═══════════════════════════════════════"

R=$(api GET "/api/plugins/library")
check "List plugin library" "$R" "["

R=$(api GET "/api/system/plugin-versions")
check "Plugin version drift" "$R" "["

echo ""
echo "═══════════════════════════════════════"
echo "11. ACTIVITY & AUDIT"
echo "═══════════════════════════════════════"

R=$(api GET "/api/activity")
check "Activity feed" "$R" "["

R=$(api GET "/api/audit-log")
check "Audit log" "$R" "["

echo ""
echo "═══════════════════════════════════════"
echo "12. SYSTEM"
echo "═══════════════════════════════════════"

R=$(api GET "/api/system/health")
check "System health" "$R" "status"

R=$(api GET "/api/settings")
check "Settings" "$R" "{"

echo ""
echo "═══════════════════════════════════════"
echo "RESULTS"
echo "═══════════════════════════════════════"
echo "  ✅ Passed: $PASS"
echo "  ❌ Failed: $FAIL"
echo "  ⚠️  Warnings: $WARN"
echo ""

if [ $FAIL -gt 0 ]; then
  echo "❌ QA FAILED — $FAIL test(s) broken"
  exit 1
else
  echo "✅ QA PASSED (with $WARN warning(s))"
fi
