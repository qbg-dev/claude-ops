#!/usr/bin/env bash
# worker-dispatch.sh — Sidecar→Worker dispatch library.
#
# Provides functions for sidecars to discover, launch, monitor,
# and communicate with their worker harnesses.
#
# Usage (source in sidecar scripts or bash):
#   export SIDECAR_NAME="mod-customer" PROJECT_ROOT="/path/to/project"
#   source ~/.claude-ops/lib/worker-dispatch.sh
#   worker_discover
#   worker_launch "miniapp-ux-v2"
#   worker_health "miniapp-ux-v2"
#
# Dependencies:
#   - fleet-jq.sh (locked_jq_write, _lock/_unlock, harness_progress_path, HARNESS_LOCK_DIR)
#   - harness-launch.sh (harness_launch)
#
# Environment (set before sourcing):
#   SIDECAR_NAME   — e.g. "mod-customer"
#   PROJECT_ROOT   — e.g. "/path/to/your/project"
#   SIDECAR_PANE   — auto-detected if not set

# ── Source dependencies ────────────────────────────────────────
source "$HOME/.claude-ops/lib/fleet-jq.sh"

WORKER_LAUNCH_TIMEOUT_SEC="${WORKER_LAUNCH_TIMEOUT_SEC:-90}"
WORKER_HEALTH_CAPTURE_LINES="${WORKER_HEALTH_CAPTURE_LINES:-10}"
WORKER_DEFAULT_MODEL="${WORKER_DEFAULT_MODEL:-cdo}"
TMUX_SESSION="${TMUX_SESSION:-h}"

# ── Auto-detect sidecar pane ──────────────────────────────────
_detect_sidecar_pane() {
  if [ -n "${SIDECAR_PANE:-}" ]; then
    echo "$SIDECAR_PANE"
    return
  fi
  local own_pane_id
  own_pane_id=$(tmux list-panes -a -F '#{pane_pid} #{pane_id}' 2>/dev/null | while read pid id; do
    local p=$PPID
    while [ "$p" -gt 1 ]; do
      [ "$p" = "$pid" ] && echo "$id" && break 2
      p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')
    done
  done)
  [ -z "$own_pane_id" ] && echo "unknown" && return
  tmux list-panes -a -F '#{pane_id} #{session_name}:#{window_index}.#{pane_index}' 2>/dev/null | \
    awk -v id="$own_pane_id" '$1 == id {print $2; exit}'
}

# ═══════════════════════════════════════════════════════════════
# JSON Parser — scan per-worker permissions.json files
# ═══════════════════════════════════════════════════════════════
# Returns: name|model|mode|allowed_tools_csv per line
# allowed_tools_csv is comma-separated (empty string if none specified)

