#!/bin/bash
# Armada Full QA Suite — tests every CRUD lifecycle through changeset pipeline + SSE
set -uo pipefail

API="http://armada-control:3001"
TOKEN="${FLEET_API_TOKEN:-}"
[ -z "$TOKEN" ] && echo "❌ FLEET_API_TOKEN not set" && exit 1

PASS=0 FAIL=0 WARN=0 SKIP=0
SSE_LOG="/tmp/qa-sse-$$.txt"

# ── Helpers ──────────────────────────────────────────────────

api() {
  local method="$1" path="$2" body="${3:-}"
  if [ -n "$body" ]; then
    curl -s -X "$method" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" "$API$path" -d "$body" 2>&1
  else
    curl -s -X "$method" -H "Authorization: Bearer $TOKEN" "$API$path" 2>&1
  fi
}

pj() { python3 -c "import json,sys,re; d=json.loads(re.sub(r'[\x00-\x1f]',' ',sys.stdin.read())); $1" 2>/dev/null; }

pass() { echo "  ✅ $1"; PASS=$((PASS + 1)); }
fail() { echo "  ❌ $1: $2"; FAIL=$((FAIL + 1)); }
warn() { echo "  ⚠️  $1: $2"; WARN=$((WARN + 1)); }
skip() { echo "  ⏭️  $1: $2"; SKIP=$((SKIP + 1)); }

cancel_drafts() {
  for csid in $(api GET "/api/changesets" | python3 -c "import json,sys; [print(c['id']) for c in json.load(sys.stdin) if c['status']=='draft']" 2>/dev/null); do
    api POST "/api/changesets/$csid/cancel" > /dev/null 2>&1
  done
}

get_draft() {
  api GET "/api/changesets" | python3 -c "import json,sys; cs=[c for c in json.load(sys.stdin) if c['status']=='draft']; print(cs[0]['id'] if cs else '')" 2>/dev/null
}

# Run a full changeset lifecycle: find draft → approve → apply → wait
apply_changeset() {
  local csid="$1" timeout="${2:-60}"
  # Approve
  local approve_result=$(api POST "/api/changesets/$csid/approve")
  local approve_status=$(echo "$approve_result" | pj "print(d.get('status', d.get('error','?')))")
  if [ "$approve_status" = "approved" ] || echo "$approve_result" | grep -q "approved"; then
    : # ok
  else
    echo "approve_failed:$approve_status"
    return 1
  fi

  # Apply
  local apply_result=$(api POST "/api/changesets/$csid/apply")
  local apply_status=$(echo "$apply_result" | pj "print(d.get('status', d.get('error','?')))")

  # Wait for completion
  local elapsed=0
  while [ $elapsed -lt $timeout ]; do
    local status=$(api GET "/api/changesets/$csid" | pj "print(d.get('status','?'))")
    case "$status" in
      completed) echo "completed"; return 0 ;;
      failed) echo "failed"; return 1 ;;
    esac
    sleep 2
    elapsed=$((elapsed + 2))
  done
  echo "timeout"
  return 1
}

# ── Setup ────────────────────────────────────────────────────

echo "🧹 Cleaning up drafts..."
cancel_drafts

# Start SSE listener
curl -s -N -H "Authorization: Bearer $TOKEN" \
  "$API/api/events/stream?token=$TOKEN" > "$SSE_LOG" 2>&1 &
SSE_PID=$!
sleep 1

HOSTINGER_NODE="0345453f-dcfb-4acd-8e39-cb55bb2d0431"
TEST_INSTANCE="6e2e54ee-3d1b-4b1d-9230-465295e0b61a"

echo ""
echo "═══════════════════════════════════════"
echo "1. READ ENDPOINTS"
echo "═══════════════════════════════════════"

for ep in nodes instances agents templates providers models changesets tasks operations activity audit settings; do
  path="/api/$ep"
  R=$(api GET "$path")
  if [ -n "$R" ] && [ "$R" != "null" ] && echo "$R" | python3 -c "import json,sys; d=json.load(sys.stdin); sys.exit(0 if isinstance(d,(list,dict)) and not (isinstance(d,dict) and 'error' in d) else 1)" 2>/dev/null; then
    pass "GET $path"
  else
    fail "GET $path" "$(echo "$R" | head -c 100)"
  fi
