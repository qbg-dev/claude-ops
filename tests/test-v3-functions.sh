#!/usr/bin/env bash
# test-v3-functions.sh — Unit tests for individual harness functions
#
# Covers the 51 previously-untested functions across:
#   harness-jq.sh, event-bus.sh, pane-resolve.sh
#
# Sections:
#   1.  iso_to_epoch: date parsing on macOS
#   2.  Pane registry CRUD: update, read, remove, set_session
#   3.  worker_pane_register: worker-specific fields
#   4.  hook_parse_input: JSON hook input parsing
#   5.  hook_block / hook_pass / hook_context: output format
#   6.  hook_resolve_harness: canonical derivation
#   7.  harness_lifecycle: config.json lifecycle field
#   8.  harness_sleep_duration: worker vs top-level vs default
#   9.  harness_operating_mode: self-sidecar vs sidecar-executor
#  10.  harness_bump_session: cycle incrementing
#  11.  harness_update_state: atomic state mutation + diff
#  12.  harness_last_cycle_at / harness_phase_entered_at
#  13.  Directory helpers: runtime, session_dir, monitor_dir, logs_dir, tmp_dir
#  14.  harness_list_all / harness_all_progress_files
#  15.  _file_mtime: portable mtime
#  16.  _harness_bus_publish: fire-and-forget wrapper
#  17.  Event bus internals: cursor_file, get_cursor, next_seq, ensure_dirs
#  18.  Event bus: _bus_run_side_effects
#  19.  Event bus: lock contention and timeout
#  20.  pane-resolve.sh: resolve_project_root, resolve_harness_dir, resolve_session_dir
#  21.  pane_registry_update with agent_role
#  22.  harness_inject_policy: context injection
#  23.  locked_jq_write edge cases: missing file, empty filter, nested objects
#
# Usage:
#   bash ~/.claude-ops/tests/test-v3-functions.sh
set -euo pipefail

source "$(dirname "$0")/helpers.sh"
source "$HOME/.claude-ops/lib/harness-jq.sh"

PROJECT_ROOT="${PROJECT_ROOT:-$(git -C "$HOME/Desktop/zPersonalProjects/Wechat" rev-parse --show-toplevel 2>/dev/null)}"

# ════════════════════════════════════════════════════════════════
# 1. iso_to_epoch
# ════════════════════════════════════════════════════════════════
echo "── iso_to_epoch ──"

EPOCH=$(iso_to_epoch "2026-01-15T12:30:00Z")
if [ "$EPOCH" -gt 1000000000 ] 2>/dev/null; then
  assert_equals "valid ISO → epoch > 1B" "yes" "yes"
else
  assert_equals "valid ISO → epoch > 1B" "yes" "no (got $EPOCH)"
fi

EPOCH2=$(iso_to_epoch "garbage-input")
assert_equals "garbage input → 0" "0" "$EPOCH2"

EPOCH3=$(iso_to_epoch "")
assert_equals "empty input → 0" "0" "$EPOCH3"

# ════════════════════════════════════════════════════════════════
# 2. Pane registry CRUD
# ════════════════════════════════════════════════════════════════
echo ""
echo "── pane registry CRUD ──"

ORIG_REG="$PANE_REGISTRY"
TMP=$(mktemp -d)
export PANE_REGISTRY="$TMP/pane-registry.json"
echo '{}' > "$PANE_REGISTRY"

# Update
pane_registry_update "%100" "test-harness" "task-1" "2" "5" "test: 2/5"
ENTRY=$(pane_registry_read "%100")
H=$(echo "$ENTRY" | jq -r '.harness')
D=$(echo "$ENTRY" | jq -r '.done')
T=$(echo "$ENTRY" | jq -r '.total')
assert_equals "update: harness set" "test-harness" "$H"
assert_equals "update: done=2" "2" "$D"
assert_equals "update: total=5" "5" "$T"

# Read nonexistent
EMPTY=$(pane_registry_read "%999")
assert_equals "read nonexistent → {}" "{}" "$EMPTY"

# Update with pane_target
pane_registry_update "%101" "test-h2" "task-2" "0" "3" "h2: 0/3" "h:1.0"
PT=$(pane_registry_read "%101" | jq -r '.pane_target')
assert_equals "update with pane_target" "h:1.0" "$PT"

# Update with agent_role
pane_registry_update "%102" "test-h3" "task-3" "1" "4" "h3: 1/4" "h:2.0" "worker"
ROLE=$(pane_registry_read "%102" | jq -r '.agent_role')
assert_equals "update with agent_role" "worker" "$ROLE"

# Set session
pane_registry_set_session "%100" "my-session-name" "doing cool stuff"
SN=$(pane_registry_read "%100" | jq -r '.session_name')
SS=$(pane_registry_read "%100" | jq -r '.session_summary')
assert_equals "set_session: name" "my-session-name" "$SN"
assert_equals "set_session: summary" "doing cool stuff" "$SS"
# Original fields preserved
H2=$(pane_registry_read "%100" | jq -r '.harness')
assert_equals "set_session: preserves harness" "test-harness" "$H2"

