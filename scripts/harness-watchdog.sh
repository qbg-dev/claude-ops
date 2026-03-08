#!/usr/bin/env bash
# harness-watchdog.sh — Monitor flat workers via registry.json; detect crashes, stuck, sleep-respawn.
#
# Window-group aware: reads "window" from registry to place respawned workers
# into their correct tmux window (split + tiled layout).
#
# Runs as a background daemon (via launchd or cron).
# Every CHECK_INTERVAL seconds:
#   1. Read registry.json for all workers with pane_id set
#   2. For each: check pane alive, classify state
#   3. Classify: alive+active | alive+stuck | graceful-sleep | dead (crash)
#   4. Stuck → kill Claude process + resume in same pane
#   5. Sleep complete → kill + resume with fresh seed
#   6. Dead pane, window exists → split-window + re-tile + relaunch
#   7. Dead pane, window gone → launch-flat-worker.sh (recreates everything)
#   8. Crash-loop guard: max MAX_CRASHES_PER_HR → stop retrying, notify
#
# Usage:
#   bash harness-watchdog.sh              # daemon mode (loops forever)
#   bash harness-watchdog.sh --once       # single-pass (for testing)
#   bash harness-watchdog.sh --status     # print current state table and exit
#
# Requirements:
#   - registry.json populated by launch-flat-worker.sh at startup

set -euo pipefail

CLAUDE_OPS_DIR="${CLAUDE_OPS_DIR:-$HOME/.claude-ops}"
source "$CLAUDE_OPS_DIR/lib/resolve-deps.sh"

# ── Config ──────────────────────────────────────────────────────
CHECK_INTERVAL="${WATCHDOG_CHECK_INTERVAL:-30}"
STUCK_THRESHOLD_SEC="${WATCHDOG_STUCK_THRESHOLD:-600}"  # 10 min no activity = stuck
MAX_CRASHES_PER_HR="${WATCHDOG_MAX_CRASHES:-3}"
LOG_FILE="${WATCHDOG_LOG:-${HOME}/.claude-ops/state/watchdog.log}"

PROJECT_ROOT="${PROJECT_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || { echo "ERROR: PROJECT_ROOT not set and not in a git repo" >&2; exit 1; })}"
REGISTRY="$PROJECT_ROOT/.claude/workers/registry.json"
CRASH_DIR="${HOME}/.claude-ops/state/watchdog-crashes"
RUNTIME_DIR="${HOME}/.claude-ops/state/watchdog-runtime"
LAUNCH_SCRIPT="${HOME}/.claude-ops/scripts/launch-flat-worker.sh"

MODE="daemon"
[ "${1:-}" = "--once" ]   && MODE="once"
[ "${1:-}" = "--status" ] && MODE="status"

# ── Logging ─────────────────────────────────────────────────────
mkdir -p "$(dirname "$LOG_FILE")" "$CRASH_DIR" "$RUNTIME_DIR"
_log() {
  local _m="[$(date -u +%FT%TZ)] watchdog: $*"
  echo "$_m" >> "$LOG_FILE"
  # Only echo to stderr when running in a terminal (launchd stderr → same LOG_FILE = duplicates)
  [ -t 2 ] && echo "$_m" >&2 || true
}

# ── Crash count management ────────────────────────────────────────
_crash_count_file() { echo "$CRASH_DIR/$1.json"; }

_increment_crash_count() {
  local worker="$1"
  local f; f=$(_crash_count_file "$worker")
  local now_ts; now_ts=$(date -u +%s)
  local hour_ago=$(( now_ts - 3600 ))

  local existing="[]"
  [ -f "$f" ] && existing=$(jq '.timestamps // []' "$f" 2>/dev/null || echo "[]")

  local updated
  updated=$(echo "$existing" | jq --argjson now "$now_ts" --argjson cutoff "$hour_ago" \
    '[.[] | select(. > $cutoff)] + [$now]')
  echo "{\"timestamps\":$updated}" > "$f"
  echo "$updated" | jq 'length'
}

_is_crash_looped() {
  local worker="$1"
  [ -f "$CRASH_DIR/${worker}.crash-loop" ]
}

# ── Registry lock helpers (atomic mkdir-based, shared with fleet MCP) ──
_REG_LOCK="${HARNESS_LOCK_DIR:-${HOME}/.claude-ops/state/locks}/worker-registry"
_lock_registry() {
  mkdir -p "$(dirname "$_REG_LOCK")" 2>/dev/null || true
  local _w=0
  while ! mkdir "$_REG_LOCK" 2>/dev/null; do
    sleep 0.5; _w=$((_w+1)); [ "$_w" -ge 10 ] && break
  done
}
_unlock_registry() { rmdir "$_REG_LOCK" 2>/dev/null || true; }

# ── Locked jq update on registry.json ──
# Usage: _registry_jq_update '.[$n].status = "inactive"' --arg n "$worker"
_registry_jq_update() {
  local _filter="$1"; shift
  _lock_registry
  local _tmp; _tmp=$(mktemp)
  jq "$_filter" "$@" "$REGISTRY" > "$_tmp" 2>/dev/null && mv "$_tmp" "$REGISTRY" || rm -f "$_tmp"
  _unlock_registry
}

# ── Worker runtime dir (per-worker state for stuck detection) ──────
_worker_runtime() {
  local dir="$RUNTIME_DIR/$1"
  mkdir -p "$dir" 2>/dev/null || true
  echo "$dir"
}