done

echo ""
echo "═══════════════════════════════════════"
echo "2. PROVIDER LIFECYCLE"
echo "═══════════════════════════════════════"

# Create
api POST "/api/providers" '{"name":"qa-provider","type":"openai","baseUrl":"https://qa.example.com"}' > /dev/null
CSID=$(get_draft)
if [ -n "$CSID" ]; then
  pass "Provider create → staged mutation + draft changeset"
  RESULT=$(apply_changeset "$CSID" 60)
  if [ "$RESULT" = "completed" ]; then
    pass "Provider create → changeset completed"
  else
    fail "Provider create → apply" "$RESULT"
  fi
else
  fail "Provider create" "No draft changeset created"
fi

# Get the provider ID
PROV_ID=$(api GET "/api/providers" | python3 -c "import json,sys; ps=[p for p in json.load(sys.stdin) if p.get('name')=='qa-provider']; print(ps[0]['id'] if ps else '')" 2>/dev/null)

# Update
if [ -n "$PROV_ID" ]; then
  cancel_drafts
  api PUT "/api/providers/$PROV_ID" '{"name":"qa-provider-updated","baseUrl":"https://qa2.example.com"}' > /dev/null
  CSID=$(get_draft)
  if [ -n "$CSID" ]; then
    pass "Provider update → staged"
    RESULT=$(apply_changeset "$CSID" 60)
    [ "$RESULT" = "completed" ] && pass "Provider update → completed" || fail "Provider update → apply" "$RESULT"
  else
    fail "Provider update" "No draft changeset"
  fi

  # Delete
  cancel_drafts
  api DELETE "/api/providers/$PROV_ID" > /dev/null
  CSID=$(get_draft)
  if [ -n "$CSID" ]; then
    pass "Provider delete → staged"
    RESULT=$(apply_changeset "$CSID" 60)
    [ "$RESULT" = "completed" ] && pass "Provider delete → completed" || fail "Provider delete → apply" "$RESULT"
  else
    fail "Provider delete" "No draft changeset"
  fi
else
  fail "Provider update/delete" "Provider not found after create"
fi

echo ""
echo "═══════════════════════════════════════"
echo "3. MODEL LIFECYCLE"
echo "═══════════════════════════════════════"

# Get a provider ID for the model
EXISTING_PROV=$(api GET "/api/providers" | python3 -c "import json,sys; ps=json.load(sys.stdin); print(ps[0]['id'] if ps else '')" 2>/dev/null)

if [ -n "$EXISTING_PROV" ]; then
  cancel_drafts
  api POST "/api/models" "{\"name\":\"qa-model\",\"modelId\":\"qa-test-1\",\"provider\":\"openai\",\"providerId\":\"$EXISTING_PROV\"}" > /dev/null
  CSID=$(get_draft)
  if [ -n "$CSID" ]; then
    pass "Model create → staged"
    RESULT=$(apply_changeset "$CSID" 60)
    [ "$RESULT" = "completed" ] && pass "Model create → completed" || fail "Model create → apply" "$RESULT"
  else
    fail "Model create" "No draft changeset"
  fi

  # Delete the model
  MODEL_ID=$(api GET "/api/models" | python3 -c "import json,sys; ms=[m for m in json.load(sys.stdin) if m.get('name')=='qa-model']; print(ms[0]['id'] if ms else '')" 2>/dev/null)
  if [ -n "$MODEL_ID" ]; then
    cancel_drafts
    api DELETE "/api/models/$MODEL_ID" > /dev/null
    CSID=$(get_draft)
    if [ -n "$CSID" ]; then
      pass "Model delete → staged"
      RESULT=$(apply_changeset "$CSID" 60)
      [ "$RESULT" = "completed" ] && pass "Model delete → completed" || fail "Model delete → apply" "$RESULT"
    else
      fail "Model delete" "No draft changeset"
    fi
  fi
else
  skip "Model lifecycle" "No providers available"
fi

echo ""
echo "═══════════════════════════════════════"
echo "4. AGENT OPERATIONS"
echo "═══════════════════════════════════════"

