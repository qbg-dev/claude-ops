#!/usr/bin/env bash
# fleet-jq.sh — Shared shell functions for reading the unified task graph.
#
# Source this file in any harness script:
#   source "$(dirname "$0")/fleet-jq.sh"
#
# All functions take a progress JSON file path as their first argument.

# ═══════════════════════════════════════════════════════════════
# CANONICAL PATHS — single source of truth
# ═══════════════════════════════════════════════════════════════
# Resolve claude-ops install dir: CLAUDE_OPS_DIR > legacy CLAUDE_OPS_DIR > ~/.claude-ops (symlink handles the rest)
_CLAUDE_OPS_ROOT="${CLAUDE_OPS_DIR:-${CLAUDE_OPS_DIR:-$HOME/.claude-ops}}"
export HARNESS_STATE_DIR="${HARNESS_STATE_DIR:-$_CLAUDE_OPS_ROOT/state}"
export HARNESS_LOCK_DIR="${HARNESS_LOCK_DIR:-$HARNESS_STATE_DIR/locks}"
export PANE_REGISTRY="$HARNESS_STATE_DIR/pane-registry.json"
mkdir -p "$HARNESS_LOCK_DIR" 2>/dev/null || true

# ── Shared utility: ISO timestamp to epoch seconds ──
# Works on both macOS (date -j) and Linux (date -d).
iso_to_epoch() {
  local ts="$1"
  # Bus timestamps end in Z (UTC). macOS date -j treats input as local time,
  # so we must set TZ=UTC to get correct epoch seconds.
  TZ=UTC date -j -f "%Y-%m-%dT%H:%M:%S" "${ts%Z}" "+%s" 2>/dev/null \
    || date -d "$ts" "+%s" 2>/dev/null || echo "0"
}

# ── Shared utility: pane_id (%NNN) to human-readable target (h:3.1) ──
hook_pane_target() {
  local pane_id="$1"
  tmux list-panes -a -F '#{pane_id} #{session_name}:#{window_index}.#{pane_index}' 2>/dev/null \
    | awk -v id="$pane_id" '$1 == id {print $2; exit}'
}

# ── Session state directory (per session_id) ──
# Creates on first call. Replaces all /tmp/claude_*_{session_id} files.
harness_session_dir() {
  local sid="$1"
  local dir="$HARNESS_STATE_DIR/sessions/$sid"
  mkdir -p "$dir" 2>/dev/null
  echo "$dir"
}

# ── Per-harness runtime directory ──
# Replaces /tmp/claude_harness_*_{name} and /tmp/claude_rotation_*_{name} files.
harness_runtime() {
  local name="$1"
  local dir="$HARNESS_STATE_DIR/harness-runtime/$name"
  mkdir -p "$dir" 2>/dev/null
  echo "$dir"
}

# ── Monitor state directory ──
# Replaces /tmp/monitor-agent-pid{N}/ dirs.
harness_monitor_dir() {
  local slug="$1"
  local dir="$HARNESS_STATE_DIR/monitors/$slug"
  mkdir -p "$dir" 2>/dev/null
  echo "$dir"
}

# ── Logs directory (consolidated debug logs) ──
harness_logs_dir() {
  local dir="$HARNESS_STATE_DIR/logs"
  mkdir -p "$dir" 2>/dev/null
  echo "$dir"
}

# ── Scratch directory (GC'd by inline GC) ──
harness_tmp_dir() {
  local dir="$HARNESS_STATE_DIR/tmp"
  mkdir -p "$dir" 2>/dev/null
  echo "$dir"
}

# ── Pane registry read/write ──
# Replaces /tmp/tmux_pane_meta_{id}, /tmp/tmux_pane_status_{id}, /tmp/tmux_pane_session_{id}

pane_registry_update() {
  local pane_id="$1" harness="$2" task="$3" done="$4" total="$5" display="$6" pane_target="${7:-}" agent_role="${8:-}"
  [ ! -f "$PANE_REGISTRY" ] && echo '{}' > "$PANE_REGISTRY"
  # Build jq args conditionally — single locked_jq_write call handles all cases
  local jq_args=(--arg pid "$pane_id" --arg h "$harness" --arg t "$task"
    --arg d "$done" --arg n "$total" --arg disp "$display")
  local jq_expr='{harness:$h, task:$t, done:($d|tonumber), total:($n|tonumber), display:$disp, updated_at:(now|todate)}'
  if [ -n "$pane_target" ]; then
    jq_args+=(--arg pt "$pane_target")
    jq_expr='{harness:$h, task:$t, done:($d|tonumber), total:($n|tonumber), display:$disp, pane_target:$pt, updated_at:(now|todate)}'
  fi
  if [ -n "$agent_role" ]; then
    jq_args+=(--arg role "$agent_role")
    jq_expr='{harness:$h, task:$t, done:($d|tonumber), total:($n|tonumber), display:$disp, pane_target:$pt, agent_role:$role, updated_at:(now|todate)}'
  fi
  locked_jq_write "$PANE_REGISTRY" "pane-registry" \
    ".[\$pid] = ((.[\$pid] // {}) * $jq_expr)" "${jq_args[@]}"
}

pane_registry_set_session() {
  local pane_id="$1" name="$2" summary="$3"
  [ ! -f "$PANE_REGISTRY" ] && echo '{}' > "$PANE_REGISTRY"
  locked_jq_write "$PANE_REGISTRY" "pane-registry" \
    '.[$pid] = ((.[$pid] // {}) * {session_name: $n, session_summary: $s})' \
    --arg pid "$pane_id" --arg n "$name" --arg s "$summary"
}

pane_registry_read() {
  local pane_id="$1"
  [ ! -f "$PANE_REGISTRY" ] && echo '{}' && return
  jq -r --arg pid "$pane_id" '.[$pid] // {}' "$PANE_REGISTRY" 2>/dev/null || echo '{}'
}

pane_registry_remove() {
  local pane_id="$1"
  [ ! -f "$PANE_REGISTRY" ] && return 0
  locked_jq_write "$PANE_REGISTRY" "pane-registry" 'del(.[$pid])' --arg pid "$pane_id"
}