# ── Extract session ID from registry or pane scrollback ───────────
_get_session_id() {
  local worker="$1" pane_id="$2"

  # Try registry first
  local sid
  sid=$(jq -r --arg n "$worker" '.[$n].session_id // empty' "$REGISTRY" 2>/dev/null || echo "")
  [ -n "$sid" ] && [ "$sid" != "null" ] && { echo "$sid"; return; }

  # Fall back to scrollback — look for the transcript .jsonl filename
  sid=$(tmux capture-pane -t "$pane_id" -p 2>/dev/null \
    | grep -oE '[a-f0-9-]{36}\.jsonl' | tail -1 | sed 's/\.jsonl//')
  [ -n "$sid" ] && { echo "$sid"; return; }

  echo ""
}

# ── CPU-based activity check ──────────────────────────────────────
# Returns 0 (true) if the pane's process tree is actively consuming CPU.
# This catches long thinking phases where Claude is computing but no hooks fire.
_is_pane_process_busy() {
  local pane_id="$1"
  local pane_pid
  pane_pid=$(tmux list-panes -a -F '#{pane_id} #{pane_pid}' 2>/dev/null | awk -v p="$pane_id" '$1==p{print $2}')
  [ -z "$pane_pid" ] && return 1

  # Sum CPU of the pane process and all descendants (node + workers)
  # macOS ps: %cpu is cumulative for each process
  local total_cpu
  total_cpu=$(ps -o %cpu= -g "$pane_pid" 2>/dev/null | awk '{s+=$1} END{printf "%.0f", s}')
  [ -z "$total_cpu" ] && return 1

  # >5% aggregate CPU means the process tree is actively computing
  [ "$total_cpu" -gt 5 ] 2>/dev/null
}

# ── Scrollback-based stuck detection ───────────────────────────────
# Hash the pane content and compare with previous check.
# If content changed → worker is active. If unchanged → idle.
_check_scrollback_stuck() {
  local pane_id="$1" worker="$2" now_ts="$3"
  local runtime; runtime=$(_worker_runtime "$worker")
  local marker="$runtime/stuck-candidate"

  # Capture visible pane content (non-empty lines, last 30)
  local content
  content=$(tmux capture-pane -t "$pane_id" -p 2>/dev/null | grep -v '^$' | tail -30)

  # Known blocking patterns in Claude Code TUI
  if echo "$content" | grep -qE 'Waiting for task|hook error.*hook error|No output.*No output'; then
    if [ ! -f "$marker" ]; then
      echo "$now_ts" > "$marker"
      echo 0  # just started, not stuck yet
      return
    fi
    local since; since=$(cat "$marker" 2>/dev/null || echo "$now_ts")
    echo $(( now_ts - since ))
    return
  fi

  # Idle Claude TUI detection — Claude finished its turn and is at the input prompt.
  # DIFF-BASED: hash scrollback content and compare with previous check.
  local last_line
  last_line=$(echo "$content" | tail -1)
  local hash_file="$runtime/scrollback-hash"

  # Compute hash once (used in both branches)
  local current_hash
  current_hash=$(echo "$content" | md5 2>/dev/null || echo "$content" | md5sum 2>/dev/null | cut -d' ' -f1)
  local prev_hash=""
  [ -f "$hash_file" ] && prev_hash=$(cat "$hash_file" 2>/dev/null)
  echo "$current_hash" > "$hash_file"

  if echo "$last_line" | grep -qF 'bypass permissions'; then
    # Statusline looks idle — use scrollback diff to detect actual activity
    if [ -n "$prev_hash" ] && [ "$current_hash" != "$prev_hash" ]; then
      # Scrollback content changed since last check — worker is active
      rm -f "$marker" 2>/dev/null || true
      echo 0
      return
    fi

    # Content unchanged since last check — genuinely idle
    if [ ! -f "$marker" ]; then
      echo "$now_ts" > "$marker"
      echo 0  # just detected idle, not stuck yet
      return
    fi
    local since; since=$(cat "$marker" 2>/dev/null || echo "$now_ts")
    echo $(( now_ts - since ))
    return
  fi

  # Not matching stuck pattern — clear marker
  rm -f "$marker" 2>/dev/null || true
  echo 0
}

# ── Notify chief-of-staff when a non-perpetual worker has no Claude process ──
# Debounced: only sends once per incident via a flag file.
# Cleared when the worker is confirmed alive again.
_notify_chief_of_staff_dead_worker() {
  local worker="$1" state="$2" detail="${3:-}"
  local runtime; runtime=$(_worker_runtime "$worker")
  local flag="$runtime/cos-notified"

  # Debounce — only notify once per incident
  [ -f "$flag" ] && return

  local cos_inbox="$PROJECT_ROOT/.claude/workers/chief-of-staff/inbox.jsonl"
  [ ! -d "$(dirname "$cos_inbox")" ] && { _log "NOTIFY-COS-ERR: chief-of-staff inbox dir not found"; return; }

  local ts; ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  local content="Worker '${worker}' (pane ${pane_id:-unknown}) has no active Claude process — ${state}. ${detail}Consider calling \`deregister\` to remove it from the registry, or restart it manually."

  jq -n \
    --arg worker "$worker" \
    --arg state "$state" \
    --arg content "$content" \
    --arg ts "$ts" \
    '{to:"worker/chief-of-staff",from:"worker/watchdog",from_name:"watchdog",content:$content,summary:("Worker " + $worker + " offline: " + $state),msg_type:"message",channel:"worker-watchdog",_ts:$ts}' \
    >> "$cos_inbox" 2>/dev/null || { _log "NOTIFY-COS-ERR: failed to append to inbox"; return; }

  touch "$flag"
  _log "NOTIFY-COS: $worker — dead-worker alert sent to chief-of-staff inbox ($state)"
}