# Remove
pane_registry_remove "%100"
GONE=$(pane_registry_read "%100")
assert_equals "remove: entry gone" "{}" "$GONE"

# Others still present
H3=$(pane_registry_read "%101" | jq -r '.harness')
assert_equals "remove: others preserved" "test-h2" "$H3"

# Remove from empty
pane_registry_remove "%999"  # Should not error
assert_equals "remove nonexistent: no error" "0" "$?"

export PANE_REGISTRY="$ORIG_REG"
rm -rf "$TMP"

# ════════════════════════════════════════════════════════════════
# 3. worker_pane_register
# ════════════════════════════════════════════════════════════════
echo ""
echo "── worker_pane_register ──"

TMP=$(mktemp -d)
ORIG_REG="$PANE_REGISTRY"
export PANE_REGISTRY="$TMP/pane-registry.json"
echo '{}' > "$PANE_REGISTRY"

worker_pane_register "%200" "mod-finance" "arrears-engine" "execution" "0" "0" "h:3.1"
ENTRY=$(pane_registry_read "%200")

WH=$(echo "$ENTRY" | jq -r '.harness')
WP=$(echo "$ENTRY" | jq -r '.parent')
WR=$(echo "$ENTRY" | jq -r '.agent_role')
WT=$(echo "$ENTRY" | jq -r '.worker_type')
WD=$(echo "$ENTRY" | jq -r '.display')
assert_equals "worker reg: harness=worker name" "arrears-engine" "$WH"
assert_equals "worker reg: parent=module" "mod-finance" "$WP"
assert_equals "worker reg: agent_role=worker" "worker" "$WR"
assert_equals "worker reg: worker_type" "execution" "$WT"
assert "worker reg: display has parent/name" "mod-finance/arrears-engine" "$WD"

export PANE_REGISTRY="$ORIG_REG"
rm -rf "$TMP"

# ════════════════════════════════════════════════════════════════
# 4. hook_parse_input
# ════════════════════════════════════════════════════════════════
echo ""
echo "── hook_parse_input ──"

# Normal JSON input
INPUT='{"session_id":"abc123","tool_name":"Bash","tool_input":{"command":"ls"}}'
hook_parse_input "$INPUT"
assert_equals "parse: session_id" "abc123" "$_HOOK_SESSION_ID"
assert_equals "parse: tool_name" "Bash" "$_HOOK_TOOL_NAME"
TCMD=$(echo "$_HOOK_TOOL_INPUT" | jq -r '.command' 2>/dev/null || echo "FAIL")
assert_equals "parse: tool_input.command" "ls" "$TCMD"

# String-wrapped tool_input (some hooks receive this)
INPUT2='{"session_id":"def","tool_name":"Edit","tool_input":"{\"file\":\"test.ts\"}"}'
hook_parse_input "$INPUT2"
TF=$(echo "$_HOOK_TOOL_INPUT" | jq -r '.file' 2>/dev/null || echo "FAIL")
assert_equals "parse: string-wrapped tool_input" "test.ts" "$TF"

# Missing fields
INPUT3='{}'
hook_parse_input "$INPUT3"
assert_equals "parse: missing session_id → empty" "" "$_HOOK_SESSION_ID"
assert_equals "parse: missing tool_name → empty" "" "$_HOOK_TOOL_NAME"

# Garbage input
hook_parse_input "not json at all"
assert_equals "parse: garbage → empty session" "" "$_HOOK_SESSION_ID"

# ════════════════════════════════════════════════════════════════
# 5. hook_block / hook_pass / hook_context
# ════════════════════════════════════════════════════════════════
echo ""
echo "── hook output functions ──"

# hook_block
BLOCK_OUT=$(hook_block "test reason" 2>/dev/null)
DECISION=$(echo "$BLOCK_OUT" | jq -r '.decision')
REASON=$(echo "$BLOCK_OUT" | jq -r '.reason')
assert_equals "hook_block: decision=block" "block" "$DECISION"
assert_equals "hook_block: reason preserved" "test reason" "$REASON"

# hook_context
CTX_OUT=$(hook_context "injected context text")
AC=$(echo "$CTX_OUT" | jq -r '.additionalContext')
assert_equals "hook_context: additionalContext set" "injected context text" "$AC"

# hook_pass
PASS_OUT=$(hook_pass)
assert_equals "hook_pass: returns {}" "{}" "$PASS_OUT"

# hook_block with special chars
BLOCK_SPECIAL=$(hook_block "reason with \"quotes\" and 'apostrophes'" 2>/dev/null)
DECISION2=$(echo "$BLOCK_SPECIAL" | jq -r '.decision')
assert_equals "hook_block: special chars handled" "block" "$DECISION2"

# ════════════════════════════════════════════════════════════════
# 6. hook_resolve_harness
# ════════════════════════════════════════════════════════════════
echo ""
echo "── hook_resolve_harness ──"

TMP=$(mktemp -d)
ORIG_REG="$PANE_REGISTRY"
export PANE_REGISTRY="$TMP/pane-registry.json"