# Register a child pane with its parent, inheriting harness/permissions.
# Writes to: panes section (unified), flat compat entry, AND legacy flat format.
pane_registry_set_parent() {
  local child_pane="$1" parent_pane="$2" harness="$3" pane_target="${4:-}"
  [ ! -f "$PANE_REGISTRY" ] && echo '{"workers":{},"panes":{}}' > "$PANE_REGISTRY"
  # Compute depth: parent's depth + 1 (root workers have depth 0)
  local parent_depth
  parent_depth=$(jq -r --arg pid "$parent_pane" '.[$pid].depth // 0' "$PANE_REGISTRY" 2>/dev/null || echo 0)
  local child_depth=$((parent_depth + 1))
  local worker_name="${harness#worker/}"
  local tmux_sess
  tmux_sess=$(echo "$pane_target" | cut -d: -f1 2>/dev/null || echo "")
  locked_jq_write "$PANE_REGISTRY" "pane-registry" \
    '.panes //= {} |
    .panes[$cid] = {worker:$wn, role:"child", pane_target:$pt, tmux_session:$ts,
      session_id:"", parent_pane:$pid, registered_at:(now|todate)} |
    .[$cid] = ((.[$cid] // {}) * {harness:$h, parent_pane:$pid, pane_target:$pt, task:"child", depth:($d|tonumber), updated_at:(now|todate)})' \
    --arg cid "$child_pane" --arg pid "$parent_pane" --arg h "$harness" --arg pt "$pane_target" \
    --arg d "$child_depth" --arg wn "$worker_name" --arg ts "$tmux_sess"
}

# ═══════════════════════════════════════════════════════════════
# AGENT WORKSPACE — Per-agent persistent identity and memory
# ═══════════════════════════════════════════════════════════════

# ═══════════════════════════════════════════════════════════════
# DECOMPOSED FILE RESOLUTION
# ═══════════════════════════════════════════════════════════════

# ── Cached path resolution ──────────────────────────────────────
_H_CACHED_PROGRESS=""
_H_CACHED_DIR=""
_H_CACHED_TASKS=""
_H_CACHED_CONFIG=""
_H_CACHED_STATE=""

_harness_ensure_cache() {
  local progress="$1"
  if [ "$progress" != "$_H_CACHED_PROGRESS" ]; then
    _H_CACHED_PROGRESS="$progress"
    _H_CACHED_DIR=$(dirname "$progress")
    _H_CACHED_TASKS=""
    _H_CACHED_CONFIG=""
    _H_CACHED_STATE=""
  fi
}

# Returns the coordinator agent dir: agents/module-manager (current) or agents/sidecar (legacy).
_harness_coordinator_dir() {
  local hdir="$1"
  if [ -d "$hdir/agents/module-manager" ]; then
    echo "$hdir/agents/module-manager"
  else
    echo "$hdir/agents/sidecar"
  fi
}

_resolve_tasks_file() {
  local progress="$1"
  _harness_ensure_cache "$progress"
  if [ -z "$_H_CACHED_TASKS" ]; then
    local f="$_H_CACHED_DIR/tasks.json"
    if [ -f "$f" ]; then
      _H_CACHED_TASKS="$f"
    else
      echo "ERROR: tasks.json not found at $f — migrate from progress.json first" >&2
      return 1
    fi
  fi
  echo "$_H_CACHED_TASKS"
}

_resolve_config_file() {
  local progress="$1"
  _harness_ensure_cache "$progress"
  if [ -z "$_H_CACHED_CONFIG" ]; then
    local agent_dir; agent_dir=$(_harness_coordinator_dir "$_H_CACHED_DIR")
    local f="$agent_dir/config.json"
    if [ -f "$f" ]; then
      _H_CACHED_CONFIG="$f"
    else
      echo "ERROR: config.json not found at $f — migrate from progress.json first" >&2
      return 1
    fi
  fi
  echo "$_H_CACHED_CONFIG"
}

_resolve_state_file() {
  local progress="$1"
  _harness_ensure_cache "$progress"
  if [ -z "$_H_CACHED_STATE" ]; then
    local agent_dir; agent_dir=$(_harness_coordinator_dir "$_H_CACHED_DIR")
    local f="$agent_dir/state.json"
    if [ -f "$f" ]; then
      _H_CACHED_STATE="$f"
    else
      echo "ERROR: state.json not found at $f — migrate from progress.json first" >&2
      return 1
    fi
  fi
  echo "$_H_CACHED_STATE"
}

# ═══════════════════════════════════════════════════════════════
# WORKER FUNCTIONS — v2 worker agent lifecycle
# ═══════════════════════════════════════════════════════════════

# Scaffold a new worker agent directory with 6 standard files.
# Usage: worker_scaffold MODULE WORKER_NAME TYPE MISSION ACCEPTANCE [APPROVED_BY] [PROJECT_ROOT]
worker_scaffold() {
  local module="${1:?}" worker_name="${2:?}" type="${3:?}" mission="${4:?}" acceptance="${5:?}"
  local approved_by="${6:-operator}" project_root="${7:-${PROJECT_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}}"

  local worker_dir="$project_root/.claude/harness/$module/agents/worker/$worker_name"
  mkdir -p "$worker_dir/memory/ref" "$worker_dir/memory/notes" "$worker_dir/memory/scripts"

  # mission.md (matches spec: Goal + Constraints + Scope + Optimization Targets)
  if [ ! -f "$worker_dir/mission.md" ]; then
    cat > "$worker_dir/mission.md" <<MEOF
# Worker Mission — $worker_name

## Goal
$mission

## Constraints (MUST MEET)
- [ ] $acceptance

## Scope
In-scope for $worker_name under $module.

## Optimization Targets
Continuous improvement after constraints pass.
MEOF
  fi

  # config.json (includes type + parent per v3 spec)
  if [ ! -f "$worker_dir/config.json" ]; then
    jq -n \
      --arg name "$worker_name" \
      --arg type "$type" \
      --arg parent "$module" \
      --arg approved_by "$approved_by" \
      '{name:$name, type:$type, parent:$parent, model:"sonnet", approved_by:$approved_by, monitoring_threshold:5, monitoring_cadence_s:3600}' \
      > "$worker_dir/config.json"
  fi

  # state.json (v3: cycles_completed, not loop_count)
  if [ ! -f "$worker_dir/state.json" ]; then
    jq -n \
      --arg type "$type" \
      '{type:$type, status:"active", cycles_completed:0, last_cycle_at:null}' \
      > "$worker_dir/state.json"
  fi

  # inbox.jsonl + outbox.jsonl
  touch "$worker_dir/inbox.jsonl" "$worker_dir/outbox.jsonl" 2>/dev/null

  # Publish worker.started to bus
  local bus_dir="$project_root/.claude/bus"
  if [ -d "$bus_dir" ] && [ -f "$HOME/.claude-ops/lib/event-bus.sh" ]; then
    local payload
    payload=$(jq -nc --arg m "$module" --arg w "$worker_name" --arg t "$type" --arg a "$approved_by" \
      '{module:$m, worker_name:$w, type:$t, approved_by:$a}')
    PROJECT_ROOT="$project_root" BUS_DIR="$bus_dir" \
      bash -c "source '$HOME/.claude-ops/lib/event-bus.sh' && bus_publish 'worker.started' '$payload'" 2>/dev/null || true
  fi
}

# Register a worker in pane-registry.json with worker-specific fields.
# Usage: worker_pane_register PANE_ID MODULE WORKER_NAME WORKER_TYPE LOOP_COUNT MINOR_COUNT PANE_TARGET
worker_pane_register() {
  local pane_id="${1:?}" module="${2:?}" worker_name="${3:?}" worker_type="${4:?}"
  local loop_count="${5:-0}" minor_count="${6:-0}" pane_target="${7:-}"

  locked_jq_write "$PANE_REGISTRY" "pane-registry" \
    '.[$pid] = {
      harness: $harness,
      parent: $parent,
      task: $task,
      worker_type: $wtype,
      agent_role: "worker",
      loop_count: $loop,
      minor_count: $minor,
      pane_target: $target,
      display: ("\($parent)/\($harness) [\($wtype)] loop:\($loop)"),
      updated_at: $ts
    }' \
    --arg pid "$pane_id" \
    --arg harness "$worker_name" \
    --arg parent "$module" \
    --arg task "$worker_name" \
    --arg wtype "$worker_type" \
    --argjson loop "$loop_count" \
    --argjson minor "$minor_count" \
    --arg target "$pane_target" \
    --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}


# ═══════════════════════════════════════════════════════════════
# SHARED HOOK FUNCTIONS — Used by all hooks to avoid duplication
# ═══════════════════════════════════════════════════════════════

# Walk process tree from current shell up to find the tmux pane_id.
# Returns: pane_id (e.g. %42) on stdout, or empty if not in tmux.
# Replaces 5 inline copies of 6-8 line pane detection across hooks.
hook_find_own_pane() {
  local search_pid=${1:-$$}
  local pane_map
  pane_map=$(tmux list-panes -a -F '#{pane_pid} #{pane_id}' 2>/dev/null)
  [ -z "$pane_map" ] && return
  while [ "$search_pid" -gt 1 ]; do
    local match
    match=$(echo "$pane_map" | awk -v pid="$search_pid" '$1 == pid {print $2; exit}')
    [ -n "$match" ] && echo "$match" && return
    search_pid=$(ps -o ppid= -p "$search_pid" 2>/dev/null | tr -d ' ')
  done
}

# Resolve harness + canonical path from pane-registry.json (sole source of truth).
# Usage: hook_resolve_harness "$pane_id" "$session_id"
# Sets globals: HARNESS (short name), CANONICAL (module/worker for workers, harness for top-level)
hook_resolve_harness() {
  local pane_id="$1" session_id="$2"
  HARNESS=""
  CANONICAL=""

  if [ -n "$pane_id" ] && [ -f "$PANE_REGISTRY" ]; then
    HARNESS=$(jq -r --arg pid "$pane_id" '.[$pid].harness // ""' "$PANE_REGISTRY" 2>/dev/null || echo "")
    local _parent
    _parent=$(jq -r --arg pid "$pane_id" '.[$pid].parent // ""' "$PANE_REGISTRY" 2>/dev/null || echo "")
    if [ -n "$_parent" ] && [ -n "$HARNESS" ]; then
      CANONICAL="${_parent}/${HARNESS}"   # e.g. mod-engineering/red-team
    else
      CANONICAL="$HARNESS"               # e.g. hq-v2
    fi
  fi
}

# Parse JSON hook input via jq. Sets global variables:
#   _HOOK_SESSION_ID  — session_id from input
#   _HOOK_TOOL_NAME   — tool_name from input
#   _HOOK_TOOL_INPUT  — tool_input as JSON string (object, not string-wrapped)
# Usage: hook_parse_input "$INPUT"
# Replaces ~10 python3 json.load(sys.stdin).get(...) calls across hooks.
hook_parse_input() {
  local input="$1"
  _HOOK_SESSION_ID=$(echo "$input" | jq -r '.session_id // ""' 2>/dev/null || echo "")
  _HOOK_TOOL_NAME=$(echo "$input" | jq -r '.tool_name // ""' 2>/dev/null || echo "")
  _HOOK_TOOL_INPUT=$(echo "$input" | jq -r '.tool_input | if type == "string" then fromjson else . end // {}' 2>/dev/null || echo "{}")
}

# Emit a block decision as JSON. Replaces python3 json.dumps({'decision':'block',...}).
# Also publishes stop.blocked event to bus if event-bus.sh is sourced.
# Usage: hook_block "reason message"
hook_block() {
  local reason="$1"
  # Publish stop.blocked to bus (fire-and-forget)
  if type bus_publish &>/dev/null 2>&1; then
    local _agent="${HARNESS:-main}"
    local _sid="${_HOOK_SESSION_ID:-${SESSION_ID:-unknown}}"
    local _summary="${reason:0:200}"
    local _blocker
    _blocker=$(basename "${BASH_SOURCE[1]:-unknown}" .sh 2>/dev/null || echo "unknown")
    local _payload
    _payload=$(jq -n --arg a "$_agent" --arg sid "$_sid" --arg h "${HARNESS:-}" \
      --arg b "$_blocker" --arg r "$_summary" \
      '{agent: $a, session_id: $sid, harness: $h, blocker: $b, reason_summary: $r}' 2>/dev/null || true)
    [ -n "$_payload" ] && bus_publish "stop.blocked" "$_payload" 2>/dev/null || true
  fi
  jq -n --arg reason "$reason" '{"decision":"block","reason":$reason}'
}

# Emit additionalContext as JSON. Replaces python3 json.dumps({'additionalContext':...}).
# Usage: hook_context "context text"
hook_context() {
  local ctx="$1"
  jq -n --arg ctx "$ctx" '{"additionalContext":$ctx}'
}

# Emit empty JSON pass-through (no block, no context).
# Writes a graceful-stop sentinel so the watchdog knows to wait sleep_duration
# before respawning (vs a crash which the watchdog respawns immediately).
# Usage: hook_pass
hook_pass() {
  local _SESSION_DIR="${CLAUDE_SESSION_DIR:-${HOME}/.claude-ops/state/sessions/${CLAUDE_SESSION_ID:-unknown}}"
  mkdir -p "$_SESSION_DIR" 2>/dev/null || true
  touch "$_SESSION_DIR/graceful-stop" 2>/dev/null || true
  echo '{}'
}

# ── Portable file mtime (macOS + Linux) ──
_file_mtime() { stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null || echo 0; }

# ── Portable file locking via atomic mkdir (macOS + Linux) ──
_lock() {
  local lockdir="$1" attempts=0 sleep_time=0.05
  local max_attempts="${LOCK_MAX_ATTEMPTS:-600}"
  while ! mkdir "$lockdir" 2>/dev/null; do
    attempts=$((attempts + 1))
    if [ "$attempts" -ge "$max_attempts" ]; then
      # Stale lock (>30s with backoff) — force break
      echo "WARN: Force-breaking stale lock after 600 attempts: $lockdir" >&2
      rm -rf "$lockdir" 2>/dev/null
      mkdir "$lockdir" 2>/dev/null || true
      break
    fi
    # Exponential backoff: 50ms → 100ms → 200ms (capped)
    if [ "$attempts" -eq 50 ]; then sleep_time=0.1; fi
    if [ "$attempts" -eq 150 ]; then sleep_time=0.2; fi
    sleep "$sleep_time"
  done
}
_unlock() { rmdir "$1" 2>/dev/null || true; }

# Atomically read-modify-write a JSON file under lock.
# Usage: locked_jq_write <file> <lockname> <jq_filter> [--arg name val ...]
locked_jq_write() {
  local file="$1" lockname="$2" filter="$3"
  shift 3
  local lockdir="$HARNESS_LOCK_DIR/$lockname"
  _lock "$lockdir"
  # Create file with empty object if missing
  [ ! -f "$file" ] && echo '{}' > "$file"
  local tmp
  tmp=$(mktemp) || { _unlock "$lockdir"; return 1; }
  if jq "$@" "$filter" "$file" > "$tmp" 2>/dev/null && [ -s "$tmp" ]; then
    # Validate output is valid JSON before overwriting
    if jq empty "$tmp" 2>/dev/null; then
      mv "$tmp" "$file"
    else
      echo "WARN: locked_jq_write produced invalid JSON for $file, skipping" >&2
      rm -f "$tmp"
    fi
  else
    rm -f "$tmp"
  fi
  _unlock "$lockdir"
}

# Current task: first in_progress, else first unblocked pending
harness_current_task() {
  local PROGRESS="$1"
  local tasks; tasks=$(_resolve_tasks_file "$PROGRESS") || return 1
  jq -r '
    . as $root |
    ([.tasks | to_entries[] | select(.value.status == "in_progress") | .key] | first) //
    ([.tasks | to_entries[] | select(
      .value.status == "pending" and
      ((.value.blockedBy // []) as $deps |
       if ($deps | length) == 0 then true
       else [$deps[] as $dep | ($root.tasks[$dep].status // "missing")] | all(. == "completed")
       end)
    ) | .key] | first) //
    "ALL_DONE"
  ' "$tasks"
}

# Next unblocked pending task (skipping any in_progress)
harness_next_task() {
  local PROGRESS="$1"
  local tasks; tasks=$(_resolve_tasks_file "$PROGRESS") || return 1
  jq -r '
    . as $root |
    [.tasks | to_entries[] | select(
      .value.status == "pending" and
      ((.value.blockedBy // []) as $deps |
       if ($deps | length) == 0 then true
       else [$deps[] as $dep | ($root.tasks[$dep].status // "missing")] | all(. == "completed")
       end)
    ) | .key] | first // "ALL_DONE"
  ' "$tasks"
}

# Count of completed tasks
harness_done_count() {
  local PROGRESS="$1"
  local tasks; tasks=$(_resolve_tasks_file "$PROGRESS") || return 1
  jq '[.tasks // {} | to_entries[] | select(.value.status == "completed")] | length' "$tasks"
}

# Total task count
harness_total_count() {
  local PROGRESS="$1"
  local tasks; tasks=$(_resolve_tasks_file "$PROGRESS") || return 1
  jq '.tasks // {} | length' "$tasks"
}

# Completed task names (comma-separated)
harness_completed_names() {
  local PROGRESS="$1"
  local tasks; tasks=$(_resolve_tasks_file "$PROGRESS") || return 1
  jq -r '[.tasks // {} | to_entries[] | select(.value.status == "completed") | .key] | join(", ")' "$tasks"
}

# Pending task names (comma-separated)
harness_pending_names() {
  local PROGRESS="$1"
  local tasks; tasks=$(_resolve_tasks_file "$PROGRESS") || return 1
  jq -r '[.tasks // {} | to_entries[] | select(.value.status == "pending") | .key] | join(", ")' "$tasks"
}

# Get task description
harness_task_description() {
  local PROGRESS="$1"
  local TASK="$2"
  local tasks; tasks=$(_resolve_tasks_file "$PROGRESS") || return 1
  jq -r --arg t "$TASK" '.tasks[$t].description // ""' "$tasks"
}

# Get harness name from config.json
harness_name() {
  local PROGRESS="$1"
  local config; config=$(_resolve_config_file "$PROGRESS") || return 1
  jq -r '.name // "unknown"' "$config"
}

# Get harness mission from config.json
harness_mission() {
  local PROGRESS="$1"
  local config; config=$(_resolve_config_file "$PROGRESS") || return 1
  jq -r '.mission // ""' "$config"
}

# Get harness lifecycle type (bounded or long-running)
harness_lifecycle() {
  local PROGRESS="$1"
  local config; config=$(_resolve_config_file "$PROGRESS") || return 1
  local val
  val=$(jq -r '.lifecycle // "bounded"' "$config")
  [ "$val" = "perpetual" ] && val="long-running"
  echo "$val"
}

# Get sleep_duration for a canonical agent path (module/worker or top-level harness name).
# Workers: reads from .claude/harness/MODULE/agents/worker/WORKER/state.json
# Top-level: reads from agents/sidecar/state.json, falls back to progress.json
# Default: 900 (15 min)
harness_sleep_duration() {
  local canonical="$1"
  local project_root="${PROJECT_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
  local val
  local perpetual_val

  # Helper: read JSON safely — tries direct jq first, falls back to runtime cache.
  # macOS TCC blocks launchd agents from reading ~/Desktop/ files directly.
  _safe_jq() {
    local file="$1" expr="$2" cache="$3"
    val=$(jq -r "$expr" "$file" 2>/dev/null)
    [ -n "$val" ] && [ "$val" != "null" ] && echo "$val" && return
    # Fallback: read from runtime cache (in ~/.claude-ops/state/, always accessible)
    [ -n "$cache" ] && [ -f "$cache" ] && val=$(jq -r "$expr" "$cache" 2>/dev/null)
    [ -n "$val" ] && [ "$val" != "null" ] && echo "$val" && return
    echo ""
  }

  if [[ "$canonical" == worker/* ]]; then
    # Flat worker: "worker/{name}" → .claude/workers/registry.json[name]
    local worker="${canonical#worker/}"
    local registry="$project_root/.claude/workers/registry.json"
    local cache="$HARNESS_STATE_DIR/harness-runtime/worker/$worker/config-cache.json"
    if [ -f "$registry" ] || [ -f "$cache" ]; then
      # Check perpetual field from registry: if explicitly false, signal watchdog to skip respawn
      perpetual_val=$(jq -r --arg w "$worker" '.[$w] | if .perpetual == null then "unset" elif .perpetual == false then "false" else "true" end' "$registry" 2>/dev/null || _safe_jq "$cache" "$(printf '.[\"%s\"] | if .perpetual == null then \"unset\" elif .perpetual == false then \"false\" else \"true\" end' "$worker")" "")
      if [ "$perpetual_val" = "false" ] || [ "$perpetual_val" = "unset" ]; then
        echo "none"
        return
      fi
      val=$(jq -r --arg w "$worker" '.[$w].sleep_duration // empty' "$registry" 2>/dev/null || _safe_jq "$cache" "$(printf '.[\"%s\"].sleep_duration // empty' "$worker")" "")
      [ -n "$val" ] && echo "$val" && return
    fi
  elif [[ "$canonical" == */* ]]; then
    # Old harness worker: "module/worker-name"
    local module="${canonical%%/*}"
    local worker="${canonical##*/}"
    local state="$project_root/.claude/harness/$module/agents/worker/$worker/state.json"
    if [ -f "$state" ]; then
      val=$(_jq_read "$state" '.sleep_duration // empty')
      [ -n "$val" ] && echo "$val" && return
    fi
  else
    # Top-level harness: try module-manager/sidecar state.json first
    local _hdir="$project_root/.claude/harness/$canonical"
    local _agent_dir; _agent_dir=$(_harness_coordinator_dir "$_hdir")
    local state="$_agent_dir/state.json"
    if [ -f "$state" ]; then
      val=$(_jq_read "$state" '.sleep_duration // empty')
      [ -n "$val" ] && echo "$val" && return
    fi
    # Fallback: progress.json (legacy top-level harnesses like hq-v2)
    local progress="$project_root/.claude/harness/$canonical/progress.json"
    if [ -f "$progress" ]; then
      val=$(_jq_read "$progress" '.sleep_duration // empty')
      [ -n "$val" ] && echo "$val" && return
    fi
  fi

  echo "900"  # default: 15 min
}

# List all worker directories across both old harness and flat worker systems.
# Outputs lines of: "canonical   /path/to/worker/dir"
# Usage: list_all_workers [project_root]
list_all_workers() {
  local _root="${1:-${PROJECT_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}}"

  # Old harness workers: .claude/harness/{module}/agents/worker/{name}/
  # Strip prefix to extract module cleanly, avoiding dirname depth errors
  for _dir in "$_root"/.claude/harness/*/agents/worker/*/; do
    [ -d "$_dir" ] || continue
    local _stripped="${_dir#${_root}/.claude/harness/}"  # "hq-v3/agents/worker/chatbot-tools/"
    local _module="${_stripped%%/*}"                      # "hq-v3"
    local _wname; _wname=$(basename "$_dir")              # "chatbot-tools"
    echo "$_module/$_wname   $_dir"
  done

  # Flat workers: .claude/workers/{name}/
  for _dir in "$_root"/.claude/workers/*/; do
    [ -d "$_dir" ] || continue
    [ -f "$_dir/mission.md" ] || continue  # must be a real worker dir
    local _wname; _wname=$(basename "$_dir")
    echo "worker/$_wname   $_dir"
  done
}

# Get long-running harness cycle count
harness_cycle_count() {
  local PROGRESS="$1"
  local state; state=$(_resolve_state_file "$PROGRESS") || return 1
  jq -r '.cycles_completed // 0' "$state"
}

# Get last_cycle_at timestamp (ISO string or "null")
harness_last_cycle_at() {
  local PROGRESS="$1"
  local state; state=$(_resolve_state_file "$PROGRESS") || return 1
  jq -r '.last_cycle_at // "null"' "$state"
}

# Get current cycle phase from current_session.cycle_phase
# Returns: probe|reconcile|act|persist|unknown
harness_cycle_phase() {
  local PROGRESS="$1"
  local state; state=$(_resolve_state_file "$PROGRESS") || return 1
  jq -r '.current_session.cycle_phase // "unknown"' "$state"
}

# Get cycle_phase_entered_at from current_session
harness_phase_entered_at() {
  local PROGRESS="$1"
  local state; state=$(_resolve_state_file "$PROGRESS") || return 1
  jq -r '.current_session.cycle_phase_entered_at // "0"' "$state" 2>/dev/null || echo "0"
}

# Detect operating mode from worker directory presence
# Returns: "self-sidecar" | "sidecar-executor"
harness_operating_mode() {
  local PROGRESS="$1"
  local PROJECT="${2:-}"
  local HNAME
  HNAME=$(harness_name "$PROGRESS")
  [ -z "$PROJECT" ] && PROJECT=$(harness_project_root "$HNAME")

  local WORKER_DIR="$PROJECT/.claude/harness/$HNAME/agents/worker"
  # Has actual worker subdirectories → sidecar-executor
  if [ -d "$WORKER_DIR" ] && [ -n "$(ls -A "$WORKER_DIR" 2>/dev/null)" ]; then
    echo "sidecar-executor"
  else
    echo "self-sidecar"
  fi
}


# Check if a task is blocked; returns JSON with blocker details or "null" if unblocked.
# Usage: BLOCKED=$(harness_check_blocked "$PROGRESS" "task-id")
#   "null" → task is runnable
#   Otherwise → JSON: {"blocked":true, "task":"task-id", "waiting_on": [{"task":"dep-id","status":"pending","owner":null},...]}
harness_check_blocked() {
  local PROGRESS="$1"
  local TASK="$2"
  local tasks; tasks=$(_resolve_tasks_file "$PROGRESS") || return 1
  jq -r --arg t "$TASK" '
    . as $root |
    (.tasks[$t].blockedBy // []) as $deps |
    if ($deps | length) == 0 then "null"
    else
      [$deps[] as $dep |
        # Treat missing tasks as incomplete (safe default)
        select(($root.tasks[$dep].status // "missing") != "completed") |
        {task: $dep, status: ($root.tasks[$dep].status // "missing"), owner: ($root.tasks[$dep].owner // null)}
      ] |
      if length == 0 then "null"
      else {blocked: true, task: $t, waiting_on: .} | tojson
      end
    end
  ' "$tasks"
}

# Set a task to in_progress (outputs to stdout, caller must redirect).
# Validates dependencies — refuses if blockers remain and prints what's blocking to stderr.
# Check other agents' progress via pane-registry.json or tmux capture-pane.
harness_set_in_progress() {
  local PROGRESS="$1"
  local TASK="$2"
  local BLOCKED
  BLOCKED=$(harness_check_blocked "$PROGRESS" "$TASK")
  if [ "$BLOCKED" != "null" ]; then
    local BLOCKERS
    BLOCKERS=$(echo "$BLOCKED" | jq -r '.waiting_on[] | "  - \(.task) [\(.status)] owner=\(.owner // "unassigned")"')
    echo "ERROR: Cannot start '$TASK' — blocked by incomplete dependencies:" >&2
    echo "$BLOCKERS" >&2
    echo "Tip: check other agents' task status via pane-registry.json or tmux capture-pane -t {pane} -p | tail -5" >&2
    return 1
  fi
  local tasks; tasks=$(_resolve_tasks_file "$PROGRESS") || return 1
  locked_jq_write "$tasks" "tasks-$(basename "$(dirname "$tasks")")" \
    '.tasks[$t].status = "in_progress"' --arg t "$TASK"
  # Publish task.started to bus (fire-and-forget)
  _harness_bus_publish "task.started" \
    "$(jq -nc --arg h "$(basename "$(dirname "$tasks")")" --arg tid "$TASK" '{harness:$h, task_id:$tid}' 2>/dev/null || true)"
}

# Set a task to completed (atomic write via locked_jq_write)
harness_set_completed() {
  local PROGRESS="$1"
  local TASK="$2"
  local SUMMARY="${3:-}"
  local tasks; tasks=$(_resolve_tasks_file "$PROGRESS") || return 1
  locked_jq_write "$tasks" "tasks-$(basename "$(dirname "$tasks")")" \
    '.tasks[$t].status = "completed"' --arg t "$TASK"
  # Publish task.completed to bus (fire-and-forget)
  _harness_bus_publish "task.completed" \
    "$(jq -nc --arg h "$(basename "$(dirname "$tasks")")" --arg tid "$TASK" --arg sum "$SUMMARY" \
      '{harness:$h, task_id:$tid, summary:$sum}' 2>/dev/null || true)"
}

# Bump cycle count + last_cycle_at in state.json (v3).
# Falls back to progress.json if state.json absent (v2 compat).
# Usage: harness_bump_session <progress_or_tasks_path>
harness_bump_session() {
  local progress="$1"
  local hdir; hdir=$(dirname "$progress")
  local hname; hname=$(basename "$hdir")
  local agent_dir; agent_dir=$(_harness_coordinator_dir "$hdir")
  local state="$agent_dir/state.json"
  if [ -f "$state" ]; then
    locked_jq_write "$state" "state-$hname" \
      '.cycles_completed = ((.cycles_completed // 0) + 1) |
       .last_cycle_at = (now | todate) |
       .status = "active"'
    # Publish agent.state-changed (fire-and-forget)
    _harness_bus_publish "agent.state-changed" \
      "$(jq -nc --arg a "$hname" --arg f "cycles_completed,last_cycle_at,status" --arg src "infrastructure" \
        '{agent:$a, fields:$f, source:$src}' 2>/dev/null || true)"
  elif [ -f "$progress" ]; then
    locked_jq_write "$progress" "progress-$hname" \
      '.status = "active" |
       .session_count = ((.session_count // 0) + 1) |
       .current_session = {
         "round_count": 0,
         "tasks_completed": 0,
         "started_at": (now | todate)
       }'
    _harness_bus_publish "agent.state-changed" \
      "$(jq -nc --arg a "$hname" --arg f "status,session_count,current_session" --arg src "infrastructure" \
        '{agent:$a, fields:$f, source:$src}' 2>/dev/null || true)"
  fi
}

# ═══════════════════════════════════════════════════════════════
# BUS-MEDIATED STATE MUTATION HELPERS
# ═══════════════════════════════════════════════════════════════

# Fire-and-forget bus_publish wrapper. Silently no-ops if bus is unavailable.
# Usage: _harness_bus_publish <event_type> <json_payload>
_harness_bus_publish() {
  local event_type="$1" payload="$2"
  [ -z "$payload" ] && return 0
  local project_root="${PROJECT_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
  local bus_dir="$project_root/.claude/bus"
  [ ! -d "$bus_dir" ] && return 0
  [ ! -f "$HOME/.claude-ops/lib/event-bus.sh" ] && return 0
  (PROJECT_ROOT="$project_root" BUS_DIR="$bus_dir" \
    bash -c "source '$HOME/.claude-ops/lib/event-bus.sh' && bus_publish '$event_type' '$payload'" 2>/dev/null || true) &
  disown 2>/dev/null || true
}

# Atomically update a state.json with jq, then publish agent.state-changed.
# Usage: harness_update_state <state_file_path> <jq_filter> [--arg ...]
#
# Resolves state.json via the path directly (caller provides full path or
# uses _resolve_state_file). Diffs changed fields for the bus event.
harness_update_state() {
  local state_file="$1" filter="$2"
  shift 2

  [ ! -f "$state_file" ] && { echo "ERROR: state file not found: $state_file" >&2; return 1; }

  # Snapshot old state keys for diff
  local old_keys
  old_keys=$(jq -S 'to_entries | map(.key + "=" + (.value | tostring)) | sort | .[]' "$state_file" 2>/dev/null || true)

  # Determine lock name from parent dir
  local lockname="state-$(basename "$(dirname "$(dirname "$state_file")")")"
  locked_jq_write "$state_file" "$lockname" "$filter" "$@"

  # Diff changed fields
  local new_keys changed_fields
  new_keys=$(jq -S 'to_entries | map(.key + "=" + (.value | tostring)) | sort | .[]' "$state_file" 2>/dev/null || true)
  changed_fields=$(comm -3 <(echo "$old_keys") <(echo "$new_keys") 2>/dev/null | sed 's/^[[:space:]]*//' | sed 's/=.*//' | sort -u | paste -sd, - || true)

  [ -z "$changed_fields" ] && return 0  # No actual change — skip event

  # Infer agent name: parent of agents/sidecar/state.json → harness name
  local agent_name
  agent_name=$(echo "$state_file" | sed -n 's|.*/harness/\([^/]*\)/.*|\1|p')
  [ -z "$agent_name" ] && agent_name="unknown"

  _harness_bus_publish "agent.state-changed" \
    "$(jq -nc --arg a "$agent_name" --arg f "$changed_fields" --arg src "infrastructure" \
      '{agent:$a, fields:$f, source:$src}' 2>/dev/null || true)"
}

# Inject a key into an agent's policy.json and publish agent.policy-appended.
# Supports slash-addressed agents (module/worker).
# Usage: harness_inject_policy <canonical> <section> <key> <value> [inject_when]
#
# canonical: "mod-customer" (sidecar) or "mod-customer/kefu-latency" (worker)
# section: "tool_context", "rules", etc. (under .inject in policy.json)
# inject_when: "always" (default), "next_prompt", etc.
harness_inject_policy() {
  local canonical="${1:?Usage: harness_inject_policy <canonical> <section> <key> <value> [inject_when]}"
  local section="${2:?}"
  local key="${3:?}"
  local value="${4:?}"
  local inject_when="${5:-always}"
  local project_root="${PROJECT_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"

  # Resolve policy.json path (worker-level first, then module-level fallback)
  local policy_path
  if [[ "$canonical" == */* ]]; then
    local module="${canonical%%/*}"
    local worker="${canonical##*/}"
    local worker_policy="$project_root/.claude/harness/$module/agents/worker/$worker/policy.json"
    if [ -f "$worker_policy" ]; then
      policy_path="$worker_policy"
    else
      policy_path="$project_root/.claude/harness/$module/policy.json"
    fi
  else
    policy_path="$project_root/.claude/harness/$canonical/policy.json"
  fi

  if [ ! -f "$policy_path" ]; then
    echo "WARN: policy.json not found at $policy_path" >&2
    return 0
  fi

  # Atomic write
  local lockname="policy-$(echo "$canonical" | tr '/' '-')"
  locked_jq_write "$policy_path" "$lockname" \
    '.inject[$sec][$k] = {"inject": $v, "inject_when": $iw}' \
    --arg sec "$section" --arg k "$key" --arg v "$value" --arg iw "$inject_when"

  # Publish agent.policy-appended (fire-and-forget)
  local source_agent="${SIDECAR_NAME:-${HARNESS:-unknown}}"
  _harness_bus_publish "agent.policy-appended" \
    "$(jq -nc --arg a "$canonical" --arg k "$key" --arg sec "$section" \
      --arg src "$source_agent" --arg iw "$inject_when" \
      '{agent:$a, key:$k, section:$sec, source_agent:$src, inject_when:$iw}' 2>/dev/null || true)"
}

# List tasks that would be unblocked if the given task were completed
harness_would_unblock() {
  local PROGRESS="$1"
  local TASK="$2"
  local tasks; tasks=$(_resolve_tasks_file "$PROGRESS") || return 1
  jq -r --arg t "$TASK" '
    . as $root |
    [.tasks | to_entries[] | select(
      .value.status == "pending" and
      (.value.blockedBy // [] | index($t)) and
      ((.value.blockedBy // []) as $deps |
       [$deps[] | select(. != $t) | $root.tasks[.].status] | all(. == "completed"))
    ) | .key] | join(", ")
  ' "$tasks"
}

# ═══════════════════════════════════════════════════════════════
# WAVE FUNCTIONS — Optional wave-based execution support
# ═══════════════════════════════════════════════════════════════
# Waves are defined in config.json as:
#   "waves": [{"id":1,"name":"...","tasks":["t1","t2"],"status":"pending","report":null}]
# Empty waves array = no waves (all functions return empty/false).

# Current wave: first in_progress, else first pending wave.
# Returns JSON object or "null" if no waves or all done.
# Waves are in config.json.
harness_current_wave() {
  local PROGRESS="$1"
  local config; config=$(_resolve_config_file "$PROGRESS") || return 1
  jq -r '
    if (.waves // [] | length) == 0 then "null"
    else
      (
        [.waves[] | select(.status == "in_progress")][0] //
        [.waves[] | select(.status == "pending")][0] //
        null
      ) | if . == null then "null" else tojson end
    end
  ' "$config" 2>/dev/null || echo "null"
}

# Wave progress summary: "Wave 2/4: Infrastructure (3/5 tasks)"
# Returns empty string if no waves defined.
# Waves from config.json + task status from tasks.json.
harness_wave_progress() {
  local PROGRESS="$1"
  local config; config=$(_resolve_config_file "$PROGRESS") || return 1
  local tasks; tasks=$(_resolve_tasks_file "$PROGRESS") || return 1
  jq -r --slurpfile task_data "$tasks" '
    if (.waves // [] | length) == 0 then ""
    else
      (.waves | length) as $total_waves |
      (
        [.waves | to_entries[] | select(.value.status == "in_progress")][0] //
        [.waves | to_entries[] | select(.value.status == "pending")][0] //
        null
      ) as $curr |
      if $curr == null then
        "All \($total_waves) waves complete"
      else
        ($task_data[0].tasks // {}) as $tasks |
        ($curr.value.tasks // []) as $wave_tasks |
        ([$wave_tasks[] | select($tasks[.].status == "completed")] | length) as $done |
        ($wave_tasks | length) as $task_total |
        "Wave \($curr.key + 1)/\($total_waves): \($curr.value.name) (\($done)/\($task_total) tasks)"
      end
    end
  ' "$config" 2>/dev/null || echo ""
}

# Task IDs in the current wave (newline-separated).
# Returns empty if no waves or no current wave.
# Waves from config.json.
harness_wave_tasks() {
  local PROGRESS="$1"
  local config; config=$(_resolve_config_file "$PROGRESS") || return 1
  jq -r '
    if (.waves // [] | length) == 0 then empty
    else
      (
        [.waves[] | select(.status == "in_progress")][0] //
        [.waves[] | select(.status == "pending")][0] //
        null
      ) as $curr |
      if $curr == null then empty
      else ($curr.tasks // [])[] end
    end
  ' "$config" 2>/dev/null || true
}

# True if all tasks in the current wave are completed.
# Returns "false" if no waves defined or no current wave.
# Waves from config.json, task status from tasks.json.
harness_is_wave_boundary() {
  local PROGRESS="$1"
  local config; config=$(_resolve_config_file "$PROGRESS") || return 1
  local tasks; tasks=$(_resolve_tasks_file "$PROGRESS") || return 1
  jq -r --slurpfile task_data "$tasks" '
    if (.waves // [] | length) == 0 then "false"
    else
      ($task_data[0].tasks // {}) as $all_tasks |
      (
        [.waves[] | select(.status == "in_progress")][0] //
        [.waves[] | select(.status == "pending")][0] //
        null
      ) as $curr |
      if $curr == null then "false"
      else
        ($curr.tasks // []) as $wave_tasks |
        if ($wave_tasks | length) == 0 then "false"
        else
          if ([$wave_tasks[] | select($all_tasks[.].status != "completed")] | length) == 0
          then "true"
          else "false"
          end
        end
      end
    end
  ' "$config" 2>/dev/null || echo "false"
}

# Report path for a wave number (1-indexed).
# Returns the path regardless of whether the file exists.
harness_wave_report_path() {
  local PROGRESS="$1"
  local WAVE_NUM="$2"
  local HNAME=$(harness_name "$PROGRESS")
  echo "$HOME/.claude-ops/harness/reports/$HNAME/wave-${WAVE_NUM}.html"
}

# ═══════════════════════════════════════════════════════════════
# WAVE GATE INJECTION — Structural enforcement of wave boundaries
# ═══════════════════════════════════════════════════════════════
# Creates "wave-N-report" gate tasks that block the next wave's tasks.
# Gate tasks require: commit, deploy, inspect, screenshot, report, notify, wait.
# Idempotent: skips if gate already exists.
# Retroactive-safe: if all wave tasks completed AND report file exists, auto-marks gate completed.

harness_inject_wave_gates() {
  local PROGRESS="${1:?Usage: harness_inject_wave_gates <progress.json>}"
  [ ! -f "$PROGRESS" ] && return 0

  local config; config=$(_resolve_config_file "$PROGRESS") || return 1
  local tasks; tasks=$(_resolve_tasks_file "$PROGRESS") || return 1

  local WAVE_COUNT
  WAVE_COUNT=$(jq '.waves // [] | length' "$config" 2>/dev/null || echo "0")
  [ "$WAVE_COUNT" -eq 0 ] && return 0

  local HNAME
  HNAME=$(harness_name "$PROGRESS")
  local REPORT_DIR="$HOME/.claude-ops/harness/reports/$HNAME"

  # Process each wave
  local i=0
  while [ "$i" -lt "$WAVE_COUNT" ]; do
    local WAVE_ID=$((i + 1))
    local GATE_ID="wave-${WAVE_ID}-report"

    # Skip if gate task already exists
    local EXISTS
    EXISTS=$(jq -r --arg g "$GATE_ID" '.tasks[$g] // empty' "$tasks" 2>/dev/null || echo "")
    if [ -n "$EXISTS" ]; then
      i=$((i + 1))
      continue
    fi

    # Get wave tasks and wave name (from config/progress for wave definitions)
    local WAVE_TASKS WAVE_NAME
    WAVE_TASKS=$(jq -r --argjson idx "$i" '(.waves[$idx].tasks // []) | join(",")' "$config" 2>/dev/null || echo "")
    WAVE_NAME=$(jq -r --argjson idx "$i" '.waves[$idx].name // "Wave \($idx + 1)"' "$config" 2>/dev/null || echo "Wave $WAVE_ID")

    [ -z "$WAVE_TASKS" ] && { i=$((i + 1)); continue; }

    # Build blockedBy array from wave tasks (the gate depends on ALL wave tasks)
    local BLOCKED_BY_JSON
    BLOCKED_BY_JSON=$(jq -n --arg tasks "$WAVE_TASKS" '$tasks | split(",") | map(select(. != ""))')

    # Check if gate should be auto-completed (retroactive: all tasks done + report exists)
    # Need to cross-reference wave tasks (from config) with task status (from tasks file)
    local ALL_DONE="false"
    if [ "$config" != "$tasks" ]; then
      # v2: waves in config, task status in tasks.json
      ALL_DONE=$(jq -r --argjson idx "$i" --slurpfile task_data "$tasks" '
        (.waves[$idx].tasks // []) as $task_ids |
        ($task_data[0].tasks // {}) as $t |
        if ($task_ids | length) == 0 then "false"
        else ([$task_ids[] as $tid | $t[$tid].status // "pending"] | all(. == "completed")) | tostring end
      ' "$config" 2>/dev/null || echo "false")
    else
      ALL_DONE=$(jq -r --argjson idx "$i" '
        . as $root |
        (.waves[$idx].tasks // []) as $task_ids |
        if ($task_ids | length) == 0 then "false"
        else ([$task_ids[] as $t | $root.tasks[$t].status // "pending"] | all(. == "completed")) | tostring end
      ' "$PROGRESS" 2>/dev/null || echo "false")
    fi

    local REPORT_FILE="$REPORT_DIR/wave-${WAVE_ID}.html"
    local GATE_STATUS="pending"
    if [ "$ALL_DONE" = "true" ] && [ -f "$REPORT_FILE" ]; then
      GATE_STATUS="completed"
    fi

    local GATE_DESC="**Wave ${WAVE_ID} Gate: ${WAVE_NAME}** — Complete these 10 steps before proceeding:
1. Commit all wave changes: feat(${HNAME}): wave ${WAVE_ID} — ${WAVE_NAME}
2. Deploy: ./scripts/deploy.sh --service static --skip-langfuse (or appropriate service)
3. Inspect every feature from this wave in Chrome
4. Take screenshots of each feature
5. Copy the starter: cp ~/.claude-ops/templates/wave-report-starter.html ~/.claude-ops/harness/reports/${HNAME}/wave-${WAVE_ID}.html
6. Edit the report — replace placeholder comments with real content
7. Generate wave report HTML at ~/.claude-ops/harness/reports/${HNAME}/wave-${WAVE_ID}.html
8. Open the report: open ~/.claude-ops/harness/reports/${HNAME}/wave-${WAVE_ID}.html
9. Notify the operator: notify \"${HNAME} wave ${WAVE_ID} complete — report ready for review\"
10. WAIT for the operator's confirmation before proceeding to the next wave"

    # Inject gate task into tasks file
    local lock_name="tasks-$(basename "$(dirname "$tasks")")"
    locked_jq_write "$tasks" "$lock_name" \
      '.tasks[$gate_id] = {
        status: $status,
        description: $desc,
        blockedBy: ($blocked_by | fromjson),
        owner: null,
        steps: [],
        completed_steps: [],
        metadata: {
          wave_gate: true,
          wave_number: ($wave_num | tonumber),
          wave_name: $wave_name
        }
      }' \
      --arg gate_id "$GATE_ID" \
      --arg status "$GATE_STATUS" \
      --arg desc "$GATE_DESC" \
      --arg blocked_by "$BLOCKED_BY_JSON" \
      --arg wave_num "$WAVE_ID" \
      --arg wave_name "$WAVE_NAME"

    # Add gate to this wave's task list (in config/progress where waves are defined)
    local waves_file="$config"
    local waves_lock="config-$(basename "$(dirname "$waves_file")")"
    locked_jq_write "$waves_file" "$waves_lock" \
      '(.waves[$idx].tasks // []) as $tasks |
       if ($tasks | index($gate)) then . else .waves[$idx].tasks += [$gate] end' \
      --argjson idx "$i" \
      --arg gate "$GATE_ID"

    # Make next wave's tasks depend on this gate
    local NEXT_IDX=$((i + 1))
    if [ "$NEXT_IDX" -lt "$WAVE_COUNT" ]; then
      local NEXT_TASKS
      NEXT_TASKS=$(jq -r --argjson idx "$NEXT_IDX" '(.waves[$idx].tasks // [])[]' "$config" 2>/dev/null || true)
      for NEXT_TASK in $NEXT_TASKS; do
        # Skip if next task is itself a gate
        [[ "$NEXT_TASK" == wave-*-report ]] && continue
        # Add blockedBy if not already present
        locked_jq_write "$tasks" "$lock_name" \
          'if (.tasks[$t].blockedBy // [] | index($gate)) then .
           else .tasks[$t].blockedBy = ((.tasks[$t].blockedBy // []) + [$gate]) end' \
          --arg t "$NEXT_TASK" \
          --arg gate "$GATE_ID"
      done
    fi

    i=$((i + 1))
  done
}

# ═══════════════════════════════════════════════════════════════
# MANIFEST REGISTRY FUNCTIONS
# ═══════════════════════════════════════════════════════════════

# Get manifest path for a harness
harness_manifest() {
  local name="$1"
  echo "$HOME/.claude-ops/harness/manifests/$name/manifest.json"
}

# Get project root for a harness (from manifest)
harness_project_root() {
  local name="$1"
  local manifest="$(harness_manifest "$name")"
  [ -f "$manifest" ] && jq -r '.project_root // ""' "$manifest" 2>/dev/null || echo ""
}

# Get tasks file path for a harness (v2: tasks.json)
# Returns the tasks.json path for the named harness.
harness_progress_path() {
  local name="$1"
  local project="${2:-}"  # optional project_root override

  # Try 1: manifest for project_root
  local manifest="$(harness_manifest "$name")"
  if [ -f "$manifest" ] && [ -z "$project" ]; then
    project=$(jq -r '.project_root // ""' "$manifest" 2>/dev/null)
  fi

  # Try 2: manifest files.progress field (relative to project_root)
  if [ -f "$manifest" ] && [ -n "$project" ]; then
    local rel_progress
    rel_progress=$(jq -r '.files.progress // ""' "$manifest" 2>/dev/null)
    if [ -n "$rel_progress" ] && [ -f "$project/$rel_progress" ]; then
      echo "$project/$rel_progress" && return
    fi
  fi

  # Try 2.5: flat worker tasks.json (check worktree, then fall back to main repo)
  if [[ "$name" == worker/* ]]; then
    local worker_name="${name#worker/}"
    if [ -n "$project" ] && [ -f "$project/.claude/workers/$worker_name/tasks.json" ]; then
      echo "$project/.claude/workers/$worker_name/tasks.json" && return
    fi
    # Worktree fallback: resolve main repo root
    if [ -n "$project" ]; then
      local _main_root
      _main_root=$(git -C "$project" rev-parse --path-format=absolute --git-common-dir 2>/dev/null | sed 's|/\.git$||')
      if [ -n "$_main_root" ] && [ "$_main_root" != "$project" ] && [ -f "$_main_root/.claude/workers/$worker_name/tasks.json" ]; then
        echo "$_main_root/.claude/workers/$worker_name/tasks.json" && return
      fi
    fi
  fi

  # Try 3: v2 tasks.json
  if [ -n "$project" ] && [ -f "$project/.claude/harness/$name/tasks.json" ]; then
    echo "$project/.claude/harness/$name/tasks.json" && return
  fi

  echo ""
}

# Discover ALL task files in a project
# Output: one absolute path per line
harness_all_progress_files() {
  local project="${1:?Usage: harness_all_progress_files <project_root>}"
  for pf in "$project"/.claude/harness/*/tasks.json; do
    [ -f "$pf" ] || continue
    echo "$pf"
  done
  # Flat workers
  for pf in "$project"/.claude/workers/*/tasks.json; do
    [ -f "$pf" ] || continue
    echo "$pf"
  done
}

# ── Policy file resolution ──
# policy.json at .claude/harness/{name}/policy.json (single file with "rules" + "inject" sections)

# Returns path to the injections config (also serves as rules file — same policy.json)
harness_inject_file() {
  local harness="${1:?}" project="${2:?}"
  # Flat worker path (check worktree, then main repo)
  if [[ "$harness" == worker/* ]]; then
    local wf="$project/.claude/workers/${harness#worker/}/policy.json"
    [ -f "$wf" ] && echo "$wf" && return
    local _main_root
    _main_root=$(git -C "$project" rev-parse --path-format=absolute --git-common-dir 2>/dev/null | sed 's|/\.git$||')
    if [ -n "$_main_root" ] && [ "$_main_root" != "$project" ]; then
      wf="$_main_root/.claude/workers/${harness#worker/}/policy.json"
      [ -f "$wf" ] && echo "$wf" && return
    fi
  fi
  local f="$project/.claude/harness/$harness/policy.json"
  [ -f "$f" ] && echo "$f" && return
  echo ""
}

# Extract the jq path prefix for injections: ".inject" for policy.json, "" for standalone files
harness_inject_jq_prefix() {
  local file="$1"
  case "$(basename "$file")" in
    *policy.json) echo ".inject" ;;
    *) echo "" ;;
  esac
}

# List all active harnesses across all projects
# Output: name|project_root|progress_path (one per line)
harness_list_active() {
  for manifest in "$HOME"/.claude-ops/harness/manifests/*/manifest.json; do
    [ -f "$manifest" ] || continue
    local name=$(jq -r '.harness' "$manifest" 2>/dev/null)
    local project=$(jq -r '.project_root' "$manifest" 2>/dev/null)
    local rel_progress=$(jq -r '.files.progress // .progress_file // ""' "$manifest" 2>/dev/null)
    [ -z "$rel_progress" ] && continue
    local progress="$project/$rel_progress"
    [ ! -f "$progress" ] && continue
    local hstatus=$(jq -r '.status // "unknown"' "$progress" 2>/dev/null || echo "unknown")
    [ "$hstatus" = "active" ] && echo "$name|$project|$progress"
  done
}

# List all registered harnesses (active and done)
# Output: name|status|project_root
harness_list_all() {
  for manifest in "$HOME"/.claude-ops/harness/manifests/*/manifest.json; do
    [ -f "$manifest" ] || continue
    local name=$(jq -r '.harness' "$manifest" 2>/dev/null)
    local project=$(jq -r '.project_root' "$manifest" 2>/dev/null)
    local rel_progress=$(jq -r '.files.progress // .progress_file // ""' "$manifest" 2>/dev/null)
    local hstatus="unknown"
    if [ -n "$rel_progress" ]; then
      local progress="$project/$rel_progress"
      [ -f "$progress" ] && hstatus=$(jq -r '.status // "unknown"' "$progress" 2>/dev/null || echo "unknown")
    fi
    echo "$name|$hstatus|$project"
  done
}




# ── hq_send — unified cell messaging via event bus (v2: bus-only) ────────────
# Usage: hq_send FROM TO TYPE CONTENT [PRIORITY]
#
# Publishes a cell-message event to the bus. Side-effects (defined in schema.json):
#   1. notify_assignee       — writes to TO's inbox.jsonl (supports module/worker slash)
#   2. notify_tmux_if_urgent — sends tmux send-keys to TO's pane (when PRIORITY=urgent)
#
# No direct inbox writes — all routing handled by bus side-effects.
#
# Example:
#   hq_send "hq-v2" "mod-customer" "task" "Start probing criterion 2.1" "urgent"
#   hq_send "mod-customer/kefu-latency" "mod-customer" "status" "Loop 3 complete"
hq_send() {
  local from="${1:-hq-v2}"
  local to="${2:?hq_send: TO required}"
  local msg_type="${3:-task}"
  local content="${4:?hq_send: CONTENT required}"
  local priority="${5:-normal}"

  local project_root="${PROJECT_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
  local bus_dir="$project_root/.claude/bus"

  # Build payload — use 'body' alias for content so notify_tmux_if_urgent picks it up
  local payload
  payload=$(jq -nc \
    --arg from "$from" \
    --arg to "$to" \
    --arg type "$msg_type" \
    --arg content "$content" \
    --arg body "$content" \
    --arg priority "$priority" \
    --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{from:$from, to:$to, type:$type, content:$content, body:$body, priority:$priority, ts:$ts}')

  # Publish to bus — side-effects handle inbox/outbox delivery
  PROJECT_ROOT="$project_root" BUS_DIR="$bus_dir" \
    bash -c "source '$HOME/.claude-ops/lib/event-bus.sh' && bus_publish 'cell-message' '$payload'" 2>/dev/null || true
}


