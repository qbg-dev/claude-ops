#!/usr/bin/env bash
# deliver_tmux.sh — Deliver cell-message content to recipient's active tmux pane.
#
# Side-effect of "cell-message" events. Replaces the direct _send_to_pane call
# in worker-message.sh, making tmux delivery bus-mediated.
#
# Signature format reflects sender's position in the worker tree:
#   child pane  → [from w:8.1 (child of chief-of-staff)]
#   root worker → [from w:5.0 (chatbot-tools)]
#   operator    → [from w:1.0]
#
# Recipient resolution:
#   .to == "worker/name"  → look up by harness field in pane-registry
#   .to == "%NNN"         → use pane ID directly (child panes in broadcast)
set -euo pipefail
source "$HOME/.boring/lib/harness-jq.sh"

payload=$(cat)
to=$(echo "$payload"      | jq -r '.to // ""'              2>/dev/null || echo "")
content=$(echo "$payload" | jq -r '.content // ""'         2>/dev/null || echo "")
[ -z "$to" ] || [ -z "$content" ] && exit 0

# ── Build sender signature ──
from_target=$(echo "$payload"  | jq -r '.from_target // ""'      2>/dev/null || echo "")
from_name=$(echo "$payload"    | jq -r '.from_name // ""'         2>/dev/null || echo "")
from_parent=$(echo "$payload"  | jq -r '.from_parent_name // ""'  2>/dev/null || echo "")

if [ -n "$from_parent" ]; then
  SIG="[from ${from_target:-?} (child of ${from_parent})]"
elif [ -n "$from_name" ]; then
  SIG="[from ${from_target:-?} (${from_name})]"
elif [ -n "$from_target" ]; then
  SIG="[from ${from_target}]"
else
  SIG="[from unknown]"
fi

# ── Resolve recipient pane (project-scoped when possible) ──
from_project=$(echo "$payload" | jq -r '.from_project // ""' 2>/dev/null || echo "")
if [[ "$to" == %* ]]; then
  # Bare pane ID (e.g. child panes in broadcast)
  PANE_ID="$to"
else
  # STRICT project-scoped lookup — no unscoped fallback to prevent cross-project leakage.
  # If from_project is known, only deliver to same-project recipient.
  # If from_project is empty, use PROJECT_ROOT as fallback scope.
  PANE_ID=""
  _scope="${from_project:-${PROJECT_ROOT:-.}}"
  if [ -n "$_scope" ]; then
    PANE_ID=$(jq -r --arg h "$to" --arg proj "$_scope" \
      'to_entries[] | select(.value.harness == $h and (.value.project_root // "") == $proj) | .key' \
      "$PANE_REGISTRY" 2>/dev/null | head -1 || echo "")
  fi
fi
[ -z "$PANE_ID" ] && exit 0

TARGET=$(tmux list-panes -a -F '#{pane_id} #{session_name}:#{window_index}.#{pane_index}' 2>/dev/null \
  | awk -v id="$PANE_ID" '$1 == id {print $2; exit}')
[ -z "$TARGET" ] && exit 0

tmux send-keys -t "$TARGET" "$SIG $content"
tmux send-keys -t "$TARGET" -H 0d
