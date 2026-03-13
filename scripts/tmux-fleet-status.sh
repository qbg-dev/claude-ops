#!/usr/bin/env bash
# tmux-fleet-status.sh — compact fleet worker status for tmux status-left
# Output: colored worker names with liveness indicators
# Called by tmux every status-interval (5s) — must be fast (<100ms)
#
# Project detection: PROJECT_ROOT env > current tmux session name > most recent fleet.json

FLEET_DATA="${HOME}/.claude/fleet"
[ -d "$FLEET_DATA" ] || exit 0

# Resolve project name
PROJECT=""

# 1. From PROJECT_ROOT env (set by watchdog/launchd)
if [ -n "${PROJECT_ROOT:-}" ]; then
  PROJECT=$(basename "$PROJECT_ROOT" | sed 's/-w-.*$//')
fi

# 2. From current tmux session name (matches fleet convention)
if [ -z "$PROJECT" ] || [ ! -d "$FLEET_DATA/$PROJECT" ]; then
  if [ -n "${TMUX:-}" ]; then
    session=$(tmux display-message -p '#{session_name}' 2>/dev/null) || true
    # Check if session name maps to a fleet project (directly or via fleet.json tmux_session)
    if [ -n "$session" ] && [ -d "$FLEET_DATA" ]; then
      for pdir in "$FLEET_DATA"/*/; do
        [ -d "$pdir" ] || continue
        pname=$(basename "$pdir")
        fj="$pdir/fleet.json"
        if [ -f "$fj" ]; then
          tmux_session=$(grep -o '"tmux_session" *: *"[^"]*"' "$fj" 2>/dev/null | head -1 | sed 's/.*"\([^"]*\)"$/\1/') || true
          if [ "$tmux_session" = "$session" ] || [ "$pname" = "$session" ]; then
            PROJECT="$pname"
            break
          fi
        fi
      done
    fi
  fi
fi

# 3. Fallback: most recently modified fleet.json
if [ -z "$PROJECT" ] || [ ! -d "$FLEET_DATA/$PROJECT" ]; then
  PROJECT=$(find "$FLEET_DATA" -maxdepth 2 -name fleet.json 2>/dev/null \
    | while read -r f; do
        mtime=$(stat -f '%m' "$f" 2>/dev/null || stat -c '%Y' "$f" 2>/dev/null || echo 0)
        echo "$mtime $f"
      done | sort -rn | head -1 | awk '{print $2}' | xargs dirname 2>/dev/null | xargs basename 2>/dev/null) || true
fi

[ -n "$PROJECT" ] && [ -d "$FLEET_DATA/$PROJECT" ] || exit 0

PROJECT_DIR="$FLEET_DATA/$PROJECT"

# Get alive tmux panes (fast — single tmux call)
ALIVE_PANES=" $(tmux list-panes -a -F '#{pane_id}' 2>/dev/null | tr '\n' ' ')"

output=""
for worker_dir in "$PROJECT_DIR"/*/; do
  [ -d "$worker_dir" ] || continue
  name=$(basename "$worker_dir")
  [ "$name" = "missions" ] && continue

  state_file="$worker_dir/state.json"
  [ -f "$state_file" ] || continue

  # Fast JSON extraction without jq
  pane_id=$(grep -o '"pane_id" *: *"[^"]*"' "$state_file" 2>/dev/null | head -1 | sed 's/.*"\([^"]*\)"$/\1/') || true
  wst=$(grep -o '"status" *: *"[^"]*"' "$state_file" 2>/dev/null | head -1 | sed 's/.*"\([^"]*\)"$/\1/') || true

  # Determine liveness
  if [ -n "$pane_id" ] && [[ "$ALIVE_PANES" == *" $pane_id "* ]]; then
    indicator="#[fg=green]●#[fg=colour245]"
  elif [ "$wst" = "sleeping" ]; then
    indicator="#[fg=blue]◦#[fg=colour245]"
  elif [ "$wst" = "standby" ]; then
    indicator="#[fg=colour240]○#[fg=colour245]"
  else
    indicator="#[fg=red]●#[fg=colour245]"
  fi

  if [ -n "$output" ]; then
    output="$output $indicator$name"
  else
    output="$indicator$name"
  fi
done

if [ -n "$output" ]; then
  echo "#[fg=colour245]$output#[default] "
fi