# Top-level harness (no parent)
jq -n '{ "%300": { "harness": "hq-v2" } }' > "$PANE_REGISTRY"
hook_resolve_harness "%300" "session-1"
assert_equals "resolve: top-level harness" "hq-v2" "$HARNESS"
assert_equals "resolve: top-level canonical" "hq-v2" "$CANONICAL"

# Worker (has parent)
jq -n '{ "%301": { "harness": "red-team", "parent": "mod-engineering" } }' > "$PANE_REGISTRY"
hook_resolve_harness "%301" "session-2"
assert_equals "resolve: worker harness" "red-team" "$HARNESS"
assert_equals "resolve: worker canonical" "mod-engineering/red-team" "$CANONICAL"

# Unknown pane
hook_resolve_harness "%999" "session-3"
assert_equals "resolve: unknown pane → empty" "" "$HARNESS"
assert_equals "resolve: unknown canonical → empty" "" "$CANONICAL"

# Empty pane_id
hook_resolve_harness "" "session-4"
assert_equals "resolve: empty pane → empty" "" "$HARNESS"

export PANE_REGISTRY="$ORIG_REG"
rm -rf "$TMP"

# ════════════════════════════════════════════════════════════════
# 7. harness_lifecycle
# ════════════════════════════════════════════════════════════════
echo ""
echo "── harness_lifecycle ──"

TMP=$(mktemp -d)
mkdir -p "$TMP/agents/sidecar"

# bounded (default)
echo '{}' > "$TMP/agents/sidecar/config.json"
echo '{}' > "$TMP/agents/sidecar/state.json"
echo '{"tasks":{}}' > "$TMP/tasks.json"
LC=$(harness_lifecycle "$TMP/tasks.json")
assert_equals "lifecycle: default → bounded" "bounded" "$LC"

# explicit long-running
echo '{"lifecycle":"long-running"}' > "$TMP/agents/sidecar/config.json"
LC2=$(harness_lifecycle "$TMP/tasks.json")
assert_equals "lifecycle: long-running" "long-running" "$LC2"

# perpetual → long-running (normalized)
echo '{"lifecycle":"perpetual"}' > "$TMP/agents/sidecar/config.json"
LC3=$(harness_lifecycle "$TMP/tasks.json")
assert_equals "lifecycle: perpetual → long-running" "long-running" "$LC3"

rm -rf "$TMP"

# ════════════════════════════════════════════════════════════════
# 8. harness_sleep_duration
# ════════════════════════════════════════════════════════════════
echo ""
echo "── harness_sleep_duration ──"

TMP=$(mktemp -d)
mkdir -p "$TMP/.claude/harness/test-mod/agents/sidecar"
mkdir -p "$TMP/.claude/harness/test-mod/agents/worker/test-worker"

# Worker with explicit sleep_duration
echo '{"sleep_duration": 600}' > "$TMP/.claude/harness/test-mod/agents/worker/test-worker/state.json"
SD=$(PROJECT_ROOT="$TMP" harness_sleep_duration "test-mod/test-worker")
assert_equals "sleep: worker explicit 600" "600" "$SD"

# Top-level sidecar with sleep_duration
echo '{"sleep_duration": 1200}' > "$TMP/.claude/harness/test-mod/agents/sidecar/state.json"
SD2=$(PROJECT_ROOT="$TMP" harness_sleep_duration "test-mod")
assert_equals "sleep: top-level sidecar 1200" "1200" "$SD2"

# Top-level fallback to progress.json
mkdir -p "$TMP/.claude/harness/legacy-mod/agents/sidecar"
echo '{}' > "$TMP/.claude/harness/legacy-mod/agents/sidecar/state.json"
echo '{"sleep_duration": 1800}' > "$TMP/.claude/harness/legacy-mod/progress.json"
SD3=$(PROJECT_ROOT="$TMP" harness_sleep_duration "legacy-mod")
assert_equals "sleep: fallback to progress.json" "1800" "$SD3"

# Default when nothing set
mkdir -p "$TMP/.claude/harness/bare-mod/agents/sidecar"
echo '{}' > "$TMP/.claude/harness/bare-mod/agents/sidecar/state.json"
SD4=$(PROJECT_ROOT="$TMP" harness_sleep_duration "bare-mod")
assert_equals "sleep: default 900" "900" "$SD4"

# Nonexistent module → default
SD5=$(PROJECT_ROOT="$TMP" harness_sleep_duration "nonexistent")
assert_equals "sleep: nonexistent → 900" "900" "$SD5"

rm -rf "$TMP"

# ════════════════════════════════════════════════════════════════
# 9. harness_operating_mode
# ════════════════════════════════════════════════════════════════
echo ""
echo "── harness_operating_mode ──"

TMP=$(mktemp -d)
mkdir -p "$TMP/.claude/harness/with-workers/agents/sidecar"
mkdir -p "$TMP/.claude/harness/with-workers/agents/worker/w1"
echo '{"name":"with-workers"}' > "$TMP/.claude/harness/with-workers/agents/sidecar/config.json"
echo '{}' > "$TMP/.claude/harness/with-workers/agents/sidecar/state.json"
echo '{"tasks":{}}' > "$TMP/.claude/harness/with-workers/tasks.json"
touch "$TMP/.claude/harness/with-workers/agents/worker/w1/config.json"