# ── Clear chief-of-staff notification flag when worker is alive again ─
_clear_cos_notified() {
  local worker="$1"
  local runtime; runtime=$(_worker_runtime "$worker")
  rm -f "$runtime/cos-notified" 2>/dev/null || true
}

# ── Move a finished non-perpetual worker's pane to "inactive" window ──
_move_to_inactive() {
  local worker="$1" pane_id="$2"
  local session
  session=$(jq -r --arg n "$worker" '.[$n].tmux_session // "w"' "$REGISTRY" 2>/dev/null)
  [ "$session" = "null" ] && session="w"

  local inactive_win="inactive"

  # Create inactive window if it doesn't exist
  if ! tmux list-windows -t "$session" -F '#{window_name}' 2>/dev/null | grep -qxF "$inactive_win"; then
    tmux new-window -t "$session" -n "$inactive_win" -d 2>/dev/null || true
  fi

  # Move the pane (join-pane moves it into the target window)
  tmux join-pane -t "$session:$inactive_win" -s "$pane_id" -d 2>/dev/null || true
  tmux select-layout -t "$session:$inactive_win" tiled 2>/dev/null || true

  # Update registry: clear pane_id so watchdog stops checking
  _registry_jq_update '.[$n].pane_id = "" | .[$n].status = "inactive"' --arg n "$worker"

  _log "INACTIVE: $worker — moved pane $pane_id to $session:$inactive_win"
}

# ── Enforce window placement — move pane to its registered window ───
_enforce_window() {
  local worker="$1" pane_id="$2"

  local target_win
  target_win=$(jq -r --arg n "$worker" '.[$n].window // empty' "$REGISTRY" 2>/dev/null)
  [ -z "$target_win" ] || [ "$target_win" = "null" ] && return  # no window registered

  local session
  session=$(jq -r --arg n "$worker" '.[$n].tmux_session // "w"' "$REGISTRY" 2>/dev/null)
  [ "$session" = "null" ] && session="w"

  # Get current window name for this pane
  local actual_win
  actual_win=$(tmux list-panes -a -F '#{pane_id} #{window_name}' 2>/dev/null \
    | awk -v p="$pane_id" '$1==p{print $2}')

  [ "$actual_win" = "$target_win" ] && return  # already correct

  # Create target window if it doesn't exist
  if ! tmux list-windows -t "$session" -F '#{window_name}' 2>/dev/null | grep -qxF "$target_win"; then
    tmux new-window -t "$session" -n "$target_win" -d 2>/dev/null || true
  fi

  # Move the pane
  tmux join-pane -s "$pane_id" -t "$session:$target_win" -d 2>/dev/null || {
    _log "ENFORCE-WIN-ERR: $worker — failed to move $pane_id from $actual_win to $target_win"
    return
  }
  tmux select-layout -t "$session:$target_win" tiled 2>/dev/null || true

  # Update pane_target in registry
  local new_target
  new_target=$(tmux list-panes -a -F '#{pane_id} #{session_name}:#{window_index}.#{pane_index}' 2>/dev/null \
    | awk -v p="$pane_id" '$1==p{print $2}')
  if [ -n "$new_target" ]; then
    _registry_update_pane "$worker" "$pane_id" "$new_target"
  fi

  _log "ENFORCE-WIN: $worker — moved $pane_id from $actual_win to $target_win"
}

# ── Kill Claude process tree in a pane ─────────────────────────────
_kill_claude_in_pane() {
  local pane_id="$1"
  local pane_pid
  pane_pid=$(tmux list-panes -a -F '#{pane_id} #{pane_pid}' 2>/dev/null \
    | awk -v id="$pane_id" '$1==id{print $2}')
  if [ -n "$pane_pid" ]; then
    pkill -TERM -P "$pane_pid" 2>/dev/null || true
    sleep 2
    pkill -KILL -P "$pane_pid" 2>/dev/null || true
    sleep 1
  fi
}

# ── Build agent command from registry config (Claude or Codex) ─────
_build_agent_cmd() {
  local worker="$1"
  local session_id="${2:-}"

  local model; model=$(jq -r --arg n "$worker" '.[$n].model // "opus"' "$REGISTRY" 2>/dev/null)
  [ "$model" = "null" ] && model="opus"
  local perm_mode; perm_mode=$(jq -r --arg n "$worker" '.[$n].permission_mode // "bypassPermissions"' "$REGISTRY" 2>/dev/null)
  [ "$perm_mode" = "null" ] && perm_mode="bypassPermissions"
  local disallowed; disallowed=$(jq -r --arg n "$worker" '.[$n].disallowed_tools // [] | join(",")' "$REGISTRY" 2>/dev/null)
  local runtime; runtime=$(jq -r --arg n "$worker" '.[$n].custom.runtime // "claude"' "$REGISTRY" 2>/dev/null)
  [ "$runtime" = "null" ] && runtime="claude"
  local effort; effort=$(jq -r --arg n "$worker" '.[$n].custom.reasoning_effort // ""' "$REGISTRY" 2>/dev/null)
  [ "$effort" = "null" ] && effort=""

  local worker_dir="$PROJECT_ROOT/.claude/workers/$worker"

  if [ "$runtime" = "codex" ]; then
    # Codex CLI
    local cmd="codex -m $model"
    if [ "$perm_mode" = "bypassPermissions" ]; then
      cmd="$cmd --dangerously-bypass-approvals-and-sandbox"
    else
      cmd="$cmd -s workspace-write -a on-request"
    fi
    [ -n "$effort" ] && cmd="$cmd -c model_reasoning_effort=$effort"
    cmd="$cmd --no-alt-screen"
    if [ -n "$session_id" ]; then
      # Codex resume uses a separate subcommand
      cmd="codex resume $session_id"
    fi
  else
    # Claude Code CLI (default)
    local cmd="CLAUDE_CODE_SKIP_PROJECT_LOCK=1 WORKER_NAME=$worker claude --model $model"
    [ "$perm_mode" = "bypassPermissions" ] && cmd="$cmd --dangerously-skip-permissions"
    [ -n "$effort" ] && cmd="$cmd --effort $effort"
    [ -n "$disallowed" ] && cmd="$cmd --disallowed-tools \"$disallowed\""
    cmd="$cmd --add-dir $worker_dir"
    [ -n "$session_id" ] && cmd="$cmd --resume $session_id"
  fi

  echo "$cmd"
}

