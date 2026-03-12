#!/usr/bin/env bash
# broadcast.sh — dispatch broadcast actions and chained prompts
# Usage:
#   broadcast.sh [chain] all|window|select
#   broadcast.sh chain all|window|select
#   broadcast.sh enter all|window
#   broadcast.sh esc   all|window
#   broadcast.sh text  all|window|select

set -euo pipefail

PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"
TMUX_BIN="${TMUX_BIN:-$(command -v tmux)}"
CHAIN_SCRIPT="${CHAIN_SCRIPT:-${CLAUDE_FLEET_DIR:-$HOME/.claude-fleet}/scripts/broadcast-chain.sh}"

mode="${1:-chain}"
scope="${2:-all}"

pane_exists() {
  "$TMUX_BIN" display-message -p -t "$1" '#{pane_id}' >/dev/null 2>&1
}

run_chain_popup() {
  local target_scope="$1"
  "$TMUX_BIN" display-popup -E -w 72 -h 14 -- "$CHAIN_SCRIPT $target_scope"
}

send_key_to_scope() {
  local key_mode="$1"
  local target_scope="$2"
  local pane
  local list_cmd=("$TMUX_BIN" list-panes -F '#{pane_id}')

  if [[ "$target_scope" == "all" ]]; then
    list_cmd=("$TMUX_BIN" list-panes -s -F '#{pane_id}')
  fi

  while IFS= read -r pane; do
    [[ -z "$pane" ]] && continue
    if ! pane_exists "$pane"; then
      continue
    fi

    case "$key_mode" in
      enter)
        "$TMUX_BIN" send-keys -t "$pane" -H 0d || true
        ;;
      esc)
        "$TMUX_BIN" send-keys -t "$pane" Escape || true
        ;;
      *)
        echo "Unknown key mode: $key_mode" >&2
        exit 1
        ;;
    esac
  done < <("${list_cmd[@]}")
}

case "$mode" in
  chain)
    run_chain_popup "$scope"
    ;;
  text)
    run_chain_popup "$scope"
    ;;
  enter)
    case "$scope" in
      all|window) send_key_to_scope enter "$scope" ;;
      *) echo "Unsupported scope for enter: $scope" >&2; exit 1 ;;
    esac
    ;;
  esc)
    case "$scope" in
      all|window) send_key_to_scope esc "$scope" ;;
      *) echo "Unsupported scope for esc: $scope" >&2; exit 1 ;;
    esac
    ;;
  *)
    if [[ "$mode" == "all" || "$mode" == "window" || "$mode" == "select" ]]; then
      run_chain_popup "$mode"
    else
      echo "Unknown mode: $mode" >&2
      exit 1
    fi
    ;;
esac
