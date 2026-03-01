#!/usr/bin/env bash
# harness-watchdog.sh — Monitor registered harness agents; detect crashes vs graceful stops.
#
# Runs as a background daemon (via launchd or cron).
# Every CHECK_INTERVAL seconds:
#   1. Read pane-registry.json for all registered agents
#   2. For each: check pane alive, Claude process alive, last tool-call event time
#   3. Classify: graceful_sleep | awake | stuck | crashed
#   4. Publish agent.* bus events
#   5. Respawn crashed agents via harness-launch.sh
#   6. Crash-loop guard: max MAX_CRASHES_PER_HR crashes → stop retrying, notify operator
#
# Usage:
#   bash harness-watchdog.sh              # daemon mode (loops forever)
#   bash harness-watchdog.sh --once       # single-pass (for testing)
#   bash harness-watchdog.sh --status     # print current state table and exit
#
# Requirements:
#   - PROJECT_ROOT set (or auto-detected via git)
#   - pane-registry.json populated by agents at startup
#   - ~/.boring/lib/harness-jq.sh + event-bus.sh available
#
# Crash-loop file: ~/.boring/state/harness-runtime/{canonical}/crash-loop
# Crash count file: ~/.boring/state/harness-runtime/{canonical}/crash-count.json

set -euo pipefail

# ── Config ──────────────────────────────────────────────────────
CHECK_INTERVAL="${WATCHDOG_CHECK_INTERVAL:-30}"
STUCK_THRESHOLD_SEC="${WATCHDOG_STUCK_THRESHOLD:-1200}"  # 20 min no activity = stuck
MAX_CRASHES_PER_HR="${WATCHDOG_MAX_CRASHES:-3}"
LOG_FILE="${WATCHDOG_LOG:-${HOME}/.boring/state/watchdog.log}"

# git rev-parse fails if cwd is not in a repo (e.g. watchdog started by launchd from /).
# Hardcode the default project root; override via env if needed.
PROJECT_ROOT="${PROJECT_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
source "${HOME}/.boring/lib/harness-jq.sh"
source "${HOME}/.boring/lib/event-bus.sh" 2>/dev/null || true

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

  # Not matching stuck pattern — clear marker
  rm -f "$marker" 2>/dev/null || true
  echo 0
}

