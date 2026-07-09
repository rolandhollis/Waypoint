#!/usr/bin/env bash
# End-to-end smoke test — exercises the full request lifecycle against a
# running dev backend so we can quickly confirm nothing regressed after
# a schema change, refactor, or dependency bump.
#
# Runs read-only checks + creates a single temp project (auto-deleted at
# the end), so it's safe to run against a live dev DB. Requires only
# bash + curl + python3.
#
# Usage:
#     ./scripts/smoke.sh                 # against http://localhost:4000
#     API_URL=... ./scripts/smoke.sh     # against a different host
#     ./scripts/smoke.sh --keep          # keep the temp project

set -eu

API_URL="${API_URL:-http://localhost:4000}"
KEEP=0
if [ "${1:-}" = "--keep" ]; then KEEP=1; fi

# ---------- helpers ----------
step() { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
fail() { printf '  \033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# Prints one JSON field extracted with a python one-liner. Reads JSON from
# stdin so we don't leak intermediate files.
jq_field() {
  python3 -c "import sys,json;d=json.load(sys.stdin);
$1" || fail "failed to extract JSON field: $1"
}

# curl wrapper: dies on non-2xx and echoes the body on success.
call() {
  local method="$1"; local path="$2"; shift 2
  local body_arg=()
  if [ $# -gt 0 ]; then body_arg=(-d "$1"); fi
  local out status
  out=$(curl -sS -o /tmp/smoke-body.$$ -w '%{http_code}' \
    -X "$method" \
    -H "content-type: application/json" \
    -H "x-mock-user-id: ${ADMIN_ID:-}" \
    "${body_arg[@]}" \
    "$API_URL/api$path") || fail "curl failed for $method $path"
  status="$out"
  if [ "${status:0:1}" != "2" ]; then
    echo "response body:" >&2
    cat /tmp/smoke-body.$$ >&2
    rm -f /tmp/smoke-body.$$
    fail "$method $path returned HTTP $status"
  fi
  cat /tmp/smoke-body.$$
  rm -f /tmp/smoke-body.$$
}

# ---------- checks ----------
step "Health"
health=$(curl -sS -o - "$API_URL/api/health") || fail "backend not reachable at $API_URL"
echo "$health" | jq_field "print(f'auth={d[\"auth\"]}, ok={d[\"ok\"]}')" >/dev/null
ok "backend reachable ($health)"

step "Mock roster (unauthenticated)"
roster=$(curl -sS "$API_URL/api/users/mock-roster") \
  || fail "mock-roster unreachable (are you in AUTH_MODE=mock?)"
ADMIN_ID=$(echo "$roster" | jq_field "
admins=[u for u in d if u['role']=='admin']
if not admins: raise SystemExit('no admin in roster')
print(admins[0]['id'])")
ADMIN_NAME=$(echo "$roster" | jq_field "
admins=[u for u in d if u['role']=='admin']
print(admins[0]['name'])")
ok "picked admin: $ADMIN_NAME ($ADMIN_ID)"

step "Reads: users, lanes, teams"
me=$(call GET /users/me)
me_role=$(echo "$me" | jq_field "print(d['role'])")
[ "$me_role" = "admin" ] || fail "/users/me returned role=$me_role, expected admin"
ok "/users/me → admin"

lanes=$(call GET /swim-lanes)
lane_count=$(echo "$lanes" | jq_field "print(len(d))")
[ "$lane_count" -gt 0 ] || fail "no swim lanes"
LANE1_ID=$(echo "$lanes" | jq_field "print(d[0]['id'])")
LANE1_NAME=$(echo "$lanes" | jq_field "print(d[0]['name'])")
# Pick the last non-admin-only lane for the move/terminal-lane exercise
# — otherwise we'd land in Archive (admin-only) which is not terminal
# and doesn't exercise the actual_completion_date side effect.
LANE_LAST_ID=$(echo "$lanes" | jq_field "
visible=[l for l in d if not l.get('is_admin_only')]
print(visible[-1]['id'])")
LANE_LAST_NAME=$(echo "$lanes" | jq_field "
visible=[l for l in d if not l.get('is_admin_only')]
print(visible[-1]['name'])")
ok "$lane_count swim lanes (first=$LANE1_NAME, last-non-admin=$LANE_LAST_NAME)"

# All lanes should have descriptions after migration 005
missing_desc=$(echo "$lanes" | jq_field "
bad=[l['name'] for l in d if not (l.get('description') or '').strip()]
print(','.join(bad))")
if [ -n "$missing_desc" ]; then
  echo "  (warn) lanes without description: $missing_desc" >&2
else
  ok "every lane has a description"
fi

# Migration 007 invariant: at most one lane can be the "add new item" default.
default_count=$(echo "$lanes" | jq_field "print(sum(1 for l in d if l.get('is_default_new')))")
if [ "$default_count" -gt 1 ]; then
  fail "$default_count lanes marked is_default_new — partial unique index invariant broken"
else
  default_name=$(echo "$lanes" | jq_field "print(next((l['name'] for l in d if l.get('is_default_new')), '(none)'))")
  ok "default-new lane: $default_name"
fi

# Migration 012 invariant: at most one lane may be flagged is_archive
# (partial unique index) — same shape as is_default_new.
archive_count=$(echo "$lanes" | jq_field "print(sum(1 for l in d if l.get('is_archive')))")
if [ "$archive_count" -gt 1 ]; then
  fail "$archive_count lanes marked is_archive — partial unique index invariant broken"
else
  archive_name=$(echo "$lanes" | jq_field "print(next((l['name'] for l in d if l.get('is_archive')), '(none)'))")
  ok "archive lane: $archive_name"
fi

teams=$(call GET /teams)
TEAM1_ID=$(echo "$teams" | jq_field "print(d[0]['id'])")
ok "$(echo "$teams" | jq_field "print(len(d))") teams"

# ---------- create ----------
step "Create temp project + validate all phase-date fields round-trip"
today=$(date +%Y-%m-%d)
in7=$(python3 -c "import datetime;print((datetime.date.today()+datetime.timedelta(days=7)).isoformat())")
in14=$(python3 -c "import datetime;print((datetime.date.today()+datetime.timedelta(days=14)).isoformat())")
in21=$(python3 -c "import datetime;print((datetime.date.today()+datetime.timedelta(days=21)).isoformat())")
in28=$(python3 -c "import datetime;print((datetime.date.today()+datetime.timedelta(days=28)).isoformat())")

created=$(call POST /projects "$(python3 -c "
import json
print(json.dumps({
    'title':'SMOKE-TEST ephemeral',
    'description':'auto-created by scripts/smoke.sh',
    'swim_lane_id':'$LANE1_ID',
    'teams':['$TEAM1_ID'],
    'tags':['smoke','ephemeral'],
    'start_date':'$today',
    'target_date':'$in7',
    'dev_end_date':'$in14',
    'optimization_end_date':'$in21',
}))")")
PROJ_ID=$(echo "$created" | jq_field "print(d['id'])")
ok "created project id=$PROJ_ID"

# Multi-team round-trip: the create above sent one team, the response
# should echo that back as a single-element array.
got_teams=$(echo "$created" | jq_field "print(','.join(d.get('teams') or []))")
[ "$got_teams" = "$TEAM1_ID" ] || fail "teams round-trip: expected [$TEAM1_ID], got [$got_teams]"
ok "teams array round-tripped as expected"

# Round-trip check: every date we sent should come back verbatim
for f in start_date target_date dev_end_date optimization_end_date; do
  expected_var="in7"
  case "$f" in
    start_date)              expected="$today" ;;
    target_date)             expected="$in7" ;;
    dev_end_date)            expected="$in14" ;;
    optimization_end_date)   expected="$in21" ;;
  esac
  got=$(echo "$created" | jq_field "print(d['$f'])")
  [ "$got" = "$expected" ] || fail "$f round-trip: expected $expected, got $got"
done
ok "all phase dates round-tripped correctly"

# ---------- patch ----------
step "PATCH dev_start_date to open an awaiting-dev gap"
gap_start=$(python3 -c "import datetime;print((datetime.date.today()+datetime.timedelta(days=10)).isoformat())")
patched=$(call PATCH "/projects/$PROJ_ID" \
  "$(python3 -c "import json;print(json.dumps({'dev_start_date':'$gap_start','dev_end_date':'$in21','optimization_end_date':'$in28'}))")")
got=$(echo "$patched" | jq_field "print(d['dev_start_date'])")
[ "$got" = "$gap_start" ] || fail "dev_start_date PATCH round-trip failed"
ok "dev_start_date now $gap_start (creates 3-day Awaiting Dev gap)"

step "Constraint check: reject dev_end_date before dev_start_date"
before=$(python3 -c "import datetime;print((datetime.date.today()-datetime.timedelta(days=1)).isoformat())")
status=$(curl -sS -o /dev/null -w '%{http_code}' \
  -X PATCH -H "content-type: application/json" -H "x-mock-user-id: $ADMIN_ID" \
  -d "$(python3 -c "import json;print(json.dumps({'dev_end_date':'$before'}))")" \
  "$API_URL/api/projects/$PROJ_ID")
[ "$status" = "400" ] || fail "expected 400 for invalid dev_end_date, got $status"
ok "backend rejected invalid dev_end_date with HTTP 400"

# ---------- move ----------
step "Move project across lanes"
call POST "/projects/$PROJ_ID/move" \
  "$(python3 -c "import json;print(json.dumps({'swim_lane_id':'$LANE_LAST_ID'}))")" \
  >/dev/null
moved=$(call GET "/projects/$PROJ_ID")
got=$(echo "$moved" | jq_field "print(d['swim_lane_id'])")
[ "$got" = "$LANE_LAST_ID" ] || fail "move failed: still in $got"
ok "project moved to $LANE_LAST_NAME"

# If the last lane is terminal, actual_completion_date should auto-set.
is_terminal=$(echo "$lanes" | jq_field "
lane=[l for l in d if l['id']=='$LANE_LAST_ID'][0]
print('yes' if lane.get('is_terminal') else 'no')")
if [ "$is_terminal" = "yes" ]; then
  actual=$(echo "$moved" | jq_field "print(d.get('actual_completion_date') or '')")
  [ -n "$actual" ] || fail "expected actual_completion_date to be set on terminal-lane entry"
  ok "actual_completion_date auto-stamped: $actual"
fi

step "Move it back so cleanup is clean"
call POST "/projects/$PROJ_ID/move" \
  "$(python3 -c "import json;print(json.dumps({'swim_lane_id':'$LANE1_ID'}))")" \
  >/dev/null
back=$(call GET "/projects/$PROJ_ID")
got_ac=$(echo "$back" | jq_field "print(d.get('actual_completion_date') or '')")
[ -z "$got_ac" ] || fail "actual_completion_date should have cleared on exit from terminal lane"
ok "actual_completion_date cleared on exit from terminal lane"

# ---------- archive flow ----------
step "Archive round-trip via /projects/:id/archive"
call POST "/projects/$PROJ_ID/archive" >/dev/null
archived=$(call GET "/projects/$PROJ_ID")
archived_lane=$(echo "$archived" | jq_field "print(d['swim_lane_id'])")
expected_archive=$(echo "$lanes" | jq_field "
matches=[l['id'] for l in d if l.get('is_archive')]
print(matches[0] if matches else '')")
[ -n "$expected_archive" ] || fail "no archive lane exists to test against"
[ "$archived_lane" = "$expected_archive" ] || fail "expected lane $expected_archive, got $archived_lane"
ok "archive endpoint moved project into the archive lane"

# Non-admin visibility: the same project should now be filtered out of
# the owner's /projects list AND return 404 on a direct-by-id probe.
OWNER_ID=$(echo "$roster" | jq_field "
owners=[u for u in d if u['role']=='owner']
if not owners: raise SystemExit('no owner in roster')
print(owners[0]['id'])")
owner_hides=$(curl -sS -H "x-mock-user-id: $OWNER_ID" "$API_URL/api/projects" | \
  python3 -c "import sys,json; ps=json.load(sys.stdin); print('yes' if not any(p['id']=='$PROJ_ID' for p in ps) else 'no')")
[ "$owner_hides" = "yes" ] || fail "owner still sees archived project in list"
owner_probe=$(curl -sS -o /dev/null -w '%{http_code}' \
  -H "x-mock-user-id: $OWNER_ID" \
  "$API_URL/api/projects/$PROJ_ID")
[ "$owner_probe" = "404" ] || fail "expected 404 on owner probe of archived project, got $owner_probe"
ok "archived project hidden from non-admin list + by-id probe"

# Restore the project to a visible lane so cleanup (DELETE) works via
# the same admin call as before regardless of where it ended up.
call POST "/projects/$PROJ_ID/move" \
  "$(python3 -c "import json;print(json.dumps({'swim_lane_id':'$LANE1_ID'}))")" \
  >/dev/null
ok "moved back out of archive for cleanup"

# ---------- hierarchy (epic ↔ subtask) ----------
step "Hierarchy: create epic + subtask, exercise cascade, guards, and cycle detection"

# Fresh parent + child tree so we don't collide with the temp project
# above. All fixtures are deleted at the end of this section.
epic=$(call POST /projects "$(python3 -c "
import json
print(json.dumps({
    'title':'SMOKE-TEST epic parent',
    'swim_lane_id':'$LANE1_ID',
    'type':'epic',
    'start_date':'$today',
    'target_date':'$in7',
    'dev_end_date':'$in14',
    'optimization_end_date':'$in21',
}))")")
EPIC_ID=$(echo "$epic" | jq_field "print(d['id'])")
epic_type=$(echo "$epic" | jq_field "print(d['type'])")
epic_parent=$(echo "$epic" | jq_field "print(d.get('parent_id') or '')")
[ "$epic_type" = "epic" ] || fail "expected type=epic, got $epic_type"
[ -z "$epic_parent" ] || fail "epic must have null parent_id, got $epic_parent"
ok "created epic $EPIC_ID"

sub=$(call POST /projects "$(python3 -c "
import json
print(json.dumps({
    'title':'SMOKE-TEST subtask child',
    'swim_lane_id':'$LANE1_ID',
    'type':'subtask',
    'parent_id':'$EPIC_ID',
    'start_date':'$today',
    'target_date':'$in7',
    'dev_end_date':'$in14',
    'optimization_end_date':'$in21',
}))")")
SUB_ID=$(echo "$sub" | jq_field "print(d['id'])")
sub_type=$(echo "$sub" | jq_field "print(d['type'])")
sub_parent=$(echo "$sub" | jq_field "print(d.get('parent_id') or '')")
[ "$sub_type" = "subtask" ] || fail "expected type=subtask, got $sub_type"
[ "$sub_parent" = "$EPIC_ID" ] || fail "expected parent_id=$EPIC_ID, got $sub_parent"
ok "created subtask $SUB_ID under epic"

# Create-time rejection: subtask without a parent should 400.
status=$(curl -sS -o /dev/null -w '%{http_code}' \
  -X POST -H "content-type: application/json" -H "x-mock-user-id: $ADMIN_ID" \
  -d "$(python3 -c "import json;print(json.dumps({'title':'SMOKE bad','type':'subtask','swim_lane_id':'$LANE1_ID'}))")" \
  "$API_URL/api/projects")
[ "$status" = "400" ] || fail "expected 400 for subtask-without-parent, got $status"
ok "subtask-without-parent rejected with HTTP 400"

# Cascade: extend the subtask's optimization_end_date; the parent should
# auto-extend to at least match.
far=$(python3 -c "import datetime;print((datetime.date.today()+datetime.timedelta(days=90)).isoformat())")
call PATCH "/projects/$SUB_ID" \
  "$(python3 -c "import json;print(json.dumps({'optimization_end_date':'$far'}))")" \
  >/dev/null
epic_after=$(call GET "/projects/$EPIC_ID")
epic_opt_end=$(echo "$epic_after" | jq_field "print(d['optimization_end_date'])")
[ "$epic_opt_end" = "$far" ] || fail "cascade upward failed: epic opt_end=$epic_opt_end, expected $far"
ok "subtask push cascaded up to epic (opt_end=$far)"

# Shrink guard: cannot pull the epic's opt_end below the subtask's.
status=$(curl -sS -o /dev/null -w '%{http_code}' \
  -X PATCH -H "content-type: application/json" -H "x-mock-user-id: $ADMIN_ID" \
  -d "$(python3 -c "import json;print(json.dumps({'optimization_end_date':'$in21'}))")" \
  "$API_URL/api/projects/$EPIC_ID")
[ "$status" = "400" ] || fail "expected 400 shrinking epic below subtask, got $status"
ok "shrinking epic below subtask rejected with HTTP 400"

# Delete guard: cannot hard-delete an epic with live subtasks.
status=$(curl -sS -o /dev/null -w '%{http_code}' \
  -X DELETE -H "x-mock-user-id: $ADMIN_ID" \
  "$API_URL/api/projects/$EPIC_ID")
[ "$status" = "400" ] || fail "expected 400 deleting parent-with-subtasks, got $status"
ok "delete-with-subtasks rejected with HTTP 400"

# Cycle guard: try to move the epic under its own descendant.
status=$(curl -sS -o /dev/null -w '%{http_code}' \
  -X PATCH -H "content-type: application/json" -H "x-mock-user-id: $ADMIN_ID" \
  -d "$(python3 -c "import json;print(json.dumps({'type':'subtask','parent_id':'$SUB_ID'}))")" \
  "$API_URL/api/projects/$EPIC_ID")
[ "$status" = "400" ] || fail "expected 400 for cycle (parent → own descendant), got $status"
ok "cycle attempt (parent under own descendant) rejected with HTTP 400"

# Cleanup: subtask first (parent still can't be deleted otherwise),
# then epic. Uses DELETE both times to also stress the guard shape.
call DELETE "/projects/$SUB_ID" >/dev/null
call DELETE "/projects/$EPIC_ID" >/dev/null
ok "cleaned up hierarchy fixtures"

# ---------- KPIs ----------
step "KPI CRUD + ordered per-project assignment"

# Non-admins can read the catalog but not mutate it.
VIEWER_ID=$(call GET /users | jq_field "
viewers=[u for u in d if u['role']=='viewer']
print(viewers[0]['id'] if viewers else '')")
if [ -n "$VIEWER_ID" ]; then
  status=$(curl -sS -o /dev/null -w '%{http_code}' \
    -X POST -H "content-type: application/json" -H "x-mock-user-id: $VIEWER_ID" \
    -d '{"name":"SMOKE viewer KPI"}' \
    "$API_URL/api/kpis")
  [ "$status" = "403" ] || fail "expected 403 for viewer POST /kpis, got $status"
  ok "viewers blocked from creating KPIs (403)"
fi

# Admin can create two KPIs to verify the ordered-assignment behavior.
kpi_a=$(call POST /kpis '{"name":"SMOKE KPI A","color":"#123456"}')
kpi_b=$(call POST /kpis '{"name":"SMOKE KPI B","description":"a longer description","color":"#abcdef"}')
KPI_A=$(echo "$kpi_a" | jq_field "print(d['id'])")
KPI_B=$(echo "$kpi_b" | jq_field "print(d['id'])")
ok "created KPIs $KPI_A and $KPI_B"

# Rename via PATCH.
patched=$(call PATCH "/kpis/$KPI_A" '{"name":"SMOKE KPI A (renamed)"}')
new_name=$(echo "$patched" | jq_field "print(d['name'])")
[ "$new_name" = "SMOKE KPI A (renamed)" ] || fail "PATCH /kpis returned name=$new_name"
ok "renamed KPI via PATCH"

# Assign both to the temp project in [A, B] order; expect API to
# echo the array back in that exact order.
call PATCH "/projects/$PROJ_ID" "$(python3 -c "
import json
print(json.dumps({'kpis':['$KPI_A','$KPI_B']}))")" >/dev/null
got=$(call GET "/projects/$PROJ_ID" | jq_field "print(','.join(d['kpis']))")
[ "$got" = "$KPI_A,$KPI_B" ] || fail "expected kpis=$KPI_A,$KPI_B got $got"
ok "project kpis persisted in submitted order"

# Reorder to [B, A] and re-verify.
call PATCH "/projects/$PROJ_ID" "$(python3 -c "
import json
print(json.dumps({'kpis':['$KPI_B','$KPI_A']}))")" >/dev/null
got=$(call GET "/projects/$PROJ_ID" | jq_field "print(','.join(d['kpis']))")
[ "$got" = "$KPI_B,$KPI_A" ] || fail "expected reordered kpis=$KPI_B,$KPI_A got $got"
ok "project kpis reordered — order change is persisted"

# The reorder should have written an audit event (kpis is in AUDITED_FIELDS
# and treated as order-sensitive).
audit_count=$(call GET "/projects/$PROJ_ID/history" | jq_field "
kpi_edits=[e for e in d if e.get('kind')=='edit' and e.get('field')=='kpis']
print(len(kpi_edits))")
[ "$audit_count" -ge 2 ] || fail "expected >=2 kpi audit events, got $audit_count"
ok "kpi assignment + reorder produced audit events ($audit_count total)"

# Deleting a KPI must cascade through project_kpis.
call DELETE "/kpis/$KPI_A" >/dev/null
got=$(call GET "/projects/$PROJ_ID" | jq_field "print(','.join(d['kpis']))")
[ "$got" = "$KPI_B" ] || fail "expected cascade to leave only $KPI_B, got $got"
ok "KPI delete cascaded through project_kpis"

# Cleanup the second KPI (implicit clear on the temp project).
call DELETE "/kpis/$KPI_B" >/dev/null
ok "cleaned up KPI fixtures"

# ---------- capacity (users + teams) ----------
step "Capacity — user + team caps round-trip"
# Users default to 3 after migration 015; assert one has a numeric cap.
users_json=$(call GET /users)
default_cap=$(echo "$users_json" | jq_field "
caps=[u.get('capacity') for u in d]
nums=[c for c in caps if isinstance(c,int)]
print(nums[0] if nums else 'MISSING')")
[ "$default_cap" != "MISSING" ] || fail "no user had a numeric capacity — migration 015 might not have run"
ok "default user capacity present ($default_cap)"

# Flip a user's cap to null (no cap), then back to 5.
call PATCH "/users/$ADMIN_ID" '{"capacity":null}' >/dev/null
got=$(call GET /users | jq_field "print([u['capacity'] for u in d if u['id']=='$ADMIN_ID'][0])")
[ "$got" = "None" ] || fail "expected null capacity, got $got"
ok "cleared admin capacity"
call PATCH "/users/$ADMIN_ID" '{"capacity":5}' >/dev/null
got=$(call GET /users | jq_field "print([u['capacity'] for u in d if u['id']=='$ADMIN_ID'][0])")
[ "$got" = "5" ] || fail "expected capacity=5, got $got"
ok "set admin capacity=5"

# Teams: pick the first team and cycle its cap.
teams_json=$(call GET /teams)
TEAM_ID=$(echo "$teams_json" | jq_field "print(d[0]['id'])")
call PATCH "/teams/$TEAM_ID" '{"capacity":2}' >/dev/null
got=$(call GET /teams | jq_field "print([t['capacity'] for t in d if t['id']=='$TEAM_ID'][0])")
[ "$got" = "2" ] || fail "expected team capacity=2, got $got"
ok "team capacity round-tripped"

# Reject non-positive integer via validation error.
bad_status=$(curl -sS -o /dev/null -w '%{http_code}' \
  -X PATCH -H "content-type: application/json" -H "x-mock-user-id: $ADMIN_ID" \
  -d '{"capacity":0}' "$API_URL/api/users/$ADMIN_ID")
[ "$bad_status" = "400" ] || fail "expected 400 for capacity=0, got $bad_status"
ok "capacity=0 rejected by validator"

# ---------- phases page data ----------
step "Phases endpoint (/api/swim-lanes) returns admin descriptions"
descs_ok=$(call GET /swim-lanes | jq_field "
strs=[l for l in d if (l.get('description') or '').strip()]
print(len(strs))")
[ "$descs_ok" -gt 0 ] || fail "no lanes returned descriptions — did migration 005 run?"
ok "$descs_ok lanes have populated descriptions"

# ---------- cleanup ----------
if [ "$KEEP" -eq 0 ]; then
  step "Cleanup: soft-delete temp project"
  call DELETE "/projects/$PROJ_ID" >/dev/null
  ok "deleted temp project"
else
  step "Cleanup skipped (--keep)"
  ok "temp project left in place: $PROJ_ID"
fi

printf '\n\033[1;32m✓ Smoke test passed\033[0m\n'