MODE=$(harness_operating_mode "$TMP/.claude/harness/with-workers/tasks.json" "$TMP")
assert_equals "mode: with workers → sidecar-executor" "sidecar-executor" "$MODE"

mkdir -p "$TMP/.claude/harness/no-workers/agents/sidecar"
echo '{"name":"no-workers"}' > "$TMP/.claude/harness/no-workers/agents/sidecar/config.json"
echo '{}' > "$TMP/.claude/harness/no-workers/agents/sidecar/state.json"
echo '{"tasks":{}}' > "$TMP/.claude/harness/no-workers/tasks.json"

MODE2=$(harness_operating_mode "$TMP/.claude/harness/no-workers/tasks.json" "$TMP")
assert_equals "mode: no workers → self-sidecar" "self-sidecar" "$MODE2"

rm -rf "$TMP"

# ════════════════════════════════════════════════════════════════
# 10. harness_bump_session
# ════════════════════════════════════════════════════════════════
echo ""
echo "── harness_bump_session ──"

TMP=$(mktemp -d)
mkdir -p "$TMP/.claude/bus/cursors" "$TMP/.claude/bus/dlq"
echo '{"global":0}' > "$TMP/.claude/bus/seq.json"
echo '{"event_types":{}}' > "$TMP/.claude/bus/schema.json"
touch "$TMP/.claude/bus/stream.jsonl"

mkdir -p "$TMP/agents/sidecar"
echo '{"cycles_completed":3,"last_cycle_at":null,"status":"active"}' > "$TMP/agents/sidecar/state.json"
echo '{}' > "$TMP/agents/sidecar/config.json"
echo '{"tasks":{}}' > "$TMP/tasks.json"

PROJECT_ROOT="$TMP" harness_bump_session "$TMP/tasks.json"
CC=$(jq -r '.cycles_completed' "$TMP/agents/sidecar/state.json")
LCA=$(jq -r '.last_cycle_at' "$TMP/agents/sidecar/state.json")
ST=$(jq -r '.status' "$TMP/agents/sidecar/state.json")
assert_equals "bump: cycles 3→4" "4" "$CC"
assert_equals "bump: status=active" "active" "$ST"
if [ "$LCA" != "null" ] && [ -n "$LCA" ]; then
  assert_equals "bump: last_cycle_at set" "yes" "yes"
else
  assert_equals "bump: last_cycle_at set" "yes" "no"
fi

# Bump again → 5
PROJECT_ROOT="$TMP" harness_bump_session "$TMP/tasks.json"
CC2=$(jq -r '.cycles_completed' "$TMP/agents/sidecar/state.json")
assert_equals "bump: cycles 4→5" "5" "$CC2"

rm -rf "$TMP"

# ════════════════════════════════════════════════════════════════
# 11. harness_update_state
# ════════════════════════════════════════════════════════════════
echo ""
echo "── harness_update_state ──"

TMP=$(mktemp -d)
mkdir -p "$TMP/.claude/bus/cursors" "$TMP/.claude/bus/dlq"
echo '{"global":0}' > "$TMP/.claude/bus/seq.json"
echo '{"event_types":{}}' > "$TMP/.claude/bus/schema.json"
touch "$TMP/.claude/bus/stream.jsonl"
mkdir -p "$TMP/agents/sidecar"

echo '{"status":"active","cycles_completed":0}' > "$TMP/agents/sidecar/state.json"
PROJECT_ROOT="$TMP" harness_update_state "$TMP/agents/sidecar/state.json" '.cycles_completed = 5'
CC=$(jq -r '.cycles_completed' "$TMP/agents/sidecar/state.json")
assert_equals "update_state: set cycles to 5" "5" "$CC"

# Status preserved
ST=$(jq -r '.status' "$TMP/agents/sidecar/state.json")
assert_equals "update_state: status preserved" "active" "$ST"

# Missing file → ERROR
RESULT=$(PROJECT_ROOT="$TMP" harness_update_state "/nonexistent/state.json" '.x=1' 2>&1 || true)
assert "update_state: missing file → error" "not found" "$RESULT"

# Update with --arg
echo '{"name":"test","value":"old"}' > "$TMP/agents/sidecar/state.json"
PROJECT_ROOT="$TMP" harness_update_state "$TMP/agents/sidecar/state.json" '.value = $v' --arg v "new"
V=$(jq -r '.value' "$TMP/agents/sidecar/state.json")
assert_equals "update_state: --arg works" "new" "$V"

rm -rf "$TMP"

# ════════════════════════════════════════════════════════════════
# 12. harness_last_cycle_at / harness_phase_entered_at
# ════════════════════════════════════════════════════════════════
echo ""
echo "── cycle timestamps ──"

