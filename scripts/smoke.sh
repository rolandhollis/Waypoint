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
LANE_LAST_ID=$(echo "$lanes" | jq_field "print(d[-1]['id'])")
LANE_LAST_NAME=$(echo "$lanes" | jq_field "print(d[-1]['name'])")
ok "$lane_count swim lanes (first=$LANE1_NAME, last=$LANE_LAST_NAME)"

# All lanes should have descriptions after migration 005
missing_desc=$(echo "$lanes" | jq_field "
bad=[l['name'] for l in d if not (l.get('description') or '').strip()]
print(','.join(bad))")
if [ -n "$missing_desc" ]; then
  echo "  (warn) lanes without description: $missing_desc" >&2
else
  ok "every lane has a description"
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
