#!/usr/bin/env bash
# harness-health.sh — Comprehensive health check for the harness + flat worker system.
#
# Checks:
#   1. Pane registry integrity (stale panes, missing session_ids)
#   2. Graceful-stop markers (stale ones > 2× max sleep_duration)
#   3. Crash-loop flags (agents stuck in crash loop)
#   4. Worker tasks.json validity (JSON schema, required fields)
#   5. Worker state.json consistency (perpetual/sleep_duration)
#   6. Stuck-candidate markers (possibly hanging workers)
#   7. Watchdog config sanity
#
# Usage:
#   bash ~/.boring/scripts/harness-health.sh [--json] [--workers-dir /path]
#   WORKERS_DIR=/path/to/.claude/workers bash harness-health.sh
#
# Output:
#   Default: colored text summary
#   --json:  machine-readable JSON report
set -uo pipefail

source "${HOME}/.boring/lib/harness-jq.sh"

# ── Config ──────────────────────────────────────────────────────
WORKERS_DIR="${WORKERS_DIR:-}"
PROJECT_ROOT_DETECT="${PROJECT_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
[ -z "$WORKERS_DIR" ] && WORKERS_DIR="$PROJECT_ROOT_DETECT/.claude/workers"
OUTPUT_JSON=false
[ "${1:-}" = "--json" ] && OUTPUT_JSON=true
[ "${2:-}" = "--json" ] && OUTPUT_JSON=true
[ "${1:-}" = "--workers-dir" ] && WORKERS_DIR="${2:?}" && shift 2
[ "${2:-}" = "--workers-dir" ] && WORKERS_DIR="${3:?}"

# ── Output helpers ───────────────────────────────────────────────
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
RESET='\033[0m'

_ok()   { echo -e "  ${GREEN}✓${RESET} $*"; }
_warn() { echo -e "  ${YELLOW}⚠${RESET} $*"; }
_fail() { echo -e "  ${RED}✗${RESET} $*"; }
_info() { echo -e "  ${BLUE}·${RESET} $*"; }

ISSUES=()
WARNINGS=()

_issue() { ISSUES+=("$*"); _fail "$*"; }
_warning() { WARNINGS+=("$*"); _warn "$*"; }

# ── 1. Pane registry integrity ───────────────────────────────────
check_pane_registry() {
  echo ""
  echo "Pane Registry"

  if [ ! -f "$PANE_REGISTRY" ]; then
    _info "No pane registry found (fresh install or watchdog not started)"
    return
  fi

  local total dead_panes missing_session orphaned
  total=$(jq 'keys | length' "$PANE_REGISTRY" 2>/dev/null || echo 0)

  if [ "$total" -eq 0 ]; then
    _ok "Registry empty (0 panes)"
    return
  fi

  _info "$total registered pane(s)"

  # Check for dead panes (pane_id no longer in tmux)
  dead_panes=0
  missing_session=0
  orphaned=0
  if command -v tmux &>/dev/null && tmux info &>/dev/null 2>&1; then
    local live_panes
    live_panes=$(tmux list-panes -a -F '#{pane_id}' 2>/dev/null || echo "")

    while IFS= read -r pane_id; do
      if [ -z "$pane_id" ]; then continue; fi
      if ! echo "$live_panes" | grep -qF "$pane_id"; then
        dead_panes=$(( dead_panes + 1 ))
        local harness
        harness=$(jq -r --arg p "$pane_id" '.[$p].harness // "unknown"' "$PANE_REGISTRY" 2>/dev/null)
        _warning "Dead pane: $pane_id ($harness) — run gc-cleanup to prune"
      fi
      # Check missing session_id (needed for graceful-stop detection)
      local sid
      sid=$(jq -r --arg p "$pane_id" '.[$p].session_id // empty' "$PANE_REGISTRY" 2>/dev/null)
      if [ -z "$sid" ]; then
        missing_session=$(( missing_session + 1 ))
      fi
    done < <(jq -r 'keys[]' "$PANE_REGISTRY" 2>/dev/null)

    [ "$dead_panes" -eq 0 ] && _ok "All $total panes alive"
    [ "$dead_panes" -gt 0 ] && _issue "$dead_panes dead pane(s) in registry (prevents proper respawn detection)"
    [ "$missing_session" -gt 0 ] && _warning "$missing_session pane(s) missing session_id (graceful-stop may not be detected)"
  else
    _info "tmux not available — skipping live pane check"
  fi
}