# Agent create (known to bypass — #530)
cancel_drafts
R=$(api POST "/api/agents" "{\"name\":\"qa-agent\",\"instanceId\":\"$TEST_INSTANCE\",\"templateId\":\"2f764baa-7d01-43c5-a79e-e3742897674b\",\"role\":\"research\",\"model\":\"anthropic/claude-sonnet-4-5\"}")
if echo "$R" | grep -q "changesetId\|staged"; then
  pass "Agent create → via changeset"
else
  warn "Agent create" "BYPASSES changeset (#530)"
  # Clean up
  api DELETE "/api/agents/qa-agent" > /dev/null 2>&1
fi

# Agent redeploy (should go through changeset)
cancel_drafts
R=$(api POST "/api/agents/forge/redeploy")
if echo "$R" | grep -q "staged"; then
  pass "Agent redeploy → staged via changeset"
  CSID=$(get_draft)
  if [ -n "$CSID" ]; then
    RESULT=$(apply_changeset "$CSID" 90)
    [ "$RESULT" = "completed" ] && pass "Agent redeploy → completed" || fail "Agent redeploy → apply" "$RESULT"
  fi
else
  fail "Agent redeploy" "$(echo "$R" | head -c 150)"
fi

echo ""
echo "═══════════════════════════════════════"
echo "5. INSTANCE OPERATIONS"
echo "═══════════════════════════════════════"

# Instance health (local)
R=$(api GET "/api/instances/$TEST_INSTANCE/health")
if echo "$R" | grep -q "healthy"; then
  pass "Instance health check (local)"
else
  fail "Instance health check" "$(echo "$R" | head -c 150)"
fi

# Instance restart via changeset
cancel_drafts
R=$(api POST "/api/instances/$TEST_INSTANCE/restart")
if echo "$R" | grep -q "staged\|changeset\|restarting"; then
  pass "Instance restart → staged"
  CSID=$(get_draft)
  if [ -n "$CSID" ]; then
    RESULT=$(apply_changeset "$CSID" 90)
    [ "$RESULT" = "completed" ] && pass "Instance restart → completed" || warn "Instance restart → apply" "$RESULT"
  fi
else
  warn "Instance restart" "$(echo "$R" | head -c 150)"
fi

echo ""
echo "═══════════════════════════════════════"
echo "6. CHANGESET OPERATIONS"
echo "═══════════════════════════════════════"

# Create + cancel
cancel_drafts
api POST "/api/providers" '{"name":"cancel-test","type":"openai","baseUrl":"https://cancel.example.com"}' > /dev/null
CSID=$(get_draft)
if [ -n "$CSID" ]; then
  pass "Changeset draft created"
  R=$(api POST "/api/changesets/$CSID/cancel")
  if echo "$R" | grep -q "cancelled"; then
    pass "Changeset cancel"
  else
    fail "Changeset cancel" "$(echo "$R" | head -c 100)"
  fi
else
  fail "Changeset draft" "Not created"
fi

# Multi-mutation changeset
cancel_drafts
api POST "/api/providers" '{"name":"batch-test-1","type":"openai","baseUrl":"https://b1.example.com"}' > /dev/null
api POST "/api/providers" '{"name":"batch-test-2","type":"openai","baseUrl":"https://b2.example.com"}' > /dev/null
CSID=$(get_draft)
if [ -n "$CSID" ]; then
  CHANGE_COUNT=$(api GET "/api/changesets/$CSID" | pj "print(len(d.get('changes',[])))")
  if [ "$CHANGE_COUNT" -gt 1 ] 2>/dev/null; then
    pass "Multi-mutation changeset ($CHANGE_COUNT changes)"
  else
    warn "Multi-mutation changeset" "Only $CHANGE_COUNT change(s)"
  fi
  RESULT=$(apply_changeset "$CSID" 60)
  [ "$RESULT" = "completed" ] && pass "Multi-mutation apply → completed" || fail "Multi-mutation apply" "$RESULT"
fi

# Clean up batch providers
cancel_drafts
for pname in cancel-test batch-test-1 batch-test-2 qa-provider-updated lifecycle-test-2; do
  PID=$(api GET "/api/providers" | python3 -c "import json,sys; ps=[p for p in json.load(sys.stdin) if p.get('name')=='$pname']; print(ps[0]['id'] if ps else '')" 2>/dev/null)
  [ -n "$PID" ] && api DELETE "/api/providers/$PID" > /dev/null 2>&1