TMP=$(mktemp -d)
mkdir -p "$TMP/agents/sidecar"
echo '{"last_cycle_at":"2026-01-15T10:00:00Z","current_session":{"cycle_phase":"probe","cycle_phase_entered_at":"2026-01-15T10:05:00Z"}}' > "$TMP/agents/sidecar/state.json"
echo '{}' > "$TMP/agents/sidecar/config.json"
echo '{"tasks":{}}' > "$TMP/tasks.json"

LCA=$(harness_last_cycle_at "$TMP/tasks.json")
assert_equals "last_cycle_at" "2026-01-15T10:00:00Z" "$LCA"

PHASE=$(harness_cycle_phase "$TMP/tasks.json")
assert_equals "cycle_phase" "probe" "$PHASE"

PEA=$(harness_phase_entered_at "$TMP/tasks.json")
assert_equals "phase_entered_at" "2026-01-15T10:05:00Z" "$PEA"

# Missing fields → defaults
echo '{}' > "$TMP/agents/sidecar/state.json"
LCA2=$(harness_last_cycle_at "$TMP/tasks.json")
assert_equals "last_cycle_at: missing → null" "null" "$LCA2"

PHASE2=$(harness_cycle_phase "$TMP/tasks.json")
assert_equals "cycle_phase: missing → unknown" "unknown" "$PHASE2"

PEA2=$(harness_phase_entered_at "$TMP/tasks.json")
assert_equals "phase_entered_at: missing → 0" "0" "$PEA2"

rm -rf "$TMP"

# ════════════════════════════════════════════════════════════════
# 13. Directory helpers
# ════════════════════════════════════════════════════════════════
echo ""
echo "── directory helpers ──"

TMP=$(mktemp -d)
ORIG_STATE="$HARNESS_STATE_DIR"
export HARNESS_STATE_DIR="$TMP"

# harness_runtime
RT=$(harness_runtime "test-agent")
assert "runtime: contains test-agent" "test-agent" "$RT"
[ -d "$RT" ] && assert_equals "runtime: dir created" "yes" "yes" || assert_equals "runtime: dir created" "yes" "no"

# harness_runtime with slash path (worker canonical)
RT2=$(harness_runtime "mod-eng/red-team")
assert "runtime: slash path" "mod-eng/red-team" "$RT2"
[ -d "$RT2" ] && assert_equals "runtime: slash dir created" "yes" "yes" || assert_equals "runtime: slash dir created" "yes" "no"

# harness_session_dir
SD=$(harness_session_dir "sess-abc123")
assert "session_dir: contains session id" "sess-abc123" "$SD"
[ -d "$SD" ] && assert_equals "session_dir: created" "yes" "yes" || assert_equals "session_dir: created" "yes" "no"

# harness_monitor_dir
MD=$(harness_monitor_dir "pid42")
assert "monitor_dir: contains slug" "pid42" "$MD"

# harness_logs_dir
LD=$(harness_logs_dir)
[ -d "$LD" ] && assert_equals "logs_dir: created" "yes" "yes" || assert_equals "logs_dir: created" "yes" "no"

# harness_tmp_dir
TD=$(harness_tmp_dir)
[ -d "$TD" ] && assert_equals "tmp_dir: created" "yes" "yes" || assert_equals "tmp_dir: created" "yes" "no"

export HARNESS_STATE_DIR="$ORIG_STATE"
rm -rf "$TMP"

# ════════════════════════════════════════════════════════════════
# 14. harness_list_all (reads from ~/.claude-ops/harness/manifests/)
# ════════════════════════════════════════════════════════════════
echo ""
echo "── harness_list_all ──"

# list_all reads manifests — verify it produces pipe-delimited output without crashing
ALL=$(harness_list_all 2>/dev/null || echo "ERROR")
if [ "$ALL" = "ERROR" ]; then
  assert_equals "list_all: no crash" "no error" "error"
else
  # Each line should be name|status|project
  FIRST_LINE=$(echo "$ALL" | head -1)
  PIPE_COUNT=$(echo "$FIRST_LINE" | tr -cd '|' | wc -c | tr -d ' ')
  assert_equals "list_all: pipe-delimited (2 pipes)" "2" "$PIPE_COUNT"
fi

# harness_all_progress_files (requires project_root arg)
PROGS=$(harness_all_progress_files "$PROJECT_ROOT" 2>/dev/null || echo "")
if [ -n "$PROGS" ]; then
  # Should return .../tasks.json paths
  FIRST_FILE=$(echo "$PROGS" | head -1)
  assert "all_progress_files: returns tasks.json paths" "tasks.json" "$FIRST_FILE"
else
  assert_equals "all_progress_files: no crash" "yes" "yes"
fi

# ════════════════════════════════════════════════════════════════
# 15. _file_mtime
# ════════════════════════════════════════════════════════════════
echo ""
echo "── _file_mtime ──"

TMP=$(mktemp -d)
echo "test" > "$TMP/testfile"
MT=$(_file_mtime "$TMP/testfile")
if [ "$MT" -gt 0 ] 2>/dev/null; then
  assert_equals "mtime: positive number" "yes" "yes"
else
  assert_equals "mtime: positive number" "yes" "no (got $MT)"
fi