# ── 2. Graceful-stop markers ─────────────────────────────────────
check_graceful_stops() {
  echo ""
  echo "Graceful-Stop Markers"

  local sessions_dir="$HARNESS_STATE_DIR/sessions"
  if [ ! -d "$sessions_dir" ]; then
    _ok "No sessions directory (no stops recorded yet)"
    return
  fi

  local stale=0 active=0
  local now_ts; now_ts=$(date -u +%s)
  local max_stale_sec=86400  # markers >24h are definitely stale

  while IFS= read -r marker; do
    [ -f "$marker" ] || continue
    local mtime
    mtime=$(stat -f %m "$marker" 2>/dev/null || stat -c %Y "$marker" 2>/dev/null || echo 0)
    local age=$(( now_ts - mtime ))
    if [ "$age" -gt "$max_stale_sec" ]; then
      stale=$(( stale + 1 ))
      local session_id; session_id=$(basename "$(dirname "$marker")")
      _warning "Stale graceful-stop: session ${session_id:0:8}... (${age}s old) — watchdog may have missed it"
    else
      active=$(( active + 1 ))
    fi
  done < <(find "$sessions_dir" -name "graceful-stop" -type f 2>/dev/null)

  local total=$(( stale + active ))
  [ "$total" -eq 0 ] && _ok "No graceful-stop markers (all agents active or respawned)"
  [ "$active" -gt 0 ] && _info "$active recent graceful-stop marker(s) (awaiting respawn)"
  [ "$stale" -gt 0 ] && _issue "$stale stale graceful-stop marker(s) older than 24h — watchdog may not be running"
}

# ── 3. Crash-loop flags ──────────────────────────────────────────
check_crash_loops() {
  echo ""
  echo "Crash-Loop Flags"

  local runtime_dir="$HARNESS_STATE_DIR/harness-runtime"
  if [ ! -d "$runtime_dir" ]; then
    _ok "No runtime directory (no crashes recorded)"
    return
  fi

  local loop_count=0
  while IFS= read -r flag; do
    [ -f "$flag" ] || continue
    loop_count=$(( loop_count + 1 ))
    local canonical; canonical=$(basename "$(dirname "$flag")")
    _issue "Crash loop: $canonical — manual intervention needed (rm $flag to reset)"
  done < <(find "$runtime_dir" -name "crash-loop" -type f 2>/dev/null)

  [ "$loop_count" -eq 0 ] && _ok "No crash-loop flags"
}

# ── 4. Stuck-candidate markers ───────────────────────────────────
check_stuck_candidates() {
  echo ""
  echo "Stuck-Candidate Markers"

  local runtime_dir="$HARNESS_STATE_DIR/harness-runtime"
  if [ ! -d "$runtime_dir" ]; then
    _ok "No stuck-candidate markers"
    return
  fi

  local now_ts; now_ts=$(date -u +%s)
  local found=0
  while IFS= read -r marker; do
    [ -f "$marker" ] || continue
    found=$(( found + 1 ))
    local mtime; mtime=$(stat -f %m "$marker" 2>/dev/null || stat -c %Y "$marker" 2>/dev/null || echo 0)
    local since; since=$(cat "$marker" 2>/dev/null || echo "$mtime")
    local age=$(( now_ts - since ))
    local canonical; canonical=$(basename "$(dirname "$marker")")
    if [ "$age" -gt 1200 ]; then
      _issue "Stuck >20min: $canonical (${age}s) — watchdog should have unstuck it"
    else
      _warning "Stuck candidate: $canonical (${age}s) — watching"
    fi
  done < <(find "$runtime_dir" -name "stuck-candidate" -type f 2>/dev/null)

  [ "$found" -eq 0 ] && _ok "No stuck-candidate markers"
}

