#!/usr/bin/env bash
# worker-watchdog.sh — Monitor registered harness agents; detect crashes vs graceful stops.
#
# Runs as a background daemon (via launchd or cron).
# Every CHECK_INTERVAL seconds:
#   1. Read registry.json (project) + pane-registry.json (legacy) for all registered agents
#   2. For each: check pane alive, Claude process alive, last tool-call event time
#   3. Classify: graceful_sleep | awake | stuck | crashed
#   4. Publish agent.* bus events
#   5. Respawn crashed agents via harness-launch.sh
#   6. Crash-loop guard: max MAX_CRASHES_PER_HR crashes → stop retrying, notify operator
#
# Usage:
#   bash worker-watchdog.sh              # daemon mode (loops forever)
#   bash worker-watchdog.sh --once       # single-pass (for testing)
#   bash worker-watchdog.sh --status     # print current state table and exit
#
# Requirements:
#   - PROJECT_ROOT set (or auto-detected via git)
#   - .claude/workers/registry.json (project) or pane-registry.json (legacy) populated at startup
#   - ~/.claude-ops/lib/fleet-jq.sh + event-bus.sh available
#
# Crash-loop file: ~/.claude-ops/state/harness-runtime/{canonical}/crash-loop
# Crash count file: ~/.claude-ops/state/harness-runtime/{canonical}/crash-count.json

set -euo pipefail

# ── Config ──────────────────────────────────────────────────────
CHECK_INTERVAL="${WATCHDOG_CHECK_INTERVAL:-30}"
STUCK_THRESHOLD_SEC="${WATCHDOG_STUCK_THRESHOLD:-1200}"  # 20 min no activity = stuck
MAX_CRASHES_PER_HR="${WATCHDOG_MAX_CRASHES:-3}"
LOG_FILE="${WATCHDOG_LOG:-${HOME}/.claude-ops/state/watchdog.log}"

# git rev-parse fails if cwd is not in a repo (e.g. watchdog started by launchd from /).
# Hardcode the default project root; override via env if needed.
PROJECT_ROOT="${PROJECT_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
source "${HOME}/.claude-ops/lib/fleet-jq.sh"
source "${HOME}/.claude-ops/lib/event-bus.sh" 2>/dev/null || true

MODE="daemon"
[ "${1:-}" = "--once" ]   && MODE="once"
[ "${1:-}" = "--status" ] && MODE="status"

# ── Logging ─────────────────────────────────────────────────────
_log() { echo "[$(date -u +%FT%TZ)] watchdog: $*" | tee -a "$LOG_FILE" >&2; }

mkdir -p "$(dirname "$LOG_FILE")"

# ── Bus publish helper (no-op if bus disabled) ───────────────────
_publish_agent_event() {
  local event_type="$1" canonical="$2" msg="$3"
  bus_publish "$event_type" \
    --arg canonical "$canonical" \
    --arg msg "$msg" \
    '{"canonical":$canonical,"message":$msg}' 2>/dev/null || true
}

# ── Crash count management ────────────────────────────────────────
_crash_count_file() {
  local canonical="$1"
  echo "$(harness_runtime "$canonical")/crash-count.json"
}

_increment_crash_count() {
  local canonical="$1"
  local f; f=$(_crash_count_file "$canonical")
  local now_ts; now_ts=$(date -u +%s)
  local hour_ago=$(( now_ts - 3600 ))

  # Read existing timestamps, filter to last hour, append current
  local existing="[]"
  [ -f "$f" ] && existing=$(jq '.timestamps // []' "$f" 2>/dev/null || echo "[]")

  local updated
  updated=$(echo "$existing" | jq --argjson now "$now_ts" --argjson cutoff "$hour_ago" \
    '[.[] | select(. > $cutoff)] + [$now]')
  echo "{\"timestamps\":$updated}" > "$f"

  # Return crash count in last hour
  echo "$updated" | jq 'length'
}

_crash_count_last_hr() {
  local canonical="$1"
  local f; f=$(_crash_count_file "$canonical")
  [ ! -f "$f" ] && echo 0 && return
  local now_ts; now_ts=$(date -u +%s)
  local hour_ago=$(( now_ts - 3600 ))
  jq --argjson cutoff "$hour_ago" '[.timestamps[] | select(. > $cutoff)] | length' "$f" 2>/dev/null || echo 0
}

# ── Last tool-call time from bus ──────────────────────────────────
_last_tool_call_sec() {
  local canonical="$1"
  local bus_stream="$PROJECT_ROOT/.claude/bus/stream.jsonl"
  [ ! -f "$bus_stream" ] && echo 0 && return

  # Find the most recent tool-call event for this canonical
  local last_ts
  last_ts=$(grep '"tool-call"' "$bus_stream" 2>/dev/null \
    | grep "\"$canonical\"" \
    | tail -1 \
    | jq -r '._ts // empty' 2>/dev/null || echo "")

  [ -z "$last_ts" ] && echo 0 && return
  iso_to_epoch "$last_ts"
}