# ── Kill + respawn a stuck flat worker in the same pane ───────────
# Kills the Claude process, then relaunches with a respawn seed.
# The worker keeps its pane ID and registry entry (still the parent).
_unstick_worker() {
  local pane_id="$1" canonical="$2" idle_sec="$3"
  local worker_name="${canonical#worker/}"
  local worker_dir="$PROJECT_ROOT/.claude/workers/$worker_name"
  local perms="$worker_dir/permissions.json"

  # 1. Kill Claude process tree in pane
  local pane_pid
  pane_pid=$(tmux list-panes -a -F '#{pane_id} #{pane_pid}' 2>/dev/null \
    | awk -v id="$pane_id" '$1==id{print $2}')
  if [ -n "$pane_pid" ]; then
    pkill -TERM -P "$pane_pid" 2>/dev/null || true
    sleep 2
    pkill -KILL -P "$pane_pid" 2>/dev/null || true
    sleep 1
  fi

  # 2. Read model from permissions
  local model
  model=$(jq -r '.model // "sonnet"' "$perms" 2>/dev/null || echo "sonnet")

  # 3. Generate respawn seed
  local seed_file="/tmp/worker-${worker_name}-respawn.txt"
  cat > "$seed_file" << RSEED
You are worker **$worker_name** (respawned by watchdog after ${idle_sec}s stuck on a hanging task).

Read these files NOW:
1. $worker_dir/tasks.json — your current task list
2. $worker_dir/MEMORY.md — accumulated knowledge
3. $worker_dir/state.json — current state

Then continue your work. Key rules:
- Use explicit timeouts for network ops: \`timeout 60 <cmd>\` or \`--connect-timeout 10\`
- If a background task doesn't complete in 2 minutes, cancel and try a different approach
- Claim your next unclaimed task: \`bash ~/.claude-ops/scripts/worker-task.sh next\`
RSEED

  # 4. Launch Claude in the same pane
  local claude_cmd="claude --model $model --dangerously-skip-permissions"
  claude_cmd="$claude_cmd --add-dir $PROJECT_ROOT/.claude/workers/$worker_name"
  tmux send-keys -t "$pane_id" "$claude_cmd" 2>/dev/null || true
  tmux send-keys -t "$pane_id" -H 0d 2>/dev/null || true

  # 5. Wait for TUI prompt (max 60s)
  local wait=0
  until tmux capture-pane -t "$pane_id" -p 2>/dev/null | grep -qE '❯|> $'; do
    sleep 2; wait=$((wait + 2))
    [ "$wait" -ge 60 ] && break
  done
  sleep 2

  # 6. Inject seed
  tmux load-buffer "$seed_file" 2>/dev/null || true
  tmux paste-buffer -t "$pane_id" 2>/dev/null || true
  sleep 2
  tmux send-keys -t "$pane_id" -H 0d 2>/dev/null || true

  _log "UNSTICK: $canonical — killed and respawned in pane $pane_id"
}

# ── Check a single agent ──────────────────────────────────────────
check_agent() {
  local pane_id="$1"
  local entry; entry=$(pane_registry_read "$pane_id")
  [ "$entry" = "{}" ] && return

  local canonical; canonical=$(echo "$entry" | jq -r '.harness // empty')
  [ -z "$canonical" ] && return

  local pane_target; pane_target=$(echo "$entry" | jq -r '.pane_target // empty')
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
    local last_tool_ts; last_tool_ts=$(_last_tool_call_sec "$canonical")
    local idle_sec=0

    if [ "$last_tool_ts" -gt 0 ]; then
      # Bus data available — use tool-call timestamp
      idle_sec=$(( now_ts - last_tool_ts ))
    else
      # No bus data (flat workers) — fall back to scrollback content analysis
      idle_sec=$(_check_scrollback_stuck "$pane_id" "$canonical" "$now_ts")
    fi

    if [ "$idle_sec" -gt "$STUCK_THRESHOLD_SEC" ]; then
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

  else
    # ── Crash (no graceful-stop flag, pane/process dead) ──
    if ! $pane_alive && ! $process_alive; then
      _log "CRASH: $canonical (pane $pane_id) — no graceful-stop, pane/process dead"
      _publish_agent_event "agent.crash" "$canonical" "Pane and process died without graceful-stop"

      # Increment crash counter and check for crash-loop
      local crash_count; crash_count=$(_increment_crash_count "$canonical")
      if [ "$crash_count" -ge "$MAX_CRASHES_PER_HR" ]; then
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

  # ── Flat worker path: worker/{name} → launch-flat-worker.sh ──
  if [[ "$canonical" == worker/* ]]; then
    local worker_name="${canonical#worker/}"
    # Try project-local first, fall back to upstream generic
    local worker_launch="$PROJECT_ROOT/.claude/scripts/launch-flat-worker.sh"
    if [ ! -f "$worker_launch" ]; then
      worker_launch="$HOME/.boring/scripts/launch-flat-worker.sh"
    fi
    if [ ! -f "$worker_launch" ]; then
      _log "RESPAWN-SKIP: $canonical — launch-flat-worker.sh not found (checked project + upstream)"
      return
    fi
    # Remove stale pane registry entry
    pane_registry_remove "$pane_id" 2>/dev/null || true
    bash "$worker_launch" "$worker_name" &
    _log "RESPAWN: $canonical (reason=$reason) — launched via launch-flat-worker.sh"
    _publish_agent_event "agent.respawned" "$canonical" "Respawned after $reason"
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
  local launch_script="$HOME/.boring/harness/harness-launch.sh"
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
  local registry="$PANE_REGISTRY"
  [ ! -f "$registry" ] && return

  while IFS= read -r pane_id; do
    check_agent "$pane_id" 2>/dev/null || true
  done < <(jq -r 'keys[]' "$registry" 2>/dev/null || true)
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