# ── 5. Worker tasks.json validation ──────────────────────────────
check_worker_tasks() {
  echo ""
  echo "Worker tasks.json"

  if [ ! -d "$WORKERS_DIR" ]; then
    _info "No workers directory at $WORKERS_DIR"
    return
  fi

  local workers; workers=$(find "$WORKERS_DIR" -maxdepth 1 -mindepth 1 -type d 2>/dev/null | sort)
  if [ -z "$workers" ]; then
    _info "No workers found"
    return
  fi

  local total=0 valid=0 invalid=0 missing=0

  while IFS= read -r wdir; do
    local wname; wname=$(basename "$wdir")
    local tf="$wdir/tasks.json"
    total=$(( total + 1 ))

    if [ ! -f "$tf" ]; then
      missing=$(( missing + 1 ))
      _warning "$wname: no tasks.json"
      continue
    fi

    # JSON parse check
    if ! jq empty "$tf" 2>/dev/null; then
      invalid=$(( invalid + 1 ))
      _issue "$wname: tasks.json is invalid JSON"
      continue
    fi

    # Count tasks
    local task_count
    task_count=$(jq 'keys | length' "$tf" 2>/dev/null || echo 0)

    # Check for tasks with required fields
    local bad_tasks
    bad_tasks=$(jq -r 'to_entries[] | select(.value.status == null or .value.subject == null) | .key' \
      "$tf" 2>/dev/null || echo "")
    if [ -n "$bad_tasks" ]; then
      _warning "$wname: $(echo "$bad_tasks" | wc -l | tr -d ' ') task(s) missing required fields (status/subject)"
    fi

    # Check for impossible states (in_progress with null owner)
    local orphaned_wip
    orphaned_wip=$(jq '[to_entries[] | select(.value.status == "in_progress" and (.value.owner == null or .value.owner == "null"))] | length' \
      "$tf" 2>/dev/null || echo 0)
    if [ "$orphaned_wip" -gt 0 ]; then
      _warning "$wname: $orphaned_wip task(s) in_progress with no owner (agent may have crashed)"
    fi

    # Check for circular deps (basic: a task blocking itself)
    local self_blocked
    self_blocked=$(jq '[to_entries[] | select(.value.blocked_by != null and (.value.blocked_by | contains([.key])))] | length' \
      "$tf" 2>/dev/null || echo 0)
    if [ "$self_blocked" -gt 0 ]; then
      _issue "$wname: $self_blocked task(s) with self-referencing blocked_by (circular dependency)"
    fi

    valid=$(( valid + 1 ))
    _ok "$wname: $task_count tasks ($(jq '[to_entries[] | select(.value.status == "completed")] | length' "$tf" 2>/dev/null)✓ $(jq '[to_entries[] | select(.value.status == "in_progress")] | length' "$tf" 2>/dev/null)⏳ $(jq '[to_entries[] | select(.value.status == "pending")] | length' "$tf" 2>/dev/null)○)"
  done <<< "$workers"

  [ "$missing" -gt 0 ] && _warning "$missing worker(s) have no tasks.json"
  [ "$invalid" -gt 0 ] && _issue "$invalid worker(s) have invalid JSON in tasks.json"
}

# ── 6. Worker state.json consistency ─────────────────────────────
check_worker_states() {
  echo ""
  echo "Worker state.json"

  if [ ! -d "$WORKERS_DIR" ]; then
    return
  fi

  local no_state=0
  while IFS= read -r wdir; do
    local wname; wname=$(basename "$wdir")
    local sf="$sf"
    sf="$wdir/state.json"

    if [ ! -f "$sf" ]; then
      no_state=$(( no_state + 1 ))
      _warning "$wname: no state.json"
      continue
    fi

    if ! jq empty "$sf" 2>/dev/null; then
      _issue "$wname: state.json is invalid JSON"
      continue
    fi

    local perpetual sleep_dur status
    perpetual=$(jq -r '.perpetual // "unset"' "$sf" 2>/dev/null)
    sleep_dur=$(jq -r '.sleep_duration // "unset"' "$sf" 2>/dev/null)
    status=$(jq -r '.status // "unknown"' "$sf" 2>/dev/null)

    # Perpetual:true workers need a sleep_duration
    if [ "$perpetual" = "true" ] && [ "$sleep_dur" = "unset" ]; then
      _warning "$wname: perpetual:true but no sleep_duration set (watchdog uses default)"
    fi

    # Sleep duration should be sane (>60s, <24h)
    if [[ "$sleep_dur" =~ ^[0-9]+$ ]]; then
      if [ "$sleep_dur" -lt 60 ]; then
        _warning "$wname: sleep_duration=${sleep_dur}s is very short (<60s)"
      elif [ "$sleep_dur" -gt 86400 ]; then
        _warning "$wname: sleep_duration=${sleep_dur}s is very long (>24h)"
      fi
    fi

    _ok "$wname: perpetual=$perpetual, sleep_duration=${sleep_dur}s, status=$status"
  done < <(find "$WORKERS_DIR" -maxdepth 1 -mindepth 1 -type d 2>/dev/null | sort)

  [ "$no_state" -gt 0 ] && _warning "$no_state worker(s) have no state.json"
}

