#!/usr/bin/env bash
# broadcast-chain.sh — interactive chained broadcast with per-step prompts
# Usage: broadcast-chain.sh all|window|select
#
# Each step is interpreted as:
#   - exactly "enter" → Enter key
#   - exactly "esc"   → Escape key
#   - anything else    → literal text

set -euo pipefail

PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"
TMUX_BIN="${TMUX_BIN:-$(command -v tmux)}"

scope="${1:-all}"
declare -a panes=()
declare -a step_kinds=()
declare -a step_values=()

on_exit() {
  local status="$1"
  if (( status != 0 )); then
    echo
    echo "Broadcast failed (exit $status). Press Enter to close."
    IFS= read -r _ || true
  fi
}
trap 'on_exit $?' EXIT

trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

parse_step() {
  local raw trimmed
  raw="$1"
  trimmed="$(trim "$raw")"
  case "$trimmed" in
    enter)
      step_kinds+=("enter")
      step_values+=("")
      ;;
    esc)
      step_kinds+=("esc")
      step_values+=("")
      ;;
    *)
      step_kinds+=("text")
      step_values+=("$raw")
      ;;
  esac
}

pane_exists() {
  "$TMUX_BIN" display-message -p -t "$1" '#{pane_id}' >/dev/null 2>&1
}

add_panes_for_window() {
  local window_index="$1"
  local pane
  while IFS= read -r pane; do
    [[ -n "$pane" ]] && panes+=("$pane")
  done < <("$TMUX_BIN" list-panes -t ":$window_index" -F '#{pane_id}')
}

resolve_panes() {
  case "$scope" in
    all)
      while IFS= read -r pane; do
        [[ -n "$pane" ]] && panes+=("$pane")
      done < <("$TMUX_BIN" list-panes -s -F '#{pane_id}')
      ;;
    window)
      while IFS= read -r pane; do
        [[ -n "$pane" ]] && panes+=("$pane")
      done < <("$TMUX_BIN" list-panes -F '#{pane_id}')
      ;;
    select)
      if ! command -v fzf >/dev/null 2>&1; then
        echo "fzf is required for select scope." >&2
        exit 1
      fi

      local selections window_index line
      selections="$({ "$TMUX_BIN" list-windows -F '#{window_index}|#{window_name} (#{window_panes} panes)'; } | fzf --multi --with-nth=2 --delimiter='|' --prompt='Select windows (Tab=multi): ' || true)"
      [[ -z "$selections" ]] && exit 0

      while IFS= read -r line; do
        [[ -z "$line" ]] && continue
        window_index="${line%%|*}"
        add_panes_for_window "$window_index"
      done <<< "$selections"
      ;;
    *)
      echo "Unknown scope: $scope" >&2
      exit 1
      ;;
  esac

  if [[ ${#panes[@]} -eq 0 ]]; then
    echo "No panes found for scope '$scope'." >&2
    exit 1
  fi
}

send_step() {
  local pane="$1"
  local kind="$2"
  local value="$3"

  if ! pane_exists "$pane"; then
    echo "Skipping closed pane: $pane"
    return 0
  fi

  case "$kind" in
    enter)
      "$TMUX_BIN" send-keys -t "$pane" -H 0d || {
        echo "Skipping pane after enter send failure: $pane"
        return 0
      }
      ;;
    esc)
      "$TMUX_BIN" send-keys -t "$pane" Escape || {
        echo "Skipping pane after esc send failure: $pane"
        return 0
      }
      ;;
    text)
      "$TMUX_BIN" send-keys -l -t "$pane" -- "$value" || {
        echo "Skipping pane after text send failure: $pane"
        return 0
      }
      ;;
    *)
      echo "Unknown step kind: $kind" >&2
      exit 1
      ;;
  esac
}

resolve_panes

echo "Broadcast scope: $scope (${#panes[@]} panes)"
echo "Type 'enter' or 'esc' for keys. Anything else is sent as literal text."

step_number=1
while true; do
  if [[ $step_number -eq 1 ]]; then
    prompt="Step $step_number: "
  else
    prompt="What next? [$step_number, blank=done]: "
  fi

  IFS= read -r -p "$prompt" raw_step || exit 0
  if [[ -z "$raw_step" ]]; then
    if [[ $step_number -eq 1 ]]; then
      exit 0
    fi
    break
  fi

  parse_step "$raw_step"
  step_number=$((step_number + 1))
done

delay="0.1"
IFS= read -r -p "Seconds between steps [0.1]: " delay_input || true
if [[ -n "$delay_input" ]]; then
  if [[ "$delay_input" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
    delay="$delay_input"
  else
    echo "Invalid delay '$delay_input' — using 0.1 seconds." >&2
  fi
fi

echo "Broadcasting ${#step_kinds[@]} step(s) to ${#panes[@]} pane(s)..."
for i in "${!step_kinds[@]}"; do
  for pane in "${panes[@]}"; do
    send_step "$pane" "${step_kinds[$i]}" "${step_values[$i]}"
  done

  if (( i + 1 < ${#step_kinds[@]} )); then
    sleep "$delay"
  fi
done

echo "Done."