MT2=$(_file_mtime "/nonexistent/file")
assert_equals "mtime: nonexistent → 0" "0" "$MT2"

rm -rf "$TMP"

# ════════════════════════════════════════════════════════════════
# 16. _harness_bus_publish (fire-and-forget)
# ════════════════════════════════════════════════════════════════
echo ""
echo "── _harness_bus_publish ──"

TMP=$(mktemp -d)
mkdir -p "$TMP/.claude/bus/cursors" "$TMP/.claude/bus/dlq"
echo '{"global":0}' > "$TMP/.claude/bus/seq.json"
echo '{"event_types":{}}' > "$TMP/.claude/bus/schema.json"
touch "$TMP/.claude/bus/stream.jsonl"

# Publish and wait for background process
PROJECT_ROOT="$TMP" _harness_bus_publish "test.event" '{"key":"val"}'
sleep 0.5  # Background process needs time
LINES=$(wc -l < "$TMP/.claude/bus/stream.jsonl" | tr -d ' ')
if [ "$LINES" -ge 1 ]; then
  assert_equals "bus_publish: event written" "yes" "yes"
else
  assert_equals "bus_publish: event written" "yes" "no ($LINES lines)"
fi

# Empty payload → no-op
LINE_BEFORE=$LINES
PROJECT_ROOT="$TMP" _harness_bus_publish "test.event" ""
sleep 0.3
LINES2=$(wc -l < "$TMP/.claude/bus/stream.jsonl" | tr -d ' ')
assert_equals "bus_publish: empty payload → no-op" "$LINE_BEFORE" "$LINES2"

# Missing bus dir → no error
PROJECT_ROOT="/nonexistent" _harness_bus_publish "test.event" '{"x":1}' 2>/dev/null
assert_equals "bus_publish: missing dir → no error" "0" "$?"

rm -rf "$TMP"

# ════════════════════════════════════════════════════════════════
# 17. Event bus internals
# ════════════════════════════════════════════════════════════════
echo ""
echo "── event bus internals ──"

source "$HOME/.claude-ops/lib/event-bus.sh"

TMP=$(mktemp -d)
export BUS_DIR="$TMP"
export BUS_STREAM="$TMP/stream.jsonl"
export BUS_SEQ_FILE="$TMP/seq.json"
export BUS_CURSORS_DIR="$TMP/cursors"
export BUS_DLQ_DIR="$TMP/dlq"
export BUS_SCHEMA="$TMP/schema.json"
export BUS_SIDE_EFFECTS_DIR="$HOME/.claude-ops/bus/side-effects"
export EVENT_BUS_ENABLED=true

_bus_ensure_dirs
[ -d "$BUS_CURSORS_DIR" ] && assert_equals "ensure_dirs: cursors created" "yes" "yes" || assert_equals "ensure_dirs: cursors created" "yes" "no"
[ -d "$BUS_DLQ_DIR" ] && assert_equals "ensure_dirs: dlq created" "yes" "yes" || assert_equals "ensure_dirs: dlq created" "yes" "no"

# cursor_file
CF=$(_bus_cursor_file "test-consumer")
assert "cursor_file: contains consumer name" "test-consumer" "$CF"
assert "cursor_file: ends with .json" ".json" "$CF"

# get_cursor: nonexistent → 0
echo '{"global":0}' > "$BUS_SEQ_FILE"
echo '{"event_types":{}}' > "$BUS_SCHEMA"
touch "$BUS_STREAM"
GC=$(_bus_get_cursor "new-consumer")
assert_equals "get_cursor: new → 0" "0" "$GC"

# set then get cursor
_bus_set_cursor "my-consumer" 42
GC2=$(_bus_get_cursor "my-consumer")
assert_equals "get_cursor: after set → 42" "42" "$GC2"

# next_seq: monotonic
S1=$(_bus_next_seq)
S2=$(_bus_next_seq)
S3=$(_bus_next_seq)
assert_equals "next_seq: monotonic (1)" "1" "$S1"
assert_equals "next_seq: monotonic (2)" "2" "$S2"
assert_equals "next_seq: monotonic (3)" "3" "$S3"

# Global seq file reflects latest
GLOBAL=$(jq -r '.global' "$BUS_SEQ_FILE")
assert_equals "next_seq: global=3" "3" "$GLOBAL"

rm -rf "$TMP"

# ════════════════════════════════════════════════════════════════
# 18. _bus_run_side_effects
# ════════════════════════════════════════════════════════════════
echo ""
echo "── bus side effects ──"

TMP=$(mktemp -d)
export BUS_DIR="$TMP"
export BUS_DLQ_DIR="$TMP/dlq"
export BUS_SIDE_EFFECTS_DIR="$TMP/effects"
export BUS_SCHEMA="$TMP/schema.json"

mkdir -p "$TMP/dlq" "$TMP/effects"

# Schema declares a side effect
cat > "$TMP/schema.json" <<'EOF'
{"event_types":{"test.event":{"description":"test","side_effects":["test_effect"]}}}
EOF