# ── 7. Watchdog config sanity ─────────────────────────────────────
check_watchdog_config() {
  echo ""
  echo "Watchdog Config"

  local wdog="$HOME/.boring/scripts/harness-watchdog.sh"
  if [ ! -f "$wdog" ]; then
    _issue "harness-watchdog.sh not found at $wdog"
    return
  fi
  _ok "harness-watchdog.sh present"

  # Check stuck threshold
  local thresh
  thresh=$(grep 'STUCK_THRESHOLD_SEC=' "$wdog" | head -1 | sed 's/.*:-//' | grep -oE '^[0-9]+')
  if [ "$thresh" = "1200" ]; then
    _ok "Stuck threshold: 1200s (20 min)"
  elif [ -n "$thresh" ]; then
    _warning "Stuck threshold: ${thresh}s (expected 1200)"
  else
    _warning "Could not parse STUCK_THRESHOLD_SEC from watchdog script"
  fi

  # Check MAX_CRASHES_PER_HR
  local max_crashes
  max_crashes=$(grep 'MAX_CRASHES_PER_HR=' "$wdog" | grep -v '#' | head -1 | grep -oE '[0-9]+' | tail -1)
  _info "Max crashes/hr: ${max_crashes:-unknown}"

  # Check that _unstick_worker exists
  if grep -q '_unstick_worker()' "$wdog"; then
    _ok "_unstick_worker() present (kill+respawn for stuck flat workers)"
  else
    _issue "_unstick_worker() missing from watchdog script"
  fi

  # Check launchd plist (watchdog running as daemon)
  local plist="$HOME/Library/LaunchAgents/com.boring.harness-watchdog.plist"
  if [ -f "$plist" ]; then
    _ok "Watchdog launchd plist found"
  else
    _warning "No launchd plist found — watchdog may not be running as daemon"
    _info "To install: launchctl load $plist (after creating it)"
  fi
}

# ── Summary ───────────────────────────────────────────────────────
print_summary() {
  echo ""
  echo "════════════════════════════════════"
  echo "  Health Summary"
  echo "════════════════════════════════════"
  local total_issues="${#ISSUES[@]}"
  local total_warnings="${#WARNINGS[@]}"

  if [ "$total_issues" -eq 0 ] && [ "$total_warnings" -eq 0 ]; then
    echo -e "  ${GREEN}All checks passed — system healthy${RESET}"
  else
    [ "$total_issues" -gt 0 ] && echo -e "  ${RED}$total_issues issue(s) require attention${RESET}"
    [ "$total_warnings" -gt 0 ] && echo -e "  ${YELLOW}$total_warnings warning(s)${RESET}"
  fi
  echo ""

  [ "$total_issues" -gt 0 ] && return 1 || return 0
}

print_summary_json() {
  local exit_code=0
  [ "${#ISSUES[@]}" -gt 0 ] && exit_code=1
  jq -n \
    --argjson issues "$(printf '%s\n' "${ISSUES[@]:-}" | jq -R . | jq -s .)" \
    --argjson warnings "$(printf '%s\n' "${WARNINGS[@]:-}" | jq -R . | jq -s .)" \
    --argjson healthy "$([ "$exit_code" -eq 0 ] && echo true || echo false)" \
    '{"healthy":$healthy,"issues":$issues,"warnings":$warnings}'
  return $exit_code
}

# ── Main ──────────────────────────────────────────────────────────
if ! $OUTPUT_JSON; then
  echo "════════════════════════════════════"
  echo "  Harness Health Check"
  echo "  Workers: $WORKERS_DIR"
  echo "════════════════════════════════════"
fi

check_pane_registry
check_graceful_stops
check_crash_loops
check_stuck_candidates
check_worker_tasks
check_worker_states
check_watchdog_config

if $OUTPUT_JSON; then
  print_summary_json
else
  print_summary
fi