# ── Scrollback-based stuck detection (flat workers fallback) ──────
# When bus events aren't available (flat workers), check tmux pane
# content for known blocking patterns. Uses a marker file to track
# how long the pattern has persisted.
_check_scrollback_stuck() {
  local pane_id="$1" canonical="$2" now_ts="$3"
  local runtime; runtime=$(harness_runtime "$canonical")
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
  # The status line shows "⏵⏵ bypass permissions" without "(running)".
  #
  # DIFF-BASED activity detection: instead of fragile pattern matching,
  # hash the scrollback content and compare with previous check.
  # If content changed → worker is active (new output, thinking, tools).
  # If content unchanged → genuinely idle.
  # This eliminates false positives from completed-turn indicators like
  # "✻ Worked for 52s" which look like active spinners but are static.
  if [[ "$canonical" == worker/* ]]; then
    local last_line
    last_line=$(echo "$content" | tail -1)
    local hash_file="$runtime/scrollback-hash"

    if echo "$last_line" | grep -qF 'bypass permissions' && ! echo "$last_line" | grep -qF '(running)'; then
      # Statusline looks idle — use scrollback diff to detect actual activity
      local current_hash
      current_hash=$(echo "$content" | md5 2>/dev/null || echo "$content" | md5sum 2>/dev/null | cut -d' ' -f1)

      local prev_hash=""
      [ -f "$hash_file" ] && prev_hash=$(cat "$hash_file" 2>/dev/null)
      echo "$current_hash" > "$hash_file"

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
    else
      # Worker not at idle statusline — update hash for next comparison
      local current_hash
      current_hash=$(echo "$content" | md5 2>/dev/null || echo "$content" | md5sum 2>/dev/null | cut -d' ' -f1)
      echo "$current_hash" > "$hash_file"
    fi
  fi

  # Not matching stuck pattern — clear marker
  rm -f "$marker" 2>/dev/null || true
  echo 0
}

# ── Extract session ID from pane scrollback or registry ───────────
_get_session_id() {
  local pane_id="$1"
  local sid=""

  # Try project registry.json first (worker panes)
  local proj_registry="$PROJECT_ROOT/.claude/workers/registry.json"
  if [ -f "$proj_registry" ]; then
    sid=$(jq -r --arg pid "$pane_id" 'to_entries[] | select(.key != "_config") | select(.value.pane_id == $pid) | .value.session_id // empty' "$proj_registry" 2>/dev/null | head -1 || echo "")
    [ -n "$sid" ] && [ "$sid" != "null" ] && [ "$sid" != "none" ] && { echo "$sid"; return; }
  fi

  # Fall back to legacy pane registry
  sid=$(jq -r --arg p "$pane_id" '.[$p].session_id // empty' "$PANE_REGISTRY" 2>/dev/null || echo "")
  [ -n "$sid" ] && [ "$sid" != "null" ] && [ "$sid" != "none" ] && { echo "$sid"; return; }

  # Fall back to scrollback — look for the transcript .jsonl filename
  sid=$(tmux capture-pane -t "$pane_id" -p 2>/dev/null \
    | grep -oE '[a-f0-9-]{36}\.jsonl' | tail -1 | sed 's/\.jsonl//')
  [ -n "$sid" ] && { echo "$sid"; return; }

  echo ""
}

# ── Build Claude command from worker config ───────────────────────
# Reads registry.json to construct the full CLI command,
# optionally with --resume <session_id> for context recovery.
_build_claude_cmd() {
  local worker_name="$1"
  local session_id="${2:-}"   # optional: resume this session
  local worker_dir="$PROJECT_ROOT/.claude/workers/$worker_name"
  local registry="$PROJECT_ROOT/.claude/workers/registry.json"

  # Read model from registry.json (with runtime cache fallback for macOS TCC)
  local cache="$HARNESS_STATE_DIR/harness-runtime/worker/$worker_name/config-cache.json"
  local model
  model=$(jq -r --arg n "$worker_name" '.[$n].model // empty' "$registry" 2>/dev/null)
  [ -z "$model" ] && model=$(jq -r '.model // empty' "$cache" 2>/dev/null)
  [ -z "$model" ] && model="opus"

  # Read permission_mode from registry.json (with runtime cache fallback)
  local perm_mode
  perm_mode=$(jq -r --arg n "$worker_name" '.[$n].permission_mode // empty' "$registry" 2>/dev/null)
  [ -z "$perm_mode" ] && perm_mode=$(jq -r '.permission_mode // empty' "$cache" 2>/dev/null)
  [ -z "$perm_mode" ] && perm_mode="bypassPermissions"

  # Build base command
  local cmd="claude --model $model"

  # Permission mode
  if [ "$perm_mode" = "bypassPermissions" ]; then
    cmd="$cmd --dangerously-skip-permissions"
  fi

  # Add worker config directory
  cmd="$cmd --add-dir $worker_dir"

  # Resume session if provided
  if [ -n "$session_id" ]; then
    cmd="$cmd --resume $session_id"
  fi

  echo "$cmd"
}

# ── Get window name for a worker (from project registry or legacy pane-registry) ──
_get_worker_window() {
  local pane_id="$1"
  local proj_registry="$PROJECT_ROOT/.claude/workers/registry.json"
  local win=""
  # Try project registry first
  if [ -f "$proj_registry" ]; then
    win=$(jq -r --arg pid "$pane_id" 'to_entries[] | select(.key != "_config") | select(.value.pane_id == $pid) | .value.window // empty' "$proj_registry" 2>/dev/null | head -1 || echo "")
  fi
  # Fall back to legacy pane-registry
  if [ -z "$win" ] || [ "$win" = "null" ]; then
    win=$(jq -r --arg p "$pane_id" '.[$p].window // empty' "$PANE_REGISTRY" 2>/dev/null || echo "")
  fi
  echo "$win"
}

# ── Kill + resume a stuck flat worker in the same pane ────────────
# Kills the Claude process, then resumes via `claude --resume <session_id>`.
# The worker keeps its pane ID, registry entry, and full conversation context.
_unstick_worker() {
  local pane_id="$1" canonical="$2" idle_sec="$3"
  local worker_name="${canonical#worker/}"
  local worker_dir="$PROJECT_ROOT/.claude/workers/$worker_name"

  # 1. Get session ID before killing (need scrollback)
  local prev_session_id
  prev_session_id=$(_get_session_id "$pane_id")

  # 2. Kill Claude process tree in pane
  local pane_pid
  pane_pid=$(tmux list-panes -a -F '#{pane_id} #{pane_pid}' 2>/dev/null \
    | awk -v id="$pane_id" '$1==id{print $2}')
  if [ -n "$pane_pid" ]; then
    pkill -TERM -P "$pane_pid" 2>/dev/null || true
    sleep 2
    pkill -KILL -P "$pane_pid" 2>/dev/null || true
    sleep 1
  fi

  # 3. Build command from worker config (with resume if session available)
  # For main-window workers (no worktree), prepend WORKER_NAME env
  local claude_cmd
  local unstick_window_check
  unstick_window_check=$(_get_worker_window "$pane_id")
  if [ -n "$unstick_window_check" ]; then
    claude_cmd="export WORKER_NAME=$worker_name && $(_build_claude_cmd "$worker_name" "$prev_session_id")"
  else
    claude_cmd=$(_build_claude_cmd "$worker_name" "$prev_session_id")
  fi

  if [ -n "$prev_session_id" ]; then
    _log "UNSTICK: $canonical — resuming session $prev_session_id in pane $pane_id"
  else
    _log "UNSTICK: $canonical — no session_id found, fresh start in pane $pane_id"
  fi

  # 4. Prepare seed file BEFORE launching Claude (shared template)
  local seed_file="/tmp/worker-${worker_name}-respawn.txt"
  local _claude_ops="${HOME}/.claude-ops"
  WORKER_NAME="$worker_name" PROJECT_ROOT="$PROJECT_ROOT" \
    "${HOME}/.bun/bin/bun" -e "
      const { generateSeedContent } = await import('${_claude_ops}/mcp/worker-fleet/index.ts');
      process.stdout.write(generateSeedContent());
    " > "$seed_file" 2>/dev/null || {
    echo "You are worker $worker_name. Read mission.md, then start your next cycle." > "$seed_file"
  }

  # 5. Launch Claude in the same pane
  tmux send-keys -t "$pane_id" "$claude_cmd" 2>/dev/null || true
  tmux send-keys -t "$pane_id" -H 0d 2>/dev/null || true

  # 6. Wait for Claude TUI to be READY (not just ❯ — old ❯ may be in scrollback).
  # Detect "bypass permissions" statusline which only appears when Claude TUI is loaded.
  # Clear any old content detection by waiting for FRESH statusline after launch.
  sleep 5  # minimum startup time for Claude
  local wait=0
  until tmux capture-pane -t "$pane_id" -p 2>/dev/null | tail -5 | grep -qF 'bypass permissions'; do
    sleep 3; wait=$((wait + 3))
    if [ "$wait" -ge 90 ]; then
      _log "UNSTICK-WARN: $canonical — TUI prompt not detected after 95s, injecting seed anyway"
      break
    fi
  done
  sleep 2

  # 7. Inject full seed prompt into Claude TUI
  # Use unique buffer name (pane + PID) to prevent stale buffer reuse
  local buf_name="wd-${pane_id#%}-$$"
  # Delete any pre-existing buffer with this name first
  tmux delete-buffer -b "$buf_name" 2>/dev/null || true
  # Load seed — if this fails, skip paste entirely (don't risk stale buffer)
  if ! tmux load-buffer -b "$buf_name" "$seed_file" 2>/dev/null; then
    _log "UNSTICK-ERR: $canonical — failed to load seed into tmux buffer (file: $seed_file)"
    rm -f "$seed_file" 2>/dev/null || true
    return
  fi
  tmux paste-buffer -t "$pane_id" -b "$buf_name" -d 2>/dev/null || true
  sleep 1
  tmux send-keys -t "$pane_id" -H 0d 2>/dev/null || true
  # Retry Enter after 3s — Claude TUI sometimes swallows the first one during paste processing
  sleep 3
  if tmux capture-pane -t "$pane_id" -p 2>/dev/null | tail -3 | grep -qE '❯'; then
    tmux send-keys -t "$pane_id" -H 0d 2>/dev/null || true
  fi
  rm -f "$seed_file" 2>/dev/null || true
  # Write pane border status for visual indicator
  echo "⚡ $worker_name" > "/tmp/tmux_pane_status_${pane_id}" 2>/dev/null || true
}

# ── Check a single agent ──────────────────────────────────────────
check_agent() {
  local pane_id="$1"
  local entry; entry=$(pane_registry_read "$pane_id")
  local canonical=""
  local pane_target=""

  if [ "$entry" != "{}" ]; then
    # Found in legacy pane-registry
    canonical=$(echo "$entry" | jq -r '.harness // empty')
    pane_target=$(echo "$entry" | jq -r '.pane_target // empty')
  fi

  # Fall back to project registry.json (worker panes)
  if [ -z "$canonical" ]; then
    local proj_registry="$PROJECT_ROOT/.claude/workers/registry.json"
    if [ -f "$proj_registry" ]; then
      # Find worker name by pane_id
      local worker_name
      worker_name=$(jq -r --arg pid "$pane_id" 'to_entries[] | select(.key != "_config") | select(.value.pane_id == $pid) | .key' "$proj_registry" 2>/dev/null | head -1)
      if [ -n "$worker_name" ]; then
        canonical="worker/$worker_name"
        pane_target=$(jq -r --arg n "$worker_name" '.[$n].pane_target // empty' "$proj_registry" 2>/dev/null || echo "")
        # Synthesize entry for downstream code
        entry=$(jq -nc --arg h "$canonical" --arg pt "$pane_target" '{harness: $h, pane_target: $pt}')
      fi
    fi
  fi

  [ -z "$canonical" ] && return
  local now_ts; now_ts=$(date -u +%s)

  # ── Skip crash recovery for child panes — ephemeral, parent handles cleanup ──
  local parent_pane; parent_pane=$(echo "$entry" | jq -r '.parent_pane // empty')
  if [ -n "$parent_pane" ]; then
    local parent_alive=false
    tmux list-panes -a -F '#{pane_id}' 2>/dev/null | grep -q "^${parent_pane}$" && parent_alive=true
    if $parent_alive; then
      return  # Parent alive → child may be intentionally done; no action
    fi
    # Parent dead → clean up stale child entry
    pane_registry_remove "$pane_id" 2>/dev/null || true
    return
  fi

  # ── Crash-loop guard: skip if already flagged ──
  local runtime; runtime=$(harness_runtime "$canonical")
  if [ -f "$runtime/crash-loop" ]; then
    return  # already flagged, don't keep respawning
  fi

  # ── Check pane alive ──
  local pane_alive=false
  if tmux list-panes -a -F '#{pane_id}' 2>/dev/null | grep -q "^${pane_id}$"; then
    pane_alive=true
  fi

  # ── Check Claude process alive ──
  local pane_pid; pane_pid=$(tmux list-panes -a -F '#{pane_id} #{pane_pid}' 2>/dev/null \
    | awk -v id="$pane_id" '$1==id{print $2}' || echo "")
  local process_alive=false
  if [ -n "$pane_pid" ] && kill -0 "$pane_pid" 2>/dev/null; then
    process_alive=true
  fi

  # ── Classify state ──
  local session_state_dir=""
  local graceful=false
  # Find session dir for this pane via pane-registry
  local session_id; session_id=$(echo "$entry" | jq -r '.session_id // empty')
  if [ -n "$session_id" ]; then
    session_state_dir="$HARNESS_STATE_DIR/sessions/$session_id"
    [ -f "$session_state_dir/graceful-stop" ] && graceful=true
  fi

  if $graceful; then
    # ── Graceful stop — check sleep_duration, respawn if elapsed ──
    # Handles BOTH cases: pane dead (normal) AND pane alive at ❯ prompt after stop hook.
    # Claude TUI stays open at the prompt even after a graceful stop — don't treat that as "stuck".
    local sleep_dur; sleep_dur=$(harness_sleep_duration "$canonical" 2>/dev/null || echo "0")

    # "none" means perpetual:false — this worker should not be respawned
    if [ "$sleep_dur" = "none" ]; then
      _log "SKIP: $canonical — perpetual:false, not respawning"
      return
    fi

    local stopped_at=0
    [ -n "$session_state_dir" ] && stopped_at=$(stat -f %m "$session_state_dir/graceful-stop" 2>/dev/null \
      || stat -c %Y "$session_state_dir/graceful-stop" 2>/dev/null || echo 0)
    local elapsed=$(( now_ts - stopped_at ))

    if [ "$sleep_dur" -gt 0 ] && [ "$elapsed" -lt "$sleep_dur" ]; then
      # Still within sleep window — don't respawn yet
      return
    fi

    # Sleep window elapsed — respawn (kill existing pane if alive, create fresh one)
    _log "RESPAWN: $canonical — graceful sleep done (slept ${elapsed}s of ${sleep_dur}s)"
    rm -f "$session_state_dir/graceful-stop" 2>/dev/null || true
    _respawn_agent "$canonical" "$pane_id" "$pane_target" "sleep-complete"

  elif $pane_alive && $process_alive; then
    # ── Alive and no graceful-stop — check for stuck ──
    # Agent is mid-turn (hasn't hit stop hook yet). Nudge if too idle.

    # Quick check: if a bash command is currently running, the worker is active.
    # Long-running commands (bun test, deploy, OCR) make bus timestamps stale
    # even though the worker is legitimately busy. Check "(running)" in statusline.
    local pane_content
    pane_content=$(tmux capture-pane -t "$pane_id" -p 2>/dev/null | grep -v '^$' | tail -3)
    if echo "$pane_content" | grep -qF '(running)'; then
      # Command actively executing — not stuck, clear any stale marker
      local runtime_chk; runtime_chk=$(harness_runtime "$canonical")
      rm -f "$runtime_chk/stuck-candidate" 2>/dev/null || true
      return  # skip all stuck detection
    fi

    local last_tool_ts; last_tool_ts=$(_last_tool_call_sec "$canonical")
    local idle_sec=0

    if [ "$last_tool_ts" -gt 0 ]; then
      # Bus data available — use tool-call timestamp
      idle_sec=$(( now_ts - last_tool_ts ))
    else
      # No bus data (flat workers) — fall back to scrollback content analysis
      idle_sec=$(_check_scrollback_stuck "$pane_id" "$canonical" "$now_ts")
    fi

    # For perpetual workers, use sleep_duration as the stuck threshold
    # (they finish cycles and go idle — detect faster than the global 20min)
    local effective_threshold="$STUCK_THRESHOLD_SEC"
    if [[ "$canonical" == worker/* ]]; then
      local worker_sleep_dur
      worker_sleep_dur=$(harness_sleep_duration "$canonical" 2>/dev/null || echo "0")
      if [ "$worker_sleep_dur" != "none" ] && [ "$worker_sleep_dur" -gt 0 ] 2>/dev/null; then
        effective_threshold="$worker_sleep_dur"
      fi
    fi

    if [ "$idle_sec" -gt "$effective_threshold" ]; then
      _log "STUCK: $canonical (pane $pane_id) — ${idle_sec}s since last activity"
      _publish_agent_event "agent.stuck" "$canonical" "Alive but ${idle_sec}s since last activity"

      if [[ "$canonical" == worker/* ]] || ! type hq_send &>/dev/null; then
        # Flat workers: kill and respawn in same pane (keeps parent identity)
        _unstick_worker "$pane_id" "$canonical" "$idle_sec"
        notify "⚠️ $canonical was stuck ${idle_sec}s — killed and respawned" "Watchdog" 2>/dev/null || true
        # Clear stuck marker so we don't re-fire next cycle
        local runtime; runtime=$(harness_runtime "$canonical")
        rm -f "$runtime/stuck-candidate" 2>/dev/null || true
      else
        hq_send "watchdog" "$canonical" "nudge" "You have been idle for ${idle_sec}s. Continue your current task." "urgent" 2>/dev/null || true
      fi
      _publish_agent_event "agent.nudged" "$canonical" "Unstuck after ${idle_sec}s idle"
    fi
    # else: agent is awake and working — no action needed

  elif $pane_alive && ! $process_alive; then
    # ── Zombie pane: pane alive but Claude process exited without graceful-stop ──
    # This happens when Claude crashes/exits but the shell in the tmux pane stays open.
    # The pane shows a shell prompt instead of Claude TUI.
    _log "ZOMBIE: $canonical (pane $pane_id) — pane alive but Claude process dead, no graceful-stop"
    _publish_agent_event "agent.zombie" "$canonical" "Pane alive but Claude process dead"

    local crash_count; crash_count=$(_increment_crash_count "$canonical")
    if [ "$crash_count" -ge "$MAX_CRASHES_PER_HR" ]; then
      local runtime; runtime=$(harness_runtime "$canonical")
      touch "$runtime/crash-loop"
      _log "CRASH-LOOP: $canonical — ${crash_count} crashes in last hour, stopping retries"
      _publish_agent_event "agent.crash-loop" "$canonical" "${crash_count} crashes in last hour — stopped retrying"
      notify "🚨 Crash loop: $canonical (${crash_count} crashes/hr) — manual intervention needed" "Watchdog Alert" 2>/dev/null || true
      return
    fi

    # Respawn in-place (pane exists, _respawn_agent handles the pane-alive path)
    _respawn_agent "$canonical" "$pane_id" "$pane_target" "zombie-recovery"

  else
    # ── Crash (no graceful-stop flag, pane AND process both dead) ──
    if ! $pane_alive && ! $process_alive; then
      _log "CRASH: $canonical (pane $pane_id) — no graceful-stop, pane/process dead"
      _publish_agent_event "agent.crash" "$canonical" "Pane and process died without graceful-stop"

      # Increment crash counter and check for crash-loop
      local crash_count; crash_count=$(_increment_crash_count "$canonical")
      if [ "$crash_count" -ge "$MAX_CRASHES_PER_HR" ]; then
        local runtime; runtime=$(harness_runtime "$canonical")
        touch "$runtime/crash-loop"
        _log "CRASH-LOOP: $canonical — ${crash_count} crashes in last hour, stopping retries"
        _publish_agent_event "agent.crash-loop" "$canonical" "${crash_count} crashes in last hour — stopped retrying"
        notify "🚨 Crash loop: $canonical (${crash_count} crashes/hr) — manual intervention needed" "Watchdog Alert" 2>/dev/null || true
        return
      fi

      _respawn_agent "$canonical" "$pane_id" "$pane_target" "crash-recovery"
    fi
  fi
}

# ── Respawn an agent ──────────────────────────────────────────────
_respawn_agent() {
  local canonical="$1" pane_id="$2" pane_target="$3" reason="$4"

  # ── Flat worker path: worker/{name} ──
  if [[ "$canonical" == worker/* ]]; then
    local worker_name="${canonical#worker/}"

    # If pane is alive, resume in-place (avoids creating new window/worktree)
    local pane_alive=false
    tmux list-panes -a -F '#{pane_id}' 2>/dev/null | grep -q "^${pane_id}$" && pane_alive=true

    if $pane_alive; then
      local worker_dir="$PROJECT_ROOT/.claude/workers/$worker_name"
      local prev_session_id
      prev_session_id=$(_get_session_id "$pane_id")

      # Kill existing Claude process in pane
      local pane_pid
      pane_pid=$(tmux list-panes -a -F '#{pane_id} #{pane_pid}' 2>/dev/null \
        | awk -v id="$pane_id" '$1==id{print $2}')
      if [ -n "$pane_pid" ]; then
        pkill -TERM -P "$pane_pid" 2>/dev/null || true
        sleep 2
        pkill -KILL -P "$pane_pid" 2>/dev/null || true
        sleep 1
      fi

      # Prepare seed file BEFORE launching (generated via bun)
      local prompt_file="/tmp/watchdog-prompt-${worker_name}.txt"
      local _claude_ops="${HOME}/.claude-ops"
      WORKER_NAME="$worker_name" PROJECT_ROOT="$PROJECT_ROOT" \
        "${HOME}/.bun/bin/bun" -e "
          const { generateSeedContent } = await import('${_claude_ops}/mcp/worker-fleet/index.ts');
          process.stdout.write(generateSeedContent());
        " > "$prompt_file" 2>/dev/null || {
        echo "You are worker $worker_name. Read mission.md, then start your next cycle." > "$prompt_file"
      }

      # Build command from config, resume previous session
      # For main-window workers (no worktree), set WORKER_NAME env
      local claude_cmd
      local worker_window_check
      worker_window_check=$(_get_worker_window "$pane_id")
      if [ -n "$worker_window_check" ]; then
        claude_cmd="export WORKER_NAME=$worker_name && $(_build_claude_cmd "$worker_name" "$prev_session_id")"
      else
        claude_cmd=$(_build_claude_cmd "$worker_name" "$prev_session_id")
      fi
      tmux send-keys -t "$pane_id" "$claude_cmd" 2>/dev/null || true
      tmux send-keys -t "$pane_id" -H 0d 2>/dev/null || true

      # Wait for Claude TUI to be READY (detect "bypass permissions" statusline)
      sleep 5
      local wait=0
      until tmux capture-pane -t "$pane_id" -p 2>/dev/null | tail -5 | grep -qF 'bypass permissions'; do
        sleep 3; wait=$((wait + 3))
        if [ "$wait" -ge 90 ]; then
          _log "RESPAWN-WARN: $canonical — TUI prompt not detected after 95s, injecting seed anyway"
          break
        fi
      done
      sleep 2

      # Inject seed into Claude TUI
      # Use unique buffer name (pane + PID) to prevent stale buffer reuse
      local buf_name="wd-${pane_id#%}-$$"
      tmux delete-buffer -b "$buf_name" 2>/dev/null || true
      if ! tmux load-buffer -b "$buf_name" "$prompt_file" 2>/dev/null; then
        _log "RESPAWN-ERR: $canonical — failed to load seed into tmux buffer (file: $prompt_file)"
        rm -f "$prompt_file" 2>/dev/null || true
        return
      fi
      tmux paste-buffer -t "$pane_id" -b "$buf_name" -d 2>/dev/null || true
      sleep 1
      tmux send-keys -t "$pane_id" -H 0d 2>/dev/null || true
      # Retry Enter after 3s — Claude TUI sometimes swallows the first one during paste processing
      sleep 3
      if tmux capture-pane -t "$pane_id" -p 2>/dev/null | tail -3 | grep -qE '❯'; then
        tmux send-keys -t "$pane_id" -H 0d 2>/dev/null || true
      fi
      rm -f "$prompt_file" 2>/dev/null || true

      if [ -n "$prev_session_id" ]; then
        _log "RESPAWN: $canonical (reason=$reason) — resumed session $prev_session_id in pane $pane_id"
      else
        _log "RESPAWN: $canonical (reason=$reason) — fresh start in pane $pane_id"
      fi
      # Write pane border status for visual indicator
      echo "⚡ $worker_name" > "/tmp/tmux_pane_status_${pane_id}" 2>/dev/null || true
      _publish_agent_event "agent.respawned" "$canonical" "Respawned after $reason (in-place)"
      return
    fi

    # Check if this worker belongs to a main window (no worktree, shared window)
    local worker_window
    worker_window=$(_get_worker_window "$pane_id")

    if [ -n "$worker_window" ]; then
      # Main-window worker — create new pane in existing window instead of new worktree
      local window_target="${TARGET_SESSION:-w}:${worker_window}"
      if tmux list-windows -t "${TARGET_SESSION:-w}" -F '#{window_name}' 2>/dev/null | grep -qF "$worker_window"; then
        # Window exists — split a new pane in it
        local new_pane
        new_pane=$(tmux split-window -t "$window_target" -h -c "$PROJECT_ROOT" -d -P -F '#{pane_id}' 2>/dev/null || \
                   tmux split-window -t "$window_target" -v -c "$PROJECT_ROOT" -d -P -F '#{pane_id}' 2>/dev/null || echo "")
        if [ -n "$new_pane" ]; then
          pane_registry_remove "$pane_id" 2>/dev/null || true
          tmux select-pane -T "$worker_name" -t "$new_pane"

          # Register new pane
          local _new_target
          _new_target=$(tmux list-panes -a -F '#{pane_id} #{session_name}:#{window_index}.#{pane_index}' \
            | awk -v p="$new_pane" '$1==p{print $2}' 2>/dev/null || echo "")
          local _now; _now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
          # Update project registry with new pane info
          local _proj_registry="$PROJECT_ROOT/.claude/workers/registry.json"
          if [ -f "$_proj_registry" ]; then
            local _lock_dir="${HARNESS_LOCK_DIR:-${HOME}/.claude-ops/state/locks}/worker-registry"
            mkdir -p "$(dirname "$_lock_dir")" 2>/dev/null || true
            local _lw=0; local _lock_ok=0
            while ! mkdir "$_lock_dir" 2>/dev/null; do
              sleep 0.5; _lw=$((_lw + 1))
              [ "$_lw" -ge 10 ] && break
            done
            [ -d "$_lock_dir" ] && _lock_ok=1
            local tmp_reg; tmp_reg=$(mktemp)
            jq --arg name "$worker_name" --arg pid "$new_pane" --arg target "${_new_target:-}" \
              --arg sess "${TARGET_SESSION:-w}" --arg win "$worker_window" \
              '.[$name].pane_id = $pid | .[$name].pane_target = $target | .[$name].tmux_session = $sess | .[$name].window = $win | .[$name].session_id = ""' \
              "$_proj_registry" > "$tmp_reg" 2>/dev/null && mv "$tmp_reg" "$_proj_registry" || rm -f "$tmp_reg"
            [ "$_lock_ok" -eq 1 ] && rmdir "$_lock_dir" 2>/dev/null || true
          fi
          # Also update legacy pane-registry for backward compat
          local tmp_reg2; tmp_reg2=$(mktemp)
          local _proj_slug; _proj_slug=$(basename "$PROJECT_ROOT")
          jq --arg pid "$new_pane" --arg name "$worker_name" --arg target "${_new_target:-}" \
            --arg sess "${TARGET_SESSION:-w}" --arg now "$_now" --arg win "$worker_window" \
            --arg proj "$PROJECT_ROOT" \
            '.[$pid] = {harness: ("worker/" + $name), session_name: $name, display: $name, task: "worker", pane_target: $target, project_root: $proj, tmux_session: $sess, window: $win}' \
            "$PANE_REGISTRY" > "$tmp_reg2" 2>/dev/null && mv "$tmp_reg2" "$PANE_REGISTRY" || rm -f "$tmp_reg2"

          # Launch Claude in new pane
          local worker_dir="$PROJECT_ROOT/.claude/workers/$worker_name"
          local claude_cmd
          claude_cmd="export WORKER_NAME=$worker_name && $(_build_claude_cmd "$worker_name" "")"
          tmux send-keys -t "$new_pane" "$claude_cmd" 2>/dev/null || true
          tmux send-keys -t "$new_pane" -H 0d 2>/dev/null || true

          # Wait for TUI, inject seed
          sleep 5
          local wait=0
          until tmux capture-pane -t "$new_pane" -p 2>/dev/null | tail -5 | grep -qF 'bypass permissions'; do
            sleep 3; wait=$((wait + 3))
            [ "$wait" -ge 90 ] && break
          done
          sleep 2

          local perpetual_protocol="$PROJECT_ROOT/.claude/workers/PERPETUAL-PROTOCOL.md"
          local prompt_file="/tmp/watchdog-prompt-${worker_name}.txt"
          cat > "$prompt_file" << MWSEED
Watchdog respawn, reason: $reason. You are worker **$worker_name** running on **main** branch (no worktree).
Project root: $PROJECT_ROOT
Worker config: $worker_dir/

Read these files NOW:
1. $worker_dir/mission.md — your mission
2. ${perpetual_protocol} — self-optimization protocol
3. $worker_dir/state.json — current state

Then start your next mission cycle. Do NOT stop to ask if you should continue.
MWSEED

          local buf_name="wd-${new_pane#%}-$$"
          tmux delete-buffer -b "$buf_name" 2>/dev/null || true
          tmux load-buffer -b "$buf_name" "$prompt_file" 2>/dev/null || true
          tmux paste-buffer -t "$new_pane" -b "$buf_name" -d 2>/dev/null || true
          sleep 1
          tmux send-keys -t "$new_pane" -H 0d 2>/dev/null || true
          sleep 3
          if tmux capture-pane -t "$new_pane" -p 2>/dev/null | tail -3 | grep -qE '❯'; then
            tmux send-keys -t "$new_pane" -H 0d 2>/dev/null || true
          fi
          rm -f "$prompt_file" 2>/dev/null || true

          _log "RESPAWN: $canonical (reason=$reason) — new pane $new_pane in window $worker_window"
          _publish_agent_event "agent.respawned" "$canonical" "Respawned in main window after $reason"
          return
        fi
      fi
      # Window gone — recreate entire main window
      local main_launch="$HOME/.claude-ops/scripts/launch-main-window.sh"
      if [ -f "$main_launch" ]; then
        pane_registry_remove "$pane_id" 2>/dev/null || true
        bash "$main_launch" --project "$PROJECT_ROOT" &
        _log "RESPAWN: $canonical (reason=$reason) — relaunched entire main window"
        _publish_agent_event "agent.respawned" "$canonical" "Main window recreated after $reason"
        return
      fi
    fi

    # Pane dead — fall back to launch-flat-worker.sh (creates new window)
    local worker_launch="$PROJECT_ROOT/.claude/scripts/launch-flat-worker.sh"
    if [ ! -f "$worker_launch" ]; then
      worker_launch="$HOME/.claude-ops/scripts/launch-flat-worker.sh"
    fi
    if [ ! -f "$worker_launch" ]; then
      _log "RESPAWN-SKIP: $canonical — launch-flat-worker.sh not found (checked project + upstream)"
      return
    fi
    # Remove stale pane registry entry
    pane_registry_remove "$pane_id" 2>/dev/null || true
    bash "$worker_launch" "$worker_name" &
    _log "RESPAWN: $canonical (reason=$reason) — launched via launch-flat-worker.sh (pane was dead)"
    _publish_agent_event "agent.respawned" "$canonical" "Respawned after $reason (new pane)"
    return
  fi

  # ── Legacy harness path ──
  local harness_name; harness_name=$(echo "$canonical" | cut -d/ -f1)
  local seed_script="$PROJECT_ROOT/.claude/scripts/${harness_name}-seed.sh"

  if [ ! -f "$seed_script" ]; then
    _log "RESPAWN-SKIP: $canonical — seed script not found at $seed_script"
    return
  fi

  # Remove stale pane registry entry
  pane_registry_remove "$pane_id" 2>/dev/null || true

  # Launch new agent (harness-launch.sh handles pane creation + seed injection)
  local launch_script="$HOME/.claude-ops/harness/harness-launch.sh"
  if [ -f "$launch_script" ]; then
    bash "$launch_script" "$harness_name" "$seed_script" &
    _log "RESPAWN: $canonical (reason=$reason) — launched via harness-launch.sh"
    _publish_agent_event "agent.respawned" "$canonical" "Respawned after $reason"
  else
    _log "RESPAWN-SKIP: $canonical — harness-launch.sh not found at $launch_script"
  fi
}

# ── Status display ────────────────────────────────────────────────
print_status() {
  local registry="$PANE_REGISTRY"
  [ ! -f "$registry" ] && { echo "No pane registry found at $registry"; return; }

  local now_ts; now_ts=$(date -u +%s)
  printf "%-30s %-10s %-10s %-20s\n" "CANONICAL" "PANE" "STATE" "LAST_TOOL"
  printf "%-30s %-10s %-10s %-20s\n" "--------" "----" "-----" "---------"

  while IFS= read -r pane_id; do
    local entry; entry=$(pane_registry_read "$pane_id")
    local canonical; canonical=$(echo "$entry" | jq -r '.harness // empty')
    [ -z "$canonical" ] && continue

    local pane_alive="dead"
    tmux list-panes -a -F '#{pane_id}' 2>/dev/null | grep -q "^${pane_id}$" && pane_alive="alive"

    local last_ts; last_ts=$(_last_tool_call_sec "$canonical")
    local last_str="never"
    [ "$last_ts" -gt 0 ] && last_str="$(( now_ts - last_ts ))s ago"

    local state="$pane_alive"
    local runtime; runtime=$(harness_runtime "$canonical")
    [ -f "$runtime/sleeping" ] && state="sleeping"
    [ -f "$runtime/crash-loop" ] && state="CRASH-LOOP"

    printf "%-30s %-10s %-10s %-20s\n" "$canonical" "$pane_id" "$state" "$last_str"
  done < <(jq -r 'keys[]' "$registry" 2>/dev/null || true)
}

# ── Main loop ─────────────────────────────────────────────────────
_log "Watchdog starting (mode=$MODE, interval=${CHECK_INTERVAL}s, stuck=${STUCK_THRESHOLD_SEC}s)"

if [ "$MODE" = "status" ]; then
  print_status
  exit 0
fi

run_once() {
  # Check workers from project registry.json (primary source)
  local proj_registry="$PROJECT_ROOT/.claude/workers/registry.json"
  if [ -f "$proj_registry" ]; then
    while IFS= read -r pane_id; do
      [ -z "$pane_id" ] || [ "$pane_id" = "null" ] && continue
      check_agent "$pane_id" 2>/dev/null || true
    done < <(jq -r 'to_entries[] | select(.key != "_config") | .value.pane_id // empty' "$proj_registry" 2>/dev/null || true)
  fi

  # Also check legacy pane-registry for non-worker harnesses
  local registry="$PANE_REGISTRY"
  if [ -f "$registry" ] && [ "$(jq 'length' "$registry" 2>/dev/null)" != "0" ]; then
    while IFS= read -r pane_id; do
      check_agent "$pane_id" 2>/dev/null || true
    done < <(jq -r 'keys[]' "$registry" 2>/dev/null || true)
  fi
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