# Backward compat alias
_build_claude_cmd() { _build_agent_cmd "$@"; }

# ── Record a watchdog relaunch in registry ──
_record_relaunch() {
  local worker="$1" reason="$2"
  local _now_iso; _now_iso=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  _registry_jq_update '
    .[$n].watchdog_relaunches = ((.[$n].watchdog_relaunches // 0) + 1) |
    .[$n].last_relaunch = {at: $ts, reason: $r}
  ' --arg n "$worker" --arg ts "$_now_iso" --arg r "$reason"
  # Touch liveness so watchdog doesn't immediately re-detect as stuck
  local _RUNTIME_DIR="${HOME}/.claude-ops/state/watchdog-runtime/${worker}"
  mkdir -p "$_RUNTIME_DIR" 2>/dev/null || true
  date +%s > "$_RUNTIME_DIR/liveness"
}

# ── Resume a worker in its existing pane (unstick or sleep-respawn) ─
_resume_in_pane() {
  local worker="$1" pane_id="$2" reason="$3"
  local worker_dir="$PROJECT_ROOT/.claude/workers/$worker"

  # 1. Get session ID before killing
  local prev_session_id
  prev_session_id=$(_get_session_id "$worker" "$pane_id")

  # 2. Kill existing Claude process
  _kill_claude_in_pane "$pane_id"

  # 3. Prepare seed using shared generator (same as initial launch)
  local seed_file="/tmp/worker-${worker}-respawn.txt"
  local _claude_ops="${HOME}/.claude-ops"
  WORKER_NAME="$worker" PROJECT_ROOT="$PROJECT_ROOT" \
    "$BUN" -e "
      const { generateSeedContent } = await import('${_claude_ops}/mcp/worker-fleet/index.ts');
      process.stdout.write(generateSeedContent());
    " > "$seed_file" 2>/dev/null || {
    echo "Watchdog respawn ($reason). You are worker $worker. Read mission.md, then start your next cycle." > "$seed_file"
  }

  # 4. Record relaunch + touch liveness so next watchdog pass skips
  _record_relaunch "$worker" "$reason"

  # 5. Launch agent (Claude or Codex)
  local agent_cmd
  agent_cmd=$(_build_agent_cmd "$worker" "$prev_session_id")

  # Determine runtime for TUI detection
  local worker_runtime; worker_runtime=$(jq -r --arg n "$worker" '.[$n].custom.runtime // "claude"' "$REGISTRY" 2>/dev/null)
  [ "$worker_runtime" = "null" ] && worker_runtime="claude"

  tmux send-keys -t "$pane_id" "$agent_cmd" 2>/dev/null || true
  tmux send-keys -t "$pane_id" -H 0d 2>/dev/null || true

  if [ -n "$prev_session_id" ]; then
    _log "RESUME: $worker ($worker_runtime) — resuming session $prev_session_id in pane $pane_id (reason: $reason)"
  else
    _log "RESUME: $worker ($worker_runtime) — fresh start in pane $pane_id (reason: $reason)"
  fi

  # 5. Wait for TUI + inject seed (background to not block watchdog)
  (
    sleep 8
    local wait=0
    local tui_ready=false
    # TUI ready pattern differs by runtime
    local tui_pattern="bypass permissions"
    [ "$worker_runtime" = "codex" ] && tui_pattern="codex"

    until tmux capture-pane -t "$pane_id" -p 2>/dev/null | tail -5 | grep -qiF "$tui_pattern"; do
      sleep 3; wait=$((wait + 3))
      if [ "$wait" -ge 60 ]; then
        break
      fi
    done

    # Hard gate: verify TUI is actually ready before pasting seed
    if tmux capture-pane -t "$pane_id" -p 2>/dev/null | tail -5 | grep -qiF "$tui_pattern"; then
      tui_ready=true
    fi

    if [ "$tui_ready" = "false" ]; then
      _log "RESUME-WARN: $worker — TUI not ready after $((wait + 8))s, skipping seed (next watchdog pass will retry)"
      rm -f "$seed_file" 2>/dev/null || true
      return
    fi

    sleep 2

    local buf_name="wd-${pane_id#%}-$$"
    tmux delete-buffer -b "$buf_name" 2>/dev/null || true
    if ! tmux load-buffer -b "$buf_name" "$seed_file" 2>/dev/null; then
      _log "RESUME-ERR: $worker — failed to load seed into tmux buffer"
      rm -f "$seed_file" 2>/dev/null || true
      return
    fi
    tmux paste-buffer -t "$pane_id" -b "$buf_name" -d 2>/dev/null || true
    sleep 1
    tmux send-keys -t "$pane_id" -H 0d 2>/dev/null || true
    # Retry Enter after 3s
    sleep 3
    if tmux capture-pane -t "$pane_id" -p 2>/dev/null | tail -3 | grep -qE '❯'; then
      tmux send-keys -t "$pane_id" -H 0d 2>/dev/null || true
    fi
    rm -f "$seed_file" 2>/dev/null || true
  ) &
}

# ── Registry update helper ────────────────────────────────────────
_registry_update_pane() {
  local worker="$1" pane_id="$2" pane_target="$3"
  _registry_jq_update '.[$n].pane_id = $pid | .[$n].pane_target = $target' \
    --arg n "$worker" --arg pid "$pane_id" --arg target "$pane_target"
}

# ── Re-launch agent in a NEW pane (dead pane respawn) ─────────────
_relaunch_claude() {
  local worker="$1" pane="$2" wt_dir="$3"

  local agent_cmd
  agent_cmd=$(_build_agent_cmd "$worker")

  # Determine runtime for TUI detection
  local worker_runtime; worker_runtime=$(jq -r --arg n "$worker" '.[$n].custom.runtime // "claude"' "$REGISTRY" 2>/dev/null)
  [ "$worker_runtime" = "null" ] && worker_runtime="claude"

  tmux send-keys -t "$pane" "cd $wt_dir"
  tmux send-keys -t "$pane" -H 0d
  sleep 1
  tmux send-keys -t "$pane" "$agent_cmd"
  tmux send-keys -t "$pane" -H 0d

  # Inject seed after TUI starts (background, with TUI gate)
  (
    sleep 10
    local wait=0
    local tui_pattern="bypass permissions on"
    [ "$worker_runtime" = "codex" ] && tui_pattern="codex"

    # Phase 1: Wait for any Claude indicator (including bypass dialog or TUI status bar)
    until tmux capture-pane -t "$pane" -p 2>/dev/null | tail -10 | grep -qiF "bypass permissions"; do
      sleep 3; wait=$((wait + 3))
      [ "$wait" -ge 60 ] && break
    done

    if ! tmux capture-pane -t "$pane" -p 2>/dev/null | tail -10 | grep -qiF "bypass permissions"; then
      _log "RELAUNCH-WARN: $worker — TUI not ready after $((wait + 10))s, skipping seed"
      return
    fi

    # Phase 2: If bypass dialog is showing (not the TUI status bar), auto-accept it
    local pane_bottom
    pane_bottom=$(tmux capture-pane -t "$pane" -p 2>/dev/null | tail -10)
    if echo "$pane_bottom" | grep -qF "Yes, I accept" && ! echo "$pane_bottom" | grep -qF "bypass permissions on"; then
      _log "RELAUNCH-ACCEPT: $worker — auto-accepting bypass dialog"
      tmux send-keys -t "$pane" Down
      sleep 0.5
      tmux send-keys -t "$pane" Enter
      sleep 5
      # Now wait for the actual TUI status bar
      local wait2=0
      until tmux capture-pane -t "$pane" -p 2>/dev/null | tail -5 | grep -qiF "$tui_pattern"; do
        sleep 3; wait2=$((wait2 + 3))
        [ "$wait2" -ge 30 ] && break
      done
    fi

    # Phase 3: Also handle project trust dialog ("Yes, I trust this folder")
    pane_bottom=$(tmux capture-pane -t "$pane" -p 2>/dev/null | tail -10)
    if echo "$pane_bottom" | grep -qF "I trust this folder"; then
      _log "RELAUNCH-TRUST: $worker — auto-accepting project trust dialog"
      tmux send-keys -t "$pane" Enter
      sleep 5
    fi

    if ! tmux capture-pane -t "$pane" -p 2>/dev/null | tail -5 | grep -qiF "$tui_pattern"; then
      _log "RELAUNCH-WARN: $worker — TUI ready check failed after dialogs, skipping seed"
      return
    fi

    sleep 2
    local seed_file="/tmp/worker-${worker}-watchdog-seed.txt"
    local _claude_ops="${HOME}/.claude-ops"
    WORKER_NAME="$worker" PROJECT_ROOT="$PROJECT_ROOT" \
      "$BUN" -e "
        const { generateSeedContent } = await import('${_claude_ops}/mcp/worker-fleet/index.ts');
        process.stdout.write(generateSeedContent());
      " > "$seed_file" 2>/dev/null || {
      echo "You are worker $worker. Read mission.md, then start your next cycle." > "$seed_file"
    }

    local buf="watchdog-${worker}-$$"
    tmux delete-buffer -b "$buf" 2>/dev/null || true
    tmux load-buffer -b "$buf" "$seed_file" 2>/dev/null || true
    tmux paste-buffer -b "$buf" -t "$pane" -d 2>/dev/null || true
    sleep 4
    tmux send-keys -t "$pane" -H 0d
    rm -f "$seed_file"
  ) &
}