_parse_workers_json() {
  local harness_dir="$1"
  local worker_base="$harness_dir/agents/worker"
  [ ! -d "$worker_base" ] && return 1

  for worker_dir in "$worker_base"/*/; do
    [ ! -d "$worker_dir" ] && continue
    local name
    name=$(basename "$worker_dir")
    local perms="$worker_dir/permissions.json"
    local config="$worker_dir/config.json"
    local w_model="" w_mode="" w_allowed=""

    # Read from permissions.json (primary) with config.json fallback for model
    if [ -f "$perms" ]; then
      w_model=$(jq -r '.model // empty' "$perms")
      w_mode=$(jq -r '.permission_mode // "default"' "$perms")
      w_allowed=$(jq -r '(.allowedTools // []) | join(",")' "$perms")
    fi
    [ -z "$w_model" ] && [ -f "$config" ] && w_model=$(jq -r '.model // empty' "$config")
    [ -z "$w_model" ] && w_model="$WORKER_DEFAULT_MODEL"
    [ -z "$w_mode" ] && w_mode="default"

    echo "${name}|${w_model}|${w_mode}|${w_allowed}"
  done
}

# ═══════════════════════════════════════════════════════════════
# Pane Discovery (inline — no fleet-pane.sh dependency)
# ═══════════════════════════════════════════════════════════════

# Find the tmux pane for a worker harness.
# Checks pane-registry first, then falls back to tmux window name.
# Returns pane target (e.g. "h:miniapp-ux-v2.0") or empty string.
_find_worker_pane() {
  local worker="$1"

  # Strategy 1: Check pane registry for a pane registered to this harness (project-scoped)
  if [ -f "$PANE_REGISTRY" ]; then
    local pane_id _proj="${PROJECT_ROOT:-}"
    if [ -n "$_proj" ]; then
      pane_id=$(jq -r --arg h "$worker" --arg proj "$_proj" '
        to_entries[] | select(.value.harness == $h and (.value.project_root // "") == $proj) | .key
      ' "$PANE_REGISTRY" 2>/dev/null | head -1)
    else
      pane_id=$(jq -r --arg h "$worker" '
        to_entries[] | select(.value.harness == $h) | .key
      ' "$PANE_REGISTRY" 2>/dev/null | head -1)
    fi
    if [ -n "$pane_id" ] && [ "$pane_id" != "null" ]; then
      # Convert pane_id to human-readable target
      local target
      target=$(tmux list-panes -a -F '#{pane_id} #{session_name}:#{window_index}.#{pane_index}' 2>/dev/null | \
        awk -v id="$pane_id" '$1 == id {print $2; exit}')
      if [ -n "$target" ]; then
        echo "$target"
        return 0
      fi
    fi
  fi

  # Strategy 2: Look for tmux window named after the worker
  if tmux list-windows -t "$TMUX_SESSION" -F '#{window_name}' 2>/dev/null | grep -q "^${worker}$"; then
    local target
    target=$(tmux list-panes -t "${TMUX_SESSION}:${worker}" -F '#{session_name}:#{window_index}.#{pane_index}' 2>/dev/null | head -1)
    if [ -n "$target" ]; then
      echo "$target"
      return 0
    fi
  fi

  echo ""
  return 1
}

# Check if a Claude process is running in a pane.
# Returns 0 (true) if Claude is alive, 1 (false) otherwise.
_is_claude_alive_in_pane() {
  local pane="$1"
  [ -z "$pane" ] && return 1

  local pane_pid
  pane_pid=$(tmux display-message -t "$pane" -p '#{pane_pid}' 2>/dev/null || echo "")
  [ -z "$pane_pid" ] && return 1

  local cpid
  for cpid in $(pgrep -P "$pane_pid" 2>/dev/null | head -5); do
    if ps -o command= -p "$cpid" 2>/dev/null | grep -q "claude"; then
      return 0
    fi
  done
  return 1
}

# ═══════════════════════════════════════════════════════════════
# PUBLIC API
# ═══════════════════════════════════════════════════════════════

# worker_discover — Scan per-worker permissions.json → list workers with model/mode/allowed_tools.
# Output: name|model|mode|allowed_tools_csv per line
worker_discover() {
  local sidecar="${SIDECAR_NAME:?SIDECAR_NAME must be set}"
  local project="${PROJECT_ROOT:?PROJECT_ROOT must be set}"
  local harness_dir="$project/.claude/harness/$sidecar"
  local worker_base="$harness_dir/agents/worker"

  if [ ! -d "$worker_base" ]; then
    echo "ERROR: No worker directory found: $worker_base" >&2
    return 1
  fi

  _parse_workers_json "$harness_dir"
}

# worker_launch — Idempotent: launch worker if not running, skip if alive.
# Usage: worker_launch <name> [model] [--monitor] [--mode MODE] [--allowed-tools CSV]
# Sets WORKER_PANE on success.
worker_launch() {
  local worker="${1:?Usage: worker_launch <name> [model] [--monitor]}"
  local model="${2:-$WORKER_DEFAULT_MODEL}"
  local with_monitor=false
  local launch_mode="bypassPermissions"
  local allowed_tools_csv=""
  shift 2 2>/dev/null || true
  while [ $# -gt 0 ]; do
    case "$1" in
      --monitor) with_monitor=true; shift ;;
      --mode) launch_mode="$2"; shift 2 ;;
      --allowed-tools) allowed_tools_csv="$2"; shift 2 ;;
      *) shift ;;
    esac
  done

  local sidecar="${SIDECAR_NAME:?SIDECAR_NAME must be set}"
  local project="${PROJECT_ROOT:?PROJECT_ROOT must be set}"

  # Per-worker launch lock
  local lockdir="$HARNESS_LOCK_DIR/worker-launch-$worker"
  _lock "$lockdir"

  # Check if already running
  local existing_pane
  existing_pane=$(_find_worker_pane "$worker") || true
  if [ -n "$existing_pane" ] && _is_claude_alive_in_pane "$existing_pane"; then
    WORKER_PANE="$existing_pane"
    export WORKER_PANE
    _unlock "$lockdir"
    worker_sync_state "$worker" "alive"
    echo "ALREADY_RUNNING|$existing_pane"
    return 0
  fi

  # Verify seed script exists
  local seed_script="$project/.claude/scripts/${worker}-seed.sh"
  if [ ! -f "$seed_script" ]; then
    _unlock "$lockdir"
    echo "ERROR: No seed script for worker: $seed_script" >&2
    return 1
  fi

  # Resolve claude command from model string + permission mode
  local resolved_model chrome_flag=""
  case "$model" in
    cdo|cdoc|opus) resolved_model="opus"; chrome_flag="--chrome" ;;
    cds|sonnet)    resolved_model="sonnet"; chrome_flag="--chrome" ;;
    cdh|haiku)     resolved_model="haiku" ;;
    *)             resolved_model="$model" ;;
  esac

  local claude_cmd
  if [ "$launch_mode" = "bypassPermissions" ]; then
    claude_cmd="claude --dangerously-skip-permissions --model $resolved_model${chrome_flag:+ $chrome_flag}"
  elif [ -n "$allowed_tools_csv" ]; then
    # mode=default with explicit allowed tools → least-privilege
    claude_cmd="claude --model $resolved_model --allowedTools '$allowed_tools_csv'${chrome_flag:+ $chrome_flag}"
  else
    # mode=default without allowed tools → will prompt for every tool use
    claude_cmd="claude --model $resolved_model${chrome_flag:+ $chrome_flag}"
  fi

  # Use idempotent flag so harness_launch returns 0 if already running
  export WORKER_DISPATCH_IDEMPOTENT=true
  export CLAUDE_CMD="$claude_cmd"

  # TODO: worker_launch() is unused — watchdog uses launch-flat-worker.sh directly
  echo "ERROR: worker_launch() is deprecated. Use launch-flat-worker.sh instead." >&2
  _unlock "$lockdir"
  return 1

  local launch_args=("$worker" "$project")
  [ "$with_monitor" = true ] && launch_args+=(--monitor)

  if harness_launch "${launch_args[@]}"; then
    _unlock "$lockdir"
    worker_sync_state "$worker" "alive"
    echo "LAUNCHED|${WORKER_PANE:-unknown}"
    return 0
  else
    _unlock "$lockdir"
    echo "ERROR: Failed to launch worker: $worker" >&2
    return 1
  fi
}

# worker_health — Returns alive|dead|no_pane|idle + pane target.
# Output: status|pane_target
worker_health() {
  local worker="${1:?Usage: worker_health <name>}"

  local pane
  pane=$(_find_worker_pane "$worker") || true

  if [ -z "$pane" ]; then
    echo "no_pane|"
    return 0
  fi

  if ! _is_claude_alive_in_pane "$pane"; then
    echo "dead|$pane"
    return 0
  fi

  # Check if idle (looking for prompt indicators in recent output)
  local capture
  capture=$(tmux capture-pane -t "$pane" -p 2>/dev/null | tail -"$WORKER_HEALTH_CAPTURE_LINES" || true)

  if echo "$capture" | grep -qE '⏺|thinking|Reading|Running|Booping|Razzle|Calling|Writing'; then
    echo "alive|$pane"
  else
    echo "idle|$pane"
  fi
}

# worker_health_all — Health check all workers from per-worker permissions.json.
# Output: name|status|pane per line
worker_health_all() {
  local workers
  workers=$(worker_discover) || return 1

  echo "$workers" | while IFS='|' read -r name model mode allowed_csv; do
    local health
    health=$(worker_health "$name")
    local w_status w_pane
    IFS='|' read -r w_status w_pane <<< "$health"
    echo "$name|$w_status|$w_pane"
  done
}

# worker_send_message — Send a signed tmux message to a worker.
# LEGACY WRAPPER: Now routes through outbox via worker_send().
# Usage: worker_send_message <name> <type> <content>
# Types: REGRESSION, TASK, CONTEXT, PERMISSION
worker_send_message() {
  local worker="${1:?Usage: worker_send_message <name> <type> <content>}"
  local msg_type="${2:?Usage: worker_send_message <name> <type> <content>}"
  local content="${3:?Usage: worker_send_message <name> <type> <content>}"
  worker_send "$worker" urgent "$msg_type: $content"
}

# worker_inject_context — Write to worker's policy.json → inject.tool_context.
# LEGACY WRAPPER: Now routes through outbox via worker_send().
# Usage: worker_inject_context <name> <key> <text>
worker_inject_context() {
  local worker="${1:?Usage: worker_inject_context <name> <key> <text>}"
  local key="${2:?Usage: worker_inject_context <name> <key> <text>}"
  local text="${3:?Usage: worker_inject_context <name> <key> <text>}"
  local sidecar="${SIDECAR_NAME:?SIDECAR_NAME must be set}"
  # Atomic write to policy.json + bus observability event
  local tagged="[SIDECAR:${sidecar}] ${text}"
  harness_inject_policy "$worker" "tool_context" "$key" "$tagged" "always"
}

# worker_inject_journal — v3: routes to worker's inbox.jsonl via worker_send().
# No journal.md in v3. Kept for API compatibility.
# Usage: worker_inject_journal <name> <text>
worker_inject_journal() {
  local worker="${1:?Usage: worker_inject_journal <name> <text>}"
  local text="${2:?Usage: worker_inject_journal <name> <text>}"
  # v3: send as directive to inbox (materialized by bus side-effects)
  worker_send "$worker" directive "$text"
}

# worker_add_task — Add task to worker's progress.json (idempotent).
# LEGACY WRAPPER: Now routes through outbox via worker_send().
# Usage: worker_add_task <name> <task_id> <desc> [blocked_by]
# blocked_by: comma-separated task IDs (optional)
worker_add_task() {
  local worker="${1:?Usage: worker_add_task <name> <task_id> <desc> [blocked_by]}"
  local task_id="${2:?Usage: worker_add_task <name> <task_id> <desc> [blocked_by]}"
  local desc="${3:?Usage: worker_add_task <name> <task_id> <desc> [blocked_by]}"
  local blocked_by="${4:-}"
  local sidecar="${SIDECAR_NAME:?SIDECAR_NAME must be set}"
  local project="${PROJECT_ROOT:?PROJECT_ROOT must be set}"
  local progress
  progress=$(harness_progress_path "$worker" "$project")
  # Idempotent check — if task exists, report and skip
  if [ -n "$progress" ] && [ -f "$progress" ]; then
    local existing
    existing=$(jq -r --arg tid "$task_id" '.tasks[$tid].status // empty' "$progress" 2>/dev/null)
    if [ -n "$existing" ]; then
      echo "EXISTS|$worker|$task_id"
      return 0
    fi
  fi
  # Outbox-first: queue for router
  worker_send "$worker" task "$task_id" "$desc" "$blocked_by"
  # Direct write for immediate effect (backward compat)
  if [ -n "$progress" ] && [ -f "$progress" ]; then
    local blocked_json="[]"
    [ -n "$blocked_by" ] && blocked_json=$(echo "$blocked_by" | tr ',' '\n' | python3 -c "import sys,json; print(json.dumps([l.strip() for l in sys.stdin if l.strip()]))")
    local tmp="${progress}.tmp.$$"
    jq --arg tid "$task_id" --arg d "$desc" --argjson bb "$blocked_json" --arg cb "$sidecar" \
      '.tasks[$tid] = {"status":"pending","description":$d,"blockedBy":$bb,"metadata":{"created_by":$cb}}' \
      "$progress" > "$tmp" 2>/dev/null && mv "$tmp" "$progress"
  fi
}

# worker_read_progress — Read worker's task graph summary.
# Output: done|total|current_task
worker_read_progress() {
  local worker="${1:?Usage: worker_read_progress <name>}"
  local project="${PROJECT_ROOT:?PROJECT_ROOT must be set}"

  local progress
  progress=$(harness_progress_path "$worker" "$project")
  if [ -z "$progress" ] || [ ! -f "$progress" ]; then
    echo "ERROR: No progress.json found for worker: $worker" >&2
    return 1
  fi

  local done_count total current
  done_count=$(harness_done_count "$progress")
  total=$(harness_total_count "$progress")
  current=$(harness_current_task "$progress")

  echo "$done_count|$total|$current"
}

# worker_sync_state — Update state.workers[] in sidecar's own progress.json.
# Usage: worker_sync_state <name> <status>
# status: alive, dead, no_pane, idle, launched
worker_sync_state() {
  local worker="${1:?Usage: worker_sync_state <name> <status>}"
  local status="${2:?Usage: worker_sync_state <name> <status>}"
  local sidecar="${SIDECAR_NAME:?SIDECAR_NAME must be set}"
  local project="${PROJECT_ROOT:?PROJECT_ROOT must be set}"

  local sidecar_progress
  sidecar_progress=$(harness_progress_path "$sidecar" "$project")
  if [ -z "$sidecar_progress" ] || [ ! -f "$sidecar_progress" ]; then
    echo "WARN: No progress.json for sidecar: $sidecar" >&2
    return 0
  fi

  local hname
  hname=$(harness_name "$sidecar_progress")
  local timestamp
  timestamp=$(date -u '+%Y-%m-%dT%H:%M:%SZ')

  locked_jq_write "$sidecar_progress" "progress-$hname" \
    '(.state.workers // []) as $workers |
     ($workers | map(select(.name == $name)) | length) as $found |
     if $found > 0 then
       .state.workers = [$workers[] | if .name == $name then . + {status: $status, last_checked: $ts} else . end]
     else
       .state.workers = ($workers + [{name: $name, harness: $name, status: $status, last_checked: $ts}])
     end' \
    --arg name "$worker" \
    --arg status "$status" \
    --arg ts "$timestamp"
}

# ═══════════════════════════════════════════════════════════════
# OUTBOX-FIRST MESSAGING API
# ═══════════════════════════════════════════════════════════════
# All messages go through sender's outbox.jsonl first.
# The inbox-router.sh PostToolUse hook delivers to recipients.

# _outbox_append — Low-level: append a JSON message to sender's outbox.jsonl.
# Usage: _outbox_append <json_string>
_outbox_append() {
  local json_line="$1"
  local sidecar="${SIDECAR_NAME:?SIDECAR_NAME must be set}"
  local project="${PROJECT_ROOT:?PROJECT_ROOT must be set}"
  local outbox="$project/.claude/harness/$sidecar/outbox.jsonl"
  mkdir -p "$(dirname "$outbox")"
  echo "$json_line" >> "$outbox"
}

# worker_send — Send a typed message to a specific harness via outbox.
# Usage: worker_send <target> <type> [args...]
#   worker_send "name" context "key" "text"
#   worker_send "name" task "task_id" "description" ["blocked_by"]
#   worker_send "name" directive "text"
#   worker_send "name" urgent "text"
#   worker_send "name" status "text"
worker_send() {
  local target="${1:?Usage: worker_send <target> <type> [args...]}"
  local msg_type="${2:?Usage: worker_send <target> <type> [args...]}"
  shift 2
  local sidecar="${SIDECAR_NAME:?SIDECAR_NAME must be set}"
  local timestamp
  timestamp=$(date -u '+%Y-%m-%dT%H:%M:%SZ')

  local json_msg=""
  case "$msg_type" in
    context)
      local key="${1:?worker_send context requires key and text}"
      local text="${2:?worker_send context requires key and text}"
      json_msg=$(python3 -c "
import json, sys
print(json.dumps({
    'ts': sys.argv[1], 'from': sys.argv[2], 'type': 'context',
    'to': sys.argv[3], 'key': sys.argv[4], 'content': sys.argv[5], 'routed': False
}))" "$timestamp" "$sidecar" "$target" "$key" "$text")
      ;;
    task)
      local task_id="${1:?worker_send task requires task_id and description}"
      local desc="${2:?worker_send task requires task_id and description}"
      local blocked_by="${3:-}"
      local blocked_json="[]"
      [ -n "$blocked_by" ] && blocked_json=$(echo "$blocked_by" | tr ',' '\n' | python3 -c "import sys,json; print(json.dumps([l.strip() for l in sys.stdin if l.strip()]))")
      json_msg=$(python3 -c "
import json, sys
print(json.dumps({
    'ts': sys.argv[1], 'from': sys.argv[2], 'type': 'task',
    'to': sys.argv[3], 'task_id': sys.argv[4], 'description': sys.argv[5],
    'blocked_by': json.loads(sys.argv[6]), 'routed': False
}))" "$timestamp" "$sidecar" "$target" "$task_id" "$desc" "$blocked_json")
      ;;
    directive)
      local text="${1:?worker_send directive requires text}"
      json_msg=$(python3 -c "
import json, sys
print(json.dumps({
    'ts': sys.argv[1], 'from': sys.argv[2], 'type': 'directive',
    'to': sys.argv[3], 'content': sys.argv[4], 'routed': False
}))" "$timestamp" "$sidecar" "$target" "$text")
      ;;
    urgent)
      local text="${1:?worker_send urgent requires text}"
      json_msg=$(python3 -c "
import json, sys
print(json.dumps({
    'ts': sys.argv[1], 'from': sys.argv[2], 'type': 'urgent',
    'to': sys.argv[3], 'content': sys.argv[4], 'routed': False
}))" "$timestamp" "$sidecar" "$target" "$text")
      ;;
    status|decision|learning|register|heartbeat|deregister)
      local text="${1:-}"
      json_msg=$(python3 -c "
import json, sys
msg = {
    'ts': sys.argv[1], 'from': sys.argv[2], 'type': sys.argv[3],
    'to': sys.argv[4], 'content': sys.argv[5], 'routed': False
}
print(json.dumps(msg))" "$timestamp" "$sidecar" "$msg_type" "$target" "$text")
      ;;
    *)
      echo "ERROR: Unknown message type: $msg_type" >&2
      return 1
      ;;
  esac

  _outbox_append "$json_msg"
  echo "QUEUED|$target|$msg_type"
}

# harness_note — Broadcast a note to harnesses matching tags or scope.
# Usage: harness_note <type> <topic_or_content> [content] [--tags "a,b"] [--to "target"] [--scope "module|all"]
harness_note() {
  local msg_type="${1:?Usage: harness_note <type> <topic> [content] [--tags ...] [--to ...] [--scope ...]}"
  local topic="${2:-}"
  local content="${3:-}"
  shift; shift; shift 2>/dev/null || true

  local tags="" to_target="" scope=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --tags) tags="$2"; shift 2 ;;
      --to) to_target="$2"; shift 2 ;;
      --scope) scope="$2"; shift 2 ;;
      *) shift ;;
    esac
  done

  local sidecar="${SIDECAR_NAME:?SIDECAR_NAME must be set}"
  local timestamp
  timestamp=$(date -u '+%Y-%m-%dT%H:%M:%SZ')

  # Build the "to" field
  local to_json=""
  if [ -n "$to_target" ]; then
    to_json="\"$to_target\""
  elif [ -n "$scope" ]; then
    to_json="{\"scope\":\"$scope\"}"
  elif [ -n "$tags" ]; then
    local tags_json
    tags_json=$(echo "$tags" | tr ',' '\n' | python3 -c "import sys,json; print(json.dumps([l.strip() for l in sys.stdin if l.strip()]))")
    to_json="{\"tags\":$tags_json}"
  else
    to_json="{\"scope\":\"module\"}"
  fi

  local json_msg
  json_msg=$(python3 -c "
import json, sys
to_raw = sys.argv[5]
try:
    to_val = json.loads(to_raw)
except:
    to_val = to_raw
msg = {
    'ts': sys.argv[1], 'from': sys.argv[2], 'type': sys.argv[3],
    'to': to_val, 'topic': sys.argv[4], 'content': sys.argv[6], 'routed': False
}
print(json.dumps(msg))" "$timestamp" "$sidecar" "$msg_type" "$topic" "$to_json" "${content:-$topic}")

  _outbox_append "$json_msg"
  echo "BROADCAST|$msg_type|$topic"
}