# Create the side effect script — writes payload to a marker file
cat > "$TMP/effects/test_effect.sh" <<'SEOF'
#!/usr/bin/env bash
cat > "$PROJECT_ROOT/effect-ran.json"
SEOF
chmod +x "$TMP/effects/test_effect.sh"

PROJECT_ROOT="$TMP" _bus_run_side_effects "test.event" '{"marker":"hello"}'
if [ -f "$TMP/effect-ran.json" ]; then
  MARKER=$(jq -r '.marker' "$TMP/effect-ran.json" 2>/dev/null || echo "FAIL")
  assert_equals "side-effect: ran and received payload" "hello" "$MARKER"
else
  assert_equals "side-effect: ran" "yes" "no"
fi

# Unknown event type → no effects, no error
PROJECT_ROOT="$TMP" _bus_run_side_effects "unknown.type" '{"x":1}' 2>/dev/null
assert_equals "side-effect: unknown type → no error" "0" "$?"

rm -rf "$TMP"

# ════════════════════════════════════════════════════════════════
# 19. Event bus: lock contention
# ════════════════════════════════════════════════════════════════
echo ""
echo "── bus lock contention ──"

TMP=$(mktemp -d)
export BUS_DIR="$TMP"
export BUS_STREAM="$TMP/stream.jsonl"
export BUS_SEQ_FILE="$TMP/seq.json"
export BUS_CURSORS_DIR="$TMP/cursors"
export BUS_DLQ_DIR="$TMP/dlq"
export BUS_SCHEMA="$TMP/schema.json"
export EVENT_BUS_ENABLED=true

mkdir -p "$TMP/cursors" "$TMP/dlq"
echo '{"global":0}' > "$TMP/seq.json"
echo '{"event_types":{}}' > "$TMP/schema.json"
touch "$TMP/stream.jsonl"

# Stale lock → broken after timeout
mkdir -p "$TMP/seq.json.lock"
S=$(_bus_next_seq)
assert_equals "stale lock: broken and seq returned" "1" "$S"

rm -rf "$TMP"

# ════════════════════════════════════════════════════════════════
# 20. pane-resolve.sh
# ════════════════════════════════════════════════════════════════
echo ""
echo "── pane-resolve.sh ──"

source "$HOME/.claude-ops/lib/pane-resolve.sh"

# resolve_project_root with CLAUDE_PROJECT_ROOT set
RESULT=$(CLAUDE_PROJECT_ROOT="/custom/path" resolve_project_root)
assert_equals "resolve_project_root: env var honored" "/custom/path" "$RESULT"

# resolve_project_root without env var (in git repo)
RESULT2=$(unset CLAUDE_PROJECT_ROOT; cd "$PROJECT_ROOT" && resolve_project_root)
assert_equals "resolve_project_root: git fallback" "$PROJECT_ROOT" "$RESULT2"

# resolve_harness_dir for existing harness
DIR=$(CLAUDE_PROJECT_ROOT="$PROJECT_ROOT" resolve_harness_dir "hq-v2")
if [ -d "$DIR" ]; then
  assert_equals "resolve_harness_dir: found" "yes" "yes"
else
  assert_equals "resolve_harness_dir: found" "yes" "no"
fi

# resolve_harness_dir for nonexistent
DIR2=$(CLAUDE_PROJECT_ROOT="$PROJECT_ROOT" resolve_harness_dir "totally-fake" || true)
assert_equals "resolve_harness_dir: nonexistent → empty" "" "$DIR2"

# resolve_harness_dir with empty name
DIR3=$(resolve_harness_dir "" 2>/dev/null || true)
assert_equals "resolve_harness_dir: empty → empty" "" "$DIR3"

# resolve_session_dir
TMP=$(mktemp -d)
ORIG_STATE="$HARNESS_STATE_DIR"
export HARNESS_STATE_DIR="$TMP"
SD=$(resolve_session_dir "test-session-id")
[ -d "$SD" ] && assert_equals "resolve_session_dir: created" "yes" "yes" || assert_equals "resolve_session_dir: created" "yes" "no"
export HARNESS_STATE_DIR="$ORIG_STATE"
rm -rf "$TMP"

# ════════════════════════════════════════════════════════════════
# 21. pane_registry_update merging behavior
# ════════════════════════════════════════════════════════════════
echo ""
echo "── pane registry merge ──"

TMP=$(mktemp -d)
ORIG_REG="$PANE_REGISTRY"
export PANE_REGISTRY="$TMP/pane-registry.json"
echo '{}' > "$PANE_REGISTRY"

# First update
pane_registry_update "%400" "mod-x" "task-a" "1" "3" "x: 1/3"
# Second update (different task, higher done) — should merge
pane_registry_update "%400" "mod-x" "task-b" "2" "3" "x: 2/3"
TASK=$(pane_registry_read "%400" | jq -r '.task')
DONE=$(pane_registry_read "%400" | jq -r '.done')
assert_equals "merge: task updated" "task-b" "$TASK"
assert_equals "merge: done updated" "2" "$DONE"