# ── Check a single worker ──────────────────────────────────────────
check_worker() {
  local worker="$1"

  # Skip _config key
  [ "$worker" = "_config" ] && return

  # Batch-read all needed fields in one jq call (avoids 7+ subprocess spawns per worker)
  local _fields
  _fields=$(jq -r --arg n "$worker" '.[$n] | [
    (.pane_id // ""),
    (.perpetual // false | tostring),
    (.status // "idle"),
    (.sleep_duration // 0 | tostring),
    (.window // ""),
    (.tmux_session // "w"),
    (.worktree // "")
  ] | join("\t")' "$REGISTRY" 2>/dev/null) || return

  local pane_id perpetual status sleep_dur window session worktree
  IFS=$'\t' read -r pane_id perpetual status sleep_dur window session worktree <<< "$_fields"
  [ "$sleep_dur" = "null" ] && sleep_dur=0

  # Skip workers in standby mode — they're intentionally dormant
  if [ "$status" = "standby" ]; then
    return
  fi

  # ── Sleeping workers: deferred recycle — watchdog owns the respawn timer ──
  # When a perpetual worker calls recycle() with sleep_duration > 0,
  # the MCP sets status="sleeping" and custom.sleep_until=<ISO timestamp>.
  # The recycle script kills the session but does NOT relaunch.
  # Watchdog waits until sleep_until passes, then relaunches.
  if [ "$status" = "sleeping" ]; then
    local sleep_until
    sleep_until=$(jq -r --arg n "$worker" '.[$n].custom.sleep_until // empty' "$REGISTRY" 2>/dev/null)
    if [ -n "$sleep_until" ] && [ "$sleep_until" != "null" ]; then
      local now_ts; now_ts=$(date -u +%s)
      local wake_ts
      wake_ts=$(date -j -u -f "%Y-%m-%dT%H:%M:%S" "${sleep_until%%.*}" +%s 2>/dev/null || echo 0)
      if [ "$wake_ts" -gt 0 ] && [ "$now_ts" -lt "$wake_ts" ]; then
        # Still sleeping — skip this worker
        return
      fi
      # Sleep complete — clear sleeping status and relaunch
      _log "WAKE: $worker — sleep_until ($sleep_until) reached, waking up"
      _registry_jq_update '.[$n].status = "active" | .[$n].custom.sleep_until = null' --arg n "$worker"
    else
      # No sleep_until set but status is sleeping — clear it
      _registry_jq_update '.[$n].status = "active"' --arg n "$worker"
    fi
    # Fall through to normal pane checks — the worker needs relaunching
  fi

  # No pane registered: launch perpetual workers, skip non-perpetual
  if [ -z "$pane_id" ]; then
    if [ "$perpetual" = "true" ]; then
      _is_crash_looped "$worker" && return
      _log "NO-PANE: $worker — perpetual worker has no pane_id, launching via launch-flat-worker.sh"
      _record_relaunch "$worker" "no-pane"
      PROJECT_ROOT="$PROJECT_ROOT" bash "$LAUNCH_SCRIPT" "$worker" &
      return 1  # signal respawn happened (for stagger)
    fi
    return  # non-perpetual with no pane — skip
  fi

  # Skip crash-looped workers
  _is_crash_looped "$worker" && return

  local now_ts; now_ts=$(date -u +%s)

  # ── Check pane alive ──
  local pane_alive=false
  if tmux list-panes -a -F '#{pane_id}' 2>/dev/null | grep -qxF "$pane_id"; then
    pane_alive=true
  fi

  if $pane_alive; then
    # ── Pane alive — enforce correct window placement ──
    _enforce_window "$worker" "$pane_id"

    # ── Pane alive — check for graceful sleep or stuck ──

    # Quick check: liveness heartbeat file (touched by PostToolUse + UserPromptSubmit hooks)
    local runtime; runtime=$(_worker_runtime "$worker")
    local liveness_file="$runtime/liveness"

    # Relaunch cooldown: if last relaunch was < 120s ago, skip entirely.
    # Prevents respawn-detection-respawn loop when Claude takes 30-60s to start.
    local _last_relaunch_ts
    _last_relaunch_ts=$(jq -r --arg n "$worker" '.[$n].last_relaunch.at // empty' "$REGISTRY" 2>/dev/null || echo "")
    if [ -n "$_last_relaunch_ts" ] && [ "$_last_relaunch_ts" != "null" ]; then
      local _relaunch_epoch
      _relaunch_epoch=$(date -j -u -f "%Y-%m-%dT%H:%M:%SZ" "$_last_relaunch_ts" +%s 2>/dev/null || echo 0)
      local _since_relaunch=$(( now_ts - _relaunch_epoch ))
      if [ "$_since_relaunch" -lt 120 ]; then
        return  # within relaunch cooldown
      fi
    fi

    if [ -f "$liveness_file" ]; then
      local last_active
      last_active=$(cat "$liveness_file" 2>/dev/null || echo "0")
      # Guard against non-numeric content in liveness file
      if ! [[ "$last_active" =~ ^[0-9]+$ ]]; then
        # Fix corrupt liveness file
        echo "$now_ts" > "$liveness_file"
        return
      fi
      local since_active=$(( now_ts - last_active ))
      if [ "$since_active" -lt 300 ]; then
        # Active within last 300s — not stuck. Opus models can think for 2-4 min
        # without firing PostToolUse hooks, so 60s was too aggressive.
        rm -f "$runtime/stuck-candidate" 2>/dev/null || true
        _clear_cos_notified "$worker"
        return
      fi
    else
      # No liveness file at all — this is the first watchdog check for this worker.
      # Seed the file so the sleep-complete logic can measure idle time.
      echo "$now_ts" > "$liveness_file"
      _log "LIVENESS-SEED: $worker — created initial liveness file"
      return
    fi

    # ── CPU activity gate ──
    # If the pane process tree is actively consuming CPU, the agent is thinking.
    # Skip all heuristic checks (bare-shell, scrollback) — it's working.
    if _is_pane_process_busy "$pane_id"; then
      rm -f "$(_worker_runtime "$worker")/stuck-candidate" 2>/dev/null || true
      _clear_cos_notified "$worker"
      return
    fi

    # ── Bare-shell detection (soft crash loop guard) ──
    # If pane is alive but Claude TUI never started, we have a failed respawn
    local full_pane_content
    full_pane_content=$(tmux capture-pane -t "$pane_id" -p 2>/dev/null | grep -v '^$' | tail -30)
    # Match Claude TUI indicators: status bar, thinking spinners (Osmosing/Booping/etc),
    # action verbs, bypass dialog, or the input prompt (❯)
    if ! echo "$full_pane_content" | grep -qiE 'bypass permissions|thinking|Osmosing|Booping|Garnishing|Reading|Searching|Editing|Writing|Running|Worked for|esc to interrupt|❯ $'; then
      # No Claude TUI indicators at all — likely bare shell from failed respawn
      if [ "$perpetual" = "true" ]; then
        _log "BARE-SHELL: $worker (pane $pane_id) — Claude not running, clean restart"
        _record_relaunch "$worker" "bare-shell"
        _kill_claude_in_pane "$pane_id"
        sleep 5
        local wt_dir
        wt_dir=$(jq -r --arg n "$worker" '.[$n].worktree // empty' "$REGISTRY" 2>/dev/null)
        _relaunch_claude "$worker" "$pane_id" "${wt_dir:-$PROJECT_ROOT}"
        return 1  # signal respawn happened (for stagger)
      else
        _log "BARE-SHELL-NONPERP: $worker (pane $pane_id) — no Claude TUI, moving to inactive"
        _move_to_inactive "$worker" "$pane_id"
        _notify_chief_of_staff_dead_worker "$worker" "bare-shell → inactive" "Pane moved to inactive window. "
      fi
    else
      # Claude TUI is present — clear any stale cos-notified flag
      _clear_cos_notified "$worker"
    fi

    # Check for graceful sleep (perpetual worker waiting for sleep_duration)
    # Uses liveness file timestamp as "last active" signal
    if [ "$perpetual" = "true" ] && [ "$sleep_dur" -gt 0 ] 2>/dev/null; then
      local _liveness_file="${HOME}/.claude-ops/state/watchdog-runtime/${worker}/liveness"
      if [ -f "$_liveness_file" ]; then
        local _last_active
        _last_active=$(cat "$_liveness_file" 2>/dev/null || echo 0)
        if [ "$_last_active" -gt 0 ] 2>/dev/null; then
          local _idle_since=$(( now_ts - _last_active ))
          if [ "$_idle_since" -ge "$sleep_dur" ]; then
            _log "RESPAWN: $worker — sleep done (idle ${_idle_since}s of ${sleep_dur}s)"
            _resume_in_pane "$worker" "$pane_id" "sleep-complete (${_idle_since}s of ${sleep_dur}s)"
            local runtime; runtime=$(_worker_runtime "$worker")
            rm -f "$runtime/stuck-candidate" 2>/dev/null || true
            return 1  # signal respawn happened (for stagger)
          fi
          # Still within sleep window — don't treat as stuck
          return
        fi
      fi
    fi

    # ── Stuck detection (scrollback diff) ──
    local idle_sec
    idle_sec=$(_check_scrollback_stuck "$pane_id" "$worker" "$now_ts")

    # For perpetual workers, use sleep_duration as threshold if shorter
    local effective_threshold="$STUCK_THRESHOLD_SEC"
    if [ "$perpetual" = "true" ] && [ "$sleep_dur" -gt 0 ] 2>/dev/null; then
      [ "$sleep_dur" -lt "$effective_threshold" ] && effective_threshold="$sleep_dur"
    fi

    if [ "$idle_sec" -gt "$effective_threshold" ]; then
      _log "STUCK: $worker (pane $pane_id) — ${idle_sec}s since last activity"
      if [ "$perpetual" = "true" ]; then
        _resume_in_pane "$worker" "$pane_id" "stuck ${idle_sec}s"
        notify "⚠️ $worker was stuck ${idle_sec}s — killed and respawned" "Watchdog" 2>/dev/null || true
        # Clear stuck marker
        local runtime; runtime=$(_worker_runtime "$worker")
        rm -f "$runtime/stuck-candidate" 2>/dev/null || true
        return 1  # signal respawn happened (for stagger)
      else
        _log "SKIP: $worker — stuck but perpetual:false, not respawning"
      fi
    fi
    return 0
  fi

  # ── Pane is dead ──

  # Non-perpetual workers: clear pane_id + mark inactive, notify chief-of-staff
  if [ "$perpetual" != "true" ]; then
    _log "DEAD-NONPERP: $worker (pane $pane_id) — marking inactive"
    _registry_jq_update '.[$n].pane_id = "" | .[$n].status = "inactive"' --arg n "$worker"
    _notify_chief_of_staff_dead_worker "$worker" "dead → inactive" "Pane $pane_id no longer exists. "
    return
  fi

  _log "DEAD: $worker (pane $pane_id)"

  # Crash-loop guard
  local crash_count; crash_count=$(_increment_crash_count "$worker")
  if [ "$crash_count" -ge "$MAX_CRASHES_PER_HR" ]; then
    touch "$CRASH_DIR/${worker}.crash-loop"
    _log "CRASH-LOOP: $worker — ${crash_count} crashes in last hour, stopping retries"
    notify "Crash loop: $worker (${crash_count} crashes/hr) — manual intervention needed" "Watchdog Alert" 2>/dev/null || true
    return
  fi

  # window, session, worktree already batch-read above

  # Check if tmux session exists at all
  if ! tmux has-session -t "$session" 2>/dev/null; then
    _log "RESPAWN-FULL: $worker — session '$session' gone, using launch-flat-worker.sh"
    _record_relaunch "$worker" "session-gone"
    PROJECT_ROOT="$PROJECT_ROOT" bash "$LAUNCH_SCRIPT" "$worker" &
    return 1  # signal respawn happened (for stagger)
  fi

  # Check if the window still exists
  if [ -n "$window" ] && tmux list-windows -t "$session" -F '#{window_name}' 2>/dev/null | grep -qxF "$window"; then
    # Window exists — split into it + re-tile
    local new_pane
    local wt_dir="${worktree:-$PROJECT_ROOT}"
    new_pane=$(tmux split-window -t "$session:$window" -c "$wt_dir" -d -P -F '#{pane_id}')
    tmux select-layout -t "$session:$window" tiled
    tmux select-pane -T "$worker" -t "$new_pane"

    # Update registry with new pane info
    local new_target; new_target=$(tmux list-panes -a -F '#{pane_id} #{session_name}:#{window_index}.#{pane_index}' \
      | awk -v p="$new_pane" '$1==p{print $2}' 2>/dev/null || echo "")
    _registry_update_pane "$worker" "$new_pane" "$new_target"

    # Re-launch Claude in the new pane
    _record_relaunch "$worker" "dead-pane-split"
    _relaunch_claude "$worker" "$new_pane" "$wt_dir"

    _log "RESPAWN-SPLIT: $worker into window '$window' (pane $new_pane)"
    return 1  # signal respawn happened (for stagger)
  else
    # Window gone — full relaunch via launch-flat-worker.sh
    _log "RESPAWN-FULL: $worker — window '$window' gone, using launch-flat-worker.sh"
    _record_relaunch "$worker" "window-gone"
    PROJECT_ROOT="$PROJECT_ROOT" bash "$LAUNCH_SCRIPT" "$worker" &
    return 1  # signal respawn happened (for stagger)
  fi
}

# ── Status display ────────────────────────────────────────────────
print_status() {
  [ ! -f "$REGISTRY" ] && { echo "No registry found at $REGISTRY"; return; }

  local now_ts; now_ts=$(date -u +%s)
  printf "%-25s %-10s %-15s %-10s %-15s\n" "WORKER" "PANE" "WINDOW" "STATE" "IDLE"
  printf "%-25s %-10s %-15s %-10s %-15s\n" "------" "----" "------" "-----" "----"

  while IFS= read -r worker; do
    [ "$worker" = "_config" ] && continue
    local pane_id; pane_id=$(jq -r --arg n "$worker" '.[$n].pane_id // "-"' "$REGISTRY" 2>/dev/null)
    local window; window=$(jq -r --arg n "$worker" '.[$n].window // "-"' "$REGISTRY" 2>/dev/null)
    local perpetual; perpetual=$(jq -r --arg n "$worker" '.[$n].perpetual // false' "$REGISTRY" 2>/dev/null)

    local state="no-pane"
    local idle_str="-"
    if [ "$pane_id" != "-" ] && [ "$pane_id" != "null" ] && [ -n "$pane_id" ]; then
      if tmux list-panes -a -F '#{pane_id}' 2>/dev/null | grep -qxF "$pane_id"; then
        state="alive"
        # Check idle time from stuck marker
        local runtime; runtime=$(_worker_runtime "$worker")
        if [ -f "$runtime/stuck-candidate" ]; then
          local since; since=$(cat "$runtime/stuck-candidate" 2>/dev/null || echo "$now_ts")
          idle_str="$(( now_ts - since ))s"
        fi
      else
        state="dead"
      fi
    fi

    _is_crash_looped "$worker" && state="CRASH-LOOP"
    [ "$perpetual" = "true" ] && state="${state}+perp"

    printf "%-25s %-10s %-15s %-10s %-15s\n" "$worker" "${pane_id:-n/a}" "${window:-n/a}" "$state" "$idle_str"
  done < <(jq -r 'keys[]' "$REGISTRY" 2>/dev/null || true)
}

# ── Main loop ─────────────────────────────────────────────────────
_log "Watchdog starting (mode=$MODE, interval=${CHECK_INTERVAL}s, stuck=${STUCK_THRESHOLD_SEC}s)"

if [ "$MODE" = "status" ]; then
  print_status
  exit 0
fi

run_once() {
  [ ! -f "$REGISTRY" ] && return

  # Collect known workers for stale file cleanup
  local known_workers
  known_workers=$(jq -r 'keys[]' "$REGISTRY" 2>/dev/null | grep -v '^_config$' || true)

  while IFS= read -r worker; do
    if ! check_worker "$worker" 2>/dev/null; then
      # Respawn happened — stagger before processing next worker
      local stagger=$(( RANDOM % 10 + 8 ))
      _log "STAGGER: sleeping ${stagger}s after respawning $worker"
      sleep "$stagger"
    fi
  done <<< "$known_workers"

  # Prune stale crash counters + runtime dirs for deregistered workers
  for f in "$CRASH_DIR"/*.json; do
    [ ! -f "$f" ] && continue
    local name; name=$(basename "$f" .json)
    if ! echo "$known_workers" | grep -qxF "$name"; then
      rm -f "$f" 2>/dev/null
    fi
  done
  for d in "$RUNTIME_DIR"/*/; do
    [ ! -d "$d" ] && continue
    local name; name=$(basename "$d")
    if ! echo "$known_workers" | grep -qxF "$name"; then
      rm -rf "$d" 2>/dev/null
    fi
  done
}

if [ "$MODE" = "once" ]; then
  run_once
  _log "Single-pass complete"
  exit 0
fi

# Daemon mode
while true; do
  run_once
  sleep "$CHECK_INTERVAL"
done