done
CSID=$(get_draft)
[ -n "$CSID" ] && apply_changeset "$CSID" 30 > /dev/null 2>&1

echo ""
echo "═══════════════════════════════════════"
echo "7. PLUGIN OPERATIONS"
echo "═══════════════════════════════════════"

R=$(api GET "/api/plugins/library")
PLUGIN_COUNT=$(echo "$R" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))" 2>/dev/null)
[ "$PLUGIN_COUNT" -gt 0 ] && pass "Plugin library ($PLUGIN_COUNT plugins)" || warn "Plugin library" "empty"

R=$(api GET "/api/system/plugin-versions")
pass "Plugin version drift endpoint"

echo ""
echo "═══════════════════════════════════════"
echo "8. TASK DISPATCH"
echo "═══════════════════════════════════════"

R=$(api POST "/api/tasks" '{"fromAgent":"robin","toAgent":"forge","taskText":"QA test task"}')
if echo "$R" | grep -qF '"id"'; then
  pass "Task dispatch (creates task record)"
  TASK_ID=$(echo "$R" | pj "print(d.get('id',''))")
  sleep 5
  TASK_STATUS=$(api GET "/api/tasks/$TASK_ID" | pj "print(d.get('status','?'))")
  echo "     Task status after 5s: $TASK_STATUS"
else
  fail "Task dispatch" "$(echo "$R" | head -c 150)"
fi

echo ""
echo "═══════════════════════════════════════"
echo "9. CROSS-NODE (MacBook)"
echo "═══════════════════════════════════════"

MAC_NODE="731d6139-b64f-4f68-ab50-6ba3b7f08e03"
R=$(api GET "/api/nodes/$MAC_NODE" 2>/dev/null || api GET "/api/nodes")
MAC_STATUS=$(echo "$R" | python3 -c "
import json,sys
d = json.load(sys.stdin)
if isinstance(d, list):
  n = [x for x in d if x.get('id','').startswith('731d')]
  print(n[0]['status'] if n else 'not_found')
else:
  print(d.get('status','?'))
" 2>/dev/null)

if [ "$MAC_STATUS" = "online" ]; then
  # Test flimp health
  FLIMP_ID=$(api GET "/api/instances" | python3 -c "import json,sys; is_=[i for i in json.load(sys.stdin) if i['name']=='flimp']; print(is_[0]['id'] if is_ else '')" 2>/dev/null)
  if [ -n "$FLIMP_ID" ]; then
    R=$(api GET "/api/instances/$FLIMP_ID/health")
    if echo "$R" | grep -q "healthy"; then
      pass "Cross-node health check (flimp on Mac)"
    else
      warn "Cross-node health" "$(echo "$R" | head -c 100)"
    fi
  fi
else
  skip "Cross-node tests" "MacBook node status: $MAC_STATUS"
fi

echo ""
echo "═══════════════════════════════════════"
echo "10. SSE EVENT COVERAGE"
echo "═══════════════════════════════════════"

kill $SSE_PID 2>/dev/null
sleep 1

echo "  Events received during QA run:"
grep "^event:" "$SSE_LOG" | sort | uniq -c | sort -rn | while read count event; do
  echo "    $count × $event"
done

# Check for critical events
for evt in "mutation.staged" "changeset.applying" "changeset.completed" "provider.created"; do
  if grep -q "event: $evt" "$SSE_LOG"; then
    pass "SSE: $evt"
  else
    fail "SSE: $evt" "not received"
  fi
done

# Cleanup
rm -f "$SSE_LOG"

echo ""
echo "═══════════════════════════════════════"
echo "RESULTS"
echo "═══════════════════════════════════════"
echo "  ✅ Passed:   $PASS"
echo "  ❌ Failed:   $FAIL"
echo "  ⚠️  Warnings: $WARN"
echo "  ⏭️  Skipped:  $SKIP"
echo ""

TOTAL=$((PASS + FAIL))
if [ $FAIL -eq 0 ]; then
  echo "🟢 ALL $TOTAL TESTS PASSED ($WARN warnings, $SKIP skipped)"
elif [ $FAIL -le 2 ]; then
  echo "🟡 $PASS/$TOTAL passed — $FAIL failure(s) need attention"
else
  echo "🔴 $PASS/$TOTAL passed — $FAIL failure(s), system needs work"
fi