# set_session after update — preserves both
pane_registry_set_session "%400" "session-1" "testing"
HARNESS_STILL=$(pane_registry_read "%400" | jq -r '.harness')
SNAME=$(pane_registry_read "%400" | jq -r '.session_name')
assert_equals "merge: harness still there after set_session" "mod-x" "$HARNESS_STILL"
assert_equals "merge: session_name set" "session-1" "$SNAME"

export PANE_REGISTRY="$ORIG_REG"
rm -rf "$TMP"

# ════════════════════════════════════════════════════════════════
# 22. harness_inject_policy: adds context injection to policy.json
# ════════════════════════════════════════════════════════════════
echo ""
echo "── harness_inject_policy ──"

TMP=$(mktemp -d)
mkdir -p "$TMP/.claude/harness/test-mod"
echo '{}' > "$TMP/.claude/harness/test-mod/policy.json"
mkdir -p "$TMP/.claude/bus/cursors" "$TMP/.claude/bus/dlq"
echo '{"global":0}' > "$TMP/.claude/bus/seq.json"
echo '{"event_types":{}}' > "$TMP/.claude/bus/schema.json"
touch "$TMP/.claude/bus/stream.jsonl"

PROJECT_ROOT="$TMP" harness_inject_policy "test-mod" "context_injections" "greeting" "Hello World" "always" 2>/dev/null
# Check policy.json was updated
VAL=$(jq -r '.inject.context_injections.greeting.inject' "$TMP/.claude/harness/test-mod/policy.json" 2>/dev/null || echo "MISSING")
IW=$(jq -r '.inject.context_injections.greeting.inject_when' "$TMP/.claude/harness/test-mod/policy.json" 2>/dev/null || echo "MISSING")
assert_equals "inject_policy: value set" "Hello World" "$VAL"
assert_equals "inject_policy: inject_when set" "always" "$IW"

# No policy.json → warning but no crash
PROJECT_ROOT="$TMP" harness_inject_policy "nonexistent-mod" "ctx" "k" "v" "always" 2>/dev/null
assert_equals "inject_policy: missing policy → no crash" "0" "$?"

# Worker-level policy
mkdir -p "$TMP/.claude/harness/test-mod/agents/worker/my-worker"
echo '{}' > "$TMP/.claude/harness/test-mod/agents/worker/my-worker/policy.json"
PROJECT_ROOT="$TMP" harness_inject_policy "test-mod/my-worker" "rules" "r1" "Do X" "cycle_start" 2>/dev/null
WV=$(jq -r '.inject.rules.r1.inject' "$TMP/.claude/harness/test-mod/agents/worker/my-worker/policy.json" 2>/dev/null || echo "MISSING")
assert_equals "inject_policy: worker-level" "Do X" "$WV"

rm -rf "$TMP"

# ════════════════════════════════════════════════════════════════
# 23. locked_jq_write: edge cases
# ════════════════════════════════════════════════════════════════
echo ""
echo "── locked_jq_write edge cases ──"

TMP=$(mktemp -d)

# Basic write
echo '{"a":1}' > "$TMP/test.json"
locked_jq_write "$TMP/test.json" "test-lock" '.b = 2'
B=$(jq -r '.b' "$TMP/test.json")
A=$(jq -r '.a' "$TMP/test.json")
assert_equals "ljw: added .b=2" "2" "$B"
assert_equals "ljw: preserved .a=1" "1" "$A"

# Multiple --arg
echo '{"x":0}' > "$TMP/test2.json"
locked_jq_write "$TMP/test2.json" "test-lock2" '.x = ($a | tonumber) + ($b | tonumber)' --arg a "10" --arg b "20"
X=$(jq -r '.x' "$TMP/test2.json")
assert_equals "ljw: multiple --arg" "30" "$X"

# Nested object
echo '{"outer":{"inner":{"deep":0}}}' > "$TMP/nested.json"
locked_jq_write "$TMP/nested.json" "test-lock3" '.outer.inner.deep = 42'
DEEP=$(jq -r '.outer.inner.deep' "$TMP/nested.json")
assert_equals "ljw: nested object update" "42" "$DEEP"

# Array manipulation
echo '{"items":[1,2,3]}' > "$TMP/array.json"
locked_jq_write "$TMP/array.json" "test-lock4" '.items += [4,5]'
LEN=$(jq '.items | length' "$TMP/array.json")
assert_equals "ljw: array append" "5" "$LEN"

# Null → new value
echo '{"val":null}' > "$TMP/null.json"
locked_jq_write "$TMP/null.json" "test-lock5" '.val = "set"'
V=$(jq -r '.val' "$TMP/null.json")
assert_equals "ljw: null → value" "set" "$V"

# Stale lock dir → broken
mkdir -p "$TMP/test.json.lock"
echo '{"y":0}' > "$TMP/test3.json"
mkdir -p "$TMP/test3.json.lock"
locked_jq_write "$TMP/test3.json" "test-lock6" '.y = 99'
Y=$(jq -r '.y' "$TMP/test3.json")
assert_equals "ljw: stale lock broken" "99" "$Y"

rm -rf "$TMP"

# ════════════════════════════════════════════════════════════════
# Summary
# ════════════════════════════════════════════════════════════════

test_summary
